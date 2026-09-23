const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const express = require('express')
const Database = require('better-sqlite3')
const { Client } = require('ssh2')

const production = process.env.NODE_ENV === 'production'
const adminPassword = process.env.ADMIN_PASSWORD || (production ? '' : 'local-dev-change-me')
const encryptionSecret = process.env.DATA_ENCRYPTION_KEY || (production ? '' : '11'.repeat(32))
const sessionSecret = process.env.SESSION_SECRET || (production ? '' : 'orbit-local-dev-session-secret')
if (!adminPassword || Buffer.from(encryptionSecret, 'hex').length !== 32 || !sessionSecret) {
  throw new Error('Set ADMIN_PASSWORD, a 64-character hex DATA_ENCRYPTION_KEY, and SESSION_SECRET before starting production.')
}
const encryptionKey = Buffer.from(encryptionSecret, 'hex')
const cookieSecure = production && process.env.COOKIE_SECURE !== 'false'
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'))
fs.mkdirSync(dataDirectory, { recursive: true })

const database = new Database(path.join(dataDirectory, 'orbit-ops.sqlite'))
database.pragma('journal_mode = WAL')
database.pragma('foreign_keys = ON')
database.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    encrypted_key TEXT,
    host_fingerprint TEXT,
    connection_status TEXT NOT NULL DEFAULT 'untested',
    last_checked_at TEXT,
    x REAL NOT NULL DEFAULT 80,
    y REAL NOT NULL DEFAULT 80,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE(source, target)
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '64kb' }))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  next()
})

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest()
  const b = crypto.createHash('sha256').update(String(right)).digest()
  return crypto.timingSafeEqual(a, b)
}

function seal(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

function unseal(value) {
  const [ivPart, tagPart, ciphertextPart] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8')
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url')
}

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

function readCookie(req, name) {
  const entry = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : ''
}

function hasValidSession(req) {
  const token = readCookie(req, 'orbit_session')
  const split = token.lastIndexOf('.')
  if (split < 1) return false
  const payload = token.slice(0, split)
  if (!safeEqual(token.slice(split + 1), sign(payload))) return false
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now()
  } catch {
    return false
  }
}

const loginAttempts = new Map()
const pendingFingerprints = new Map()
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin)
      const localDevOrigin = !production && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin.origin)
      if (!localDevOrigin && origin.host !== req.get('host')) return res.status(403).json({ error: 'Origin check failed.' })
    } catch {
      return res.status(403).json({ error: 'Origin check failed.' })
    }
  }
  next()
})

app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.get('/api/session', (req, res) => res.json({ authenticated: hasValidSession(req) }))
app.post('/api/session', (req, res) => {
  const address = req.ip || 'unknown'
  const attempt = loginAttempts.get(address) || { count: 0, until: 0 }
  if (attempt.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' })
  if (!safeEqual(req.body?.password || '', adminPassword)) {
    attempt.count += 1
    if (attempt.count >= 5) { attempt.count = 0; attempt.until = Date.now() + 60_000 }
    loginAttempts.set(address, attempt)
    return res.status(401).json({ error: 'That password did not match.' })
  }
  loginAttempts.delete(address)
  res.cookie('orbit_session', makeSession(), { httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 })
  return res.json({ authenticated: true })
})
app.delete('/api/session', (req, res) => {
  if (!hasValidSession(req)) return res.status(401).json({ error: 'Sign in to continue.' })
  res.clearCookie('orbit_session', { httpOnly: true, sameSite: 'strict', secure: cookieSecure, path: '/' })
  return res.json({ authenticated: false })
})

app.use('/api', (req, res, next) => {
  if (req.path === '/session' || req.path === '/session/') return next()
  if (!hasValidSession(req)) return res.status(401).json({ error: 'Sign in to continue.' })
  next()
})

const rowById = database.prepare('SELECT * FROM nodes WHERE id = ?')
function toGraphNode(row) {
  const payload = JSON.parse(row.payload)
  const type = payload.type
  const icon = type === 'vps' ? 'server' : type === 'tunnel' ? 'cloud' : type === 'external' ? 'globe' : 'database'
  const tint = type === 'vps' ? 'cyan' : type === 'tunnel' ? 'orange' : type === 'external' ? 'blue' : 'violet'
  const kind = type === 'vps'
    ? `VPS${payload.location ? ` · ${payload.location.toUpperCase()}` : ''}`
    : type === 'tunnel' ? `${(payload.provider || 'TUNNEL').toUpperCase()} · TUNNEL`
      : type === 'external' ? `EXTERNAL · ${(payload.provider || 'SERVICE').toUpperCase()}`
        : `SERVICE${payload.provider ? ` · ${payload.provider.toUpperCase()}` : ''}`
  const meta = type === 'vps' ? `${payload.host}:${payload.port} · ${payload.username}` : payload.endpoint || payload.provider || payload.notes || 'No endpoint set'
  const status = type === 'vps'
    ? row.connection_status === 'connected' ? 'CHECK OK' : row.connection_status === 'error' ? 'CHECK FAILED' : 'NOT CHECKED'
    : 'TRACKED'
  return {
    id: row.id,
    type: 'resource',
    position: { x: row.x, y: row.y },
    data: {
      name: payload.name,
      kind,
      meta,
      status,
      tint,
      icon,
      resourceType: type,
      host: payload.host || '',
      port: payload.port || 0,
      username: payload.username || '',
      endpoint: payload.endpoint || '',
      provider: payload.provider || '',
      location: payload.location || '',
      notes: payload.notes || '',
      hasPrivateKey: Boolean(row.encrypted_key),
      hostFingerprint: row.host_fingerprint || '',
      connectionStatus: row.connection_status,
      lastCheckedAt: row.last_checked_at || '',
    },
  }
}

function requireString(value, label, max = 180) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} is required and must be ${max} characters or fewer.`)
  return value.trim()
}

app.get('/api/graph', (_req, res) => {
  const nodes = database.prepare('SELECT * FROM nodes ORDER BY created_at').all().map(toGraphNode)
  const edges = database.prepare('SELECT id, source, target FROM edges ORDER BY created_at').all().map((row) => ({ ...row, type: 'smoothstep' }))
  const setupComplete = database.prepare("SELECT value FROM app_meta WHERE key = 'setup_complete'").get()?.value === '1'
  res.json({ nodes, edges, demo: nodes.length === 0 && !setupComplete })
})

app.post('/api/nodes', (req, res) => {
  try {
    const body = req.body || {}
    const type = ['vps', 'service', 'tunnel', 'external'].includes(body.type) ? body.type : ''
    if (!type) return res.status(400).json({ error: 'Choose a supported resource type.' })
    const payload = { type, name: requireString(body.name, 'Name'), provider: (body.provider || '').trim().slice(0, 80), endpoint: (body.endpoint || '').trim().slice(0, 320), notes: (body.notes || '').trim().slice(0, 500), location: (body.location || '').trim().slice(0, 80) }
    let encryptedKey = null
    let id = crypto.randomUUID()
    let x = Number.isFinite(body.x) ? body.x : 100 + (database.prepare('SELECT COUNT(*) AS count FROM nodes').get().count % 3) * 280
    let y = Number.isFinite(body.y) ? body.y : 100 + (database.prepare('SELECT COUNT(*) AS count FROM nodes').get().count % 2) * 190
    if (type === 'vps') {
      payload.host = requireString(body.host, 'Host', 253)
      payload.port = Number(body.port || 22)
      if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) return res.status(400).json({ error: 'SSH port must be between 1 and 65535.' })
      payload.username = requireString(body.username, 'SSH user', 80)
      encryptedKey = seal(JSON.stringify({ privateKey: requireString(body.privateKey, 'Private key', 48_000), passphrase: (body.passphrase || '').slice(0, 500) }))
    } else if (type === 'tunnel' || type === 'external') {
      if (!payload.endpoint && !payload.provider) return res.status(400).json({ error: 'Add an endpoint or provider for this resource.' })
    }
    const now = new Date().toISOString()
    database.prepare('INSERT INTO nodes (id, payload, encrypted_key, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, JSON.stringify(payload), encryptedKey, x, y, now)
    if (body.parentId && body.parentId !== id) {
      const parent = rowById.get(body.parentId)
      if (parent) database.prepare('INSERT OR IGNORE INTO edges (id, source, target, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), body.parentId, id, now)
    }
    database.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('setup_complete', '1')").run()
    return res.status(201).json({ node: toGraphNode(rowById.get(id)) })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not add this resource.' })
  }
})

app.patch('/api/nodes/:id', (req, res) => {
  const row = rowById.get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Resource not found.' })
  const body = req.body || {}
  if (Number.isFinite(body.x) && Number.isFinite(body.y)) database.prepare('UPDATE nodes SET x = ?, y = ? WHERE id = ?').run(body.x, body.y, row.id)
  if (typeof body.name === 'string') {
    try {
      const payload = JSON.parse(row.payload)
      payload.name = requireString(body.name, 'Name')
      database.prepare('UPDATE nodes SET payload = ? WHERE id = ?').run(JSON.stringify(payload), row.id)
    } catch (error) { return res.status(400).json({ error: error.message }) }
  }
  return res.json({ node: toGraphNode(rowById.get(row.id)) })
})

app.delete('/api/nodes/:id', (req, res) => {
  const result = database.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id)
  return result.changes ? res.status(204).end() : res.status(404).json({ error: 'Resource not found.' })
})

app.post('/api/edges', (req, res) => {
  const { source, target } = req.body || {}
  if (!rowById.get(source) || !rowById.get(target) || source === target) return res.status(400).json({ error: 'Choose two different saved resources.' })
  const id = crypto.randomUUID()
  try {
    database.prepare('INSERT INTO edges (id, source, target, created_at) VALUES (?, ?, ?, ?)').run(id, source, target, new Date().toISOString())
    return res.status(201).json({ id, source, target, type: 'smoothstep' })
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Those resources are already connected.' })
    return res.status(500).json({ error: 'Could not save the connection.' })
  }
})

app.delete('/api/edges/:id', (req, res) => {
  const result = database.prepare('DELETE FROM edges WHERE id = ?').run(req.params.id)
  return result.changes ? res.status(204).end() : res.status(404).json({ error: 'Connection not found.' })
})

function sshFingerprint(hostKey) {
  const hash = crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/g, '')
  return `SHA256:${hash}`
}

function checkSsh(row) {
  if (!row.encrypted_key) return Promise.reject(new Error('This host has no SSH key stored.'))
  const payload = JSON.parse(row.payload)
  const auth = JSON.parse(unseal(row.encrypted_key))
  return new Promise((resolve) => {
    const connection = new Client()
    let fingerprint = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { connection.end() } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'Connection timed out.' }), 12_000)
    connection.on('ready', () => finish({ ok: true, fingerprint }))
    connection.on('error', (error) => {
      if (fingerprint && (!row.host_fingerprint || !safeEqual(fingerprint, row.host_fingerprint))) finish({ ok: false, needsTrust: true, fingerprint, replacesExisting: Boolean(row.host_fingerprint), previousFingerprint: row.host_fingerprint || '' })
      else finish({ ok: false, error: error.message || 'SSH connection failed.' })
    })
    connection.connect({
      host: payload.host,
      port: payload.port,
      username: payload.username,
      privateKey: auth.privateKey,
      passphrase: auth.passphrase || undefined,
      readyTimeout: 11_000,
      hostVerifier: (hostKey) => {
        fingerprint = sshFingerprint(hostKey)
        if (!row.host_fingerprint) return false
        return safeEqual(fingerprint, row.host_fingerprint)
      },
    })
  })
}

app.post('/api/nodes/:id/test-ssh', async (req, res) => {
  const row = rowById.get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Resource not found.' })
  if (JSON.parse(row.payload).type !== 'vps') return res.status(400).json({ error: 'SSH checks are only available for VPS hosts.' })
  try {
    const result = await checkSsh(row)
    const checkedAt = new Date().toISOString()
    if (result.ok) database.prepare("UPDATE nodes SET connection_status = 'connected', last_checked_at = ? WHERE id = ?").run(checkedAt, row.id)
    else if (!result.needsTrust || result.replacesExisting) database.prepare("UPDATE nodes SET connection_status = 'error', last_checked_at = ? WHERE id = ?").run(checkedAt, row.id)
    if (result.needsTrust) pendingFingerprints.set(row.id, { fingerprint: result.fingerprint, until: Date.now() + 5 * 60_000 })
    return res.json({ ...result, checkedAt })
  } catch (error) {
    database.prepare("UPDATE nodes SET connection_status = 'error', last_checked_at = ? WHERE id = ?").run(new Date().toISOString(), row.id)
    return res.status(400).json({ error: error.message || 'SSH connection failed.' })
  }
})

app.post('/api/nodes/:id/trust-host-key', (req, res) => {
  const candidate = pendingFingerprints.get(req.params.id)
  const fingerprint = req.body?.fingerprint
  if (!candidate || candidate.until < Date.now() || !safeEqual(candidate.fingerprint, fingerprint)) return res.status(400).json({ error: 'Run the SSH check again, then verify the newly shown fingerprint.' })
  database.prepare('UPDATE nodes SET host_fingerprint = ? WHERE id = ?').run(candidate.fingerprint, req.params.id)
  pendingFingerprints.delete(req.params.id)
  return res.json({ trusted: true, fingerprint: candidate.fingerprint })
})

const publicDirectory = path.join(__dirname, '..', 'dist')
if (fs.existsSync(publicDirectory)) {
  app.use(express.static(publicDirectory, { index: false, maxAge: '1h' }))
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/healthz') return next()
    return res.sendFile(path.join(publicDirectory, 'index.html'))
  })
}

app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.message)
  res.status(500).json({ error: 'Something went wrong. Check the server log for details.' })
})

const port = Number(process.env.PORT || 8787)
const bindHost = process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1')
app.listen(port, bindHost, () => console.log(`Orbit Ops listening on ${bindHost}:${port}`))
