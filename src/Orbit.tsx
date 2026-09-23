import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import {
  addEdge, Background, BackgroundVariant, Controls, Handle, MiniMap, Position,
  ReactFlow, ReactFlowProvider, type Connection, type Edge, type Node, type NodeProps,
  useEdgesState, useNodesState,
} from '@xyflow/react'
import {
  Activity, ArrowDownRight, ArrowUpRight, Box, Cable, Check, Cloud, Command, Database, FolderOpen,
  Globe2, KeyRound, Layers3, LoaderCircle, LogOut, Plus, Server, ShieldCheck,
  ExternalLink, Monitor, Pencil, Trash2, Waypoints, X,
} from 'lucide-react'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './Dashboard.css'
import './Orbit.css'
import './Canvas.css'
import './Workspace.css'
import Desktop from './Desktop'
import WindowFrame from './WindowFrame'
import SshKeyField from './SshKeyField'
import SshConfigImport, { type StoredSshProfile } from './SshConfigImport'
import SshLibrary, { type StoredSshKeyFile } from './SshLibrary'

type ResourceType = 'vps' | 'service' | 'tunnel' | 'external'
type ResourceData = {
  name: string; kind: string; meta: string; status: string
  tint: 'cyan' | 'violet' | 'orange' | 'blue'
  icon: 'server' | 'cloud' | 'database' | 'globe'
  resourceType: ResourceType; host?: string; port?: number; username?: string
  endpoint?: string; provider?: string; location?: string; notes?: string
  publicKey?: string; keyFingerprint?: string; hasPrivateKey?: boolean; hostFingerprint?: string; connectionStatus?: string; lastCheckedAt?: string
}
type ResourceNode = Node<ResourceData>
type GraphBoard = { id: string; name: string; resourceCount: number }
type StoredSshIdentity = { id: string; name: string; publicKey: string; keyFingerprint: string; uploadFileName: string; context: string; createdAt: string }
type GraphResponse = { nodes: ResourceNode[]; edges: Edge[]; demo: boolean; boards: GraphBoard[]; boardId: string }
type LoginResponse = { authenticated: boolean }
type SshResult = { ok: boolean; error?: string; needsTrust?: boolean; fingerprint?: string; replacesExisting?: boolean; previousFingerprint?: string; checkedAt?: string }
type Draft = { type: ResourceType; name: string; host: string; port: string; username: string; privateKey: string; passphrase: string; provider: string; endpoint: string; location: string; notes: string; parentId: string }

const sampleNodes: ResourceNode[] = [
  { id: 'sample-origin', type: 'resource', position: { x: 74, y: 185 }, data: { name: 'Origin node', kind: 'VPS · SINGAPORE', meta: '203.0.113.14:22 · root', status: 'EXAMPLE', tint: 'cyan', icon: 'server', resourceType: 'vps', host: '203.0.113.14', port: 22, username: 'root' } },
  { id: 'sample-tunnel', type: 'resource', position: { x: 336, y: 35 }, data: { name: 'Edge tunnel', kind: 'CLOUDFLARE · TUNNEL', meta: 'origin.example.net', status: 'EXAMPLE', tint: 'orange', icon: 'cloud', resourceType: 'tunnel', provider: 'Cloudflare', endpoint: 'origin.example.net' } },
  { id: 'sample-service', type: 'resource', position: { x: 336, y: 330 }, data: { name: 'Relay service', kind: 'SERVICE · DOCKER', meta: 'localhost:8080', status: 'EXAMPLE', tint: 'violet', icon: 'database', resourceType: 'service', provider: 'Docker', endpoint: 'localhost:8080' } },
  { id: 'sample-public', type: 'resource', position: { x: 624, y: 185 }, data: { name: 'Public endpoint', kind: 'EXTERNAL · WEB', meta: 'app.example.net', status: 'EXAMPLE', tint: 'blue', icon: 'globe', resourceType: 'external', provider: 'HTTPS', endpoint: 'app.example.net' } },
]
const sampleEdges: Edge[] = [
  { id: 'sample-a', source: 'sample-origin', target: 'sample-tunnel', sourceHandle: 'out', targetHandle: 'in', label: 'INGRESS', type: 'smoothstep', animated: true, style: { stroke: '#37d5ca', strokeWidth: 1.5 }, labelStyle: { fill: '#8293a7', fontSize: 10 }, labelBgStyle: { fill: '#111923' } },
  { id: 'sample-b', source: 'sample-origin', target: 'sample-service', sourceHandle: 'out', targetHandle: 'in', label: 'HOSTS', type: 'smoothstep', style: { stroke: '#9472ff', strokeWidth: 1.3 }, labelStyle: { fill: '#8293a7', fontSize: 10 }, labelBgStyle: { fill: '#111923' } },
  { id: 'sample-c', source: 'sample-tunnel', target: 'sample-public', sourceHandle: 'out', targetHandle: 'in', label: 'ROUTES TO', type: 'smoothstep', animated: true, style: { stroke: '#ffad69', strokeWidth: 1.5 }, labelStyle: { fill: '#8293a7', fontSize: 10 }, labelBgStyle: { fill: '#111923' } },
  { id: 'sample-d', source: 'sample-service', target: 'sample-public', sourceHandle: 'out', targetHandle: 'in', label: 'SERVES', type: 'smoothstep', style: { stroke: '#9472ff', strokeWidth: 1.3 }, labelStyle: { fill: '#8293a7', fontSize: 10 }, labelBgStyle: { fill: '#111923' } },
]
const blankDraft: Draft = { type: 'vps', name: '', host: '', port: '22', username: '', privateKey: '', passphrase: '', provider: '', endpoint: '', location: '', notes: '', parentId: '' }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' })
  const payload = response.status === 204 ? undefined : await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`)
  return payload as T
}

function endpointUrl(value: string) {
  const input = value.trim()
  if (!input || input.startsWith('//')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^https?:\/\//i.test(input) && !/^[a-z][a-z\d.-]*(?::\d+)?(?:\/|$)/i.test(input)) return null
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

function TerminalWindow({ nodeId, name, onClose, desktop, minimized, onMinimize, focusToken }: { nodeId: string; name: string; onClose: () => void; desktop: boolean; minimized: boolean; onMinimize: () => void; focusToken: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Connecting')

  useEffect(() => {
    if (!hostRef.current) return
    let disposed = false
    let cleanup = () => undefined
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed || !hostRef.current) return
      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 13,
        theme: { background: '#0a1016', foreground: '#dce7ef', cursor: '#55d5cb', selectionBackground: '#244149', black: '#111820', brightBlack: '#647687', green: '#79d9af', brightGreen: '#9becbc', red: '#ef8c8c', brightRed: '#ffaaaa', blue: '#77aeea', brightBlue: '#a5c8ff', yellow: '#eac77f', brightYellow: '#f7df9e' },
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(hostRef.current)
      const socketUrl = new URL('/api/terminal', window.location.href)
      socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      socketUrl.searchParams.set('nodeId', nodeId)
      const socket = new WebSocket(socketUrl)
      let frame = 0
      const syncSize = () => {
        if (socket.readyState !== WebSocket.OPEN) return
        try { fit.fit(); socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })) } catch { /* the terminal can be between layout sizes */ }
      }
      const onData = terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
      })
      socket.onopen = () => {
        setStatus('SSH connected · opening terminal')
        frame = window.requestAnimationFrame(syncSize)
      }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; data?: string; message?: string }
          if (message.type === 'ready') { setStatus('Connected'); syncSize() }
          else if (message.type === 'output' && typeof message.data === 'string') terminal.write(message.data)
          else if (message.type === 'error' && typeof message.message === 'string') terminal.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`)
        } catch { terminal.write('\r\n\x1b[31mReceived an invalid terminal response.\x1b[0m\r\n') }
      }
      socket.onerror = () => setStatus('Connection error')
      socket.onclose = () => setStatus('Disconnected')
      const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(syncSize) })
      observer.observe(hostRef.current)
      cleanup = () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
        onData.dispose()
        if (socket.readyState < WebSocket.CLOSING) socket.close()
        terminal.dispose()
      }
    })().catch(() => { if (!disposed) setStatus('Terminal could not load. Refresh and try again.') })
    return () => {
      disposed = true
      cleanup()
    }
  }, [nodeId])

  return <WindowFrame desktop={desktop} title={`Terminal · ${name}`} onClose={onClose} wide focusToken={focusToken} minimized={minimized} onMinimize={onMinimize}><section className="terminal-modal"><header className="terminal-heading"><div><span className="modal-kicker">SSH SESSION</span><h2>{name}</h2><p><i className={status === 'Connected' ? 'terminal-live' : ''} />{status}</p></div><button className="modal-close" onClick={onClose} aria-label="Close terminal"><X size={17} /></button></header><div ref={hostRef} className="terminal-screen" /><footer className="terminal-footer"><span>SSH · XTERM-256COLOR</span><span>SESSION ENDS WHEN THIS WINDOW CLOSES</span></footer></section></WindowFrame>
}

function ResourceNodeView({ data, selected }: NodeProps<ResourceNode>) {
  const Icon = data.icon === 'server' ? Server : data.icon === 'cloud' ? Cloud : data.icon === 'database' ? Database : Globe2
  return <article className={`resource-node tint-${data.tint}${selected ? ' is-selected' : ''}`}>
    <Handle id="in" type="target" position={Position.Left} className="node-port port-target" />
    <span className="node-icon"><Icon size={17} strokeWidth={1.8} /></span>
    <span className="node-copy"><span className="node-kind">{data.kind}</span><strong>{data.name}</strong><span className="node-meta">{data.meta}</span></span>
    <span className={`node-state ${data.status === 'CHECK OK' ? 'state-good' : ''}`}><i />{data.status}</span>
    <Handle id="out" type="source" position={Position.Right} className="node-port port-source" />
  </article>
}
const nodeTypes = { resource: ResourceNodeView }

function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await request<LoginResponse>('/session', { method: 'POST', body: JSON.stringify({ password }) }); setPassword(''); onSuccess() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sign in.') }
    finally { setBusy(false) }
  }
  return <main className="signin-screen"><form className="signin-card" onSubmit={submit}>
    <div className="signin-brand"><span className="brand-mark"><Waypoints size={21} /></span><span>ORBIT <b>OPS</b></span></div>
    <span className="signin-kicker">SELF-HOSTED CONTROL PLANE</span><h1>Sign in to your map.</h1><p>Use the dashboard password configured on this server.</p>
    {import.meta.env.DEV && <div className="dev-warning">Local development mode uses a fixed encryption key. Do not save real SSH keys here.</div>}
    <label className="field-label" htmlFor="admin-password">Dashboard password</label><input id="admin-password" className="text-input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required />
    {error && <div className="form-error" role="alert">{error}</div>}
    <button className="primary-button signin-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />} Sign in</button>
    <div className="signin-foot"><ShieldCheck size={14} /> Private keys are encrypted on this server.</div>
  </form></main>
}

function App() {
  const [view, setView] = useState<'map' | 'desktop'>(() => { try { return localStorage.getItem('orbit-view') === 'desktop' ? 'desktop' : 'map' } catch { return 'map' } })
  const desktop = view === 'desktop'
  const [boards, setBoards] = useState<GraphBoard[]>([])
  const [boardId, setBoardId] = useState('default')
  const boardRef = useRef('default')
  const graphRequest = useRef(0)
  const [boardLoading, setBoardLoading] = useState(false)
  const [boardDialog, setBoardDialog] = useState<'add' | 'rename' | null>(null)
  const [boardName, setBoardName] = useState('')
  const [boardBusy, setBoardBusy] = useState(false)
  const [windowFocus, setWindowFocus] = useState<Record<string, number>>({})
  const [minimizedWindows, setMinimizedWindows] = useState<string[]>([])
  const [nodes, setNodes, onNodesChange] = useNodesState<ResourceNode>(sampleNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(sampleEdges)
  const [authenticated, setAuthenticated] = useState(false)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [isDemo, setIsDemo] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(sampleNodes[0].id)
  const [addOpen, setAddOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [terminalNode, setTerminalNode] = useState<ResourceNode | null>(null)
  const [sshIdentities, setSshIdentities] = useState<StoredSshIdentity[]>([])
  const [sshFiles, setSshFiles] = useState<StoredSshKeyFile[]>([])
  const [sshProfiles, setSshProfiles] = useState<StoredSshProfile[]>([])
  const [selectedIdentityId, setSelectedIdentityId] = useState('')
  const [rememberSshKey, setRememberSshKey] = useState(false)
  const [rememberSshKeyName, setRememberSshKeyName] = useState('')
  const [sshLibraryBusy, setSshLibraryBusy] = useState(false)
  const [sshLibraryOpen, setSshLibraryOpen] = useState(false)
  const [sshKeyUploadFileName, setSshKeyUploadFileName] = useState('')
  const [identityHint, setIdentityHint] = useState('')
  const [draft, setDraft] = useState<Draft>(blankDraft)
  const [saveBusy, setSaveBusy] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [trustBusy, setTrustBusy] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [verification, setVerification] = useState<SshResult | null>(null)
  const [message, setMessage] = useState<{ text: string; kind: 'error' | 'success' } | null>(null)
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 })
  const realNodes = useMemo(() => nodes.filter((node) => !node.id.startsWith('sample-')), [nodes])
  const selected = nodes.find((node) => node.id === selectedId) || null
  const activeBoard = boards.find((board) => board.id === boardId)
  const restoreWindow = (id: string) => { setMinimizedWindows((current) => current.filter((item) => item !== id)); setWindowFocus((current) => ({ ...current, [id]: (current[id] || 0) + 1 })) }
  const minimizeWindow = (id: string) => setMinimizedWindows((current) => [...new Set([...current, id])])
  const changeView = (next: 'map' | 'desktop') => { setView(next); setMinimizedWindows([]); try { localStorage.setItem('orbit-view', next) } catch { /* preferences are optional */ } }
  const closeTerminal = useCallback(() => setTerminalNode(null), [])
  const vpsNodes = nodes.filter((node) => node.data.resourceType === 'vps' && !node.id.startsWith('sample-'))
  const hostCount = nodes.filter((node) => node.data.resourceType === 'vps').length
  const tunnelCount = nodes.filter((node) => node.data.resourceType === 'tunnel').length
  const serviceCount = nodes.filter((node) => node.data.resourceType === 'service' || node.data.resourceType === 'external').length

  const loadGraph = useCallback(async (nextId = boardRef.current) => {
    const version = ++graphRequest.current
    setBoardLoading(true)
    try {
    const graph = await request<GraphResponse>(`/graph?boardId=${encodeURIComponent(nextId)}`)
    if (version !== graphRequest.current) return
    boardRef.current = graph.boardId
    setBoardId(graph.boardId)
    setBoards(graph.boards)
    setIsDemo(graph.demo)
    setNodes(graph.nodes.length ? graph.nodes.map((node) => ({ ...node, deletable: false })) : graph.demo ? sampleNodes : [])
    setEdges(graph.edges.length ? graph.edges : graph.demo ? sampleEdges : [])
    if (graph.nodes.length) setSelectedId((previous) => graph.nodes.some((node) => node.id === previous) ? previous : graph.nodes[0].id)
    else setSelectedId(graph.demo ? sampleNodes[0].id : null)
    } finally { if (version === graphRequest.current) setBoardLoading(false) }
  }, [setEdges, setNodes])

  useEffect(() => {
    request<LoginResponse>('/session').then(async (session) => {
      if (session.authenticated) { setAuthenticated(true); await loadGraph() }
    }).catch(() => undefined).finally(() => setSessionLoaded(true))
  }, [loadGraph])

  const notify = (text: string, kind: 'error' | 'success' = 'success') => { setMessage({ text, kind }); window.setTimeout(() => setMessage(null), 4400) }
  const handleSignedIn = async () => {
    setAuthenticated(true)
    try { await loadGraph() } catch (error) { notify(error instanceof Error ? error.message : 'Could not load the map.', 'error') }
  }
  const openDetails = (id = selectedId) => { if (boardLoading || !id) return; setSelectedId(id); setVerification(null); setDeleteConfirm(false); restoreWindow('details'); setDetailsOpen(true) }
  const refreshSshLibrary = async () => {
    const [identities, configs, files] = await Promise.all([request<{ identities: StoredSshIdentity[] }>('/ssh-identities'), request<{ profiles: StoredSshProfile[] }>('/ssh-profiles'), request<{ files: StoredSshKeyFile[] }>('/ssh-files')])
    setSshIdentities(identities.identities); setSshProfiles(configs.profiles); setSshFiles(files.files)
  }
  const openSshLibrary = async () => {
    try { await refreshSshLibrary(); setSshLibraryOpen(true); restoreWindow('ssh-library') }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not load saved SSH files.', 'error') }
  }
  const openAdd = () => {
    if (boardLoading) return
    setIdentityHint(''); setSshKeyUploadFileName(''); setDraft(blankDraft); setSelectedIdentityId(''); setRememberSshKey(false); setRememberSshKeyName(''); setMessage(null); restoreWindow('add'); setAddOpen(true)
    void refreshSshLibrary().catch((error) => notify(error instanceof Error ? error.message : 'Could not load saved SSH setups.', 'error'))
  }
  const saveSshConfig = async (configName: string, uploadFileName: string, profiles: Array<Omit<StoredSshProfile, 'id' | 'configName' | 'uploadFileName' | 'context'>>) => {
    setSshLibraryBusy(true)
    try {
      const result = await request<{ profiles: StoredSshProfile[] }>('/ssh-profiles', { method: 'POST', body: JSON.stringify({ configName, uploadFileName, profiles }) })
      setSshProfiles((current) => [...current.filter((profile) => profile.configName !== configName), ...result.profiles])
      notify(`Saved ${result.profiles.length} SSH host aliases.`)
    } finally { setSshLibraryBusy(false) }
  }
  const deleteSshConfig = async (configName: string) => {
    await request(`/ssh-profiles/${encodeURIComponent(configName)}`, { method: 'DELETE' })
    setSshProfiles((current) => current.filter((profile) => profile.configName !== configName)); notify(`Deleted SSH config ${configName}.`)
  }
  const saveSshIdentity = async () => {
    if (!rememberSshKeyName.trim()) { notify('Enter a name for this saved SSH key.', 'error'); return }
    setSshLibraryBusy(true)
    try {
      const result = await request<{ identity: StoredSshIdentity }>('/ssh-identities', { method: 'POST', body: JSON.stringify({ name: rememberSshKeyName, privateKey: draft.privateKey, passphrase: draft.passphrase, uploadFileName: sshKeyUploadFileName }) })
      setSshIdentities((current) => [...current, result.identity].sort((a, b) => a.name.localeCompare(b.name)))
      setSelectedIdentityId(result.identity.id); setDraft((current) => ({ ...current, privateKey: '', passphrase: '' })); setSshKeyUploadFileName(''); setRememberSshKey(false); await refreshSshLibrary()
      notify('Encrypted SSH key saved. Choose it from this list next time.')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save this SSH key.', 'error') }
    finally { setSshLibraryBusy(false) }
  }
  const deleteSshIdentity = async (id: string) => {
    await request(`/ssh-identities/${id}`, { method: 'DELETE' })
    setSshIdentities((current) => current.filter((identity) => identity.id !== id)); if (selectedIdentityId === id) setSelectedIdentityId(''); await refreshSshLibrary(); notify('Saved SSH key deleted.')
  }
  const saveSshProfileContext = async (configName: string, context: string) => {
    const result = await request<{ profiles: StoredSshProfile[] }>(`/ssh-profiles/${encodeURIComponent(configName)}/context`, { method: 'PATCH', body: JSON.stringify({ context }) })
    setSshProfiles((current) => [...current.filter((profile) => profile.configName !== configName), ...result.profiles])
    notify('SSH config context saved.')
  }
  const saveSshIdentityContext = async (identity: StoredSshKeyFile, context: string) => {
    if (identity.source === 'vps') {
      await request(`/nodes/${encodeURIComponent(identity.id)}/ssh-file-context`, { method: 'PATCH', body: JSON.stringify({ context }) })
      setSshFiles((current) => current.map((file) => file.id === identity.id && file.source === 'vps' ? { ...file, context } : file))
    } else {
      const result = await request<{ identity: StoredSshIdentity }>(`/ssh-identities/${encodeURIComponent(identity.id)}/context`, { method: 'PATCH', body: JSON.stringify({ context }) })
      setSshIdentities((current) => current.map((item) => item.id === identity.id ? result.identity : item))
      setSshFiles((current) => current.map((file) => file.id === identity.id && file.source === 'library' ? { ...file, context } : file))
    }
    notify('SSH key context saved.')
  }
  const deleteSshNodeKey = async (nodeId: string) => {
    await request(`/nodes/${encodeURIComponent(nodeId)}/ssh-key`, { method: 'DELETE' })
    await Promise.all([loadGraph(), refreshSshLibrary()])
    notify('SSH key removed from the VPS.')
  }
  const openBoardDialog = (mode: 'add' | 'rename') => { setBoardName(mode === 'rename' ? activeBoard?.name || '' : ''); restoreWindow('board'); setBoardDialog(mode) }
  const switchBoard = async (id: string) => {
    if (id === boardId || boardLoading || saveBusy || testBusy || trustBusy || boardBusy) return
    setDetailsOpen(false); setAddOpen(false); setBoardDialog(null); setVerification(null); setDeleteConfirm(false)
    try { await loadGraph(id) } catch (error) { notify(error instanceof Error ? error.message : 'Could not open this graph.', 'error') }
  }
  const saveBoard = async (event: FormEvent) => {
    event.preventDefault(); setBoardBusy(true)
    try {
      if (boardDialog === 'add') {
        const result = await request<{ board: GraphBoard }>('/boards', { method: 'POST', body: JSON.stringify({ name: boardName }) })
        setDetailsOpen(false); setAddOpen(false); setVerification(null); await loadGraph(result.board.id)
      } else { await request(`/boards/${boardId}`, { method: 'PATCH', body: JSON.stringify({ name: boardName }) }); await loadGraph() }
      setBoardDialog(null); notify(boardDialog === 'add' ? 'Graph board added.' : 'Graph renamed.')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save this graph.', 'error') }
    finally { setBoardBusy(false) }
  }
  const removeBoard = async () => {
    setBoardBusy(true)
    try { await request(`/boards/${boardId}`, { method: 'DELETE' }); setBoardDialog(null); await loadGraph('default'); notify('Empty graph removed.') }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not remove this graph.', 'error') }
    finally { setBoardBusy(false) }
  }
  const addNode = async (event: FormEvent) => {
    event.preventDefault(); setSaveBusy(true); setMessage(null)
    const x = 90 + (realNodes.length % 3) * 278
    const y = 110 + (Math.floor(realNodes.length / 3) % 2) * 205
    const body = { ...draft, privateKey: draft.type === 'vps' && !selectedIdentityId ? draft.privateKey : undefined, passphrase: draft.type === 'vps' && !selectedIdentityId ? draft.passphrase : undefined, sshIdentityId: draft.type === 'vps' ? (selectedIdentityId || undefined) : undefined, rememberSshKey: draft.type === 'vps' && rememberSshKey && !selectedIdentityId, rememberSshKeyName: draft.type === 'vps' && rememberSshKey && !selectedIdentityId ? rememberSshKeyName : undefined, sshKeyUploadFileName: draft.type === 'vps' && !selectedIdentityId ? sshKeyUploadFileName : undefined, boardId, port: Number(draft.port || 22), x, y, parentId: draft.parentId || undefined }
    try {
      await request('/nodes', { method: 'POST', body: JSON.stringify(body) })
      if (draft.type === 'vps') await refreshSshLibrary()
      setDraft(blankDraft); setAddOpen(false); setVerification(null); await loadGraph(); notify('Resource added to the map.')
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save this resource.', 'error') }
    finally { setSaveBusy(false) }
  }
  const handleConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return
    if (isDemo) { setEdges((current) => addEdge({ ...connection, type: 'smoothstep', style: { stroke: '#71869a', strokeWidth: 1.3 } }, current)); return }
    try {
      const edge = await request<Edge>('/edges', { method: 'POST', body: JSON.stringify({ source: connection.source, target: connection.target }) })
      setEdges((current) => addEdge({ ...connection, ...edge, style: { stroke: '#71869a', strokeWidth: 1.3 } }, current))
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not connect those resources.', 'error') }
  }, [isDemo, setEdges])
  const handleEdgesDelete = useCallback((removed: Edge[]) => {
    if (isDemo) return
    for (const edge of removed) void request(`/edges/${edge.id}`, { method: 'DELETE' }).catch(() => loadGraph())
  }, [isDemo, loadGraph])
  const savePosition = useCallback((_event: globalThis.MouseEvent | TouchEvent, node: ResourceNode) => {
    if (isDemo || node.id.startsWith('sample-')) return
    void request(`/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify({ x: node.position.x, y: node.position.y }) }).catch((error) => notify(error instanceof Error ? error.message : 'Could not save this position.', 'error'))
  }, [isDemo])
  const runCheck = async (id: string) => {
    setTestBusy(true); setVerification(null); setMessage(null)
    try {
      const result = await request<SshResult>(`/nodes/${id}/test-ssh`, { method: 'POST' })
      if (result.needsTrust) { setVerification(result); notify('Verify the presented SSH host key before trusting it.', 'error') }
      else if (result.ok) { notify('SSH connection succeeded.'); await loadGraph() }
      else { notify(result.error || 'SSH connection failed.', 'error'); await loadGraph() }
    } catch (error) { notify(error instanceof Error ? error.message : 'SSH connection failed.', 'error') }
    finally { setTestBusy(false) }
  }
  const trustFingerprint = async () => {
    if (!selected || !verification?.fingerprint) return
    setTrustBusy(true)
    try {
      await request(`/nodes/${selected.id}/trust-host-key`, { method: 'POST', body: JSON.stringify({ fingerprint: verification.fingerprint }) })
      setVerification(null); notify('Host key fingerprint saved. Checking SSH again…'); await runCheck(selected.id)
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save this fingerprint.', 'error') }
    finally { setTrustBusy(false) }
  }
  const deleteNode = async () => {
    if (!selected || isDemo) return
    try { await request(`/nodes/${selected.id}`, { method: 'DELETE' }); setDetailsOpen(false); setDeleteConfirm(false); setVerification(null); await loadGraph(); notify('Resource removed from the map.') }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not remove this resource.', 'error') }
  }
  const signOut = async () => {
    try { await request('/session', { method: 'DELETE' }) } catch { /* the next request will require a fresh sign-in */ }
    ++graphRequest.current; boardRef.current = 'default'; setBoardId('default'); setBoards([]); setSshIdentities([]); setSshFiles([]); setSshProfiles([]); setSelectedIdentityId(''); setSshLibraryOpen(false); setDetailsOpen(false); setAddOpen(false); setTerminalNode(null); setBoardDialog(null); setMinimizedWindows([])
    setAuthenticated(false); setNodes(sampleNodes); setEdges(sampleEdges); setIsDemo(true); setSelectedId(sampleNodes[0].id)
  }

  if (!sessionLoaded) return <main className="signin-screen"><div className="signin-loading"><LoaderCircle className="spin" size={23} /><span>Loading workspace…</span></div></main>
  if (!authenticated) return <SignIn onSuccess={handleSignedIn} />

  const boardNavigation = <div className="board-navigation" aria-label="Graph boards">
    <div className="board-tabs" role="group" aria-label="Choose graph board">{boards.map((board) => <button key={board.id} className={board.id === boardId ? 'board-tab selected' : 'board-tab'} aria-pressed={board.id === boardId} disabled={boardLoading || saveBusy || testBusy || trustBusy || boardBusy} onClick={() => void switchBoard(board.id)} title={board.name}><Layers3 size={15} /><span>{board.name}</span><small>{board.resourceCount}</small></button>)}</div>
    <div className="board-actions"><button className="board-add" onClick={() => openBoardDialog('add')} disabled={boardLoading || saveBusy || boardBusy}><Plus size={16} /><span>Add graph</span></button><button className="board-edit" aria-label="Rename current graph" title="Rename graph" onClick={() => openBoardDialog('rename')} disabled={boardLoading || !activeBoard}><Pencil size={15} /></button></div>
  </div>
  const openWindows = [
    ...(addOpen ? [{ id: 'add', title: 'Add connection', minimized: minimizedWindows.includes('add') }] : []),
    ...(detailsOpen && selected ? [{ id: 'details', title: selected.data.name, minimized: minimizedWindows.includes('details') }] : []),
    ...(terminalNode ? [{ id: 'terminal', title: 'Terminal · ' + terminalNode.data.name, minimized: minimizedWindows.includes('terminal') }] : []),
    ...(boardDialog ? [{ id: 'board', title: 'Graph board', minimized: minimizedWindows.includes('board') }] : []),
    ...(sshLibraryOpen ? [{ id: 'ssh-library', title: 'SSH File Library', minimized: minimizedWindows.includes('ssh-library') }] : []),
  ]
  return <ReactFlowProvider><div className={desktop ? 'app-frame desktop-mode' : 'app-frame'}>
    <aside className="rail"><div className="brand-mark"><Waypoints size={20} strokeWidth={1.8} /></div><div className="rail-divider" /><button className="rail-action active" aria-label="System map" onClick={() => changeView('map')}><Waypoints size={18} /></button><button className="rail-action" aria-label="Inventory" onClick={openAdd}><Layers3 size={18} /></button><button className="rail-action" aria-label="Activity" onClick={() => openDetails()}><Activity size={18} /></button><div className="rail-spacer" /><button className="rail-action" aria-label="Sign out" onClick={() => void signOut()}><LogOut size={17} /></button><div className="rail-avatar">O</div></aside>
    <main className="main-column">
      <header className="topbar"><div className="crumb"><span>ORBIT</span><span className="crumb-slash">/</span><strong>OPERATIONS</strong></div><div className="topbar-right"><div className="view-switch" role="group" aria-label="Workspace view"><button aria-pressed={!desktop} onClick={() => changeView('map')}><Waypoints size={16} /><span>Map</span></button><button aria-pressed={desktop} onClick={() => changeView('desktop')}><Monitor size={16} /><span>Desktop</span></button></div><button className="ssh-library-button" aria-label="Open SSH file library" title="SSH files" onClick={() => void openSshLibrary()}><FolderOpen size={15} /><span>SSH Files</span></button><span className="secure-label"><ShieldCheck size={14} /> SELF-HOSTED</span><span className="topbar-separator" /><button className="help-button" onClick={() => openDetails()}><Command size={14} /> RESOURCE DETAILS</button><button className="topbar-logout" aria-label="Sign out of Orbit" onClick={() => void signOut()}><LogOut size={17} /></button></div></header>
      {desktop ? <><div className="desktop-board-bar">{boardNavigation}</div><Desktop name={activeBoard?.name || 'Network graph'} nodes={nodes} demo={isDemo} onOpen={openDetails} onAdd={openAdd} onMap={() => changeView('map')} onAddBoard={() => openBoardDialog('add')} windows={openWindows} onRestore={restoreWindow} /></> : <section className="workspace">
        <div className="workspace-heading"><div><div className="eyebrow"><span className="eyebrow-line" />INFRASTRUCTURE / TOPOLOGY</div><h1>System map</h1><p className="subtitle">See how your hosts, services, and tunnels fit together.</p></div><button className="primary-button" onClick={openAdd}><Plus size={17} /> Add connection</button></div>
        <div className="metric-strip"><div className="metric"><span className="metric-icon cyan"><Server size={16} /></span><span><small>HOSTS</small><strong>{String(hostCount).padStart(2, '0')} <em>{isDemo ? 'EXAMPLE' : 'SAVED'}</em></strong></span></div><div className="metric-divider" /><div className="metric"><span className="metric-icon orange"><Cloud size={16} /></span><span><small>TUNNELS</small><strong>{String(tunnelCount).padStart(2, '0')} <em>{isDemo ? 'EXAMPLE' : 'TRACKED'}</em></strong></span></div><div className="metric-divider" /><div className="metric"><span className="metric-icon violet"><Box size={16} /></span><span><small>SERVICES</small><strong>{String(serviceCount).padStart(2, '0')} <em>{isDemo ? 'EXAMPLE' : 'TRACKED'}</em></strong></span></div><div className={`metric-note ${isDemo ? '' : 'note-saved'}`}><i /> {isDemo ? 'DEMO TOPOLOGY · NOT CONNECTED' : 'SAVED MAP · CONNECTIONS ARE MANUAL'}</div></div>
        {boardNavigation}
        <section className="map-panel" aria-label="Infrastructure topology graph"><div className="map-toolbar"><div className="map-label"><span className="map-label-icon"><Cable size={15} /></span><strong title={activeBoard?.name}>{activeBoard?.name || 'Network graph'}</strong><span className="map-divider">/</span><span className="map-count">{String(nodes.length).padStart(2, '0')} RESOURCES</span></div><div className="map-tools"><span className="layout-label">DRAG NODES TO ARRANGE</span><button className="toolbar-button" onClick={openAdd}><Plus size={14} /><span>NEW NODE</span></button></div></div>
          <div className="flow-wrap"><ReactFlow key={boardId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => void handleConnect(connection)} onEdgesDelete={handleEdgesDelete} onNodeClick={(_: MouseEvent, node: ResourceNode) => { setSelectedId(node.id); setVerification(null) }} onNodeDoubleClick={(_: MouseEvent, node: ResourceNode) => openDetails(node.id)} onNodeDragStop={savePosition} onMove={(_, nextViewport) => setViewport(nextViewport)} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }} minZoom={0.15} maxZoom={1.55} nodesConnectable edgesReconnectable={false} deleteKeyCode={isDemo ? null : ['Backspace', 'Delete']} proOptions={{ hideAttribution: false }}><Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#283442" /><Controls showInteractive={false} position="bottom-left" /><MiniMap pannable zoomable nodeColor={(node) => `var(--${(node.data as ResourceData).tint})`} maskColor="rgba(11, 16, 23, .76)" position="bottom-right" /></ReactFlow><div className="map-coordinates"><span>TOPOLOGY CANVAS</span><span>X {Math.round(viewport.x)} · Y {Math.round(viewport.y)} · {Math.round(viewport.zoom * 100)}%</span></div>{isDemo && <div className="sample-stamp">SAMPLE<br />GRAPH</div>}{nodes.length === 0 && <div className="empty-graph"><span className="empty-graph-icon"><Waypoints size={22} /></span><strong>Your map is clear.</strong><span>Add a VPS, service, or tunnel to start building it.</span><button className="primary-button" onClick={openAdd}><Plus size={15} /> Add first resource</button></div>}</div>
          <footer className="map-footer"><span><i className="legend-dot cyan-dot" />VPS HOST</span><span><i className="legend-dot orange-dot" />TUNNEL</span><span><i className="legend-dot violet-dot" />SERVICE</span><span className="footer-hint">CONNECT NODES BY DRAGGING BETWEEN PORTS <span>·</span> SCROLL TO ZOOM</span></footer></section>
        <div className="bottom-row"><section className="selection-card"><div className={`selection-glyph tint-${selected?.data.tint || 'cyan'}`}>{selected?.data.icon === 'cloud' ? <Cloud size={18} /> : selected?.data.icon === 'database' ? <Database size={18} /> : selected?.data.icon === 'globe' ? <Globe2 size={18} /> : <Server size={18} />}</div><div className="selection-copy"><small>SELECTED RESOURCE <span>·</span> {selected?.data.kind || 'NONE SELECTED'}</small><strong>{selected?.data.name || 'Select a node on the map'}</strong><span>{selected?.data.meta || 'Add a host or service to begin.'}</span></div>{selected && <span className={`selection-status ${selected.data.status === 'CHECK OK' ? 'selection-good' : ''}`}><i /> {selected.data.status}</span>}<button className="icon-button" aria-label="Open resource details" disabled={!selected} onClick={() => openDetails()}><ArrowUpRight size={17} /></button></section><section className="connection-card"><div><span className="connection-icon"><Activity size={16} /></span><span className="connection-copy"><small>SSH CONNECTION CHECKS</small><strong>{nodes.filter((node) => node.data.resourceType === 'vps' && node.data.connectionStatus === 'connected').length} successful · manual checks only</strong></span></div><ArrowDownRight className="muted-arrow" size={17} /></section></div>
        <div className="workspace-footnote"><span>ORBIT OPS <b>0.1.0</b></span><span>{isDemo ? 'EXAMPLE MAP ONLY · YOUR INVENTORY STARTS WHEN YOU ADD A RESOURCE.' : 'SERVICE AND TUNNEL NODES ARE INVENTORY ONLY; NO CONTINUOUS PROBES RUN.'}</span><span>ENCRYPTED SSH <i /> SELF-HOSTED</span></div>
      </section>}
      {boardLoading && <div className="board-loading" role="status"><LoaderCircle className="spin" size={18} />Loading graph…</div>}
    </main>

    {addOpen && <WindowFrame desktop={desktop} title="Add connection" onClose={() => { if (!saveBusy) setAddOpen(false) }} focusToken={windowFocus.add || 0} minimized={minimizedWindows.includes('add')} onMinimize={() => minimizeWindow('add')}><form className="resource-modal" onSubmit={(event) => void addNode(event)}><header className="modal-heading"><div><span className="modal-kicker">MAP INVENTORY</span><h2>Add a resource</h2><p>Add to {activeBoard?.name || 'this graph'}.</p></div><button type="button" className="modal-close" onClick={() => setAddOpen(false)} aria-label="Close"><X size={17} /></button></header>
      <div className="type-switch" role="group" aria-label="Resource type"><button type="button" className={draft.type === 'vps' ? 'selected' : ''} onClick={() => { setIdentityHint(''); setDraft({ ...blankDraft, type: 'vps' }) }}><Server size={15} /> VPS / SSH</button><button type="button" className={draft.type !== 'vps' ? 'selected' : ''} onClick={() => setDraft({ ...draft, type: draft.type === 'vps' ? 'service' : draft.type })}><Layers3 size={15} /> SERVICE</button></div>
      {draft.type === 'vps' && <SshConfigImport savedProfiles={sshProfiles} onSave={saveSshConfig} onDelete={deleteSshConfig} onSelect={(profile) => { setDraft((current) => ({ ...current, name: profile.alias, host: profile.host, port: profile.port, username: profile.username, privateKey: '', passphrase: '' })); setSelectedIdentityId(''); setRememberSshKey(false); setIdentityHint(profile.identityFiles.join(' or ')); notify('Host settings imported. Choose or save its private key below.'); }} />}
      <label className="field-label" htmlFor="resource-name">Name<input id="resource-name" className="text-input" placeholder={draft.type === 'vps' ? 'e.g. Singapore edge' : 'e.g. PostgreSQL or Cloudflare ingress'} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={180} required autoFocus /></label>
      {draft.type === 'vps' ? <><div className="field-row"><label className="field-label" htmlFor="ssh-host">Host / IP<input id="ssh-host" className="text-input" placeholder="203.0.113.10" value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} autoComplete="off" required /></label><label className="field-label port-field" htmlFor="ssh-port">Port<input id="ssh-port" className="text-input" inputMode="numeric" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} required /></label></div><div className="field-row"><label className="field-label" htmlFor="ssh-user">SSH username<input id="ssh-user" className="text-input" placeholder="root" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} autoComplete="off" required /></label><label className="field-label" htmlFor="ssh-location">Location <span className="optional-label">OPTIONAL</span><input id="ssh-location" className="text-input" placeholder="Singapore" value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label></div>{import.meta.env.DEV && <div className="dev-warning">Local development mode uses a fixed encryption key. Do not save real SSH keys here.</div>}{sshIdentities.length > 0 && <div className="saved-identity-picker"><label className="field-label" htmlFor="saved-ssh-key">Saved private key<select id="saved-ssh-key" className="text-input" value={selectedIdentityId} onChange={(event) => { setSelectedIdentityId(event.target.value); setDraft((current) => ({ ...current, privateKey: '', passphrase: '' })); setRememberSshKey(false) }}><option value="">Upload or paste another key…</option>{sshIdentities.filter((identity) => identity.id).map((identity) => <option key={identity.id} value={identity.id}>{identity.name} · {identity.keyFingerprint}</option>)}</select></label>{selectedIdentityId && <button type="button" className="danger-quiet" disabled={sshLibraryBusy} onClick={() => void deleteSshIdentity(selectedIdentityId)}>Delete selected saved key</button>}</div>}{selectedIdentityId ? <div className="security-note"><KeyRound size={15} /><span>Saved key selected. Its encrypted key stays on the server and is reused for this VPS.</span></div> : <><SshKeyField key={identityHint + draft.host} hint={identityHint} value={draft.privateKey} onChange={(privateKey, fileName = '') => { setDraft((current) => ({ ...current, privateKey })); setSshKeyUploadFileName(fileName) }} /><label className="field-label" htmlFor="ssh-passphrase">Key passphrase <span className="optional-label">IF ENCRYPTED</span><input id="ssh-passphrase" className="text-input" type="password" autoComplete="new-password" value={draft.passphrase} onChange={(event) => setDraft((current) => ({ ...current, passphrase: event.target.value }))} /></label>{draft.privateKey.trim() && <div className="store-key-now"><label className="field-label" htmlFor="ssh-key-library-name">Save key in library as<input id="ssh-key-library-name" className="text-input" value={rememberSshKeyName} onChange={(event) => setRememberSshKeyName(event.target.value)} maxLength={80} placeholder="e.g. Main Ed25519" /></label><button type="button" className="secondary-button" disabled={sshLibraryBusy || !rememberSshKeyName.trim()} onClick={() => void saveSshIdentity()}>{sshLibraryBusy ? 'Saving key…' : 'Save key for reuse'}</button></div>}<label className="remember-ssh-key"><input type="checkbox" checked={rememberSshKey} onChange={(event) => setRememberSshKey(event.target.checked)} />Save this key to the library when adding this VPS</label>{rememberSshKey && <label className="field-label" htmlFor="remember-key-name">Saved key name<input id="remember-key-name" className="text-input" value={rememberSshKeyName} onChange={(event) => setRememberSshKeyName(event.target.value)} maxLength={80} placeholder="e.g. Main Ed25519" required /></label>}<div className="security-note"><ShieldCheck size={15} /><span>The private key and passphrase are encrypted before storage. Private keys are never returned by the server.</span></div></>}</> : <><div className="field-row"><label className="field-label" htmlFor="resource-provider">Provider<input id="resource-provider" className="text-input" placeholder="Cloudflare, Docker, AWS…" value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} /></label><label className="field-label" htmlFor="resource-endpoint">Endpoint<input id="resource-endpoint" className="text-input" placeholder="https://… or localhost:port" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label></div>{vpsNodes.length > 0 && <label className="field-label" htmlFor="resource-parent">Connected to <span className="optional-label">OPTIONAL</span><select id="resource-parent" className="text-input" value={draft.parentId} onChange={(event) => setDraft({ ...draft, parentId: event.target.value })}><option value="">No host link yet</option>{vpsNodes.map((node) => <option key={node.id} value={node.id}>{node.data.name}</option>)}</select></label>}<label className="field-label" htmlFor="resource-notes">Notes <span className="optional-label">OPTIONAL</span><textarea id="resource-notes" className="text-input notes-input" placeholder="Where it runs, which service it routes to, or other context." value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div className="security-note"><Cloud size={15} /><span>Tunnels and services are saved as topology records. This does not query their provider APIs or monitor health.</span></div></>}
      <footer className="form-footer"><span>ADDED TO YOUR LOCAL MAP</span><button type="button" className="secondary-button" onClick={() => setAddOpen(false)} disabled={saveBusy}>Cancel</button><button type="submit" className="primary-button" disabled={saveBusy}>{saveBusy ? <LoaderCircle size={16} className="spin" /> : <Plus size={15} />} Add resource</button></footer>
    </form></WindowFrame>}

    {detailsOpen && selected && <WindowFrame desktop={desktop} title={selected.data.name} onClose={() => { setDetailsOpen(false); setDeleteConfirm(false) }} focusToken={windowFocus.details || 0} minimized={minimizedWindows.includes('details')} onMinimize={() => minimizeWindow('details')}><section className="details-modal"><header className="modal-heading"><div><span className="modal-kicker">{selected.data.kind}</span><h2>{selected.data.name}</h2><p>{selected.data.meta}</p></div><button className="modal-close" onClick={() => { setDetailsOpen(false); setDeleteConfirm(false) }} aria-label="Close"><X size={17} /></button></header>
      <div className="detail-grid"><span>TYPE</span><strong>{selected.data.resourceType.toUpperCase()}</strong>{selected.data.provider && <><span>PROVIDER</span><strong>{selected.data.provider}</strong></>}{selected.data.endpoint && <><span>ENDPOINT</span><strong className="detail-value">{selected.data.endpoint}</strong></>}{selected.data.resourceType === 'vps' && <><span>SSH TARGET</span><strong>{selected.data.username}@{selected.data.host}:{selected.data.port}</strong><span>KEY STORAGE</span><strong>{selected.data.hasPrivateKey ? 'Encrypted on this server' : 'No key saved'}</strong>{selected.data.hostFingerprint && <><span>HOST KEY</span><strong className="detail-value">{selected.data.hostFingerprint}</strong></>}{selected.data.lastCheckedAt && <><span>LAST CHECK</span><strong>{new Date(selected.data.lastCheckedAt).toLocaleString()}</strong></>}</>}{selected.data.notes && <><span>NOTES</span><strong className="detail-value">{selected.data.notes}</strong></>}</div>
      {selected.data.publicKey && <div className="public-key-panel"><strong>Login public key</strong><p>Install this public key in ~/.ssh/authorized_keys for {selected.data.username}. Your private key stays encrypted on the Orbit server.</p><textarea className="text-input" aria-label="Login public key" readOnly value={selected.data.publicKey} onFocus={(event) => event.currentTarget.select()} /><small>{selected.data.keyFingerprint}</small><button className="secondary-button" onClick={() => { if (!navigator.clipboard) { notify('Select the public key above and copy it.', 'error'); return }; void navigator.clipboard.writeText(selected.data.publicKey || '').then(() => notify('Public key copied.')).catch(() => notify('Select the public key above and copy it.', 'error')) }}>Copy public key</button></div>}
      {selected.data.resourceType === 'vps' && <div className="ssh-action-block"><div className="ssh-action-buttons"><button className="secondary-button check-button" onClick={() => void runCheck(selected.id)} disabled={testBusy || isDemo}><Activity size={15} />{testBusy ? 'Checking SSH…' : 'Check SSH connection'}</button><button className="secondary-button terminal-button" onClick={() => { setTerminalNode(selected); restoreWindow('terminal'); setDetailsOpen(false) }} disabled={isDemo || !selected.data.hasPrivateKey || !selected.data.hostFingerprint}><Command size={15} />Open SSH terminal</button></div>{(!selected.data.hostFingerprint || !selected.data.hasPrivateKey) && <small>{isDemo ? 'Add a VPS before connecting.' : 'Check SSH and verify the host fingerprint before opening a terminal.'}</small>}{verification?.fingerprint && <div className="fingerprint-check"><span className="fingerprint-title">{verification.replacesExisting ? 'HOST KEY CHANGED' : 'VERIFY THIS HOST KEY'}</span>{verification.replacesExisting && <p>Saved: <code>{verification.previousFingerprint}</code></p>}<code>{verification.fingerprint}</code><p>Compare the fingerprint with the console or trusted control panel for this VPS. Continue only if it matches.</p><button className="primary-button" onClick={() => void trustFingerprint()} disabled={trustBusy}>{trustBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} I verified this fingerprint</button></div>}</div>}
      {selected.data.resourceType !== 'vps' && endpointUrl(selected.data.endpoint || '') && <div className="endpoint-actions"><button className="secondary-button" disabled={isDemo} onClick={() => { const url = endpointUrl(selected.data.endpoint || ''); if (url) window.open(url, '_blank', 'noopener,noreferrer') }}><ExternalLink size={15} />Open endpoint</button></div>}
      {deleteConfirm ? <div className="delete-confirm"><span>Removing this resource also deletes its encrypted SSH key and map links.</span><div><button className="secondary-button" onClick={() => setDeleteConfirm(false)}>Keep it</button><button className="danger-button" onClick={() => void deleteNode()}><Trash2 size={14} /> Remove resource</button></div></div> : <div className="detail-actions"><span>{selected.data.resourceType === 'tunnel' || selected.data.resourceType === 'service' || selected.data.resourceType === 'external' ? 'Inventory only · no health probe configured' : selected.data.hostFingerprint ? 'Pinned host key · first-use verification complete' : 'Host key verification required on first check'}</span><button className="danger-quiet" disabled={isDemo} onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> Remove</button></div>}
    </section></WindowFrame>}
    {terminalNode && <TerminalWindow key={terminalNode.id} nodeId={terminalNode.id} name={terminalNode.data.name} onClose={closeTerminal} desktop={desktop} focusToken={windowFocus.terminal || 0} minimized={minimizedWindows.includes('terminal')} onMinimize={() => minimizeWindow('terminal')} />}
    {boardDialog && <WindowFrame desktop={desktop} title={boardDialog === 'add' ? 'Add graph board' : 'Rename graph'} onClose={() => { if (!boardBusy) setBoardDialog(null) }} focusToken={windowFocus.board || 0} minimized={minimizedWindows.includes('board')} onMinimize={() => minimizeWindow('board')}><form className="resource-modal board-form" onSubmit={(event) => void saveBoard(event)}><header className="modal-heading"><div><span className="modal-kicker">GRAPH BOARDS</span><h2>{boardDialog === 'add' ? 'A new place for your resources.' : 'Name this graph.'}</h2><p>{boardDialog === 'add' ? 'Keep a separate map for a location, project, or group of services.' : 'This name appears in both Map and Desktop views.'}</p></div><button type="button" className="modal-close" aria-label="Close graph form" onClick={() => setBoardDialog(null)}><X size={17} /></button></header><label className="field-label" htmlFor="board-name">Graph name<input id="board-name" className="text-input" value={boardName} onChange={(event) => setBoardName(event.target.value)} maxLength={80} placeholder="e.g. Home lab, Cloudflare, Production" required autoFocus /></label><footer className="form-footer"><button type="button" className="secondary-button" disabled={boardBusy} onClick={() => setBoardDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={boardBusy || !boardName.trim()}>{boardBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{boardDialog === 'add' ? 'Create graph' : 'Save name'}</button></footer>{boardDialog === 'rename' && boardId !== 'default' && <div className="board-remove"><p>{activeBoard?.resourceCount ? 'Remove this graph’s resources before deleting the graph.' : 'This graph is empty and can be removed.'}</p><button type="button" className="danger-quiet" disabled={boardBusy || !!activeBoard?.resourceCount} onClick={() => void removeBoard()}><Trash2 size={15} />Delete empty graph</button></div>}</form></WindowFrame>}
    {sshLibraryOpen && <SshLibrary desktop={desktop} minimized={minimizedWindows.includes('ssh-library')} focusToken={windowFocus['ssh-library'] || 0} profiles={sshProfiles} identities={sshFiles} onClose={() => setSshLibraryOpen(false)} onMinimize={() => minimizeWindow('ssh-library')} onSaveProfileContext={saveSshProfileContext} onSaveIdentityContext={saveSshIdentityContext} onDeleteProfile={deleteSshConfig} onDeleteIdentity={(identity) => deleteSshIdentity(identity.id)} onDeleteAttachedKey={deleteSshNodeKey} />}
    {message && <div className={`toast ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'error' ? <X size={15} /> : <Check size={15} />}{message.text}<button onClick={() => setMessage(null)} aria-label="Dismiss"><X size={14} /></button></div>}
  </div></ReactFlowProvider>
}
export default App
