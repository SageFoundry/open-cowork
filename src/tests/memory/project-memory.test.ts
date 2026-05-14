import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory storage
const store = new Map<string, Record<string, unknown>>();
let rowIdCounter = 1;

// Make the default prepare return a callable
const defaultRun = (..._args: unknown[]) => ({ lastInsertRowid: ++rowIdCounter });
const defaultGet = (..._args: unknown[]) => undefined;
const defaultAll = (..._args: unknown[]) => [];

function mockPrepare(sql: string): {
  run: (...args: unknown[]) => { lastInsertRowid?: number };
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
  all: (...args: unknown[]) => Record<string, unknown>[];
} {
  // INSERT INTO knowledge (may have leading whitespace/newlines from template literals)
  if (/INSERT INTO knowledge\b/i.test(sql.trim())) {
    return {
      run: (...params: unknown[]) => {
        const record: Record<string, unknown> = {
          id: params[0] as string,
          session_id: params[1] as string | null,
          type: params[2] as string,
          title: params[3] as string,
          content: params[4] as string,
          importance: params[5] as number,
          access_count: params[6] as number,
          source: params[7] as string,
          tags: params[8] as string,
          created_at: params[9] as number,
          updated_at: params[10] as number,
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
    return { run: defaultRun, get: defaultGet, all: defaultAll };
  }

  // DELETE FROM knowledge_fts
  if (/DELETE FROM knowledge_fts/i.test(sql.trim())) {
    return { run: defaultRun, get: defaultGet, all: defaultAll };
  }

  // DELETE FROM knowledge WHERE id = ?
  if (/DELETE FROM knowledge WHERE/i.test(sql.trim()) && /id/i.test(sql)) {
    return {
      run: (...params: unknown[]) => {
        store.delete(params[0] as string);
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

  // SELECT * FROM knowledge WHERE type = ? (listKnowledge with type filter)
  // ⚠️ Must come BEFORE generic "SELECT * FROM knowledge" check
  if (/^SELECT \*/i.test(sql.trim()) && /WHERE type/i.test(sql)) {
    return {
      run: defaultRun,
      get: defaultGet,
      all: (...params: unknown[]) => {
        const type = params[0] as string;
        return Array.from(store.values())
          .filter((r) => r.type === type)
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
        const query = params[0] as string;
        const terms = query
          .toLowerCase()
          .split(' OR ')
          .map((t) => t.replace(/"/g, ''));
        return Array.from(store.values())
          .filter((record) => {
            const haystack = `${record.title} ${record.content} ${record.tags}`.toLowerCase();
            return terms.some((term) => term && haystack.includes(term));
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
    },
  }),
}));

const { ProjectMemoryService } = await import('../../main/memory/project-memory');

describe('ProjectMemoryService', () => {
  beforeEach(() => {
    store.clear();
    rowIdCounter = 1;
  });

  it('saves and retrieves knowledge entries', () => {
    const service = new ProjectMemoryService();

    const entry = service.saveKnowledge({
      sessionId: null,
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
      type: 'preference',
      title: 'Alice Preferences',
      content: 'Alice prefers concise progress updates and brief implementation notes.',
      importance: 3,
      source: 'auto',
      tags: [],
    });

    service.saveKnowledge({
      sessionId: null,
      type: 'decision',
      title: 'DB Schema Decision',
      content: 'Decided to use SQLite FTS5 for full-text search over file-system grep.',
      importance: 5,
      source: 'auto',
      tags: ['database', 'search'],
    });

    const results = service.searchKnowledge('FTS5');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === 'DB Schema Decision')).toBe(true);

    const results2 = service.searchKnowledge('prefers concise');
    expect(results2.some((r) => r.title === 'Alice Preferences')).toBe(true);
  });

  it('returns relevant knowledge in buildPromptMaterial', () => {
    const service = new ProjectMemoryService();

    service.saveKnowledge({
      sessionId: null,
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
    expect(joined).toContain('project_memory_index');
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

    service.saveKnowledge({ sessionId: null, type: 'fact', title: 'Fact 1', content: 'x', importance: 3, source: 'auto', tags: [] });
    service.saveKnowledge({ sessionId: null, type: 'preference', title: 'Pref 1', content: 'y', importance: 3, source: 'auto', tags: [] });
    service.saveKnowledge({ sessionId: null, type: 'decision', title: 'Dec 1', content: 'z', importance: 3, source: 'auto', tags: [] });

    const facts = service.listKnowledge('fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].title).toBe('Fact 1');

    const all = service.listKnowledge();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});
