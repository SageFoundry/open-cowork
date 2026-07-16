import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderPlus, KeyRound, LoaderCircle, Pencil, Plus, Search, Server, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import type { SshResourceNode, SshServer } from '../../types';
import { useAppStore } from '../../store';
import { SshResourceTree } from './SshResourceTree';
import { SshTerminalPane } from './SshTerminalPane';

type ServerForm = {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: 'password' | 'privateKey';
  password: string;
  privateKey: string;
  defaultCwd: string;
  tags: string;
};

type ConnectionTestFeedback = {
  serverId: string;
  status: 'testing' | 'success' | 'failed' | 'confirmation_required';
  message: string;
};

const emptyForm: ServerForm = {
  name: '', host: '', port: '22', username: '', authType: 'password', password: '', privateKey: '', defaultCwd: '', tags: '',
};

export function ServersPage() {
  const serverEditorRequestId = useAppStore((state) => state.serverEditorRequestId);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setMainView = useAppStore((state) => state.setMainView);
  const [servers, setServers] = useState<SshServer[]>([]);
  const [tree, setTree] = useState<SshResourceNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState('ssh-root');
  const [terminalServer, setTerminalServer] = useState<SshServer | null>(null);
  const [form, setForm] = useState<ServerForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [connectionTest, setConnectionTest] = useState<ConnectionTestFeedback | null>(null);

  const load = async () => {
    const [serverList, resourceTree] = await Promise.all([
      window.electronAPI.ssh.listServers(),
      window.electronAPI.ssh.listResourceTree(),
    ]);
    setServers(serverList);
    setTree(resourceTree);
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (serverEditorRequestId > 0) {
      setEditingId(null);
      setForm(emptyForm);
      setMessage(null);
      setShowEditor(true);
    }
  }, [serverEditorRequestId]);

  const selectedNode = useMemo(() => {
    const visit = (nodes: SshResourceNode[]): SshResourceNode | undefined =>
      nodes.flatMap((node) => [node, ...node.children]).find((node) => node.id === selectedNodeId);
    return visit(tree);
  }, [tree, selectedNodeId]);

  const visibleServers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const collectServerIds = (node: SshResourceNode): string[] => [
      ...(node.serverId ? [node.serverId] : []),
      ...node.children.flatMap(collectServerIds),
    ];
    const selectedServerIds = selectedNode ? new Set(collectServerIds(selectedNode)) : undefined;
    return servers.filter((server) => {
      const matchesNode = !selectedServerIds || selectedServerIds.has(server.id);
      const matchesQuery = !normalized || `${server.name} ${server.host} ${server.username} ${server.tags.join(' ')}`.toLowerCase().includes(normalized);
      return matchesNode && matchesQuery;
    });
  }, [query, servers, selectedNode]);

  const closeEditor = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowEditor(false);
  };
  const createFolder = async () => {
    const name = window.prompt('目录名称');
    if (!name?.trim()) return;
    try {
      await window.electronAPI.ssh.createFolder(name, selectedNode?.type === 'folder' ? selectedNode.id : selectedNode?.parentId ?? 'ssh-root');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建目录失败');
    }
  };
  const moveServer = async (serverId: string) => {
    const parentId = selectedNode?.type === 'folder' ? selectedNode.id : selectedNode?.parentId;
    if (!parentId) return;
    await window.electronAPI.ssh.moveResourceNode(`server:${serverId}`, parentId);
    await load();
  };
  const edit = (server: SshServer) => {
    setEditingId(server.id);
    setForm({
      name: server.name, host: server.host, port: String(server.port), username: server.username,
      authType: server.authType, password: '', privateKey: '', defaultCwd: server.defaultCwd ?? '', tags: server.tags.join(', '),
    });
    setShowEditor(true);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    try {
      await window.electronAPI.ssh.saveServer({
        id: editingId ?? undefined, name: form.name, host: form.host, port: Number(form.port), username: form.username,
        authType: form.authType, password: form.password || undefined, privateKey: form.privateKey || undefined,
        defaultCwd: form.defaultCwd || undefined, tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      });
      await load();
      closeEditor();
      setMessage(editingId ? '服务器配置已更新' : '服务器已添加');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存服务器失败');
    }
  };
  const testConnection = async (server: SshServer) => {
    setMessage(null);
    setConnectionTest({ serverId: server.id, status: 'testing', message: `正在连接 ${server.name}…` });
    try {
      const result = await window.electronAPI.ssh.testConnection(server.id);
      if (result.status === 'connected') {
        setConnectionTest({ serverId: server.id, status: 'success', message: `${server.name} 连接成功` });
        return;
      }
      if (result.status === 'host_key_confirmation_required' && result.fingerprint) {
        setConnectionTest({ serverId: server.id, status: 'confirmation_required', message: `请确认 ${server.name} 的 Host Key 指纹` });
        if (!window.confirm(`首次连接 ${server.name}。确认 Host Key 指纹：\n${result.fingerprint}`)) {
          setConnectionTest({ serverId: server.id, status: 'failed', message: '已取消 Host Key 确认，未建立连接' });
          return;
        }
        setConnectionTest({ serverId: server.id, status: 'testing', message: `正在验证 ${server.name}…` });
        await window.electronAPI.ssh.trustHostKey(server.id, result.fingerprint);
        await load();
        const retry = await window.electronAPI.ssh.testConnection(server.id);
        setConnectionTest({
          serverId: server.id,
          status: retry.status === 'connected' ? 'success' : 'failed',
          message: retry.status === 'connected' ? `${server.name} 连接成功` : (retry.error ?? 'Host Key 已确认，但连接验证失败'),
        });
        return;
      }
      setConnectionTest({ serverId: server.id, status: 'failed', message: result.error ?? '连接失败' });
    } catch (error) {
      setConnectionTest({ serverId: server.id, status: 'failed', message: error instanceof Error ? error.message : '连接测试失败' });
    }
  };

  return <div className="h-full overflow-y-auto bg-background">
    <div className="mx-auto max-w-[1120px] px-5 py-6 lg:px-9 lg:py-8">
      <header className="flex flex-col gap-4 border-b border-border-muted pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <button onClick={() => setMainView('chat')} className="-ml-2 mb-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary" title="返回对话"><ArrowLeft className="h-3.5 w-3.5" />{activeSessionId ? '返回当前对话' : '返回工作区'}</button>
          <p className="text-[11px] uppercase tracking-[0.14em] text-text-muted">基础设施</p>
          <h1 className="mt-1 text-xl font-semibold text-text-primary">服务器</h1>
          <p className="mt-1 text-sm text-text-muted">管理 SSH 连接，并按会话授权 Agent 访问。</p>
        </div>
        <button onClick={() => { setMessage(null); setShowEditor(true); }} className="btn btn-primary rounded-md px-4 py-2 shadow-card active:scale-[0.98]"><Plus className="h-4 w-4" />添加服务器</button>
      </header>
      {message && <p className="mt-3 text-sm text-accent">{message}</p>}
      {connectionTest && <div role="status" aria-live="polite" className={`mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${connectionTest.status === 'failed' ? 'border-error/25 bg-error/10 text-error' : connectionTest.status === 'success' ? 'border-success/25 bg-success/10 text-success' : 'border-accent/25 bg-accent-muted text-accent'}`}>{connectionTest.status === 'testing' && <LoaderCircle className="h-4 w-4 animate-spin" />}{connectionTest.message}</div>}
      <div className="mt-5 grid min-h-[440px] grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded-md border border-border-muted bg-surface p-2"><div className="flex items-center justify-between border-b border-border-muted px-2 pb-2"><span className="text-xs font-medium text-text-secondary">资源目录</span><button onClick={() => void createFolder()} title="新建目录" className="p-1 text-text-muted hover:text-text-primary"><FolderPlus className="h-4 w-4" /></button></div><SshResourceTree nodes={tree} selectedId={selectedNodeId} onSelect={(node) => setSelectedNodeId(node.id)} /></aside>
        <section className="overflow-hidden rounded-md border border-border-muted"><div className="flex items-center gap-2 border-b border-border-muted bg-surface px-3 py-2"><Search className="h-4 w-4 text-text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、主机、用户或标签" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted" /><span className="text-xs text-text-muted">{selectedNode?.name ?? '全部服务器'}</span></div>
          {visibleServers.map((server) => {
            const feedback = connectionTest?.serverId === server.id ? connectionTest : null;
            const isTesting = feedback?.status === 'testing';
            return <article key={server.id} className="flex items-center gap-3 border-b border-border-muted px-4 py-3 last:border-b-0 hover:bg-surface-hover/60"><KeyRound className="h-4 w-4 shrink-0 text-text-muted" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-medium text-text-primary">{server.name}</h2>{server.hasTrustedHostKey ? <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-label="Host Key 已确认" /> : <ShieldAlert className="h-3.5 w-3.5 text-warning" aria-label="Host Key 未确认" />}{feedback && feedback.status !== 'testing' && <span className={`text-[11px] ${feedback.status === 'success' ? 'text-success' : feedback.status === 'failed' ? 'text-error' : 'text-accent'}`}>{feedback.status === 'success' ? '连接成功' : feedback.status === 'failed' ? '测试失败' : '等待确认'}</span>}</div><p className="mt-0.5 truncate text-xs text-text-muted">{server.username}@{server.host}:{server.port} · {server.authType === 'password' ? '密码认证' : '私钥认证'} · {server.hasCredential ? '凭证已配置' : '缺少凭证'}</p>{server.tags.length > 0 && <div className="mt-1.5 flex gap-1 overflow-hidden">{server.tags.map((tag) => <span key={tag} className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-muted">{tag}</span>)}</div>}</div><div className="flex shrink-0 items-center gap-1"><button disabled={!server.hasTrustedHostKey} onClick={() => setTerminalServer(server)} className="rounded px-2 py-1.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-40" title="打开交互终端">终端</button><button onClick={() => void moveServer(server.id)} className="rounded px-2 py-1.5 text-xs text-text-muted hover:bg-surface-hover" title="移动到当前目录">移动至此</button><button disabled={isTesting} onClick={() => void testConnection(server)} className="inline-flex min-w-[66px] items-center justify-center gap-1 rounded px-2 py-1.5 text-xs text-accent hover:bg-accent/10 disabled:cursor-wait disabled:bg-accent-muted disabled:opacity-100" title="测试连接">{isTesting && <LoaderCircle className="h-3 w-3 animate-spin" />}{isTesting ? '测试中' : '测试'}</button><button onClick={() => edit(server)} className="rounded p-2 text-text-secondary hover:bg-surface-hover" title="编辑"><Pencil className="h-4 w-4" /></button><button onClick={() => void window.electronAPI.ssh.deleteServer(server.id).then(load)} className="rounded p-2 text-error hover:bg-error/10" title="删除"><Trash2 className="h-4 w-4" /></button></div></article>;
          })}
          {visibleServers.length === 0 && <div className="px-5 py-14 text-center"><Server className="mx-auto h-7 w-7 text-text-muted" /><p className="mt-3 text-sm text-text-secondary">{servers.length === 0 ? '尚未添加服务器' : '当前目录没有匹配的服务器'}</p><p className="mt-1 text-xs text-text-muted">服务器凭证仅在主进程的系统安全存储中加密保存。</p></div>}
        </section>
      </div>
      {terminalServer && <SshTerminalPane key={terminalServer.id} server={terminalServer} />}
    </div>
    {showEditor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"><form onSubmit={submit} className="w-full max-w-2xl rounded-lg border border-border bg-surface shadow-elevated"><header className="flex items-center justify-between border-b border-border-muted px-5 py-4"><div><h2 className="text-base font-semibold">{editingId ? '编辑服务器' : '添加服务器'}</h2><p className="mt-0.5 text-xs text-text-muted">认证凭证不会显示给 Agent 或写入普通日志。</p></div><button type="button" onClick={closeEditor} className="rounded p-2 hover:bg-surface-hover"><X className="h-4 w-4" /></button></header><div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="显示名称" className="input" /><input required value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="主机 / IP" className="input" /><input required type="number" min="1" max="65535" value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} placeholder="端口" className="input" /><input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="用户名" className="input" /><select value={form.authType} onChange={(event) => setForm({ ...form, authType: event.target.value as ServerForm['authType'] })} className="input"><option value="password">密码认证</option><option value="privateKey">私钥认证</option></select><input value={form.defaultCwd} onChange={(event) => setForm({ ...form, defaultCwd: event.target.value })} placeholder="默认远程目录（可选）" className="input" />{form.authType === 'password' ? <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={editingId ? '认证方式不变时可留空以保留密码' : '密码'} className="input sm:col-span-2" /> : <textarea value={form.privateKey} onChange={(event) => setForm({ ...form, privateKey: event.target.value })} placeholder={editingId ? '认证方式不变时可留空以保留私钥' : '私钥内容'} className="input min-h-28 font-mono sm:col-span-2" />}<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="标签，用逗号分隔" className="input sm:col-span-2" /></div><footer className="flex justify-end gap-2 border-t border-border-muted px-5 py-4"><button type="button" onClick={closeEditor} className="px-3 py-2 text-sm text-text-secondary">取消</button><button type="submit" className="btn btn-primary rounded-md px-3 py-2 text-sm">{editingId ? '保存修改' : '添加服务器'}</button></footer></form></div>}
  </div>;
}
