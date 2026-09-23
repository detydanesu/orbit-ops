const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Server } = require('ssh2')
const { WebSocket } = require('ws')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const Database = require('better-sqlite3')

test('terminal pins SSH keys, relays input, ignores malformed input, and contains invalid credentials', { timeout: 25000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-terminal-'))
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const clients = new Set()
  const ssh = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (context) => context.method === 'publickey' ? context.accept() : context.reject())
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty())
      session.on('window-change', (acceptResize) => acceptResize?.())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write('fixture-ready\r\n')
        stream.on('data', (data) => stream.write('echo:' + data))
      })
    }))
  })
  ssh.listen(0, '127.0.0.1')
  await once(ssh, 'listening')
  const probe = net.createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.cjs'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: fixture, COOKIE_SECURE: 'false', ADMIN_PASSWORD: 'terminal-fixture', DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), SESSION_SECRET: crypto.randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let cookie = '', socket
  const api = async (route, body) => {
    const response = await fetch(base + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    assert.equal(response.ok, true, await response.clone().text())
    return response.json()
  }
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => { if (String(data).includes('Orbit Ops listening')) resolve() })
      child.on('error', reject)
      child.on('exit', (code) => reject(new Error('Fixture exited: ' + code)))
    })
    const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'terminal-fixture' }) })
    cookie = login.headers.get('set-cookie').split(';')[0]
    const { node } = await api('/nodes', { type: 'vps', name: 'Local SSH fixture', host: '127.0.0.1', port: ssh.address().port, username: 'fixture', privateKey: key })
    const check = await api(`/nodes/${node.id}/test-ssh`, {})
    assert.equal(check.needsTrust, true)
    await api(`/nodes/${node.id}/trust-host-key`, { fingerprint: check.fingerprint })
    assert.equal((await api(`/nodes/${node.id}/test-ssh`, {})).ok, true)
    const address = `ws://127.0.0.1:${port}/api/terminal?nodeId=${node.id}`
    socket = new WebSocket(address, { origin: base, headers: { Cookie: cookie } })
    const output = []
    socket.on('message', (raw) => output.push(JSON.parse(String(raw))))
    await once(socket, 'open')
    const waitFor = async (predicate) => {
      const end = Date.now() + 5000
      while (!predicate()) { if (Date.now() > end) throw new Error('Terminal output timed out'); await new Promise((resolve) => setTimeout(resolve, 20)) }
    }
    await waitFor(() => output.some((item) => item.type === 'ready'))
    socket.send('null')
    socket.send('{bad json')
    socket.send(JSON.stringify({ type: 'resize', rows: 30, cols: 100 }))
    socket.send(JSON.stringify({ type: 'input', data: 'hello\r\n' }))
    await waitFor(() => output.some((item) => item.data?.includes('echo:hello')))
    socket.close()
    await once(socket, 'close')
    const { node: bad } = await api('/nodes', { type: 'vps', name: 'Bad key fixture', host: '127.0.0.1', username: 'fixture', privateKey: 'invalid key' })
    const db = new Database(path.join(fixture, 'orbit-ops.sqlite'))
    db.prepare('UPDATE nodes SET host_fingerprint = ? WHERE id = ?').run(check.fingerprint, bad.id)
    db.close()
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?nodeId=${bad.id}`, { origin: base, headers: { Cookie: cookie } })
    const [code] = await once(socket, 'close')
    assert.equal(code, 1011)
    assert.equal((await fetch(base + '/healthz')).status, 200)
    socket = new WebSocket(address, { origin: base, headers: { Cookie: 'orbit_session=%E0%A4%A' } })
    const [error] = await once(socket, 'error')
    assert.match(error.message, /401/)
    assert.equal((await fetch(base + '/healthz')).status, 200)
  } finally {
    socket?.terminate()
    child.kill()
    if (child.exitCode === null) await once(child, 'exit')
    for (const client of clients) client.end()
    await new Promise((resolve) => ssh.close(resolve))
    if (path.dirname(path.resolve(fixture)) === path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('orbit-terminal-')) fs.rmSync(fixture, { recursive: true, force: true })
  }
})
