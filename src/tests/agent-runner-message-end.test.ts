import { describe, expect, it } from 'vitest';
import { resolveMessageEndPayload, toUserFacingErrorText } from '../main/claude/agent-runner-message-end';

describe('resolveMessageEndPayload', () => {
  it('uses streamed thinking as a fallback when message_end content is empty', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: '',
      streamedThinking: 'Analyzing repository state',
    });

    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'Analyzing repository state',
      },
    ]);
  });

  it('preserves streamed thinking signature when using streamed fallback content', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: '',
      streamedThinking: 'Hidden reasoning from provider',
      streamedThinkingSignature: 'reasoning_content',
    });

    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'Hidden reasoning from provider',
        thinkingSignature: 'reasoning_content',
      },
    ]);
  });

  it('keeps both streamed thinking and streamed text when final content is empty', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: 'Visible answer',
      streamedThinking: 'Reasoning that must be replayed',
      streamedThinkingSignature: 'reasoning_content',
    });

    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'Reasoning that must be replayed',
        thinkingSignature: 'reasoning_content',
      },
      {
        type: 'text',
        text: 'Visible answer',
      },
    ]);
  });

  it('restores streamed thinking when final content only includes visible text', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible answer' }],
        stopReason: 'stop',
      },
      streamedText: 'Visible answer',
      streamedThinking: 'Reasoning from stream',
      streamedThinkingSignature: 'reasoning_content',
    });

    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'Reasoning from stream',
        thinkingSignature: 'reasoning_content',
      },
      {
        type: 'text',
        text: 'Visible answer',
      },
    ]);
  });

  it('adds streamed thinking signature to final thinking content when provider omits it', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reasoning from stream' },
          { type: 'text', text: 'Visible answer' },
        ],
        stopReason: 'stop',
      },
      streamedText: 'Visible answer',
      streamedThinking: 'Reasoning from stream',
      streamedThinkingSignature: 'reasoning_content',
    });

    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'Reasoning from stream',
        thinkingSignature: 'reasoning_content',
      },
      {
        type: 'text',
        text: 'Visible answer',
      },
    ]);
  });

  it('adds streamed thinking signature to thinking split from think tags', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<think>Reasoning from stream</think>Visible answer' }],
        stopReason: 'stop',
      },
      streamedText: 'Visible answer',
      streamedThinking: 'Reasoning from stream',
      streamedThinkingSignature: 'reasoning_content',
    });

    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking: 'Reasoning from stream',
        thinkingSignature: 'reasoning_content',
      },
      {
        type: 'text',
        text: 'Visible answer',
      },
    ]);
  });

  it('still surfaces an error for a truly empty successful result', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: '',
      streamedThinking: '',
    });

    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(toUserFacingErrorText('empty_success_result'));
  });
});
