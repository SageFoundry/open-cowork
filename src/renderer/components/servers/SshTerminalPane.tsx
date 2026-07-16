import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Terminal as TerminalIcon } from 'lucide-react';
import type { SshServer } from '../../types';

export function SshTerminalPane({ server }: { server: SshServer }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<'opening' | 'open' | 'closed' | 'error'>('opening');

  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'Cascadia Code, Consolas, monospace', theme: { background: '#111827', foreground: '#d1d5db', cursor: '#e5e7eb' }, scrollback: 5000 });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminalRef.current = terminal; fitRef.current = fit;
    if (hostRef.current) { terminal.open(hostRef.current); fit.fit(); }
    const resize = () => { fit.fit(); const id = terminalIdRef.current; if (id) void window.electronAPI.ssh.resizeTerminal(id, terminal.cols, terminal.rows); };
    const observer = new ResizeObserver(resize); if (hostRef.current) observer.observe(hostRef.current);
    const disposable = terminal.onData((data) => { const id = terminalIdRef.current; if (id) void window.electronAPI.ssh.writeTerminal(id, data); });
    const cleanupListener = window.electronAPI.on((event) => {
      if (event.type !== 'ssh.terminal' || event.payload.kind !== 'user' || event.payload.serverId !== server.id) return;
      if (terminalIdRef.current && event.payload.terminalId !== terminalIdRef.current) return;
      if (event.payload.type === 'data' && event.payload.text) terminal.write(event.payload.text);
      if (event.payload.type === 'opened') setStatus('open');
      if (event.payload.type === 'closed') { setStatus('closed'); terminalIdRef.current = null; }
      if (event.payload.type === 'error') { setStatus('error'); terminal.writeln(`\r\n[终端错误] ${event.payload.error ?? '未知错误'}`); }
    });
    window.electronAPI.ssh.openTerminal(server.id, terminal.cols, terminal.rows).then((id) => { terminalIdRef.current = id; }).catch((error) => { setStatus('error'); terminal.writeln(`\r\n[无法打开终端] ${error instanceof Error ? error.message : String(error)}`); });
    return () => { disposable.dispose(); observer.disconnect(); cleanupListener(); const id = terminalIdRef.current; if (id) void window.electronAPI.ssh.closeTerminal(id); terminal.dispose(); };
  }, [server.id]);

  const close = () => { const id = terminalIdRef.current; if (id) void window.electronAPI.ssh.closeTerminal(id); };
  return <div className="mt-4 overflow-hidden rounded-md border border-border-muted bg-[#111827]"><div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-gray-300"><TerminalIcon className="w-4 h-4" /><span className="flex-1 truncate">{server.name} · {server.username}@{server.host}</span>{status === 'opening' && <LoaderCircle className="w-3.5 h-3.5 animate-spin" />}{status === 'open' && <button onClick={close} title="关闭终端" className="p-1 hover:text-red-300"><Square className="w-3.5 h-3.5" /></button>}</div><div ref={hostRef} className="h-[360px] w-full p-2" /></div>;
}
