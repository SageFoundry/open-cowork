import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { SshService } from '../../ssh/ssh-service';
import type { SshAuthorizationBroker } from '../../ssh/ssh-authorization-broker';

/**
 * Built-in MCP-style provider for SSH assets. It intentionally lives in the
 * main process: external MCP transports must never receive SSH credentials or
 * own the application's shared connection pool.
 */
export class SshMcpProvider {
  readonly id = 'builtin-ssh';

  constructor(
    private readonly service: SshService,
    private readonly isPlanMode: (sessionId: string) => boolean,
    private readonly authorizationBroker?: SshAuthorizationBroker
  ) {}

  getTools(sessionId: string): ToolDefinition[] {
    const ensureAuthorized = async () => {
      if (this.service.listSessionGrants(sessionId).length > 0) return;
      if (this.authorizationBroker) await this.authorizationBroker.request(sessionId);
      else await this.service.requestAuthorization(sessionId);
      if (!this.service.listSessionGrants(sessionId).length) throw new Error('当前会话未授权 SSH 服务器资源');
    };
    const listTool: ToolDefinition = {
      name: 'ssh_list_servers',
      label: 'List Authorized SSH Servers',
      description: 'List only SSH resources explicitly authorized for the current session. Credentials are never included.',
      parameters: Type.Object({}),
      execute: async () => {
        await ensureAuthorized();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(this.service.listSessionGrants(sessionId).map(({ id, name, tags, permission, executionMode }) => ({ id, name, tags, permission, executionMode })), null, 2) }],
          details: undefined as unknown,
        };
      },
    };
    const listDirectoryTool: ToolDefinition = {
      name: 'ssh_list_directory',
      label: 'List SSH Directory',
      description: 'List a remote directory on an authorized SSH resource. This is a structured read-only operation.',
      parameters: Type.Object({ serverId: Type.String({ description: 'Authorized server ID from ssh_list_servers' }), path: Type.String({ description: 'Absolute remote directory path' }) }),
      execute: async (_toolCallId, params: { serverId: string; path: string }) => {
        await ensureAuthorized();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(await this.service.listDirectory({ sessionId, ...params }), null, 2) }],
          details: undefined as unknown,
        };
      },
    };
    const readFileTool: ToolDefinition = {
      name: 'ssh_read_file',
      label: 'Read SSH File',
      description: 'Read a bounded range of a remote text file on an authorized SSH resource. This is a structured read-only operation.',
      parameters: Type.Object({
        serverId: Type.String({ description: 'Authorized server ID from ssh_list_servers' }),
        path: Type.String({ description: 'Absolute remote file path' }),
        offset: Type.Optional(Type.Number({ description: 'Byte offset, default 0' })),
        limit: Type.Optional(Type.Number({ description: 'Maximum bytes to read, up to 262144' })),
      }),
      execute: async (_toolCallId, params: { serverId: string; path: string; offset?: number; limit?: number }) => {
        await ensureAuthorized();
        const result = await this.service.readFile({ sessionId, ...params });
        return { content: [{ type: 'text' as const, text: result.content }], details: { path: result.path, offset: result.offset, bytesRead: result.bytesRead, truncated: result.truncated } };
      },
    };
    const execTool: ToolDefinition = {
      name: 'ssh_exec',
      label: 'Execute in Visible SSH Terminal',
      description: 'Execute a command in the persistent, user-visible SSH terminal authorized for this session. Shell state such as cwd and exported variables is preserved across calls.',
      parameters: Type.Object({
        serverId: Type.String({ description: 'Authorized server ID from ssh_list_servers' }),
        terminalId: Type.Optional(Type.String({ description: 'Optional visible terminal ID from ssh_list_terminals. Omit to use the default terminal for this server.' })),
        command: Type.String({ description: 'Remote shell command to type into the visible terminal' }),
        timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds, maximum 600' })),
      }),
      execute: async (_toolCallId, params: { serverId: string; terminalId?: string; command: string; timeout?: number }, signal) => {
        await ensureAuthorized();
        if (this.isPlanMode(sessionId)) throw new Error('Plan mode does not allow remote SSH command execution.');
        const result = await this.service.execForeground({ sessionId, serverId: params.serverId, terminalId: params.terminalId, command: params.command, timeoutSeconds: params.timeout, signal });
        return { content: [{ type: 'text' as const, text: `exit code: ${result.exitCode ?? 'unknown'}\n${result.output || '(无输出)'}` }], details: { terminalId: result.terminalId, exitCode: result.exitCode } };
      },
    };
    const listTerminalsTool: ToolDefinition = {
      name: 'ssh_list_terminals',
      label: 'List Visible SSH Terminals',
      description: 'List the currently open visible SSH terminal windows for this session. The list is live and reflects windows the user closes.',
      parameters: Type.Object({}),
      execute: async () => {
        await ensureAuthorized();
        return { content: [{ type: 'text' as const, text: JSON.stringify(this.service.listForegroundTerminals(sessionId), null, 2) }], details: undefined as unknown };
      },
    };
    const openTerminalTool: ToolDefinition = {
      name: 'ssh_open_terminal',
      label: 'Open Visible SSH Terminal',
      description: 'Open a new visible, persistent SSH terminal window for an authorized server. Use ssh_list_terminals and terminalId to manage multiple independent shell states.',
      parameters: Type.Object({ serverId: Type.String({ description: 'Authorized server ID from ssh_list_servers' }) }),
      execute: async (_toolCallId, params: { serverId: string }) => {
        await ensureAuthorized();
        if (this.isPlanMode(sessionId)) throw new Error('Plan mode does not allow opening remote SSH terminals.');
        const terminal = await this.service.openForegroundTerminal(sessionId, params.serverId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(terminal, null, 2) }], details: terminal };
      },
    };
    const closeTerminalTool: ToolDefinition = {
      name: 'ssh_close_terminal',
      label: 'Close Visible SSH Terminal',
      description: 'Close one visible SSH terminal window owned by the current session.',
      parameters: Type.Object({ terminalId: Type.String({ description: 'Terminal ID from ssh_list_terminals' }) }),
      execute: async (_toolCallId, params: { terminalId: string }) => {
        this.service.closeForegroundTerminal(sessionId, params.terminalId);
        return { content: [{ type: 'text' as const, text: 'Terminal closed.' }], details: undefined as unknown };
      },
    };
    const backgroundExecTool: ToolDefinition = {
      name: 'ssh_exec_background',
      label: 'Execute SSH Command in Background',
      description: 'Execute an isolated non-interactive SSH command for background or batch work. Each call has independent shell state.',
      parameters: Type.Object({
        serverId: Type.String({ description: 'Authorized server ID from ssh_list_servers' }),
        command: Type.String({ description: 'Remote shell command to execute independently' }),
        cwd: Type.Optional(Type.String({ description: 'Optional remote working directory' })),
        timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds, maximum 600' })),
      }),
      execute: async (_toolCallId, params: { serverId: string; command: string; cwd?: string; timeout?: number }, signal) => {
        await ensureAuthorized();
        if (this.isPlanMode(sessionId)) throw new Error('Plan mode does not allow remote SSH command execution.');
        const result = await this.service.exec({ sessionId, serverId: params.serverId, command: params.command, cwd: params.cwd, timeoutSeconds: params.timeout, signal });
        const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : '', result.truncated ? '\n[输出已截断]' : ''].filter(Boolean).join('\n');
        return { content: [{ type: 'text' as const, text: `exit code: ${result.exitCode ?? 'unknown'}\n${output || '(无输出)'}` }], details: { executionId: result.executionId, exitCode: result.exitCode, truncated: result.truncated } };
      },
    };
    return [listTool, listDirectoryTool, readFileTool, listTerminalsTool, openTerminalTool, closeTerminalTool, execTool, backgroundExecTool];
  }
}
