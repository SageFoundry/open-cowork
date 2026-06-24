import type { Message } from '../types';

export interface CommonTextSuggestion {
  text: string;
  previewText: string;
  count: number;
  lastUsedAt: number;
}

const DEFAULT_PREVIEW_LENGTH = 40;
const MIN_MEANINGFUL_TEXT_LENGTH = 2;

export function getCommonTextSuggestions(
  messages: Message[],
  limit = 3
): CommonTextSuggestion[] {
  if (limit <= 0) return [];

  const suggestions = new Map<
    string,
    {
      text: string;
      count: number;
      lastUsedAt: number;
      firstSeenIndex: number;
    }
  >();

  messages.forEach((message, index) => {
    if (message.role !== 'user') return;

    const text = extractUserText(message);
    const normalized = normalizeSuggestionText(text);
    if (!normalized || isLowValueText(normalized)) return;

    const key = normalized.toLowerCase();
    const existing = suggestions.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, message.timestamp);
      return;
    }

    suggestions.set(key, {
      text: normalized,
      count: 1,
      lastUsedAt: message.timestamp,
      firstSeenIndex: index,
    });
  });

  return Array.from(suggestions.values())
    .filter((item) => item.count > 1)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.firstSeenIndex - b.firstSeenIndex;
    })
    .slice(0, limit)
    .map((item) => ({
      text: item.text,
      previewText: truncateSuggestionText(item.text),
      count: item.count,
      lastUsedAt: item.lastUsedAt,
    }));
}

function extractUserText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function normalizeSuggestionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isLowValueText(value: string): boolean {
  if (value.length < MIN_MEANINGFUL_TEXT_LENGTH) {
    return true;
  }

  return !/[\p{L}\p{N}\p{Script=Han}]/u.test(value);
}

export function truncateSuggestionText(value: string, maxLength = DEFAULT_PREVIEW_LENGTH): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) {
    return value;
  }

  return `${chars.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}
