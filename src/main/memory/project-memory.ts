import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import * as path from 'path';
import { getDatabase } from '../db/database';
import { logWarn } from '../utils/logger';

/**
 * Knowledge types for durable memory
 */
export type KnowledgeType =
  | 'fact'        // Project facts, architecture decisions
  | 'preference'  // User preferences, style choices
  | 'decision'    // Design/implementation decisions
  | 'reference'   // Reference information, links, docs
  | 'project';    // General project knowledge

/**
 * A single knowledge entry (durable cross-session memory)
 */
export interface KnowledgeEntry {
  id: string;
  sessionId: string | null;
  projectPath: string | null;
  type: KnowledgeType;
  title: string;
  content: string;
  importance: number;      // 1-5
  accessCount: number;
  source: 'auto' | 'manual';
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeSource {
  id: string;
  knowledgeId: string;
  sessionId: string;
  messageId: string;
  turnIndex: number;
  role: 'user' | 'assistant';
  timestamp: number;
  snippet: string;
  createdAt: number;
}

export interface KnowledgeSourceCandidate {
  sessionId: string;
  messageId: string;
  turnIndex: number;
  role: 'user' | 'assistant';
  timestamp: number;
  snippet: string;
}

export interface KnowledgeEvidenceResult {
  sources: KnowledgeSource[];
  returnedChars: number;
  maxChars: number;
  truncated: boolean;
}

/**
 * Prompt material built from relevant knowledge
 */
export interface ProjectMemoryPromptMaterial {
  ignoreMemory: boolean;
  promptSections: string[];
  entries: KnowledgeEntry[];
}

const VALID_TYPES = new Set<string>(['fact', 'preference', 'decision', 'reference', 'project']);
const DEFAULT_EVIDENCE_SNIPPETS_CHARS = 3000;
const DEFAULT_EVIDENCE_WINDOW_CHARS = 6000;
const MAX_EVIDENCE_CHARS = 12000;

export function normalizeProjectPath(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.normalize(path.resolve(trimmed));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function tokenizeQuery(query: string): string[] {
  const lowered = query.toLowerCase();
  const asciiTokens = lowered
    .split(/[^a-z0-9_./-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const cjkTokens = lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return Array.from(new Set([...asciiTokens, ...cjkTokens, lowered.trim()].filter(Boolean)));
}

/**
 * ProjectMemoryService - manages durable cross-session knowledge using SQLite + FTS5.
 *
 * Storage: cowork.db → knowledge table + knowledge_fts (FTS5 virtual table)
 * 
 * Replaces the old file-system-based project memory. All knowledge entries are
 * stored in a single SQLite table with full-text search via FTS5.
 */
export class ProjectMemoryService {
  private knowledgeFtsAvailable: boolean | null = null;

  private getDb(): Database.Database {
    return getDatabase().raw;
  }

  private hasKnowledgeFts(): boolean {
    if (this.knowledgeFtsAvailable !== null) {
      return this.knowledgeFtsAvailable;
    }

    try {
      const row = this.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'")
        .get() as { name: string } | undefined;
      this.knowledgeFtsAvailable = Boolean(row);
    } catch {
      this.knowledgeFtsAvailable = false;
    }
    return this.knowledgeFtsAvailable;
  }

  private disableKnowledgeFts(operation: string, error: unknown): void {
    this.knowledgeFtsAvailable = false;
    logWarn(
      `[ProjectMemoryService] Knowledge FTS unavailable during ${operation}; using keyword fallback:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  private getKnowledgeRowId(id: string): number | null {
    const row = this.getDb()
      .prepare('SELECT rowid FROM knowledge WHERE id = ?')
      .get(id) as { rowid: number } | undefined;
    return typeof row?.rowid === 'number' ? row.rowid : null;
  }

  private insertIntoFts(rowid: number, title: string, content: string, tags: string): void {
    if (!this.hasKnowledgeFts()) {
      return;
    }

    try {
      this.getDb()
        .prepare('INSERT INTO knowledge_fts (rowid, title, content, tags) VALUES (?, ?, ?, ?)')
        .run(rowid, title, content, tags);
    } catch (error) {
      this.disableKnowledgeFts('insert', error);
    }
  }

  private deleteFromFts(rowid: number): void {
    if (!this.hasKnowledgeFts()) {
      return;
    }

    try {
      this.getDb().prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(rowid);
    } catch (error) {
      this.disableKnowledgeFts('delete', error);
    }
  }

  shouldIgnoreMemory(userPrompt: string): boolean {
    return /不要用记忆|忽略记忆|别用记忆|不要使用记忆|ignore memory|don't use memory|without memory|no memory/i.test(
      userPrompt
    );
  }

  /**
   * Save a knowledge entry to the database and update FTS index
   */
  saveKnowledge(
    entry: Omit<KnowledgeEntry, 'id' | 'projectPath' | 'accessCount' | 'createdAt' | 'updatedAt'> & {
      projectPath?: string | null;
    }
  ): KnowledgeEntry {
    const db = this.getDb();
    const now = Date.now();
    const knowledge: KnowledgeEntry = {
      id: uuidv4(),
      sessionId: entry.sessionId ?? null,
      projectPath: normalizeProjectPath(entry.projectPath),
      type: entry.type,
      title: entry.title,
      content: entry.content,
      importance: entry.importance ?? 3,
      accessCount: 0,
      source: entry.source ?? 'auto',
      tags: entry.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };

    const stmt = db.prepare(`
      INSERT INTO knowledge (id, session_id, project_path, type, title, content, importance, access_count, source, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      knowledge.id,
      knowledge.sessionId,
      knowledge.projectPath,
      knowledge.type,
      knowledge.title,
      knowledge.content,
      knowledge.importance,
      knowledge.accessCount,
      knowledge.source,
      JSON.stringify(knowledge.tags),
      knowledge.createdAt,
      knowledge.updatedAt
    );

    const rowidFromInsert = Number(result.lastInsertRowid);
    const rowid = Number.isFinite(rowidFromInsert) && rowidFromInsert > 0
      ? rowidFromInsert
      : this.getKnowledgeRowId(knowledge.id);
    if (rowid !== null) {
      this.insertIntoFts(rowid, knowledge.title, knowledge.content, JSON.stringify(knowledge.tags));
    }

    return knowledge;
  }

  /**
   * Update an existing knowledge entry
   */
  updateKnowledge(id: string, updates: Partial<Pick<KnowledgeEntry, 'content' | 'title' | 'importance' | 'type' | 'tags'>>): void {
    const db = this.getDb();
    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.importance !== undefined) {
      setClauses.push('importance = ?');
      values.push(updates.importance);
    }
    if (updates.type !== undefined) {
      setClauses.push('type = ?');
      values.push(updates.type);
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }

    values.push(id);
    db.prepare(`UPDATE knowledge SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    // Rebuild FTS index for this row
    const row = db.prepare('SELECT rowid, title, content, tags FROM knowledge WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (row) {
      this.deleteFromFts(row.rowid as number);
      this.insertIntoFts(
        row.rowid as number,
        row.title as string,
        row.content as string,
        row.tags as string
      );
    }
  }

  /**
   * Increment access count for an entry
   */
  markAccessed(id: string): void {
    this.getDb().prepare('UPDATE knowledge SET access_count = access_count + 1 WHERE id = ?').run(id);
  }

  /**
   * Delete a knowledge entry
   */
  deleteKnowledge(id: string): void {
    const db = this.getDb();
    const row = db.prepare('SELECT rowid FROM knowledge WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (row) {
      this.deleteFromFts(row.rowid);
    }
    db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
  }

  addKnowledgeSources(knowledgeId: string, sources: KnowledgeSourceCandidate[]): void {
    if (sources.length === 0) {
      return;
    }

    const now = Date.now();
    const stmt = this.getDb().prepare(`
      INSERT OR IGNORE INTO knowledge_sources
        (id, knowledge_id, session_id, message_id, turn_index, role, timestamp, snippet, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.getDb().transaction((items: KnowledgeSourceCandidate[]) => {
      for (const source of items) {
        const snippet = cleanSnippet(source.snippet, 600);
        if (!snippet) {
          continue;
        }
        stmt.run(
          uuidv4(),
          knowledgeId,
          source.sessionId,
          source.messageId,
          Math.max(0, Math.floor(source.turnIndex)),
          source.role,
          source.timestamp,
          snippet,
          now
        );
      }
    });
    tx(sources);
  }

  listKnowledgeSources(knowledgeId: string): KnowledgeSource[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM knowledge_sources WHERE knowledge_id = ? ORDER BY timestamp ASC, turn_index ASC')
      .all(knowledgeId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSource(row));
  }

  getKnowledgeEvidence(
    knowledgeId: string,
    options?: { mode?: 'snippets' | 'window'; maxChars?: number; windowTurns?: number }
  ): KnowledgeEvidenceResult {
    const mode = options?.mode === 'window' ? 'window' : 'snippets';
    const maxChars = normalizeEvidenceBudget(
      options?.maxChars,
      mode === 'window' ? DEFAULT_EVIDENCE_WINDOW_CHARS : DEFAULT_EVIDENCE_SNIPPETS_CHARS
    );
    const baseSources = this.listKnowledgeSources(knowledgeId);
    const sources = mode === 'window'
      ? this.buildWindowEvidence(baseSources, options?.windowTurns ?? 2)
      : baseSources;
    return limitEvidenceSources(sources, maxChars);
  }

  /**
   * Get a single knowledge entry by ID
   */
  getKnowledge(id: string): KnowledgeEntry | undefined {
    const row = this.getDb().prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  /**
   * List all knowledge entries, optionally filtered by type
   */
  listKnowledge(projectPath?: string | null, type?: KnowledgeType): KnowledgeEntry[] {
    let sql = 'SELECT * FROM knowledge';
    const params: unknown[] = [];
    const where: string[] = [];
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    if (normalizedProjectPath) {
      where.push('project_path = ?');
      params.push(normalizedProjectPath);
    }
    if (type && VALID_TYPES.has(type)) {
      where.push('type = ?');
      params.push(type);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY importance DESC, updated_at DESC LIMIT 100';
    const rows = this.getDb().prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Search knowledge using FTS5 full-text search
   */
  searchKnowledge(query: string, projectPath?: string | null): KnowledgeEntry[] {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    if (!normalizedProjectPath) {
      return [];
    }
    // Use FTS5 for full-text search
    const ftsSql = `
      SELECT k.*
      FROM knowledge k
      JOIN knowledge_fts fts ON k.rowid = fts.rowid
      WHERE k.project_path = ? AND knowledge_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `;
    try {
      if (!this.hasKnowledgeFts()) {
        return this.fallbackSearch(query, normalizedProjectPath);
      }
      const rows = this.getDb().prepare(ftsSql).all(normalizedProjectPath, this.buildFtsQuery(query)) as Record<string, unknown>[];
      if (rows.length > 0) {
        return rows.map((r) => this.rowToEntry(r));
      }
    } catch (error) {
      this.disableKnowledgeFts('search', error);
      // FTS5 query failed, fall back to simple keyword search
    }

    // Fallback: simple keyword search across content/title
    return this.fallbackSearch(query, normalizedProjectPath);
  }

  /**
   * Build prompt material: search relevant knowledge and inject into prompt sections
   */
  buildPromptMaterial(cwd: string | undefined, userPrompt: string): ProjectMemoryPromptMaterial {
    if (!cwd) {
      return { ignoreMemory: false, promptSections: [], entries: [] };
    }

    const ignoreMemory = this.shouldIgnoreMemory(userPrompt);
    if (ignoreMemory) {
      return { ignoreMemory: true, promptSections: [], entries: [] };
    }

    // Search relevant entries using FTS5
    const projectPath = normalizeProjectPath(cwd);
    const entries = this.searchKnowledge(userPrompt, projectPath);

    // Also include high-importance entries that might be relevant
    const highImportance = this.listKnowledge(projectPath).filter((e) => e.importance >= 4 && !entries.some((m) => m.id === e.id));
    const allEntries = [...entries, ...highImportance].slice(0, 6);

    // Mark accessed
    for (const e of allEntries) {
      this.markAccessed(e.id);
    }

    // Build index summary
    const indexSummary = this.listKnowledge(projectPath)
      .slice(0, 20)
      .map((e) => `- ${e.title} [${e.type}]${e.importance >= 4 ? ' (important)' : ''}`)
      .join('\n');

    // Build relevant entries section
    const relevantSection = allEntries.length > 0
      ? allEntries
          .map(
            (e) =>
              `### ${e.title}\nType: ${e.type} | Importance: ${e.importance}\n${e.content.slice(0, 2000).trim()}`
          )
          .join('\n\n')
      : '';

    return {
      ignoreMemory: false,
      entries: allEntries,
      promptSections: [
        `<project_memory_guidance>
Use project memory only for durable information that cannot be derived from the current repository state.
Ignore project memory when it conflicts with the user's current instruction or with the checked-out code.
Do not treat project memory as a task list, recent diff log, or temporary scratchpad.
Knowledge is stored as structured entries (facts, preferences, decisions, references).
</project_memory_guidance>`,
        `<project_memory_index>\n${indexSummary || '(no indexed knowledge)'}\n</project_memory_index>`,
        relevantSection
          ? `<project_memory_relevant>\n${relevantSection}\n</project_memory_relevant>`
          : '',
      ].filter(Boolean),
    };
  }

  /**
   * Convert a database row to a KnowledgeEntry
   */
  private rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags as string) as string[];
    } catch {
      tags = [];
    }
    return {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      projectPath: (row.project_path as string | null) ?? null,
      type: (row.type as KnowledgeType) ?? 'fact',
      title: (row.title as string) ?? '',
      content: row.content as string,
      importance: (row.importance as number) ?? 3,
      accessCount: (row.access_count as number) ?? 0,
      source: (row.source as 'auto' | 'manual') ?? 'auto',
      tags,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToSource(row: Record<string, unknown>): KnowledgeSource {
    return {
      id: row.id as string,
      knowledgeId: row.knowledge_id as string,
      sessionId: row.session_id as string,
      messageId: row.message_id as string,
      turnIndex: (row.turn_index as number) ?? 0,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      timestamp: (row.timestamp as number) ?? 0,
      snippet: (row.snippet as string) ?? '',
      createdAt: (row.created_at as number) ?? 0,
    };
  }

  private buildWindowEvidence(sources: KnowledgeSource[], windowTurns: number): KnowledgeSource[] {
    const radius = Math.max(0, Math.min(5, Math.floor(windowTurns)));
    const bySession = new Map<string, KnowledgeSource[]>();
    for (const source of sources) {
      const list = bySession.get(source.sessionId) ?? [];
      list.push(source);
      bySession.set(source.sessionId, list);
    }

    const windows: KnowledgeSource[] = [];
    const seen = new Set<string>();
    for (const [sessionId, sessionSources] of bySession) {
      const messages = this.loadSessionMessageSources(sessionId);
      for (const source of sessionSources) {
        const indexById = messages.findIndex((message) => message.messageId === source.messageId);
        const center = indexById >= 0 ? indexById : source.turnIndex;
        const start = Math.max(0, center - radius);
        const end = Math.min(messages.length - 1, center + radius);
        for (let index = start; index <= end; index++) {
          const message = messages[index];
          const key = `${source.knowledgeId}:${message.messageId}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          windows.push({
            id: `${source.id}:${message.messageId}`,
            knowledgeId: source.knowledgeId,
            sessionId,
            messageId: message.messageId,
            turnIndex: index,
            role: message.role,
            timestamp: message.timestamp,
            snippet: message.snippet,
            createdAt: source.createdAt,
          });
        }
      }
    }
    return windows.sort((a, b) => a.timestamp - b.timestamp || a.turnIndex - b.turnIndex);
  }

  private loadSessionMessageSources(sessionId: string): KnowledgeSourceCandidate[] {
    const rows = this.getDb()
      .prepare('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as Array<{ id: string; role: string; content: string; timestamp: number }>;

    const result: KnowledgeSourceCandidate[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (row.role !== 'user' && row.role !== 'assistant') {
        continue;
      }
      const snippet = cleanSnippet(extractMessageTextFromStoredContent(row.content), 1200);
      if (!snippet) {
        continue;
      }
      result.push({
        sessionId,
        messageId: row.id,
        turnIndex: index,
        role: row.role,
        timestamp: row.timestamp,
        snippet,
      });
    }
    return result;
  }

  /**
   * Build an FTS5 query string from user input
   */
  private buildFtsQuery(query: string): string {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return '""';
    // Escape special FTS5 characters and join with OR
    const escaped = tokens.map((t) => {
      const sanitized = t.replace(/['"*^()~:+-]/g, '');
      return sanitized ? `"${sanitized}"` : '';
    }).filter(Boolean);
    return escaped.join(' OR ');
  }

  /**
   * Fallback keyword search when FTS5 fails
   */
  private fallbackSearch(query: string, projectPath: string): KnowledgeEntry[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const all = this.listKnowledge(projectPath);
    return all
      .map((entry) => {
        const haystack = `${entry.title}\n${entry.content}`.toLowerCase();
        const score = tokens.reduce((sum, t) => sum + (haystack.includes(t) ? 1 : 0), 0);
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.importance - a.entry.importance)
      .slice(0, 5)
      .map((item) => item.entry);
  }
}

function normalizeEvidenceBudget(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) {
    return fallback;
  }
  return Math.max(500, Math.min(MAX_EVIDENCE_CHARS, Math.floor(value as number)));
}

function limitEvidenceSources(sources: KnowledgeSource[], maxChars: number): KnowledgeEvidenceResult {
  const limited: KnowledgeSource[] = [];
  let returnedChars = 0;
  let truncated = false;

  for (const source of sources) {
    const remaining = maxChars - returnedChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    let snippet = source.snippet.trim();
    if (!snippet) {
      continue;
    }
    if (snippet.length > remaining) {
      snippet = `${snippet.slice(0, Math.max(0, remaining - 16)).trimEnd()}\n...[truncated]`;
      truncated = true;
    }
    returnedChars += snippet.length;
    limited.push({ ...source, snippet });

    if (truncated) {
      break;
    }
  }

  return {
    sources: limited,
    returnedChars,
    maxChars,
    truncated: truncated || limited.length < sources.length,
  };
}

function cleanSnippet(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n...[truncated]`;
}

function extractMessageTextFromStoredContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    return blocks
      .map((block) => {
        if (typeof block !== 'object' || block === null || !('type' in block)) {
          return '';
        }
        const record = block as Record<string, unknown>;
        if (record.type === 'text') {
          return typeof record.text === 'string' ? record.text : '';
        }
        if (record.type === 'tool_use') {
          return typeof record.name === 'string' ? `[tool_use: ${record.name}]` : '[tool_use]';
        }
        if (record.type === 'tool_result') {
          return typeof record.content === 'string' ? `[tool_result]\n${record.content.slice(0, 500)}` : '[tool_result]';
        }
        if (record.type === 'file_attachment') {
          const filename = typeof record.filename === 'string' ? record.filename : 'file';
          const relativePath = typeof record.relativePath === 'string' ? record.relativePath : '';
          return `[file_attachment] ${filename}${relativePath ? ` (${relativePath})` : ''}`;
        }
        if (record.type === 'image') {
          return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}
