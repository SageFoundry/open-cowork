import type { Client, ClientChannel } from 'ssh2';
import { v4 as uuidv4 } from 'uuid';
import { SshAbortError, SshTimeoutError, type SshForegroundExecutionResult, type SshService } from './ssh-service';

export interface SshTerminalEvent {
  terminalId: string;
  serverId: string;
  serverName?: string;
  sessionId?: string;
  kind: 'user' | 'agent';
  type: 'opened' | 'data' | 'closed' | 'error';
  text?: string;
  error?: string;
}

export interface SshAgentTerminal {
  terminalId: string;
  serverId: string;
  serverName: string;
}

interface ActiveTerminalCommand {
  token: string;
  startMarker: string;
  endPrefix: string;
  buffer: string;
  started: boolean;
  resolve: (result: SshForegroundExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface TerminalChannel {
  terminalId: string;
  serverId: string;
  serverName: string;
  sessionId?: string;
  kind: 'user' | 'agent';
  channel: ClientChannel;
  commandTail: Promise<void>;
  activeCommand?: ActiveTerminalCommand;
}

export class SshTerminalService {
  private readonly terminals = new Map<string, TerminalChannel>();
  private readonly agentTerminalIdsBySession = new Map<string, Set<string>>();
  private readonly pendingAgentTerminals = new Map<string, Promise<TerminalChannel>>();

  constructor(
    private readonly ssh: SshService,
    private readonly emit: (event: SshTerminalEvent) => void
  ) {}

  async open(serverId: string, cols = 100, rows = 30): Promise<string> {
    const terminal = await this.openShell(serverId, 'user', undefined, cols, rows);
    return terminal.terminalId;
  }

  async openAgentTerminal(sessionId: string, serverId: string): Promise<SshAgentTerminal> {
    const terminal = await this.openShell(serverId, 'agent', sessionId, 120, 36);
    return this.toAgentTerminal(terminal);
  }

  listAgentTerminals(sessionId: string): SshAgentTerminal[] {
    return [...(this.agentTerminalIdsBySession.get(sessionId) ?? [])]
      .map((terminalId) => this.terminals.get(terminalId))
      .filter((terminal): terminal is TerminalChannel => Boolean(terminal))
      .map((terminal) => this.toAgentTerminal(terminal));
  }

  closeAgentTerminal(sessionId: string, terminalId: string): void {
    const terminal = this.requireAgentTerminal(sessionId, terminalId);
    this.close(terminal.terminalId);
  }

  async executeAgentCommand(input: { sessionId: string; serverId: string; terminalId?: string; command: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<SshForegroundExecutionResult> {
    const terminal = input.terminalId
      ? this.requireAgentTerminal(input.sessionId, input.terminalId, input.serverId)
      : await this.ensureAgentTerminal(input.sessionId, input.serverId);
    const operation = terminal.commandTail.then(() => this.runAgentCommand(terminal, input));
    terminal.commandTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  write(terminalId: string, text: string): void {
    this.requireTerminal(terminalId).channel.write(text);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.requireTerminal(terminalId).channel.setWindow(this.bound(rows, 5, 200), this.bound(cols, 20, 400), 0, 0);
  }

  close(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    this.rejectActiveCommand(terminal, new SshAbortError('SSH 终端已关闭'));
    this.removeTerminal(terminal);
    terminal.channel.close();
  }

  closeByServer(serverId: string): void {
    for (const terminal of [...this.terminals.values()]) if (terminal.serverId === serverId) this.close(terminal.terminalId);
  }

  closeBySession(sessionId: string): void {
    for (const terminal of [...this.terminals.values()]) if (terminal.sessionId === sessionId) this.close(terminal.terminalId);
  }

  shutdown(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private async ensureAgentTerminal(sessionId: string, serverId: string): Promise<TerminalChannel> {
    const key = this.agentKey(sessionId, serverId);
    const existing = this.listAgentTerminals(sessionId)
      .filter((terminal) => terminal.serverId === serverId)
      .map((terminal) => this.terminals.get(terminal.terminalId))
      .find((terminal): terminal is TerminalChannel => Boolean(terminal));
    if (existing) return existing;
    const pending = this.pendingAgentTerminals.get(key);
    if (pending) return pending;
    const opening = this.openShell(serverId, 'agent', sessionId, 120, 36).finally(() => this.pendingAgentTerminals.delete(key));
    this.pendingAgentTerminals.set(key, opening);
    return opening;
  }

  private async openShell(serverId: string, kind: 'user' | 'agent', sessionId: string | undefined, cols: number, rows: number): Promise<TerminalChannel> {
    const client = await this.ssh.acquireTerminalConnection(serverId);
    const server = this.ssh.listServers().find((item) => item.id === serverId);
    if (!server) throw new Error('服务器不存在');
    const terminalId = uuidv4();
    return new Promise((resolve, reject) => {
      this.createShell(client, cols, rows, (error, channel) => {
        if (error || !channel) {
          reject(error ?? new Error('无法创建 SSH 终端'));
          return;
        }
        const terminal: TerminalChannel = { terminalId, serverId, serverName: server.name, sessionId, kind, channel, commandTail: Promise.resolve() };
        this.terminals.set(terminalId, terminal);
        if (kind === 'agent' && sessionId) {
          const terminalIds = this.agentTerminalIdsBySession.get(sessionId) ?? new Set<string>();
          terminalIds.add(terminalId);
          this.agentTerminalIdsBySession.set(sessionId, terminalIds);
        }
        channel.on('data', (chunk: Buffer) => this.handleData(terminal, chunk.toString('utf8')));
        channel.stderr.on('data', (chunk: Buffer) => this.handleData(terminal, chunk.toString('utf8')));
        channel.once('error', (channelError: Error) => {
          this.emitTerminal(terminal, 'error', undefined, channelError.message);
          this.rejectActiveCommand(terminal, channelError);
        });
        channel.once('close', () => {
          this.rejectActiveCommand(terminal, new SshAbortError('SSH 终端连接已关闭'));
          this.removeTerminal(terminal);
          this.emitTerminal(terminal, 'closed');
        });
        this.emitTerminal(terminal, 'opened');
        if (kind === 'agent' && server.defaultCwd) channel.write(`cd -- ${this.quote(server.defaultCwd)}\n`);
        resolve(terminal);
      });
    });
  }

  private createShell(client: Client, cols: number, rows: number, callback: (error?: Error, channel?: ClientChannel) => void): void {
    client.shell({ term: 'xterm-256color', cols: this.bound(cols, 20, 400), rows: this.bound(rows, 5, 200) }, (error, channel) => callback(error ?? undefined, channel));
  }

  private runAgentCommand(terminal: TerminalChannel, input: { command: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<SshForegroundExecutionResult> {
    if (input.signal?.aborted) return Promise.reject(new SshAbortError());
    const token = uuidv4().replace(/-/g, '');
    const startMarker = `\x1b]777;OpenCoworkStart=${token}\x07`;
    const endPrefix = `\x1b]777;OpenCoworkEnd=${token};`;
    return new Promise((resolve, reject) => {
      const timeoutSeconds = Math.min(Math.max(input.timeoutSeconds ?? 120, 1), 600);
      const command: ActiveTerminalCommand = {
        token,
        startMarker,
        endPrefix,
        buffer: '',
        started: false,
        resolve,
        reject,
        timeout: setTimeout(() => {
          terminal.channel.write('\x03');
          this.finishCommand(terminal, undefined, new SshTimeoutError());
        }, timeoutSeconds * 1000),
        signal: input.signal,
      };
      command.abortListener = () => {
        terminal.channel.write('\x03');
        this.finishCommand(terminal, undefined, new SshAbortError());
      };
      input.signal?.addEventListener('abort', command.abortListener, { once: true });
      terminal.activeCommand = command;
      const payload = [
        `printf '\\033]777;OpenCoworkStart=${token}\\007'`,
        input.command,
        '__open_cowork_exit=$?',
        `printf '\\033]777;OpenCoworkEnd=${token};%s\\007' "$__open_cowork_exit"`,
      ].join('\n');
      terminal.channel.write(`${payload}\n`);
    });
  }

  private handleData(terminal: TerminalChannel, text: string): void {
    this.emitTerminal(terminal, 'data', text);
    const active = terminal.activeCommand;
    if (!active) return;
    active.buffer += text;
    if (!active.started) {
      const startIndex = active.buffer.indexOf(active.startMarker);
      if (startIndex < 0) {
        active.buffer = active.buffer.slice(-Math.max(active.startMarker.length * 2, 512));
        return;
      }
      active.started = true;
      active.buffer = active.buffer.slice(startIndex + active.startMarker.length);
    }
    const endIndex = active.buffer.indexOf(active.endPrefix);
    if (endIndex < 0) return;
    const codeStart = endIndex + active.endPrefix.length;
    const markerEnd = active.buffer.indexOf('\x07', codeStart);
    if (markerEnd < 0) return;
    const exitCodeText = active.buffer.slice(codeStart, markerEnd).trim();
    const parsedExitCode = Number.parseInt(exitCodeText, 10);
    const result: SshForegroundExecutionResult = {
      terminalId: terminal.terminalId,
      output: this.cleanOutput(active.buffer.slice(0, endIndex)),
      exitCode: Number.isFinite(parsedExitCode) ? parsedExitCode : null,
    };
    this.finishCommand(terminal, result);
  }

  private finishCommand(terminal: TerminalChannel, result?: SshForegroundExecutionResult, error?: Error): void {
    const active = terminal.activeCommand;
    if (!active) return;
    terminal.activeCommand = undefined;
    clearTimeout(active.timeout);
    if (active.abortListener) active.signal?.removeEventListener('abort', active.abortListener);
    if (error) active.reject(error);
    else active.resolve(result!);
  }

  private rejectActiveCommand(terminal: TerminalChannel, error: Error): void {
    this.finishCommand(terminal, undefined, error);
  }

  private removeTerminal(terminal: TerminalChannel): void {
    this.terminals.delete(terminal.terminalId);
    if (terminal.kind === 'agent' && terminal.sessionId) {
      const terminalIds = this.agentTerminalIdsBySession.get(terminal.sessionId);
      terminalIds?.delete(terminal.terminalId);
      if (terminalIds?.size === 0) this.agentTerminalIdsBySession.delete(terminal.sessionId);
    }
  }

  private requireAgentTerminal(sessionId: string, terminalId: string, expectedServerId?: string): TerminalChannel {
    const terminal = this.requireTerminal(terminalId);
    if (terminal.kind !== 'agent' || terminal.sessionId !== sessionId) throw new Error('\u524d\u53f0 SSH \u7ec8\u7aef\u4e0d\u5c5e\u4e8e\u5f53\u524d\u4f1a\u8bdd');
    if (expectedServerId && terminal.serverId !== expectedServerId) throw new Error('前台 SSH 终端不属于指定服务器');
    return terminal;
  }

  private toAgentTerminal(terminal: TerminalChannel): SshAgentTerminal {
    return { terminalId: terminal.terminalId, serverId: terminal.serverId, serverName: terminal.serverName };
  }

  private emitTerminal(terminal: TerminalChannel, type: SshTerminalEvent['type'], text?: string, error?: string): void {
    this.emit({ terminalId: terminal.terminalId, serverId: terminal.serverId, serverName: terminal.serverName, sessionId: terminal.sessionId, kind: terminal.kind, type, text, error });
  }

  private requireTerminal(id: string): TerminalChannel {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error('终端已关闭');
    return terminal;
  }

  private agentKey(sessionId: string, serverId: string): string {
    return `${sessionId}:${serverId}`;
  }

  private bound(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.floor(value)));
  }

  private quote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private cleanOutput(value: string): string {
    return value
      .replace(/\x1b\][^\x07]*(?:\x07|$)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '')
      .trim();
  }
}
