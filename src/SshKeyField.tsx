import { useEffect, useRef, useState } from 'react'

export default function SshKeyField({ value, onChange, hint, required = true }: { hint?: string; value: string; required?: boolean; onChange: (value: string, fileName?: string) => void }) {
  const [error, setError] = useState('')
  const [filename, setFilename] = useState('')
  const revision = useRef(0)
  useEffect(() => () => { ++revision.current }, [])
  return <div className="ssh-key-field">
    <label className="field-label" htmlFor="ssh-key-file">OpenSSH private-key file
      <input id="ssh-key-file" type="file" className="text-input key-file-input" onChange={async (event) => {
        const version = ++revision.current
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        onChange(''); setFilename('')
        setError('')
        if (file.size > 48000) { setError('The private key must be smaller than 48 KB.'); return }
        try {
          const text = await file.text()
          if (version !== revision.current) return
          if (!/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) { setError('Choose your private key, such as id_ed25519 or id_rsa, rather than its .pub file.'); return }
          onChange(text, file.name); setFilename(file.name)
        } catch { if (version === revision.current) setError('Could not read this file. Try selecting it again.') }
      }} />
    </label>
    {hint && <p className="key-help">Config key path: <code>{hint}</code></p>}
    <p className="key-help">Choose id_ed25519, id_rsa, or a PEM private key, or paste it below. Add the matching public key to the VPS user’s ~/.ssh/authorized_keys.</p>
    {filename && <p className="key-help" role="status">Loaded: {filename}</p>}
    {error && <p className="key-file-error" role="alert">{error}</p>}
    <label className="field-label" htmlFor="ssh-key">Private key<textarea id="ssh-key" className="text-input key-input" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={value} onChange={(event) => { ++revision.current; setFilename(''); setError(''); onChange(event.target.value) }} spellCheck={false} autoComplete="off" autoCapitalize="none" required={required} /></label>
  </div>
}
