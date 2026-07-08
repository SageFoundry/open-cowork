import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import {
  getRuntimePathEntriesForChildProcess,
  getRuntimePathForChildProcess,
} from '../runtime/runtime-resolver';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import type { ExecutionResult } from '../sandbox/types';
import { log } from '../utils/logger';

/**
 * Convert a Windows path (e.g. "D:/pythonsdk" or "D:\\pythonsdk") to
 * MSYS2/POSIX format (e.g. "/d/pythonsdk") for use in Git Bash's $PATH.
 */
function winPathToMsys2(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[\\/]/, (_match, drive: string) => `/${drive.toLowerCase()}/`)
    .replace(/\\/g, '/');
}

export interface WindowsBashExecutionParams {
  sessionId: string;
  command: string;
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface WindowsBashExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  backend: 'wsl' | 'git-bash';
  timedOut?: boolean;
}

function detectConfiguredBashFromPiSettings(): string | null {
  const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json');

  try {
    if (!fs.existsSync(settingsPath)) {
      return null;
    }

    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { shellPath?: unknown };
    const shellPath = typeof parsed.shellPath === 'string' ? parsed.shellPath.trim() : '';
    if (!shellPath) {
      return null;
    }

    if (fs.existsSync(shellPath)) {
      return shellPath;
    }
  } catch {
    // ignore invalid or unreadable settings
  }

  return null;
}

function detectGitBashFromPath(): string | null {
  const pathValue = process.env.PATH || '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const candidates = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const trimmedEntry = entry.replace(/[\\/]+$/, '');
      return [
        path.resolve(trimmedEntry, 'bash.exe'),
        path.resolve(trimmedEntry, '..', 'bin', 'bash.exe'),
      ];
    })
    .map((candidate) => path.normalize(candidate));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore invalid path candidates
    }
  }

  return null;
}

export function detectGitBash(): string | null {
  const configuredShellPath = detectConfiguredBashFromPiSettings();
  if (configuredShellPath) {
    return configuredShellPath;
  }

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return detectGitBashFromPath();
}

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatExecutionResult(
  result: ExecutionResult,
  backend: 'wsl' | 'git-bash',
  timedOut = false
): WindowsBashExecutionResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    backend,
    timedOut,
  };
}

async function executeViaSandbox(
  command: string,
  cwd: string,
  timeoutMs: number,
  backend: 'wsl',
  signal?: AbortSignal
): Promise<WindowsBashExecutionResult> {
  const sandbox = getSandboxAdapter();

  return await new Promise<WindowsBashExecutionResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (abortHandler) {
        signal?.removeEventListener('abort', abortHandler);
      }
    };

    const finish = (result: WindowsBashExecutionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      finish({
        stdout: '',
        stderr: `Command timed out after ${timeoutMs}ms`,
        exitCode: 124,
        backend,
        timedOut: true,
      });
    }, timeoutMs);

    const abortHandler = signal ? () => fail(new Error('Command aborted')) : undefined;

    if (abortHandler) {
      signal?.addEventListener('abort', abortHandler, { once: true });
    }

    sandbox
      .executeCommand(command, cwd, {
        OPEN_COWORK_BASH_BACKEND: backend,
      })
      .then((result) => {
        const timedOut = !result.success && /timed out|timeout/i.test(result.stderr);
        if (timedOut) {
          log(`[WindowsBashExecutor] ${backend} execution timed out after ${timeoutMs}ms`);
        }
        finish(formatExecutionResult(result, backend, timedOut));
      })
      .catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

/**
 * Kill a process and its entire tree via taskkill on Windows.
 * Falls back to the node process.kill on non-Windows or if taskkill is unavailable.
 */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // best-effort
    }
    return;
  }
  // On Windows, taskkill /F /T kills the process and all descendants.
  const execFile = promisify(_execFile);
  try {
    await execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: 4000,
      windowsHide: true,
      stdio: 'pipe',
    } as any);
  } catch {
    // If taskkill is unavailable, fall back to the node kill.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best-effort
    }
  }
}

async function executeViaGitBash({
  gitBashPath,
  command,
  cwd,
  timeout,
  signal,
  stdin,
}: {
  gitBashPath: string;
  command: string;
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  stdin?: string;
}): Promise<WindowsBashExecutionResult> {
  // Normalize Windows absolute paths in command for Git Bash compatibility,
  // preventing backslashes from being interpreted as escape sequences.
  command = command.replace(/([A-Za-z]:[\\/][^\s"'|;&<>]*)/g, (match) =>
    match.replace(/\\/g, '/')
  );
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const gitBashDir = path.dirname(gitBashPath);
  const enhancedPathEntries = [
    gitBashDir,
    ...getRuntimePathEntriesForChildProcess(),
  ];
  const bashPath = enhancedPathEntries
    .map((entry) => winPathToMsys2(entry))
    .filter(Boolean)
    .join(':');
  const scriptPath = path.join(
    os.tmpdir(),
    `oc-git-bash-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`
  );
  // Base64-encode the command and deliver it via stdin (not argv / script body).
  // MSYS2/Cygwin auto-converts arguments that look like Unix paths, which can
  // corrupt base64 payloads containing byte patterns that match path-like
  // sequences (especially with CJK/non-ASCII content).  Passing the command
  // through stdin bypasses MSYS2 argv conversion entirely.
  const cmdBase64 = Buffer.from(command, 'utf-8').toString('base64');
  const scriptBody = [
    '#!/usr/bin/env bash',
    'export PYTHONIOENCODING=utf-8',
    'export PYTHONUTF8=1',
    'export LANG=en_US.UTF-8',
    'export LC_ALL=en_US.UTF-8',
    bashPath ? `export PATH=${shellEscapeSingleQuoted(bashPath)}:"$PATH"` : '',
    `cd ${shellEscapeSingleQuoted(normalizedCwd)}`,
    'base64 -d | bash',
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, scriptBody, 'utf8');
  log(`[WindowsBashExecutor] Git Bash script: ${scriptPath}`);

  return await new Promise<WindowsBashExecutionResult>((resolve, reject) => {
    const child = spawn(gitBashPath, ['--noprofile', '--norc', scriptPath], {
      cwd,
      env: {
        ...process.env,
        PATH: getRuntimePathForChildProcess(),
        OPEN_COWORK_BASH_BACKEND: 'git-bash',
        MSYS2_ARG_CONV_EXCL: '*',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const closePipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    };

    const cleanup = (removeScript: boolean) => {
      clearTimeout(timeoutId);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      if (removeScript) {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          // best-effort cleanup
        }
      }
    };

    const finish = (result: WindowsBashExecutionResult) => {
      if (settled) return;
      settled = true;
      closePipes();
      cleanup(result.exitCode === 0 && !result.timedOut);
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closePipes();
      cleanup(false);
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid).catch(() => {});
      else child.kill();
      finish({
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}Command timed out after ${timeout}ms\n[Git Bash script preserved at ${scriptPath}]`,
        exitCode: 124,
        backend: 'git-bash',
        timedOut: true,
      });
    }, timeout);

    const abortHandler = signal
      ? () => {
          if (child.pid) killProcessTree(child.pid).catch(() => {});
          else child.kill();
          fail(new Error('Command aborted'));
        }
      : undefined;

    if (abortHandler) {
      signal?.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (error) => {
      fail(error);
    });

    child.on('exit', (code) => {
      finish({
        stdout,
        stderr: timedOut
          ? `${stderr}${stderr ? '\n' : ''}Command timed out after ${timeout}ms\n[Git Bash script preserved at ${scriptPath}]`
          : code === 0 || !scriptPath
            ? stderr
            : `${stderr}${stderr ? '\n' : ''}[Git Bash script preserved at ${scriptPath}]`,
        exitCode: timedOut ? 124 : (code ?? 1),
        backend: 'git-bash',
        timedOut,
      });
    });

    // Write the base64-encoded command to stdin, then any external stdin.
    // The script reads stdin via 'base64 -d | bash'.
    child.stdin?.write(cmdBase64);
    if (stdin) {
      child.stdin?.write('\n');
      child.stdin?.write(stdin);
    }
    child.stdin?.end();
  });
}

export async function executeWindowsBash({
  sessionId,
  command,
  cwd,
  timeout = 120,
  signal,
  stdin,
}: WindowsBashExecutionParams): Promise<WindowsBashExecutionResult> {
  if (process.platform !== 'win32') {
    throw new Error('executeWindowsBash should only be used on Windows');
  }

  const timeoutMs = Math.max(1, timeout) * 1000;
  const sandbox = getSandboxAdapter();

  if (sandbox.isWSL && sandbox.wslStatus?.distro) {
    log(
      `[WindowsBashExecutor] Session ${sessionId}: executing via WSL (${sandbox.wslStatus.distro})`
    );

    if (stdin) {
      const escapedInput = shellEscapeSingleQuoted(stdin);
      const wrappedCommand = `printf %s ${escapedInput} | (${command})`;
      return await executeViaSandbox(wrappedCommand, cwd, timeoutMs, 'wsl', signal);
    }

    return await executeViaSandbox(command, cwd, timeoutMs, 'wsl', signal);
  }

  const gitBashPath = detectGitBash();
  if (gitBashPath) {
    log(`[WindowsBashExecutor] Session ${sessionId}: executing via Git Bash (${gitBashPath})`);
    return await executeViaGitBash({
      gitBashPath,
      command,
      cwd,
      timeout: timeoutMs,
      signal,
      stdin,
    });
  }

  const tried = [
    'WSL sandbox',
    `${path.join(os.homedir(), '.pi', 'agent', 'settings.json')} (optional shellPath override)`,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'PATH lookup for bash.exe',
  ].join('\n');

  throw new Error(
    `No executable bash environment available on Windows.\nTried:\n${tried}\n\nRecommended fixes:\n- Enable WSL2 in Open Cowork settings\n- Install Git for Windows`
  );
}
