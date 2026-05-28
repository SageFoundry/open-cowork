import { estimateTextTokens } from '../context/context-budget';
import type { ToolOutputCompressionLevel } from '../config/config-store';

export type ToolOutputCategory =
  | 'Git'
  | 'Search'
  | 'Tests'
  | 'Build'
  | 'Files'
  | 'HTTP'
  | 'MCP'
  | 'Other';
export type ToolOutputSkipReason =
  | 'level_off'
  | 'explicit_raw'
  | 'short_output'
  | 'unsupported_command'
  | 'low_savings'
  | 'semantic_sensitive'
  | 'non_text';

export interface ToolOutputCompressionContext {
  toolName: string;
  params?: unknown;
  level: ToolOutputCompressionLevel;
}

export interface ToolOutputCompressionEventInput {
  toolName: string;
  commandFamily: string;
  category: ToolOutputCategory;
  level: ToolOutputCompressionLevel;
  strategy: string;
  compressed: boolean;
  skipReason: ToolOutputSkipReason | null;
  rawChars: number;
  compressedChars: number;
  inputTokensEst: number;
  outputTokensEst: number;
  savedTokensEst: number;
  savingsPct: number;
}

export interface ToolOutputCompressionResult<T> {
  result: T;
  event: ToolOutputCompressionEventInput | null;
}

interface CommandInfo {
  command: string;
  family: string;
  category: ToolOutputCategory;
  strategy: string;
  supported: boolean;
}

type TextPart = Record<string, unknown> & { type: 'text'; text: string };

const RAW_INTENT_FLAGS = [
  '--verbose',
  '--debug',
  '--trace',
  '--json',
  '--raw',
  '--full',
  '--no-trunc',
  '--nocapture',
];

const MIN_CHARS: Record<ToolOutputCompressionLevel, number> = {
  off: Number.POSITIVE_INFINITY,
  conservative: 1200,
  aggressive: 900,
};

const GENERIC_FALLBACK_MIN_CHARS: Record<ToolOutputCompressionLevel, number> = {
  off: Number.POSITIVE_INFINITY,
  conservative: 3600,
  aggressive: 900,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractCommand(params: unknown): string {
  if (!isRecord(params)) {
    return '';
  }
  const command = params.command;
  if (typeof command === 'string') {
    return command.trim();
  }
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : '';
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  if (method || url) {
    return [method || 'HTTP', url].filter(Boolean).join(' ');
  }
  return '';
}

function normalizeCommand(command: string): string {
  let normalized = command
    .replace(/^\s*(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/i, '')
    .replace(/^\s*(?:sudo\s+|command\s+|exec\s+|bundle\s+exec\s+|poetry\s+run\s+|uv\s+run\s+)/i, '')
    .trim();

  for (;;) {
    const next = normalized.replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^&;]+?)\s*(?:&&|;)\s*/i, '').trim();
    if (next === normalized) {
      return normalized;
    }
    normalized = next;
  }
}

function stripGitGlobalOptions(command: string): string {
  const tool = command.match(/^(git|yadm)\b/i)?.[1];
  if (!tool) {
    return command;
  }

  let rest = command.slice(tool.length).trim();
  for (;;) {
    const withValue = rest.match(/^-(?:C|c)\s+(?:"[^"]+"|'[^']+'|\S+)\s*/);
    if (withValue) {
      rest = rest.slice(withValue[0].length).trim();
      continue;
    }
    const longWithValue = rest.match(/^--(?:git-dir|work-tree|namespace)=\S+\s*/i);
    if (longWithValue) {
      rest = rest.slice(longWithValue[0].length).trim();
      continue;
    }
    break;
  }

  return `${tool} ${rest}`.trim();
}

function hasExplicitRawIntent(command: string): boolean {
  const normalized = ` ${command} `;
  if (/\s-v{1,3}(\s|$)/.test(normalized)) {
    return true;
  }
  return RAW_INTENT_FLAGS.some((flag) => normalized.includes(` ${flag}`));
}

function classifyCommand(toolName: string, params: unknown): CommandInfo {
  const command = stripGitGlobalOptions(normalizeCommand(extractCommand(params)));
  const lowerTool = toolName.toLowerCase();
  const lower = command.toLowerCase();

  if (lowerTool === 'http') {
    return { command, family: 'http', category: 'HTTP', strategy: 'http-body', supported: true };
  }

  if (lowerTool.startsWith('mcp__')) {
    return { command, family: 'mcp', category: 'MCP', strategy: 'generic-text', supported: true };
  }

  if (/(^|[_-])web[_-]?search$|^search$/.test(lowerTool)) {
    return {
      command,
      family: lowerTool,
      category: 'Search',
      strategy: 'web-search-results',
      supported: true,
    };
  }

  if (/^(git|yadm)\s+(status|log|diff|show)\b/.test(lower)) {
    const sub = lower.match(/^(?:git|yadm)\s+(\w+)/)?.[1] || 'git';
    const isBlobShow = sub === 'show' && /^(?:git|yadm)\s+show\s+\S+:.+/.test(lower);
    return {
      command,
      family: `git ${sub}`,
      category: 'Git',
      strategy: isBlobShow ? 'git-show-file' : `git-${sub}`,
      supported: true,
    };
  }

  if (/^(rg|grep)\b/.test(lower) || /^select-string\b/.test(lower)) {
    const family = lower.startsWith('select-string')
      ? 'Select-String'
      : lower.startsWith('rg')
        ? 'rg'
        : 'grep';
    return { command, family, category: 'Search', strategy: 'search-results', supported: true };
  }

  if (
    /^(ls|tree|find|cat|head|tail|nl)\b/.test(lower) ||
    /^sed\s+-n\b/.test(lower) ||
    /^(get-childitem|gci|dir|get-content|gc|type)\b/.test(lower)
  ) {
    const family = lower.match(/^(\S+)/)?.[1] || 'files';
    return { command, family, category: 'Files', strategy: 'file-list', supported: true };
  }

  const packageScript = lower.match(/^(npm|pnpm|yarn)\s+(?:run\s+)?(test|typecheck|lint|build)\b/);
  if (packageScript?.[2] === 'test') {
    return {
      command,
      family: `${packageScript[1]} test`,
      category: 'Tests',
      strategy: 'test-output',
      supported: true,
    };
  }
  if (packageScript) {
    return {
      command,
      family: `${packageScript[1]} ${packageScript[2]}`,
      category: 'Build',
      strategy: 'diagnostic-output',
      supported: true,
    };
  }

  if (
    /\b(vitest|pytest)\b/.test(lower) ||
    /^cargo\s+test\b/.test(lower) ||
    /^go\s+test\b/.test(lower) ||
    /^(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(lower)
  ) {
    const family =
      lower.match(/\b(vitest|pytest)\b/)?.[1] ||
      lower.match(/^(cargo|go|npm|pnpm|yarn)/)?.[1] ||
      'test';
    return {
      command,
      family: family === 'cargo' ? 'cargo test' : family === 'go' ? 'go test' : family,
      category: 'Tests',
      strategy: 'test-output',
      supported: true,
    };
  }

  if (
    /\b(tsc|eslint|ruff)\b/.test(lower) ||
    /\bvite\s+build\b/.test(lower) ||
    /^(npx|npm\s+exec|pnpm\s+exec|yarn\s+exec)\s+(tsc|eslint|ruff)\b/.test(lower)
  ) {
    const family = lower.match(/\b(tsc|eslint|ruff)\b/)?.[1] || 'build';
    return { command, family, category: 'Build', strategy: 'diagnostic-output', supported: true };
  }

  return {
    command,
    family: lowerTool || 'unknown',
    category: lowerTool === 'bash' || lowerTool === 'pwsh' ? 'Other' : 'MCP',
    strategy: lowerTool === 'bash' || lowerTool === 'pwsh' ? 'unsupported' : 'generic-text',
    supported: lowerTool !== 'bash' && lowerTool !== 'pwsh',
  };
}

function lineLimitFor(
  level: ToolOutputCompressionLevel,
  conservative: number,
  aggressive: number
): number {
  return level === 'aggressive' ? aggressive : conservative;
}

function withCompressionNotice(
  body: string,
  rawChars: number,
  compressedCharsBeforeNotice: number,
  strategy: string
): string {
  return [
    body.trimEnd(),
    '',
    `[Open Cowork compressed tool output: ${rawChars} chars -> ${compressedCharsBeforeNotice} chars, strategy=${strategy}. Rerun with a narrower command or explicit verbose/raw flags for full output.]`,
  ].join('\n');
}

function headTail(lines: string[], head: number, tail: number, label = 'lines'): string {
  if (lines.length <= head + tail + 1) {
    return lines.join('\n');
  }
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `[... ${omitted} ${label} omitted ...]`,
    ...lines.slice(lines.length - tail),
  ].join('\n');
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function compressGit(text: string, info: CommandInfo, level: ToolOutputCompressionLevel): string {
  const lines = text.split(/\r?\n/);
  if (info.strategy === 'git-status' || info.family === 'git status') {
    const keep = lines.filter((line) =>
      /^(STDOUT:|STDERR:|Exit code:|On branch|Your branch|Changes|Untracked|modified:|new file:|deleted:|renamed:|M\s|A\s|D\s|\?\?)/.test(
        line.trim()
      )
    );
    return keep.length > 0 ? headTail(keep, 80, 20) : headTail(lines, 80, 20);
  }

  if (info.strategy === 'git-log' || info.family === 'git log') {
    return headTail(lines, lineLimitFor(level, 80, 40), 10, 'git log lines');
  }

  if (info.strategy === 'git-show-file') {
    return headTail(
      lines,
      lineLimitFor(level, 140, 90),
      lineLimitFor(level, 30, 20),
      'git show file lines'
    );
  }

  const maxLines = lineLimitFor(level, 220, 120);
  const kept: string[] = [];
  let hunkChangedLines = 0;
  for (const line of lines) {
    const important =
      /^(STDOUT:|STDERR:|Exit code:|diff --git|index |--- |\+\+\+ |@@ |Binary files|rename from|rename to|new file mode|deleted file mode)/.test(
        line
      ) ||
      (/^[+-]/.test(line) &&
        !/^(\+\+\+|---)/.test(line) &&
        hunkChangedLines < (level === 'aggressive' ? 4 : 8));
    if (line.startsWith('@@ ')) {
      hunkChangedLines = 0;
    }
    if (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) {
      hunkChangedLines += 1;
    }
    if (important) {
      kept.push(line);
    }
    if (kept.length >= maxLines) {
      kept.push(`[... git diff truncated after ${maxLines} important lines ...]`);
      break;
    }
  }
  return kept.length > 0 ? kept.join('\n') : headTail(lines, 120, 30);
}

function compressSearch(text: string, level: ToolOutputCompressionLevel): string {
  const cleanText = stripAnsi(text);
  const lines = cleanText.split(/\r?\n/);
  const perFile = lineLimitFor(level, 4, 2);
  const groups = new Map<string, string[]>();
  const other: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([^:\r\n]+):(\d+|line\s+\d+)?[:\)]/i);
    if (!match) {
      other.push(line);
      continue;
    }
    const key = match[1];
    const group = groups.get(key) || [];
    if (group.length < perFile) {
      group.push(line);
    }
    groups.set(key, group);
  }

  if (groups.size === 0) {
    return headTail(lines, lineLimitFor(level, 120, 60), 20);
  }

  const out = [...other.filter(Boolean).slice(0, 20)];
  const maxFiles = lineLimitFor(level, 60, 30);
  let shownFiles = 0;
  for (const [file, matches] of groups) {
    if (shownFiles >= maxFiles) {
      break;
    }
    out.push(`${file}: ${matches.length}${matches.length === perFile ? '+' : ''} shown`);
    out.push(...matches.map((line) => `  ${line}`));
    shownFiles += 1;
  }
  if (groups.size > shownFiles) {
    out.push(`[... ${groups.size - shownFiles} matched files omitted ...]`);
  }
  out.push(`Search summary: ${groups.size} files matched.`);
  return out.join('\n');
}

function compressDiagnostics(text: string, level: ToolOutputCompressionLevel): string {
  const lines = stripAnsi(text).split(/\r?\n/);
  const important = lines.filter((line) =>
    /(STDOUT:|STDERR:|Exit code:|error|failed|failure|FAIL|FAILED|Assertion|Expected|Received|panic|TS\d+|ESLint|ruff|✖|×|\sat\s|:\d+:\d+)/i.test(
      line
    )
  );
  if (important.length === 0) {
    return headTail(lines, lineLimitFor(level, 80, 40), 20);
  }
  return headTail(important, lineLimitFor(level, 180, 90), 30, 'diagnostic lines');
}

function compressFileList(text: string, level: ToolOutputCompressionLevel): string {
  const lines = stripAnsi(text).split(/\r?\n/);
  return headTail(
    lines,
    lineLimitFor(level, 140, 70),
    lineLimitFor(level, 30, 15),
    'file-list lines'
  );
}

function compressHttp(text: string, level: ToolOutputCompressionLevel): string | null {
  const lines = text.split(/\r?\n/);
  const first = lines[0] || '';
  const status = first.match(/^HTTP\s+(\d{3})/i);
  if (!status || !status[1].startsWith('2')) {
    return null;
  }
  const blankIndex = lines.findIndex((line) => line.trim() === '');
  if (blankIndex < 0) {
    return headTail(lines, 80, 20);
  }
  const headers = lines.slice(0, blankIndex);
  const body = lines.slice(blankIndex + 1);
  const bodyLimit = lineLimitFor(level, 80, 35);
  return [...headers, '', headTail(body, bodyLimit, 10, 'HTTP body lines')].join('\n');
}

function compressGeneric(text: string, level: ToolOutputCompressionLevel): string {
  const lines = stripAnsi(text).split(/\r?\n/);
  return headTail(lines, lineLimitFor(level, 160, 80), lineLimitFor(level, 30, 15));
}

function compressText(
  text: string,
  info: CommandInfo,
  level: ToolOutputCompressionLevel
): string | null {
  switch (info.category) {
    case 'Git':
      return compressGit(text, info, level);
    case 'Search':
      return compressSearch(text, level);
    case 'Files':
      return compressFileList(text, level);
    case 'Tests':
    case 'Build':
      return compressDiagnostics(text, level);
    case 'HTTP':
      return compressHttp(text, level);
    case 'MCP':
      return compressGeneric(text, level);
    default:
      return compressGeneric(text, level);
  }
}

function buildEvent(
  info: CommandInfo,
  toolName: string,
  level: ToolOutputCompressionLevel,
  rawText: string,
  outputText: string,
  compressed: boolean,
  skipReason: ToolOutputSkipReason | null
): ToolOutputCompressionEventInput {
  const inputTokens = estimateTextTokens(rawText);
  const outputTokens = estimateTextTokens(outputText);
  const saved = Math.max(0, inputTokens - outputTokens);
  const savingsPct = inputTokens > 0 ? (saved / inputTokens) * 100 : 0;
  return {
    toolName,
    commandFamily: info.family,
    category: info.category,
    level,
    strategy: compressed && !info.supported ? 'generic-text' : info.strategy,
    compressed,
    skipReason,
    rawChars: rawText.length,
    compressedChars: outputText.length,
    inputTokensEst: inputTokens,
    outputTokensEst: outputTokens,
    savedTokensEst: saved,
    savingsPct,
  };
}

function compressPlainText(
  text: string,
  context: ToolOutputCompressionContext
): { text: string; event: ToolOutputCompressionEventInput } {
  const info = classifyCommand(context.toolName, context.params);

  if (context.level === 'off') {
    return {
      text,
      event: buildEvent(info, context.toolName, context.level, text, text, false, 'level_off'),
    };
  }

  if (hasExplicitRawIntent(info.command)) {
    return {
      text,
      event: buildEvent(info, context.toolName, context.level, text, text, false, 'explicit_raw'),
    };
  }

  if (info.strategy === 'web-search-results') {
    return {
      text,
      event: buildEvent(
        info,
        context.toolName,
        context.level,
        text,
        text,
        false,
        'semantic_sensitive'
      ),
    };
  }

  if (info.family === 'read_full') {
    return {
      text,
      event: buildEvent(info, context.toolName, context.level, text, text, false, 'semantic_sensitive'),
    };
  }

  if (text.length < MIN_CHARS[context.level]) {
    return {
      text,
      event: buildEvent(info, context.toolName, context.level, text, text, false, 'short_output'),
    };
  }

  if (!info.supported && text.length < GENERIC_FALLBACK_MIN_CHARS[context.level]) {
    return {
      text,
      event: buildEvent(
        info,
        context.toolName,
        context.level,
        text,
        text,
        false,
        'unsupported_command'
      ),
    };
  }

  const compressedBody = compressText(text, info, context.level);
  if (!compressedBody) {
    return {
      text,
      event: buildEvent(
        info,
        context.toolName,
        context.level,
        text,
        text,
        false,
        'unsupported_command'
      ),
    };
  }

  if (compressedBody.length >= text.length * 0.95) {
    return {
      text,
      event: buildEvent(info, context.toolName, context.level, text, text, false, 'low_savings'),
    };
  }

  const strategy = !info.supported ? 'generic-text' : info.strategy;
  const compressed = withCompressionNotice(
    text === compressedBody ? text : compressedBody,
    text.length,
    compressedBody.length,
    strategy
  );
  return {
    text: compressed,
    event: buildEvent(info, context.toolName, context.level, text, compressed, true, null),
  };
}

function isTextPart(part: unknown): part is TextPart {
  return isRecord(part) && part.type === 'text' && typeof part.text === 'string';
}

export function compressToolExecutionResultForModel<T>(
  result: T,
  context: ToolOutputCompressionContext
): ToolOutputCompressionResult<T> {
  if (typeof result === 'string') {
    const compressed = compressPlainText(result, context);
    return { result: compressed.text as T, event: compressed.event };
  }

  if (!isRecord(result) || !Array.isArray(result.content)) {
    const info = classifyCommand(context.toolName, context.params);
    return {
      result,
      event: buildEvent(info, context.toolName, context.level, '', '', false, 'non_text'),
    };
  }

  const firstTextIndex = result.content.findIndex(isTextPart);
  if (firstTextIndex < 0) {
    const info = classifyCommand(context.toolName, context.params);
    return {
      result,
      event: buildEvent(info, context.toolName, context.level, '', '', false, 'non_text'),
    };
  }

  const textParts = result.content.filter(isTextPart);
  const combinedText = textParts.map((part) => part.text).join('\n\n');
  const compressed = compressPlainText(combinedText, context);

  if (compressed.text === combinedText) {
    return { result, event: compressed.event };
  }

  let replacedText = false;
  const nextContent = result.content
    .filter((part, index) => {
      if (index === firstTextIndex) {
        return true;
      }
      return !isTextPart(part);
    })
    .map((part) => {
      if (!replacedText && isTextPart(part)) {
        replacedText = true;
        return { ...part, text: compressed.text };
      }
      return part;
    });

  return {
    result: {
      ...result,
      content: nextContent,
    } as T,
    event: compressed.event,
  };
}
