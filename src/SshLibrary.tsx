import { useEffect, useState } from 'react'
import { FileKey2, FileText, Save, Trash2, X } from 'lucide-react'
import WindowFrame from './WindowFrame'
import type { StoredSshProfile } from './SshConfigImport'

type Identity = { id: string; name: string; publicKey: string; keyFingerprint: string; uploadFileName: string; context: string; createdAt: string }
export type StoredSshKeyFile = Identity & { source: 'library' | 'vps'; hostName?: string }

export default function SshLibrary({ desktop, minimized, focusToken, profiles, identities, onClose, onMinimize, onSaveProfileContext, onSaveIdentityContext, onDeleteProfile, onDeleteIdentity, onDeleteAttachedKey }: {
  desktop: boolean; minimized: boolean; focusToken: number; profiles: StoredSshProfile[]; identities: StoredSshKeyFile[]
  onClose: () => void; onMinimize: () => void
  onSaveProfileContext: (configName: string, context: string) => Promise<void>
  onSaveIdentityContext: (identity: StoredSshKeyFile, context: string) => Promise<void>
  onDeleteProfile: (configName: string) => Promise<void>
  onDeleteIdentity: (identity: StoredSshKeyFile) => Promise<void>
  onDeleteAttachedKey: (nodeId: string) => Promise<void>
}) {
  const [profileNotes, setProfileNotes] = useState<Record<string, string>>({})
  const [identityNotes, setIdentityNotes] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')
  const [confirmingRemoval, setConfirmingRemoval] = useState('')
  useEffect(() => {
    setProfileNotes(Object.fromEntries([...new Set(profiles.map((profile) => profile.configName))].map((name) => [name, profiles.find((profile) => profile.configName === name)?.context || ''])))
    setIdentityNotes(Object.fromEntries(identities.map((identity) => [`${identity.source}:${identity.id}`, identity.context || ''])))
  }, [profiles, identities])
  const configNames = [...new Set(profiles.map((profile) => profile.configName))]
  const save = async (id: string, callback: () => Promise<void>) => {
    setSaving(id)
    setError('')
    try { await callback() }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this change.') }
    finally { setSaving('') }
  }

  return <WindowFrame desktop={desktop} title="SSH File Library" onClose={onClose} onMinimize={onMinimize} focusToken={focusToken} minimized={minimized} wide>
    <section className="ssh-library-view">
      <header className="modal-heading"><div><span className="modal-kicker">SAVED SSH FILES</span><h2>SSH library</h2><p>Browse uploaded config files and keys stored for reuse or on a VPS. Add a short note to remember what each one is for.</p></div>{!desktop && <button type="button" className="ssh-library-close" aria-label="Close SSH file library" onClick={onClose}><X size={17} /></button>}</header>
      <p className="key-help">Config files show their imported host settings. Private keys stay encrypted and are never displayed here.</p>
      {error && <p className="key-file-error" role="alert">{error}</p>}
      <section className="ssh-library-section"><h3><FileText size={17} /> SSH config files <small>{configNames.length}</small></h3>
        {configNames.length === 0 && <p className="key-help">No config files saved yet. Use “Add connection” to import your SSH config.</p>}
        {configNames.map((name) => { const entries = profiles.filter((profile) => profile.configName === name); const fileName = entries[0]?.uploadFileName || name; return <article className="ssh-library-file" key={name}>
          <div className="ssh-library-file-heading"><FileText size={18} /><div><strong>{fileName}</strong><small>{name} · {entries.length} saved host {entries.length === 1 ? 'alias' : 'aliases'}</small></div><button type="button" className="danger-quiet" disabled={saving === `remove:config:${name}`} onClick={() => void save(`remove:config:${name}`, () => onDeleteProfile(name))}><Trash2 size={14} />{saving === `remove:config:${name}` ? 'Removing…' : 'Remove'}</button></div>
          <label className="field-label">File context<textarea className="text-input ssh-library-context" value={profileNotes[name] ?? ''} onChange={(event) => setProfileNotes((current) => ({ ...current, [name]: event.target.value }))} maxLength={1000} placeholder="What is this config for? Add any reminders." /></label>
          <button type="button" className="secondary-button" disabled={saving === `config:${name}`} onClick={() => void save(`config:${name}`, () => onSaveProfileContext(name, profileNotes[name] || ''))}><Save size={14} />{saving === `config:${name}` ? 'Saving…' : 'Save context'}</button>
          <div className="ssh-library-aliases">{entries.map((profile) => <div className="ssh-library-alias" key={profile.id}><strong>{profile.alias}</strong><span>{profile.username || 'user not set'}@{profile.host}:{profile.port}</span>{profile.identityFiles.map((identityFile) => <small key={identityFile}>Key path: {identityFile}</small>)}{profile.problems.map((problem) => <small className="key-file-error" key={problem}>{problem}</small>)}</div>)}</div>
        </article> })}
      </section>
      <section className="ssh-library-section"><h3><FileKey2 size={17} /> Private-key files <small>{identities.length}</small></h3>
        {identities.length === 0 && <p className="key-help">No SSH keys have been uploaded yet. Keys saved for reuse and keys stored on a VPS appear here.</p>}
        {identities.map((identity) => {
          const fileId = `${identity.source}:${identity.id}`
          return <article className="ssh-library-file" key={fileId}>
            <div className="ssh-library-file-heading"><FileKey2 size={18} /><div><strong>{identity.uploadFileName || (identity.source === 'vps' ? `Key attached to ${identity.hostName || identity.name}` : 'Pasted private key')}</strong><small>{identity.source === 'vps' ? `VPS ${identity.hostName || identity.name}` : identity.name}{identity.keyFingerprint ? ` · ${identity.keyFingerprint}` : ''}</small></div>{identity.source === 'library' ? <button type="button" className="danger-quiet" disabled={saving === `remove:key:${fileId}`} onClick={() => void save(`remove:key:${fileId}`, () => onDeleteIdentity(identity))}><Trash2 size={14} />{saving === `remove:key:${fileId}` ? 'Removing…' : 'Remove'}</button> : <button type="button" className="danger-quiet" onClick={() => setConfirmingRemoval(fileId)}><Trash2 size={14} />Remove key</button>}</div>
            <label className="field-label">File context<textarea className="text-input ssh-library-context" value={identityNotes[fileId] ?? ''} onChange={(event) => setIdentityNotes((current) => ({ ...current, [fileId]: event.target.value }))} maxLength={1000} placeholder="Which hosts or account is this key for?" /></label>
            <button type="button" className="secondary-button" disabled={saving === `key:${fileId}`} onClick={() => void save(`key:${fileId}`, () => onSaveIdentityContext(identity, identityNotes[fileId] || ''))}><Save size={14} />{saving === `key:${fileId}` ? 'Saving…' : 'Save context'}</button>
            {confirmingRemoval === fileId && <div className="ssh-key-remove-confirm"><span>This removes the key from {identity.hostName || identity.name} and disables SSH access from Orbit.</span><button type="button" className="secondary-button" onClick={() => setConfirmingRemoval('')}>Keep key</button><button type="button" className="danger-button" disabled={saving === `remove:key:${fileId}`} onClick={() => void save(`remove:key:${fileId}`, async () => { await onDeleteAttachedKey(identity.id); setConfirmingRemoval('') })}>{saving === `remove:key:${fileId}` ? 'Removing…' : 'Remove key'}</button></div>}
            <small className="key-help">The private-key file remains encrypted; only its public fingerprint is shown here.</small>
          </article>
        })}
      </section>
    </section>
  </WindowFrame>
}
