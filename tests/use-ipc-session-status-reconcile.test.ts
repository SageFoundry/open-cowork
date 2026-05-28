import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const useIPCPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');
const source = readFileSync(useIPCPath, 'utf8');

describe('useIPC session status reconciliation', () => {
  it('reconciles recent persisted messages when a session becomes idle', () => {
    expect(source).toContain('const reconcileSessionMessagesFromDisk = async (sessionId: string) => {');
    expect(source).toContain("type: 'session.getMessages'");
    expect(source).toContain('payload: { sessionId, limit: 20 }');
    expect(source).toContain('store.setMessages(sessionId, merged);');
    expect(source).toContain('void reconcileSessionMessagesFromDisk(event.payload.sessionId);');
  });

  it('clears stale streaming state on non-running session status', () => {
    expect(source).toContain('delete pendingPartials[event.payload.sessionId];');
    expect(source).toContain('delete pendingThinking[event.payload.sessionId];');
    expect(source).toContain('store.clearPartialMessage(event.payload.sessionId);');
    expect(source).toContain('store.clearPartialThinking(event.payload.sessionId);');
    expect(source).toContain('store.clearActiveTurn(event.payload.sessionId);');
  });
});
