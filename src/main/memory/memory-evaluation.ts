import type { KnowledgeEntry, KnowledgeType, ProjectMemoryService } from './project-memory';

export interface MemoryEvaluationMessage {
  role: string;
  content: string | unknown[];
}

export interface MemoryEvaluationAction {
  action: 'create' | 'update' | 'ignore';
  existingId?: string;
  type?: KnowledgeType;
  title?: string;
  content?: string;
  importance?: number;
  tags?: string[];
  reason?: string;
}

export interface KnowledgeCandidate {
  type: string;
  title: string;
  content: string;
  importance?: number;
  tags?: string[];
  trigger?: 'explicit_user_request' | 'autonomous_high_value';
  reason?: string;
}

export interface AppliedMemoryActions {
  created: number;
  updated: number;
  ignored: number;
  entries: KnowledgeEntry[];
  reasons: string[];
}

const VALID_TYPES: KnowledgeType[] = ['fact', 'preference', 'decision', 'reference', 'project'];
const MAX_ACTIONS_TO_APPLY = 12;
const MAX_EXISTING_MEMORY_IN_PROMPT = 80;
const MAX_MESSAGE_CHARS = 60000;

export function extractTextFromMemoryMessage(message: MemoryEvaluationMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .map((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        (block as { type?: unknown }).type === 'text' &&
        'text' in block
      ) {
        const text = (block as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildMemoryExtractionPrompt(
  messages: MemoryEvaluationMessage[],
  existingEntries: KnowledgeEntry[]
): { systemPrompt: string; prompt: string } {
  const transcript = serializeRecentMessages(messages);
  const existing = serializeExistingKnowledge(existingEntries);

  return {
    systemPrompt: `You extract durable project memory for Open Cowork.
Return only strict JSON. No markdown. No comments.

Memory is for stable, cross-session knowledge only. It is NOT a transcript, task log, temporary status, or searchable history.
Use search_history for recoverable conversation details. Save memory only when it compresses stable facts, decisions, preferences, references, or project conventions.

Compare against existing memory before deciding:
- create: only for genuinely new durable knowledge.
- update: when new information should be merged into an existing memory entry.
- ignore: for duplicates, temporary details, ordinary task progress, tool output summaries, or anything easily recoverable from search_history.

Allowed types: fact, preference, decision, reference, project.
Importance must be 1-5. Use 4-5 only for critical, reusable knowledge.
Return at most ${MAX_ACTIONS_TO_APPLY} create/update actions.`,
    prompt: `Existing memory:
${existing}

Conversation to extract from:
${transcript}

Return this JSON shape:
{"actions":[{"action":"create|update|ignore","existingId":"optional-existing-id","type":"fact|preference|decision|reference|project","title":"short title","content":"concise durable knowledge","importance":1,"tags":["tag"],"reason":"brief reason"}]}`,
  };
}

export function parseMemoryEvaluationResponse(raw: string): MemoryEvaluationAction[] {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) {
      return [];
    }
    return parsed.actions
      .map(sanitizeAction)
      .filter((action): action is MemoryEvaluationAction => Boolean(action));
  } catch {
    return [];
  }
}

export function buildCandidateEvaluationAction(
  candidate: KnowledgeCandidate,
  existingEntries: KnowledgeEntry[],
  autoMemoryEnabled: boolean
): MemoryEvaluationAction {
  const trigger = candidate.trigger ?? 'autonomous_high_value';
  const normalized = sanitizeAction({
    action: 'create',
    type: candidate.type,
    title: candidate.title,
    content: candidate.content,
    importance: candidate.importance,
    tags: candidate.tags,
    reason: candidate.reason,
  });

  if (!normalized || !normalized.content || !normalized.title || !normalized.type) {
    return { action: 'ignore', reason: 'Candidate is missing required memory fields.' };
  }

  if (trigger !== 'explicit_user_request') {
    if (!autoMemoryEnabled) {
      return { action: 'ignore', reason: 'autoMemory is disabled and this was not an explicit user memory request.' };
    }
    if (!isHighValueAutonomousMemory(normalized)) {
      return { action: 'ignore', reason: 'Candidate does not meet the strict autonomous memory threshold.' };
    }
  }

  const similar = findSimilarExisting(normalized, existingEntries);
  if (!similar) {
    return normalized;
  }

  if (isRedundantWithExisting(normalized, similar)) {
    return { action: 'ignore', existingId: similar.id, reason: 'Candidate duplicates existing memory.' };
  }

  return {
    ...normalized,
    action: 'update',
    existingId: similar.id,
    title: normalized.title || similar.title,
    content: mergeKnowledgeContent(similar.content, normalized.content),
    tags: mergeTags(similar.tags, normalized.tags ?? []),
    importance: Math.max(similar.importance, normalized.importance ?? 3),
    reason: normalized.reason || 'Merged with similar existing memory.',
  };
}

export function applyMemoryActions(
  service: ProjectMemoryService,
  actions: MemoryEvaluationAction[],
  options: { sessionId: string | null; projectPath: string | null; source: 'manual' | 'auto'; maxChanges?: number }
): AppliedMemoryActions {
  const result: AppliedMemoryActions = { created: 0, updated: 0, ignored: 0, entries: [], reasons: [] };
  const maxChanges = options.maxChanges ?? MAX_ACTIONS_TO_APPLY;
  const existing = service.listKnowledge(options.projectPath);
  let appliedChanges = 0;

  for (const originalAction of actions) {
    if (appliedChanges >= maxChanges) {
      result.ignored++;
      result.reasons.push('Change limit reached.');
      continue;
    }

    const action = sanitizeAction(originalAction);
    if (!action || action.action === 'ignore') {
      result.ignored++;
      if (originalAction.reason) result.reasons.push(originalAction.reason);
      continue;
    }

    if (!action.title || !action.content || !action.type) {
      result.ignored++;
      result.reasons.push('Action missing required fields.');
      continue;
    }

    const similar = findSimilarExisting(action, existing);
    if (similar && action.action === 'create') {
      if (isRedundantWithExisting(action, similar)) {
        result.ignored++;
        result.reasons.push(action.reason || `Duplicate of existing memory ${similar.id}.`);
        continue;
      }
      action.action = 'update';
      action.existingId = similar.id;
      action.content = mergeKnowledgeContent(similar.content, action.content);
      action.tags = mergeTags(similar.tags, action.tags ?? []);
      action.importance = Math.max(similar.importance, action.importance ?? 3);
    }

    if (action.action === 'update') {
      const target = action.existingId ? service.getKnowledge(action.existingId) : similar;
      if (!target) {
        result.ignored++;
        result.reasons.push(action.reason || 'Update target not found.');
        continue;
      }

      service.updateKnowledge(target.id, {
        type: action.type,
        title: action.title,
        content: action.content,
        importance: action.importance,
        tags: mergeTags(target.tags, action.tags ?? []),
      });
      const updated = service.getKnowledge(target.id);
      if (updated) {
        replaceExisting(existing, updated);
        result.entries.push(updated);
      }
      result.updated++;
      appliedChanges++;
      continue;
    }

    const created = service.saveKnowledge({
      sessionId: options.sessionId,
      projectPath: options.projectPath,
      type: action.type,
      title: action.title,
      content: action.content,
      importance: action.importance ?? 3,
      source: options.source,
      tags: action.tags ?? [],
    });
    existing.push(created);
    result.entries.push(created);
    result.created++;
    appliedChanges++;
  }

  return result;
}

export function serializeExistingKnowledge(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return '(none)';
  }

  return entries
    .slice(0, MAX_EXISTING_MEMORY_IN_PROMPT)
    .map((entry) => {
      const tags = entry.tags.length ? entry.tags.join(', ') : 'none';
      return [
        `ID: ${entry.id}`,
        `Type: ${entry.type}`,
        `Importance: ${entry.importance}`,
        `Title: ${entry.title}`,
        `Tags: ${tags}`,
        `Content: ${entry.content}`,
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

export function normalizeKnowledgeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?;；:："'`()[\]{}<>]/g, '')
    .slice(0, 220);
}

function serializeRecentMessages(messages: MemoryEvaluationMessage[]): string {
  let remaining = MAX_MESSAGE_CHARS;
  const parts: string[] = [];

  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const text = extractTextFromMemoryMessage(message).trim();
    if (!text) continue;

    const prefix = message.role === 'user' ? 'User' : 'Assistant';
    const chunk = `${prefix}: ${text}`;
    const clipped = chunk.slice(Math.max(0, chunk.length - remaining));
    parts.push(clipped);
    remaining -= clipped.length;
    if (remaining <= 0) break;
  }

  return parts.reverse().join('\n\n---\n\n') || '(no text messages)';
}

function sanitizeAction(raw: unknown): MemoryEvaluationAction | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const action = record.action === 'update' || record.action === 'ignore' ? record.action : 'create';
  const type = VALID_TYPES.includes(record.type as KnowledgeType) ? (record.type as KnowledgeType) : undefined;
  const title = typeof record.title === 'string' ? cleanText(record.title).slice(0, 120) : undefined;
  const content = typeof record.content === 'string' ? cleanText(record.content).slice(0, 2000) : undefined;
  const importance = clampImportance(record.importance);
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => cleanTag(tag)).filter(Boolean).slice(0, 12)
    : [];
  const existingId = typeof record.existingId === 'string' && record.existingId.trim() ? record.existingId.trim() : undefined;
  const reason = typeof record.reason === 'string' ? cleanText(record.reason).slice(0, 240) : undefined;

  if (action !== 'ignore' && (!type || !title || !content)) {
    return { action: 'ignore', existingId, reason: reason || 'Invalid memory action.' };
  }

  return { action, existingId, type, title, content, importance, tags, reason };
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function clampImportance(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(5, Math.round(parsed)));
}

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function cleanTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
}

function findSimilarExisting(
  action: Pick<MemoryEvaluationAction, 'title' | 'content' | 'type'>,
  existingEntries: KnowledgeEntry[]
): KnowledgeEntry | undefined {
  const actionText = `${action.title ?? ''}\n${action.content ?? ''}`;
  const actionKey = normalizeKnowledgeKey(actionText);
  const actionTokens = tokenizeForSimilarity(actionText);

  let best: { entry: KnowledgeEntry; score: number } | undefined;
  for (const entry of existingEntries) {
    if (action.type && entry.type !== action.type) {
      continue;
    }

    const entryText = `${entry.title}\n${entry.content}`;
    const entryKey = normalizeKnowledgeKey(entryText);
    const contains = actionKey.includes(entryKey) || entryKey.includes(actionKey);
    const score = contains ? 1 : jaccard(actionTokens, tokenizeForSimilarity(entryText));
    if (score >= 0.58 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best?.entry;
}

function isRedundantWithExisting(
  action: Pick<MemoryEvaluationAction, 'title' | 'content'>,
  existing: KnowledgeEntry
): boolean {
  const actionKey = normalizeKnowledgeKey(`${action.title ?? ''}\n${action.content ?? ''}`);
  const existingKey = normalizeKnowledgeKey(`${existing.title}\n${existing.content}`);
  return actionKey === existingKey || existingKey.includes(actionKey);
}

function mergeKnowledgeContent(existingContent: string, newContent: string): string {
  const existingKey = normalizeKnowledgeKey(existingContent);
  const newKey = normalizeKnowledgeKey(newContent);
  if (!newKey || existingKey.includes(newKey)) {
    return existingContent;
  }
  if (newKey.includes(existingKey)) {
    return newContent;
  }
  return `${existingContent.trim()}\n\n${newContent.trim()}`.slice(0, 2400);
}

function mergeTags(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right].map(cleanTag).filter(Boolean))).slice(0, 12);
}

function replaceExisting(entries: KnowledgeEntry[], updated: KnowledgeEntry): void {
  const index = entries.findIndex((entry) => entry.id === updated.id);
  if (index >= 0) {
    entries[index] = updated;
  } else {
    entries.push(updated);
  }
}

function tokenizeForSimilarity(value: string): Set<string> {
  const lowered = value.toLowerCase();
  const ascii = lowered.split(/[^a-z0-9_./-]+/).filter((token) => token.length >= 3);
  const cjk = lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return new Set([...ascii, ...cjk]);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function isHighValueAutonomousMemory(action: MemoryEvaluationAction): boolean {
  const content = `${action.title ?? ''}\n${action.content ?? ''}`.toLowerCase();
  const importance = action.importance ?? 3;
  const highValueMarkers = [
    'decision',
    'decided',
    'architecture',
    'constraint',
    'preference',
    'must',
    'never',
    'always',
    '长期',
    '稳定',
    '关键决策',
    '架构',
    '约定',
    '偏好',
    '必须',
    '不要',
    '不能',
  ];
  const transientMarkers = [
    'today',
    'now',
    'temporary',
    'debug log',
    'tool output',
    '当前任务',
    '这次',
    '临时',
    '刚才',
    '报错',
    '日志',
  ];
  return (
    importance >= 4 &&
    highValueMarkers.some((marker) => content.includes(marker)) &&
    !transientMarkers.some((marker) => content.includes(marker))
  );
}
