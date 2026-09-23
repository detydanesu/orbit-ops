import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import {
  addEdge, Background, BackgroundVariant, Controls, Handle, MiniMap, Position,
  ReactFlow, ReactFlowProvider, type Connection, type Edge, type Node, type NodeProps,
  useEdgesState, useNodesState,
} from '@xyflow/react'
import {
  Activity, ArrowDownRight, ArrowUpRight, Box, Cable, Check, Cloud, Command, Database,
  Globe2, KeyRound, Layers3, LoaderCircle, LogOut, Plus, Server, ShieldCheck,
  ExternalLink, Trash2, Waypoints, X,
} from 'lucide-react'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './Dashboard.css'
import './Orbit.css'
import './Canvas.css'

type ResourceType = 'vps' | 'service' | 'tunnel' | 'external'
type ResourceData = {
  name: string; kind: string; meta: string; status: string
  tint: 'cyan' | 'violet' | 'orange' | 'blue'
  icon: 'server' | 'cloud' | 'database' | 'globe'
  resourceType: ResourceType; host?: string; port?: number; username?: string
  endpoint?: string; provider?: string; location?: string; notes?: string
  hasPrivateKey?: boolean; hostFingerprint?: string; connectionStatus?: string; lastCheckedAt?: string
}
type ResourceNode = Node<ResourceData>
type GraphResponse = { nodes: ResourceNode[]; edges: Edge[]; demo: boolean }
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

function TerminalWindow({ nodeId, name, onClose }: { nodeId: string; name: string; onClose: () => void }) {
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
    })()
    return () => {
      disposed = true
      cleanup()
    }
  }, [nodeId])

  return <div className="modal-backdrop terminal-backdrop"><section className="terminal-modal" role="dialog" aria-modal="true" aria-label={`SSH terminal for ${name}`}><header className="terminal-heading"><div><span className="modal-kicker">SSH SESSION</span><h2>{name}</h2><p><i className={status === 'Connected' ? 'terminal-live' : ''} />{status}</p></div><button className="modal-close" onClick={onClose} aria-label="Close terminal"><X size={17} /></button></header><div ref={hostRef} className="terminal-screen" /><footer className="terminal-footer"><span>SSH · XTERM-256COLOR</span><span>SESSION ENDS WHEN THIS WINDOW CLOSES</span></footer></section></div>
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
  const [nodes, setNodes, onNodesChange] = useNodesState<ResourceNode>(sampleNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(sampleEdges)
  const [authenticated, setAuthenticated] = useState(false)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [isDemo, setIsDemo] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(sampleNodes[0].id)
  const [addOpen, setAddOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [terminalNode, setTerminalNode] = useState<ResourceNode | null>(null)
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
  const closeTerminal = useCallback(() => setTerminalNode(null), [])
  const vpsNodes = nodes.filter((node) => node.data.resourceType === 'vps' && !node.id.startsWith('sample-'))
  const hostCount = nodes.filter((node) => node.data.resourceType === 'vps').length
  const tunnelCount = nodes.filter((node) => node.data.resourceType === 'tunnel').length
  const serviceCount = nodes.filter((node) => node.data.resourceType === 'service' || node.data.resourceType === 'external').length

  const loadGraph = useCallback(async () => {
    const graph = await request<GraphResponse>('/graph')
    setIsDemo(graph.demo)
    setNodes(graph.nodes.length ? graph.nodes : graph.demo ? sampleNodes : [])
    setEdges(graph.edges.length ? graph.edges : graph.demo ? sampleEdges : [])
    if (graph.nodes.length) setSelectedId((previous) => graph.nodes.some((node) => node.id === previous) ? previous : graph.nodes[0].id)
    else if (!graph.demo) setSelectedId(null)
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
  const openAdd = () => { setDraft(blankDraft); setMessage(null); setAddOpen(true) }
  const addNode = async (event: FormEvent) => {
    event.preventDefault(); setSaveBusy(true); setMessage(null)
    const x = 90 + (realNodes.length % 3) * 278
    const y = 110 + (Math.floor(realNodes.length / 3) % 2) * 205
    const body = { ...draft, port: Number(draft.port || 22), x, y, parentId: draft.parentId || undefined }
    try {
      await request('/nodes', { method: 'POST', body: JSON.stringify(body) })
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
    setAuthenticated(false); setNodes(sampleNodes); setEdges(sampleEdges); setIsDemo(true); setSelectedId(sampleNodes[0].id)
  }

  if (!sessionLoaded) return <main className="signin-screen"><div className="signin-loading"><LoaderCircle className="spin" size={23} /><span>Loading workspace…</span></div></main>
  if (!authenticated) return <SignIn onSuccess={handleSignedIn} />

  return <ReactFlowProvider><div className="app-frame">
    <aside className="rail"><div className="brand-mark"><Waypoints size={20} strokeWidth={1.8} /></div><div className="rail-divider" /><button className="rail-action active" aria-label="System map"><Waypoints size={18} /></button><button className="rail-action" aria-label="Inventory" onClick={openAdd}><Layers3 size={18} /></button><button className="rail-action" aria-label="Activity" onClick={() => selected && setDetailsOpen(true)}><Activity size={18} /></button><div className="rail-spacer" /><button className="rail-action" aria-label="Sign out" onClick={() => void signOut()}><LogOut size={17} /></button><div className="rail-avatar">O</div></aside>
    <main className="main-column">
      <header className="topbar"><div className="crumb"><span>ORBIT</span><span className="crumb-slash">/</span><strong>OPERATIONS</strong></div><div className="topbar-right"><span className="secure-label"><ShieldCheck size={14} /> SELF-HOSTED</span><span className="topbar-separator" /><button className="help-button" onClick={() => selected && setDetailsOpen(true)}><Command size={14} /> RESOURCE DETAILS</button></div></header>
      <section className="workspace">
        <div className="workspace-heading"><div><div className="eyebrow"><span className="eyebrow-line" />INFRASTRUCTURE / TOPOLOGY</div><h1>System map</h1><p className="subtitle">See how your hosts, services, and tunnels fit together.</p></div><button className="primary-button" onClick={openAdd}><Plus size={17} /> Add connection</button></div>
        <div className="metric-strip"><div className="metric"><span className="metric-icon cyan"><Server size={16} /></span><span><small>HOSTS</small><strong>{String(hostCount).padStart(2, '0')} <em>{isDemo ? 'EXAMPLE' : 'SAVED'}</em></strong></span></div><div className="metric-divider" /><div className="metric"><span className="metric-icon orange"><Cloud size={16} /></span><span><small>TUNNELS</small><strong>{String(tunnelCount).padStart(2, '0')} <em>{isDemo ? 'EXAMPLE' : 'TRACKED'}</em></strong></span></div><div className="metric-divider" /><div className="metric"><span className="metric-icon violet"><Box size={16} /></span><span><small>SERVICES</small><strong>{String(serviceCount).padStart(2, '0')} <em>{isDemo ? 'EXAMPLE' : 'TRACKED'}</em></strong></span></div><div className={`metric-note ${isDemo ? '' : 'note-saved'}`}><i /> {isDemo ? 'DEMO TOPOLOGY · NOT CONNECTED' : 'SAVED MAP · CONNECTIONS ARE MANUAL'}</div></div>
        <section className="map-panel" aria-label="Infrastructure topology graph"><div className="map-toolbar"><div className="map-label"><span className="map-label-icon"><Cable size={15} /></span><strong>NETWORK GRAPH</strong><span className="map-divider">/</span><span className="map-count">{String(nodes.length).padStart(2, '0')} RESOURCES</span></div><div className="map-tools"><span className="layout-label">DRAG NODES TO ARRANGE</span><button className="toolbar-button" onClick={openAdd}><Plus size={14} /><span>NEW NODE</span></button></div></div>
          <div className="flow-wrap"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => void handleConnect(connection)} onEdgesDelete={handleEdgesDelete} onNodeClick={(_: MouseEvent, node: ResourceNode) => setSelectedId(node.id)} onNodeDragStop={savePosition} onMove={(_, nextViewport) => setViewport(nextViewport)} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }} minZoom={0.55} maxZoom={1.55} nodesConnectable edgesReconnectable={false} deleteKeyCode={isDemo ? null : ['Backspace', 'Delete']} proOptions={{ hideAttribution: false }}><Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#283442" /><Controls showInteractive={false} position="bottom-left" /><MiniMap pannable zoomable nodeColor={(node) => `var(--${(node.data as ResourceData).tint})`} maskColor="rgba(11, 16, 23, .76)" position="bottom-right" /></ReactFlow><div className="map-coordinates"><span>TOPOLOGY CANVAS</span><span>X {Math.round(viewport.x)} · Y {Math.round(viewport.y)} · {Math.round(viewport.zoom * 100)}%</span></div>{isDemo && <div className="sample-stamp">SAMPLE<br />GRAPH</div>}{nodes.length === 0 && <div className="empty-graph"><span className="empty-graph-icon"><Waypoints size={22} /></span><strong>Your map is clear.</strong><span>Add a VPS, service, or tunnel to start building it.</span><button className="primary-button" onClick={openAdd}><Plus size={15} /> Add first resource</button></div>}</div>
          <footer className="map-footer"><span><i className="legend-dot cyan-dot" />VPS HOST</span><span><i className="legend-dot orange-dot" />TUNNEL</span><span><i className="legend-dot violet-dot" />SERVICE</span><span className="footer-hint">CONNECT NODES BY DRAGGING BETWEEN PORTS <span>·</span> SCROLL TO ZOOM</span></footer></section>
        <div className="bottom-row"><section className="selection-card"><div className={`selection-glyph tint-${selected?.data.tint || 'cyan'}`}>{selected?.data.icon === 'cloud' ? <Cloud size={18} /> : selected?.data.icon === 'database' ? <Database size={18} /> : selected?.data.icon === 'globe' ? <Globe2 size={18} /> : <Server size={18} />}</div><div className="selection-copy"><small>SELECTED RESOURCE <span>·</span> {selected?.data.kind || 'NONE SELECTED'}</small><strong>{selected?.data.name || 'Select a node on the map'}</strong><span>{selected?.data.meta || 'Add a host or service to begin.'}</span></div>{selected && <span className={`selection-status ${selected.data.status === 'CHECK OK' ? 'selection-good' : ''}`}><i /> {selected.data.status}</span>}<button className="icon-button" aria-label="Open resource details" disabled={!selected} onClick={() => setDetailsOpen(true)}><ArrowUpRight size={17} /></button></section><section className="connection-card"><div><span className="connection-icon"><Activity size={16} /></span><span className="connection-copy"><small>SSH CONNECTION CHECKS</small><strong>{nodes.filter((node) => node.data.resourceType === 'vps' && node.data.connectionStatus === 'connected').length} successful · manual checks only</strong></span></div><ArrowDownRight className="muted-arrow" size={17} /></section></div>
        <div className="workspace-footnote"><span>ORBIT OPS <b>0.1.0</b></span><span>{isDemo ? 'EXAMPLE MAP ONLY · YOUR INVENTORY STARTS WHEN YOU ADD A RESOURCE.' : 'SERVICE AND TUNNEL NODES ARE INVENTORY ONLY; NO CONTINUOUS PROBES RUN.'}</span><span>ENCRYPTED SSH <i /> SELF-HOSTED</span></div>
      </section>
    </main>

    {addOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saveBusy) setAddOpen(false) }}><form className="resource-modal" onSubmit={(event) => void addNode(event)}><header className="modal-heading"><div><span className="modal-kicker">MAP INVENTORY</span><h2>Add a resource</h2><p>Register an SSH host or track a service that lives anywhere.</p></div><button type="button" className="modal-close" onClick={() => setAddOpen(false)} aria-label="Close"><X size={17} /></button></header>
      <div className="type-switch" role="group" aria-label="Resource type"><button type="button" className={draft.type === 'vps' ? 'selected' : ''} onClick={() => setDraft({ ...blankDraft, type: 'vps' })}><Server size={15} /> VPS / SSH</button><button type="button" className={draft.type !== 'vps' ? 'selected' : ''} onClick={() => setDraft({ ...draft, type: draft.type === 'vps' ? 'service' : draft.type })}><Layers3 size={15} /> SERVICE / TUNNEL</button></div>
      {draft.type !== 'vps' && <label className="field-label" htmlFor="resource-type">Resource type<select id="resource-type" className="text-input" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ResourceType, provider: event.target.value === 'tunnel' ? 'Cloudflare' : '' })}><option value="service">Service</option><option value="tunnel">Cloudflare Tunnel</option><option value="external">External service</option></select></label>}
      <label className="field-label" htmlFor="resource-name">Name<input id="resource-name" className="text-input" placeholder={draft.type === 'vps' ? 'e.g. Singapore edge' : draft.type === 'tunnel' ? 'e.g. Public ingress' : 'e.g. PostgreSQL'} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={180} required autoFocus /></label>
      {draft.type === 'vps' ? <><div className="field-row"><label className="field-label" htmlFor="ssh-host">Host / IP<input id="ssh-host" className="text-input" placeholder="203.0.113.10" value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} autoComplete="off" required /></label><label className="field-label port-field" htmlFor="ssh-port">Port<input id="ssh-port" className="text-input" inputMode="numeric" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} required /></label></div><div className="field-row"><label className="field-label" htmlFor="ssh-user">SSH username<input id="ssh-user" className="text-input" placeholder="root" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} autoComplete="off" required /></label><label className="field-label" htmlFor="ssh-location">Location <span className="optional-label">OPTIONAL</span><input id="ssh-location" className="text-input" placeholder="Singapore" value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label></div>{import.meta.env.DEV && <div className="dev-warning">Local development mode uses a fixed encryption key. Do not save real SSH keys here.</div>}<label className="field-label" htmlFor="ssh-key">Private key<textarea id="ssh-key" className="text-input key-input" placeholder="Paste the OpenSSH private key for this host" value={draft.privateKey} onChange={(event) => setDraft({ ...draft, privateKey: event.target.value })} spellCheck={false} autoComplete="off" required /></label><label className="field-label" htmlFor="ssh-passphrase">Key passphrase <span className="optional-label">OPTIONAL</span><input id="ssh-passphrase" className="text-input" type="password" autoComplete="new-password" value={draft.passphrase} onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })} /></label><div className="security-note"><ShieldCheck size={15} /><span>The private key and passphrase are encrypted before they are stored on this server. They are never sent to the browser again.</span></div></> : <><div className="field-row"><label className="field-label" htmlFor="resource-provider">Provider<input id="resource-provider" className="text-input" placeholder={draft.type === 'tunnel' ? 'Cloudflare' : 'Docker, AWS…'} value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} /></label><label className="field-label" htmlFor="resource-endpoint">Endpoint<input id="resource-endpoint" className="text-input" placeholder="https://… or localhost:port" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} /></label></div>{vpsNodes.length > 0 && <label className="field-label" htmlFor="resource-parent">Connected to <span className="optional-label">OPTIONAL</span><select id="resource-parent" className="text-input" value={draft.parentId} onChange={(event) => setDraft({ ...draft, parentId: event.target.value })}><option value="">No host link yet</option>{vpsNodes.map((node) => <option key={node.id} value={node.id}>{node.data.name}</option>)}</select></label>}<label className="field-label" htmlFor="resource-notes">Notes <span className="optional-label">OPTIONAL</span><textarea id="resource-notes" className="text-input notes-input" placeholder="Where it runs, which service it routes to, or other context." value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div className="security-note"><Cloud size={15} /><span>Tunnels and services are saved as topology records. This does not query their provider APIs or monitor health.</span></div></>}
      <footer className="form-footer"><span>ADDED TO YOUR LOCAL MAP</span><button type="button" className="secondary-button" onClick={() => setAddOpen(false)} disabled={saveBusy}>Cancel</button><button type="submit" className="primary-button" disabled={saveBusy}>{saveBusy ? <LoaderCircle size={16} className="spin" /> : <Plus size={15} />} Add resource</button></footer>
    </form></div>}

    {detailsOpen && selected && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setDetailsOpen(false); setDeleteConfirm(false) } }}><section className="details-modal"><header className="modal-heading"><div><span className="modal-kicker">{selected.data.kind}</span><h2>{selected.data.name}</h2><p>{selected.data.meta}</p></div><button className="modal-close" onClick={() => { setDetailsOpen(false); setDeleteConfirm(false) }} aria-label="Close"><X size={17} /></button></header>
      <div className="detail-grid"><span>TYPE</span><strong>{selected.data.resourceType.toUpperCase()}</strong>{selected.data.provider && <><span>PROVIDER</span><strong>{selected.data.provider}</strong></>}{selected.data.endpoint && <><span>ENDPOINT</span><strong className="detail-value">{selected.data.endpoint}</strong></>}{selected.data.resourceType === 'vps' && <><span>SSH TARGET</span><strong>{selected.data.username}@{selected.data.host}:{selected.data.port}</strong><span>KEY STORAGE</span><strong>{selected.data.hasPrivateKey ? 'Encrypted on this server' : 'No key saved'}</strong>{selected.data.hostFingerprint && <><span>HOST KEY</span><strong className="detail-value">{selected.data.hostFingerprint}</strong></>}{selected.data.lastCheckedAt && <><span>LAST CHECK</span><strong>{new Date(selected.data.lastCheckedAt).toLocaleString()}</strong></>}</>}{selected.data.notes && <><span>NOTES</span><strong className="detail-value">{selected.data.notes}</strong></>}</div>
      {selected.data.resourceType === 'vps' && <div className="ssh-action-block"><div className="ssh-action-buttons"><button className="secondary-button check-button" onClick={() => void runCheck(selected.id)} disabled={testBusy || isDemo}><Activity size={15} />{testBusy ? 'Checking SSH…' : 'Check SSH connection'}</button><button className="secondary-button terminal-button" onClick={() => { setTerminalNode(selected); setDetailsOpen(false) }} disabled={isDemo || !selected.data.hasPrivateKey || !selected.data.hostFingerprint}><Command size={15} />Open SSH terminal</button></div>{(!selected.data.hostFingerprint || !selected.data.hasPrivateKey) && <small>{isDemo ? 'Add a VPS before connecting.' : 'Check SSH and verify the host fingerprint before opening a terminal.'}</small>}{verification?.fingerprint && <div className="fingerprint-check"><span className="fingerprint-title">{verification.replacesExisting ? 'HOST KEY CHANGED' : 'VERIFY THIS HOST KEY'}</span>{verification.replacesExisting && <p>Saved: <code>{verification.previousFingerprint}</code></p>}<code>{verification.fingerprint}</code><p>Compare the fingerprint with the console or trusted control panel for this VPS. Continue only if it matches.</p><button className="primary-button" onClick={() => void trustFingerprint()} disabled={trustBusy}>{trustBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} I verified this fingerprint</button></div>}</div>}
      {selected.data.resourceType !== 'vps' && endpointUrl(selected.data.endpoint || '') && <div className="endpoint-actions"><button className="secondary-button" disabled={isDemo} onClick={() => { const url = endpointUrl(selected.data.endpoint || ''); if (url) window.open(url, '_blank', 'noopener,noreferrer') }}><ExternalLink size={15} />Open endpoint</button></div>}
      {deleteConfirm ? <div className="delete-confirm"><span>Removing this resource also deletes its encrypted SSH key and map links.</span><div><button className="secondary-button" onClick={() => setDeleteConfirm(false)}>Keep it</button><button className="danger-button" onClick={() => void deleteNode()}><Trash2 size={14} /> Remove resource</button></div></div> : <div className="detail-actions"><span>{selected.data.resourceType === 'tunnel' || selected.data.resourceType === 'service' || selected.data.resourceType === 'external' ? 'Inventory only · no health probe configured' : selected.data.hostFingerprint ? 'Pinned host key · first-use verification complete' : 'Host key verification required on first check'}</span><button className="danger-quiet" disabled={isDemo} onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> Remove</button></div>}
    </section></div>}
    {terminalNode && <TerminalWindow key={terminalNode.id} nodeId={terminalNode.id} name={terminalNode.data.name} onClose={closeTerminal} />}
    {message && <div className={`toast ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.kind === 'error' ? <X size={15} /> : <Check size={15} />}{message.text}<button onClick={() => setMessage(null)} aria-label="Dismiss"><X size={14} /></button></div>}
  </div></ReactFlowProvider>
}
export default App
