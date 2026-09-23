const { test } = require('node:test')
const assert = require('node:assert/strict')
const parse = async (text) => (await import('../src/sshConfig.ts')).parseSshConfig(text)

test('SSH config imports quoted Windows paths, aliases, and defaults', async () => {
  const profiles = await parse(String.raw`
Host sg secondary
  HostName = 192.0.2.10
  User operator
  IdentityFile "C:\Users\user\.ssh\ed25519"
  ServerAliveInterval 60
Host router
  HostName 192.168.2.2
  User root
Host * !router
  Port 2222
  User fallback
`)
  assert.equal(profiles.length, 3)
  assert.equal(profiles[0].host, '192.0.2.10')
  assert.equal(profiles[0].username, 'operator')
  assert.equal(profiles[0].port, '2222')
  assert.deepEqual(profiles[0].identityFiles, [String.raw`C:\Users\user\.ssh\ed25519`])
  assert.equal(profiles[1].alias, 'secondary')
  assert.equal(profiles[2].port, '22')
  assert.deepEqual(profiles[0].problems, [])
})

test('first value wins and unsupported transports or URL hosts are flagged', async () => {
  const profiles = await parse(`Host *\n User first\nHost direct\n HostName example.com\n User ignored\nHost proxy\n ProxyCommand cloudflared access ssh --hostname %h\nHost jump\n ProxyJump bastion\nHost url\n HostName https://ssh.example.com/`)
  assert.equal(profiles[0].username, 'first')
  assert.match(profiles[1].problems.join(' '), /ProxyCommand/)
  assert.match(profiles[2].problems.join(' '), /ProxyJump/)
  assert.match(profiles[3].problems.join(' '), /without https/)
})

test('Include and Match are not executed or silently treated as resolved', async () => {
  const profiles = await parse('Include ~/.ssh/more\nHost sg\nHostName 192.0.2.1\nMatch exec "some-command"\nUser hidden\nHost other\nHostName 192.0.2.2')
  assert.equal(profiles[0].username, '')
  assert.equal(profiles.length, 2)
  assert(profiles.every((profile) => profile.problems.length === 2))
})
