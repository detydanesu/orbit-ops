import { useEffect, useRef, useState } from 'react'

export default function SshKeyUpload({ onSave }: {
  onSave: (name: string, privateKey: string, passphrase: string, uploadFileName: string) => Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const revision = useRef(0)
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [name, setName] = useState('')
  const [fileName, setFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => () => { ++revision.current }, [])
  const chooseFile = async (file?: File) => {
    const version = ++revision.current
    setError('')
    setPrivateKey('')
    setPassphrase('')
    setFileName('')
    if (!file) return
    if (file.size > 48000) { setError('The private key must be smaller than 48 KB.'); return }
    try {
      const text = await file.text()
      if (version !== revision.current) return
      if (!/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
        setError('Choose a private-key file such as id_ed25519 or id_rsa, not a .pub file.')
        return
      }
      setPrivateKey(text)
      setFileName(file.name)
      setName(file.name.replace(/\.[^.]+$/, '').slice(0, 80))
    } catch {
      if (version === revision.current) setError('Could not read this file. Try selecting it again.')
    }
  }

  const upload = async () => {
    setSaving(true)
    setError('')
    try {
      await onSave(name.trim(), privateKey, passphrase, fileName)
      setPrivateKey('')
      setPassphrase('')
      setName('')
      setFileName('')
      if (inputRef.current) inputRef.current.value = ''
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save this SSH key.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="ssh-library-uploader">
    <p className="key-help">Upload an OpenSSH private-key file here. Its contents and passphrase are encrypted before storage and never shown again.</p>
    <label className="field-label" htmlFor="ssh-library-key-file">Upload private key<input ref={inputRef} id="ssh-library-key-file" type="file" className="text-input key-file-input" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void chooseFile(file) }} /></label>
    {privateKey && <>
      <p className="key-help" role="status">Selected: <strong>{fileName}</strong></p>
      <label className="field-label" htmlFor="ssh-library-key-name">Library name<input id="ssh-library-key-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
      <label className="field-label" htmlFor="ssh-library-key-passphrase">Key passphrase <span className="optional-label">IF ENCRYPTED</span><input id="ssh-library-key-passphrase" className="text-input" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
      <button type="button" className="secondary-button" disabled={saving || !name.trim()} onClick={() => void upload()}>{saving ? 'Encrypting and saving…' : 'Save key to library'}</button>
    </>}
    {error && <p className="key-file-error" role="alert">{error}</p>}
  </div>
}
