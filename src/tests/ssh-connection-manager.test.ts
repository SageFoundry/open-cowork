import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SshConnectionManager } from '../main/ssh/ssh-connection-manager';

class FakeClient extends EventEmitter {
  end = vi.fn(() => this.emit('close'));
  destroy = vi.fn(() => this.emit('close'));
}

describe('SshConnectionManager', () => {
  it('shares one handshake across concurrent callers and reconnects only after disconnect', async () => {
    const manager = new SshConnectionManager();
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const createClient = vi.fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    const first = manager.acquire('server-1', createClient as never);
    const concurrent = manager.acquire('server-1', createClient as never);
    expect(createClient).toHaveBeenCalledTimes(1);

    firstClient.emit('ready');
    await expect(first).resolves.toBe(firstClient);
    await expect(concurrent).resolves.toBe(firstClient);
    expect(manager.getStatus('server-1').state).toBe('connected');

    manager.disconnect('server-1');
    expect(firstClient.end).toHaveBeenCalledTimes(1);
    expect(manager.getStatus('server-1').state).toBe('disconnected');

    const reconnect = manager.acquire('server-1', createClient as never);
    expect(createClient).toHaveBeenCalledTimes(2);
    secondClient.emit('ready');
    await expect(reconnect).resolves.toBe(secondClient);
  });

  it('destroys a client that is still connecting when disconnected', async () => {
    const manager = new SshConnectionManager();
    const client = new FakeClient();
    const connecting = manager.acquire('server-1', () => client as never);

    const rejected = expect(connecting).rejects.toThrow('SSH 连接已关闭');
    manager.disconnect('server-1');

    expect(client.destroy).toHaveBeenCalledTimes(1);
    await rejected;
    expect(manager.getStatus('server-1').state).toBe('disconnected');
  });
});
