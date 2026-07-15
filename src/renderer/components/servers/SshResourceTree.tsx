import { ChevronDown, ChevronRight, Folder, FolderOpen, Server } from 'lucide-react';
import { useState } from 'react';
import type { SshResourceNode } from '../../types';

interface SshResourceTreeProps {
  nodes: SshResourceNode[];
  selectedId?: string;
  onSelect: (node: SshResourceNode) => void;
  selectable?: (node: SshResourceNode) => boolean;
  selectedNodeIds?: Set<string>;
}

export function SshResourceTree({ nodes, selectedId, onSelect, selectable, selectedNodeIds }: SshResourceTreeProps) {
  return <div className="py-1">{nodes.map((node) => <TreeNode key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} selectable={selectable} selectedNodeIds={selectedNodeIds} />)}</div>;
}

function TreeNode({ node, selectedId, onSelect, selectable, selectedNodeIds }: Omit<SshResourceTreeProps, 'nodes'> & { node: SshResourceNode }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelectable = selectable?.(node) ?? true;
  const active = selectedId === node.id || selectedNodeIds?.has(node.id);
  return <div>
    <div className={`group flex min-w-0 items-center gap-1 rounded px-1 py-1 text-xs ${active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-hover'}`}>
      {node.type === 'folder' ? <button type="button" onClick={() => setExpanded(!expanded)} className="p-0.5 text-text-muted">{hasChildren ? (expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : <span className="inline-block w-3" />}</button> : <span className="inline-block w-4" />}
      <button type="button" disabled={!isSelectable} onClick={() => onSelect(node)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"><span>{node.type === 'folder' ? (expanded ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />) : <Server className="w-3.5 h-3.5" />}</span><span className="truncate">{node.name}</span></button>
    </div>
    {node.type === 'folder' && expanded && hasChildren && <div className="ml-3 border-l border-border-muted pl-1">{node.children.map((child) => <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} selectable={selectable} selectedNodeIds={selectedNodeIds} />)}</div>}
  </div>;
}
