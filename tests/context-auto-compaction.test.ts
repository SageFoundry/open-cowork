import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');

describe('SessionManager auto compaction safeguards', () => {
  it('uses a structured continuation summary prompt', () => {
    const source = fs.readFileSync(sessionManagerPath, 'utf8');

    expect(source).toContain('CRITICAL: Respond with TEXT ONLY');
    expect(source).toContain('## Primary Request and Intent');
    expect(source).toContain('## Key Technical Concepts');
    expect(source).toContain('## Files and Code Sections');
    expect(source).toContain('## User Messages');
    expect(source).toContain('## Current Work');
    expect(source).toContain('## Next Step');
  });

  it('keeps fallback summaries in the same section shape', () => {
    const source = fs.readFileSync(sessionManagerPath, 'utf8');

    expect(source).toContain("'## Primary Request and Intent'");
    expect(source).toContain("'## Pending Tasks'");
    expect(source).toContain("'## Current Work'");
    expect(source).toContain("'## Next Step'");
  });

  it('tracks automatic compaction failures and skips nested automatic compaction', () => {
    const source = fs.readFileSync(sessionManagerPath, 'utf8');

    expect(source).toContain('MAX_AUTOMATIC_COMPACTION_FAILURES = 3');
    expect(source).toContain('compactionFailureCounts');
    expect(source).toContain('compactingSessions');
    expect(source).toContain('summaryResult.usedFallback');
    expect(source).toContain("skipReason: 'failure_circuit_breaker'");
    expect(source).toContain("skipReason: 'nested_compaction'");
    expect(source).toContain('Skipped nested ${trigger} compaction');
  });

  it('suppresses follow-up questions during automatic compaction summaries', () => {
    const source = fs.readFileSync(sessionManagerPath, 'utf8');

    expect(source).toContain('This is automatic compaction. Suppress follow-up questions');
    expect(source).toContain('No follow-up question');
  });
});
