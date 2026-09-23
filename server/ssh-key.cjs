const { utils } = require('ssh2')
const crypto = require('node:crypto')

module.exports = function readPrivateKey(privateKey, passphrase = '') {
  if (typeof privateKey !== 'string' || !privateKey.trim() || Buffer.byteLength(privateKey) > 48000) throw new Error('Choose a private key file or paste a private key (maximum 48 KB).')
  if (typeof passphrase !== 'string' || passphrase.length > 500) throw new Error('Key passphrase must be 500 characters or fewer.')
  const normalized = privateKey.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  let parsed
  try { parsed = utils.parseKey(normalized, passphrase || undefined) } catch { throw new Error('Could not read the private key. Check its format and passphrase.') }
  if (parsed instanceof Error) throw new Error('Could not unlock or read the private key. Use an OpenSSH or PEM private key and enter its passphrase if encrypted.')
  const keys = Array.isArray(parsed) ? parsed : [parsed]
  if (keys.length !== 1 || !keys[0]?.isPrivateKey()) throw new Error('Import the private key, not the .pub file. The matching public key belongs on the VPS.')
  const key = keys[0]
  const publicBytes = key.getPublicSSH()
  return {
    privateKey: normalized,
    passphrase,
    publicKey: `${key.type} ${publicBytes.toString('base64')}`,
    keyFingerprint: 'SHA256:' + crypto.createHash('sha256').update(publicBytes).digest('base64').replace(/=+$/, ''),
  }
}
