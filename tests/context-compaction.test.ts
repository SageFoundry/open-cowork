import { describe, expect, it } from 'vitest';
import {
  buildCompactedContextPreview,
  microCompactMessages,
} from '../src/main/context/context-compaction';
import type { Message } from '../src/renderer/types';

function toolUseMessage(id: string, name: string, input: Record<string, unknown>): Message {
  return {
    id: `use-${id}`,
    sessionId: 'session-1',
    role: 'assistant',
    timestamp: Date.now(),
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function toolResultMessage(id: string, content: string): Message {
  return {
    id: `result-${id}`,
    sessionId: 'session-1',
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'tool_result', toolUseId: id, content }],
  };
}

describe('context micro compaction', () => {
  it('preserves semantic search command output', () => {
    const searchOutput = 'src/a.ts:1:needle\nsrc/b.ts:2:needle\nsrc/c.ts:3:needle';
    const messages = [
      toolUseMessage('search-1', 'bash', { command: 'rg "needle" src -n' }),
      toolResultMessage('search-1', searchOutput),
      toolUseMessage('tail-1', 'bash', { command: 'pwd' }),
      toolResultMessage('tail-1', 'E:/workspace/open-cowork'),
    ];

    const result = microCompactMessages(messages, 2);

    expect(result.messages[1].content[0]).toMatchObject({
      type: 'tool_result',
      content: searchOutput,
    });
    expect(result.compactedMessageCount).toBe(0);
  });

  it('compacts older non-search command output with head and tail context', () => {
    const longOutput = `${'a'.repeat(500)}\nimportant tail`;
    const messages = [
      toolUseMessage('build-1', 'bash', { command: 'npm run build' }),
      toolResultMessage('build-1', longOutput),
      toolUseMessage('tail-1', 'bash', { command: 'pwd' }),
      toolResultMessage('tail-1', 'E:/workspace/open-cowork'),
    ];

    const result = microCompactMessages(messages, 2);
    const compacted = result.messages[1].content[0];

    expect(compacted).toMatchObject({ type: 'tool_result' });
    if (compacted.type !== 'tool_result') throw new Error('Expected tool_result');
    expect(compacted.content).toContain('...[middle compacted]...');
    expect(compacted.content).toContain('important tail');
    expect(result.compactedMessageCount).toBe(1);
  });

  it('builds a preview of the compacted runtime context', () => {
    const preview = buildCompactedContextPreview([
      {
        id: 'summary',
        sessionId: 'session-1',
        role: 'assistant',
        timestamp: Date.now(),
        content: [{ type: 'text', text: '<conversation_continuation_summary>keep this</conversation_continuation_summary>' }],
      },
      toolResultMessage('tail-1', 'short preserved tool result'),
    ]);

    expect(preview).toContain('#1 assistant');
    expect(preview).toContain('keep this');
    expect(preview).toContain('short preserved tool result');
  });
});
