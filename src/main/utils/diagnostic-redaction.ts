import { homedir } from 'os';
import path from 'path';

export const DIAGNOSTIC_REDACTION_VERSION = 1;

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|secret|password|passwd|credential|private[_-]?key|refresh[_-]?token)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|rk|ak|AIza|xox[baprs]|gh[pousr]|glpat|sk-ant|sk-or-v1)[-_A-Za-z0-9]{8,}\b/g,
  /\b[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\b/g,
];

export function isSensitiveDiagnosticKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function getPathTail(value: string, maxSegments = 2): string {
  const normalized = normalizePathSeparators(value).replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '';
  }
  return segments.slice(-maxSegments).join('/');
}

function getRelativeTail(value: string, basePath: string, maxSegments = 2): string {
  const normalizedValue = normalizePathSeparators(value).replace(/\/+$/, '');
  const normalizedBase = normalizePathSeparators(basePath).replace(/\/+$/, '');
  if (!normalizedBase || !normalizedValue.startsWith(normalizedBase)) {
    return getPathTail(normalizedValue, maxSegments);
  }

  const suffix = normalizedValue.slice(normalizedBase.length).replace(/^\/+/, '');
  if (!suffix) {
    return '';
  }
  return getPathTail(suffix, maxSegments);
}

export function redactFileSystemPath(value?: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }

  const trimmed = value.trim();
  const normalized = normalizePathSeparators(trimmed);
  const normalizedHome = normalizePathSeparators(homedir());

  if (normalizedHome && normalized.startsWith(normalizedHome)) {
    const tail = getRelativeTail(normalized, normalizedHome);
    return tail ? `<home>/${tail}` : '<home>';
  }

  const winTempDirs = [process.env.TEMP, process.env.TMP]
    .filter(Boolean)
    .map((d) => normalizePathSeparators(path.normalize(d!)));
  const normalizedForTmpCheck = normalizePathSeparators(path.normalize(trimmed));

  for (const winTmp of winTempDirs) {
    if (normalizedForTmpCheck.startsWith(winTmp)) {
      const tail = getRelativeTail(normalizedForTmpCheck, winTmp);
      return tail ? `<tmp>/${tail}` : '<tmp>';
    }
  }

  if (/AppData[/\\]Local[/\\]Temp/i.test(trimmed)) {
    const appDataTempIdx = normalizedForTmpCheck.search(/appdata\/local\/temp/i);
    if (appDataTempIdx >= 0) {
      const tmpBase = normalizedForTmpCheck.slice(
        0,
        appDataTempIdx + 'AppData/Local/Temp'.length
      );
      const tail = getRelativeTail(normalizedForTmpCheck, tmpBase);
      return tail ? `<tmp>/${tail}` : '<tmp>';
    }
  }

  if (
    normalized.startsWith('/tmp') ||
    normalized.startsWith('/private/tmp') ||
    normalized.startsWith('/var/folders/')
  ) {
    const tmpBase = normalized.startsWith('/private/tmp')
      ? '/private/tmp'
      : normalized.startsWith('/var/folders/')
        ? '/var/folders'
        : '/tmp';
    const tail = getRelativeTail(normalized, tmpBase);
    return tail ? `<tmp>/${tail}` : '<tmp>';
  }

  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') || path.isAbsolute(trimmed)) {
    const tail = getPathTail(normalized);
    return tail ? `<abs>/${tail}` : '<abs>';
  }

  return trimmed;
}

export function redactSensitiveString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[redacted-secret]'),
    value
  );
}

export function redactDiagnosticText(value: string): string {
  let redacted = redactSensitiveString(value);

  for (const rawPath of [homedir(), process.env.TEMP, process.env.TMP].filter(Boolean) as string[]) {
    const normalized = rawPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(normalized, 'gi'), redactFileSystemPath(rawPath) || '');
    redacted = redacted.replace(
      new RegExp(normalized.replace(/\\\\/g, '/'), 'gi'),
      redactFileSystemPath(rawPath) || ''
    );
  }

  redacted = redacted.replace(
    /https?:\/\/[^\s"'<>]+/gi,
    (match) => sanitizeDiagnosticUrl(match) || match
  );
  redacted = redacted.replace(
    /\b[A-Za-z]:\\[^\s"'<>|]+/g,
    (match) => redactFileSystemPath(match) || match
  );
  redacted = redacted.replace(
    /\b[A-Za-z]:\/[^\s"'<>|]+/g,
    (match) => redactFileSystemPath(match) || match
  );

  return redacted;
}

export function sanitizeDiagnosticUrl(value?: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }

  const trimmed = redactSensitiveString(value.trim());
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.split(/[?#]/, 1)[0] || null;
  }
}

export function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return '[max-depth]';
  }
  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactDiagnosticValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      isSensitiveDiagnosticKey(key) ? '[redacted-secret]' : redactDiagnosticValue(item, depth + 1),
    ])
  );
}
