import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '../renderer/types';
import {
  getCommonTextSuggestions,
  truncateSuggestionText,
} from '../renderer/utils/common-text-suggestions';

function makeMessage(
  id: string,
  role: Message['role'],
  content: ContentBlock[],
  timestamp: number
): Message {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    timestamp,
  };
}

describe('common-text-suggestions', () => {
  it('counts repeated user text and ignores non-user messages', () => {
    const messages = [
      makeMessage('u1', 'user', [{ type: 'text', text: '重新编译本地重启' }], 1),
      makeMessage('a1', 'assistant', [{ type: 'text', text: 'ignored' }], 2),
      makeMessage('u2', 'user', [{ type: 'text', text: '重新编译本地重启' }], 3),
      makeMessage('u3', 'system', [{ type: 'text', text: '重新编译本地重启' }], 4),
      makeMessage('u4', 'user', [{ type: 'text', text: '编译linux' }], 5),
      makeMessage('u5', 'user', [{ type: 'text', text: '编译linux' }], 6),
      makeMessage('u6', 'user', [{ type: 'text', text: '编译linux' }], 7),
      makeMessage('u7', 'user', [{ type: 'text', text: '  编译linux  ' }], 8),
      makeMessage('u8', 'user', [{ type: 'text', text: 'ok' }], 9),
    ];

    const suggestions = getCommonTextSuggestions(messages);

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({
      text: '编译linux',
      count: 4,
    });
    expect(suggestions[1]).toMatchObject({
      text: '重新编译本地重启',
      count: 2,
    });
  });

  it('truncates long text for display while keeping the full value', () => {
    const text = '请帮我把这个项目重新编译，然后重启本地服务并检查日志输出是否正常';

    expect(truncateSuggestionText(text, 12)).toBe('请帮我把这个项目重新编…');
    expect(truncateSuggestionText('short', 12)).toBe('short');
  });

  it('only returns top three suggestions by frequency', () => {
    const messages = [
      makeMessage('u1', 'user', [{ type: 'text', text: '命令一' }], 1),
      makeMessage('u2', 'user', [{ type: 'text', text: '命令一' }], 2),
      makeMessage('u3', 'user', [{ type: 'text', text: '命令二' }], 3),
      makeMessage('u4', 'user', [{ type: 'text', text: '命令二' }], 4),
      makeMessage('u5', 'user', [{ type: 'text', text: '命令三' }], 5),
      makeMessage('u6', 'user', [{ type: 'text', text: '命令三' }], 6),
      makeMessage('u7', 'user', [{ type: 'text', text: '命令四' }], 7),
      makeMessage('u8', 'user', [{ type: 'text', text: '命令四' }], 8),
    ];

    const suggestions = getCommonTextSuggestions(messages);

    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((item) => item.text)).toEqual(['命令四', '命令三', '命令二']);
  });
});
