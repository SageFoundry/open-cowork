const ANYSEARCH_SEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search';
const DEFAULT_MAX_RESULTS = 5;
const TOOL_MAX_RESULTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ANONYMOUS_RATE_LIMIT = 10;
const AUTHENTICATED_RATE_LIMIT = 100;
const RESULT_CONTENT_LIMIT = 900;
const OUTPUT_LIMIT = 20_000;

const VALID_FRESHNESS = new Set(['day', 'week', 'month', 'year']);
const VALID_CONTENT_TYPES = new Set([
  'web',
  'news',
  'academic',
  'code',
  'doc',
  'data',
  'image',
  'video',
  'audio',
]);
const VALID_DOMAINS = new Set([
  'general',
  'news',
  'code',
  'tech',
  'fashion',
  'travel',
  'home',
  'ecommerce',
  'gaming',
  'film',
  'music',
  'finance',
  'academic',
  'legal',
  'business',
  'ip',
  'security',
  'education',
  'health',
  'religion',
  'geo',
  'environment',
  'energy',
  'ugc',
]);
const VALID_ZONES = new Set(['cn', 'intl']);

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AnySearchInput {
  query: string;
  maxResults?: number;
  freshness?: string;
  domains?: string[];
  contentTypes?: string[];
  zone?: string;
  language?: string;
}

export interface AnySearchOptions {
  apiKey?: string;
  endpoint?: string;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface NormalizedAnySearchInput {
  query: string;
  maxResults: number;
  freshness?: string;
  domains?: string[];
  contentTypes?: string[];
  zone?: string;
  language?: string;
}

interface AnySearchResultItem {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
  raw_content?: string;
  source?: string;
  score?: number;
  quality_score?: number;
  published_at?: string;
}

interface AnySearchMetadata {
  total_results?: number;
  search_time_ms?: number;
  routes_queried?: number;
  routes_succeeded?: number;
  cached?: boolean;
  request_id?: string;
  capability_errors?: unknown[];
}

interface AnySearchResponse {
  results?: AnySearchResultItem[];
  metadata?: AnySearchMetadata;
}

interface AnySearchSuccessEnvelope {
  code?: number;
  message?: string;
  data?: AnySearchResponse;
}

interface AnySearchErrorBody {
  code?: number;
  symbol?: string;
  message?: string;
  data?: Record<string, unknown>;
  request_id?: string;
}

const requestTimes = {
  anonymous: [] as number[],
  authenticated: [] as number[],
};

export class AnySearchClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'AnySearchClientError';
  }
}

export function resetAnySearchRateLimiter(): void {
  requestTimes.anonymous = [];
  requestTimes.authenticated = [];
}

export function normalizeAnySearchInput(input: AnySearchInput): NormalizedAnySearchInput {
  const query = input.query?.trim();
  if (!query) {
    throw new AnySearchClientError('Query is required.', 'invalid_request');
  }

  const maxResults = normalizeMaxResults(input.maxResults);
  const freshness = normalizeOptionalEnum(input.freshness, VALID_FRESHNESS, 'freshness');
  const domains = normalizeOptionalStringArray(input.domains, VALID_DOMAINS, 'domains');
  const contentTypes = normalizeOptionalStringArray(
    input.contentTypes,
    VALID_CONTENT_TYPES,
    'contentTypes'
  );
  const zone = normalizeOptionalEnum(input.zone, VALID_ZONES, 'zone');
  const language = input.language?.trim() || undefined;

  return {
    query,
    maxResults,
    ...(freshness ? { freshness } : {}),
    ...(domains ? { domains } : {}),
    ...(contentTypes ? { contentTypes } : {}),
    ...(zone ? { zone } : {}),
    ...(language ? { language } : {}),
  };
}

export async function searchAnySearch(
  input: AnySearchInput,
  options: AnySearchOptions = {}
): Promise<AnySearchResponse> {
  const normalized = normalizeAnySearchInput(input);
  return requestAnySearch(normalized, options);
}

export async function searchAnySearchAsText(
  input: AnySearchInput,
  options: AnySearchOptions = {}
): Promise<string> {
  const normalized = normalizeAnySearchInput(input);
  const response = await requestAnySearch(normalized, options);
  return formatAnySearchResponse(normalized, response);
}

async function requestAnySearch(
  input: NormalizedAnySearchInput,
  options: AnySearchOptions
): Promise<AnySearchResponse> {
  const apiKey = options.apiKey ?? process.env.ANYSEARCH_API_KEY ?? '';
  const trimmedApiKey = apiKey.trim();
  const now = options.now ?? Date.now;
  checkRateLimit(Boolean(trimmedApiKey), now());

  const payload = buildRequestPayload(input);
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(options.endpoint ?? ANYSEARCH_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'open-cowork',
        ...(trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new AnySearchClientError(
        'AnySearch request timed out. Check the network and retry.',
        'network_error'
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AnySearchClientError(`AnySearch network request failed: ${message}`, 'network_error');
  }

  const body = await readJsonBody(response);
  if (!response.ok) {
    throw mapAnySearchError(response, body);
  }

  return normalizeAnySearchResponse(body);
}

export function formatAnySearchResponse(
  input: NormalizedAnySearchInput,
  response: AnySearchResponse
): string {
  const metadata = response.metadata ?? {};
  const results = response.results ?? [];
  const parameters = [
    `max_results=${input.maxResults}`,
    input.freshness ? `freshness=${input.freshness}` : '',
    input.domains?.length ? `domains=${input.domains.join(',')}` : '',
    input.contentTypes?.length ? `content_types=${input.contentTypes.join(',')}` : '',
    input.zone ? `zone=${input.zone}` : '',
    input.language ? `language=${input.language}` : '',
  ].filter(Boolean);

  const lines = [
    'AnySearch Web Search',
    `Query: ${input.query}`,
    `Parameters: ${parameters.join('; ') || 'default'}`,
    formatMetadata(metadata),
    '',
    'Results:',
  ];

  if (results.length === 0) {
    lines.push('No results returned.');
  } else {
    results.forEach((item, index) => {
      lines.push('');
      lines.push(`${index + 1}. ${cleanText(item.title) || '(Untitled)'}`);
      lines.push(`URL: ${cleanText(item.url) || '(no url)'}`);
      if (item.source) lines.push(`Source: ${cleanText(item.source)}`);
      if (item.published_at) lines.push(`Published: ${cleanText(item.published_at)}`);
      if (typeof item.score === 'number') lines.push(`Score: ${formatScore(item.score)}`);
      if (typeof item.quality_score === 'number') {
        lines.push(`Quality: ${formatScore(item.quality_score)}`);
      }
      if (item.description) lines.push(`Description: ${cleanText(item.description)}`);
      if (item.content)
        lines.push(`Content: ${truncate(cleanText(item.content), RESULT_CONTENT_LIMIT)}`);
    });
  }

  lines.push('');
  lines.push('If using these results in the final answer, cite the real URLs above in Sources.');

  const output = lines.join('\n');
  return output.length > OUTPUT_LIMIT
    ? `${output.slice(0, OUTPUT_LIMIT)}\n\n[Truncated ${output.length - OUTPUT_LIMIT} chars]`
    : output;
}

function normalizeMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.max(1, Math.min(TOOL_MAX_RESULTS, Math.floor(value)));
}

function normalizeOptionalEnum(
  value: string | undefined,
  validValues: Set<string>,
  name: string
): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const normalized = value.trim();
  if (!validValues.has(normalized)) {
    throw new AnySearchClientError(
      `Invalid ${name}: ${normalized}. Allowed values: ${Array.from(validValues).join(', ')}`,
      'invalid_request'
    );
  }
  return normalized;
}

function normalizeOptionalStringArray(
  values: string[] | undefined,
  validValues: Set<string>,
  name: string
): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  const invalid = normalized.find((value) => !validValues.has(value));
  if (invalid) {
    throw new AnySearchClientError(
      `Invalid ${name} value: ${invalid}. Allowed values: ${Array.from(validValues).join(', ')}`,
      'invalid_request'
    );
  }
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function checkRateLimit(authenticated: boolean, now: number): void {
  const bucket = authenticated ? requestTimes.authenticated : requestTimes.anonymous;
  const limit = authenticated ? AUTHENTICATED_RATE_LIMIT : ANONYMOUS_RATE_LIMIT;
  while (bucket.length > 0 && now - bucket[0] >= RATE_LIMIT_WINDOW_MS) {
    bucket.shift();
  }
  if (bucket.length >= limit) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - bucket[0]);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    throw new AnySearchClientError(
      `AnySearch local rate limit reached (${limit} requests per 60 seconds). Retry in about ${retryAfterSeconds}s, or add a free AnySearch API key in Settings > Tools > Web Search to raise the limit.`,
      'rate_limit_exceeded',
      retryAfterSeconds
    );
  }
  bucket.push(now);
}

function buildRequestPayload(input: NormalizedAnySearchInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    query: input.query,
    max_results: input.maxResults,
  };
  if (input.domains) payload.domains = input.domains;
  if (input.contentTypes) payload.content_types = input.contentTypes;
  if (input.zone) payload.zone = input.zone;
  if (input.language) payload.language = input.language;
  if (input.freshness) payload.freshness = input.freshness;
  return payload;
}

function normalizeAnySearchResponse(body: unknown): AnySearchResponse {
  const envelope = body && typeof body === 'object' ? (body as AnySearchSuccessEnvelope) : {};
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new AnySearchClientError(
      `AnySearch request failed (${envelope.code}): ${cleanText(envelope.message) || 'request failed'}.`,
      'request_failed'
    );
  }

  const parsed =
    envelope.data && typeof envelope.data === 'object'
      ? envelope.data
      : (body as AnySearchResponse);

  return {
    results: Array.isArray(parsed.results) ? parsed.results : [],
    metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {},
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function mapAnySearchError(response: Response, body: unknown): AnySearchClientError {
  const errorBody = body && typeof body === 'object' ? (body as AnySearchErrorBody) : {};
  const symbol = cleanText(errorBody.symbol) || `http_${response.status}`;
  const requestId = cleanText(errorBody.request_id);
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'), errorBody.data);
  const suffix = requestId ? ` Request ID: ${requestId}.` : '';
  const autoRegisteredHint = hasAutoRegisteredApiKey(errorBody.data)
    ? ' The response included an auto-registered API key; Open Cowork did not save or expose it. Configure ANYSEARCH_API_KEY yourself if you want higher limits.'
    : '';
  const quotaData = formatQuotaData(errorBody.data);

  if (response.status === 400) {
    return new AnySearchClientError(
      `AnySearch rejected the request (${symbol}): ${cleanText(errorBody.message) || 'invalid request'}.${suffix}`,
      'invalid_request'
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new AnySearchClientError(
      `AnySearch API key problem (${symbol}): ${cleanText(errorBody.message) || response.statusText}. Check ANYSEARCH_API_KEY or remove it to use anonymous access.${suffix}`,
      'auth_error'
    );
  }
  if (response.status === 402 || response.status === 429) {
    return new AnySearchClientError(
      `AnySearch quota or rate limit hit (${symbol}): ${cleanText(errorBody.message) || response.statusText}.${quotaData}${retryAfter ? ` Retry after about ${retryAfter}s.` : ''} Add a free AnySearch API key in Settings > Tools > Web Search to raise the limit.${autoRegisteredHint}${suffix}`,
      response.status === 429 ? 'rate_limit_exceeded' : 'quota_exhausted',
      retryAfter
    );
  }
  if (response.status >= 500) {
    return new AnySearchClientError(
      `AnySearch service is temporarily unavailable (${response.status} ${symbol}). Retry later with backoff.${suffix}`,
      'service_unavailable'
    );
  }
  return new AnySearchClientError(
    `AnySearch request failed (${response.status} ${symbol}): ${cleanText(errorBody.message) || response.statusText}.${suffix}`,
    'request_failed'
  );
}

function parseRetryAfter(
  headerValue: string | null,
  data: Record<string, unknown> | undefined
): number | undefined {
  const headerNumber = headerValue ? Number(headerValue) : NaN;
  if (Number.isFinite(headerNumber) && headerNumber > 0) {
    return Math.ceil(headerNumber);
  }
  const dataRetryAfter = data?.retry_after;
  if (typeof dataRetryAfter === 'number' && Number.isFinite(dataRetryAfter) && dataRetryAfter > 0) {
    return Math.ceil(dataRetryAfter);
  }
  return undefined;
}

function hasAutoRegisteredApiKey(data: Record<string, unknown> | undefined): boolean {
  const autoRegistered = data?.auto_registered;
  return (
    Boolean(autoRegistered && typeof autoRegistered === 'object' && 'api_key' in autoRegistered) ||
    Boolean(data?.api_key)
  );
}

function formatQuotaData(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return '';
  }
  const quotaLimit = data.quota_limit;
  const quotaUsed = data.quota_used;
  const quotaRemaining = data.quota_remaining;
  if (
    typeof quotaLimit === 'number' ||
    typeof quotaUsed === 'number' ||
    typeof quotaRemaining === 'number'
  ) {
    return ` Quota: limit=${quotaLimit ?? 'unknown'}, used=${quotaUsed ?? 'unknown'}, remaining=${quotaRemaining ?? 'unknown'}.`;
  }
  return '';
}

function formatMetadata(metadata: AnySearchMetadata): string {
  const routes =
    metadata.routes_succeeded !== undefined || metadata.routes_queried !== undefined
      ? `${metadata.routes_succeeded ?? '?'}/${metadata.routes_queried ?? '?'}`
      : 'unknown';
  return [
    `Metadata: total_results=${metadata.total_results ?? 'unknown'}`,
    `search_time_ms=${metadata.search_time_ms ?? 'unknown'}`,
    `routes_succeeded=${routes}`,
    `cached=${metadata.cached ?? 'unknown'}`,
    `request_id=${metadata.request_id ?? 'unknown'}`,
  ].join('; ');
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function formatScore(value: number): string {
  return Number.isFinite(value)
    ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
    : String(value);
}
