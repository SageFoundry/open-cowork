import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const chatViewPath = path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx');
const assistantTurnGroupPath = path.resolve(
  process.cwd(),
  'src/renderer/components/AssistantTurnGroup.tsx'
);
const messageCardPath = path.resolve(process.cwd(), 'src/renderer/components/MessageCard.tsx');
const useIPCPath = path.resolve(process.cwd(), 'src/renderer/hooks/useIPC.ts');
const preloadPath = path.resolve(process.cwd(), 'src/preload/index.ts');
const enLocalePath = path.resolve(process.cwd(), 'src/renderer/i18n/locales/en.json');
const zhLocalePath = path.resolve(process.cwd(), 'src/renderer/i18n/locales/zh.json');

const chatViewSource = readFileSync(chatViewPath, 'utf8');
const assistantTurnGroupSource = readFileSync(assistantTurnGroupPath, 'utf8');
const messageCardSource = readFileSync(messageCardPath, 'utf8');
const useIPCSource = readFileSync(useIPCPath, 'utf8');
const preloadSource = readFileSync(preloadPath, 'utf8');
const enLocaleSource = readFileSync(enLocalePath, 'utf8');
const zhLocaleSource = readFileSync(zhLocalePath, 'utf8');

describe('session message fork UI wiring', () => {
  it('allows and invokes the session.fork IPC event', () => {
    expect(preloadSource).toContain("'session.fork'");
    expect(useIPCSource).toContain('const forkSession = useCallback');
    expect(useIPCSource).toContain("type: 'session.fork'");
    expect(useIPCSource).toContain('payload: { sourceSessionId, messageId }');
    expect(useIPCSource).toContain('setMessagePagination(result.session.id');
    expect(useIPCSource).toContain('setActiveSession(result.session.id)');
    expect(useIPCSource).toContain('forkSession,');
  });

  it('renders the fork action in the turn footer with an upward custom tooltip', () => {
    expect(chatViewSource).toContain('GitFork');
    expect(chatViewSource).toContain('const getTurnForkMessageId = useCallback');
    expect(chatViewSource).toContain("!message.id.startsWith('partial-')");
    expect(chatViewSource).toContain('!turn.userMessage.localStatus');
    expect(chatViewSource).toContain("aria-label={t('messageCard.forkFromHere')}");
    expect(chatViewSource).toContain('bottom-full');
    expect(chatViewSource).not.toContain('title={t(\'messageCard.forkFromHere\')}');
    expect(messageCardSource).not.toContain('GitFork');
  });

  it('passes fork callbacks through ChatView and assistant final messages', () => {
    expect(chatViewSource).toContain('const { continueSession, forkSession, stopSession');
    expect(chatViewSource).toContain('const handleForkMessage = useCallback');
    expect(chatViewSource).toContain('void forkSession(activeSessionId, messageId);');
    expect(chatViewSource).toContain('onClick={() => handleForkMessage(forkMessageId)}');
    expect(assistantTurnGroupSource).not.toContain('onForkMessage?: (messageId: string) => void;');
    expect(assistantTurnGroupSource).not.toContain('onForkMessage={onForkMessage}');
  });

  it('ships English and Chinese fork labels', () => {
    expect(enLocaleSource).toContain('"forkFromHere": "Fork from here"');
    expect(zhLocaleSource).toContain('"forkFromHere": "从这里分叉"');
    expect(enLocaleSource).toContain('"forkCreated": "Forked session created"');
    expect(zhLocaleSource).toContain('"forkCreated": "已创建分叉会话"');
  });
});
