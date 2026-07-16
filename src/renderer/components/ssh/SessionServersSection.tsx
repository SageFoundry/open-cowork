import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Server, Trash2, X } from 'lucide-react';
import type { SessionSshGrant, SshResourceGrant, SshResourceNode } from '../../types';
import { useAppStore } from '../../store';
import { SshResourceTree } from '../servers/SshResourceTree';

function findNodeName(nodes: SshResourceNode[], id: string): string {
  for (const node of nodes) {
    if (node.id === id) return node.name;
    const nested = findNodeName(node.children, id);
    if (nested) return nested;
  }
  return '已删除资源';
}

export function SessionServersSection({ sessionId }: { sessionId: string }) {
  const setMainView = useAppStore((state) => state.setMainView);
  const setShowSettings = useAppStore((state) => state.setShowSettings);
  const requestServerEditor = useAppStore((state) => state.requestServerEditor);
  const [open, setOpen] = useState(true);
  const [showGrantDialog, setShowGrantDialog] = useState(false);
  const [grants, setGrants] = useState<SessionSshGrant[]>([]);
  const [resourceTree, setResourceTree] = useState<SshResourceNode[]>([]);
  const [resourceGrants, setResourceGrants] = useState<SshResourceGrant[]>([]);
  const [selectedNode, setSelectedNode] = useState<SshResourceNode | null>(null);
  const [permission, setPermission] = useState<'read' | 'execute'>('execute');
  const [executionMode, setExecutionMode] = useState<'foreground' | 'background'>('foreground');
  const load = useCallback(async () => {
    const [sessionGrants, tree, groupedGrants] = await Promise.all([
      window.electronAPI.ssh.listSessionGrants(sessionId),
      window.electronAPI.ssh.listResourceTree(),
      window.electronAPI.ssh.listResourceGrants(sessionId),
    ]);
    setGrants(sessionGrants);
    setResourceTree(tree);
    setResourceGrants(groupedGrants);
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => window.electronAPI.on((event) => {
    if (event.type === 'ssh.authorization.request' && event.payload.sessionId === sessionId) setShowGrantDialog(true);
  }), [sessionId]);

  const denyAuthorization = async () => {
    setShowGrantDialog(false);
    setSelectedNode(null);
    await window.electronAPI.ssh.denyAuthorization(sessionId);
  };
  const grantResource = async () => {
    if (!selectedNode) return;
    await window.electronAPI.ssh.grantResource(sessionId, selectedNode.id, permission, selectedNode.type === 'folder', true, executionMode);
    setShowGrantDialog(false);
    setSelectedNode(null);
    await load();
  };
  const grantedNodeIds = new Set(resourceGrants.map((grant) => grant.resourceNodeId));
  const grantLabel = (grant: Pick<SessionSshGrant, 'permission' | 'executionMode'>) =>
    grant.permission === 'execute' ? (grant.executionMode === 'foreground' ? '可见终端' : '后台执行') : '只读';

  return <div className="border-b border-border-muted">
    <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-hover">
      <Server className="h-3.5 w-3.5 text-text-muted" />
      <span className="flex-1 text-xs font-medium text-text-secondary">已授权服务器 {grants.length > 0 && `(${grants.length})`}</span>
      {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
    </button>
    {open && <div className="space-y-2 px-4 pb-3">
      {resourceGrants.map((grant) => <div key={grant.resourceNodeId} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{findNodeName(resourceTree, grant.resourceNodeId)}</span><span className="text-text-muted">{grantLabel(grant)}</span><button title="撤销资源授权" onClick={() => void window.electronAPI.ssh.revokeResource(sessionId, grant.resourceNodeId).then(load)} className="p-1 text-text-muted hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button></div>)}
      {resourceGrants.length === 0 && grants.map((grant) => <div key={grant.id} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{grant.name}</span><span className="text-text-muted">{grantLabel(grant)}</span><button title="撤销单服务器授权" onClick={() => void window.electronAPI.ssh.revokeSessionServer(sessionId, grant.id).then(load)} className="p-1 text-text-muted hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button></div>)}
      <div className="flex items-center gap-3 pt-1"><button onClick={() => setShowGrantDialog(true)} className="inline-flex items-center gap-1 text-xs text-accent hover:underline"><Plus className="h-3.5 w-3.5" />授权资源</button><button onClick={requestServerEditor} className="text-xs text-accent hover:underline">新增服务器</button><button onClick={() => { setShowSettings(false); setMainView('servers'); }} className="text-xs text-text-muted hover:text-text-secondary">管理服务器</button></div>
    </div>}
    {showGrantDialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"><div className="w-full max-w-md rounded-lg border border-border bg-surface shadow-elevated"><header className="flex items-center justify-between border-b border-border-muted px-4 py-3"><div><h2 className="text-sm font-semibold">授权服务器资源</h2><p className="mt-0.5 text-xs text-text-muted">选择资源，并决定 Agent 以可见终端还是后台方式操作。</p></div><button onClick={() => void denyAuthorization()} className="rounded p-1.5 hover:bg-surface-hover"><X className="h-4 w-4" /></button></header><div className="max-h-72 overflow-auto p-3"><SshResourceTree nodes={resourceTree} selectedId={selectedNode?.id} selectedNodeIds={grantedNodeIds} onSelect={setSelectedNode} /></div><div className="grid grid-cols-2 gap-2 border-t border-border-muted px-4 py-3"><label className="text-[11px] text-text-muted">权限<select value={permission} onChange={(event) => setPermission(event.target.value as 'read' | 'execute')} className="input mt-1 py-2 text-sm"><option value="execute">允许执行</option><option value="read">仅只读</option></select></label><label className={`text-[11px] text-text-muted ${permission === 'read' ? 'opacity-45' : ''}`}>执行方式<select disabled={permission === 'read'} value={executionMode} onChange={(event) => setExecutionMode(event.target.value as 'foreground' | 'background')} className="input mt-1 py-2 text-sm disabled:cursor-not-allowed"><option value="foreground">可见终端（保留状态）</option><option value="background">后台执行（独立任务）</option></select></label></div><footer className="flex items-center justify-end gap-2 border-t border-border-muted px-4 py-3"><button onClick={() => void denyAuthorization()} className="px-2 py-2 text-sm text-text-secondary">取消</button><button disabled={!selectedNode} onClick={() => void grantResource()} className="btn btn-primary rounded-md px-3 py-2 text-sm disabled:opacity-40">授权{selectedNode ? `：${selectedNode.name}` : ''}</button></footer></div></div>}
  </div>;
}
