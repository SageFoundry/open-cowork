import type { DatabaseInstance } from '../db/database';
import type { ToolCompressionBreakdownItem, ToolCompressionStats } from '../../shared/ipc-types';
import type { ToolOutputCompressionEventInput } from './tool-output-compression';

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecordToolOutputCompressionEventInput {
  sessionId?: string;
  projectPath?: string;
  event: ToolOutputCompressionEventInput;
}

interface AggregateRow {
  total_commands: number | null;
  compressed_commands: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_saved_tokens: number | null;
}

interface BreakdownRow {
  name: string;
  commands: number;
  saved_tokens: number;
  input_tokens: number;
}

interface SkipReasonRow {
  reason: string;
  count: number;
}

interface DailyRow {
  date: string;
  commands: number;
  saved_tokens: number;
}

interface ToolOutputCompressionStatsOptions {
  sessionId?: string | null;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function toBreakdown(row: BreakdownRow): ToolCompressionBreakdownItem {
  const savingsPct = row.input_tokens > 0 ? (row.saved_tokens / row.input_tokens) * 100 : 0;
  return {
    name: row.name,
    commands: row.commands,
    savedTokens: row.saved_tokens,
    savingsPct,
  };
}

function cleanupOld(db: DatabaseInstance): void {
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  db.raw.prepare('DELETE FROM tool_output_compression_events WHERE timestamp < ?').run(cutoff);
}

export function recordToolOutputCompressionEvent(
  db: DatabaseInstance,
  input: RecordToolOutputCompressionEventInput
): void {
  cleanupOld(db);
  const event = input.event;
  db.raw
    .prepare(
      `
      INSERT INTO tool_output_compression_events (
        timestamp, session_id, project_path, tool_name, command_family, category, level, strategy,
        compressed, skip_reason, raw_chars, compressed_chars, input_tokens_est, output_tokens_est,
        saved_tokens_est, savings_pct
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      Date.now(),
      input.sessionId ?? null,
      input.projectPath ?? null,
      event.toolName,
      event.commandFamily,
      event.category,
      event.level,
      event.strategy,
      event.compressed ? 1 : 0,
      event.skipReason,
      event.rawChars,
      event.compressedChars,
      event.inputTokensEst,
      event.outputTokensEst,
      event.savedTokensEst,
      event.savingsPct
    );
}

export function resetToolOutputCompressionStats(db: DatabaseInstance): void {
  db.raw.prepare('DELETE FROM tool_output_compression_events').run();
}

export function getToolOutputCompressionStats(
  db: DatabaseInstance,
  options: ToolOutputCompressionStatsOptions = {}
): ToolCompressionStats {
  cleanupOld(db);
  const now = Date.now();
  const since24h = now - DAY_MS;
  const since7d = now - 7 * DAY_MS;
  const since30d = now - 30 * DAY_MS;
  const whereClause = options.sessionId ? 'WHERE session_id = ?' : '';
  const whereParams = options.sessionId ? [options.sessionId] : [];
  const andSessionClause = options.sessionId ? 'AND session_id = ?' : '';
  const sinceParams = (since: number) => (options.sessionId ? [since, options.sessionId] : [since]);

  const aggregate = db.raw
    .prepare(
      `
      SELECT
        COUNT(*) AS total_commands,
        COALESCE(SUM(compressed), 0) AS compressed_commands,
        COALESCE(SUM(input_tokens_est), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens_est), 0) AS total_output_tokens,
        COALESCE(SUM(saved_tokens_est), 0) AS total_saved_tokens
      FROM tool_output_compression_events
      ${whereClause}
    `
    )
    .get(...whereParams) as AggregateRow;

  const savedTokens24h =
    (
      db.raw
        .prepare(
          `SELECT COALESCE(SUM(saved_tokens_est), 0) AS value FROM tool_output_compression_events WHERE timestamp >= ? ${andSessionClause}`
        )
        .get(...sinceParams(since24h)) as { value: number }
    ).value ?? 0;
  const savedTokens7d =
    (
      db.raw
        .prepare(
          `SELECT COALESCE(SUM(saved_tokens_est), 0) AS value FROM tool_output_compression_events WHERE timestamp >= ? ${andSessionClause}`
        )
        .get(...sinceParams(since7d)) as { value: number }
    ).value ?? 0;
  const savedTokens30d =
    (
      db.raw
        .prepare(
          `SELECT COALESCE(SUM(saved_tokens_est), 0) AS value FROM tool_output_compression_events WHERE timestamp >= ? ${andSessionClause}`
        )
        .get(...sinceParams(since30d)) as { value: number }
    ).value ?? 0;

  const dailyRows = db.raw
    .prepare(
      `
      SELECT date(timestamp / 1000, 'unixepoch') AS date,
        COUNT(*) AS commands,
        COALESCE(SUM(saved_tokens_est), 0) AS saved_tokens
      FROM tool_output_compression_events
      WHERE timestamp >= ? ${andSessionClause}
      GROUP BY date
    `
    )
    .all(...sinceParams(startOfLocalDay(since30d))) as DailyRow[];
  const dailyByDate = new Map(dailyRows.map((row) => [row.date, row]));
  const daily = Array.from({ length: 30 }, (_, index) => {
    const date = formatDate(startOfLocalDay(now) - (29 - index) * DAY_MS);
    const row = dailyByDate.get(date);
    return {
      date,
      savedTokens: row?.saved_tokens ?? 0,
      commands: row?.commands ?? 0,
    };
  });

  const topCategories = db.raw
    .prepare(
      `
      SELECT category AS name, COUNT(*) AS commands,
        COALESCE(SUM(saved_tokens_est), 0) AS saved_tokens,
        COALESCE(SUM(input_tokens_est), 0) AS input_tokens
      FROM tool_output_compression_events
      ${whereClause}
      GROUP BY category
      ORDER BY saved_tokens DESC, commands DESC
      LIMIT 8
    `
    )
    .all(...whereParams)
    .map((row) => toBreakdown(row as BreakdownRow));

  const topCommandFamilies = db.raw
    .prepare(
      `
      SELECT command_family AS name, COUNT(*) AS commands,
        COALESCE(SUM(saved_tokens_est), 0) AS saved_tokens,
        COALESCE(SUM(input_tokens_est), 0) AS input_tokens
      FROM tool_output_compression_events
      ${whereClause}
      GROUP BY command_family
      ORDER BY saved_tokens DESC, commands DESC
      LIMIT 8
    `
    )
    .all(...whereParams)
    .map((row) => toBreakdown(row as BreakdownRow));

  const lowSavings = db.raw
    .prepare(
      `
      SELECT strategy AS name, COUNT(*) AS commands,
        COALESCE(SUM(saved_tokens_est), 0) AS saved_tokens,
        COALESCE(SUM(input_tokens_est), 0) AS input_tokens
      FROM tool_output_compression_events
      WHERE compressed = 1 ${andSessionClause}
      GROUP BY strategy
      HAVING input_tokens > 0 AND (saved_tokens * 1.0 / input_tokens) < 0.30
      ORDER BY commands DESC
      LIMIT 6
    `
    )
    .all(...whereParams)
    .map((row) => toBreakdown(row as BreakdownRow));

  const skipReasons = db.raw
    .prepare(
      `
      SELECT COALESCE(skip_reason, 'compressed') AS reason, COUNT(*) AS count
      FROM tool_output_compression_events
      WHERE compressed = 0 ${andSessionClause}
      GROUP BY reason
      ORDER BY count DESC
      LIMIT 8
    `
    )
    .all(...whereParams) as SkipReasonRow[];

  const totalInputTokens = aggregate.total_input_tokens ?? 0;
  const totalSavedTokens = aggregate.total_saved_tokens ?? 0;

  return {
    totalCommands: aggregate.total_commands ?? 0,
    compressedCommands: aggregate.compressed_commands ?? 0,
    totalInputTokens,
    totalOutputTokens: aggregate.total_output_tokens ?? 0,
    totalSavedTokens,
    avgSavingsPct: totalInputTokens > 0 ? (totalSavedTokens / totalInputTokens) * 100 : 0,
    savedTokens24h,
    savedTokens7d,
    savedTokens30d,
    daily,
    topCategories,
    topCommandFamilies,
    lowSavings,
    skipReasons,
  };
}
