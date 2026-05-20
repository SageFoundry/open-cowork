import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnySearchTool } from '../src/main/search/anysearch-tool';
import { resetAnySearchRateLimiter } from '../src/main/search/anysearch-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AnySearch websearch tool', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetAnySearchRateLimiter();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('exposes a websearch custom tool', () => {
    const tool = buildAnySearchTool({ getApiKey: () => undefined });

    expect(tool.name).toBe('websearch');
    expect(tool.label).toBe('Web Search');
    expect(tool.description).toMatch(/AnySearch/);
  });

  it('executes searches and returns citation-ready URLs', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: 'AnySearch Docs',
            url: 'https://www.anysearch.com/docs',
            description: 'Docs',
            content: 'Unified search API docs',
            source: 'doc',
          },
        ],
        metadata: { request_id: 'req-tool', total_results: 1 },
      })
    );

    const tool = buildAnySearchTool({ getApiKey: () => undefined });
    const result = await tool.execute(
      'tool-1',
      { query: 'AnySearch docs', maxResults: 3 },
      undefined,
      undefined,
      undefined
    );

    expect(result.content[0]?.text).toContain('AnySearch Web Search');
    expect(result.content[0]?.text).toContain('https://www.anysearch.com/docs');
    expect(result.content[0]?.text).toContain('Sources');
  });

  it('uses the configured AnySearch API key when present', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({
        results: [],
        metadata: { request_id: 'req-key' },
      })
    );

    const tool = buildAnySearchTool({ getApiKey: () => ' as_sk_configured ' });
    await tool.execute('tool-2', { query: 'AnySearch limits' }, undefined, undefined, undefined);

    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer as_sk_configured');
  });
});
