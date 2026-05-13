import type {
  ContentBlock,
  MemoryStrategy,
  Message,
  TokenBudgetSnapshot,
  TokenWarningState,
} from '../../renderer/types';

export interface TokenBudgetInput {
  messages: Message[];
  contextWindow: number;
  maxContextTokens: number;
  strategy: MemoryStrategy;
  systemPromptTokens?: number;
}

export interface StrategyThresholds {
  warningRatio: number;
  errorRatio: number;
  blockingRatio: number;
  microCompactRatio: number;
  fullCompactRatio: number;
  preservedTailCount: number;
}

const STRATEGY_THRESHOLDS: Record<MemoryStrategy, StrategyThresholds> = {
  auto: {
    warningRatio: 0.6,
    errorRatio: 0.68,
    blockingRatio: 0.8,
    microCompactRatio: 0.55,
    fullCompactRatio: 0.65,
    preservedTailCount: 8,
  },
  manual: {
    warningRatio: 0.6,
    errorRatio: 0.68,
    blockingRatio: 0.8,
    microCompactRatio: 0.55,
    fullCompactRatio: Number.POSITIVE_INFINITY,
    preservedTailCount: 8,
  },
  rolling: {
    warningRatio: 0.55,
    errorRatio: 0.6,
    blockingRatio: 0.72,
    microCompactRatio: 0.5,
    fullCompactRatio: 0.6,
    preservedTailCount: 4,
  },
};

export function getStrategyThresholds(strategy: MemoryStrategy): StrategyThresholds {
  return STRATEGY_THRESHOLDS[strategy];
}

/**
 * Estimates the token count for a given text string.
 *
 * Uses character-length-based heuristics that vary by script type to account
 * for the different tokenization efficiency of different writing systems:
 *
 * - CJK (Chinese/Japanese/Korean) characters: approximately 2-3 tokens per
 *   character in most LLM tokenizers (Claude, GPT, DeepSeek).
 * - Latin/numeric/whitespace characters: approximately 1 token per 4 characters.
 * - Mixed content: weighted average based on detected CJK ratio.
 *
 * This guards against severe underestimation in Chinese-heavy conversations
 * (previously used a flat `length/4` which underestimated Chinese by ~50-60%).
 */
export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  // Count CJK characters (CJK Unified Ideographs range)
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjkCount++;
    }
  }

  const nonCjkCount = text.length - cjkCount;

  // CJK: ~2.5 tokens per character (conservative middle estimate)
  // Non-CJK: ~1 token per 4 characters (standard heuristic)
  const estimatedTokens = cjkCount * 2.5 + nonCjkCount / 4;

  return Math.ceil(estimatedTokens);
}

function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text) + 6;
    case 'thinking':
      return estimateTextTokens(block.thinking) + 12;
    case 'image':
      return 512;
    case 'file_attachment':
      return estimateTextTokens(`${block.filename} ${block.relativePath}`) + 128;
    case 'tool_use':
      return estimateTextTokens(`${block.name} ${JSON.stringify(block.input)}`) + 32;
    case 'tool_result':
      return estimateTextTokens(block.content) + (block.images?.length ?? 0) * 256 + 24;
    default:
      return 0;
  }
}

export function estimateMessageTokens(message: Message): number {
  const roleOverhead = message.role === 'assistant' ? 10 : message.role === 'system' ? 14 : 8;
  return (
    roleOverhead +
    message.content.reduce((sum, block) => sum + estimateContentBlockTokens(block), 0)
  );
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

const LEGACY_DEFAULT_MAX_CONTEXT_TOKENS = 180000;

export function resolveContextBudget(contextWindow: number, maxContextTokens: number): number {
  const safeContextWindow =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : LEGACY_DEFAULT_MAX_CONTEXT_TOKENS;
  const hasExplicitConfiguredMax =
    Number.isFinite(maxContextTokens) &&
    maxContextTokens > 0 &&
    !(
      maxContextTokens === LEGACY_DEFAULT_MAX_CONTEXT_TOKENS && safeContextWindow > maxContextTokens
    );
  const safeConfiguredMax = hasExplicitConfiguredMax ? maxContextTokens : safeContextWindow;
  return Math.max(8192, Math.min(safeContextWindow, safeConfiguredMax));
}

export function resolveReserveTokens(contextBudget: number): number {
  return Math.max(2048, Math.min(12000, Math.floor(contextBudget * 0.12)));
}

export function getTokenWarningState(
  usageRatio: number,
  strategy: MemoryStrategy
): TokenWarningState {
  const thresholds = getStrategyThresholds(strategy);
  if (usageRatio >= thresholds.blockingRatio) {
    return 'blocking';
  }
  if (usageRatio >= thresholds.errorRatio) {
    return 'error';
  }
  if (usageRatio >= thresholds.warningRatio) {
    return 'warning';
  }
  return 'normal';
}

export function buildTokenBudgetSnapshot(input: TokenBudgetInput): TokenBudgetSnapshot {
  const effectiveBudget = resolveContextBudget(input.contextWindow, input.maxContextTokens);
  const reserveTokens = resolveReserveTokens(effectiveBudget);
  const estimatedConversationTokens = estimateMessagesTokens(input.messages);
  const estimatedSystemPromptTokens = Math.max(0, input.systemPromptTokens ?? 0);
  const estimatedTotalTokens =
    estimatedConversationTokens + estimatedSystemPromptTokens + reserveTokens;
  const usageRatio = estimatedTotalTokens / effectiveBudget;

  return {
    contextWindow: input.contextWindow,
    maxContextTokens: effectiveBudget,
    estimatedConversationTokens,
    estimatedSystemPromptTokens,
    estimatedTotalTokens,
    availableTokens: Math.max(0, effectiveBudget - estimatedTotalTokens),
    reserveTokens,
    usageRatio,
    warningState: getTokenWarningState(usageRatio, input.strategy),
    strategy: input.strategy,
    lastUpdatedAt: Date.now(),
  };
}
