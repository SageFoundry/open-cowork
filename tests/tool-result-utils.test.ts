import { describe, expect, it } from 'vitest';
import {
  limitToolExecutionResultForModel,
  limitToolResultTextForContext,
  normalizeMcpToolResultForModel,
  normalizeToolExecutionResultForUi,
} from '../src/main/claude/tool-result-utils';

describe('tool result utils', () => {
  it('keeps screenshot metadata text while omitting image base64 from model context', () => {
    const base64Image = 'A'.repeat(2048);
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, path: '/tmp/screenshot.png' }, null, 2),
        },
        {
          type: 'image',
          data: base64Image,
          mimeType: 'image/png',
        },
      ],
    };

    const normalized = normalizeMcpToolResultForModel(result);

    expect(normalized.text).toContain('"success": true');
    expect(normalized.text).toContain('/tmp/screenshot.png');
    expect(normalized.text).not.toContain(base64Image);
    expect(normalized.images).toEqual([{ data: base64Image, mimeType: 'image/png' }]);
  });

  it('extracts tool result images into the dedicated ui field', () => {
    const base64Image = 'B'.repeat(1024);
    const result = {
      content: [{ type: 'text', text: 'Screenshot captured successfully' }],
      details: {
        openCoworkImages: [
          {
            data: base64Image,
            mimeType: 'image/png',
          },
        ],
      },
    };

    const normalized = normalizeToolExecutionResultForUi(result);

    expect(normalized.content).toBe('Screenshot captured successfully');
    expect(normalized.images).toEqual([{ data: base64Image, mimeType: 'image/png' }]);
  });

  it('keeps different images that share the same prefix and length', () => {
    const sharedPrefix = 'PREFIX'.repeat(20);
    const firstImage = `${sharedPrefix}${'X'.repeat(64)}`;
    const secondImage = `${sharedPrefix}${'Y'.repeat(64)}`;
    const result = {
      content: [{ type: 'text', text: 'Captured two screenshots' }],
      details: {
        openCoworkImages: [
          { data: firstImage, mimeType: 'image/png' },
          { data: secondImage, mimeType: 'image/png' },
        ],
      },
    };

    const normalized = normalizeToolExecutionResultForUi(result);

    expect(normalized.images).toEqual([
      { data: firstImage, mimeType: 'image/png' },
      { data: secondImage, mimeType: 'image/png' },
    ]);
  });

  it('redacts data urls and image payloads when stringifying fallback tool results', () => {
    const dataUrl = `data:image/png;base64,${'C'.repeat(512)}`;
    const result = {
      content: [
        {
          type: 'image_url',
          image_url: {
            url: dataUrl,
          },
        },
      ],
    };

    const normalized = normalizeToolExecutionResultForUi(result);

    expect(normalized.content).toContain('[image data URL omitted');
    expect(normalized.content).not.toContain(dataUrl);
  });

  it('limits oversized tool text before saving it for ui history', () => {
    const hugeOutput = `HEAD-${'A'.repeat(120_000)}-TAIL`;

    const normalized = normalizeToolExecutionResultForUi({
      content: [{ type: 'text', text: hugeOutput }],
    });

    expect(normalized.content.length).toBeLessThanOrEqual(80_000);
    expect(normalized.content).toContain('HEAD-');
    expect(normalized.content).toContain('-TAIL');
    expect(normalized.content).toContain('[Tool output truncated: omitted');
  });

  it('limits MCP text before returning it to the model', () => {
    const hugeOutput = `BEGIN\n${Array.from({ length: 2500 }, (_, index) => `line-${index}`).join('\n')}\nEND`;

    const normalized = normalizeMcpToolResultForModel({
      content: [{ type: 'text', text: hugeOutput }],
    });

    expect(normalized.text).toContain('BEGIN');
    expect(normalized.text).toContain('END');
    expect(normalized.text).toContain('[Tool output truncated: omitted');
    expect(normalized.text.split(/\r?\n/).length).toBeLessThanOrEqual(2004);
  });

  it('limits structured tool execution results while preserving non-text payloads', () => {
    const base64Image = 'D'.repeat(1024);
    const result = limitToolExecutionResultForModel({
      content: [
        { type: 'text', text: `HEAD-${'B'.repeat(120_000)}-TAIL` },
        { type: 'image', data: base64Image, mimeType: 'image/png' },
      ],
      details: {
        openCoworkImages: [{ data: base64Image, mimeType: 'image/png' }],
      },
    });

    const textPart = result.content[0];
    expect(textPart.type).toBe('text');
    expect(textPart.text.length).toBeLessThanOrEqual(80_000);
    expect(textPart.text).toContain('[Tool output truncated: omitted');
    expect(result.content[1]).toEqual({ type: 'image', data: base64Image, mimeType: 'image/png' });
    expect(result.details.openCoworkImages[0].data).toBe(base64Image);
  });

  it('scrubs unsafe binary control characters from tool context text', () => {
    const limited = limitToolResultTextForContext('MZ\u0000\u0001ok\n');

    expect(limited).toBe('MZ��ok\n');
  });
});
