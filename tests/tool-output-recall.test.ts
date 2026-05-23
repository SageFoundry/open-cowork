import { describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance, ToolOutputSnapshotRow } from '../src/main/db/database';
import {
  createToolOutputSnapshot,
  formatToolOutputRecallNotice,
  recallToolOutput,
} from '../src/main/tools/tool-output-recall';

function makeDb(): DatabaseInstance {
  const rows = new Map<string, ToolOutputSnapshotRow>();
  return {
    toolOutputSnapshots: {
      create: vi.fn((snapshot: ToolOutputSnapshotRow) => {
        rows.set(snapshot.id, snapshot);
      }),
      get: vi.fn((id: string) => rows.get(id)),
      deleteOlderThan: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
  } as unknown as DatabaseInstance;
}

describe('tool output recall', () => {
  it('stores original output and recalls by range', () => {
    const db = makeDb();
    const handle = createToolOutputSnapshot(db, {
      sessionId: 'session-1',
      projectPath: 'E:/workspace/project',
      toolName: 'bash',
      reason: 'truncated',
      content: '0123456789abcdefghijklmnopqrstuvwxyz',
    });

    expect(handle).toMatch(/^tool-output:\/\//);
    const recalled = recallToolOutput(db, {
      handle: handle!,
      start: 10,
      end: 15,
    });

    expect(recalled.found).toBe(true);
    expect(recalled.text).toContain('chars 10-15');
    expect(recalled.text).toContain('abcde');
  });

  it('recalls matching excerpts by keyword', () => {
    const db = makeDb();
    const handle = createToolOutputSnapshot(db, {
      sessionId: 'session-1',
      projectPath: null,
      toolName: 'web_search',
      reason: 'compressed',
      content: `alpha\n${'middle '.repeat(50)}important source detail\nomega`,
    });

    const recalled = recallToolOutput(db, {
      handle: handle!,
      query: 'important detail',
      maxChars: 200,
    });

    expect(recalled.found).toBe(true);
    expect(recalled.text).toContain('important source detail');
  });

  it('formats a model-visible recall handle notice', () => {
    const notice = formatToolOutputRecallNotice({
      handle: 'tool-output://abc',
      reason: 'compressed',
      rawChars: 10000,
      visibleChars: 2000,
    });

    expect(notice).toContain('tool-output://abc');
    expect(notice).toContain('recall_tool_output');
  });
});
