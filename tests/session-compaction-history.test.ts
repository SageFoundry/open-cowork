import { describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance, CompactionSnapshotRow } from '../src/main/db/database';
import { SessionManager } from '../src/main/session/session-manager';

vi.mock('../src/main/claude/agent-runner', () => ({
  ClaudeAgentRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn(),
    cancel: vi.fn(),
    updateAllowedTools: vi.fn(),
    clearSdkSession: vi.fn(),
  })),
}));

vi.mock('../src/main/config/config-store', () => ({
  configStore: {
    getAll: () => ({}),
    get: () => undefined,
  },
}));

vi.mock('../src/main/memory/project-memory', () => ({
  ProjectMemoryService: vi.fn().mockImplementation(() => ({
    buildPromptMaterial: vi.fn(() => null),
  })),
  normalizeProjectPath: (value: string | null) => value,
}));

vi.mock('../src/main/sandbox/sandbox-adapter', () => ({
  getSandboxAdapter: () => ({ mode: 'native' }),
  initializeSandbox: vi.fn(),
  reinitializeSandbox: vi.fn(),
}));

vi.mock('../src/main/sandbox/path-resolver', () => ({
  PathResolver: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

function makeDb(snapshot: CompactionSnapshotRow): DatabaseInstance {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(() => undefined),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      getLatestBySessionId: vi.fn(() => []),
      getBeforeTimestamp: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
    compactionSnapshots: {
      create: vi.fn(),
      getLatestBySessionId: vi.fn(() => snapshot),
      getBySessionId: vi.fn(() => [snapshot]),
      deleteBySessionId: vi.fn(),
    },
  } as unknown as DatabaseInstance;
}

describe('SessionManager compaction history hydration', () => {
  it('rebuilds context management stats from persisted snapshots', () => {
    const snapshot: CompactionSnapshotRow = {
      id: 'snap-1',
      session_id: 'session-1',
      compact_type: 'full',
      summary_text: 'Summary text',
      preserved_tail: JSON.stringify([]),
      estimated_tokens_before: 1000,
      estimated_tokens_after: 250,
      compacted_message_count: 12,
      preserved_tail_count: 4,
      summary_preview: 'Summary',
      compacted_context_preview: '#1 assistant\nSummary',
      created_at: 1234,
    };
    const manager = new SessionManager(makeDb(snapshot), vi.fn());

    const history = manager.getCompactionHistory('session-1');

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sessionId: 'session-1',
      compactionType: 'full',
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 250,
      compactedMessageCount: 12,
      preservedTailCount: 4,
      summaryText: 'Summary text',
      compactedContextPreview: '#1 assistant\nSummary',
    });
  });

  it('computes token budget for an opened historical session', () => {
    const snapshot: CompactionSnapshotRow = {
      id: 'snap-1',
      session_id: 'session-1',
      compact_type: 'full',
      summary_text: 'Summary text',
      preserved_tail: JSON.stringify([]),
      estimated_tokens_before: 1000,
      estimated_tokens_after: 250,
      compacted_message_count: 12,
      preserved_tail_count: 4,
      summary_preview: 'Summary',
      compacted_context_preview: '#1 assistant\nSummary',
      created_at: 1234,
    };
    const db = makeDb(snapshot);
    db.sessions.get = vi.fn(() => ({
      id: 'session-1',
      title: 'Historical',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      plan_mode: 0,
      created_at: 1,
      updated_at: 1,
    }));
    const manager = new SessionManager(db, vi.fn());

    const budget = manager.getTokenBudgetSnapshot('session-1', 'kimi-k2.6');

    expect(budget).toBeTruthy();
    expect(budget?.estimatedTotalTokens).toBeGreaterThan(0);
    expect(budget?.contextWindow).toBeGreaterThanOrEqual(256000);
    expect(budget?.maxContextTokens).toBeGreaterThanOrEqual(256000);
  });
});
