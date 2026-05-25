import { describe, expect, it } from 'vitest';
import {
  groupMessagesByTurn,
  isModeEventMessage,
} from '../src/renderer/utils/conversation-turns';
import type { Message } from '../src/renderer/types';

function message(id: string, role: Message['role'], text: string): Message {
  return {
    id,
    sessionId: 'session-1',
    role,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

describe('mode event rendering', () => {
  it('detects and hides mode event messages from visible conversation turns', () => {
    const modeEvent = message(
      'mode-1',
      'assistant',
      '<mode_event type="exit_plan">\nCurrent mode changed to Normal Mode.\n</mode_event>'
    );
    const user = message('user-1', 'user', '现在执行');
    const assistant = message('assistant-1', 'assistant', '开始执行。');

    expect(isModeEventMessage(modeEvent)).toBe(true);
    expect(groupMessagesByTurn([modeEvent, user, assistant])).toEqual([
      { userMessage: user, assistantMessages: [assistant] },
    ]);
  });
});
