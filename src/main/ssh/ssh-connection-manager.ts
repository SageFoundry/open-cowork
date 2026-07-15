import { type Client } from 'ssh2';

export type SshConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface SshConnectionStatus {
  serverId: string;
  state: SshConnectionState;
  updatedAt: number;
  error?: string;
}

interface ManagedConnection extends SshConnectionStatus {
  client?: Client;
  pending?: Promise<Client>;
  pendingClient?: Client;
  disconnected?: boolean;
}

/**
 * Owns SSH TCP connections independently from individual command channels.
 * A server has at most one connecting/connected client at any time; callers
 * create their own exec, SFTP, or PTY channels on that client.
 */
export class SshConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();

  constructor(private readonly onStatusChange?: (status: SshConnectionStatus) => void) {}

  getStatus(serverId: string): SshConnectionStatus {
    const connection = this.connections.get(serverId);
    return connection
      ? this.toStatus(connection)
      : { serverId, state: 'disconnected', updatedAt: Date.now() };
  }

  listStatuses(): SshConnectionStatus[] {
    return Array.from(this.connections.values()).map((connection) => this.toStatus(connection));
  }

  acquire(serverId: string, createClient: () => Client, timeoutMs = 15_000): Promise<Client> {
    const existing = this.connections.get(serverId);
    if (existing?.client) return Promise.resolve(existing.client);
    if (existing?.pending) return existing.pending;

    const entry: ManagedConnection = {
      serverId,
      state: 'connecting',
      updatedAt: Date.now(),
    };
    this.connections.set(serverId, entry);
    this.notify(entry);

    let client: Client;
    try {
      client = createClient();
      entry.pendingClient = client;
    } catch (error) {
      this.fail(entry, error);
      return Promise.reject(error);
    }

    entry.pending = new Promise<Client>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.removeListener('ready', onReady);
        client.removeListener('error', onConnectError);
        client.removeListener('close', onCloseBeforeReady);
        entry.pending = undefined;
        entry.pendingClient = undefined;
        if (error) {
          if (entry.disconnected) {
            reject(error);
            return;
          }
          this.fail(entry, error);
          reject(error);
          return;
        }
        entry.client = client;
        entry.state = 'connected';
        entry.error = undefined;
        entry.updatedAt = Date.now();
        this.notify(entry);
        this.bindLifecycle(entry, client);
        resolve(client);
      };
      const onReady = () => finish();
      const onConnectError = (error: Error) => finish(error);
      const onCloseBeforeReady = () => finish(new Error('SSH \u8fde\u63a5\u5df2\u5173\u95ed'));
      const timeout = setTimeout(() => {
        client.destroy();
        finish(new Error('SSH ���ӳ�ʱ'));
      }, timeoutMs);
      client.once('ready', onReady);
      client.once('error', onConnectError);
      client.once('close', onCloseBeforeReady);
    });

    return entry.pending;
  }

  disconnect(serverId: string): void {
    const entry = this.connections.get(serverId);
    if (!entry) return;
    this.connections.delete(serverId);
    entry.disconnected = true;
    entry.pending = undefined;
    entry.pendingClient?.destroy();
    entry.pendingClient = undefined;
    entry.client?.end();
    entry.client?.removeAllListeners();
    entry.state = 'disconnected';
    entry.updatedAt = Date.now();
    this.notify(entry);
  }

  shutdown(): void {
    for (const serverId of Array.from(this.connections.keys())) this.disconnect(serverId);
  }

  private bindLifecycle(entry: ManagedConnection, client: Client): void {
    const invalidate = (error?: Error) => {
      if (this.connections.get(entry.serverId)?.client !== client) return;
      this.connections.delete(entry.serverId);
      entry.client = undefined;
      entry.state = error ? 'failed' : 'disconnected';
      entry.error = error?.message;
      entry.updatedAt = Date.now();
      this.notify(entry);
    };
    client.once('error', (error) => invalidate(error));
    client.once('close', () => invalidate());
  }

  private fail(entry: ManagedConnection, error: unknown): void {
    if (this.connections.get(entry.serverId) === entry) this.connections.delete(entry.serverId);
    entry.client = undefined;
    entry.pending = undefined;
    entry.state = 'failed';
    entry.error = error instanceof Error ? error.message : String(error);
    entry.updatedAt = Date.now();
    this.notify(entry);
  }

  private notify(connection: ManagedConnection): void {
    this.onStatusChange?.(this.toStatus(connection));
  }

  private toStatus(connection: ManagedConnection): SshConnectionStatus {
    return {
      serverId: connection.serverId,
      state: connection.state,
      updatedAt: connection.updatedAt,
      ...(connection.error ? { error: connection.error } : {}),
    };
  }
}
