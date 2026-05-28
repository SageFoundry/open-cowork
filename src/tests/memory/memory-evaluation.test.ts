import { describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../../main/memory/project-memory';
import {
  applyMemoryActions,
  buildCandidateEvaluationAction,
  buildKnowledgeSourceCandidates,
  buildMemoryExtractionPrompt,
  parseMemoryEvaluationResponse,
} from '../../main/memory/memory-evaluation';

const existingDecision: KnowledgeEntry = {
  id: 'existing-1',
  sessionId: 'session-1',
  projectPath: 'e:\\workspace\\project-a',
  type: 'decision',
  title: 'Memory storage decision',
  content: 'Project memory is stored in SQLite knowledge tables with FTS5 search.',
  importance: 5,
  accessCount: 0,
  source: 'manual',
  tags: ['memory', 'sqlite'],
  createdAt: 1,
  updatedAt: 1,
};

describe('memory evaluation', () => {
  it('builds model extraction prompts with existing memory to prevent duplicates', () => {
    const prompt = buildMemoryExtractionPrompt(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: '好了，记忆系统全部存 SQLite，用 knowledge 表和 FTS5 做查询。' }],
        },
      ],
      [existingDecision]
    );

    expect(prompt.systemPrompt).toContain('已有记忆对比');
    expect(prompt.prompt).toContain('existing-1');
    expect(prompt.prompt).toContain('SQLite knowledge tables');
    expect(prompt.prompt).toContain('好了，记忆系统全部存 SQLite');
  });

  it('parses and sanitizes model action JSON', () => {
    const actions = parseMemoryEvaluationResponse(`
      {"actions":[
        {"action":"create","type":"decision","title":"DB choice","content":"Use SQLite knowledge table.","importance":9,"tags":["Memory System"],"reason":"stable decision"},
        {"action":"ignore","reason":"duplicate"}
      ]}
    `);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      action: 'create',
      type: 'decision',
      title: 'DB choice',
      importance: 5,
      tags: ['memory-system'],
    });
    expect(actions[1]).toMatchObject({ action: 'ignore' });
  });

  it('returns no actions for invalid model JSON', () => {
    expect(parseMemoryEvaluationResponse('not json')).toEqual([]);
    expect(parseMemoryEvaluationResponse('{"items":[]}')).toEqual([]);
  });

  it('ignores autonomous candidates when autoMemory is disabled', () => {
    const action = buildCandidateEvaluationAction(
      {
        trigger: 'autonomous_high_value',
        type: 'decision',
        title: 'Architecture decision',
        content: '关键决策：memory uses SQLite as the durable storage layer.',
        importance: 5,
      },
      [],
      false
    );

    expect(action.action).toBe('ignore');
    expect(action.reason).toContain('autoMemory is disabled');
  });

  it('ignores low-value autonomous candidates when autoMemory is enabled', () => {
    const action = buildCandidateEvaluationAction(
      {
        trigger: 'autonomous_high_value',
        type: 'fact',
        title: 'Temporary error',
        content: '当前任务里刚才出现了一个日志报错。',
        importance: 4,
      },
      [],
      true
    );

    expect(action.action).toBe('ignore');
    expect(action.reason).toContain('strict autonomous memory threshold');
  });

  it('updates similar existing memory instead of creating a duplicate', () => {
    const action = buildCandidateEvaluationAction(
      {
        trigger: 'explicit_user_request',
        type: 'decision',
        title: 'Memory storage decision',
        content: 'Project memory is stored in SQLite knowledge tables with FTS5 search and should not use embeddings for now.',
        importance: 5,
        tags: ['no-embedding'],
      },
      [existingDecision],
      false
    );

    expect(action.action).toBe('update');
    expect(action.existingId).toBe('existing-1');
    expect(action.content).toContain('should not use embeddings');
    expect(action.tags).toContain('sqlite');
    expect(action.tags).toContain('no-embedding');
  });

  it('apply layer ignores duplicate create actions', () => {
    const entries = [structuredClone(existingDecision)];
    const service = createFakeMemoryService(entries);

    const applied = applyMemoryActions(
      service,
      [
        {
          action: 'create',
          type: 'decision',
          title: 'Memory storage decision',
          content: 'Project memory is stored in SQLite knowledge tables with FTS5 search.',
          importance: 5,
          tags: ['memory'],
        },
      ],
      { sessionId: 'session-1', projectPath: existingDecision.projectPath, source: 'manual' }
    );

    expect(applied.created).toBe(0);
    expect(applied.updated).toBe(0);
    expect(applied.ignored).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it('apply layer converts similar create actions into updates', () => {
    const entries = [structuredClone(existingDecision)];
    const service = createFakeMemoryService(entries);

    const applied = applyMemoryActions(
      service,
      [
        {
          action: 'create',
          type: 'decision',
          title: 'Memory storage decision',
          content: 'Project memory is stored in SQLite knowledge tables with FTS5 search and should not use embeddings for now.',
          importance: 5,
          tags: ['no-embedding'],
        },
      ],
      { sessionId: 'session-1', projectPath: existingDecision.projectPath, source: 'manual' }
    );

    expect(applied.created).toBe(0);
    expect(applied.updated).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('should not use embeddings');
    expect(entries[0].tags).toContain('no-embedding');
  });

  it('builds source candidates from persisted messages', () => {
    const sources = buildKnowledgeSourceCandidates([
      {
        id: 'message-1',
        sessionId: 'session-1',
        role: 'user',
        timestamp: 10,
        content: [{ type: 'text', text: '请记住这个项目约定。' }],
      },
      {
        id: 'message-2',
        sessionId: 'session-1',
        role: 'system',
        timestamp: 11,
        content: [{ type: 'text', text: 'hidden' }],
      },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-1',
      turnIndex: 0,
      role: 'user',
    });
    expect(sources[0].snippet).toContain('项目约定');
  });
});

function createFakeMemoryService(entries: KnowledgeEntry[]) {
  return {
    listKnowledge: () => entries,
    getKnowledge: (id: string) => entries.find((entry) => entry.id === id),
    updateKnowledge: (id: string, updates: Partial<KnowledgeEntry>) => {
      const entry = entries.find((item) => item.id === id);
      if (entry) {
        Object.assign(entry, updates, { updatedAt: Date.now() });
      }
    },
    saveKnowledge: (entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => {
      const saved: KnowledgeEntry = {
        ...entry,
        id: `new-${entries.length + 1}`,
        accessCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      entries.push(saved);
      return saved;
    },
    addKnowledgeSources: () => undefined,
  } as any;
}
