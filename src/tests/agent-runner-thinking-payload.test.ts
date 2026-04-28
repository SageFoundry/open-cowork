import { describe, expect, it } from 'vitest';
import {
  disableThinkingForAnthropicPayload,
  restoreOpenAIReasoningContentForPayload,
  restoreUnsignedThinkingBlocksForAnthropicPayload,
} from '../main/claude/thinking-compat';

describe('restoreUnsignedThinkingBlocksForAnthropicPayload', () => {
  it('restores signed thinking text blocks using Anthropic payload signature field', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'signed reasoning' }],
        },
      ],
    };
    const sourceMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'signed reasoning',
            thinkingSignature: 'sig-123',
          },
        ],
      },
    ];

    expect(restoreUnsignedThinkingBlocksForAnthropicPayload(payload, sourceMessages)).toEqual({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'signed reasoning', signature: 'sig-123' }],
        },
      ],
    });
  });

  it('restores redacted thinking as Anthropic redacted_thinking payload blocks', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '[Reasoning redacted]' }],
        },
      ],
    };
    const sourceMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '[Reasoning redacted]',
            thinkingSignature: 'opaque-data',
            redacted: true,
          },
        ],
      },
    ];

    expect(restoreUnsignedThinkingBlocksForAnthropicPayload(payload, sourceMessages)).toEqual({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'redacted_thinking', data: 'opaque-data' }],
        },
      ],
    });
  });

  it('restores thinking blocks even when payload assistant messages no longer align by index', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'second assistant reasoning' }],
        },
      ],
    };
    const sourceMessages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'first assistant text' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'second assistant reasoning',
            thinkingSignature: 'sig-second',
          },
        ],
      },
    ];

    expect(restoreUnsignedThinkingBlocksForAnthropicPayload(payload, sourceMessages)).toEqual({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'second assistant reasoning', signature: 'sig-second' },
          ],
        },
      ],
    });
  });
});

describe('restoreOpenAIReasoningContentForPayload', () => {
  it('adds reasoning_content from source thinking when OpenAI payload lacks it', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: 'Visible answer',
        },
      ],
    };
    const sourceMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Reasoning that must be replayed',
          },
          {
            type: 'text',
            text: 'Visible answer',
          },
        ],
      },
    ];

    expect(restoreOpenAIReasoningContentForPayload(payload, sourceMessages)).toEqual({
      messages: [
        {
          role: 'assistant',
          content: 'Visible answer',
          reasoning_content: 'Reasoning that must be replayed',
        },
      ],
    });
  });

  it('uses provider reasoning field from thinkingSignature when present', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: 'Visible answer',
        },
      ],
    };
    const sourceMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Provider reasoning',
            thinkingSignature: 'reasoning',
          },
          {
            type: 'text',
            text: 'Visible answer',
          },
        ],
      },
    ];

    expect(restoreOpenAIReasoningContentForPayload(payload, sourceMessages)).toEqual({
      messages: [
        {
          role: 'assistant',
          content: 'Visible answer',
          reasoning: 'Provider reasoning',
        },
      ],
    });
  });

  it('does not overwrite existing OpenAI reasoning fields', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: 'Visible answer',
          reasoning_content: 'Existing reasoning',
        },
      ],
    };
    const sourceMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'New reasoning',
          },
        ],
      },
    ];

    expect(restoreOpenAIReasoningContentForPayload(payload, sourceMessages)).toBe(payload);
  });
});

describe('disableThinkingForAnthropicPayload', () => {
  it('disables thinking and converts visible thinking blocks to text', () => {
    const payload = {
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Visible reasoning' },
            { type: 'text', text: 'Answer' },
            { type: 'redacted_thinking', data: 'opaque' },
          ],
        },
      ],
    };

    expect(disableThinkingForAnthropicPayload(payload)).toEqual({
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Visible reasoning' },
            { type: 'text', text: 'Answer' },
          ],
        },
      ],
    });
  });
});
