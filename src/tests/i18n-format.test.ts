import { describe, expect, it } from 'vitest';
import { formatChatTurnTime } from '../renderer/utils/i18n-format';

describe('formatChatTurnTime', () => {
  it('uses compact chat timestamps by recency', () => {
    const now = new Date('2026-05-28T17:30:00+08:00');

    expect(formatChatTurnTime(new Date('2026-05-28T17:17:00+08:00'), now)).toBe('17:17');
    expect(formatChatTurnTime(new Date('2026-05-20T17:17:00+08:00'), now)).toBe(
      '5月20日 17:17'
    );
    expect(formatChatTurnTime(new Date('2025-05-20T17:17:00+08:00'), now)).toBe('2025年5月20日');
  });
});
