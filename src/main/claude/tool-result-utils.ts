import { createHash } from 'node:crypto';

type ToolResultImage = {
  data: string;
  mimeType: string;
};

type NormalizedToolTextResult = {
  text: string;
  images: ToolResultImage[];
};

type NormalizedToolExecutionResult = {
  content: string;
  images: ToolResultImage[];
};

export interface ToolResultLimitInfo {
  truncated: boolean;
  rawChars: number;
  limitedChars: number;
}

export interface LimitedToolResult<T> {
  result: T;
  info: ToolResultLimitInfo;
}

const MAX_TOOL_RESULT_TEXT_CHARS = 80_000;
const MAX_TOOL_RESULT_TEXT_LINES = 2_000;
const TOOL_RESULT_HEAD_RATIO = 0.7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isToolResultImage(value: unknown): value is ToolResultImage {
  return (
    isRecord(value) &&
    typeof value.data === 'string' &&
    typeof value.mimeType === 'string' &&
    value.data.length > 0 &&
    value.mimeType.length > 0
  );
}

function redactLargeBinaryData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactLargeBinaryData(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const objectType = typeof value.type === 'string' ? value.type : undefined;
  const redacted: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue === 'string') {
      if (objectType === 'image' && key === 'data') {
        redacted[key] = `[image base64 omitted: ${nestedValue.length} chars]`;
        continue;
      }

      if ((key === 'base64' || key === 'inlineDataBase64') && nestedValue.length > 128) {
        redacted[key] = `[base64 omitted: ${nestedValue.length} chars]`;
        continue;
      }

      if (key === 'url' && /^data:image\//i.test(nestedValue)) {
        redacted[key] = `[image data URL omitted: ${nestedValue.length} chars]`;
        continue;
      }
    }

    redacted[key] = redactLargeBinaryData(nestedValue);
  }

  return redacted;
}

function safeStringifyToolResult(value: unknown): string {
  try {
    return JSON.stringify(redactLargeBinaryData(value));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return `[Unserializable tool result: ${details}]`;
  }
}

function scrubUnsafeControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '\uFFFD');
}

function buildTruncationMarker(omittedChars: number, omittedLines: number): string {
  const details = [
    omittedChars > 0 ? `${omittedChars} chars` : null,
    omittedLines > 0 ? `${omittedLines} lines` : null,
  ].filter(Boolean);
  const omitted = details.length > 0 ? details.join(', ') : 'content';
  return `[Tool output truncated: omitted ${omitted}. Open Cowork saves oversized original tool output when possible and appends a tool-output:// handle below. Use recall_tool_output with that handle to read the omitted text by start offset, line range, or query.]`;
}

function truncateByLines(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= MAX_TOOL_RESULT_TEXT_LINES) {
    return text;
  }

  const headLineCount = Math.floor(MAX_TOOL_RESULT_TEXT_LINES * TOOL_RESULT_HEAD_RATIO);
  const tailLineCount = MAX_TOOL_RESULT_TEXT_LINES - headLineCount;
  const omittedLines = lines.length - headLineCount - tailLineCount;
  const omittedChars = lines.slice(headLineCount, lines.length - tailLineCount).join('\n').length;

  return [
    ...lines.slice(0, headLineCount),
    '',
    buildTruncationMarker(omittedChars, omittedLines),
    '',
    ...lines.slice(lines.length - tailLineCount),
  ].join('\n');
}

function truncateByChars(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_TEXT_CHARS) {
    return text;
  }

  const marker = buildTruncationMarker(text.length - MAX_TOOL_RESULT_TEXT_CHARS, 0);
  const separator = `\n\n${marker}\n\n`;
  const availableChars = Math.max(0, MAX_TOOL_RESULT_TEXT_CHARS - separator.length);
  const headChars = Math.floor(availableChars * TOOL_RESULT_HEAD_RATIO);
  const tailChars = availableChars - headChars;
  const exactMarker = buildTruncationMarker(text.length - headChars - tailChars, 0);
  const exactSeparator = `\n\n${exactMarker}\n\n`;
  return `${text.slice(0, headChars)}${exactSeparator}${tailChars > 0 ? text.slice(-tailChars) : ''}`;
}

export function limitToolResultTextForContext(text: string): string {
  const scrubbed = scrubUnsafeControlChars(text);
  return truncateByChars(truncateByLines(scrubbed));
}

export function limitToolResultTextForContextWithInfo(text: string): {
  text: string;
  info: ToolResultLimitInfo;
} {
  const scrubbed = scrubUnsafeControlChars(text);
  const limited = truncateByChars(truncateByLines(scrubbed));
  return {
    text: limited,
    info: {
      truncated: limited !== scrubbed,
      rawChars: scrubbed.length,
      limitedChars: limited.length,
    },
  };
}

export function limitToolExecutionResultForModel<T>(result: T): T {
  return limitToolExecutionResultForModelWithInfo(result).result;
}

export function limitToolExecutionResultForModelWithInfo<T>(result: T): LimitedToolResult<T> {
  if (typeof result === 'string') {
    const limited = limitToolResultTextForContextWithInfo(result);
    return { result: limited.text as T, info: limited.info };
  }

  if (!isRecord(result) || !Array.isArray(result.content)) {
    return {
      result,
      info: {
        truncated: false,
        rawChars: 0,
        limitedChars: 0,
      },
    };
  }

  let truncated = false;
  let rawChars = 0;
  let limitedChars = 0;
  return {
    result: {
      ...result,
      content: result.content.map((part) => {
        if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
          const limited = limitToolResultTextForContextWithInfo(part.text);
          truncated = truncated || limited.info.truncated;
          rawChars += limited.info.rawChars;
          limitedChars += limited.info.limitedChars;
          return {
            ...part,
            text: limited.text,
          };
        }
        return part;
      }),
    } as T,
    info: {
      truncated,
      rawChars,
      limitedChars,
    },
  };
}

function summarizeStructuredToolPart(part: unknown): string | null {
  if (!isRecord(part)) {
    return typeof part === 'string' ? part : safeStringifyToolResult(part);
  }

  if (part.type === 'text') {
    return typeof part.text === 'string' ? part.text : '';
  }

  if (part.type === 'image' && isToolResultImage(part)) {
    return null;
  }

  return safeStringifyToolResult(part);
}

function extractImagesFromDetails(details: unknown): ToolResultImage[] {
  if (!isRecord(details) || !Array.isArray(details.openCoworkImages)) {
    return [];
  }

  return details.openCoworkImages.flatMap((image) =>
    isToolResultImage(image) ? [{ data: image.data, mimeType: image.mimeType }] : []
  );
}

function extractTextAndImagesFromContent(content: unknown): {
  textParts: string[];
  images: ToolResultImage[];
} {
  if (!Array.isArray(content)) {
    return { textParts: [], images: [] };
  }

  const textParts: string[] = [];
  const images: ToolResultImage[] = [];

  for (const part of content) {
    if (isRecord(part) && part.type === 'image' && isToolResultImage(part)) {
      images.push({ data: part.data, mimeType: part.mimeType });
      continue;
    }

    const summary = summarizeStructuredToolPart(part);
    if (summary && summary.trim()) {
      textParts.push(summary.trim());
    }
  }

  return { textParts, images };
}

function dedupeImages(images: ToolResultImage[]): ToolResultImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const hash = createHash('sha256').update(image.data).digest('hex');
    const key = `${image.mimeType}:${hash}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function finalizeText(textParts: string[], imageCount: number): string {
  const normalized = textParts.map((part) => part.trim()).filter(Boolean);
  if (normalized.length > 0) {
    return normalized.join('\n\n');
  }
  if (imageCount > 0) {
    return imageCount === 1
      ? '[1 image output omitted from text context]'
      : `[${imageCount} image outputs omitted from text context]`;
  }
  return '(no output)';
}

export function normalizeMcpToolResultForModel(result: unknown): NormalizedToolTextResult {
  const resultObj = isRecord(result) ? result : null;
  if (resultObj?.content) {
    const { textParts, images } = extractTextAndImagesFromContent(resultObj.content);
    return {
      text: limitToolResultTextForContext(finalizeText(textParts, images.length)),
      images,
    };
  }

  return {
    text: limitToolResultTextForContext(
      typeof result === 'string' ? result : safeStringifyToolResult(result)
    ),
    images: [],
  };
}

export function normalizeToolExecutionResultForUi(result: unknown): NormalizedToolExecutionResult {
  const resultObj = isRecord(result) ? result : null;
  const detailImages = extractImagesFromDetails(resultObj?.details);

  if (resultObj?.content) {
    const { textParts, images: inlineImages } = extractTextAndImagesFromContent(resultObj.content);
    const images = dedupeImages([...inlineImages, ...detailImages]);
    return {
      content: limitToolResultTextForContext(finalizeText(textParts, images.length)),
      images,
    };
  }

  return {
    content: limitToolResultTextForContext(
      typeof result === 'string' ? result : safeStringifyToolResult(result)
    ),
    images: dedupeImages(detailImages),
  };
}
