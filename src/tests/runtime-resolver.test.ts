import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('runtime-resolver', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalPath = process.env.PATH;
  const originalProgramFiles = process.env.ProgramFiles;
  const originalSystemRoot = process.env.SystemRoot;
  let tmpDir: string;

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    process.env.PATH = originalPath;
    process.env.ProgramFiles = originalProgramFiles;
    process.env.SystemRoot = originalSystemRoot;
    vi.doUnmock('child_process');
    vi.resetModules();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prefers PowerShell 7 on Windows when available', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'));
    const shellDir = path.join(tmpDir, 'pwsh-bin');
    fs.mkdirSync(shellDir, { recursive: true });
    fs.writeFileSync(path.join(shellDir, 'pwsh.exe'), '');

    process.env.ProgramFiles = path.join(tmpDir, 'missing-program-files');
    process.env.SystemRoot = path.join(tmpDir, 'missing-system-root');
    process.env.PATH = shellDir;

    const { resolvePreferredWindowsShell } = await import('../main/runtime/runtime-resolver');
    const resolved = resolvePreferredWindowsShell();

    expect(resolved?.flavor).toBe('pwsh');
    expect(resolved?.path).toBe(path.join(shellDir, 'pwsh.exe'));
    expect(resolved?.warnings).toEqual([]);
  });

  it('falls back to Windows PowerShell when pwsh is unavailable', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'));
    const systemRoot = path.join(tmpDir, 'Windows');
    const powershellDir = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    fs.mkdirSync(powershellDir, { recursive: true });
    fs.writeFileSync(path.join(powershellDir, 'powershell.exe'), '');

    process.env.ProgramFiles = path.join(tmpDir, 'missing-program-files');
    process.env.SystemRoot = systemRoot;
    process.env.PATH = '';

    const { resolvePreferredWindowsShell } = await import('../main/runtime/runtime-resolver');
    const resolved = resolvePreferredWindowsShell();

    expect(resolved?.flavor).toBe('powershell');
    expect(resolved?.path).toBe(path.join(powershellDir, 'powershell.exe'));
    expect(resolved?.warnings[0]).toContain('PowerShell 7 not found');
  });

  it('does not attempt Windows registry PATH restore when only cmd fallback is available', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'));
    const systemRoot = path.join(tmpDir, 'Windows');
    const cmdDir = path.join(systemRoot, 'System32');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'cmd.exe'), '');

    process.env.ProgramFiles = path.join(tmpDir, 'missing-program-files');
    process.env.SystemRoot = systemRoot;
    process.env.PATH = '';

    const { getWindowsRegistryPathEntries, resolvePreferredWindowsShell } = await import(
      '../main/runtime/runtime-resolver'
    );
    const shell = resolvePreferredWindowsShell();
    const restored = getWindowsRegistryPathEntries();

    expect(shell?.flavor).toBe('cmd');
    expect(restored).toEqual([]);
  });

  it('skips WindowsApps python alias when resolving python', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'));
    const windowsApps = path.join(
      tmpDir,
      'Users',
      'user',
      'AppData',
      'Local',
      'Microsoft',
      'WindowsApps'
    );
    fs.mkdirSync(windowsApps, { recursive: true });
    fs.writeFileSync(path.join(windowsApps, 'python.exe'), '');

    process.env.PATH = windowsApps;

    const { resolvePythonFromPath } = await import('../main/runtime/runtime-resolver');
    const resolved = resolvePythonFromPath();

    expect(resolved?.path).not.toBe(path.join(windowsApps, 'python.exe'));
  });

  it('prefers a real python over WindowsApps alias on PATH', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'));
    const windowsApps = path.join(
      tmpDir,
      'Users',
      'user',
      'AppData',
      'Local',
      'Microsoft',
      'WindowsApps'
    );
    const realPythonDir = path.join(tmpDir, 'Python311');
    fs.mkdirSync(windowsApps, { recursive: true });
    fs.mkdirSync(realPythonDir, { recursive: true });
    fs.writeFileSync(path.join(windowsApps, 'python.exe'), '');
    fs.writeFileSync(path.join(realPythonDir, 'python.exe'), '');

    process.env.PATH = `${windowsApps};${realPythonDir}`;

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn((command: string, args: string[]) => {
        if (command === path.join(realPythonDir, 'python.exe') && args[0] === '-c') {
          return 'OK\n';
        }
        throw new Error('not found');
      }),
    }));

    const { resolvePythonFromPath } = await import('../main/runtime/runtime-resolver');
    const resolved = resolvePythonFromPath();

    expect(resolved?.path).toBe(path.join(realPythonDir, 'python.exe'));
    expect(resolved?.warnings).toEqual([]);
  });

  it('builds child process PATH from Windows registry and current process PATH', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runtime-'));
    const shellDir = path.join(tmpDir, 'pwsh-bin');
    const currentDir = path.join(tmpDir, 'current-bin');
    const registryDir = path.join(tmpDir, 'registry-bin');
    fs.mkdirSync(shellDir, { recursive: true });
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(shellDir, 'pwsh.exe'), '');

    process.env.ProgramFiles = path.join(tmpDir, 'missing-program-files');
    process.env.SystemRoot = path.join(tmpDir, 'missing-system-root');
    process.env.PATH = `${shellDir};${currentDir}`;

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(() => registryDir),
    }));

    const { getRuntimePathEntriesForChildProcess } = await import(
      '../main/runtime/runtime-resolver'
    );
    const entries = getRuntimePathEntriesForChildProcess();

    expect(entries).toContain(registryDir);
    expect(entries).toContain(currentDir);
    expect(entries.indexOf(registryDir)).toBeLessThan(entries.indexOf(currentDir));
  });
});
