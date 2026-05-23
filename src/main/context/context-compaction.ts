import { v4 as uuidv4 } from 'uuid';
import type {
  CompactionType,
  CompactionTrigger,
  Message,
  SessionCompactionInfo,
  ToolResultContent,
  ToolUseContent,
} from '../../renderer/types';
import { estimateMessagesTokens, getStrategyThresholds } from './context-budget';

const COMPACTABLE_TOOL_NAMES = new Set([
  'read',
  'glob',
  'bash',
  'pwsh',
  'http',
  'edit',
  'write',
]);

interface CompactableToolUse {
  name: string;
  input?: Record<string, unknown>;
}

export interface MicroCompactionResult {
  messages: Message[];
  compactedMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export interface CompactionBoundaryRecordInput {
  sessionId: string;
  summaryText: string;
  preservedTail: Message[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  compactType: CompactionType;
}

export interface SerializedCompactionBoundary {
  summary_text: string;
  preserved_tail: string;
  created_at: number;
}

export function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

export function getPreservedTailCount(trigger: CompactionTrigger): number {
  if (trigger === 'rolling') {
    return getStrategyThresholds('rolling').preservedTailCount;
  }
  return getStrategyThresholds('auto').preservedTailCount;
}

function getCommandText(input?: Record<string, unknown>): string {
  const command = input?.command;
  if (typeof command === 'string') {
    return command;
  }
  const query = input?.query;
  if (typeof query === 'string') {
    return query;
  }
  return '';
}

function isSearchCommand(toolUse: CompactableToolUse): boolean {
  const normalizedName = normalizeToolName(toolUse.name);
  if (normalizedName === 'grep') {
    return true;
  }
  const command = getCommandText(toolUse.input);
  return /\b(rg|grep|Select-String)\b/i.test(command);
}

function compactToolResult(
  toolResult: ToolResultContent,
  toolUse: CompactableToolUse
): ToolResultContent {
  if (toolResult.images && toolResult.images.length > 0) {
    return {
      ...toolResult,
      content: '[image]',
      images: undefined,
    };
  }

  if (isSearchCommand(toolUse)) {
    return toolResult;
  }

  const normalizedName = normalizeToolName(toolUse.name);
  if (normalizedName === 'bash') {
    return {
      ...toolResult,
      content: truncateCompactedText(toolResult.content, 320, '[command output compacted]'),
    };
  }

  return {
    ...toolResult,
    content: truncateCompactedText(
      toolResult.content,
      320,
      `[${normalizedName || 'tool'} output compacted]`
    ),
  };
}

function truncateCompactedText(text: string, maxChars: number, fallback: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const headChars = Math.max(120, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(80, maxChars - headChars);
  const head = normalized.slice(0, headChars).trimEnd();
  const tail = normalized.slice(-tailChars).trimStart();
  return `${head}\n...[middle compacted]...\n${tail}`;
}

export function microCompactMessages(
  messages: Message[],
  preservedTailCount = 8
): MicroCompactionResult {
  const estimatedTokensBefore = estimateMessagesTokens(messages);
  if (messages.length <= preservedTailCount) {
    return {
      messages,
      compactedMessageCount: 0,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const compactableToolUses = new Map<string, CompactableToolUse>();
  const compactedMessages = messages.map((message, index) => {
    if (index >= messages.length - preservedTailCount) {
      return message;
    }

    let changed = false;
    const nextContent = message.content.map((block) => {
      if (block.type === 'tool_use') {
        const toolUse = block as ToolUseContent;
        if (COMPACTABLE_TOOL_NAMES.has(normalizeToolName(toolUse.name))) {
          compactableToolUses.set(toolUse.id, {
            name: toolUse.name,
            input: toolUse.input,
          });
        }
        return block;
      }

      if (block.type !== 'tool_result') {
        return block;
      }

      const toolResult = block as ToolResultContent;
      const toolUse = compactableToolUses.get(toolResult.toolUseId);
      if (!toolUse) {
        return block;
      }

      const compactedResult = compactToolResult(toolResult, toolUse);
      changed = changed || compactedResult !== toolResult;
      return compactedResult;
    });

    if (!changed) {
      return message;
    }

    return {
      ...message,
      content: nextContent,
    };
  });

  const compactedMessageCount = compactedMessages.reduce(
    (count, message, index) => count + (message !== messages[index] ? 1 : 0),
    0
  );
  const estimatedTokensAfter = estimateMessagesTokens(compactedMessages);

  return {
    messages: compactedMessages,
    compactedMessageCount,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}

export function createBoundarySummaryMessage(sessionId: string, summaryText: string): Message {
  return {
    id: `compaction-boundary-${uuidv4()}`,
    sessionId,
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `<conversation_continuation_summary>\n${summaryText.trim()}\n</conversation_continuation_summary>`,
      },
    ],
    timestamp: Date.now(),
  };
}

export function rebuildRuntimeMessagesFromSnapshot(
  sessionId: string,
  snapshot: SerializedCompactionBoundary,
  transcriptMessages: Message[]
): Message[] {
  let preservedTail: Message[] = [];
  try {
    const parsed = JSON.parse(snapshot.preserved_tail) as unknown;
    if (Array.isArray(parsed)) {
      preservedTail = parsed as Message[];
    }
  } catch {
    preservedTail = [];
  }

  const summaryMessage = createBoundarySummaryMessage(sessionId, snapshot.summary_text);
  summaryMessage.timestamp = snapshot.created_at;
  const newerMessages = transcriptMessages.filter(
    (message) => message.timestamp > snapshot.created_at
  );
  return [summaryMessage, ...preservedTail, ...newerMessages];
}

export function appendTranscriptMessagesSince(
  runtimeMessages: Message[],
  transcriptMessages: Message[],
  sinceTimestamp: number
): Message[] {
  const runtimeMessageIds = new Set(runtimeMessages.map((message) => message.id));
  const appendedMessages = transcriptMessages.filter(
    (message) => !runtimeMessageIds.has(message.id) && message.timestamp >= sinceTimestamp
  );

  if (appendedMessages.length === 0) {
    return runtimeMessages;
  }

  return [...runtimeMessages, ...appendedMessages];
}

export function buildCompactionInfo(input: {
  sessionId: string;
  compactionType: CompactionType;
  trigger: CompactionTrigger;
  status?: SessionCompactionInfo['status'];
  skipReason?: SessionCompactionInfo['skipReason'];
  failureCount?: number;
  boundaryCreated: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  preservedTailCount: number;
  compactedMessageCount: number;
  summaryText?: string;
}): SessionCompactionInfo {
  return {
    sessionId: input.sessionId,
    compactionType: input.compactionType,
    trigger: input.trigger,
    status: input.status,
    skipReason: input.skipReason,
    failureCount: input.failureCount,
    boundaryCreated: input.boundaryCreated,
    estimatedTokensBefore: input.estimatedTokensBefore,
    estimatedTokensAfter: input.estimatedTokensAfter,
    preservedTailCount: input.preservedTailCount,
    compactedMessageCount: input.compactedMessageCount,
    createdAt: Date.now(),
    summaryPreview: input.summaryText?.slice(0, 200),
  };
}
