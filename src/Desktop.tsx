import { Cloud, Database, Globe2, Layers3, Plus, Server, Waypoints, AppWindow, TerminalSquare } from 'lucide-react'

type DesktopResource = { id: string; data: { name: string; icon: string; resourceType: string; status: string; tint: string } }
type Props = {
  name: string; nodes: DesktopResource[]; demo: boolean; onOpen: (id: string) => void;
  onAdd: () => void; onMap: () => void; onAddBoard: () => void;
  windows: { id: string; title: string; minimized: boolean }[]; onRestore: (id: string) => void;
}

export default function Desktop({ name, nodes, demo, onOpen, onAdd, onMap, onAddBoard, windows, onRestore }: Props) {
  return <section className="desktop-surface" aria-label="Desktop workspace">
    <div className="desktop-wallpaper" aria-hidden="true" />
    <div className="desktop-heading"><div><span>ORBIT DESKTOP</span><h1>{name}</h1></div><p>{demo ? 'Example resources' : `${nodes.length} saved resources`}<span>Choose an icon to open its controls</span></p></div>
    <div className="desktop-icons">
      <button className="desktop-shortcut" onClick={onMap}><span className="app-icon app-map"><Waypoints size={34} strokeWidth={1.6} /></span><strong>System map</strong><small>Open graph view</small></button>
      <button className="desktop-shortcut" onClick={onAdd}><span className="app-icon app-add"><Plus size={36} strokeWidth={1.6} /></span><strong>Add connection</strong><small>VPS or service</small></button>
      {nodes.map((node) => {
        const Icon = node.data.icon === 'server' ? Server : node.data.icon === 'cloud' ? Cloud : node.data.icon === 'database' ? Database : Globe2
        return <button key={node.id} className="desktop-shortcut" onClick={() => onOpen(node.id)} title={`${node.data.name} · ${node.data.status}`}>
          <span className={`app-icon app-${node.data.tint}`}><Icon size={33} strokeWidth={1.6} /><i className={node.data.status === 'CHECK OK' ? 'app-indicator connected' : 'app-indicator'} /></span>
          <strong>{node.data.name}</strong><small>{node.data.resourceType === 'vps' ? 'SSH host' : node.data.resourceType === 'tunnel' ? 'Tunnel' : 'Service'}</small>
        </button>
      })}
    </div>
    {!nodes.length && <div className="desktop-empty"><Layers3 size={26} /><strong>This desktop is ready.</strong><p>Add your first VPS, service, or tunnel to this graph.</p></div>}
    <nav className="desktop-dock" aria-label="Desktop dock">
      <button onClick={onMap} aria-label="Switch to map view" title="System map"><Waypoints size={23} /></button>
      <button onClick={onAdd} aria-label="Add desktop resource" title="Add connection"><Plus size={24} /></button>
      <button onClick={onAddBoard} aria-label="Add desktop graph board" title="Add graph board"><Layers3 size={23} /></button>
      {windows.length > 0 && <span className="dock-divider" />}
      {windows.map((item) => <button key={item.id} className={`dock-window ${item.minimized ? 'is-minimized' : ''}`} onClick={() => onRestore(item.id)} aria-label={`Show ${item.title}`} title={item.title}>{item.id === 'terminal' ? <TerminalSquare size={22} /> : <AppWindow size={22} />}<i /></button>)}
    </nav>
  </section>
}
