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

  it('returns explicit next-page instructions for long range recalls', () => {
    const db = makeDb();
    const handle = createToolOutputSnapshot(db, {
      sessionId: 'session-1',
      projectPath: 'E:/workspace/project',
      toolName: 'bash',
      reason: 'truncated',
      content: 'A'.repeat(120_000),
    });

    const recalled = recallToolOutput(db, {
      handle: handle!,
      maxChars: 100_000,
    });

    expect(recalled.found).toBe(true);
    expect(recalled.text).toContain('"start":100000');
    expect(recalled.text).toContain('"maxChars":100000');
  });

  it('recalls saved output by line range', () => {
    const db = makeDb();
    const handle = createToolOutputSnapshot(db, {
      sessionId: 'session-1',
      projectPath: null,
      toolName: 'read',
      reason: 'truncated',
      content: ['line-1', 'line-2', 'line-3', 'line-4'].join('\n'),
    });

    const recalled = recallToolOutput(db, {
      handle: handle!,
      startLine: 2,
      endLine: 3,
    });

    expect(recalled.found).toBe(true);
    expect(recalled.text).toContain('lines 2-3 of 4');
    expect(recalled.text).toContain('line-2');
    expect(recalled.text).toContain('line-3');
    expect(recalled.text).not.toContain('line-1');
    expect(recalled.text).not.toContain('line-4');
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
    expect(notice).toContain('"start":2000');
    expect(notice).toContain('startLine/endLine');
  });
});
