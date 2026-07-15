import { describe, expect, it, vi } from 'vitest';
import { SshMcpProvider } from '../main/mcp/providers/ssh-mcp-provider';
import type { SshService } from '../main/ssh/ssh-service';

describe('SshMcpProvider foreground terminals', () => {
  it('exposes live terminal management tools and targets a selected terminal', async () => {
    const service = {
      listSessionGrants: vi.fn(() => [{ id: 'server-1', name: 'prod', permission: 'execute', executionMode: 'foreground' }]),
      listForegroundTerminals: vi.fn(() => [{ terminalId: 'terminal-1', serverId: 'server-1', serverName: 'prod' }]),
      openForegroundTerminal: vi.fn(async () => ({ terminalId: 'terminal-2', serverId: 'server-1', serverName: 'prod' })),
      closeForegroundTerminal: vi.fn(),
      execForeground: vi.fn(async () => ({ terminalId: 'terminal-2', output: '/home', exitCode: 0 })),
    } as unknown as SshService;
    const provider = new SshMcpProvider(service, () => false);
    const tools = provider.getTools('session-1');
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const execute = (name: string, ...args: unknown[]) => (byName.get(name)!.execute as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args);

    expect([...byName.keys()]).toEqual(expect.arrayContaining(['ssh_list_terminals', 'ssh_open_terminal', 'ssh_close_terminal', 'ssh_exec']));

    await execute('ssh_list_terminals', 'call-1', {});
    await execute('ssh_open_terminal', 'call-2', { serverId: 'server-1' });
    await execute('ssh_close_terminal', 'call-3', { terminalId: 'terminal-1' });
    await execute('ssh_exec', 'call-4', { serverId: 'server-1', terminalId: 'terminal-2', command: 'pwd' });

    expect(service.openForegroundTerminal).toHaveBeenCalledWith('session-1', 'server-1');
    expect(service.closeForegroundTerminal).toHaveBeenCalledWith('session-1', 'terminal-1');
    expect(service.execForeground).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', terminalId: 'terminal-2', command: 'pwd' }));
  });
});
