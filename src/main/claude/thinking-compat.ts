type AnthropicPayloadMessage = {
  role?: string;
  content?: unknown;
};

type AnthropicPayload = {
  messages?: AnthropicPayloadMessage[];
};

type OpenAICompletionsPayloadMessage = {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  reasoning_text?: unknown;
  [key: string]: unknown;
};

type OpenAICompletionsPayload = {
  messages?: OpenAICompletionsPayloadMessage[];
};

export function thinkingTextsMatch(text: string, thinking: string): boolean {
  return text === thinking || text.trim() === thinking.trim();
}

function getBlockText(block: unknown): string | null {
  if (!block || typeof block !== 'object') {
    return null;
  }
  const typed = block as { type?: unknown; text?: unknown };
  if (typed.type !== 'text' || typeof typed.text !== 'string') {
    return null;
  }
  return typed.text;
}

function restoreThinkingBlockForAnthropicPayload(
  block: Record<string, unknown>
): Record<string, unknown> {
  if (block.redacted === true) {
    const redactedData =
      typeof block.thinkingSignature === 'string' && block.thinkingSignature.trim().length > 0
        ? block.thinkingSignature
        : block.signature;
    if (typeof redactedData === 'string' && redactedData.trim().length > 0) {
      return {
        type: 'redacted_thinking',
        data: redactedData,
      };
    }
  }

  const restored: Record<string, unknown> = {
    type: 'thinking',
    thinking: block.thinking,
  };

  if (typeof block.thinkingSignature === 'string' && block.thinkingSignature.trim().length > 0) {
    restored.signature = block.thinkingSignature;
  }
  if (typeof block.signature === 'string' && block.signature.trim().length > 0) {
    restored.signature = block.signature;
  }

  return restored;
}

export function restoreUnsignedThinkingBlocksForAnthropicPayload(
  payload: unknown,
  sourceMessages: unknown[]
): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const typedPayload = payload as AnthropicPayload;
  if (!Array.isArray(typedPayload.messages)) {
    return payload;
  }

  const sourceThinkingEntries = sourceMessages.flatMap((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'assistant' ||
      !Array.isArray((message as { content?: unknown }).content)
    ) {
      return [];
    }

    return (message as { content: Array<Record<string, unknown>> }).content
      .filter((block) => {
        if (block.type !== 'thinking') return false;
        return typeof block.thinking === 'string' && block.thinking.trim().length > 0;
      })
      .map((block) => ({
        thinking: block.thinking as string,
        payloadBlock: restoreThinkingBlockForAnthropicPayload(block),
        used: false,
      }));
  });
  let changed = false;

  const messages = typedPayload.messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return message;
    }

    if (sourceThinkingEntries.length === 0) {
      return message;
    }

    const content = message.content.map((block) => {
      const text = getBlockText(block);
      if (text == null) {
        return block;
      }

      const matchingThinkingEntry = sourceThinkingEntries.find(
        (entry) => !entry.used && thinkingTextsMatch(text, entry.thinking)
      );
      if (!matchingThinkingEntry) {
        return block;
      }

      matchingThinkingEntry.used = true;
      changed = true;
      return matchingThinkingEntry.payloadBlock;
    });

    return { ...message, content };
  });

  return changed ? { ...typedPayload, messages } : payload;
}

function getPayloadMessageText(message: OpenAICompletionsPayloadMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        const typed = block as { text?: unknown };
        return typeof typed.text === 'string' ? typed.text : '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

export function restoreOpenAIReasoningContentForPayload(
  payload: unknown,
  sourceMessages: unknown[]
): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const typedPayload = payload as OpenAICompletionsPayload;
  if (!Array.isArray(typedPayload.messages)) {
    return payload;
  }

  const sourceAssistantEntries = sourceMessages.flatMap((message) => {
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { role?: unknown }).role !== 'assistant' ||
      !Array.isArray((message as { content?: unknown }).content)
    ) {
      return [];
    }

    const content = (message as { content: Array<Record<string, unknown>> }).content;
    const thinkingBlocks = content.filter(
      (block) =>
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        block.thinking.trim().length > 0
    );
    if (thinkingBlocks.length === 0) {
      return [];
    }

    const text = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    const signature =
      thinkingBlocks.find(
        (block) =>
          typeof block.thinkingSignature === 'string' &&
          block.thinkingSignature.trim().length > 0
      )?.thinkingSignature ?? 'reasoning_content';

    return [
      {
        text,
        thinking: thinkingBlocks.map((block) => block.thinking as string).join('\n'),
        signature: signature as string,
        used: false,
      },
    ];
  });

  if (sourceAssistantEntries.length === 0) {
    return payload;
  }

  let changed = false;
  const messages = typedPayload.messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }
    if (
      typeof message.reasoning_content === 'string' ||
      typeof message.reasoning === 'string' ||
      typeof message.reasoning_text === 'string'
    ) {
      return message;
    }

    const payloadText = getPayloadMessageText(message);
    const matchingEntry = sourceAssistantEntries.find((entry) => {
      if (entry.used) {
        return false;
      }
      if (!payloadText.trim() || !entry.text.trim()) {
        return true;
      }
      return thinkingTextsMatch(payloadText, entry.text);
    });
    if (!matchingEntry) {
      return message;
    }

    matchingEntry.used = true;
    changed = true;
    return {
      ...message,
      [matchingEntry.signature || 'reasoning_content']: matchingEntry.thinking,
    };
  });

  return changed ? { ...typedPayload, messages } : payload;
}

export function disableThinkingForOpenAIPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const typedPayload = payload as Record<string, unknown>;
  if (!Array.isArray(typedPayload.messages)) {
    return { ...typedPayload, thinking: { type: 'disabled' } };
  }

  const messages = (typedPayload.messages as Array<Record<string, unknown>>).map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return message;
    }

    const content = message.content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return block;
        }
        const typed = block as { type?: unknown; thinking?: unknown };
        if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
          return { type: 'text', text: typed.thinking };
        }
        return block;
      })
      .filter(Boolean);

    return content.length > 0 ? { ...message, content } : null;
  }).filter(Boolean) as Array<Record<string, unknown>>;

  return {
    ...typedPayload,
    thinking: { type: 'disabled' },
    messages,
  };
}

export function disableThinkingForAnthropicPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const typedPayload = payload as AnthropicPayload & { thinking?: unknown };
  if (!Array.isArray(typedPayload.messages)) {
    return { ...typedPayload, thinking: { type: 'disabled' } };
  }

  const messages = typedPayload.messages
    .map((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        return message;
      }

      const content = message.content
        .map((block) => {
          if (!block || typeof block !== 'object') {
            return block;
          }
          const typed = block as {
            type?: unknown;
            thinking?: unknown;
          };
          if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
            return { type: 'text', text: typed.thinking };
          }
          if (typed.type === 'redacted_thinking') {
            return null;
          }
          return block;
        })
        .filter(Boolean);

      return content.length > 0 ? { ...message, content } : null;
    })
    .filter(Boolean) as AnthropicPayloadMessage[];

  return {
    ...typedPayload,
    thinking: { type: 'disabled' },
    messages,
  };
}
