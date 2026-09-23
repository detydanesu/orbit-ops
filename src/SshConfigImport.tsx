import { useEffect, useRef, useState } from 'react'
import { parseSshConfig, type SshProfile } from './sshConfig'

export type StoredSshProfile = SshProfile & { id: string; configName: string; uploadFileName: string; context: string }

export default function SshConfigImport({ onSelect, savedProfiles, onOpenLibrary }: {
  onSelect: (profile: SshProfile) => void
  savedProfiles: StoredSshProfile[]
  onOpenLibrary: () => void
}) {
  const [selection, setSelection] = useState('')
  const names = [...new Set(savedProfiles.map((profile) => profile.configName))]
  const selected = savedProfiles.find((profile) => profile.id === selection)
  return <details className="ssh-config-import"><summary>Choose a saved SSH host</summary>
    {savedProfiles.length === 0 ? <div className="ssh-library-empty"><p>No SSH config aliases are saved yet.</p><button type="button" className="secondary-button" onClick={onOpenLibrary}>Open SSH Files</button></div> : <>
      <label className="field-label" htmlFor="saved-ssh-host">Host alias<select id="saved-ssh-host" className="text-input" value={selection} onChange={(event) => setSelection(event.target.value)}><option value="">Choose a saved host alias…</option>{names.map((name) => <optgroup key={name} label={name}>{savedProfiles.filter((profile) => profile.configName === name).map((profile) => <option key={profile.id} value={profile.id}>{profile.alias}{profile.problems.length ? ' — needs review' : ''}</option>)}</optgroup>)}</select></label>
      {selected && <div className="ssh-config-preview"><p>{selected.username || '(choose user)'}@{selected.host}:{selected.port}</p>{selected.identityFiles.map((file) => <p key={file} className="key-help">Key path: <code>{file}</code></p>)}{selected.problems.map((problem) => <p key={problem} className="key-file-error">{problem}</p>)}<p className="key-help">Host, user, and port come from this saved alias. Select a private key from the library below.</p><button type="button" className="secondary-button" disabled={selected.problems.length > 0} onClick={() => onSelect(selected)}>Use saved host</button></div>}
    </>}
    <p className="key-help">Upload or remove SSH config files in SSH Files.</p>
  </details>
}

export function SshConfigUpload({ onSave }: {
  onSave: (configName: string, uploadFileName: string, profiles: SshProfile[]) => Promise<void>
}) {
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [configName, setConfigName] = useState('')
  const [uploadFileName, setUploadFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)

  useEffect(() => () => { ++revision.current }, [])
  const chooseFile = async (file?: File) => {
    const version = ++revision.current
    setError('')
    setProfiles([])
    setUploadFileName('')
    if (!file) return
    if (file.size > 256000) { setError('Choose an SSH config file smaller than 256 KB.'); return }
    try {
      const source = await file.text()
      if (version !== revision.current) return
      const parsed = parseSshConfig(source)
      if (!parsed.length) { setError('No named Host entries were found in this file.'); return }
      setProfiles(parsed)
      setUploadFileName(file.name)
      setConfigName(file.name.replace(/\.[^.]+$/, '').slice(0, 80))
    } catch {
      if (version === revision.current) setError('Could not read the SSH config file.')
    }
  }

  return <div className="ssh-library-uploader">
    <p className="key-help">Choose a .ssh/config file. It is parsed in your browser; the original text is not uploaded or stored.</p>
    <label className="field-label" htmlFor="ssh-config-file">Upload SSH config<input id="ssh-config-file" className="text-input key-file-input" type="file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void chooseFile(file) }} /></label>
    {profiles.length > 0 && <>
      <p className="key-help">Selected file: <code>{uploadFileName}</code></p>
      <label className="field-label" htmlFor="ssh-config-name">Library name<input id="ssh-config-name" className="text-input" value={configName} onChange={(event) => setConfigName(event.target.value)} maxLength={80} required /></label>
      <div className="ssh-library-aliases">{profiles.map((profile) => <div className="ssh-library-alias" key={profile.alias}><strong>{profile.alias}</strong><span>{profile.username || 'user not set'}@{profile.host}:{profile.port}</span>{profile.problems.map((problem) => <small className="key-file-error" key={problem}>{problem}</small>)}</div>)}</div>
      <button type="button" className="secondary-button" disabled={saving || !configName.trim()} onClick={async () => { setSaving(true); setError(''); try { await onSave(configName.trim(), uploadFileName, profiles); setProfiles([]); setUploadFileName(''); setConfigName('') } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this config.') } finally { setSaving(false) } }}>{saving ? 'Saving config…' : 'Save ' + profiles.length + ' host aliases'}</button>
    </>}
    {error && <p className="key-file-error" role="alert">{error}</p>}
  </div>
}
