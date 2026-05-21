import { describe, expect, it } from 'vitest';
import { compressToolExecutionResultForModel } from '../src/main/tools/tool-output-compression';
import {
  getToolOutputCompressionStats,
  recordToolOutputCompressionEvent,
  resetToolOutputCompressionStats,
} from '../src/main/tools/tool-output-compression-stats';
import type { DatabaseInstance } from '../src/main/db/database';

type FakeEvent = {
  timestamp: number;
  session_id: string | null;
  project_path: string | null;
  tool_name: string;
  command_family: string;
  category: string;
  level: string;
  strategy: string;
  compressed: number;
  skip_reason: string | null;
  raw_chars: number;
  compressed_chars: number;
  input_tokens_est: number;
  output_tokens_est: number;
  saved_tokens_est: number;
  savings_pct: number;
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function getText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.find((part) => part.type === 'text')?.text || '';
}

function makeDb(): DatabaseInstance {
  const events: FakeEvent[] = [];
  const filterForSql = (sql: string, args: unknown[]) => {
    const sessionId = /session_id = \?/.test(sql) ? String(args[args.length - 1]) : null;
    const since = /timestamp >= \?/.test(sql) ? Number(args[0]) : null;
    return events.filter((event) => {
      if (sessionId && event.session_id !== sessionId) return false;
      if (since !== null && event.timestamp < since) return false;
      return true;
    });
  };
  const groupBy = (
    rows: FakeEvent[],
    field: keyof Pick<FakeEvent, 'category' | 'command_family' | 'strategy'>
  ) => {
    const groups = new Map<string, FakeEvent[]>();
    for (const event of rows) {
      if (field === 'strategy' && event.compressed !== 1) continue;
      const key = String(event[field]);
      groups.set(key, [...(groups.get(key) || []), event]);
    }
    return Array.from(groups.entries())
      .map(([name, rows]) => ({
        name,
        commands: rows.length,
        saved_tokens: rows.reduce((sum, row) => sum + row.saved_tokens_est, 0),
        input_tokens: rows.reduce((sum, row) => sum + row.input_tokens_est, 0),
      }))
      .sort((a, b) => b.saved_tokens - a.saved_tokens || b.commands - a.commands);
  };
  const raw = {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (/DELETE FROM tool_output_compression_events WHERE timestamp </.test(sql)) {
          const cutoff = Number(args[0]);
          for (let i = events.length - 1; i >= 0; i -= 1) {
            if (events[i].timestamp < cutoff) events.splice(i, 1);
          }
          return;
        }
        if (/DELETE FROM tool_output_compression_events/.test(sql)) {
          events.splice(0, events.length);
          return;
        }
        if (/INSERT INTO tool_output_compression_events/.test(sql)) {
          const [
            timestamp,
            session_id,
            project_path,
            tool_name,
            command_family,
            category,
            level,
            strategy,
            compressed,
            skip_reason,
            raw_chars,
            compressed_chars,
            input_tokens_est,
            output_tokens_est,
            saved_tokens_est,
            savings_pct,
          ] = args;
          events.push({
            timestamp: Number(timestamp),
            session_id: session_id as string | null,
            project_path: project_path as string | null,
            tool_name: String(tool_name),
            command_family: String(command_family),
            category: String(category),
            level: String(level),
            strategy: String(strategy),
            compressed: Number(compressed),
            skip_reason: skip_reason as string | null,
            raw_chars: Number(raw_chars),
            compressed_chars: Number(compressed_chars),
            input_tokens_est: Number(input_tokens_est),
            output_tokens_est: Number(output_tokens_est),
            saved_tokens_est: Number(saved_tokens_est),
            savings_pct: Number(savings_pct),
          });
        }
      },
      get: (...args: unknown[]) => {
        const filtered = filterForSql(sql, args);
        if (/COUNT\(\*\) AS total_commands/.test(sql)) {
          return {
            total_commands: filtered.length,
            compressed_commands: filtered.reduce((sum, event) => sum + event.compressed, 0),
            total_input_tokens: filtered.reduce((sum, event) => sum + event.input_tokens_est, 0),
            total_output_tokens: filtered.reduce((sum, event) => sum + event.output_tokens_est, 0),
            total_saved_tokens: filtered.reduce((sum, event) => sum + event.saved_tokens_est, 0),
          };
        }
        return {
          value: filtered.reduce((sum, event) => sum + event.saved_tokens_est, 0),
        };
      },
      all: (...args: unknown[]) => {
        const filtered = filterForSql(sql, args);
        if (/GROUP BY date/.test(sql)) {
          return filtered.map((event) => ({
            date: new Date(event.timestamp).toISOString().slice(0, 10),
            commands: 1,
            saved_tokens: event.saved_tokens_est,
          }));
        }
        if (/GROUP BY category/.test(sql)) return groupBy(filtered, 'category');
        if (/GROUP BY command_family/.test(sql)) return groupBy(filtered, 'command_family');
        if (/GROUP BY strategy/.test(sql)) return groupBy(filtered, 'strategy');
        if (/GROUP BY reason/.test(sql)) {
          const counts = new Map<string, number>();
          for (const event of filtered.filter((item) => item.compressed === 0)) {
            const reason = event.skip_reason || 'compressed';
            counts.set(reason, (counts.get(reason) || 0) + 1);
          }
          return Array.from(counts.entries()).map(([reason, count]) => ({ reason, count }));
        }
        return [];
      },
    }),
    exec: () => {},
    pragma: () => undefined,
    close: () => {},
  };
  return {
    raw: raw as unknown as DatabaseInstance['raw'],
    sessions: {} as DatabaseInstance['sessions'],
    messages: {} as DatabaseInstance['messages'],
    traceSteps: {} as DatabaseInstance['traceSteps'],
    compactionSnapshots: {} as DatabaseInstance['compactionSnapshots'],
    scheduledTasks: {} as DatabaseInstance['scheduledTasks'],
    backgroundTasks: {} as DatabaseInstance['backgroundTasks'],
    prepare: raw.prepare as unknown as DatabaseInstance['prepare'],
    exec: raw.exec,
    pragma: raw.pragma,
    close: raw.close,
  };
}

describe('tool output compression', () => {
  it('does not compress when disabled', () => {
    const raw = `STDOUT:\n${'line\n'.repeat(1000)}\nExit code: 0`;
    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'git diff' },
      level: 'off',
    });

    expect(getText(compressed.result)).toBe(raw);
    expect(compressed.event?.skipReason).toBe('level_off');
  });

  it('uses stronger compression in aggressive mode', () => {
    const raw = [
      'STDOUT:',
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      ...Array.from({ length: 80 }, (_, i) => `@@ -${i},5 +${i},5 @@`),
      ...Array.from({ length: 600 }, (_, i) => (i % 2 ? `+added ${i}` : `-removed ${i}`)),
      'Exit code: 0',
    ].join('\n');

    const conservative = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'git diff' },
      level: 'conservative',
    });
    const aggressive = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'git diff' },
      level: 'aggressive',
    });

    expect(conservative.event?.compressed).toBe(true);
    expect(aggressive.event?.compressed).toBe(true);
    expect(getText(aggressive.result).length).toBeLessThan(getText(conservative.result).length);
    expect(getText(aggressive.result)).toContain('diff --git');
  });

  it('preserves file content for git show blob commands', () => {
    const raw = [
      'STDOUT:',
      'package com.example;',
      '',
      ...Array.from({ length: 260 }, (_, i) => `public void method${i}() { call${i}(); }`),
      'Exit code: 0',
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'git show HEAD:src/main/java/Example.java' },
      level: 'aggressive',
    });
    const text = getText(compressed.result);

    expect(compressed.event?.compressed).toBe(true);
    expect(compressed.event?.strategy).toBe('git-show-file');
    expect(text).toContain('package com.example;');
    expect(text).toContain('public void method0()');
    expect(text).toContain('git show file lines omitted');
    expect(text).toContain('Exit code: 0');
  });

  it('skips explicit raw and json commands', () => {
    const raw = `STDOUT:\n${'{"ok":true}\n'.repeat(500)}\nExit code: 0`;
    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'gh pr view --json title,body' },
      level: 'aggressive',
    });

    expect(getText(compressed.result)).toBe(raw);
    expect(compressed.event?.skipReason).toBe('explicit_raw');
  });

  it('keeps failure diagnostics for test output', () => {
    const raw = [
      'STDOUT:',
      ...Array.from({ length: 250 }, (_, i) => `passing noise ${i}`),
      'FAIL tests/example.test.ts > saves output',
      'AssertionError: expected 1 to equal 2',
      'Expected: 2',
      'Received: 1',
      '    at tests/example.test.ts:42:7',
      ...Array.from({ length: 250 }, (_, i) => `more noise ${i}`),
      'Exit code: 1',
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'npm test' },
      level: 'conservative',
    });
    const text = getText(compressed.result);

    expect(compressed.event?.compressed).toBe(true);
    expect(text).toContain('FAIL tests/example.test.ts');
    expect(text).toContain('AssertionError');
    expect(text).toContain('tests/example.test.ts:42:7');
    expect(text).toContain('Exit code: 1');
  });

  it('recognizes common wrapped commands in conservative mode', () => {
    const raw = [
      'STDOUT:',
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      ...Array.from({ length: 320 }, (_, i) => (i % 2 ? `+added ${i}` : `-removed ${i}`)),
      'Exit code: 0',
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'git -C E:/workspace/open-cowork diff -- src/a.ts' },
      level: 'conservative',
    });

    expect(compressed.event?.compressed).toBe(true);
    expect(compressed.event?.category).toBe('Git');
    expect(compressed.event?.commandFamily).toBe('git diff');
    expect(getText(compressed.result)).toContain('diff --git');
  });

  it('recognizes grep after a shell directory preamble', () => {
    const raw = [
      'STDOUT:',
      ...Array.from(
        { length: 240 },
        (_, i) => `moon/src/main/java/Example${i}.java:${i + 1}:    int thread = ${i};`
      ),
      'Exit code: 0',
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: {
        command: 'cd D:\\dist\\sun-quic-android && grep -rn "thread" --include="*.java" | head -20',
      },
      level: 'aggressive',
    });

    expect(compressed.event?.compressed).toBe(true);
    expect(compressed.event?.category).toBe('Search');
    expect(compressed.event?.commandFamily).toBe('grep');
    expect(getText(compressed.result)).toContain('Search summary');
  });

  it('keeps web search tool results unchanged because they are semantic context', () => {
    const raw = [
      'Search results:',
      ...Array.from(
        { length: 220 },
        (_, i) => `Result ${i}: https://example.com/${i} - detailed snippet about thread pools`
      ),
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'websearch',
      params: { query: 'android thread pool limits' },
      level: 'aggressive',
    });

    expect(compressed.event?.compressed).toBe(false);
    expect(compressed.event?.category).toBe('Search');
    expect(compressed.event?.commandFamily).toBe('websearch');
    expect(compressed.event?.skipReason).toBe('semantic_sensitive');
    expect(getText(compressed.result)).toBe(raw);
  });

  it('keeps AnySearch result blocks unchanged instead of omitting results', () => {
    const raw = [
      'AnySearch Web Search',
      'Query: Java ScheduledExecutorService corePoolSize 1 vs 8 best practice',
      'Parameters: max_results=5',
      'Metadata: total_results=5; search_time_ms=2524; routes_succeeded=2/2; cached=false; request_id=abc',
      '',
      'Results:',
      '',
      ...Array.from({ length: 5 }, (_, i) =>
        [
          `${i + 1}. Result title ${i}`,
          `URL: https://example.com/${i}`,
          'Score: 83.417',
          'Quality: 83.417',
          `Content: ${'Long snippet with scheduler and thread pool details. '.repeat(24)}`,
        ].join('\n')
      ),
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'websearch',
      params: { query: 'Java ScheduledExecutorService corePoolSize 1 vs 8 best practice' },
      level: 'aggressive',
    });

    const text = getText(compressed.result);
    expect(compressed.event?.compressed).toBe(false);
    expect(compressed.event?.category).toBe('Search');
    expect(compressed.event?.skipReason).toBe('semantic_sensitive');
    expect(text).toBe(raw);
    expect(text).toContain('request_id=');
    expect(text).toContain('5. Result title 4');
  });

  it('strips ANSI table formatting from PowerShell file lists', () => {
    const raw = [
      'STDOUT:',
      '',
      '\u001b[32;1mFilename              \u001b[0m\u001b[32;1m LineNumber\u001b[0m\u001b[32;1m Line\u001b[0m',
      '\u001b[32;1m--------              \u001b[0m \u001b[32;1m----------\u001b[0m \u001b[32;1m----\u001b[0m',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `OkioTcpClient.java            ${100 + i}         if (!MoonThreadManager.getInstance().executeWorker(() -> veryLongCall${i}()))`
      ),
      '',
      'Exit code: 0',
    ].join('\r\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'pwsh',
      params: {
        command:
          'Get-ChildItem -Path D:\\dist\\sun-quic-android -Recurse -Filter "*.java" | Select-String -Pattern "executeWorker" | Select-Object Filename, LineNumber, Line',
      },
      level: 'aggressive',
    });

    const text = getText(compressed.result);
    expect(compressed.event?.compressed).toBe(true);
    expect(text).not.toContain('\u001b[');
    expect(text).toContain('OkioTcpClient.java');
  });

  it('compresses package build diagnostics instead of marking them unsupported', () => {
    const raw = [
      'STDOUT:',
      ...Array.from(
        { length: 240 },
        (_, i) => `src/file-${i}.ts(${i + 1},${i + 2}): error TS1234: example failure`
      ),
      'Exit code: 2',
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'pwsh',
      params: { command: 'npm run typecheck' },
      level: 'conservative',
    });

    expect(compressed.event?.compressed).toBe(true);
    expect(compressed.event?.category).toBe('Build');
    expect(compressed.event?.commandFamily).toBe('npm typecheck');
    expect(getText(compressed.result)).toContain('error TS1234');
  });

  it('uses a conservative generic fallback for long unsupported shell output', () => {
    const raw = [
      'STDOUT:',
      ...Array.from({ length: 620 }, (_, i) => `unknown tool output line ${i}`),
      'Exit code: 0',
    ].join('\n');

    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'custom-report --summary' },
      level: 'conservative',
    });

    expect(compressed.event?.compressed).toBe(true);
    expect(compressed.event?.category).toBe('Other');
    expect(compressed.event?.strategy).toBe('generic-text');
    expect(getText(compressed.result)).toContain('omitted');
  });

  it('keeps short unsupported shell output untouched', () => {
    const raw = `STDOUT:\n${'unknown output\n'.repeat(40)}\nExit code: 0`;
    const compressed = compressToolExecutionResultForModel(textResult(raw), {
      toolName: 'bash',
      params: { command: 'custom-report --summary' },
      level: 'conservative',
    });

    expect(compressed.event?.compressed).toBe(false);
    expect(compressed.event?.skipReason).toBe('short_output');
    expect(getText(compressed.result)).toBe(raw);
  });

  it('records, aggregates, and resets local stats', () => {
    const db = makeDb();
    const compressed = compressToolExecutionResultForModel(
      textResult(`STDOUT:\n${'error TS1234: bad\n'.repeat(400)}\nExit code: 2`),
      {
        toolName: 'bash',
        params: { command: 'tsc --noEmit' },
        level: 'conservative',
      }
    );
    expect(compressed.event).toBeTruthy();

    recordToolOutputCompressionEvent(db, {
      sessionId: 'session-1',
      projectPath: 'E:/workspace/open-cowork',
      event: compressed.event!,
    });

    const stats = getToolOutputCompressionStats(db);
    expect(stats.totalCommands).toBe(1);
    expect(stats.compressedCommands).toBe(1);
    expect(stats.totalSavedTokens).toBeGreaterThan(0);
    expect(stats.topCategories[0].name).toBe('Build');

    resetToolOutputCompressionStats(db);
    expect(getToolOutputCompressionStats(db).totalCommands).toBe(0);
    db.close();
  });

  it('aggregates compression stats by session', () => {
    const db = makeDb();
    const first = compressToolExecutionResultForModel(
      textResult(`STDOUT:\n${'error TS1234: bad\n'.repeat(400)}\nExit code: 2`),
      {
        toolName: 'bash',
        params: { command: 'npm run typecheck' },
        level: 'aggressive',
      }
    );
    const second = compressToolExecutionResultForModel(
      textResult(`STDOUT:\n${'diff --git a/a b/a\n+line\n-line\n'.repeat(300)}\nExit code: 0`),
      {
        toolName: 'bash',
        params: { command: 'git diff' },
        level: 'aggressive',
      }
    );

    recordToolOutputCompressionEvent(db, {
      sessionId: 'session-a',
      projectPath: 'E:/workspace/open-cowork',
      event: first.event!,
    });
    recordToolOutputCompressionEvent(db, {
      sessionId: 'session-b',
      projectPath: 'E:/workspace/open-cowork',
      event: second.event!,
    });

    const globalStats = getToolOutputCompressionStats(db);
    const sessionStats = getToolOutputCompressionStats(db, { sessionId: 'session-a' });

    expect(globalStats.totalCommands).toBe(2);
    expect(sessionStats.totalCommands).toBe(1);
    expect(sessionStats.topCategories[0].name).toBe('Build');
    expect(sessionStats.topCommandFamilies[0].name).toBe('npm typecheck');
    db.close();
  });
});
