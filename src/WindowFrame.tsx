import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react'
import { Maximize2, Minimize2, Minus, X } from 'lucide-react'

let nextLayer = 50
type Props = { desktop: boolean; title: string; children: ReactNode; onClose: () => void; wide?: boolean; minimized?: boolean; onMinimize?: () => void; focusToken?: number }

export default function WindowFrame({ desktop, title, children, onClose, wide = false, minimized = false, onMinimize, focusToken = 0 }: Props) {
  const shell = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const raise = () => { if (shell.current?.parentElement) shell.current.parentElement.style.zIndex = String(++nextLayer) }
  const [maximized, setMaximized] = useState(false)
  const [position, setPosition] = useState({ x: Math.max(12, (window.innerWidth - (wide ? 1000 : 580)) / 2), y: 100 })
  const [size, setSize] = useState({ width: Math.min(wide ? 1000 : 580, window.innerWidth - 24), height: Math.min(wide ? 660 : 650, window.innerHeight - 172) })

  useEffect(() => { raise() }, [focusToken])

  useEffect(() => {
    const constrain = () => {
      const width = Math.min(shell.current?.offsetWidth || (wide ? 1000 : 580), window.innerWidth - 24)
      const height = Math.min(shell.current?.offsetHeight || 650, window.innerHeight - 172)
      setSize({ width: Math.max(280, width), height: Math.max(200, height) })
      setPosition((current) => ({ x: Math.max(12, Math.min(current.x, window.innerWidth - width - 12)), y: Math.max(76, Math.min(current.y, window.innerHeight - height - 84)) }))
    }
    window.addEventListener('resize', constrain)
    return () => window.removeEventListener('resize', constrain)
  }, [wide])

  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    if (maximized || window.innerWidth <= 700 || (event.target as HTMLElement).closest('button')) return
    const rect = shell.current!.getBoundingClientRect()
    drag.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current || !shell.current) return
    setPosition({ x: Math.max(8, Math.min(event.clientX - drag.current.x, window.innerWidth - shell.current.offsetWidth - 8)), y: Math.max(68, Math.min(event.clientY - drag.current.y, window.innerHeight - shell.current.offsetHeight - 76)) })
  }

  return <div className={desktop ? 'window-layer desktop-window-layer' : 'window-layer modal-backdrop'} style={{ display: minimized ? 'none' : undefined }} onMouseDown={(event) => { if (!desktop && event.target === event.currentTarget) onClose() }}>
    <div ref={shell} className={`window-shell ${maximized ? 'window-maximized' : ''}`} style={desktop && !maximized ? { left: position.x, top: position.y, width: size.width, height: size.height } : undefined} role="dialog" aria-label={title} aria-modal={desktop ? undefined : true} onPointerDown={raise}>
      <header className="window-titlebar" hidden={!desktop} tabIndex={desktop ? 0 : -1} aria-label={`Move ${title} window using arrow keys`} onPointerDown={beginDrag} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !event.key.startsWith('Arrow') || maximized) return
        event.preventDefault()
        setPosition((current) => ({ x: Math.max(8, Math.min(current.x + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0), window.innerWidth - (shell.current?.offsetWidth || 300) - 8)), y: Math.max(68, Math.min(current.y + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0), window.innerHeight - (shell.current?.offsetHeight || 300) - 76)) }))
      }}>
        <span className="window-title"><i />{title}</span><div className="window-controls">
          {onMinimize && <button onClick={onMinimize} aria-label={`Minimize ${title}`}><Minus size={15} /></button>}
          <button onClick={() => setMaximized(!maximized)} aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          <button onClick={onClose} aria-label={`Close ${title}`}><X size={16} /></button>
        </div>
      </header>
      <div className="window-body">{children}</div>
    </div>
  </div>
}
