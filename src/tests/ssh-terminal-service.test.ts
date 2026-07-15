import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

import { SshTerminalService, type SshTerminalEvent } from '../main/ssh/ssh-terminal-service';
import type { SshService } from '../main/ssh/ssh-service';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  writes: string[] = [];
  write = vi.fn((value: string) => { this.writes.push(value); });
  close = vi.fn(() => this.emit('close'));
  setWindow = vi.fn();
}

class FakeClient extends EventEmitter {
  channels: FakeChannel[] = [];
  get channel(): FakeChannel { return this.channels[0]!; }
  shell = vi.fn((_options, callback: (error: Error | undefined, channel: FakeChannel) => void) => {
    const channel = new FakeChannel();
    this.channels.push(channel);
    callback(undefined, channel);
  });
}

function completeCommand(channel: FakeChannel, output: string, exitCode = 0): void {
  const payload = channel.writes.at(-1) ?? '';
  const token = payload.match(/OpenCoworkStart=([a-f0-9]+)/)?.[1];
  if (!token) throw new Error('missing command token');
  channel.emit('data', Buffer.from(`\x1b]777;OpenCoworkStart=${token}\x07${output}\r\n\x1b]777;OpenCoworkEnd=${token};${exitCode}\x07`));
}

describe('SshTerminalService', () => {
  it('reuses one visible PTY for consecutive agent commands', async () => {
    const client = new FakeClient();
    const events: SshTerminalEvent[] = [];
    const ssh = {
      acquireTerminalConnection: vi.fn(async () => client),
      listServers: vi.fn(() => [{ id: 'server-1', name: 'prod', defaultCwd: null }]),
    } as unknown as SshService;
    const terminals = new SshTerminalService(ssh, (event) => events.push(event));

    const first = terminals.executeAgentCommand({ sessionId: 'session-1', serverId: 'server-1', command: 'cd /home' });
    await vi.waitFor(() => expect(client.channel.write).toHaveBeenCalledTimes(1));
    completeCommand(client.channel, '');
    await expect(first).resolves.toMatchObject({ exitCode: 0 });

    const second = terminals.executeAgentCommand({ sessionId: 'session-1', serverId: 'server-1', command: 'pwd' });
    await vi.waitFor(() => expect(client.channel.write).toHaveBeenCalledTimes(2));
    completeCommand(client.channel, '/home');
    await expect(second).resolves.toMatchObject({ output: '/home', exitCode: 0 });

    expect(client.shell).toHaveBeenCalledTimes(1);
    expect(ssh.acquireTerminalConnection).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.kind === 'agent' && event.type === 'opened' && event.sessionId === 'session-1')).toBe(true);
  });

  it('creates, lists, targets, and removes multiple agent terminals in one session', async () => {
    const client = new FakeClient();
    const ssh = {
      acquireTerminalConnection: vi.fn(async () => client),
      listServers: vi.fn(() => [{ id: 'server-1', name: 'prod', defaultCwd: null }]),
    } as unknown as SshService;
    const terminals = new SshTerminalService(ssh, () => undefined);

    const first = await terminals.openAgentTerminal('session-1', 'server-1');
    const second = await terminals.openAgentTerminal('session-1', 'server-1');

    expect(terminals.listAgentTerminals('session-1')).toEqual([first, second]);
    expect(client.shell).toHaveBeenCalledTimes(2);

    const execution = terminals.executeAgentCommand({ sessionId: 'session-1', serverId: 'server-1', terminalId: second.terminalId, command: 'pwd' });
    await vi.waitFor(() => expect(client.channels[1]!.write).toHaveBeenCalledTimes(1));
    completeCommand(client.channels[1]!, '/tmp');
    await expect(execution).resolves.toMatchObject({ terminalId: second.terminalId, output: '/tmp' });

    terminals.closeAgentTerminal('session-1', first.terminalId);
    expect(terminals.listAgentTerminals('session-1')).toEqual([second]);
    expect(() => terminals.closeAgentTerminal('session-2', second.terminalId)).toThrow('不属于当前会话');
  });
});
