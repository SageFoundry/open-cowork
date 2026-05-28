import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  setRuntimeOpenRouterModelSpecs,
  type KnownModelSpecEntry,
} from '../claude/pi-model-resolution';
import { log, logError, logWarn } from '../utils/logger';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const RECENT_MODEL_WINDOW_MONTHS = 6;

interface OpenRouterModelSpecsCacheFile {
  updatedAt: string;
  sourceUrl: string;
  since: string;
  entries: KnownModelSpecEntry[];
}

export interface OpenRouterModelSpecsStatus {
  updatedAt?: string;
  sourceUrl: string;
  since?: string;
  count: number;
  imageCapable: number;
  textOnly: number;
  cachePath: string;
}

function getCachePath(): string {
  return path.join(app.getPath('userData'), 'cache', 'openrouter-model-specs.json');
}

function isoMonthsAgo(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function summarize(entries: KnownModelSpecEntry[]): Pick<
  OpenRouterModelSpecsStatus,
  'count' | 'imageCapable' | 'textOnly'
> {
  const imageCapable = entries.filter((entry) => entry.input?.includes('image')).length;
  return {
    count: entries.length,
    imageCapable,
    textOnly: entries.length - imageCapable,
  };
}

function isSpecsCacheFile(value: unknown): value is OpenRouterModelSpecsCacheFile {
  const candidate = value as Partial<OpenRouterModelSpecsCacheFile>;
  return (
    typeof candidate?.updatedAt === 'string' &&
    typeof candidate.sourceUrl === 'string' &&
    typeof candidate.since === 'string' &&
    Array.isArray(candidate.entries)
  );
}

function normalizeEntry(entry: KnownModelSpecEntry): KnownModelSpecEntry | null {
  const aliases = Array.isArray(entry.aliases)
    ? entry.aliases.map((alias) => String(alias).trim()).filter(Boolean)
    : [];
  const contextWindow = Number(entry.contextWindow);
  const maxTokens = Number(entry.maxTokens);
  if (!aliases.length || !Number.isFinite(contextWindow) || !Number.isFinite(maxTokens)) {
    return null;
  }
  return {
    aliases,
    contextWindow,
    maxTokens,
    ...(entry.input?.includes('image') ? { input: ['text', 'image'] as const } : {}),
  };
}

function normalizeCacheEntries(entries: KnownModelSpecEntry[]): KnownModelSpecEntry[] {
  return entries
    .map(normalizeEntry)
    .filter((entry): entry is KnownModelSpecEntry => Boolean(entry));
}

function transformOpenRouterModels(payload: unknown, sinceIso: string): KnownModelSpecEntry[] {
  const models = Array.isArray((payload as { data?: unknown[] })?.data)
    ? ((payload as { data: unknown[] }).data)
    : [];
  const sinceMs = Date.parse(sinceIso);

  return models
    .filter((item) => {
      const model = item as {
        created?: unknown;
        architecture?: { output_modalities?: unknown };
      };
      const createdMs =
        typeof model.created === 'number' ? model.created * 1000 : Number.NaN;
      const outputModalities = Array.isArray(model.architecture?.output_modalities)
        ? model.architecture.output_modalities
        : [];
      return createdMs >= sinceMs && outputModalities.includes('text');
    })
    .map((item) => {
      const model = item as {
        id?: unknown;
        canonical_slug?: unknown;
        context_length?: unknown;
        top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
        architecture?: { input_modalities?: unknown };
      };
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      const canonicalSlug =
        typeof model.canonical_slug === 'string' ? model.canonical_slug.trim() : '';
      const aliases = [id, canonicalSlug].filter(
        (alias, index, values) => alias && values.indexOf(alias) === index
      );
      const contextWindow =
        Number(model.top_provider?.context_length ?? model.context_length ?? 0) || 0;
      const maxTokens = Number(model.top_provider?.max_completion_tokens ?? 0) || 0;
      const inputModalities = Array.isArray(model.architecture?.input_modalities)
        ? model.architecture.input_modalities
        : [];
      return normalizeEntry({
        aliases,
        contextWindow,
        maxTokens,
        ...(inputModalities.includes('image') ? { input: ['text', 'image'] } : {}),
      });
    })
    .filter((entry): entry is KnownModelSpecEntry => Boolean(entry));
}

export async function initializeOpenRouterModelSpecsCache(): Promise<OpenRouterModelSpecsStatus> {
  const cachePath = getCachePath();
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isSpecsCacheFile(parsed)) {
      throw new Error('Invalid OpenRouter model specs cache');
    }
    const entries = normalizeCacheEntries(parsed.entries);
    setRuntimeOpenRouterModelSpecs(entries);
    log('[OpenRouterSpecs] Loaded model specs cache:', {
      count: entries.length,
      updatedAt: parsed.updatedAt,
      cachePath,
    });
    return {
      updatedAt: parsed.updatedAt,
      sourceUrl: parsed.sourceUrl,
      since: parsed.since,
      cachePath,
      ...summarize(entries),
    };
  } catch (error) {
    logWarn('[OpenRouterSpecs] No usable model specs cache, using built-in specs:', error);
    return {
      sourceUrl: OPENROUTER_MODELS_URL,
      cachePath,
      count: 0,
      imageCapable: 0,
      textOnly: 0,
    };
  }
}

export async function refreshOpenRouterModelSpecsCache(): Promise<OpenRouterModelSpecsStatus> {
  const since = isoMonthsAgo(RECENT_MODEL_WINDOW_MONTHS);
  const response = await fetch(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const entries = transformOpenRouterModels(payload, since);
  if (!entries.length) {
    throw new Error('OpenRouter returned no recent text-output model specs');
  }

  setRuntimeOpenRouterModelSpecs(entries);

  const cachePath = getCachePath();
  const cacheFile: OpenRouterModelSpecsCacheFile = {
    updatedAt: new Date().toISOString(),
    sourceUrl: OPENROUTER_MODELS_URL,
    since,
    entries,
  };
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cacheFile, null, 2)}\n`, 'utf8');

  const status = {
    updatedAt: cacheFile.updatedAt,
    sourceUrl: cacheFile.sourceUrl,
    since: cacheFile.since,
    cachePath,
    ...summarize(entries),
  };
  log('[OpenRouterSpecs] Refreshed model specs cache:', status);
  return status;
}

export async function getOpenRouterModelSpecsStatus(): Promise<OpenRouterModelSpecsStatus> {
  try {
    return await initializeOpenRouterModelSpecsCache();
  } catch (error) {
    logError('[OpenRouterSpecs] Failed reading model specs cache:', error);
    return {
      sourceUrl: OPENROUTER_MODELS_URL,
      cachePath: getCachePath(),
      count: 0,
      imageCapable: 0,
      textOnly: 0,
    };
  }
}
