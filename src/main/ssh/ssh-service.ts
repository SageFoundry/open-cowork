import { createHash } from 'node:crypto';
import { safeStorage } from 'electron';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import {
  SshConnectionManager,
  type SshConnectionStatus,
} from './ssh-connection-manager';
import type { SshAuthorizationBroker } from './ssh-authorization-broker';

export type SshPermission = 'read' | 'execute';
export type SshExecutionMode = 'foreground' | 'background';
export type SshAuthType = 'password' | 'privateKey';
export type SshExecutionStatus = 'connecting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'timed_out';

export interface SshServerInput {
  id?: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  authType: SshAuthType;
  password?: string;
  privateKey?: string;
  defaultCwd?: string;
  tags?: string[];
}

export interface SshServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  hasCredential: boolean;
  hasTrustedHostKey: boolean;
  defaultCwd: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionSshGrant extends SshServer {
  permission: SshPermission;
  executionMode: SshExecutionMode;
  grantedAt: number;
}

export interface SshResourceNode {
  id: string;
  parentId: string | null;
  type: 'folder' | 'server';
  serverId: string | null;
  name: string;
  sortOrder: number;
  children: SshResourceNode[];
}

export interface SshResourceGrant {
  sessionId: string;
  resourceNodeId: string;
  permission: SshPermission;
  executionMode: SshExecutionMode;
  recursive: boolean;
  includeFutureChildren: boolean;
  grantedAt: number;
}

export interface SshExecutionEvent {
  executionId: string;
  sessionId: string;
  serverId: string;
  serverName: string;
  command: string;
  cwd?: string;
  status: SshExecutionStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
  stream?: 'stdout' | 'stderr';
  text?: string;
}

export interface SshConnectionTestResult {
  status: 'connected' | 'host_key_confirmation_required' | 'failed';
  fingerprint?: string;
  error?: string;
}

export interface SshDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: number | null;
}

export interface SshFileReadResult {
  path: string;
  content: string;
  offset: number;
  bytesRead: number;
  truncated: boolean;
}

interface SshServerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: SshAuthType;
  credential: Buffer | null;
  host_key_hash: string | null;
  default_cwd: string | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

interface ActiveExecution {
  sessionId: string;
  serverId: string;
  channel?: ClientChannel;
  complete: (status: SshExecutionStatus, error?: Error, exitCode?: number | null) => void;
}

export interface SshForegroundExecutionResult {
  terminalId: string;
  output: string;
  exitCode: number | null;
}

export interface SshForegroundTerminal {
  terminalId: string;
  serverId: string;
  serverName: string;
}

export class SshAbortError extends Error {
  constructor(message = '远程命令已中断') { super(message); this.name = 'SshAbortError'; }
}
export class SshTimeoutError extends Error {
  constructor() { super('远程命令执行超时'); this.name = 'SshTimeoutError'; }
}
export class SshHostKeyError extends Error {
  constructor(message: string) { super(message); this.name = 'SshHostKeyError'; }
}

export class SshService {
  private executions = new Map<string, ActiveExecution>();
  private readonly connections: SshConnectionManager;
  private authorizationBroker?: SshAuthorizationBroker;
  private closeTerminals?: (serverId: string) => void;
  private closeSessionTerminals?: (sessionId: string) => void;
  private foregroundExecutor?: (input: { sessionId: string; serverId: string; terminalId?: string; command: string; timeoutSeconds?: number; signal?: AbortSignal }) => Promise<SshForegroundExecutionResult>;
  private foregroundTerminalOpener?: (sessionId: string, serverId: string) => Promise<SshForegroundTerminal>;
  private foregroundTerminalLister?: (sessionId: string) => SshForegroundTerminal[];
  private foregroundTerminalCloser?: (sessionId: string, terminalId: string) => void;

  constructor(
    private readonly db: DatabaseInstance,
    private readonly emit: (event: SshExecutionEvent) => void,
    onConnectionStatus?: (status: SshConnectionStatus) => void
  ) {
    this.connections = new SshConnectionManager(onConnectionStatus);
  }

  setAuthorizationBroker(broker: SshAuthorizationBroker): void { this.authorizationBroker = broker; }
  setTerminalCloser(closeTerminals: (serverId: string) => void): void { this.closeTerminals = closeTerminals; }
  setSessionTerminalCloser(closeTerminals: (sessionId: string) => void): void { this.closeSessionTerminals = closeTerminals; }
  setForegroundExecutor(executor: (input: { sessionId: string; serverId: string; terminalId?: string; command: string; timeoutSeconds?: number; signal?: AbortSignal }) => Promise<SshForegroundExecutionResult>): void { this.foregroundExecutor = executor; }
  setForegroundTerminalManager(manager: { open: (sessionId: string, serverId: string) => Promise<SshForegroundTerminal>; list: (sessionId: string) => SshForegroundTerminal[]; close: (sessionId: string, terminalId: string) => void }): void {
    this.foregroundTerminalOpener = manager.open;
    this.foregroundTerminalLister = manager.list;
    this.foregroundTerminalCloser = manager.close;
  }
  requestAuthorization(sessionId: string): Promise<void> {
    if (!this.authorizationBroker) return Promise.reject(new Error('当前会话未授权 SSH 服务器资源'));
    return this.authorizationBroker.request(sessionId);
  }
  denyAuthorization(sessionId: string): void { this.authorizationBroker?.deny(sessionId); }

  listServers(): SshServer[] {
    return (this.db.raw.prepare('SELECT * FROM ssh_servers ORDER BY name COLLATE NOCASE').all() as SshServerRow[]).map((row) => this.toServer(row));
  }

  listResourceTree(): SshResourceNode[] {
    const rows = this.db.raw.prepare('SELECT * FROM ssh_resource_nodes ORDER BY sort_order, name COLLATE NOCASE').all() as Array<{ id: string; parent_id: string | null; node_type: 'folder' | 'server'; server_id: string | null; name: string; sort_order: number }>;
    const byId = new Map<string, SshResourceNode>();
    for (const row of rows) byId.set(row.id, { id: row.id, parentId: row.parent_id, type: row.node_type, serverId: row.server_id, name: row.name, sortOrder: row.sort_order, children: [] });
    const roots: SshResourceNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return roots;
  }

  createFolder(name: string, parentId = 'ssh-root'): SshResourceNode {
    const trimmed = name.trim(); if (!trimmed) throw new Error('目录名称不能为空');
    const parent = this.getResourceNode(parentId);
    if (!parent || parent.node_type !== 'folder') throw new Error('父资源目录不存在或不可包含子节点');
    const now = Date.now(); const id = uuidv4();
    this.db.raw.prepare('INSERT INTO ssh_resource_nodes (id, parent_id, node_type, server_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)').run(id, parentId, 'folder', trimmed, now, now, now);
    return { id, parentId, type: 'folder', serverId: null, name: trimmed, sortOrder: now, children: [] };
  }

  moveResourceNode(nodeId: string, parentId: string): void {
    if (nodeId === 'ssh-root' || nodeId === parentId) throw new Error('无效的资源目录');
    const node = this.getResourceNode(nodeId);
    const parent = this.getResourceNode(parentId);
    if (!node) throw new Error('资源节点不存在');
    if (!parent || parent.node_type !== 'folder') throw new Error('父资源目录不存在或不可包含子节点');
    const descendants = this.collectNodeIds(nodeId);
    if (descendants.includes(parentId)) throw new Error('不能移动到自身或子目录');
    this.db.raw.prepare('UPDATE ssh_resource_nodes SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId, Date.now(), nodeId);
  }

  listResourceGrants(sessionId: string): SshResourceGrant[] {
    return (this.db.raw.prepare('SELECT * FROM session_ssh_resource_grants WHERE session_id = ?').all(sessionId) as Array<{ session_id: string; resource_node_id: string; permission: SshPermission; execution_mode: SshExecutionMode; recursive: number; include_future_children: number; granted_at: number }>).map((row) => ({ sessionId: row.session_id, resourceNodeId: row.resource_node_id, permission: row.permission, executionMode: row.execution_mode, recursive: Boolean(row.recursive), includeFutureChildren: Boolean(row.include_future_children), grantedAt: row.granted_at }));
  }

  grantResource(sessionId: string, resourceNodeId: string, permission: SshPermission, recursive = true, includeFutureChildren = false, executionMode: SshExecutionMode = 'foreground'): void {
    if (permission !== 'read' && permission !== 'execute') throw new Error('\u65e0\u6548\u7684\u670d\u52a1\u5668\u6743\u9650');
    if (executionMode !== 'foreground' && executionMode !== 'background') throw new Error('无效的 SSH 执行模式');
    if (!this.collectNodeIds(resourceNodeId).length) throw new Error('资源节点不存在');
    const now = Date.now();
    this.db.raw.prepare('INSERT INTO session_ssh_resource_grants (session_id, resource_node_id, permission, execution_mode, recursive, include_future_children, granted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, resource_node_id) DO UPDATE SET permission = excluded.permission, execution_mode = excluded.execution_mode, recursive = excluded.recursive, include_future_children = excluded.include_future_children, updated_at = excluded.updated_at').run(sessionId, resourceNodeId, permission, executionMode, recursive ? 1 : 0, includeFutureChildren ? 1 : 0, now, now);
    this.authorizationBroker?.approve(sessionId);
  }

  revokeResource(sessionId: string, resourceNodeId: string): void {
    for (const serverId of this.resolveGrantedServerIds(sessionId, resourceNodeId)) this.cancel(sessionId, serverId);
    this.db.raw.prepare('DELETE FROM session_ssh_resource_grants WHERE session_id = ? AND resource_node_id = ?').run(sessionId, resourceNodeId);
  }

  saveServer(input: SshServerInput): SshServer {
    const name = input.name.trim();
    const host = input.host.trim();
    const username = input.username.trim();
    if (!name || !host || !username) throw new Error('服务器名称、主机和用户名不能为空');
    if (input.authType !== 'password' && input.authType !== 'privateKey') throw new Error('不支持的认证方式');
    const port = Number(input.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须介于 1 到 65535');
    const existing = input.id ? this.getServerRow(input.id) : undefined;
    const secret = input.authType === 'password' ? input.password?.trim() : input.privateKey?.trim();
    // A credential is only reusable when its authentication type did not change.
    if (!secret && (!existing?.credential || existing.auth_type !== input.authType)) {
      throw new Error(`\u5207\u6362\u4e3a${input.authType === 'password' ? '\u5bc6\u7801' : '\u79c1\u94a5'}\u8ba4\u8bc1\u65f6\u5fc5\u987b\u63d0\u4f9b\u65b0\u7684\u8ba4\u8bc1\u51ed\u8bc1`);
    }
    const id = existing?.id ?? uuidv4();
    const now = Date.now();
    const endpointChanged = Boolean(existing && (existing.host !== host || existing.port !== port));
    const authenticationChanged = Boolean(existing && (existing.username !== username || existing.auth_type !== input.authType || Boolean(secret)));
    if (existing && (endpointChanged || authenticationChanged)) this.closeServerConnections(existing.id);
    const credential = secret ? this.encrypt(secret) : existing!.credential;
    this.db.raw.prepare(`
      INSERT INTO ssh_servers (id, name, host, port, username, auth_type, credential, host_key_hash, default_cwd, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, host = excluded.host, port = excluded.port, username = excluded.username,
        auth_type = excluded.auth_type, credential = excluded.credential,
        host_key_hash = excluded.host_key_hash, default_cwd = excluded.default_cwd,
        tags_json = excluded.tags_json, updated_at = excluded.updated_at
    `).run(id, name, host, port, username, input.authType, credential,
      endpointChanged ? null : (existing?.host_key_hash ?? null), input.defaultCwd?.trim() || null,
      JSON.stringify(input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? []), existing?.created_at ?? now, now);
    this.db.raw.prepare(`INSERT OR IGNORE INTO ssh_resource_nodes (id, parent_id, node_type, server_id, name, sort_order, created_at, updated_at) VALUES (?, 'ssh-root', 'server', ?, ?, ?, ?, ?)`)
      .run(`server:${id}`, id, name, now, now, now);
    this.db.raw.prepare('UPDATE ssh_resource_nodes SET name = ?, updated_at = ? WHERE server_id = ?').run(name, now, id);
    return this.getServerOrThrow(id);
  }

  deleteServer(serverId: string): void {
    this.cancelByServer(serverId);
    this.closeServerConnections(serverId);
    this.db.raw.prepare('DELETE FROM ssh_servers WHERE id = ?').run(serverId);
  }

  listSessionGrants(sessionId: string): SessionSshGrant[] {
    const effective = new Map<string, { permission: SshPermission; executionMode: SshExecutionMode; grantedAt: number }>();
    const legacy = this.db.raw.prepare(`SELECT s.*, g.permission, g.execution_mode, g.granted_at FROM session_ssh_grants g JOIN ssh_servers s ON s.id = g.server_id WHERE g.session_id = ?`).all(sessionId) as Array<SshServerRow & { permission: SshPermission; execution_mode: SshExecutionMode; granted_at: number }>;
    legacy.forEach((row) => effective.set(row.id, { permission: row.permission, executionMode: row.execution_mode, grantedAt: row.granted_at }));
    for (const grant of this.listResourceGrants(sessionId)) {
      for (const serverId of this.resolveGrantedServerIdsForGrant(grant)) {
        const current = effective.get(serverId);
        if (!current || (grant.permission === 'execute' && current.permission === 'read') || (grant.permission === current.permission && grant.grantedAt >= current.grantedAt)) {
          effective.set(serverId, { permission: grant.permission, executionMode: grant.executionMode, grantedAt: grant.grantedAt });
        }
      }
    }
    if (!effective.size) return [];
    const ids = [...effective.keys()];
    const rows = this.db.raw.prepare(`SELECT * FROM ssh_servers WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`).all(...ids) as SshServerRow[];
    return rows.map((row) => ({ ...this.toServer(row), ...effective.get(row.id)! }));
  }

  grantSessionServer(sessionId: string, serverId: string, permission: SshPermission, executionMode: SshExecutionMode = 'foreground'): SessionSshGrant {
    if (permission !== 'read' && permission !== 'execute') throw new Error('\u65e0\u6548\u7684\u670d\u52a1\u5668\u6743\u9650');
    if (executionMode !== 'foreground' && executionMode !== 'background') throw new Error('无效的 SSH 执行模式');
    this.getServerOrThrow(serverId);
    const now = Date.now();
    this.db.raw.prepare(`INSERT INTO session_ssh_grants (session_id, server_id, permission, execution_mode, granted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, server_id) DO UPDATE SET permission = excluded.permission, execution_mode = excluded.execution_mode, updated_at = excluded.updated_at`).run(sessionId, serverId, permission, executionMode, now, now);
    return this.listSessionGrants(sessionId).find((grant) => grant.id === serverId)!;
  }

  revokeSessionServer(sessionId: string, serverId: string): void {
    this.cancel(sessionId, serverId);
    this.db.raw.prepare('DELETE FROM session_ssh_grants WHERE session_id = ? AND server_id = ?').run(sessionId, serverId);
  }

  async testConnection(serverId: string): Promise<SshConnectionTestResult> {
    const row = this.getServerRow(serverId);
    if (!row) throw new Error('服务器不存在');
    let discoveredFingerprint: string | undefined;
    try {
      await this.connect(row, (hash) => {
        discoveredFingerprint = hash;
        return row.host_key_hash === hash;
      });
      return { status: 'connected' };
    } catch (error) {
      if (discoveredFingerprint && !row.host_key_hash) return { status: 'host_key_confirmation_required', fingerprint: discoveredFingerprint };
      return { status: 'failed', error: this.errorMessage(error) };
    }
  }

  trustHostKey(serverId: string, fingerprint: string): void {
    const row = this.getServerRow(serverId);
    if (!row) throw new Error('服务器不存在');
    if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error('无效的 Host Key 指纹');
    this.db.raw.prepare('UPDATE ssh_servers SET host_key_hash = ?, updated_at = ? WHERE id = ?').run(fingerprint.toLowerCase(), Date.now(), serverId);
  }

  async acquireTerminalConnection(serverId: string): Promise<Client> {
    const row = this.getServerRow(serverId);
    if (!row) throw new Error('服务器不存在');
    if (!row.host_key_hash) throw new SshHostKeyError('服务器尚未确认 Host Key，请先在服务器设置中测试并确认连接');
    return this.connections.acquire(row.id, () => this.createClient(row, (hash) => row.host_key_hash === hash));
  }

  getConnectionStatus(serverId: string): SshConnectionStatus { return this.connections.getStatus(serverId); }
  listConnectionStatuses(): SshConnectionStatus[] { return this.connections.listStatuses(); }
  disconnectServer(serverId: string): void { this.cancelByServer(serverId); this.closeServerConnections(serverId); }
  shutdown(): void { this.executions.clear(); this.connections.shutdown(); }
  cancelAuthorization(sessionId: string): void { this.authorizationBroker?.cancelSession(sessionId); }

  async listDirectory(input: { sessionId: string; serverId: string; path: string }): Promise<SshDirectoryEntry[]> {
    const startedAt = Date.now();
    const row = this.requireReadGrant(input.sessionId, input.serverId);
    try {
      const entries = await this.withSftp(row, (sftp) => new Promise<SshDirectoryEntry[]>((resolve, reject) => {
        sftp.readdir(input.path, (error, list) => {
          if (error) return reject(error);
          resolve((list ?? []).map((entry) => ({
            name: entry.filename,
            path: this.joinRemotePath(input.path, entry.filename),
            type: entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : entry.attrs.isSymbolicLink() ? 'symlink' : 'other',
            size: entry.attrs.size,
            modifiedAt: entry.attrs.mtime ? entry.attrs.mtime * 1000 : null,
          })));
        });
      }));
      this.recordAudit(input.sessionId, row.id, 'list_directory', undefined, input.path, 'completed', startedAt, entries.length, null);
      return entries;
    } catch (error) {
      this.recordAudit(input.sessionId, row.id, 'list_directory', undefined, input.path, 'failed', startedAt, 0, this.errorMessage(error));
      throw error;
    }
  }

  async readFile(input: { sessionId: string; serverId: string; path: string; offset?: number; limit?: number }): Promise<SshFileReadResult> {
    const startedAt = Date.now();
    const row = this.requireReadGrant(input.sessionId, input.serverId);
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 65_536)), 256 * 1024);
    try {
      const result = await this.withSftp(row, (sftp) => new Promise<SshFileReadResult>((resolve, reject) => {
        const stream = sftp.createReadStream(input.path, { start: offset, end: offset + limit });
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.once('error', reject);
        stream.once('end', () => {
          const content = Buffer.concat(chunks);
          const truncated = content.length > limit;
          const boundedContent = truncated ? content.subarray(0, limit) : content;
          resolve({ path: input.path, content: boundedContent.toString('utf8'), offset, bytesRead: boundedContent.length, truncated });
        });
      }));
      this.recordAudit(input.sessionId, row.id, 'read_file', undefined, input.path, 'completed', startedAt, result.bytesRead, null);
      return result;
    } catch (error) {
      this.recordAudit(input.sessionId, row.id, 'read_file', undefined, input.path, 'failed', startedAt, 0, this.errorMessage(error));
      throw error;
    }
  }

  async execForeground(input: { sessionId: string; serverId: string; terminalId?: string; command: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<SshForegroundExecutionResult> {
    this.requireExecuteGrant(input.sessionId, input.serverId, 'foreground');
    if (!input.command.trim()) throw new Error('远程命令不能为空');
    if (!this.foregroundExecutor) throw new Error('SSH 可见终端服务尚未初始化');
    return this.foregroundExecutor(input);
  }

  listForegroundTerminals(sessionId: string): SshForegroundTerminal[] {
    return this.foregroundTerminalLister?.(sessionId) ?? [];
  }

  async openForegroundTerminal(sessionId: string, serverId: string): Promise<SshForegroundTerminal> {
    this.requireExecuteGrant(sessionId, serverId, 'foreground');
    if (!this.foregroundTerminalOpener) throw new Error('SSH 可见终端服务尚未初始化');
    return this.foregroundTerminalOpener(sessionId, serverId);
  }

  closeForegroundTerminal(sessionId: string, terminalId: string): void {
    if (!this.foregroundTerminalCloser) throw new Error('SSH 可见终端服务尚未初始化');
    this.foregroundTerminalCloser(sessionId, terminalId);
  }

  async exec(input: { sessionId: string; serverId: string; command: string; cwd?: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<{ executionId: string; stdout: string; stderr: string; exitCode: number | null; truncated: boolean }> {
    this.requireExecuteGrant(input.sessionId, input.serverId, 'background');
    if (!input.command.trim()) throw new Error('远程命令不能为空');
    const row = this.getServerRow(input.serverId);
    if (!row) throw new Error('服务器不存在');
    if (!row.host_key_hash) throw new SshHostKeyError('服务器尚未确认 Host Key，请先在服务器设置中测试并确认连接');

    const executionId = uuidv4();
    const startedAt = Date.now();
    const maxOutput = 256 * 1024;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let settled = false;
    const eventBase = { executionId, sessionId: input.sessionId, serverId: row.id, serverName: row.name, command: input.command, cwd: input.cwd, startedAt };
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const remaining = Math.max(0, maxOutput - stdout.length - stderr.length);
      if (text.length > remaining) truncated = true;
      if (stream === 'stdout') stdout += text.slice(0, remaining); else stderr += text.slice(0, remaining);
      this.emit({ ...eventBase, status: 'running', stream, text });
    };

    return new Promise((resolve, reject) => {
      const finish = (status: SshExecutionStatus, error?: Error, exitCode: number | null = null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (abortListener) input.signal?.removeEventListener('abort', abortListener);
        const active = this.executions.get(executionId);
        this.executions.delete(executionId);
        active?.channel?.close();
        this.emit({ ...eventBase, status, endedAt: Date.now(), exitCode, error: error?.message });
        this.recordAudit(input.sessionId, row.id, 'exec', input.command, input.cwd, status, startedAt, stdout.length + stderr.length, error?.message ?? null, exitCode);
        if (error) reject(error); else resolve({ executionId, stdout, stderr, exitCode, truncated });
      };
      const interrupt = (status: 'interrupted' | 'timed_out', error: Error) => {
        // finish marks the execution settled before client.end() can synchronously emit close.
        finish(status, error);
      };
      abortListener = () => interrupt('interrupted', new SshAbortError());
      if (input.signal?.aborted) return abortListener();
      input.signal?.addEventListener('abort', abortListener, { once: true });
      timeout = setTimeout(() => interrupt('timed_out', new SshTimeoutError()), Math.min(Math.max(input.timeoutSeconds ?? 120, 1), 600) * 1000);
      this.emit({ ...eventBase, status: 'connecting' });
      try {
        this.executions.set(executionId, { sessionId: input.sessionId, serverId: row.id, complete: finish });
        this.connections.acquire(row.id, () => this.createClient(row, (hash) => row.host_key_hash === hash))
          .then((client) => {
            if (settled) return;
            this.emit({ ...eventBase, status: 'running' });
            const cwd = input.cwd?.trim() || row.default_cwd;
            const command = cwd ? `cd -- ${this.quote(cwd)} && ${input.command}` : input.command;
            client.exec(command, (error, channel) => {
              if (error) return finish('failed', error);
              const active = this.executions.get(executionId);
              if (active) active.channel = channel;
              channel.on('data', (chunk: Buffer) => append('stdout', chunk));
              channel.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
              channel.once('error', (channelError: Error) => finish('failed', channelError));
              channel.once('close', (code: number | null) => finish('completed', undefined, code));
            });
          })
          .catch((error) => finish('failed', this.toHostKeyError(this.toError(error))));
      } catch (error) {
        finish('failed', this.toError(error));
      }
    });
  }

  cancelBySession(sessionId: string): void {
    for (const [id, execution] of this.executions) if (execution.sessionId === sessionId) this.cancelExecution(id);
    this.closeSessionTerminals?.(sessionId);
  }
  cancelByServer(serverId: string): void { for (const [id, execution] of this.executions) if (execution.serverId === serverId) this.cancelExecution(id); }
  cancel(sessionId: string, serverId: string): void { for (const [id, execution] of this.executions) if (execution.sessionId === sessionId && execution.serverId === serverId) this.cancelExecution(id); }
  cancelExecution(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;
    // complete settles before it closes the client, so close cannot win the race.
    execution.complete('interrupted', new SshAbortError());
  }

  private requireReadGrant(sessionId: string, serverId: string): SshServerRow {
    const grant = this.listSessionGrants(sessionId).find((item) => item.id === serverId);
    if (!grant) throw new Error('此服务器未授权给当前会话');
    const row = this.getServerRow(serverId);
    if (!row) throw new Error('服务器不存在');
    if (!row.host_key_hash) throw new SshHostKeyError('服务器尚未确认 Host Key，请先在服务器设置中测试并确认连接');
    return row;
  }

  private requireExecuteGrant(sessionId: string, serverId: string, executionMode: SshExecutionMode): SessionSshGrant {
    const grant = this.listSessionGrants(sessionId).find((item) => item.id === serverId);
    if (!grant) throw new Error('此服务器未授权给当前会话');
    if (grant.permission !== 'execute') throw new Error('\u5f53\u524d\u4f1a\u8bdd\u53ea\u6709\u53ea\u8bfb\u670d\u52a1\u5668\u6743\u9650\uff0c\u4e0d\u80fd\u6267\u884c\u8fdc\u7a0b\u547d\u4ee4');
    if (grant.executionMode !== executionMode) {
      throw new Error(executionMode === 'foreground' ? '此服务器仅授权后台执行，不能使用可见终端' : '此服务器仅授权可见终端，不能在后台执行');
    }
    return grant;
  }

  private async withSftp<T>(row: SshServerRow, callback: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = await this.connections.acquire(
      row.id,
      () => this.createClient(row, (hash) => row.host_key_hash === hash)
    );
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let sftp: SFTPWrapper | undefined;
      const timeout = setTimeout(() => finish(new SshTimeoutError()), 30_000);
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        sftp?.end();
        if (error) reject(error); else resolve(value as T);
      };
      client.sftp((error, openedSftp) => {
        if (error || !openedSftp) return finish(error ?? new Error('无法建立 SFTP channel'));
        sftp = openedSftp;
        callback(sftp).then((value) => finish(undefined, value), (callbackError) => finish(this.toError(callbackError)));
      });
    });
  }

  private recordAudit(sessionId: string, serverId: string, operation: string, commandPreview: string | undefined, path: string | undefined, status: SshExecutionStatus | 'completed' | 'failed', startedAt: number, outputBytes: number, errorMessage: string | null, exitCode: number | null = null): void {
    this.db.raw.prepare(`INSERT INTO ssh_audit_events (id, session_id, server_id, operation, command_preview, path, status, exit_code, started_at, ended_at, output_bytes, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), sessionId, serverId, operation, commandPreview?.slice(0, 4_000) ?? null, path?.slice(0, 4_000) ?? null, status, exitCode, startedAt, Date.now(), outputBytes, errorMessage);
  }

  private joinRemotePath(parent: string, child: string): string { return `${parent.replace(/\/+$/, '')}/${child}`; }
  private createClient(row: SshServerRow, hostVerifier: (fingerprint: string) => boolean): Client {
    const client = new Client();
    const credential = this.decrypt(row.credential);
    client.connect({ host: row.host, port: row.port, username: row.username, ...(row.auth_type === 'password' ? { password: credential } : { privateKey: credential }), readyTimeout: 15_000, hostHash: 'sha256', hostVerifier: (hash: string | Buffer) => hostVerifier(this.normalizeFingerprint(hash)) });
    return client;
  }

  private connect(row: SshServerRow, hostVerifier: (fingerprint: string) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = this.createClient(row, hostVerifier);
      const timeout = setTimeout(() => { client.destroy(); reject(new SshTimeoutError()); }, 15_000);
      const cleanup = () => { clearTimeout(timeout); client.removeAllListeners(); client.end(); };
      client.once('ready', () => { cleanup(); resolve(); });
      client.once('error', (error) => { cleanup(); reject(this.toHostKeyError(error)); });
      client.once('close', () => { cleanup(); reject(new Error('SSH 连接已关闭')); });
    });
  }

  private resolveGrantedServerIds(sessionId: string, onlyNodeId?: string): string[] {
    const grants = this.listResourceGrants(sessionId).filter((grant) => !onlyNodeId || grant.resourceNodeId === onlyNodeId);
    return [...new Set(grants.flatMap((grant) => this.resolveGrantedServerIdsForGrant(grant)))];
  }

  private resolveGrantedServerIdsForGrant(grant: SshResourceGrant): string[] {
    const ids = grant.recursive ? this.collectNodeIds(grant.resourceNodeId) : [grant.resourceNodeId];
    if (!ids.length) return [];
    const nodes = this.db.raw.prepare(`SELECT server_id FROM ssh_resource_nodes WHERE id IN (${ids.map(() => '?').join(',')}) AND server_id IS NOT NULL`).all(...ids) as Array<{ server_id: string }>;
    return nodes.map((node) => node.server_id);
  }

  private collectNodeIds(rootId: string): string[] {
    const rows = this.db.raw.prepare('SELECT id, parent_id FROM ssh_resource_nodes').all() as Array<{ id: string; parent_id: string | null }>;
    const children = new Map<string, string[]>();
    rows.forEach((row) => { if (row.parent_id) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row.id]); });
    if (!rows.some((row) => row.id === rootId)) return [];
    const result: string[] = []; const queue = [rootId];
    while (queue.length) { const id = queue.shift()!; result.push(id); queue.push(...(children.get(id) ?? [])); }
    return result;
  }

  private closeServerConnections(serverId: string): void {
    this.closeTerminals?.(serverId);
    this.connections.disconnect(serverId);
  }

  private getResourceNode(id: string): { id: string; node_type: 'folder' | 'server' } | undefined {
    return this.db.raw.prepare('SELECT id, node_type FROM ssh_resource_nodes WHERE id = ?').get(id) as { id: string; node_type: 'folder' | 'server' } | undefined;
  }

  private getServerRow(id: string): SshServerRow | undefined { return this.db.raw.prepare('SELECT * FROM ssh_servers WHERE id = ?').get(id) as SshServerRow | undefined; }
  private getServerOrThrow(id: string): SshServer { const row = this.getServerRow(id); if (!row) throw new Error('服务器不存在'); return this.toServer(row); }
  private toServer(row: SshServerRow): SshServer { let tags: string[] = []; try { tags = JSON.parse(row.tags_json); } catch { /* ignore malformed legacy tags */ } return { id: row.id, name: row.name, host: row.host, port: row.port, username: row.username, authType: row.auth_type, hasCredential: Boolean(row.credential), hasTrustedHostKey: Boolean(row.host_key_hash), defaultCwd: row.default_cwd, tags, createdAt: row.created_at, updatedAt: row.updated_at }; }
  private encrypt(value: string): Buffer { if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不可用安全凭证存储'); return safeStorage.encryptString(value); }
  private decrypt(value: Buffer | null): string { if (!value) throw new Error('服务器未配置认证凭证'); try { return safeStorage.decryptString(value); } catch { throw new Error('无法读取服务器凭证，请重新保存该服务器'); } }
  private normalizeFingerprint(hash: string | Buffer): string { return (typeof hash === 'string' ? hash : createHash('sha256').update(hash).digest('hex')).toLowerCase(); }
  private quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
  private toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
  private errorMessage(value: unknown): string { return this.toError(value).message; }
  private toHostKeyError(error: Error): Error { return /host.*key|host.*denied/i.test(error.message) ? new SshHostKeyError('Host Key 指纹未确认或已变化，连接已阻止') : error; }
}
