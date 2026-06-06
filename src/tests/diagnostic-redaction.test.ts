import { describe, expect, it } from 'vitest';
import {
  redactDiagnosticValue,
  redactDiagnosticText,
  redactFileSystemPath,
  redactSensitiveString,
  sanitizeDiagnosticUrl,
} from '../main/utils/diagnostic-redaction';

describe('diagnostic redaction', () => {
  it('redacts common secret strings', () => {
    const value = redactSensitiveString(
      'Authorization: Bearer sk-test_abcdefghijklmnopqrstuvwxyz123456789'
    );

    expect(value).toContain('[redacted-secret]');
    expect(value).not.toContain('sk-test_abcdefghijklmnopqrstuvwxyz123456789');
  });

  it('redacts sensitive object fields', () => {
    const value = redactDiagnosticValue({
      apiKey: 'sk-test_abcdefghijklmnopqrstuvwxyz123456789',
      nested: {
        Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
        keep: 'model-name',
      },
    }) as Record<string, unknown>;

    expect(value.apiKey).toBe('[redacted-secret]');
    expect((value.nested as Record<string, unknown>).Authorization).toBe('[redacted-secret]');
    expect((value.nested as Record<string, unknown>).keep).toBe('model-name');
  });

  it('sanitizes diagnostic URLs', () => {
    expect(
      sanitizeDiagnosticUrl('https://user:pass@example.com/v1/chat/completions?token=secret#frag')
    ).toBe('https://example.com/v1/chat/completions');
  });

  it('redacts secrets and URL credentials in diagnostic text', () => {
    const value = redactDiagnosticText(
      'POST https://user:pass@example.com/v1?api_key=secret Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'
    );

    expect(value).toContain('https://example.com/v1');
    expect(value).toContain('[redacted-secret]');
    expect(value).not.toContain('user:pass');
    expect(value).not.toContain('api_key=secret');
    expect(value).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('summarizes local filesystem paths', () => {
    expect(redactFileSystemPath('C:\\Users\\alice\\project\\src\\file.ts')).toBe(
      '<abs>/src/file.ts'
    );
  });
});
