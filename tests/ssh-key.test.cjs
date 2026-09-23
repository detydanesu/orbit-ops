const { test } = require('node:test')
const assert = require('node:assert/strict')
const { utils } = require('ssh2')
const readPrivateKey = require('../server/ssh-key.cjs')

test('OpenSSH Ed25519, RSA and ECDSA keys derive their matching public key', () => {
  for (const [type, options] of [['ed25519', {}], ['rsa', { bits: 2048 }], ['ecdsa', { bits: 256 }]]) {
    const pair = utils.generateKeyPairSync(type, options)
    const result = readPrivateKey('\uFEFF' + pair.private.replace(/\n/g, '\r\n'))
    assert.equal(result.publicKey, pair.public.trim())
    assert.match(result.keyFingerprint, /^SHA256:/)
    assert.equal(result.passphrase, '')
  }
})

test('encrypted OpenSSH key needs its passphrase, and public keys are rejected', () => {
  const pair = utils.generateKeyPairSync('ed25519', { cipher: 'aes256-ctr', passphrase: 'test-key-only' })
  assert.equal(readPrivateKey(pair.private, 'test-key-only').publicKey, pair.public.trim())
  assert.throws(() => readPrivateKey(pair.private), /unlock or read/)
  assert.throws(() => readPrivateKey(pair.private, 'wrong'), /unlock or read/)
  assert.throws(() => readPrivateKey(pair.public), /not the .pub/)
  assert.throws(() => readPrivateKey('invalid key'), /unlock or read/)
  assert.throws(() => readPrivateKey('x'.repeat(48001)), /48 KB/)
})
