/**
 * @module main/skills/skills-manager
 *
 * Skill discovery and lifecycle.
 *
 * Responsibilities:
 * - Discovers built-in skills from .claude/skills/ directories
 * - Parses SKILL.md front-matter for metadata (name, description, triggers)
 * - Plugin install/uninstall from npm-style package specs
 *
 * Three skill sources:
 *   1. Built-in skills: app.asar/.claude/skills/ (read-only, shipped with app)
 *   2. Global skills: %APPDATA%/open-cowork/skills/ (the single user-managed directory)
 *   3. Project skills: <project>/.skills/ (per-project)
 *
 * Dependencies: database
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Skill, PluginInstallResult } from '../../renderer/types';
import type { DatabaseInstance } from '../db/database';
import { log, logError, logWarn } from '../utils/logger';
import { isPathWithinRoot } from '../../shared/path-containment';
import {
  getGlobalSkillsDir,
  getLegacyAppSkillsDir,
  getProjectSkillsDir,
  resolveBuiltinSkillsPath,
} from './skill-paths';

/**
 * Validate that a skill name is safe for use as a directory name.
 * Rejects names containing path separators or parent directory references.
 */
function validateSkillName(name: string): void {
  if (!name || /[/\\]|\.\./.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

/**
 * Check if a path is a dangling symlink (symlink whose target no longer exists).
 */
function isDanglingSymlink(filePath: string): boolean {
  try {
    const lstat = fs.lstatSync(filePath);
    if (!lstat.isSymbolicLink()) return false;
    // Symlink exists — check if the target is reachable
    try {
      fs.statSync(filePath);
      return false; // target exists, not dangling
    } catch {
      return true; // target unreachable
    }
  } catch {
    return false; // path itself doesn't exist
  }
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SkillConfig {
  name: string;
  description?: string;
  type: 'mcp' | 'custom';
  mcp?: McpServerConfig;
  enabled?: boolean;
}

interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
}

export type SkillInstallScope = 'global' | 'project';

const LEGACY_MIGRATION_MARKER = '.legacy-skills-migrated';

interface SkillsManagerOptions {
  getLegacyConfiguredGlobalSkillsPath?: () => string | undefined;
  clearLegacyConfiguredGlobalSkillsPath?: () => void;
}

/**
 * SkillsManager - Manages skill loading and MCP server lifecycle
 *
 * Skills loading priority:
 * 1. Project-level: <project>/.skills/
 * 2. Global: %APPDATA%/open-cowork/skills/
 * 3. Built-in skills (read-only)
 */
export class SkillsManager {
  private db: DatabaseInstance;
  private loadedSkills: Map<string, Skill> = new Map();
  private runningServers: Map<string, { process: unknown; skill: Skill }> = new Map();
  private loadedGlobalSkillsSignature = '';
  private globalSkillsLoaded = false;
  private loadedProjectSkillsSignature = '';
  private loadedProjectPath = '';
  private projectSkillsLoaded = false;
  private getLegacyConfiguredGlobalSkillsPathFn?: () => string | undefined;
  private clearLegacyConfiguredGlobalSkillsPathFn?: () => void;

  constructor(db: DatabaseInstance, options: SkillsManagerOptions = {}) {
    this.db = db;
    this.getLegacyConfiguredGlobalSkillsPathFn = options.getLegacyConfiguredGlobalSkillsPath;
    this.clearLegacyConfiguredGlobalSkillsPathFn = options.clearLegacyConfiguredGlobalSkillsPath;
    this.migrateLegacyGlobalSkills();
    this.loadBuiltinSkills();
  }

  /**
   * Non-destructively import legacy global skills into the fixed Open Cowork
   * global skills directory. Existing target skills win.
   */
  private migrateLegacyGlobalSkills(): void {
    const targetDir = getGlobalSkillsDir();
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const legacyDirs = new Set<string>();
    legacyDirs.add(getLegacyAppSkillsDir());
    const configuredPath = (this.getLegacyConfiguredGlobalSkillsPathFn?.() || '').trim();
    if (configuredPath) {
      legacyDirs.add(path.resolve(configuredPath));
    }

    const markerPath = path.join(targetDir, LEGACY_MIGRATION_MARKER);
    const markerExists = fs.existsSync(markerPath);
    for (const sourceDir of legacyDirs) {
      if (!sourceDir || path.resolve(sourceDir) === path.resolve(targetDir)) {
        continue;
      }
      if (markerExists && sourceDir === getLegacyAppSkillsDir()) {
        continue;
      }
      this.importLegacySkills(sourceDir, targetDir);
    }

    if (!markerExists) {
      try {
        fs.writeFileSync(markerPath, String(Date.now()), 'utf8');
      } catch (err) {
        logWarn(`[Skills] Failed to write legacy migration marker: ${err}`);
      }
    }

    if (configuredPath) {
      try {
        this.clearLegacyConfiguredGlobalSkillsPathFn?.();
      } catch (err) {
        logWarn(`[Skills] Failed to clear legacy skills path config: ${err}`);
      }
    }
  }

  private importLegacySkills(sourceDir: string, targetDir: string): void {
    if (!fs.existsSync(sourceDir)) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourceDir);
    } catch {
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch (err) {
      logWarn(`[Skills] Failed to read legacy skills directory ${sourceDir}: ${err}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (/[/\\]|\.\./.test(entry.name)) {
        logWarn(`[Skills] Skipping legacy skill with unsafe name: ${entry.name}`);
        continue;
      }
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (!fs.existsSync(path.join(sourcePath, 'SKILL.md'))) {
        continue;
      }
      if (fs.existsSync(targetPath) || isDanglingSymlink(targetPath)) {
        logWarn(`[Skills] Skipping legacy skill migration because target exists: ${targetPath}`);
        continue;
      }
      try {
        this.moveDirectorySyncSafe(sourcePath, targetPath);
        log(`[Skills] Migrated legacy skill: ${sourcePath} -> ${targetPath}`);
      } catch (err) {
        logWarn(`[Skills] Failed to migrate legacy skill ${sourcePath}: ${err}`);
      }
    }
  }

  private moveDirectorySyncSafe(source: string, target: string): void {
    try {
      fs.renameSync(source, target);
      return;
    } catch (renameError) {
      try {
        this.copyDirectorySyncSafe(source, target);
        fs.rmSync(source, { recursive: true, force: true });
      } catch (copyError) {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
        throw copyError ?? renameError;
      }
    }
  }

  /**
   * Load built-in skills
   */
  private loadBuiltinSkills(): void {
    // Load skills from .claude/skills directory (like pdf, xlsx, docx, pptx)
    const builtinSkillsPath = this.getBuiltinSkillsPath();
    if (builtinSkillsPath) {
      try {
        const skillDirs = fs.readdirSync(builtinSkillsPath);

        for (const dir of skillDirs) {
          const skillPath = path.join(builtinSkillsPath, dir);

          if (isDanglingSymlink(skillPath)) {
            logWarn(`[Skills] Skipping dangling symlink in built-in skills: ${skillPath}`);
            continue;
          }

          let stat: fs.Stats;
          try {
            stat = fs.statSync(skillPath);
          } catch {
            continue;
          }

          if (!stat.isDirectory()) continue;

          // Look for SKILL.md
          const skillMdPath = path.join(skillPath, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;

          // Parse metadata
          const metadata = this.getSkillMetadata(skillPath);
          if (!metadata) continue;

          const skill: Skill = {
            id: `builtin-${dir}`,
            name: metadata.name,
            description: metadata.description,
            type: 'builtin',
            source: 'builtin',
            enabled: true,
            createdAt: Date.now(),
          };

          this.loadedSkills.set(skill.id, skill);
          log(`Loaded built-in skill: ${skill.name}`);
        }
      } catch (error) {
        logError('Failed to load built-in skills from .claude/skills:', error);
      }
    }
  }

  /**
   * Get the built-in skills directory path
   */
  private getBuiltinSkillsPath(): string {
    return resolveBuiltinSkillsPath();
  }

  /**
   * SkillsAdapter implementation: return all Open Cowork managed skill directories.
   * Used by ClaudeAgentRunner to pass to pi's DefaultResourceLoader via additionalSkillPaths.
   */
  getSkillPaths(projectPath?: string): string[] {
    const paths: string[] = [];

    // 1. Built-in skills (.claude/skills)
    const builtin = this.getBuiltinSkillsPath();
    if (builtin && fs.existsSync(builtin)) {
      paths.push(builtin);
    }

    // 2. Global skills (%APPDATA%/open-cowork/skills/)
    const global = getGlobalSkillsDir();
    if (fs.existsSync(global)) {
      paths.push(global);
    }

    // 3. Project-level skills
    if (projectPath) {
      const projectSkillsDir = getProjectSkillsDir(projectPath);
      if (fs.existsSync(projectSkillsDir) && fs.statSync(projectSkillsDir).isDirectory()) {
        paths.push(projectSkillsDir);
      }
    }

    return paths;
  }

  /**
   * Get the global skills directory path.
   * This is the single directory where all user-installed skills live.
   */
  getGlobalSkillsPath(): string {
    return getGlobalSkillsDir();
  }

  private clearSkillsBySource(source: 'project' | 'global'): void {
    const prefix = `${source}-`;
    for (const key of Array.from(this.loadedSkills.keys())) {
      if (key.startsWith(prefix)) {
        this.loadedSkills.delete(key);
      }
    }
  }

  private invalidateGlobalSkillsCache(): void {
    this.loadedGlobalSkillsSignature = '';
    this.globalSkillsLoaded = false;
  }

  private invalidateProjectSkillsCache(): void {
    this.loadedProjectSkillsSignature = '';
    this.loadedProjectPath = '';
    this.projectSkillsLoaded = false;
  }

  private computeStorageSignature(storagePath: string): string {
    try {
      if (!fs.existsSync(storagePath) || !fs.statSync(storagePath).isDirectory()) {
        return '';
      }
      const entries = fs.readdirSync(storagePath, { withFileTypes: true });
      const parts = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const skillMdPath = path.join(storagePath, entry.name, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) {
            return null;
          }
          const stat = fs.statSync(skillMdPath);
          return `${entry.name}:${stat.mtimeMs}`;
        })
        .filter((value): value is string => Boolean(value))
        .sort();
      return parts.join('|');
    } catch {
      return '';
    }
  }

  /**
   * Load skills from a project directory
   */
  async loadProjectSkills(projectPath: string): Promise<Skill[]> {
    const skillsDir = getProjectSkillsDir(projectPath);
    const signature = this.computeStorageSignature(skillsDir);
    const resolvedProjectPath = path.resolve(projectPath);
    if (
      this.projectSkillsLoaded &&
      this.loadedProjectPath === resolvedProjectPath &&
      signature === this.loadedProjectSkillsSignature
    ) {
      return Array.from(this.loadedSkills.values()).filter((skill) =>
        skill.id.startsWith('project-')
      );
    }

    this.clearSkillsBySource('project');

    if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
      this.loadedProjectPath = resolvedProjectPath;
      this.loadedProjectSkillsSignature = signature;
      this.projectSkillsLoaded = true;
      return [];
    }

    const skills = await this.loadSkillsFromDirectory(skillsDir, 'project');
    this.loadedProjectPath = resolvedProjectPath;
    this.loadedProjectSkillsSignature = signature;
    this.projectSkillsLoaded = true;
    return skills;
  }

  /**
   * Load global skills from user config directory
   */
  async loadGlobalSkills(): Promise<Skill[]> {
    const globalSkillsPath = getGlobalSkillsDir();

    if (!fs.existsSync(globalSkillsPath)) {
      fs.mkdirSync(globalSkillsPath, { recursive: true });
    }

    const signature = this.computeStorageSignature(globalSkillsPath);
    if (this.globalSkillsLoaded && signature === this.loadedGlobalSkillsSignature) {
      return Array.from(this.loadedSkills.values()).filter((skill) =>
        skill.id.startsWith('global-')
      );
    }

    this.clearSkillsBySource('global');
    const skills = await this.loadSkillsFromDirectory(globalSkillsPath, 'global');
    this.loadedGlobalSkillsSignature = signature;
    this.globalSkillsLoaded = true;
    return skills;
  }

  /**
   * Load skills from a directory
   */
  private async loadSkillsFromDirectory(
    dir: string,
    source: 'project' | 'global'
  ): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = fs.readdirSync(dir);

      for (const entry of entries) {
        const entryPath = path.join(dir, entry);

        // Skip dangling symlinks (e.g. leftover links to a previous app bundle)
        if (isDanglingSymlink(entryPath)) {
          logWarn(`[Skills] Skipping dangling symlink: ${entryPath}`);
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(entryPath);
        } catch {
          continue; // skip entries that can't be stat'd
        }

        // Check if it's a directory with SKILL.md
        if (stat.isDirectory()) {
          const skillMdPath = path.join(entryPath, 'SKILL.md');
          if (fs.existsSync(skillMdPath)) {
            // Parse metadata from SKILL.md
            const metadata = this.getSkillMetadata(entryPath);
            if (!metadata) continue;

            const skill: Skill = {
              id: `${source}-${entry}`,
              name: metadata.name,
              description: metadata.description,
              type: 'custom',
              source,
              enabled: true,
              createdAt: Date.now(),
            };

            skills.push(skill);
            this.loadedSkills.set(skill.id, skill);
          }
        }
        // Also support legacy .json config files
        else if (entry.endsWith('.json')) {
          try {
            const content = fs.readFileSync(entryPath, 'utf-8');
            const config: SkillConfig = JSON.parse(content);

            const skill: Skill = {
              id: `${source}-${path.basename(entry, '.json')}`,
              name: config.name,
              description: config.description,
              type: config.type === 'mcp' ? 'mcp' : 'custom',
              source,
              enabled: config.enabled !== false,
              config: config.mcp ? { mcp: config.mcp } : undefined,
              createdAt: Date.now(),
            };

            skills.push(skill);
            this.loadedSkills.set(skill.id, skill);
          } catch (error) {
            logError(`Failed to load skill from ${entryPath}:`, error);
          }
        }
      }
    } catch (error) {
      logError(`Failed to read skills directory ${dir}:`, error);
    }

    return skills;
  }

  /**
   * Get all active skills for a session
   */
  async getActiveSkills(_sessionId: string, projectPath?: string): Promise<Skill[]> {
    const skills: Skill[] = [];

    // 1. Add built-in skills
    for (const skill of this.loadedSkills.values()) {
      if (skill.type === 'builtin' && skill.enabled) {
        skills.push(skill);
      }
    }

    // 2. Add global skills
    const globalSkills = await this.loadGlobalSkills();
    skills.push(...globalSkills.filter((s) => s.enabled));

    // 3. Add project skills (highest priority, can override)
    if (projectPath) {
      const projectSkills = await this.loadProjectSkills(projectPath);

      skills.push(...projectSkills.filter((s) => s.enabled));
    }

    return this.deduplicateSkills(skills);
  }

  /**
   * Start an MCP server for a skill
   */
  async startMcpServer(skill: Skill): Promise<void> {
    if (skill.type !== 'mcp' || !skill.config?.mcp) {
      throw new Error('Skill is not an MCP skill');
    }

    if (this.runningServers.has(skill.id)) {
      log(`MCP server for ${skill.name} is already running`);
      return;
    }

    // TODO: Implement actual MCP server startup
    // const { spawn } = await import('child_process');
    // const mcpConfig = skill.config.mcp as McpServerConfig;
    //
    // const proc = spawn(mcpConfig.command, mcpConfig.args || [], {
    //   env: { ...process.env, ...mcpConfig.env },
    // });
    //
    // this.runningServers.set(skill.id, { process: proc, skill });

    log(`MCP server started for skill: ${skill.name}`);
  }

  /**
   * Stop an MCP server
   */
  async stopMcpServer(skillId: string): Promise<void> {
    const server = this.runningServers.get(skillId);
    if (!server) {
      return;
    }

    // TODO: Implement graceful shutdown
    // server.process.kill();

    this.runningServers.delete(skillId);
    log(`MCP server stopped for skill: ${server.skill.name}`);
  }

  /**
   * Stop all running MCP servers
   */
  async stopAllServers(): Promise<void> {
    for (const skillId of this.runningServers.keys()) {
      await this.stopMcpServer(skillId);
    }
  }

  /**
   * Enable or disable a skill
   */
  setSkillEnabled(skillId: string, enabled: boolean): void {
    const skill = this.loadedSkills.get(skillId);
    if (skill) {
      skill.enabled = enabled;

      // Stop server if disabling an MCP skill
      if (!enabled && skill.type === 'mcp') {
        this.stopMcpServer(skillId);
      }
    }
  }

  /**
   * Get all loaded skills
   */
  getAllSkills(): Skill[] {
    return this.deduplicateSkills(Array.from(this.loadedSkills.values()));
  }

  /**
   * Save skill to database
   */
  saveSkill(skill: Skill): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skills (id, name, description, type, enabled, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      skill.id,
      skill.name,
      skill.description || null,
      skill.type,
      skill.enabled ? 1 : 0,
      skill.config ? JSON.stringify(skill.config) : null,
      skill.createdAt
    );
  }

  /**
   * Delete a skill
   */
  deleteSkill(skillId: string): void {
    // Can't delete built-in skills
    const skill = this.loadedSkills.get(skillId);
    if (skill?.type === 'builtin') {
      throw new Error('Cannot delete built-in skills');
    }

    this.stopMcpServer(skillId);
    this.loadedSkills.delete(skillId);

    const stmt = this.db.prepare('DELETE FROM skills WHERE id = ?');
    stmt.run(skillId);
  }

  /**
   * List all skills with optional filters
   */
  async listSkills(
    filter?: {
    type?: 'builtin' | 'mcp' | 'custom';
    enabled?: boolean;
    },
    options: { projectPath?: string } = {}
  ): Promise<Skill[]> {
    // Load managed skills first to ensure they're in loadedSkills
    await this.loadGlobalSkills();
    if (options.projectPath) {
      await this.loadProjectSkills(options.projectPath);
    } else {
      this.clearSkillsBySource('project');
      this.invalidateProjectSkillsCache();
    }

    let skills = this.deduplicateSkills(Array.from(this.loadedSkills.values()));

    if (filter) {
      if (filter.type !== undefined) {
        skills = skills.filter((s) => s.type === filter.type);
      }
      if (filter.enabled !== undefined) {
        skills = skills.filter((s) => s.enabled === filter.enabled);
      }
    }

    return skills;
  }

  /**
   * Validate skill folder structure and SKILL.md
   */
  async validateSkillFolder(skillPath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check if path exists
    if (!fs.existsSync(skillPath)) {
      return { valid: false, errors: ['Path does not exist'] };
    }

    // Check if it's a directory
    const stat = fs.statSync(skillPath);
    if (!stat.isDirectory()) {
      return { valid: false, errors: ['Path is not a directory'] };
    }

    // Check for SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return { valid: false, errors: ['SKILL.md not found'] };
    }

    // Parse SKILL.md frontmatter
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const frontMatter = frontMatterMatch ? frontMatterMatch[1] : content;

      const nameMatch = frontMatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
      const descMatch = frontMatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);

      if (!nameMatch) {
        errors.push('SKILL.md missing "name" in frontmatter');
      }
      if (!descMatch) {
        errors.push('SKILL.md missing "description" in frontmatter');
      }
    } catch (err) {
      errors.push('Failed to parse SKILL.md');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get skill metadata from SKILL.md file
   */
  getSkillMetadata(skillPath: string): { name: string; description: string } | null {
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');

      // Limit regex matching to the YAML front-matter block (between --- markers)
      const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const frontMatter = frontMatterMatch ? frontMatterMatch[1] : content;

      const nameMatch = frontMatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
      const descMatch = frontMatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);

      if (!nameMatch || !descMatch) {
        return null;
      }

      const name = nameMatch[1].trim();
      validateSkillName(name);

      return {
        name,
        description: descMatch[1].trim(),
      };
    } catch (error) {
      logError(`Failed to parse SKILL.md from ${skillPath}:`, error);
      return null;
    }
  }

  private getInstallRoot(scope: SkillInstallScope, projectPath?: string): string {
    if (scope === 'project') {
      if (!projectPath?.trim()) {
        throw new Error('Project path is required for project skill install');
      }
      return getProjectSkillsDir(projectPath);
    }
    return getGlobalSkillsDir();
  }

  private async copySkillToRoot(
    sourcePath: string,
    skillName: string,
    rootPath: string
  ): Promise<string> {
    if (!fs.existsSync(rootPath)) {
      fs.mkdirSync(rootPath, { recursive: true });
    }

    const targetPath = path.join(rootPath, skillName);
    await this.copyDirectory(sourcePath, targetPath);

    log(`Copied skill from ${sourcePath} to ${targetPath}`);
    return targetPath;
  }

  private copyDirectorySyncSafe(source: string, target: string): void {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const files = fs.readdirSync(source);
    for (const file of files) {
      const sourcePath = path.join(source, file);
      const targetPath = path.join(target, file);
      const lstat = fs.lstatSync(sourcePath);

      if (lstat.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = fs.realpathSync(sourcePath);
        } catch {
          logWarn(`[Skills] Skipping unresolvable symlink: ${sourcePath}`);
          continue;
        }
        if (!isPathWithinRoot(realTarget, source)) {
          logWarn(
            `[Skills] Skipping symlink escaping source directory: ${sourcePath} -> ${realTarget}`
          );
          continue;
        }
        const realStat = fs.statSync(sourcePath);
        if (realStat.isDirectory()) {
          this.copyDirectorySyncSafe(realTarget, targetPath);
        } else {
          fs.copyFileSync(sourcePath, targetPath);
        }
      } else if (lstat.isDirectory()) {
        this.copyDirectorySyncSafe(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Recursively copy directory
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    // Remove dangling symlink at target before creating directory
    if (isDanglingSymlink(target)) {
      try {
        fs.unlinkSync(target);
      } catch {
        if (isDanglingSymlink(target)) throw new Error(`Cannot remove dangling symlink: ${target}`);
      }
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const files = fs.readdirSync(source);

    for (const file of files) {
      const sourcePath = path.join(source, file);
      const targetPath = path.join(target, file);
      const lstat = fs.lstatSync(sourcePath);

      if (lstat.isSymbolicLink()) {
        // Resolve symlink and check it stays within source directory
        let realTarget: string;
        try {
          realTarget = fs.realpathSync(sourcePath);
        } catch {
          logWarn(`[Skills] Skipping unresolvable symlink: ${sourcePath}`);
          continue;
        }
        if (!isPathWithinRoot(realTarget, source)) {
          logWarn(
            `[Skills] Skipping symlink escaping source directory: ${sourcePath} -> ${realTarget}`
          );
          continue;
        }
        // Copy the target content instead of recreating the symlink
        const realStat = fs.statSync(sourcePath);
        if (realStat.isDirectory()) {
          await this.copyDirectory(realTarget, targetPath);
        } else {
          fs.copyFileSync(sourcePath, targetPath);
        }
      } else if (lstat.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Install a skill from a directory
   */
  async installSkill(
    skillPath: string,
    options: { scope?: SkillInstallScope; projectPath?: string } = {}
  ): Promise<Skill> {
    const scope: SkillInstallScope = options.scope || 'global';
    // Validate skill folder
    const validation = await this.validateSkillFolder(skillPath);
    if (!validation.valid) {
      throw new Error(`Invalid skill folder: ${validation.errors.join(', ')}`);
    }

    // Get skill metadata
    const metadata = this.getSkillMetadata(skillPath);
    if (!metadata) {
      throw new Error('Failed to read skill metadata from SKILL.md');
    }

    // Validate skill name is safe for filesystem operations
    validateSkillName(metadata.name);

    const rootPath = this.getInstallRoot(scope, options.projectPath);
    const targetPath = path.join(rootPath, metadata.name);

    const normalizedSkillName = metadata.name.toLowerCase();
    for (const [skillId, skill] of this.loadedSkills.entries()) {
      if (skill.name.toLowerCase() === normalizedSkillName && skill.id.startsWith(`${scope}-`)) {
        this.loadedSkills.delete(skillId);
        log(`Removing existing skill: ${skill.name} (${skillId})`);
      }
    }

    if (isDanglingSymlink(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
        log(`Removed dangling symlink at: ${targetPath}`);
      } catch {
        if (isDanglingSymlink(targetPath))
          throw new Error(`Cannot remove dangling symlink: ${targetPath}`);
      }
    } else if (fs.existsSync(targetPath)) {
      // Delete existing directory
      fs.rmSync(targetPath, { recursive: true, force: true });
      log(`Deleted existing skill directory: ${targetPath}`);
    }

    // Copy skill to target scope directory
    await this.copySkillToRoot(skillPath, metadata.name, rootPath);

    const reloadedSkills =
      scope === 'project'
        ? (this.invalidateProjectSkillsCache(), await this.loadProjectSkills(options.projectPath!))
        : (this.invalidateGlobalSkillsCache(), await this.loadGlobalSkills());
    const installedSkill = reloadedSkills.find(
      (skill) => skill.name.toLowerCase() === normalizedSkillName
    );

    if (!installedSkill) {
      throw new Error(`Installed skill not found after reload: ${metadata.name}`);
    }

    // Save canonical skill entry (stable id: <scope>-<folderName>)
    this.saveSkill(installedSkill);

    log(`Installed skill: ${installedSkill.name} (${installedSkill.id})`);
    return installedSkill;
  }

  private deduplicateSkills(skills: Skill[]): Skill[] {
    const byName = new Map<string, Skill>();

    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      const existing = byName.get(key);

      if (!existing) {
        byName.set(key, skill);
        continue;
      }

      if (this.getSkillPriority(skill) > this.getSkillPriority(existing)) {
        byName.set(key, skill);
      }
    }

    return Array.from(byName.values());
  }

  private getSkillPriority(skill: Skill): number {
    if (skill.id.startsWith('project-') || skill.source === 'project') return 3;
    if (skill.id.startsWith('global-') || skill.source === 'global') return 2;
    if (skill.type === 'builtin' || skill.source === 'builtin') return 1;
    return 0;
  }

  async validatePluginFolder(
    pluginRootPath: string
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!fs.existsSync(pluginRootPath)) {
      return { valid: false, errors: ['Path does not exist'] };
    }

    const stat = fs.statSync(pluginRootPath);
    if (!stat.isDirectory()) {
      return { valid: false, errors: ['Path is not a directory'] };
    }

    const skillsRootPath = path.join(pluginRootPath, 'skills');
    if (!fs.existsSync(skillsRootPath) || !fs.statSync(skillsRootPath).isDirectory()) {
      errors.push('Plugin has no installable skills');
      return { valid: false, errors };
    }

    const entries = fs.readdirSync(skillsRootPath, { withFileTypes: true });
    const hasInstallableSkill = entries.some((entry) => {
      if (!entry.isDirectory()) return false;
      const skillMdPath = path.join(skillsRootPath, entry.name, 'SKILL.md');
      return fs.existsSync(skillMdPath);
    });

    if (!hasInstallableSkill) {
      errors.push('Plugin has no installable skills');
    }

    return { valid: errors.length === 0, errors };
  }

  async installPluginFromDirectory(pluginRootPath: string): Promise<PluginInstallResult> {
    const validation = await this.validatePluginFolder(pluginRootPath);
    if (!validation.valid) {
      throw new Error(`Invalid plugin folder: ${validation.errors.join(', ')}`);
    }

    const pluginJsonPath = path.join(pluginRootPath, '.claude-plugin', 'plugin.json');
    let pluginName = path.basename(pluginRootPath);
    try {
      const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')) as PluginManifest;
      pluginName = manifest.name?.trim() || pluginName;
    } catch {
      // ignore, fallback to directory name
    }

    const skillsRootPath = path.join(pluginRootPath, 'skills');
    if (!fs.existsSync(skillsRootPath) || !fs.statSync(skillsRootPath).isDirectory()) {
      throw new Error('Plugin has no installable skills');
    }

    const entries = fs.readdirSync(skillsRootPath, { withFileTypes: true });
    const skillDirs = entries.filter((entry) => entry.isDirectory());
    if (skillDirs.length === 0) {
      throw new Error('Plugin has no installable skills');
    }

    const result: PluginInstallResult = {
      pluginName,
      installedSkills: [],
      skippedSkills: [],
      errors: [],
    };

    for (const skillDir of skillDirs) {
      const skillFolderPath = path.join(skillsRootPath, skillDir.name);
      const skillMdPath = path.join(skillFolderPath, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) {
        result.skippedSkills.push(skillDir.name);
        continue;
      }

      try {
        const installedSkill = await this.installSkill(skillFolderPath);
        result.installedSkills.push(installedSkill.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${skillDir.name}: ${message}`);
      }
    }

    if (result.installedSkills.length === 0 && result.errors.length > 0) {
      throw new Error(`Failed to install plugin skills: ${result.errors.join('; ')}`);
    }

    if (result.installedSkills.length === 0) {
      throw new Error('Plugin has no installable skills');
    }

    log(`Installed plugin skills: ${pluginName} (${result.installedSkills.length} skills)`);
    return result;
  }

  /**
   * Uninstall a skill (delete from filesystem and database)
   */
  async uninstallSkill(skillId: string): Promise<void> {
    const skill = this.loadedSkills.get(skillId);

    if (!skill) {
      throw new Error('Skill not found');
    }

    // Can't delete built-in skills
    if (skill.type === 'builtin') {
      throw new Error('Cannot delete built-in skills');
    }

    // Stop MCP server if running
    await this.stopMcpServer(skillId);

    // Remove from filesystem for managed custom skills.
    if (skill.type === 'custom') {
      // Validate skill name before using it in path construction
      validateSkillName(skill.name);

      const rootPath = skill.id.startsWith('project-')
        ? getProjectSkillsDir(this.loadedProjectPath)
        : getGlobalSkillsDir();
      const skillDir = path.join(rootPath, skill.name);

      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        log(`Deleted skill directory: ${skillDir}`);
      }
    }

    // Remove from loaded skills
    this.loadedSkills.delete(skillId);
    this.invalidateGlobalSkillsCache();
    this.invalidateProjectSkillsCache();

    // Delete from database
    const stmt = this.db.prepare('DELETE FROM skills WHERE id = ?');
    stmt.run(skillId);

    log(`Uninstalled skill: ${skill.name} (${skillId})`);
  }
}
