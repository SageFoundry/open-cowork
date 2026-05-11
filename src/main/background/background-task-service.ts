import { app, shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, existsSync, readFile, readFileSync, watchFile, unwatchFile, writeFileSync, appendFileSync } from 'node:fs';
import { join, delimiter as pathDelimiter } from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type {
  BackgroundTask,
  BackgroundTaskLogChunk,
  BackgroundTaskStartInput,
  ServerEvent,
} from '../../renderer/types';
import type { BackgroundTaskRow, DatabaseInstance } from '../db/database';
import { logWarn } from '../utils/logger';
import { detectGitBash } from '../tools/windows-bash-executor';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { resolvePythonFromPath } from '../runtime/runtime-resolver';

interface BackgroundTaskServiceOptions {
  watchIntervalMs?: number;
  reconcileIntervalMs?: number;
}

interface RunningTaskState {
  watcherAttached: boolean;
  lastSize: number;
  urlDetected: boolean;
}

const LOCAL_URL_REGEX =
  /\b((?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})?(?:\/[^\s]*)?)\b/i;

function normalizeTaskRow(row: BackgroundTaskRow): BackgroundTask {
  let args: string[] = [];
  try {
    const parsed = JSON.parse(row.args_json) as unknown;
    if (Array.isArray(parsed)) {
      args = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    args = [];
  }

  return {
    id: row.id,
    title: row.title,
    command: row.command,
    args,
    cwd: row.cwd,
    status: row.status as BackgroundTask['status'],
    pid: row.pid,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    logPath: row.log_path,
    ...(row.detected_url ? { detectedUrl: row.detected_url } : {}),
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deriveTaskTitle(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return 'Background Task';
  }
  const normalized = trimmed.replace(/\s+/g, ' ');
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

function execFileAsync(
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout?: number; stdio?: 'ignore' }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options as Parameters<typeof execFile>[2], (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(typeof stdout === 'string' ? stdout.trim() : String(stdout ?? '').trim());
      }
    });
  });
}

function detectUrl(text: string): string | null {
  const match = LOCAL_URL_REGEX.exec(text);
  if (!match?.[1]) {
    return null;
  }
  const candidate = match[1];
  return /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
}

function findShellBackgroundOperator(command: string): number {
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char !== '&') {
      continue;
    }

    const previous = command[i - 1] || '';
    const next = command[i + 1] || '';
    if (previous === '&' || next === '&' || previous === '>' || next === '>') {
      continue;
    }

    return i;
  }

  return -1;
}

function normalizeDetachedCommand(command: string): string {
  const normalized = command.replace(/\r\n?/g, '\n').trim();
  const ampIndex = findShellBackgroundOperator(normalized);
  if (ampIndex === -1) {
    return normalized;
  }

  const backgroundCommand = normalized.slice(0, ampIndex).trim();
  const trailingCommand = normalized.slice(ampIndex + 1).trim();
  if (!trailingCommand || /^;?\s*disown\b/i.test(trailingCommand)) {
    return backgroundCommand;
  }

  return normalized;
}

export class BackgroundTaskService {
  private readonly db: DatabaseInstance;
  private readonly sendToRenderer: (event: ServerEvent) => void;
  private readonly watchIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly logsDir: string;
  private readonly runningTasks = new Map<string, RunningTaskState>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: DatabaseInstance,
    sendToRenderer: (event: ServerEvent) => void,
    options: BackgroundTaskServiceOptions = {}
  ) {
    this.db = db;
    this.sendToRenderer = sendToRenderer;
    this.watchIntervalMs = options.watchIntervalMs ?? 250;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5000;
    this.logsDir = this.ensureLogsDir();
  }

  initialize(): void {
    void this.reconcileTasks(true);
    this.reconcileTimer = setInterval(() => {
      void this.reconcileTasks(false);
    }, this.reconcileIntervalMs);
  }

  async shutdown(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    const activeTasks = this.listTasks().filter(
      (task) =>
        task.pid &&
        (task.status === 'queued' ||
          task.status === 'starting' ||
          task.status === 'running' ||
          task.status === 'stopping')
    );
    await Promise.allSettled(activeTasks.map((task) => this.stopTask(task.id)));

    for (const taskId of this.runningTasks.keys()) {
      this.detachLogWatcher(taskId);
    }
  }

  listTasks(): BackgroundTask[] {
    return this.db.backgroundTasks.getAll().map(normalizeTaskRow);
  }

  async startTask(input: BackgroundTaskStartInput): Promise<BackgroundTask> {
    const command = normalizeDetachedCommand(input.command);
    if (!command) {
      throw new Error('Command is required');
    }
    if (!input.cwd?.trim()) {
      throw new Error('Working directory is required');
    }

    const now = Date.now();
    const id = uuidv4();
    const logPath = join(this.logsDir, `${id}.log`);
    const title = input.title?.trim() || deriveTaskTitle(command);
    const baseRow: BackgroundTaskRow = {
      id,
      title,
      command,
      args_json: '[]',
      cwd: input.cwd,
      status: 'starting',
      pid: null,
      started_at: now,
      ended_at: null,
      exit_code: null,
      log_path: logPath,
      detected_url: null,
      source_session_id: input.sourceSessionId || null,
      created_at: now,
      updated_at: now,
    };
    this.db.backgroundTasks.create(baseRow);

    try {
      const child = this.spawnDetached(command, input.cwd);
      const runningTask = this.persistTaskUpdate(id, {
        status: 'running',
        pid: child.pid ?? null,
      });

      // Pipe stdout/stderr to the log file. On Windows, raw file descriptors
      // passed to spawn stdio do not reliably work; use pipe mode and manually
      // append to the log file.
      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          appendFileSync(logPath, chunk);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          appendFileSync(logPath, chunk);
        });
      }

      child.unref();
      this.attachLogWatcher(runningTask);
      this.emitTaskUpdate(runningTask);

      return runningTask;
    } catch (error) {
      const failedTask = this.persistTaskUpdate(id, {
        status: 'failed',
        ended_at: Date.now(),
        exit_code: 1,
      });
      this.emitTaskUpdate(failedTask);
      throw error;
    }
  }

  async stopTask(taskId: string): Promise<BackgroundTask | null> {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    if (!task.pid || ['completed', 'failed', 'lost'].includes(task.status)) {
      return task;
    }

    let updated = this.persistTaskUpdate(taskId, { status: 'stopping' });
    this.emitTaskUpdate(updated);

    const stoppedGracefully = await this.terminateProcess(task.pid);
    if (!stoppedGracefully) {
      await this.forceKillProcess(task.pid);
    }

    const alive = await this.isProcessAlive(task.pid, task.command);
    const finalStatus = alive ? 'lost' : 'completed';
    updated = this.persistTaskUpdate(taskId, {
      status: finalStatus,
      ended_at: Date.now(),
      exit_code: finalStatus === 'completed' ? 0 : null,
    });
    this.detachLogWatcher(taskId);
    this.emitTaskUpdate(updated);
    return updated;
  }

  getTask(taskId: string): BackgroundTask | null {
    const row = this.db.backgroundTasks.get(taskId);
    return row ? normalizeTaskRow(row) : null;
  }

  getLogTail(taskId: string, maxChars = 8000): string {
    const task = this.getTask(taskId);
    if (!task) {
      return '';
    }
    if (!existsSync(task.logPath)) {
      return '';
    }

    const content = readFileSync(task.logPath, 'utf8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  }

  async openLog(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    if (!task) {
      return false;
    }
    const result = await shell.openPath(task.logPath);
    return result === '';
  }

  async openDetectedUrl(taskId: string): Promise<boolean> {
    const task = this.getTask(taskId);
    if (!task?.detectedUrl) {
      return false;
    }
    await shell.openExternal(task.detectedUrl);
    return true;
  }

  async waitForPort(taskId: string, port: number, timeoutMs = 10000): Promise<boolean> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.getTask(taskId);
      if (!task) {
        return false;
      }
      if (task.status === 'failed' || task.status === 'lost' || task.status === 'completed') {
        return false;
      }

      const ready = await this.checkPortReady(port);
      if (ready) {
        if (!task.detectedUrl) {
          const updated = this.persistTaskUpdate(taskId, {
            detected_url: `http://localhost:${port}`,
          });
          this.emitTaskUpdate(updated);
        }
        return true;
      }
      await this.delay(250);
    }
    return false;
  }

  private ensureLogsDir(): string {
    const dir = join(app.getPath('userData'), 'logs', 'background-tasks');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private spawnDetached(command: string, cwd: string) {
    if (process.platform === 'win32') {
      const sandbox = getSandboxAdapter();
      const gitBashPath = detectGitBash();
      const resolvedPython = resolvePythonFromPath();
      const resolvedPythonDir = resolvedPython
        ? resolvedPython.path.replace(/[\\/][^\\/]+$/, '')
        : null;

      const windowsEncodingEnv = {
        PYTHONIOENCODING: 'utf-8' as const,
        PYTHONUTF8: '1' as const,
        LANG: 'en_US.UTF-8' as const,
        LC_ALL: 'en_US.UTF-8' as const,
      };

      if (sandbox.isWSL && sandbox.wslStatus?.distro) {
        return spawn(
          'wsl',
          ['-d', sandbox.wslStatus.distro, '--', 'bash', '-lc', command],
          {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, OPEN_COWORK_BASH_BACKEND: 'wsl', ...windowsEncodingEnv },
          }
        );
      }

      if (gitBashPath) {
        const scriptPath = join(
          os.tmpdir(),
          `oc-git-bash-bg-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`
        );
        const normalizedCwd = cwd.replace(/\\/g, '/');
        const cmdBase64 = Buffer.from(command, 'utf-8').toString('base64');
        const scriptBody = [
          '#!/usr/bin/env bash',
          "trap 'rm -f -- \"$0\"' EXIT",
          'export PYTHONIOENCODING=utf-8',
          'export PYTHONUTF8=1',
          'export LANG=en_US.UTF-8',
          'export LC_ALL=en_US.UTF-8',
          resolvedPythonDir ? `export PATH='${resolvedPythonDir.replace(/'/g, `"'"'`)}':"$PATH"` : '',
          `cd '${normalizedCwd.replace(/'/g, `"'"'`)}'`,
          `eval "$(printf '%s' '${cmdBase64}' | base64 -d)"`,
          '',
        ].join('\n');
        writeFileSync(scriptPath, scriptBody, 'utf8');
        return spawn(gitBashPath, ['--noprofile', '--norc', scriptPath], {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            OPEN_COWORK_BASH_BACKEND: 'git-bash',
            MSYS2_ARG_CONV_EXCL: '*',
            ...(resolvedPythonDir
              ? {
                  PATH: `${resolvedPythonDir}${pathDelimiter}${process.env.PATH || ''}`,
                }
              : {}),
            ...windowsEncodingEnv,
          },
        });
      }

      return spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        {
          cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, ...windowsEncodingEnv },
        }
      );
    }

    return spawn('/bin/bash', ['-lc', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  }

  private attachLogWatcher(task: BackgroundTask): void {
    if (this.runningTasks.get(task.id)?.watcherAttached) {
      return;
    }

    if (existsSync(task.logPath)) {
      readFile(task.logPath, 'utf8', (_err, data) => {
        const content = data || '';
        this.handleInitialLogContent(task, content);
      });
    } else {
      this.finalizeLogWatcherAttach(task, '', false);
    }
  }

  private handleInitialLogContent(task: BackgroundTask, content: string): void {
    let knownTask = task;
    if (!task.detectedUrl && content) {
      const detectedUrl = detectUrl(content);
      if (detectedUrl) {
        knownTask = this.persistTaskUpdate(task.id, {
          detected_url: detectedUrl,
        });
        this.emitTaskUpdate(knownTask);
      }
    }
    this.finalizeLogWatcherAttach(knownTask, content, Boolean(knownTask.detectedUrl));
  }

  private finalizeLogWatcherAttach(
    task: BackgroundTask,
    initialContent: string,
    urlDetected: boolean
  ): void {
    this.runningTasks.set(task.id, {
      watcherAttached: true,
      lastSize: initialContent.length,
      urlDetected,
    });

    watchFile(
      task.logPath,
      { interval: this.watchIntervalMs, persistent: false },
      (current, previous) => {
        if (current.size <= previous.size) {
          return;
        }
        const state = this.runningTasks.get(task.id);
        if (!state) {
          return;
        }
        const nextContent = readFileSync(task.logPath, 'utf8');
        const chunk = nextContent.slice(state.lastSize);
        state.lastSize = nextContent.length;
        if (!chunk) {
          return;
        }

        if (!state.urlDetected) {
          const detectedUrl = detectUrl(chunk);
          if (detectedUrl) {
            state.urlDetected = true;
            const updatedTask = this.persistTaskUpdate(task.id, {
              detected_url: detectedUrl,
            });
            this.emitTaskUpdate(updatedTask);
          }
        }

        const payload: BackgroundTaskLogChunk = {
          taskId: task.id,
          stream: 'stdout',
          text: chunk,
          timestamp: Date.now(),
        };
        this.sendToRenderer({ type: 'tasks.logAppended', payload });
      }
    );
  }

  private detachLogWatcher(taskId: string): void {
    const task = this.getTask(taskId);
    if (task) {
      unwatchFile(task.logPath);
    }
    this.runningTasks.delete(taskId);
  }

  private emitTaskUpdate(task: BackgroundTask): void {
    this.sendToRenderer({
      type: 'tasks.updated',
      payload: { task },
    });
  }

  private async reconcileTasks(emitForHealthyTasks: boolean): Promise<void> {
    const tasks = this.db.backgroundTasks.getAll().map(normalizeTaskRow);
    for (const task of tasks) {
      const shouldTrack =
        task.status === 'running' || task.status === 'starting' || task.status === 'stopping';
      if (!shouldTrack || !task.pid) {
        continue;
      }

      if (await this.isProcessAlive(task.pid, task.command)) {
        this.attachLogWatcher(task);
        if (emitForHealthyTasks) {
          this.emitTaskUpdate(task);
        }
        continue;
      }

      const nextStatus = task.status === 'stopping' ? 'completed' : 'lost';
      const updated = this.persistTaskUpdate(task.id, {
        status: nextStatus,
        ended_at: task.endedAt ?? Date.now(),
      });
      this.detachLogWatcher(task.id);
      this.emitTaskUpdate(updated);
    }
  }

  private persistTaskUpdate(taskId: string, updates: Partial<BackgroundTaskRow>): BackgroundTask {
    this.db.backgroundTasks.update(taskId, updates);
    const updated = this.db.backgroundTasks.get(taskId);
    if (!updated) {
      throw new Error(`Background task missing after update: ${taskId}`);
    }
    return normalizeTaskRow(updated);
  }

  private async isProcessAlive(pid: number, command: string): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        const output = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty ProcessId)`,
          ],
          { encoding: 'utf8', timeout: 3000 }
        );
        if (!output?.trim()) {
          return false;
        }
        // On Windows, spawned tasks run inside git-bash.exe / powershell.exe wrappers,
        // so the wrapper's command line never contains the user's original command.
        // Just confirm the pid is alive — we use taskkill /T to stop child trees.
        return true;
      }

      const output = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (!output) {
        return false;
      }
      if (!command.trim()) {
        return true;
      }
      const commandPrefix = command.trim().split(/\s+/)[0];
      return output.includes(commandPrefix);
    } catch {
      return false;
    }
  }

  private async terminateProcess(pid: number): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T'], { encoding: 'utf8', timeout: 4000, stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGTERM');
      }
    } catch (error) {
      logWarn('[BackgroundTaskService] Graceful stop failed:', error);
    }

    await this.delay(1200);
    return !(await this.isProcessAlive(pid, ''));
  }

  private async forceKillProcess(pid: number): Promise<void> {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 4000, stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (error) {
      logWarn('[BackgroundTaskService] Force kill failed:', error);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async checkPortReady(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(1000);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }
}

export { detectUrl, deriveTaskTitle, normalizeTaskRow };
