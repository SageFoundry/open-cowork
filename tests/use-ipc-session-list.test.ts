import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const useIPCPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');
const source = readFileSync(useIPCPath, 'utf8');

describe('useIPC session list loading', () => {
  it('loads sessions through invoke so startup has a return value and retry path', () => {
    expect(source).toContain('const listSessions = useCallback(async () => {');
    expect(source).toContain("const sessions = await invoke<Session[]>({ type: 'session.list', payload: {} });");
    expect(source).toContain('useAppStore.getState().setSessions(nextSessions);');
    expect(source).toContain("console.error('[useIPC] Failed to list sessions, retrying once:', error);");
    expect(source).toContain('window.setTimeout(resolve, 300)');
  });

  it('does not fire-and-forget session.list from listSessions', () => {
    const start = source.indexOf('const listSessions = useCallback');
    const end = source.indexOf('// Get messages for a session', start);
    const listSessionsBlock = source.slice(start, end);
    expect(listSessionsBlock).not.toContain("send({ type: 'session.list'");
  });
});
