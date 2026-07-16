import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronUp, GripHorizontal, Plus, Square, Terminal, X } from 'lucide-react';
import type { ServerEvent } from '../../types';

type BackgroundActivity = Extract<ServerEvent, { type: 'ssh.execution' }>['payload'];
type TerminalPayload = Extract<ServerEvent, { type: 'ssh.terminal' }>['payload'];
type AgentTerminal = Pick<TerminalPayload, 'terminalId' | 'serverId' | 'serverName'> & { text: string; status: 'open' | 'closed' | 'error'; error?: string };

const statusText: Record<BackgroundActivity['status'], string> = { connecting: '连接中', running: '运行中', completed: '已完成', failed: '失败', interrupted: '已中断', timed_out: '已超时' };
const MIN_DOCK_HEIGHT = 150;
const DEFAULT_DOCK_HEIGHT = 300;

export function SshActivitySection({ sessionId }: { sessionId: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [dockHeight, setDockHeight] = useState(DEFAULT_DOCK_HEIGHT);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<Record<string, AgentTerminal>>({});
  const [backgroundActivities, setBackgroundActivities] = useState<Record<string, BackgroundActivity>>({});

  useEffect(() => window.electronAPI.on((event) => {
    if (event.type === 'ssh.execution' && event.payload.sessionId === sessionId) {
      setBackgroundActivities((current) => ({ ...current, [event.payload.executionId]: { ...current[event.payload.executionId], ...event.payload } }));
      return;
    }
    if (event.type !== 'ssh.terminal' || event.payload.kind !== 'agent' || event.payload.sessionId !== sessionId) return;
    const payload = event.payload;
    if (payload.type === 'closed') {
      setTerminals((current) => {
        const next = { ...current };
        delete next[payload.terminalId];
        return next;
      });
      setActiveTerminalId((current) => current === payload.terminalId ? null : current);
      return;
    }
    setTerminals((current) => {
      const previous = current[payload.terminalId];
      return {
        ...current,
        [payload.terminalId]: {
          terminalId: payload.terminalId,
          serverId: payload.serverId,
          serverName: payload.serverName ?? previous?.serverName ?? payload.serverId,
          text: `${previous?.text ?? ''}${payload.type === 'data' ? payload.text ?? '' : payload.type === 'error' ? `\r\n[终端错误] ${payload.error ?? '未知错误'}\r\n` : ''}`,
          status: payload.type === 'closed' ? 'closed' : payload.type === 'error' ? 'error' : 'open',
          error: payload.error ?? previous?.error,
        },
      };
    });
    setActiveTerminalId(payload.terminalId);
    if (payload.type === 'opened') setCollapsed(false);
  }), [sessionId]);

  const terminalItems = useMemo(() => Object.values(terminals), [terminals]);
  const activeTerminal = (activeTerminalId ? terminals[activeTerminalId] : undefined) ?? terminalItems.at(-1);
  const backgroundItems = Object.values(backgroundActivities).sort((a, b) => b.startedAt - a.startedAt);
  const runningBackgroundCount = backgroundItems.filter((activity) => ['connecting', 'running'].includes(activity.status)).length;
  const openTerminal = () => {
    if (!activeTerminal) return;
    void window.electronAPI.ssh.openAgentTerminal(sessionId, activeTerminal.serverId).catch(() => undefined);
  };
  const closeTerminal = (terminalId: string) => {
    void window.electronAPI.ssh.closeAgentTerminal(sessionId, terminalId).catch(() => undefined);
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = dockHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    const handleMove = (moveEvent: PointerEvent) => {
      const maxHeight = Math.max(MIN_DOCK_HEIGHT, Math.floor(window.innerHeight * 0.7));
      setDockHeight(Math.min(maxHeight, Math.max(MIN_DOCK_HEIGHT, startHeight + startY - moveEvent.clientY)));
    };
    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp, { once: true });
    document.addEventListener('pointercancel', handleUp, { once: true });
  };

  if (terminalItems.length === 0) return null;

  return <section className="relative mx-4 mt-2 mb-4 flex shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0b0f14] shadow-[0_8px_24px_rgba(0,0,0,0.22)]" style={{ height: collapsed ? 38 : dockHeight }} aria-label="Agent SSH 终端">
    {!collapsed && <div onPointerDown={beginResize} className="group flex h-2 shrink-0 touch-none cursor-ns-resize items-center justify-center bg-[#111820] transition-colors hover:bg-accent/25" title="按住并上下拖动调整终端高度"><GripHorizontal className="h-3.5 w-5 text-gray-600 transition-colors group-hover:text-accent" /></div>}
    <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-white/10 bg-[#111820] px-2 text-gray-300">
      <Terminal className="h-4 w-4 shrink-0 text-emerald-400" />
      <span className="shrink-0 text-xs font-medium">Agent SSH</span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">{terminalItems.map((terminal) => <div key={terminal.terminalId} className={`inline-flex max-w-44 shrink-0 items-center rounded ${activeTerminal?.terminalId === terminal.terminalId ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}><button onClick={() => { setActiveTerminalId(terminal.terminalId); setCollapsed(false); }} className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1 text-[11px]"><span className={`h-1.5 w-1.5 rounded-full ${terminal.status === 'open' ? 'bg-emerald-400' : terminal.status === 'error' ? 'bg-red-400' : 'bg-gray-500'}`} /><span className="truncate">{terminal.serverName}</span></button><button onClick={() => closeTerminal(terminal.terminalId)} className="mr-1 rounded p-0.5 text-gray-500 hover:bg-white/10 hover:text-red-300" title="关闭此终端"><X className="h-3 w-3" /></button></div>)}</div>
      {backgroundItems.length > 0 && <div className="group relative shrink-0"><span className="rounded px-2 py-1 text-[11px] text-gray-500">后台 {runningBackgroundCount > 0 ? `${runningBackgroundCount} 运行中` : backgroundItems.length}</span><div className="invisible absolute bottom-full right-0 z-20 mb-2 w-80 rounded-md border border-white/10 bg-[#111820] p-2 opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100"><div className="space-y-1">{backgroundItems.slice(0, 8).map((activity) => <div key={activity.executionId} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-white/5"><span className="min-w-0 flex-1 truncate text-gray-300">{activity.serverName} · {activity.command}</span><span className="shrink-0 text-gray-500">{statusText[activity.status]}</span>{['connecting', 'running'].includes(activity.status) && <button title="中断后台命令" onClick={() => void window.electronAPI.ssh.cancelExecution(activity.executionId)} className="p-0.5 text-gray-500 hover:text-red-400"><Square className="h-3 w-3" /></button>}</div>)}</div></div></div>}
      <button onClick={openTerminal} className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white" title="为当前服务器新建独立终端"><Plus className="h-3.5 w-3.5" /></button>
      <button onClick={() => setCollapsed((value) => !value)} className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white" title={collapsed ? '展开终端' : '折叠终端'}>{collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
    </header>
    {!collapsed && activeTerminal && <AgentTerminalViewport terminal={activeTerminal} />}
  </section>;
}

function AgentTerminalViewport({ terminal }: { terminal: AgentTerminal }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermTerminal | null>(null);
  const writtenLengthRef = useRef(0);

  useEffect(() => {
    const xterm = new XtermTerminal({ cursorBlink: true, convertEol: false, fontSize: 12, fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace', theme: { background: '#0b0f14', foreground: '#d7dde5', cursor: '#58d68d', selectionBackground: '#2d4258' }, scrollback: 10_000 });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xtermRef.current = xterm;
    if (hostRef.current) { xterm.open(hostRef.current); fit.fit(); }
    xterm.attachCustomWheelEventHandler((event) => { event.stopPropagation(); return true; });
    const resize = () => { fit.fit(); void window.electronAPI.ssh.resizeTerminal(terminal.terminalId, xterm.cols, xterm.rows).catch(() => undefined); };
    const observer = new ResizeObserver(resize);
    if (hostRef.current) observer.observe(hostRef.current);
    const input = xterm.onData((data) => void window.electronAPI.ssh.writeTerminal(terminal.terminalId, data).catch(() => undefined));
    return () => { input.dispose(); observer.disconnect(); xterm.dispose(); xtermRef.current = null; writtenLengthRef.current = 0; };
  }, [terminal.terminalId]);

  useEffect(() => {
    const next = terminal.text.slice(writtenLengthRef.current);
    if (!next) return;
    xtermRef.current?.write(next);
    writtenLengthRef.current = terminal.text.length;
  }, [terminal.text]);

  return <div ref={hostRef} onWheel={(event) => event.stopPropagation()} className="min-h-0 w-full flex-1 overflow-hidden p-2" />;
}
