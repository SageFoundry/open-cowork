import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory storage
const store = new Map<string, Record<string, unknown>>();
const sourceStore = new Map<string, Record<string, unknown>>();
const messageRows: Array<Record<string, unknown>> = [];
let rowIdCounter = 1;
let ftsAvailable = true;
const PROJECT_PATH = 'e:\\workspace\\project-a';
const OTHER_PROJECT_PATH = 'e:\\workspace\\project-b';

// Make the default prepare return a callable
const defaultRun = (..._args: unknown[]) => ({ lastInsertRowid: ++rowIdCounter });
const defaultGet = (..._args: unknown[]) => undefined;
const defaultAll = (..._args: unknown[]) => [];

function mockPrepare(sql: string): {
  run: (...args: unknown[]) => { lastInsertRowid?: number };
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  all: (...args: unknown[]) => Record<string, unknown>[];
} {
  // FTS5 availability check
  if (/sqlite_master/i.test(sql) && /knowledge_fts/i.test(sql)) {
    return {
      run: defaultRun,
      get: () => (ftsAvailable ? { name: 'knowledge_fts' } : undefined),
      all: defaultAll,
    };
  }

  // INSERT INTO knowledge (may have leading whitespace/newlines from template literals)
  if (/INSERT INTO knowledge\b/i.test(sql.trim())) {
    return {
      run: (...params: unknown[]) => {
        const record: Record<string, unknown> = {
          id: params[0] as string,
          session_id: params[1] as string | null,
          project_path: params[2] as string | null,
          type: params[3] as string,
          title: params[4] as string,
          content: params[5] as string,
          importance: params[6] as number,
          access_count: params[7] as number,
          source: params[8] as string,
          tags: params[9] as string,
          created_at: params[10] as number,
          updated_at: params[11] as number,
          rowid: rowIdCounter,
        };
        store.set(record.id as string, record);
        rowIdCounter++;
        return { lastInsertRowid: record.rowid as number };
      },
      get: defaultGet,
      all: defaultAll,
    };
  }

  // INSERT INTO knowledge_fts
  if (/INSERT INTO knowledge_fts/i.test(sql.trim())) {
    return {
      run: (...args: unknown[]) => {
        if (!ftsAvailable) throw new Error('no such table: knowledge_fts');
        return defaultRun(...args);
      },
      get: defaultGet,
      all: defaultAll,
    };
  }

  // INSERT INTO knowledge_sources
  if (/INSERT OR IGNORE INTO knowledge_sources/i.test(sql.trim())) {
    return {
      run: (...params: unknown[]) => {
        const knowledgeId = params[1] as string;
        const messageId = params[3] as string;
        const duplicate = Array.from(sourceStore.values()).some(
          (record) => record.knowledge_id === knowledgeId && record.message_id === messageId
        );
        if (!duplicate) {
          sourceStore.set(params[0] as string, {
            id: params[0] as string,
            knowledge_id: knowledgeId,
            session_id: params[2] as string,
            message_id: messageId,
            turn_index: params[4] as number,
            role: params[5] as string,
            timestamp: params[6] as number,
            snippet: params[7] as string,
            created_at: params[8] as number,
          });
        }
        return {};
      },
      get: defaultGet,
      all: defaultAll,
    };
  }

  // SELECT * FROM knowledge_sources WHERE knowledge_id = ?
  if (/SELECT \* FROM knowledge_sources/i.test(sql.trim())) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: (...params: unknown[]) => {
        const knowledgeId = params[0] as string;
        return Array.from(sourceStore.values())
          .filter((record) => record.knowledge_id === knowledgeId)
          .sort((a, b) => (a.timestamp as number) - (b.timestamp as number) || (a.turn_index as number) - (b.turn_index as number));
      },
    };
  }

  // SELECT id, role, content, timestamp FROM messages WHERE session_id = ?
  if (/SELECT id, role, content, timestamp FROM messages/i.test(sql.trim())) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: (...params: unknown[]) => {
        const sessionId = params[0] as string;
        return messageRows
          .filter((record) => record.session_id === sessionId)
          .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
      },
    };
  }

  // DELETE FROM knowledge_fts
  if (/DELETE FROM knowledge_fts/i.test(sql.trim())) {
    return {
      run: (...args: unknown[]) => {
        if (!ftsAvailable) throw new Error('no such table: knowledge_fts');
        return defaultRun(...args);
      },
      get: defaultGet,
      all: defaultAll,
    };
  }

  // DELETE FROM knowledge WHERE id = ?
  if (/DELETE FROM knowledge WHERE/i.test(sql.trim()) && /id/i.test(sql)) {
    return {
      run: (...params: unknown[]) => {
        const id = params[0] as string;
        store.delete(id);
        for (const [sourceId, source] of sourceStore) {
          if (source.knowledge_id === id) {
            sourceStore.delete(sourceId);
          }
        }
        return {};
      },
      get: defaultGet,
      all: defaultAll,
    };
  }

  // UPDATE knowledge SET ... WHERE id = ?
  if (/UPDATE knowledge SET/i.test(sql.trim())) {
    return {
      run: (...params: unknown[]) => {
        const id = params[params.length - 1] as string;
        const record = store.get(id);
        if (!record) return {};
        // Parse SET column=value pairs from params (except last which is id)
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
        if (setMatch) {
          const cols = setMatch[1].split(',').map((c) => c.trim().split(/\s*=\s*/)[0].trim());
          for (let i = 0; i < cols.length; i++) {
            const val = params[i];
            if (val !== undefined) {
              record[cols[i]] = val;
            }
          }
        }
        return {};
      },
      get: defaultGet,
      all: defaultAll,
    };
  }

  // SELECT rowid FROM knowledge WHERE id = ?
  if (/SELECT rowid FROM knowledge/i.test(sql.trim())) {
    return {
      run: defaultRun,
      get: (...params: unknown[]) => {
        const id = params[0] as string;
        const record = store.get(id);
        return record ? { rowid: record.rowid as number } : undefined;
      },
      all: defaultAll,
    };
  }

  // SELECT * FROM knowledge WHERE id = ? (getKnowledge)
  if (/^SELECT \*/i.test(sql.trim()) && /WHERE id/i.test(sql)) {
    return {
      run: defaultRun,
      get: (...params: unknown[]) => store.get(params[0] as string),
      all: defaultAll,
    };
  }

  // SELECT * FROM knowledge ORDER BY (listKnowledge - no WHERE, no type filter)
  if (/^SELECT \*/i.test(sql.trim()) && /ORDER BY/i.test(sql) && !/WHERE/i.test(sql)) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: () =>
        Array.from(store.values())
          .sort(
            (a, b) => (b.importance as number) - (a.importance as number) || (b.updated_at as number) - (a.updated_at as number)
          )
          .slice(0, 100),
    };
  }

  // SELECT * FROM knowledge WHERE project_path = ? (listKnowledge with project filter)
  if (/^SELECT \*/i.test(sql.trim()) && /WHERE project_path/i.test(sql) && !/\btype\b/i.test(sql)) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: (...params: unknown[]) => {
        const projectPath = params[0] as string;
        return Array.from(store.values())
          .filter((r) => r.project_path === projectPath)
          .sort(
            (a, b) => (b.importance as number) - (a.importance as number) || (b.updated_at as number) - (a.updated_at as number)
          )
          .slice(0, 100);
      },
    };
  }

  // SELECT * FROM knowledge WHERE type = ? (listKnowledge with type filter)
  // ⚠️ Must come BEFORE generic "SELECT * FROM knowledge" check
  if (/^SELECT \*/i.test(sql.trim()) && /WHERE/i.test(sql) && /type/i.test(sql)) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: (...params: unknown[]) => {
        const hasProjectFilter = /project_path/i.test(sql);
        const projectPath = hasProjectFilter ? (params[0] as string) : undefined;
        const type = params[hasProjectFilter ? 1 : 0] as string;
        return Array.from(store.values())
          .filter((r) => (!projectPath || r.project_path === projectPath) && r.type === type)
          .sort(
            (a, b) => (b.importance as number) - (a.importance as number) || (b.updated_at as number) - (a.updated_at as number)
          )
          .slice(0, 100);
      },
    };
  }

  // SELECT k.* FROM knowledge k JOIN knowledge_fts (FTS5 search)
  if (/JOIN knowledge_fts/i.test(sql)) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: (...params: unknown[]) => {
        if (!ftsAvailable) throw new Error('no such table: knowledge_fts');
        const projectPath = params[0] as string;
        const query = params[1] as string;
        const terms = query
          .toLowerCase()
          .split(' OR ')
          .map((t) => t.replace(/"/g, ''));
        return Array.from(store.values())
          .filter((record) => {
            const haystack = `${record.title} ${record.content} ${record.tags}`.toLowerCase();
            return record.project_path === projectPath && terms.some((term) => term && haystack.includes(term));
          })
          .slice(0, 10);
      },
    };
  }

  // Default fallback
  return { run: defaultRun, get: defaultGet, all: defaultAll };
}

vi.mock('../../main/db/database', () => ({
  getDatabase: () => ({
    raw: {
      prepare: (sql: string) => mockPrepare(sql),
      exec: () => {},
      transaction: (fn: (...args: any[]) => any) => (...args: any[]) => fn(...args),
    },
  }),
}));

const { ProjectMemoryService } = await import('../../main/memory/project-memory');

describe('ProjectMemoryService', () => {
  beforeEach(() => {
    store.clear();
    sourceStore.clear();
    messageRows.length = 0;
    rowIdCounter = 1;
    ftsAvailable = true;
  });

  it('saves and retrieves knowledge entries', () => {
    const service = new ProjectMemoryService();

    const entry = service.saveKnowledge({
      sessionId: null,
      projectPath: PROJECT_PATH,
      type: 'preference',
      title: 'Alice Preferences',
      content: 'Alice prefers concise progress updates and wants implementation notes to stay brief.',
      importance: 4,
      source: 'auto',
      tags: ['alice', 'writing-style'],
    });

    expect(entry.id).toBeTruthy();
    expect(entry.type).toBe('preference');
    expect(entry.title).toBe('Alice Preferences');
    expect(entry.accessCount).toBe(0);
    expect(entry.importance).toBe(4);
    expect(entry.source).toBe('auto');

    const retrieved = service.getKnowledge(entry.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.title).toBe('Alice Preferences');
    expect(retrieved!.content).toContain('concise progress updates');
  });

  it('searches knowledge using FTS5', () => {
    const service = new ProjectMemoryService();

    service.saveKnowledge({
      sessionId: null,
      projectPath: PROJECT_PATH,
      type: 'preference',
      title: 'Alice Preferences',
      content: 'Alice prefers concise progress updates and brief implementation notes.',
      importance: 3,
      source: 'auto',
      tags: [],
    });

    service.saveKnowledge({
      sessionId: null,
      projectPath: PROJECT_PATH,
      type: 'decision',
      title: 'DB Schema Decision',
      content: 'Decided to use SQLite FTS5 for full-text search over file-system grep.',
      importance: 5,
      source: 'auto',
      tags: ['database', 'search'],
    });

    const results = service.searchKnowledge('FTS5', PROJECT_PATH);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === 'DB Schema Decision')).toBe(true);

    const results2 = service.searchKnowledge('prefers concise', PROJECT_PATH);
    expect(results2.some((r) => r.title === 'Alice Preferences')).toBe(true);
  });

  it('returns relevant knowledge in buildPromptMaterial', () => {
    const service = new ProjectMemoryService();

    service.saveKnowledge({
      sessionId: null,
      projectPath: '/some/workspace',
      type: 'preference',
      title: 'Alice Preferences',
      content: 'Alice prefers concise progress updates.',
      importance: 3,
      source: 'auto',
      tags: [],
    });

    const material = service.buildPromptMaterial('/some/workspace', 'Please remember Alice preferences');

    expect(material.ignoreMemory).toBe(false);
    expect(material.entries.length).toBeGreaterThanOrEqual(1);
    expect(material.entries.some((e) => e.title === 'Alice Preferences')).toBe(true);

    const joined = material.promptSections.join('\n');
    expect(joined).toContain('Alice Preferences');
    expect(joined).toContain('project_memory_guidance');
    expect(joined).toContain('project_memory_relevant');
    expect(joined).not.toContain('project_memory_index');
  });

  it('skips memory injection when user asks to ignore memory', () => {
    const service = new ProjectMemoryService();
    const material = service.buildPromptMaterial('/some/workspace', '这轮请忽略记忆，只看当前仓库');
    expect(material.ignoreMemory).toBe(true);
    expect(material.promptSections).toEqual([]);
    expect(material.entries).toEqual([]);
  });

  it('updates and deletes knowledge entries', () => {
    const service = new ProjectMemoryService();

    const entry = service.saveKnowledge({
      sessionId: null,
      projectPath: PROJECT_PATH,
      type: 'fact',
      title: 'Test Fact',
      content: 'Original content.',
      importance: 3,
      source: 'auto',
      tags: [],
    });

    service.updateKnowledge(entry.id, { content: 'Updated content.' });
    const updated = service.getKnowledge(entry.id);
    expect(updated).toBeDefined();
    expect(updated!.content).toBe('Updated content.');

    service.deleteKnowledge(entry.id);
    const deleted = service.getKnowledge(entry.id);
    expect(deleted).toBeUndefined();
  });

  it('lists knowledge by type', () => {
    const service = new ProjectMemoryService();

    service.saveKnowledge({ sessionId: null, projectPath: PROJECT_PATH, type: 'fact', title: 'Fact 1', content: 'x', importance: 3, source: 'auto', tags: [] });
    service.saveKnowledge({ sessionId: null, projectPath: PROJECT_PATH, type: 'preference', title: 'Pref 1', content: 'y', importance: 3, source: 'auto', tags: [] });
    service.saveKnowledge({ sessionId: null, projectPath: OTHER_PROJECT_PATH, type: 'decision', title: 'Dec 1', content: 'z', importance: 3, source: 'auto', tags: [] });

    const facts = service.listKnowledge(PROJECT_PATH, 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].title).toBe('Fact 1');

    const all = service.listKnowledge(PROJECT_PATH);
    expect(all).toHaveLength(2);
    expect(all.some((entry) => entry.title === 'Dec 1')).toBe(false);
  });

  it('saves and searches with keyword fallback when FTS5 is unavailable', () => {
    ftsAvailable = false;
    const service = new ProjectMemoryService();

    const entry = service.saveKnowledge({
      sessionId: null,
      projectPath: PROJECT_PATH,
      type: 'fact',
      title: 'Fallback Memory',
      content: 'Keyword search should still work when the FTS table is absent.',
      importance: 3,
      source: 'auto',
      tags: [],
    });

    expect(service.getKnowledge(entry.id)?.title).toBe('Fallback Memory');
    expect(service.searchKnowledge('keyword absent', PROJECT_PATH).some((r) => r.id === entry.id)).toBe(true);
  });

  it('stores bounded source evidence and dedupes repeated message bindings', () => {
    const service = new ProjectMemoryService();
    const entry = service.saveKnowledge({
      sessionId: 'session-1',
      projectPath: PROJECT_PATH,
      type: 'decision',
      title: 'Evidence test',
      content: 'Memory should point back to source evidence.',
      importance: 4,
      source: 'manual',
      tags: [],
    });

    service.addKnowledgeSources(entry.id, [
      {
        sessionId: 'session-1',
        messageId: 'message-1',
        turnIndex: 2,
        role: 'user',
        timestamp: 10,
        snippet: '用户确认记忆需要能回查来源对话。'.repeat(80),
      },
      {
        sessionId: 'session-1',
        messageId: 'message-1',
        turnIndex: 2,
        role: 'user',
        timestamp: 10,
        snippet: '重复来源不应再次写入。',
      },
    ]);

    const evidence = service.getKnowledgeEvidence(entry.id, { mode: 'snippets', maxChars: 500 });
    expect(service.listKnowledgeSources(entry.id)).toHaveLength(1);
    expect(evidence.returnedChars).toBeLessThanOrEqual(500);
    expect(evidence.truncated).toBe(true);
  });

  it('returns a small history window around evidence sources', () => {
    const service = new ProjectMemoryService();
    const entry = service.saveKnowledge({
      sessionId: 'session-1',
      projectPath: PROJECT_PATH,
      type: 'decision',
      title: 'Window test',
      content: 'Evidence windows should stay local.',
      importance: 4,
      source: 'manual',
      tags: [],
    });
    for (let i = 0; i < 6; i++) {
      messageRows.push({
        id: `message-${i}`,
        session_id: 'session-1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: JSON.stringify([{ type: 'text', text: `message text ${i}` }]),
        timestamp: i,
      });
    }
    service.addKnowledgeSources(entry.id, [{
      sessionId: 'session-1',
      messageId: 'message-3',
      turnIndex: 3,
      role: 'assistant',
      timestamp: 3,
      snippet: 'center',
    }]);

    const evidence = service.getKnowledgeEvidence(entry.id, { mode: 'window', maxChars: 6000, windowTurns: 1 });
    expect(evidence.sources.map((source) => source.messageId)).toEqual(['message-2', 'message-3', 'message-4']);
    expect(evidence.sources.every((source) => source.sessionId === 'session-1')).toBe(true);
  });
});
