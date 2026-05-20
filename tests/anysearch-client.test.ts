import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatAnySearchResponse,
  normalizeAnySearchInput,
  resetAnySearchRateLimiter,
  searchAnySearch,
} from '../src/main/search/anysearch-client';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('AnySearch client', () => {
  beforeEach(() => {
    resetAnySearchRateLimiter();
  });

  it('sends anonymous search requests without Authorization', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        results: [],
        metadata: { request_id: 'req-anon' },
      })
    );

    await searchAnySearch({ query: 'hello world' }, { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anysearch.com/v1/search');
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'hello world',
      max_results: 5,
    });
  });

  it('parses AnySearch v1 success envelopes', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        code: 0,
        message: 'success',
        data: {
          results: [
            {
              title: 'Wrapped Result',
              url: 'https://example.com/wrapped',
              content: 'wrapped content',
            },
          ],
          metadata: { request_id: 'req-wrapped', total_results: 1 },
        },
      })
    );

    const response = await searchAnySearch({ query: 'wrapped' }, { fetchFn });

    expect(response.results).toHaveLength(1);
    expect(response.results?.[0]?.title).toBe('Wrapped Result');
    expect(response.metadata?.request_id).toBe('req-wrapped');
  });

  it('sends API key search requests with Bearer Authorization', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ results: [], metadata: {} }));

    await searchAnySearch(
      { query: 'Go release notes', maxResults: 7, freshness: 'month' },
      { fetchFn, apiKey: 'as_sk_test' }
    );

    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer as_sk_test');
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'Go release notes',
      max_results: 7,
      freshness: 'month',
    });
  });

  it('normalizes parameters and caps maxResults for tool use', () => {
    expect(
      normalizeAnySearchInput({
        query: '  search me  ',
        maxResults: 100,
        freshness: 'week',
        domains: ['tech', 'tech', 'code'],
        contentTypes: ['web', 'doc', 'image'],
        zone: 'intl',
        language: 'en',
      })
    ).toEqual({
      query: 'search me',
      maxResults: 10,
      freshness: 'week',
      domains: ['tech', 'code'],
      contentTypes: ['web', 'doc', 'image'],
      zone: 'intl',
      language: 'en',
    });
  });

  it('rejects invalid enum parameters before making a request', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ results: [], metadata: {} }));

    await expect(searchAnySearch({ query: 'x', freshness: 'hour' }, { fetchFn })).rejects.toThrow(
      /Invalid freshness/
    );
    await expect(searchAnySearch({ query: 'x', domains: ['bad'] }, { fetchFn })).rejects.toThrow(
      /Invalid domains/
    );
    await expect(
      searchAnySearch({ query: 'x', contentTypes: ['bad'] }, { fetchFn })
    ).rejects.toThrow(/Invalid contentTypes/);
    await expect(searchAnySearch({ query: 'x', zone: 'us' }, { fetchFn })).rejects.toThrow(
      /Invalid zone/
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('formats results with metadata and bounded content', () => {
    const formatted = formatAnySearchResponse(
      { query: 'test', maxResults: 5 },
      {
        metadata: {
          total_results: 1,
          search_time_ms: 123,
          routes_queried: 2,
          routes_succeeded: 1,
          request_id: 'req-123',
          cached: false,
        },
        results: [
          {
            title: 'Example Result',
            url: 'https://example.com/a',
            source: 'web',
            published_at: '2026-05-20T00:00:00Z',
            description: 'Short summary',
            content: 'x'.repeat(1200),
          },
        ],
      }
    );

    expect(formatted).toContain('AnySearch Web Search');
    expect(formatted).toContain('request_id=req-123');
    expect(formatted).toContain('1. Example Result');
    expect(formatted).toContain('URL: https://example.com/a');
    expect(formatted).not.toContain('[Truncated');
    expect(formatted.length).toBeLessThan(20_000);
  });

  it('maps common API errors to user-readable errors without leaking auto keys', async () => {
    const secretKey = 'as_sk_secret_from_api';
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { symbol: 'invalid_request', message: 'bad query', request_id: 'req-400' },
          400
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({ symbol: 'invalid_api_key', message: 'bad key', request_id: 'req-401' }, 401)
      )
      .mockResolvedValueOnce(
        jsonResponse({ symbol: 'expired_api_key', message: 'expired', request_id: 'req-403' }, 403)
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            symbol: 'daily_free_quota_exhausted',
            message: 'quota done',
            data: { auto_registered: { api_key: secretKey } },
            request_id: 'req-402',
          },
          402
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { symbol: 'rate_limit_exceeded', message: 'too fast', data: { retry_after: 9 } },
          429
        )
      )
      .mockResolvedValueOnce(jsonResponse({ symbol: 'internal_error' }, 500));

    await expect(searchAnySearch({ query: 'a' }, { fetchFn })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(searchAnySearch({ query: 'b' }, { fetchFn })).rejects.toThrow(/API key problem/);
    await expect(searchAnySearch({ query: 'c' }, { fetchFn })).rejects.toThrow(/API key problem/);
    let quotaError: unknown;
    try {
      await searchAnySearch({ query: 'd' }, { fetchFn });
    } catch (error) {
      quotaError = error;
    }
    expect(String(quotaError)).toMatch(/quota/i);
    expect(String(quotaError)).not.toContain(secretKey);
    await expect(searchAnySearch({ query: 'e' }, { fetchFn })).rejects.toThrow(/Retry after/);
    await expect(searchAnySearch({ query: 'f' }, { fetchFn })).rejects.toThrow(/temporarily/);
  });

  it('enforces local anonymous and authenticated rate limits', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ results: [], metadata: {} }));
    const now = () => 1_000;

    for (let i = 0; i < 10; i += 1) {
      await searchAnySearch({ query: `anon ${i}` }, { fetchFn, now });
    }
    await expect(searchAnySearch({ query: 'anon over' }, { fetchFn, now })).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
      retryAfterSeconds: 60,
    });

    resetAnySearchRateLimiter();
    for (let i = 0; i < 100; i += 1) {
      await searchAnySearch({ query: `key ${i}` }, { fetchFn, apiKey: 'as_sk_test', now });
    }
    await expect(
      searchAnySearch({ query: 'key over' }, { fetchFn, apiKey: 'as_sk_test', now })
    ).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
      retryAfterSeconds: 60,
    });
  });
});
