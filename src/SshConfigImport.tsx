import { useEffect, useRef, useState } from 'react'
import { parseSshConfig, type SshProfile } from './sshConfig'

export type StoredSshProfile = SshProfile & { id: string; configName: string; uploadFileName: string; context: string }

export default function SshConfigImport({ onSelect, savedProfiles, onSave, onDelete }: {
  onSelect: (profile: SshProfile) => void
  savedProfiles: StoredSshProfile[]
  onSave: (configName: string, uploadFileName: string, profiles: SshProfile[]) => Promise<void>
  onDelete: (configName: string) => Promise<void>
}) {
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [configName, setConfigName] = useState('')
  const [uploadFileName, setUploadFileName] = useState('')
  const [selection, setSelection] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  useEffect(() => () => { ++revision.current }, [])
  const saved = savedProfiles.find((profile) => profile.id === selection)
  const selected = saved || profiles.find((profile) => profile.alias === selection)
  const names = [...new Set(savedProfiles.map((profile) => profile.configName))]
  return <details className="ssh-config-import"><summary>Saved SSH hosts and keys</summary>
    {savedProfiles.length > 0 && <label className="field-label" htmlFor="saved-ssh-host">Saved host alias<select id="saved-ssh-host" className="text-input" value={saved ? selection : ''} onChange={(event) => setSelection(event.target.value)}><option value="">Choose a saved host alias…</option>{names.map((name) => <optgroup key={name} label={name}>{savedProfiles.filter((profile) => profile.configName === name).map((profile) => <option key={profile.id} value={profile.id}>{profile.alias}{profile.problems.length ? ' — needs review' : ''}</option>)}</optgroup>)}</select></label>}
    <p className="key-help">Choose your .ssh/config file, for example C:\Users\bypja\.ssh\config. The file is read in your browser; only parsed host settings are stored.</p>
    <label className="field-label" htmlFor="ssh-config-file">SSH config file<input id="ssh-config-file" className="text-input key-file-input" type="file" onChange={async (event) => {
      const file = event.target.files?.[0], version = ++revision.current
      event.target.value = ''
      if (!file) return
      setError(''); setProfiles([]); setSelection(''); setUploadFileName(file.name); setConfigName(file.name.replace(/\.[^.]+$/, '').slice(0, 80))
      if (file.size > 256000) { setError('Choose an SSH config file smaller than 256 KB.'); return }
      try {
        const source = await file.text()
        if (version !== revision.current) return
        const parsed = parseSshConfig(source)
        if (!parsed.length) { setError('No named Host entries were found in this file.'); return }
        setProfiles(parsed); setSelection(parsed[0].alias)
      } catch { if (version === revision.current) setError('Could not read the SSH config file.') }
    }} /></label>
    {profiles.length > 0 && <><p className="key-help">Selected file: <code>{uploadFileName}</code></p><label className="field-label" htmlFor="ssh-config-name">Save config as<input id="ssh-config-name" className="text-input" value={configName} onChange={(event) => setConfigName(event.target.value)} maxLength={80} required /></label><button type="button" className="secondary-button" disabled={saving || !configName.trim()} onClick={async () => { setSaving(true); setError(''); try { await onSave(configName.trim(), uploadFileName, profiles); setProfiles([]); setSelection('') } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this config.') } finally { setSaving(false) } }}>{saving ? 'Saving config…' : `Save ${profiles.length} host aliases`}</button><label className="field-label" htmlFor="ssh-config-host">Host alias<select id="ssh-config-host" className="text-input" value={saved ? '' : selection} onChange={(event) => setSelection(event.target.value)}>{profiles.map((profile) => <option key={profile.alias} value={profile.alias}>{profile.alias}{profile.problems.length ? ' — needs review' : ''}</option>)}</select></label></>}
    {error && <p className="key-file-error" role="alert">{error}</p>}
    {selected && <div className="ssh-config-preview"><p>{selected.username || '(choose user)'}@{selected.host}:{selected.port}</p>{selected.identityFiles.map((file) => <p key={file} className="key-help">IdentityFile: <code>{file}</code></p>)}{selected.problems.map((problem) => <p key={problem} className="key-file-error">{problem}</p>)}<p className="key-help">HostName, User, and Port are imported. Other SSH options are not applied. Select or save the matching private key below.</p><button type="button" className="secondary-button" disabled={selected.problems.length > 0} onClick={() => onSelect(selected)}>{saved ? 'Use saved host' : 'Use this host'}</button></div>}
    {names.map((name) => <button key={name} type="button" className="danger-quiet" onClick={() => void onDelete(name)}>Delete saved config “{name}”</button>)}
  </details>
}
