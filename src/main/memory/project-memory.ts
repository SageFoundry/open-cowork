import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getDatabase } from '../db/database';

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

/**
 * Prompt material built from relevant knowledge
 */
export interface ProjectMemoryPromptMaterial {
  ignoreMemory: boolean;
  promptSections: string[];
  entries: KnowledgeEntry[];
}

const VALID_TYPES = new Set<string>(['fact', 'preference', 'decision', 'reference', 'project']);

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
  private getDb(): Database.Database {
    return getDatabase().raw;
  }

  shouldIgnoreMemory(userPrompt: string): boolean {
    return /不要用记忆|忽略记忆|别用记忆|不要使用记忆|ignore memory|don't use memory|without memory|no memory/i.test(
      userPrompt
    );
  }

  /**
   * Save a knowledge entry to the database and update FTS index
   */
  saveKnowledge(entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): KnowledgeEntry {
    const db = this.getDb();
    const now = Date.now();
    const knowledge: KnowledgeEntry = {
      id: uuidv4(),
      sessionId: entry.sessionId ?? null,
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
      INSERT INTO knowledge (id, session_id, type, title, content, importance, access_count, source, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      knowledge.id,
      knowledge.sessionId,
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

    // Sync to FTS5 index
    db.exec(`
      INSERT INTO knowledge_fts (rowid, title, content, tags)
      VALUES (last_insert_rowid(), '${knowledge.title.replace(/'/g, "''")}', '${knowledge.content.replace(/'/g, "''")}', '${JSON.stringify(knowledge.tags).replace(/'/g, "''")}')
    `);

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
      db.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(row.rowid);
      db.prepare(`INSERT INTO knowledge_fts (rowid, title, content, tags) VALUES (?, ?, ?, ?)`).run(
        row.rowid,
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
      db.prepare('DELETE FROM knowledge_fts WHERE rowid = ?').run(row.rowid);
    }
    db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
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
  listKnowledge(type?: KnowledgeType): KnowledgeEntry[] {
    let sql = 'SELECT * FROM knowledge';
    const params: unknown[] = [];
    if (type && VALID_TYPES.has(type)) {
      sql += ' WHERE type = ?';
      params.push(type);
    }
    sql += ' ORDER BY importance DESC, updated_at DESC LIMIT 100';
    const rows = this.getDb().prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Search knowledge using FTS5 full-text search
   */
  searchKnowledge(query: string): KnowledgeEntry[] {
    // Use FTS5 for full-text search
    const ftsSql = `
      SELECT k.*
      FROM knowledge k
      JOIN knowledge_fts fts ON k.rowid = fts.rowid
      WHERE knowledge_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `;
    try {
      const rows = this.getDb().prepare(ftsSql).all(this.buildFtsQuery(query)) as Record<string, unknown>[];
      if (rows.length > 0) {
        return rows.map((r) => this.rowToEntry(r));
      }
    } catch {
      // FTS5 query failed, fall back to simple keyword search
    }

    // Fallback: simple keyword search across content/title
    return this.fallbackSearch(query);
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
    const entries = this.searchKnowledge(userPrompt);

    // Also include high-importance entries that might be relevant
    const highImportance = this.listKnowledge().filter((e) => e.importance >= 4 && !entries.some((m) => m.id === e.id));
    const allEntries = [...entries, ...highImportance].slice(0, 6);

    // Mark accessed
    for (const e of allEntries) {
      this.markAccessed(e.id);
    }

    // Build index summary
    const indexSummary = this.listKnowledge()
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
  private fallbackSearch(query: string): KnowledgeEntry[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const all = this.listKnowledge();
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
