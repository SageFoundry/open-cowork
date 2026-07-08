import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export type RuntimeSource = 'bundled' | 'configured' | 'workspace' | 'system' | 'wsl' | 'unknown';
export type RuntimeKind = 'shell' | 'node' | 'python' | 'git';
export type ShellFlavor = 'pwsh' | 'powershell' | 'bash' | 'cmd' | 'unknown';

export interface ResolvedRuntime {
  kind: RuntimeKind;
  path: string;
  source: RuntimeSource;
  flavor?: ShellFlavor;
  warnings: string[];
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findExecutableInPath(executableNames: string[], pathValue = process.env.PATH): string | null {
  const entries = splitPathEntries(pathValue);
  for (const entry of entries) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // ignore invalid path entry
      }
    }
  }
  return null;
}

function findExecutablesInPath(executableNames: string[], pathValue = process.env.PATH): string[] {
  const entries = splitPathEntries(pathValue);
  const results: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const executableName of executableNames) {
      const candidate = path.join(entry, executableName);
      const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(normalized)) {
        continue;
      }
      try {
        if (fs.existsSync(candidate)) {
          seen.add(normalized);
          results.push(candidate);
        }
      } catch {
        // ignore invalid path entry
      }
    }
  }
  return results;
}

function existingDirectory(candidate: string): string | null {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

function collectBundledRuntimePathEntries(): string[] {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const projectRoot = process.cwd();
  const resourcesRoot = process.resourcesPath || path.join(projectRoot, 'resources');
  const entries: string[] = [];

  const nodeDirs =
    platform === 'win32'
      ? [
          path.join(resourcesRoot, 'node'),
          path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`),
        ]
      : [
          path.join(resourcesRoot, 'node', 'bin'),
          path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`, 'bin'),
        ];

  const pythonDirs = [
    path.join(resourcesRoot, 'python', 'bin'),
    path.join(projectRoot, 'resources', 'python', 'bin'),
    path.join(projectRoot, 'resources', 'python', `${platform}-${arch}`, 'bin'),
  ];

  const toolsDirs = [
    path.join(resourcesRoot, 'tools', 'bin'),
    path.join(resourcesRoot, 'tools', `${platform}-${arch}`, 'bin'),
    path.join(projectRoot, 'resources', 'tools', 'bin'),
    path.join(projectRoot, 'resources', 'tools', `${platform}-${arch}`, 'bin'),
  ];

  for (const candidate of [...nodeDirs, ...pythonDirs, ...toolsDirs]) {
    const dir = existingDirectory(candidate);
    if (dir) entries.push(dir);
  }

  return entries;
}

export function getRuntimePathEntriesForChildProcess(pathValue = process.env.PATH): string[] {
  const currentPaths = splitPathEntries(pathValue);
  const restoredPaths =
    process.platform === 'win32'
      ? (() => {
          try {
            return getWindowsRegistryPathEntries();
          } catch {
            return [];
          }
        })()
      : [];

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...collectBundledRuntimePathEntries(), ...restoredPaths, ...currentPaths]) {
    const normalized = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(entry);
    }
  }

  return merged;
}

export function getRuntimePathForChildProcess(pathValue = process.env.PATH): string {
  return getRuntimePathEntriesForChildProcess(pathValue).join(path.delimiter);
}

function resolveExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore invalid candidate
    }
  }
  return null;
}

export function isWindowsStoreAliasPath(executablePath: string | null | undefined): boolean {
  if (!executablePath) return false;
  return /\\AppData\\Local\\Microsoft\\WindowsApps\\/i.test(executablePath);
}

/**
 * Common Python installation directories on Windows to use as fallback.
 * These are searched when PATH resolution and py launcher both fail.
 */
const WINDOWS_PYTHON_FALLBACK_PATHS: string[] = [
  'D:\\pythonsdk\\python.exe',
  'C:\\Python312\\python.exe',
  'C:\\Python311\\python.exe',
  'C:\\Python310\\python.exe',
  path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Programs', 'Python', 'Python312', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Programs', 'Python', 'Python311', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Programs', 'Python', 'Python310', 'python.exe'),
  'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe',
];

function resolvePythonViaPyLauncher(): string | null {
  if (process.platform !== 'win32') {
    return null;
  }
  try {
    const output = execFileSync(
      'py',
      ['-3', '-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    return output && fs.existsSync(output) && !isWindowsStoreAliasPath(output) ? output : null;
  } catch {
    return null;
  }
}

/**
 * Execute a short Python -c command to check if a given python.exe resolves
 * correctly. This is used to validate candidates found in PATH that might
 * be non-functional WindowsApps aliases.
 */
function validatePythonExecutable(executablePath: string): boolean {
  try {
    const output = execFileSync(executablePath, ['-c', 'import sys; print("OK")'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return output === 'OK';
  } catch {
    return false;
  }
}

export function resolvePreferredWindowsShell(): ResolvedRuntime | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const warnings: string[] = [];
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pwsh =
    resolveExisting([
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '6', 'pwsh.exe'),
    ]) || findExecutableInPath(['pwsh.exe', 'pwsh']);

  if (pwsh) {
    return {
      kind: 'shell',
      path: pwsh,
      source: 'system',
      flavor: 'pwsh',
      warnings,
    };
  }

  const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
  const powershell =
    resolveExisting([
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ]) || findExecutableInPath(['powershell.exe', 'powershell']);

  if (powershell) {
    warnings.push('PowerShell 7 not found; falling back to Windows PowerShell 5.1.');
    return {
      kind: 'shell',
      path: powershell,
      source: 'system',
      flavor: 'powershell',
      warnings,
    };
  }

  const cmd =
    resolveExisting([path.join(systemRoot, 'System32', 'cmd.exe')]) ||
    process.env.COMSPEC ||
    'cmd.exe';

  warnings.push('PowerShell not found; falling back to cmd.exe compatibility mode.');
  return {
    kind: 'shell',
    path: cmd,
    source: 'system',
    flavor: 'cmd',
    warnings,
  };
}

export function getWindowsRegistryPathEntries(): string[] {
  if (process.platform !== 'win32') {
    return [];
  }

  const shellRuntime = resolvePreferredWindowsShell();
  if (!shellRuntime || (shellRuntime.flavor !== 'pwsh' && shellRuntime.flavor !== 'powershell')) {
    return [];
  }

  const output = (
    execFileSync(
      shellRuntime.path,
      [
        '-NoProfile',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')",
      ],
      { encoding: 'utf-8', timeout: 5000 }
    ) as string
  ).trim();

  return output
    ? output
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function resolvePythonFromPath(): ResolvedRuntime | null {
  const executableNames = process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'python3', 'python']
    : ['python3', 'python'];

  const warnings: string[] = [];
  const effectivePath = getRuntimePathForChildProcess();

  // Phase 1: Search PATH for non-WindowsApps python executables
  const candidates = findExecutablesInPath(executableNames, effectivePath);
  const realPython = candidates.find((candidate) => !isWindowsStoreAliasPath(candidate));

  if (realPython) {
    // Validate the candidate actually works
    if (validatePythonExecutable(realPython)) {
      return {
        kind: 'python',
        path: realPython,
        source: 'system',
        warnings,
      };
    }
    warnings.push(`Found ${realPython} on PATH but failed to validate; trying other methods.`);
  }

  // Phase 2: Try py launcher
  const launcherResolved = resolvePythonViaPyLauncher();
  if (launcherResolved) {
    if (validatePythonExecutable(launcherResolved)) {
      warnings.push('Resolved python via py launcher (PATH entries were invalid or WindowsApps aliases).');
      return {
        kind: 'python',
        path: launcherResolved,
        source: 'system',
        warnings,
      };
    }
    warnings.push(`py launcher returned ${launcherResolved} but it failed validation.`);
  }

  // Phase 3: Try common fallback installation paths
  if (process.platform === 'win32') {
    for (const fallbackPath of WINDOWS_PYTHON_FALLBACK_PATHS) {
      if (fs.existsSync(fallbackPath)) {
        try {
          const testPath = path.resolve(fallbackPath);
          if (validatePythonExecutable(testPath)) {
            warnings.push(`Resolved python via fallback path: ${testPath}`);
            return {
              kind: 'python',
              path: testPath,
              source: 'system',
              warnings,
            };
          }
        } catch {
          continue;
        }
      }
    }
  }

  // Phase 4: If we found a WindowsApps candidate earlier, at least surface it
  const windowsAppsCandidate = candidates.find((c) => isWindowsStoreAliasPath(c));
  if (windowsAppsCandidate) {
    warnings.push(
      'Only WindowsApps python alias found on PATH. ' +
      'This may fail with "Permission denied" in sub-processes. ' +
      'Consider installing a real Python distribution or configuring the path explicitly.'
    );
    // Don't return it — better to let the caller know there's no usable Python
  }

  return null;
}

export function resolveNodeFromPath(): ResolvedRuntime | null {
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
  const found = findExecutableInPath([executableName, 'node'], getRuntimePathForChildProcess());
  if (!found) return null;

  return {
    kind: 'node',
    path: found,
    source: 'system',
    warnings: [],
  };
}

export interface RuntimeDiagnosticsSnapshot {
  shell: ResolvedRuntime | null;
  python: ResolvedRuntime | null;
  node: ResolvedRuntime | null;
}

export function collectRuntimeDiagnostics(): RuntimeDiagnosticsSnapshot {
  return {
    shell: process.platform === 'win32' ? resolvePreferredWindowsShell() : null,
    python: resolvePythonFromPath(),
    node: resolveNodeFromPath(),
  };
}
