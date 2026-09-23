import { useEffect, useRef, useState } from 'react'
import { parseSshConfig, type SshProfile } from './sshConfig'

export default function SshConfigImport({ onSelect }: { onSelect: (profile: SshProfile) => void }) {
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [alias, setAlias] = useState('')
  const [error, setError] = useState('')
  const revision = useRef(0)
  useEffect(() => () => { ++revision.current }, [])
  const selected = profiles.find((profile) => profile.alias === alias)
  return <details className="ssh-config-import"><summary>Import from SSH config</summary>
    <p className="key-help">Choose your .ssh/config file, for example C:\Users\bypja\.ssh\config. The file is read in your browser; only the host you choose is used.</p>
    <label className="field-label" htmlFor="ssh-config-file">SSH config file<input id="ssh-config-file" className="text-input key-file-input" type="file" onChange={async (event) => {
      const file = event.target.files?.[0], version = ++revision.current
      event.target.value = ''
      if (!file) return
      setError(''); setProfiles([]); setAlias('')
      if (file.size > 256000) { setError('Choose an SSH config file smaller than 256 KB.'); return }
      try {
        const source = await file.text()
        if (version !== revision.current) return
        const parsed = parseSshConfig(source)
        if (!parsed.length) { setError('No named Host entries were found in this file.'); return }
        setProfiles(parsed); setAlias(parsed[0].alias)
      } catch { if (version === revision.current) setError('Could not read the SSH config file.') }
    }} /></label>
    {error && <p className="key-file-error" role="alert">{error}</p>}
    {profiles.length > 0 && <label className="field-label" htmlFor="ssh-config-host">Host alias<select id="ssh-config-host" className="text-input" value={alias} onChange={(event) => setAlias(event.target.value)}>{profiles.map((profile) => <option key={profile.alias} value={profile.alias}>{profile.alias}{profile.problems.length ? ' — needs review' : ''}</option>)}</select></label>}
    {selected && <div className="ssh-config-preview"><p>{selected.username || '(choose user)'}@{selected.host}:{selected.port}</p>{selected.identityFiles.map((file) => <p key={file} className="key-help">IdentityFile: <code>{file}</code></p>)}{selected.problems.map((problem) => <p key={problem} className="key-file-error">{problem}</p>)}<p className="key-help">Imports HostName, User, and Port, with an IdentityFile hint. Other SSH options are not applied. Select the private-key file below after importing.</p><button type="button" className="secondary-button" disabled={selected.problems.length > 0} onClick={() => onSelect(selected)}>Use this host</button></div>}
  </details>
}
