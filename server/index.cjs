const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const express = require('express')
const Database = require('better-sqlite3')
const { Client } = require('ssh2')
const { WebSocket, WebSocketServer } = require('ws')
const installBoards = require('./boards.cjs')
const readPrivateKey = require('./ssh-key.cjs')

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

installBoards(database)
database.exec(`
  CREATE TABLE IF NOT EXISTS ssh_identities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
    key_fingerprint TEXT NOT NULL, encrypted_key TEXT NOT NULL, upload_file_name TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ssh_profiles (
    id TEXT PRIMARY KEY, config_name TEXT NOT NULL, alias TEXT NOT NULL,
    host TEXT NOT NULL, username TEXT NOT NULL, port INTEGER NOT NULL,
    identity_files TEXT NOT NULL, problems TEXT NOT NULL, upload_file_name TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
    UNIQUE(config_name, alias)
  );
`)
for (const [table, column] of [['ssh_identities', 'upload_file_name'], ['ssh_identities', 'context'], ['ssh_profiles', 'upload_file_name'], ['ssh_profiles', 'context']]) {
  if (!database.pragma(`table_info(${table})`).some((entry) => entry.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '512kb' }))
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
  try { return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '' } catch { return '' }
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

const listSshIdentities = () => database.prepare('SELECT id, name, public_key AS publicKey, key_fingerprint AS keyFingerprint, upload_file_name AS uploadFileName, context, created_at AS createdAt FROM ssh_identities ORDER BY name COLLATE NOCASE').all()
const listSshProfiles = () => database.prepare('SELECT id, config_name AS configName, alias, host, username, port, identity_files AS identityFilesJson, problems AS problemsJson, upload_file_name AS uploadFileName, context FROM ssh_profiles ORDER BY config_name COLLATE NOCASE, alias COLLATE NOCASE').all().map((profile) => ({ ...profile, identityFiles: JSON.parse(profile.identityFilesJson), problems: JSON.parse(profile.problemsJson), identityFilesJson: undefined, problemsJson: undefined }))
const listSshFiles = () => {
  const identities = listSshIdentities().map((identity) => ({ ...identity, source: 'library' }))
  const identityIds = new Set(identities.map((identity) => identity.id))
  const attached = database.prepare('SELECT id, payload, encrypted_key AS encryptedKey, created_at AS createdAt FROM nodes WHERE encrypted_key IS NOT NULL ORDER BY created_at').all().flatMap((row) => {
    const payload = JSON.parse(row.payload)
    if (payload.type !== 'vps' || (payload.sshIdentityId && identityIds.has(payload.sshIdentityId))) return []
    return [{ id: row.id, name: payload.name, hostName: payload.name, publicKey: payload.publicKey || '', keyFingerprint: payload.keyFingerprint || '', uploadFileName: payload.sshKeyFileName || '', context: payload.sshKeyContext || '', createdAt: row.createdAt, source: 'vps' }]
  })
  return [...identities, ...attached]
}

app.get('/api/ssh-identities', (_req, res) => res.json({ identities: listSshIdentities() }))
app.post('/api/ssh-identities', (req, res) => {
  try {
    const name = requireString(req.body?.name, 'Key name', 80)
    const uploadFileName = typeof req.body?.uploadFileName === 'string' ? req.body.uploadFileName.replace(/[\\/]/g, '/').split('/').pop().trim().slice(0, 180) : ''
    const key = readPrivateKey(req.body?.privateKey, req.body?.passphrase ?? '')
    const id = crypto.randomUUID(), createdAt = new Date().toISOString()
    try {
      database.prepare('INSERT INTO ssh_identities (id, name, public_key, key_fingerprint, encrypted_key, upload_file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, key.publicKey, key.keyFingerprint, seal(JSON.stringify({ privateKey: key.privateKey, passphrase: key.passphrase })), uploadFileName, createdAt)
    } catch (error) {
      if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'A saved key already uses that name. Choose another name.' })
      throw error
    }
    return res.status(201).json({ identity: listSshIdentities().find((identity) => identity.id === id) })
  } catch (error) { return res.status(400).json({ error: error.message || 'Could not save this SSH key.' }) }
})
app.delete('/api/ssh-identities/:id', (req, res) => {
  const result = database.prepare('DELETE FROM ssh_identities WHERE id = ?').run(req.params.id)
  return result.changes ? res.status(204).end() : res.status(404).json({ error: 'Saved SSH key not found.' })
})
app.patch('/api/ssh-identities/:id/context', (req, res) => {
  const identity = database.prepare('SELECT id FROM ssh_identities WHERE id = ?').get(req.params.id)
  if (!identity) return res.status(404).json({ error: 'Saved SSH key not found.' })
  if (typeof req.body?.context !== 'string' || req.body.context.length > 1000) return res.status(400).json({ error: 'File context must be 1000 characters or fewer.' })
  database.prepare('UPDATE ssh_identities SET context = ? WHERE id = ?').run(req.body.context.trim(), identity.id)
  return res.json({ identity: listSshIdentities().find((entry) => entry.id === identity.id) })
})

app.get('/api/ssh-profiles', (_req, res) => res.json({ profiles: listSshProfiles() }))
app.post('/api/ssh-profiles', (req, res) => {
  try {
    const configName = requireString(req.body?.configName, 'Config name', 80)
    const uploadFileName = typeof req.body?.uploadFileName === 'string' ? req.body.uploadFileName.replace(/[\\/]/g, '/').split('/').pop().trim().slice(0, 180) : ''
    const profiles = req.body?.profiles
    if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 100) throw new Error('Choose a config with 1 to 100 named host aliases.')
    const createdAt = new Date().toISOString()
    const rows = profiles.map((profile) => {
      const alias = requireString(profile?.alias, 'Host alias', 100)
      const host = requireString(profile?.host, 'Host', 253)
      const problems = Array.isArray(profile.problems) ? profile.problems.slice(0, 10).map((problem) => requireString(problem, 'SSH config warning', 300)) : []
      const invalidHostname = /[\s/?#]/.test(host) || host.includes('://')
      if (invalidHostname && !problems.some((problem) => problem.startsWith('HostName must be a hostname or IP address'))) throw new Error(`HostName for ${alias} must be a hostname or IP address.`)
      const username = typeof profile.username === 'string' ? profile.username.trim().slice(0, 80) : ''
      const port = Number(profile.port || 22)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port for ${alias} must be between 1 and 65535.`)
      const identityFiles = Array.isArray(profile.identityFiles) ? profile.identityFiles.slice(0, 8).map((file) => requireString(file, 'Identity file', 320)) : []
      return [crypto.randomUUID(), configName, alias, host, username, port, JSON.stringify(identityFiles), JSON.stringify(problems), uploadFileName, createdAt]
    })
    const replaceConfig = database.transaction(() => {
      database.prepare('DELETE FROM ssh_profiles WHERE config_name = ?').run(configName)
      const insert = database.prepare('INSERT INTO ssh_profiles (id, config_name, alias, host, username, port, identity_files, problems, upload_file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const row of rows) insert.run(...row)
    })
    replaceConfig()
    return res.status(201).json({ profiles: listSshProfiles().filter((profile) => profile.configName === configName) })
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'Host aliases in this config must be unique.' })
    return res.status(400).json({ error: error.message || 'Could not save this SSH config.' })
  }
})
app.delete('/api/ssh-profiles/:configName', (req, res) => {
  const result = database.prepare('DELETE FROM ssh_profiles WHERE config_name = ?').run(req.params.configName)
  return result.changes ? res.status(204).end() : res.status(404).json({ error: 'Saved SSH config not found.' })
})
app.patch('/api/ssh-profiles/:configName/context', (req, res) => {
  if (typeof req.body?.context !== 'string' || req.body.context.length > 1000) return res.status(400).json({ error: 'File context must be 1000 characters or fewer.' })
  const result = database.prepare('UPDATE ssh_profiles SET context = ? WHERE config_name = ?').run(req.body.context.trim(), req.params.configName)
  return result.changes ? res.json({ profiles: listSshProfiles().filter((profile) => profile.configName === req.params.configName) }) : res.status(404).json({ error: 'Saved SSH config not found.' })
})
app.get('/api/ssh-files', (_req, res) => res.json({ files: listSshFiles() }))

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
      publicKey: payload.publicKey || '',
      keyFingerprint: payload.keyFingerprint || '',
      sshKeyFileName: payload.sshKeyFileName || '',
      sshKeyContext: payload.sshKeyContext || '',
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

const boardById = database.prepare('SELECT * FROM boards WHERE id = ?')
const membership = database.prepare('SELECT board_id FROM board_nodes WHERE node_id = ?')
function listBoards() {
  return database.prepare(`SELECT b.id, b.name, COUNT(m.node_id) AS resourceCount
    FROM boards b LEFT JOIN board_nodes m ON m.board_id = b.id
    GROUP BY b.id ORDER BY b.created_at, b.id`).all()
}

app.get('/api/graph', (req, res) => {
  const boardId = typeof req.query.boardId === 'string' ? req.query.boardId : 'default'
  if (!boardById.get(boardId)) return res.status(404).json({ error: 'Graph board not found.' })
  const nodes = database.prepare('SELECT n.* FROM nodes n JOIN board_nodes m ON m.node_id = n.id WHERE m.board_id = ? ORDER BY n.created_at').all(boardId).map(toGraphNode)
  const edges = database.prepare(`SELECT e.id, e.source, e.target FROM edges e
    JOIN board_nodes s ON s.node_id = e.source JOIN board_nodes t ON t.node_id = e.target
    WHERE s.board_id = ? AND t.board_id = ? ORDER BY e.created_at`).all(boardId, boardId).map((row) => ({ ...row, type: 'smoothstep' }))
  const setupComplete = database.prepare("SELECT value FROM app_meta WHERE key = 'setup_complete'").get()?.value === '1'
  res.json({ nodes, edges, boards: listBoards(), boardId, demo: boardId === 'default' && nodes.length === 0 && !setupComplete })
})

app.post('/api/boards', (req, res) => {
  try {
    const board = { id: crypto.randomUUID(), name: requireString(req.body?.name, 'Graph name', 80), resourceCount: 0 }
    database.prepare('INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)').run(board.id, board.name, new Date().toISOString())
    return res.status(201).json({ board })
  } catch (error) { return res.status(400).json({ error: error.message }) }
})

app.patch('/api/boards/:id', (req, res) => {
  if (!boardById.get(req.params.id)) return res.status(404).json({ error: 'Graph board not found.' })
  try {
    const name = requireString(req.body?.name, 'Graph name', 80)
    database.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, req.params.id)
    return res.json({ board: boardById.get(req.params.id) })
  } catch (error) { return res.status(400).json({ error: error.message }) }
})

app.delete('/api/boards/:id', (req, res) => {
  const id = req.params.id
  if (id === 'default') return res.status(409).json({ error: 'The original graph cannot be removed.' })
  if (!boardById.get(id)) return res.status(404).json({ error: 'Graph board not found.' })
  if (database.prepare('SELECT 1 FROM board_nodes WHERE board_id = ? LIMIT 1').get(id)) return res.status(409).json({ error: 'Remove the resources in this graph before deleting it.' })
  database.prepare('DELETE FROM boards WHERE id = ?').run(id)
  return res.status(204).end()
})

app.post('/api/nodes', (req, res) => {
  try {
    const body = req.body || {}
    const boardId = typeof body.boardId === 'string' ? body.boardId : 'default'
    if (!boardById.get(boardId)) return res.status(400).json({ error: 'Choose an existing graph board.' })
    if (body.parentId && membership.get(body.parentId)?.board_id !== boardId) return res.status(400).json({ error: 'The linked host must be in the same graph board.' })
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
      if (typeof body.sshIdentityId === 'string' && body.sshIdentityId) {
        const identity = database.prepare('SELECT * FROM ssh_identities WHERE id = ?').get(body.sshIdentityId)
        if (!identity) return res.status(400).json({ error: 'Choose a saved SSH key that still exists.' })
        payload.publicKey = identity.public_key
        payload.keyFingerprint = identity.key_fingerprint
        payload.sshIdentityId = identity.id
        encryptedKey = identity.encrypted_key
      } else {
        const key = readPrivateKey(body.privateKey, body.passphrase ?? '')
        payload.publicKey = key.publicKey
        payload.keyFingerprint = key.keyFingerprint
        encryptedKey = seal(JSON.stringify({ privateKey: key.privateKey, passphrase: key.passphrase }))
        payload.sshKeyFileName = typeof body.sshKeyUploadFileName === 'string' ? body.sshKeyUploadFileName.replace(/[\\/]/g, '/').split('/').pop().trim().slice(0, 180) : ''
        payload.sshKeyContext = ''
        if (body.rememberSshKey === true) {
          payload.rememberSshKeyName = requireString(body.rememberSshKeyName, 'Saved key name', 80)
          const uploadFileName = typeof body.sshKeyUploadFileName === 'string' ? body.sshKeyUploadFileName.replace(/[\\/]/g, '/').split('/').pop().trim().slice(0, 180) : ''
          payload.rememberSshIdentity = { publicKey: key.publicKey, keyFingerprint: key.keyFingerprint, encryptedKey, uploadFileName, id: crypto.randomUUID() }
        }
      }
    } else if (type === 'tunnel' || type === 'external') {
      if (!payload.endpoint && !payload.provider) return res.status(400).json({ error: 'Add an endpoint or provider for this resource.' })
    }
    const now = new Date().toISOString()
    database.transaction(() => {
      if (payload.rememberSshIdentity) {
        const saved = payload.rememberSshIdentity
        database.prepare('INSERT INTO ssh_identities (id, name, public_key, key_fingerprint, encrypted_key, upload_file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(saved.id, payload.rememberSshKeyName, saved.publicKey, saved.keyFingerprint, saved.encryptedKey, saved.uploadFileName, now)
        payload.sshIdentityId = saved.id
        delete payload.rememberSshIdentity
        delete payload.rememberSshKeyName
      }
      database.prepare('INSERT INTO nodes (id, payload, encrypted_key, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, JSON.stringify(payload), encryptedKey, x, y, now)
      database.prepare('INSERT INTO board_nodes (node_id, board_id) VALUES (?, ?)').run(id, boardId)
      if (body.parentId && body.parentId !== id) {
        const parent = rowById.get(body.parentId)
        if (parent) database.prepare('INSERT OR IGNORE INTO edges (id, source, target, created_at) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), body.parentId, id, now)
      }
      database.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('setup_complete', '1')").run()
    })()
    return res.status(201).json({ node: toGraphNode(rowById.get(id)) })
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Could not add this resource.' })
  }
})

app.patch('/api/nodes/:id', (req, res) => {
  const row = rowById.get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Resource not found.' })
  try {
    const body = req.body || {}
    const payload = JSON.parse(row.payload)
    const type = payload.type
    let hostChanged = false
    let sshTargetChanged = false
    if ('name' in body) payload.name = requireString(body.name, 'Name')
    if (type === 'vps') {
      if ('host' in body) {
        const host = requireString(body.host, 'Host', 253)
        hostChanged = host !== payload.host
        payload.host = host
      }
      if ('port' in body) {
        const port = Number(body.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be between 1 and 65535.')
        hostChanged = hostChanged || port !== Number(payload.port)
        payload.port = port
      }
      if ('username' in body) {
        const username = requireString(body.username, 'SSH user', 80)
        sshTargetChanged = username !== payload.username
        payload.username = username
      }
      if ('location' in body) {
        if (typeof body.location !== 'string') throw new Error('Location must be text.')
        payload.location = body.location.trim().slice(0, 80)
      }
    } else {
      if ('provider' in body) {
        if (typeof body.provider !== 'string') throw new Error('Provider must be text.')
        payload.provider = body.provider.trim().slice(0, 80)
      }
      if ('endpoint' in body) {
        if (typeof body.endpoint !== 'string') throw new Error('Endpoint must be text.')
        payload.endpoint = body.endpoint.trim().slice(0, 320)
      }
      if ((type === 'tunnel' || type === 'external') && !payload.endpoint && !payload.provider) throw new Error('Add an endpoint or provider for this resource.')
    }
    if ('notes' in body) {
      if (typeof body.notes !== 'string') throw new Error('Notes must be text.')
      payload.notes = body.notes.trim().slice(0, 500)
    }
    const x = Number.isFinite(body.x) && Number.isFinite(body.y) ? body.x : row.x
    const y = Number.isFinite(body.x) && Number.isFinite(body.y) ? body.y : row.y
    const connectionStatus = hostChanged || sshTargetChanged ? 'untested' : row.connection_status
    const hostFingerprint = hostChanged ? null : row.host_fingerprint
    const lastCheckedAt = hostChanged || sshTargetChanged ? null : row.last_checked_at
    database.prepare('UPDATE nodes SET payload = ?, x = ?, y = ?, host_fingerprint = ?, connection_status = ?, last_checked_at = ? WHERE id = ?')
      .run(JSON.stringify(payload), x, y, hostFingerprint, connectionStatus, lastCheckedAt, row.id)
    return res.json({ node: toGraphNode(rowById.get(row.id)) })
  } catch (error) { return res.status(400).json({ error: error.message || 'Could not update this resource.' }) }
})

app.delete('/api/nodes/:id', (req, res) => {
  const result = database.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id)
  return result.changes ? res.status(204).end() : res.status(404).json({ error: 'Resource not found.' })
})
app.patch('/api/nodes/:id/ssh-file-context', (req, res) => {
  if (typeof req.body?.context !== 'string' || req.body.context.length > 1000) return res.status(400).json({ error: 'File context must be 1000 characters or fewer.' })
  const row = rowById.get(req.params.id)
  if (!row || !row.encrypted_key || JSON.parse(row.payload).type !== 'vps') return res.status(404).json({ error: 'VPS SSH key file not found.' })
  const payload = JSON.parse(row.payload)
  payload.sshKeyContext = req.body.context.trim()
  database.prepare('UPDATE nodes SET payload = ? WHERE id = ?').run(JSON.stringify(payload), row.id)
  return res.json({ id: row.id, context: payload.sshKeyContext })
})
app.delete('/api/nodes/:id/ssh-key', (req, res) => {
  const row = rowById.get(req.params.id)
  if (!row || !row.encrypted_key || JSON.parse(row.payload).type !== 'vps') return res.status(404).json({ error: 'VPS SSH key file not found.' })
  const payload = JSON.parse(row.payload)
  delete payload.sshKeyFileName
  delete payload.sshKeyContext
  delete payload.sshIdentityId
  delete payload.publicKey
  delete payload.keyFingerprint
  database.prepare("UPDATE nodes SET payload = ?, encrypted_key = NULL, connection_status = 'untested', last_checked_at = NULL WHERE id = ?").run(JSON.stringify(payload), row.id)
  return res.status(204).end()
})

app.post('/api/edges', (req, res) => {
  const { source, target } = req.body || {}
  if (!rowById.get(source) || !rowById.get(target) || source === target) return res.status(400).json({ error: 'Choose two different saved resources.' })
  if (membership.get(source)?.board_id !== membership.get(target)?.board_id) return res.status(400).json({ error: 'Resources must belong to the same graph board.' })
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

const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false })
const httpServer = http.createServer(app)
httpServer.on('upgrade', (req, socket, head) => {
  let requestUrl
  try { requestUrl = new URL(req.url || '/', 'http://localhost') } catch { socket.destroy(); return }
  if (requestUrl.pathname !== '/api/terminal') { socket.destroy(); return }
  const origin = req.headers.origin
  if (!origin || !req.headers.host || (() => {
    try { return new URL(origin).host !== req.headers.host } catch { return true }
  })()) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  if (!hasValidSession({ headers: req.headers })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const row = rowById.get(requestUrl.searchParams.get('nodeId') || '')
  if (!row || !row.encrypted_key || !row.host_fingerprint || JSON.parse(row.payload).type !== 'vps') {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  terminalSockets.handleUpgrade(req, socket, head, (websocket) => {
    terminalSockets.emit('connection', websocket, req, row)
  })
})

terminalSockets.on('connection', (websocket, _req, row) => {
  const payload = JSON.parse(row.payload)
  let auth
  try { auth = JSON.parse(unseal(row.encrypted_key)) } catch {
    websocket.close(1011, 'Stored SSH credentials could not be read')
    return
  }
  const connection = new Client()
  let shell = null
  let closed = false
  const send = (message) => {
    if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message))
  }
  const closeConnection = () => {
    if (closed) return
    closed = true
    clearTimeout(connectTimer)
    try { shell?.close() } catch {}
    try { connection.end() } catch {}
  }
  const connectTimer = setTimeout(() => {
    send({ type: 'error', message: 'SSH connection timed out.' })
    websocket.close(1011, 'SSH connection timed out')
    closeConnection()
  }, 20_000)

  websocket.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > 16 * 1024) return
    let message
    try { message = JSON.parse(raw.toString('utf8')) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 12_000) {
      shell?.write(message.data)
    } else if (message.type === 'resize') {
      const cols = Math.max(10, Math.min(300, Math.floor(Number(message.cols) || 80)))
      const rows = Math.max(5, Math.min(200, Math.floor(Number(message.rows) || 24)))
      shell?.setWindow(rows, cols, 0, 0)
    }
  })
  websocket.on('close', closeConnection)
  websocket.on('error', closeConnection)
  connection.on('ready', () => {
    clearTimeout(connectTimer)
    if (websocket.readyState !== WebSocket.OPEN) return closeConnection()
    connection.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, stream) => {
      if (error) {
        send({ type: 'error', message: 'SSH connected, but the server did not open a terminal.' })
        websocket.close(1011, 'Could not open SSH terminal')
        return closeConnection()
      }
      shell = stream
      send({ type: 'ready' })
      stream.on('data', (data) => send({ type: 'output', data: data.toString('utf8') }))
      stream.stderr.on('data', (data) => send({ type: 'output', data: data.toString('utf8') }))
      stream.on('close', () => {
        if (websocket.readyState === WebSocket.OPEN) websocket.close(1000, 'SSH session ended')
        closeConnection()
      })
      stream.on('error', () => {
        send({ type: 'error', message: 'The SSH terminal stream failed.' })
        if (websocket.readyState === WebSocket.OPEN) websocket.close(1011, 'SSH terminal stream failed')
        closeConnection()
      })
    })
  })
  connection.on('error', () => {
    send({ type: 'error', message: 'SSH authentication failed or the pinned host key changed. Run the connection check to review the host key.' })
    if (websocket.readyState === WebSocket.OPEN) websocket.close(1011, 'SSH connection failed')
    closeConnection()
  })
  try {
    connection.connect({
      host: payload.host,
      port: payload.port,
      username: payload.username,
      privateKey: auth.privateKey,
      passphrase: auth.passphrase || undefined,
      readyTimeout: 18_000,
      hostVerifier: (hostKey) => safeEqual(sshFingerprint(hostKey), row.host_fingerprint),
    })
  } catch {
    send({ type: 'error', message: 'The saved SSH key could not be loaded. Check the key format and passphrase.' })
    websocket.close(1011, 'Invalid SSH credentials')
    closeConnection()
  }
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
httpServer.listen(port, bindHost, () => console.log(`Orbit Ops listening on ${bindHost}:${port}`))
