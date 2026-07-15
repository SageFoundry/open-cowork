import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderPlus, KeyRound, LoaderCircle, Pencil, Plus, Search, Server, ShieldCheck, ShieldAlert, Trash2, X } from 'lucide-react';
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

const emptyForm: ServerForm = { name: '', host: '', port: '22', username: '', authType: 'password', password: '', privateKey: '', defaultCwd: '', tags: '' };
type ConnectionTestFeedback = { serverId: string; status: 'testing' | 'success' | 'failed' | 'confirmation_required'; message: string };

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
    const [serverList, resourceTree] = await Promise.all([window.electronAPI.ssh.listServers(), window.electronAPI.ssh.listResourceTree()]);
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
    const visit = (nodes: SshResourceNode[]): SshResourceNode | undefined => nodes.flatMap((node) => [node, ...node.children]).find((node) => node.id === selectedNodeId);
    return visit(tree);
  }, [tree, selectedNodeId]);
  const visibleServers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const collectServerIds = (node: SshResourceNode): string[] => {
      const own = node.serverId ? [node.serverId] : [];
      return [...own, ...node.children.flatMap(collectServerIds)];
    };
    const selectedServerIds = selectedNode ? new Set(collectServerIds(selectedNode)) : undefined;
    return servers.filter((server) => (!selectedServerIds || selectedServerIds.has(server.id)) && (!normalized || `${server.name} ${server.host} ${server.username} ${server.tags.join(' ')}`.toLowerCase().includes(normalized)));
  }, [query, servers, selectedNode]);

  const closeEditor = () => { setEditingId(null); setForm(emptyForm); setShowEditor(false); };
  const createFolder = async () => {
    const name = window.prompt('Ŀ¼����');
    if (!name?.trim()) return;
    try { await window.electronAPI.ssh.createFolder(name, selectedNode?.type === 'folder' ? selectedNode.id : selectedNode?.parentId ?? 'ssh-root'); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '����Ŀ¼ʧ��'); }
  };
  const moveServer = async (serverId: string) => {
    const parentId = selectedNode?.type === 'folder' ? selectedNode.id : selectedNode?.parentId;
    if (!parentId) return;
    await window.electronAPI.ssh.moveResourceNode(`server:${serverId}`, parentId);
    await load();
  };
  const edit = (server: SshServer) => {
    setEditingId(server.id);
    setForm({ name: server.name, host: server.host, port: String(server.port), username: server.username, authType: server.authType, password: '', privateKey: '', defaultCwd: server.defaultCwd ?? '', tags: server.tags.join(', ') });
    setShowEditor(true);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    try {
      await window.electronAPI.ssh.saveServer({ id: editingId ?? undefined, name: form.name, host: form.host, port: Number(form.port), username: form.username, authType: form.authType, password: form.password || undefined, privateKey: form.privateKey || undefined, defaultCwd: form.defaultCwd || undefined, tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      await load();
      closeEditor();
      setMessage(editingId ? '�����������Ѹ���' : '�����������');
    } catch (error) { setMessage(error instanceof Error ? error.message : '���������ʧ��'); }
  };
  const testConnection = async (server: SshServer) => {
    setMessage(null);
    setConnectionTest({ serverId: server.id, status: 'testing', message: `�������� ${server.name}��` });
    try {
      const result = await window.electronAPI.ssh.testConnection(server.id);
      if (result.status === 'connected') {
        setConnectionTest({ serverId: server.id, status: 'success', message: `${server.name} ���ӳɹ�` });
        return;
      }
      if (result.status === 'host_key_confirmation_required' && result.fingerprint) {
        setConnectionTest({ serverId: server.id, status: 'confirmation_required', message: `��ȷ�� ${server.name} �� Host Key ָ��` });
        if (!window.confirm(`�״����� ${server.name}��ȷ�� Host Key ָ�ƣ�\n${result.fingerprint}`)) {
          setConnectionTest({ serverId: server.id, status: 'failed', message: '��ȡ�� Host Key ȷ�ϣ�δ��������' });
          return;
        }
        setConnectionTest({ serverId: server.id, status: 'testing', message: `������֤ ${server.name}��` });
        await window.electronAPI.ssh.trustHostKey(server.id, result.fingerprint);
        await load();
        const retry = await window.electronAPI.ssh.testConnection(server.id);
        setConnectionTest({
          serverId: server.id,
          status: retry.status === 'connected' ? 'success' : 'failed',
          message: retry.status === 'connected' ? `${server.name} ���ӳɹ�` : (retry.error ?? 'Host Key ��ȷ�ϣ���������֤ʧ��'),
        });
        return;
      }
      setConnectionTest({ serverId: server.id, status: 'failed', message: result.error ?? '����ʧ��' });
    } catch (error) {
      setConnectionTest({ serverId: server.id, status: 'failed', message: error instanceof Error ? error.message : '���Ӳ���ʧ��' });
    }
  };

  return <div className="h-full overflow-y-auto bg-background">
    <div className="max-w-[1120px] mx-auto px-5 py-6 lg:px-9 lg:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-border-muted pb-5">
        <div><button onClick={() => setMainView('chat')} className="-ml-2 mb-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary" title="���ضԻ�"><ArrowLeft className="h-3.5 w-3.5" />{activeSessionId ? '���ص�ǰ�Ի�' : '���ع�����'}</button><p className="text-[11px] uppercase tracking-[0.14em] text-text-muted">������ʩ</p><h1 className="mt-1 text-xl font-semibold text-text-primary">������</h1><p className="mt-1 text-sm text-text-muted">���� SSH ���ӣ������Ự��Ȩ Agent ���ʡ�</p></div>
        <button onClick={() => { setMessage(null); setShowEditor(true); }} className="btn btn-primary rounded-md px-4 py-2 shadow-card active:scale-[0.98]"><Plus className="w-4 h-4" />��ӷ�����</button>
      </header>
      {message && <p className="mt-3 text-sm text-accent">{message}</p>}
      {connectionTest && <div role="status" aria-live="polite" className={`mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${connectionTest.status === 'failed' ? 'border-error/25 bg-error/10 text-error' : connectionTest.status === 'success' ? 'border-success/25 bg-success/10 text-success' : 'border-accent/25 bg-accent-muted text-accent'}`}>{connectionTest.status === 'testing' && <LoaderCircle className="h-4 w-4 animate-spin" />}{connectionTest.message}</div>}
      <div className="mt-5 grid min-h-[440px] grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="rounded-md border border-border-muted bg-surface p-2"><div className="flex items-center justify-between border-b border-border-muted px-2 pb-2"><span className="text-xs font-medium text-text-secondary">��ԴĿ¼</span><button onClick={() => void createFolder()} title="�½�Ŀ¼" className="p-1 text-text-muted hover:text-text-primary"><FolderPlus className="w-4 h-4" /></button></div><SshResourceTree nodes={tree} selectedId={selectedNodeId} onSelect={(node) => setSelectedNodeId(node.id)} /></aside>
        <section className="overflow-hidden rounded-md border border-border-muted"><div className="flex items-center gap-2 border-b border-border-muted bg-surface px-3 py-2"><Search className="w-4 h-4 text-text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="�������ơ��������û����ǩ" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted" /><span className="text-xs text-text-muted">{selectedNode?.name ?? 'ȫ��������'}</span></div>
          {visibleServers.map((server) => {
            const feedback = connectionTest?.serverId === server.id ? connectionTest : null;
            const isTesting = feedback?.status === 'testing';
            return <article key={server.id} className="flex items-center gap-3 px-4 py-3 border-b border-border-muted last:border-b-0 hover:bg-surface-hover/60"><KeyRound className="w-4 h-4 shrink-0 text-text-muted" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-medium text-text-primary">{server.name}</h2>{server.hasTrustedHostKey ? <ShieldCheck className="w-3.5 h-3.5 text-accent" aria-label="Host Key ��ȷ��" /> : <ShieldAlert className="w-3.5 h-3.5 text-warning" aria-label="Host Key δȷ��" />}{feedback && feedback.status !== 'testing' && <span className={`text-[11px] ${feedback.status === 'success' ? 'text-success' : feedback.status === 'failed' ? 'text-error' : 'text-accent'}`}>{feedback.status === 'success' ? '���ӳɹ�' : feedback.status === 'failed' ? '����ʧ��' : '�ȴ�ȷ��'}</span>}</div><p className="mt-0.5 truncate text-xs text-text-muted">{server.username}@{server.host}:{server.port} �� {server.authType === 'password' ? '������֤' : '˽Կ��֤'} �� {server.hasCredential ? 'ƾ֤������' : 'ȱ��ƾ֤'}</p>{server.tags.length > 0 && <div className="mt-1.5 flex gap-1 overflow-hidden">{server.tags.map((tag) => <span key={tag} className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-text-muted">{tag}</span>)}</div>}</div><div className="flex shrink-0 items-center gap-1"><button disabled={!server.hasTrustedHostKey} onClick={() => setTerminalServer(server)} className="px-2 py-1.5 text-xs text-accent hover:bg-accent/10 rounded disabled:opacity-40" title="�򿪽����ն�">�ն�</button><button onClick={() => void moveServer(server.id)} className="px-2 py-1.5 text-xs text-text-muted hover:bg-surface-hover rounded" title="�ƶ�����ǰĿ¼">�ƶ�����</button><button disabled={isTesting} onClick={() => void testConnection(server)} className="inline-flex min-w-[66px] items-center justify-center gap-1 rounded px-2 py-1.5 text-xs text-accent hover:bg-accent/10 disabled:cursor-wait disabled:bg-accent-muted disabled:opacity-100" title="��������">{isTesting && <LoaderCircle className="h-3 w-3 animate-spin" />}{isTesting ? '������' : '����'}</button><button onClick={() => edit(server)} className="p-2 text-text-secondary hover:bg-surface-hover rounded" title="�༭"><Pencil className="w-4 h-4" /></button><button onClick={() => void window.electronAPI.ssh.deleteServer(server.id).then(load)} className="p-2 text-error hover:bg-error/10 rounded" title="ɾ��"><Trash2 className="w-4 h-4" /></button></div></article>;
          })}
          {visibleServers.length === 0 && <div className="px-5 py-14 text-center"><Server className="mx-auto w-7 h-7 text-text-muted" /><p className="mt-3 text-sm text-text-secondary">{servers.length === 0 ? '��δ��ӷ�����' : '��ǰĿ¼û��ƥ��ķ�����'}</p><p className="mt-1 text-xs text-text-muted">������ƾ֤���������̵�ϵͳ��ȫ�洢�м��ܱ��档</p></div>}
        </section>
      </div>
      {terminalServer && <SshTerminalPane key={terminalServer.id} server={terminalServer} />}
    </div>
    {showEditor && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"><form onSubmit={submit} className="w-full max-w-2xl rounded-lg border border-border bg-surface shadow-elevated"><header className="flex items-center justify-between border-b border-border-muted px-5 py-4"><div><h2 className="text-base font-semibold">{editingId ? '�༭������' : '��ӷ�����'}</h2><p className="mt-0.5 text-xs text-text-muted">��֤ƾ֤������ʾ�� Agent ��д����ͨ��־��</p></div><button type="button" onClick={closeEditor} className="p-2 rounded hover:bg-surface-hover"><X className="w-4 h-4" /></button></header><div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-5"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="��ʾ����" className="input" /><input required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="���� / IP" className="input" /><input required type="number" min="1" max="65535" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="�˿�" className="input" /><input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="�û���" className="input" /><select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as ServerForm['authType'] })} className="input"><option value="password">������֤</option><option value="privateKey">˽Կ��֤</option></select><input value={form.defaultCwd} onChange={(e) => setForm({ ...form, defaultCwd: e.target.value })} placeholder="Ĭ��Զ��Ŀ¼����ѡ��" className="input" />{form.authType === 'password' ? <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editingId ? '��֤��ʽ����ʱ������Ա�������' : '����'} className="input sm:col-span-2" /> : <textarea value={form.privateKey} onChange={(e) => setForm({ ...form, privateKey: e.target.value })} placeholder={editingId ? '��֤��ʽ����ʱ������Ա���˽Կ' : '˽Կ����'} className="input sm:col-span-2 min-h-28 font-mono" />}<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="��ǩ���ö��ŷָ�" className="input sm:col-span-2" /></div><footer className="flex justify-end gap-2 border-t border-border-muted px-5 py-4"><button type="button" onClick={closeEditor} className="px-3 py-2 text-sm text-text-secondary">ȡ��</button><button type="submit" className="btn btn-primary rounded-md px-3 py-2 text-sm">{editingId ? '�����޸�' : '��ӷ�����'}</button></footer></form></div>}
  </div>;
}
