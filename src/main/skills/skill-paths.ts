import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface ResolveBuiltinSkillsPathOptions {
  onFound?: (skillsPath: string) => void;
  onMissing?: () => void;
}

export function physicalDirExists(dirPath: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const originalFs = require('original-fs') as typeof import('fs');
    return originalFs.existsSync(dirPath) && originalFs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the built-in skills directory (app.asar/.claude/skills/ or unpacked equivalent).
 * Built-in skills are read-only and shipped with the application.
 */
export function resolveBuiltinSkillsPath(options: ResolveBuiltinSkillsPathOptions = {}): string {
  const appPath = app.getAppPath();
  const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');
  const possiblePaths = [
    path.join(__dirname, '..', '..', '..', '.claude', 'skills'),
    path.join(process.resourcesPath || '', 'skills'),
    ...(physicalDirExists(path.join(unpackedPath, '.claude', 'skills'))
      ? [path.join(unpackedPath, '.claude', 'skills')]
      : []),
    path.join(appPath, '.claude', 'skills'),
  ];

  for (const skillsPath of possiblePaths) {
    if (fs.existsSync(skillsPath)) {
      options.onFound?.(skillsPath);
      return skillsPath;
    }
  }

  options.onMissing?.();
  return '';
}

/**
 * Get the global skills directory path.
 * This is the single directory where all user-installed skills are stored.
 * Path on Windows: %APPDATA%/open-cowork/skills/
 */
export function getGlobalSkillsDir(): string {
  if (process.platform === 'win32') {
    return path.join(app.getPath('appData'), 'open-cowork', 'skills');
  }
  return path.join(app.getPath('userData'), 'skills');
}

/**
 * Get the project-local skills directory.
 * Project skills are always stored in <project>/.skills.
 */
export function getProjectSkillsDir(projectPath: string): string {
  return path.join(path.resolve(projectPath), '.skills');
}

/**
 * Legacy Open Cowork global skills directory used by earlier versions.
 */
export function getLegacyAppSkillsDir(): string {
  return path.join(app.getPath('userData'), 'claude', 'skills');
}

/**
 * Recursively copy a directory.
 */
export function copyDirectorySync(source: string, target: string): void {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const entries = fs.readdirSync(source);
  for (const entry of entries) {
    const sourcePath = path.join(source, entry);
    const targetPath = path.join(target, entry);
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      copyDirectorySync(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}
