import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => {
      if (name === 'appData') return path.join(testRoot, 'AppData', 'Roaming');
      if (name === 'userData') return path.join(testRoot, 'userData');
      if (name === 'home') return path.join(testRoot, 'home');
      return testRoot;
    },
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { getGlobalSkillsDir, getProjectSkillsDir } from '../src/main/skills/skill-paths';
import { SkillsManager } from '../src/main/skills/skills-manager';
import type { DatabaseInstance } from '../src/main/db/database';

function createDbMock(): DatabaseInstance {
  const statement = { run: vi.fn() };
  return {
    raw: {} as any,
    sessions: {} as any,
    messages: {} as any,
    traceSteps: {} as any,
    scheduledTasks: {} as any,
    prepare: vi.fn(() => statement as any),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
  };
}

function writeSkill(rootPath: string, name: string, description = `${name} skill`): void {
  const skillRoot = path.join(rootPath, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.`,
    'utf8'
  );
}

describe('SkillsManager fixed storage layout', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-skills-storage-test-'));
    fs.mkdirSync(path.join(testRoot, 'AppData', 'Roaming'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('resolves global skills to APPDATA/open-cowork/skills on Windows-like appData mocks', () => {
    expect(getGlobalSkillsDir()).toBe(path.join(testRoot, 'AppData', 'Roaming', 'open-cowork', 'skills'));
  });

  it('resolves project skills to the project .skills directory only', () => {
    const projectPath = path.join(testRoot, 'repo');
    expect(getProjectSkillsDir(projectPath)).toBe(path.join(projectPath, '.skills'));
  });

  it('loads global skills and project .skills, but ignores project skills directory', async () => {
    const projectPath = path.join(testRoot, 'repo');
    writeSkill(getGlobalSkillsDir(), 'global-alpha', 'global skill');
    writeSkill(path.join(projectPath, '.skills'), 'project-alpha', 'project skill');
    writeSkill(path.join(projectPath, 'skills'), 'ignored-alpha', 'ignored skill');

    const manager = new SkillsManager(createDbMock());
    const skills = await manager.listSkills({ type: 'custom' }, { projectPath });
    const names = skills.map((skill) => skill.name).sort();

    expect(names).toEqual(['global-alpha', 'project-alpha']);
  });

  it('prefers project skills over global skills with the same name', async () => {
    const projectPath = path.join(testRoot, 'repo');
    writeSkill(getGlobalSkillsDir(), 'alpha', 'global description');
    writeSkill(path.join(projectPath, '.skills'), 'alpha', 'project description');

    const manager = new SkillsManager(createDbMock());
    const skills = await manager.listSkills({ type: 'custom' }, { projectPath });
    const alpha = skills.find((skill) => skill.name === 'alpha');

    expect(alpha?.source).toBe('project');
    expect(alpha?.description).toBe('project description');
  });

  it('installs and deletes project skills without touching global skills', async () => {
    const projectPath = path.join(testRoot, 'repo');
    const sourcePath = path.join(testRoot, 'source-skill');
    writeSkill(sourcePath, 'alpha', 'project description');
    writeSkill(getGlobalSkillsDir(), 'beta', 'global description');

    const manager = new SkillsManager(createDbMock());
    const installed = await manager.installSkill(path.join(sourcePath, 'alpha'), {
      scope: 'project',
      projectPath,
    });

    expect(installed.id).toBe('project-alpha');
    expect(fs.existsSync(path.join(projectPath, '.skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(getGlobalSkillsDir(), 'beta', 'SKILL.md'))).toBe(true);

    await manager.uninstallSkill(installed.id);

    expect(fs.existsSync(path.join(projectPath, '.skills', 'alpha'))).toBe(false);
    expect(fs.existsSync(path.join(getGlobalSkillsDir(), 'beta', 'SKILL.md'))).toBe(true);
  });

  it('migrates legacy app and configured global skills without overwriting existing targets', async () => {
    const legacyAppSkills = path.join(testRoot, 'userData', 'claude', 'skills');
    const configuredSkills = path.join(testRoot, 'home', 'configured-skills');
    writeSkill(legacyAppSkills, 'legacy-alpha', 'legacy description');
    writeSkill(configuredSkills, 'configured-alpha', 'configured description');
    writeSkill(configuredSkills, 'existing-alpha', 'configured existing');
    writeSkill(getGlobalSkillsDir(), 'existing-alpha', 'global existing');

    let configuredPath = configuredSkills;
    const manager = new SkillsManager(createDbMock(), {
      getLegacyConfiguredGlobalSkillsPath: () => configuredPath,
      clearLegacyConfiguredGlobalSkillsPath: () => {
        configuredPath = '';
      },
    });

    expect(fs.existsSync(path.join(manager.getGlobalSkillsPath(), 'legacy-alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(manager.getGlobalSkillsPath(), 'configured-alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(legacyAppSkills, 'legacy-alpha'))).toBe(false);
    expect(fs.existsSync(path.join(configuredSkills, 'configured-alpha'))).toBe(false);
    expect(
      fs.readFileSync(path.join(manager.getGlobalSkillsPath(), 'existing-alpha', 'SKILL.md'), 'utf8')
    ).toContain('global existing');
    expect(configuredPath).toBe('');
  });

  it('does not restore a migrated legacy skill after the user deletes it and restarts', async () => {
    const legacyAppSkills = path.join(testRoot, 'userData', 'claude', 'skills');
    writeSkill(legacyAppSkills, 'legacy-alpha', 'legacy description');

    let manager = new SkillsManager(createDbMock());
    expect(fs.existsSync(path.join(manager.getGlobalSkillsPath(), 'legacy-alpha', 'SKILL.md'))).toBe(true);

    fs.rmSync(path.join(manager.getGlobalSkillsPath(), 'legacy-alpha'), { recursive: true, force: true });
    manager = new SkillsManager(createDbMock());

    expect(fs.existsSync(path.join(manager.getGlobalSkillsPath(), 'legacy-alpha'))).toBe(false);
  });
});
