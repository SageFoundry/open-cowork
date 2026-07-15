import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
  },
}));

import { SshAbortError, SshService, SshTimeoutError, type SshExecutionEvent } from '../main/ssh/ssh-service';
import type { DatabaseInstance } from '../main/db/database';

type Row = {
  id: string; name: string; host: string; port: number; username: string; auth_type: 'password' | 'privateKey'; credential: Buffer | null;
  host_key_hash: string | null; default_cwd: string | null; tags_json: string; created_at: number; updated_at: number;
};

function createDb(rows: Row[]): DatabaseInstance {
  const servers = new Map(rows.map((row) => [row.id, { ...row }]));
  const grants = new Map<string, { permission: 'read' | 'execute'; execution_mode: 'foreground' | 'background'; granted_at: number }>();
  const raw = {
    prepare(sql: string) {
      return {
        all: (sessionId?: string) => {
          if (sql.includes('JOIN ssh_servers')) return [...grants.entries()].filter(([key]) => key.startsWith(`${sessionId}:`)).map(([key, grant]) => ({ ...servers.get(key.slice(String(sessionId).length + 1))!, ...grant }));
          return [...servers.values()];
        },
        get: (id: string) => servers.get(id),
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO ssh_servers')) {
            const [id, name, host, port, username, authType, credential, hostKey, cwd, tags, createdAt, updatedAt] = args as [string, string, string, number, string, Row['auth_type'], Buffer, string | null, string | null, string, number, number];
            servers.set(id, { id, name, host, port, username, auth_type: authType, credential, host_key_hash: hostKey, default_cwd: cwd, tags_json: tags, created_at: createdAt, updated_at: updatedAt });
          } else if (sql.includes('UPDATE ssh_servers SET host_key_hash')) {
            const [hash, updatedAt, id] = args as [string, number, string]; const row = servers.get(id); if (row) { row.host_key_hash = hash; row.updated_at = updatedAt; }
          } else if (sql.includes('INSERT INTO session_ssh_grants')) {
            const [sessionId, serverId, permission, executionMode, grantedAt] = args as [string, string, 'read' | 'execute', 'foreground' | 'background', number]; grants.set(`${sessionId}:${serverId}`, { permission, execution_mode: executionMode, granted_at: grantedAt });
          } else if (sql.includes('DELETE FROM session_ssh_grants')) grants.delete(`${args[0]}:${args[1]}`);
          return { changes: 1 };
        },
      };
    },
  };
  return { raw } as unknown as DatabaseInstance;
}

class FakeChannel extends EventEmitter { stderr = new EventEmitter(); close = vi.fn(); }
class FakeClient extends EventEmitter {
  destroyed = false;
  end = vi.fn(() => this.emit('close'));
  destroy = vi.fn(() => { this.destroyed = true; this.emit('close'); });
  connect = vi.fn();
  exec = vi.fn((_command: string, callback: (error: Error | undefined, channel: FakeChannel) => void) => callback(undefined, new FakeChannel() as never));
}

const row: Row = { id: 'server-1', name: 'prod', host: '10.0.0.1', port: 22, username: 'root', auth_type: 'password', credential: Buffer.from('encrypted:secret'), host_key_hash: 'a'.repeat(64), default_cwd: null, tags_json: '[]', created_at: 1, updated_at: 1 };

describe('SshService', () => {
  let events: SshExecutionEvent[];
  let service: SshService;
  beforeEach(() => { events = []; service = new SshService(createDb([row]), (event) => events.push(event)); });

  it('requires a new credential when changing authentication types', () => {
    expect(() => service.saveServer({ id: row.id, name: row.name, host: row.host, username: row.username, authType: 'privateKey' })).toThrow('必须提供新的认证凭证');
  });

  it('clears the trusted Host Key when host or port changes', () => {
    const saved = service.saveServer({ id: row.id, name: row.name, host: '10.0.0.2', username: row.username, authType: 'password' });
    expect(saved.hasTrustedHostKey).toBe(false);
  });

  it('only trusts a Host Key after explicit confirmation', () => {
    const untrustedRow = { ...row, id: 'server-2', host_key_hash: null };
    const untrustedService = new SshService(createDb([untrustedRow]), (event) => events.push(event));
    expect(untrustedService.listServers()[0].hasTrustedHostKey).toBe(false);
    untrustedService.trustHostKey(untrustedRow.id, 'b'.repeat(64));
    expect(untrustedService.listServers()[0].hasTrustedHostKey).toBe(true);
  });

  it('does not allow a read-only grant to execute shell commands', async () => {
    service.grantSessionServer('session-1', row.id, 'read');
    await expect(service.exec({ sessionId: 'session-1', serverId: row.id, command: 'id' })).rejects.toThrow('只有只读服务器权限');
  });

  it('rejects invalid resource permissions before persisting a grant', () => {
    expect(() => service.grantResource('session-1', 'ssh-root', 'invalid' as never)).toThrow('无效的服务器权限');
  });

  it('closes the SFTP channel after an operation completes', async () => {
    const client = new FakeClient() as FakeClient & { sftp: ReturnType<typeof vi.fn> };
    const sftp = { end: vi.fn() };
    client.sftp = vi.fn((callback: (error?: Error, channel?: typeof sftp) => void) => callback(undefined, sftp));
    vi.spyOn(service as unknown as { createClient: () => FakeClient }, 'createClient').mockReturnValue(client);

    const operation = (service as unknown as {
      withSftp: (server: Row, callback: (channel: typeof sftp) => Promise<string>) => Promise<string>;
    }).withSftp(row, async () => 'done');
    client.emit('ready');

    await expect(operation).resolves.toBe('done');
    expect(sftp.end).toHaveBeenCalledTimes(1);
  });

  it('returns at most the requested number of file bytes and reports truncation', async () => {
    service.grantSessionServer('session-1', row.id, 'read');
    const createReadStream = vi.fn(() => Readable.from([Buffer.from('abc')]));
    vi.spyOn(service as unknown as {
      withSftp: (server: Row, callback: (channel: { createReadStream: typeof createReadStream }) => Promise<unknown>) => Promise<unknown>;
    }, 'withSftp').mockImplementation(async (_server, callback) => callback({ createReadStream }));

    const result = await service.readFile({ sessionId: 'session-1', serverId: row.id, path: '/tmp/data', limit: 2 });

    expect(createReadStream).toHaveBeenCalledWith('/tmp/data', { start: 0, end: 2 });
    expect(result).toMatchObject({ content: 'ab', bytesRead: 2, truncated: true });
  });

  it('settles an execution immediately when cancelled during connection', async () => {
    service.grantSessionServer('session-1', row.id, 'execute', 'background');
    const client = new FakeClient();
    vi.spyOn(service as unknown as { createClient: () => FakeClient }, 'createClient').mockReturnValue(client);
    const execution = service.exec({ sessionId: 'session-1', serverId: row.id, command: 'sleep 10' });
    const observed = execution.catch((error) => error);
    const started = events.find((event) => event.status === 'connecting')!;
    service.cancelExecution(started.executionId);
    await expect(observed).resolves.toBeInstanceOf(SshAbortError);
    expect(events.at(-1)?.status).toBe('interrupted');
  });

  it('settles an execution with a timeout error', async () => {
    vi.useFakeTimers();
    service.grantSessionServer('session-1', row.id, 'execute', 'background');
    const client = new FakeClient();
    vi.spyOn(service as unknown as { createClient: () => FakeClient }, 'createClient').mockReturnValue(client);
    const execution = service.exec({ sessionId: 'session-1', serverId: row.id, command: 'sleep 10', timeoutSeconds: 1 });
    const observed = execution.catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(observed).resolves.toBeInstanceOf(SshTimeoutError);
    expect(events.at(-1)?.status).toBe('timed_out');
    vi.useRealTimers();
  });
});
