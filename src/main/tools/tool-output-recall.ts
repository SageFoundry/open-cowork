import { randomUUID } from 'node:crypto';
import type { DatabaseInstance } from '../db/database';

const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_RECALL_MAX_CHARS = 8_000;
const MAX_RECALL_MAX_CHARS = 20_000;
const SEARCH_CONTEXT_CHARS = 700;

export type ToolOutputSnapshotReason = 'compressed' | 'truncated';

export interface CreateToolOutputSnapshotInput {
  sessionId: string | null;
  projectPath: string | null;
  toolName: string;
  reason: ToolOutputSnapshotReason;
  content: string;
}

export interface RecallToolOutputInput {
  handle: string;
  query?: string;
  start?: number;
  end?: number;
  maxChars?: number;
}

export interface RecallToolOutputResult {
  found: boolean;
  text: string;
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^tool-output:\/\//, '');
}

function clampMaxChars(maxChars: number | undefined): number {
  if (!Number.isFinite(maxChars ?? NaN)) {
    return DEFAULT_RECALL_MAX_CHARS;
  }
  return Math.max(500, Math.min(MAX_RECALL_MAX_CHARS, Math.floor(maxChars as number)));
}

function buildRangeLabel(start: number, end: number, total: number): string {
  return `chars ${start}-${end} of ${total}`;
}

export function createToolOutputSnapshot(
  db: DatabaseInstance,
  input: CreateToolOutputSnapshotInput
): string | null {
  const content = input.content.trim();
  if (!content) {
    return null;
  }

  const now = Date.now();
  db.toolOutputSnapshots.deleteOlderThan(now - SNAPSHOT_RETENTION_MS);

  const id = randomUUID();
  db.toolOutputSnapshots.create({
    id,
    session_id: input.sessionId,
    project_path: input.projectPath,
    tool_name: input.toolName,
    reason: input.reason,
    raw_chars: content.length,
    content,
    created_at: now,
  });

  return `tool-output://${id}`;
}

export function formatToolOutputRecallNotice(input: {
  handle: string;
  reason: ToolOutputSnapshotReason;
  rawChars: number;
  visibleChars: number;
}): string {
  const savedTokens = Math.max(0, Math.ceil((input.rawChars - input.visibleChars) / 4));
  const action =
    input.reason === 'compressed'
      ? 'Use recall_tool_output with this handle to inspect omitted original text.'
      : 'Use recall_tool_output with this handle to inspect truncated original text.';
  return [
    '',
    `[Open Cowork original output saved: ${input.handle}, raw=${input.rawChars} chars, visible=${input.visibleChars} chars, est_saved_tokens=${savedTokens}. ${action}]`,
  ].join('\n');
}

export function recallToolOutput(
  db: DatabaseInstance,
  input: RecallToolOutputInput
): RecallToolOutputResult {
  const id = normalizeHandle(input.handle);
  const snapshot = db.toolOutputSnapshots.get(id);
  if (!snapshot) {
    return {
      found: false,
      text: `No saved tool output found for handle: ${input.handle}`,
    };
  }

  const maxChars = clampMaxChars(input.maxChars);
  const content = snapshot.content;

  if (input.query?.trim()) {
    const terms = input.query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const lower = content.toLowerCase();
    const firstIndex = terms.length > 0 ? lower.indexOf(terms[0]) : -1;
    if (firstIndex < 0 || !terms.every((term) => lower.includes(term))) {
      return {
        found: true,
        text: `Saved output ${input.handle} has ${content.length} chars, but no match for query: "${input.query}"`,
      };
    }

    const start = Math.max(0, firstIndex - SEARCH_CONTEXT_CHARS);
    const end = Math.min(content.length, start + maxChars);
    return {
      found: true,
      text: [
        `Saved output ${input.handle} (${snapshot.tool_name}, ${snapshot.reason}, ${buildRangeLabel(
          start,
          end,
          content.length
        )})`,
        '',
        content.slice(start, end),
        end < content.length ? `\n[more available: request start=${end}]` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  const requestedStart = Math.max(0, Math.floor(input.start ?? 0));
  const requestedEnd =
    input.end !== undefined
      ? Math.max(requestedStart, Math.min(content.length, Math.floor(input.end)))
      : Math.min(content.length, requestedStart + maxChars);
  const end = Math.min(requestedEnd, requestedStart + maxChars);

  return {
    found: true,
    text: [
      `Saved output ${input.handle} (${snapshot.tool_name}, ${snapshot.reason}, ${buildRangeLabel(
        requestedStart,
        end,
        content.length
      )})`,
      '',
      content.slice(requestedStart, end),
      end < content.length ? `\n[more available: request start=${end}]` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
