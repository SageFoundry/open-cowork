/**
 * @module main/session/session-manager
 *
 * Session lifecycle manager (957 lines).
 *
 * Responsibilities:
 * - Session CRUD: create, continue, stop, delete, list
 * - Chat history persistence to SQLite via DatabaseInstance
 * - Workspace-scoped sessions with sandbox integration
 * - Delegates AI execution to ClaudeAgentRunner
 *
 * Dependencies: database, agent-runner, config-store, mcp-manager, sandbox-adapter
 */
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CompactionTrigger,
  Session,
  SessionContextConfig,
  SessionCompactionInfo,
  SessionCompactionState,
  Message,
  ServerEvent,
  PermissionResult,
  ContentBlock,
  TextContent,
  TokenBudgetSnapshot,
  TraceStep,
  FileAttachmentContent,
  SessionMessagesPage,
} from '../../renderer/types';
import type { CompactionSnapshotRow, DatabaseInstance, TraceStepRow } from '../db/database';
import { PathResolver } from '../sandbox/path-resolver';
import {
  SandboxAdapter,
  getSandboxAdapter,
  initializeSandbox,
  reinitializeSandbox,
} from '../sandbox/sandbox-adapter';
import { SandboxSync } from '../sandbox/sandbox-sync';
import {
  ClaudeAgentRunner,
  type HistoryReadRequest,
  type HistoryReadResult,
  type HistorySearchRequest,
  type HistorySearchResult,
} from '../claude/agent-runner';
import { configStore } from '../config/config-store';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import {
  log,
  logError,
  logWarn,
  logCtx,
  logCtxError,
  runWithLogContext,
  generateTraceId,
} from '../utils/logger';
import { maybeGenerateSessionTitle } from './session-title-flow';
import {
  buildTitlePrompt,
  getDefaultTitleFromPrompt,
  normalizeGeneratedTitle,
} from './session-title-utils';
import { completeWithClaudeSdk, generateTitleWithClaudeSdk } from '../claude/claude-sdk-one-shot';
import { buildScheduledTaskTitle } from '../../shared/schedule/task-title';
import {
  buildTokenBudgetSnapshot,
  estimateMessagesTokens,
  getStrategyThresholds,
} from '../context/context-budget';
import {
  appendTranscriptMessagesSince,
  buildCompactedContextPreview,
  buildCompactionInfo,
  createBoundarySummaryMessage,
  getPreservedTailCount,
  microCompactMessages,
  rebuildRuntimeMessagesFromSnapshot,
} from '../context/context-compaction';
import { ProjectMemoryService } from '../memory/project-memory';
import { resolveKnownModelSpecs } from '../claude/pi-model-resolution';
import {
  buildWorkspaceInfoPrompt,
  estimateEffectiveSystemPromptTokens,
} from '../claude/prompt-contract';
import type { SkillsManager } from '../skills/skills-manager';
import type { BackgroundTaskService } from '../background/background-task-service';

interface AgentRunner {
  run(session: Session, prompt: string, existingMessages: Message[]): Promise<void>;
  cancel(sessionId: string): void;
  clearSdkSession?(sessionId: string): void;
}

const WORKSPACE_MOUNT_VIRTUAL_PATH = '/mnt/workspace';
const TITLE_GENERATION_TIMEOUT_MS = 20000;
const HISTORY_SEARCH_MAX_RESULTS = 50;
const HISTORY_READ_MAX_CHARS = 30000;
const MODE_EVENT_ENTER_PLAN = `<mode_event type="enter_plan">
Current mode changed to Plan Mode. Research, inspect, and propose. Do not modify source files, project config, dependencies, git state, persistent memory, or external services.
</mode_event>`;
const MODE_EVENT_EXIT_PLAN = `<mode_event type="exit_plan">
Current mode changed to Normal Mode. Previous Plan Mode restrictions are no longer current. Normal tool permissions apply, subject to standard safety checks.
</mode_event>`;
const HISTORY_SEARCH_STOP_WORDS = new Set([
  'history',
  'record',
  'records',
  'conversation',
  'session',
  'chat',
  'search',
  'tool',
  'tools',
  '历史',
  '记录',
  '对话',
  '会话',
  '聊天',
  '搜索',
  '查询',
  '工具',
  '之前',
  '前面',
  '关于',
]);
const SESSION_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const COMPACTION_SUMMARY_SYSTEM_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do not call tools, do not browse files, do not ask the user questions, and do not include code fences unless a tiny snippet is essential.

Create a structured continuation summary for a coding agent that must resume the same session after context compaction.
Preserve durable information structure over verbosity. Keep exact file paths, commands, code identifiers, API names, error messages, and user preferences when they still affect the next step.

Use exactly these markdown sections, in this order:
## Primary Request and Intent
## Key Technical Concepts
## Files and Code Sections
## Errors and Fixes
## Problem Solving
## User Messages
## Pending Tasks
## Current Work
## Next Step

Section guidance:
- Primary Request and Intent: the user's actual goal, constraints, and desired product behavior.
- Key Technical Concepts: architecture, APIs, settings, data flows, context limits, and implementation rules that matter.
- Files and Code Sections: concrete files/functions/components already touched or discovered, with why they matter.
- Errors and Fixes: failures, regressions, test output, user-reported issues, and fixes already applied.
- Problem Solving: important decisions, rejected approaches, and rationale.
- User Messages: preserve the user's messages in order as concise bullet summaries; do not drop late corrections.
- Pending Tasks: unfinished work and acceptance criteria.
- Current Work: the exact work in progress when compaction happened, including files/functions and partial edits.
- Next Step: one concrete next action the assistant should take.

If evidence is missing, say "Unknown" briefly instead of inventing details.
CRITICAL: Respond with TEXT ONLY. No tool use. No follow-up question.`;

const COMPACTION_SUMMARY_SYSTEM_PROMPT_ZH = `关键要求：只返回文本。不要调用工具，不要浏览文件，不要向用户提问，除非极短代码片段确有必要，否则不要使用代码围栏。

为即将因上下文压缩而继续同一会话的编码 agent 创建结构化续接摘要。
相比冗长叙述，更要保留持久信息结构。仍会影响下一步的文件路径、命令、代码标识符、API 名称、错误信息和用户偏好必须精确保留。

必须严格按以下 markdown 标题和顺序输出：
## Primary Request and Intent
## Key Technical Concepts
## Files and Code Sections
## Errors and Fixes
## Problem Solving
## User Messages
## Pending Tasks
## Current Work
## Next Step

各部分要求：
- Primary Request and Intent：用户真实目标、约束和期望产品行为。
- Key Technical Concepts：重要的架构、API、设置、数据流、上下文限制和实现规则。
- Files and Code Sections：已经修改或发现的具体文件/函数/组件，以及它们为什么重要。
- Errors and Fixes：失败、回归、测试输出、用户反馈的问题和已经应用的修复。
- Problem Solving：重要决策、放弃的方案和理由。
- User Messages：按顺序保留用户消息的简洁要点，不要丢掉后续修正。
- Pending Tasks：未完成工作和验收标准。
- Current Work：压缩发生时正在进行的确切工作，包括文件/函数和未完成编辑。
- Next Step：一个具体的下一步动作。

如果缺少证据，简短写 "Unknown"，不要编造。
关键要求：只返回文本。不要使用工具。不要追问。`;

function buildCompactionSummarySystemPrompt(language: 'zh' | 'en'): string {
  return language === 'zh' ? COMPACTION_SUMMARY_SYSTEM_PROMPT_ZH : COMPACTION_SUMMARY_SYSTEM_PROMPT;
}

function buildCompactionSummaryPrompt(input: {
  language: 'zh' | 'en';
  isAutomaticCompaction: boolean;
  serializedHistory: string;
}): string {
  if (input.language === 'zh') {
    return [
      '请总结较早的对话，使助手能在有限上下文中继续工作。',
      '摘要必须使用中文。代码标识符、命令、文件路径、API 名称和引用的错误信息需要时保持原样。',
      '使用系统提示中要求的固定章节。即使某个章节信息很少，也保持结构稳定。',
      input.isAutomaticCompaction
        ? '这是自动上下文压缩。不要提出后续问题；如有不确定性，请写出最佳假设，并在 Next Step 中给出验证步骤。'
        : '这是手动上下文压缩。只有真正阻塞后续工作的问题，才记录为待办。',
      '较早历史：',
      input.serializedHistory.slice(0, 24000),
    ].join('\n\n');
  }

  return [
    'Summarize the earlier conversation so the assistant can continue with limited context.',
    'Write the summary in English. Preserve code identifiers, commands, file paths, API names, and quoted errors exactly when needed.',
    'Use the exact required sections from the system prompt. Keep the structure stable even when a section has little data.',
    input.isAutomaticCompaction
      ? 'This is automatic compaction. Suppress follow-up questions: if uncertainty exists, write the best assumption and a verification step in Next Step.'
      : 'This is manual compaction. Record open questions as pending tasks only when they are genuinely blocking.',
    'Earlier history:',
    input.serializedHistory.slice(0, 24000),
  ].join('\n\n');
}

function normalizeHistorySearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeHistoryQuery(query: string): string[] {
  const normalized = normalizeHistorySearchText(query);
  if (!normalized) return [];
  const terms = Array.from(new Set(normalized.split(/\s+/).filter(Boolean)));
  const contentTerms = terms.filter((term) => !HISTORY_SEARCH_STOP_WORDS.has(term));
  return contentTerms.length > 0 ? contentTerms : terms;
}

function normalizeHistoryLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(1, Math.min(HISTORY_SEARCH_MAX_RESULTS, Math.floor(value as number)));
}

function normalizeHistoryWindowCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(0, Math.min(20, Math.floor(value as number)));
}

function normalizeHistoryMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 12000;
  return Math.max(1000, Math.min(HISTORY_READ_MAX_CHARS, Math.floor(value as number)));
}

function isHistorySearchToolName(name: string | undefined): boolean {
  return name === 'search_history' || name === 'read_history';
}

function isHistorySearchMetaText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsHistorySearch =
    normalized.includes('search_history') ||
    normalized.includes('read_history') ||
    normalized.includes('历史搜索') ||
    normalized.includes('搜索历史') ||
    normalized.includes('历史会话') ||
    normalized.includes('历史记录') ||
    normalized.includes('搜索工具');
  if (!mentionsHistorySearch) return false;
  return (
    normalized.includes('tool') ||
    normalized.includes('tools') ||
    normalized.includes('工具') ||
    normalized.includes('测试') ||
    normalized.includes('优化') ||
    normalized.includes('再搜') ||
    normalized.includes('搜一次') ||
    normalized.includes('能不能搜到') ||
    normalized.includes('找不到') ||
    normalized.includes('没有找到')
  );
}

function isHistorySearchToolResultText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('no history messages found matching') ||
    normalized.includes('no messages found matching') ||
    normalized.includes('matching messages in the current session history') ||
    normalized.includes('matching history messages') ||
    normalized.includes('history window from session') ||
    normalized.includes('搜索到了当前会话的历史记录') ||
    (normalized.includes('没有找到') &&
      (normalized.includes('历史记录') || normalized.includes('history')))
  );
}

function flattenMessageForHistorySearch(
  message: Message,
  options: { includeToolResults: boolean; includeSearchToolResults: boolean }
): string {
  const textBlocks: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      if (
        !options.includeSearchToolResults &&
        (isHistorySearchToolResultText((block as { text: string }).text) ||
          isHistorySearchMetaText((block as { text: string }).text))
      ) {
        continue;
      }
      textBlocks.push((block as { text: string }).text);
    } else if (block.type === 'thinking') {
      continue;
    } else if (block.type === 'tool_use') {
      const toolUse = block as { name?: string; input?: Record<string, unknown> };
      if (!options.includeSearchToolResults && isHistorySearchToolName(toolUse.name)) {
        continue;
      }
      textBlocks.push(
        `[tool_use: ${toolUse.name ?? 'tool'}] ${JSON.stringify(toolUse.input ?? {})}`
      );
    } else if (block.type === 'tool_result') {
      if (!options.includeToolResults) continue;
      const resultText = String((block as { content?: unknown }).content ?? '');
      if (!options.includeSearchToolResults && isHistorySearchToolResultText(resultText)) {
        continue;
      }
      textBlocks.push(resultText.slice(0, 4000));
    }
  }
  return textBlocks.join('\n');
}

function flattenMessageForHistoryRead(message: Message): string {
  const textBlocks: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      textBlocks.push((block as { text: string }).text);
    } else if (block.type === 'thinking') {
      continue;
    } else if (block.type === 'tool_use') {
      const toolUse = block as { name?: string; input?: Record<string, unknown> };
      textBlocks.push(
        `[tool_use: ${toolUse.name ?? 'tool'}]\n${JSON.stringify(toolUse.input ?? {}, null, 2)}`
      );
    } else if (block.type === 'tool_result') {
      textBlocks.push(`[tool_result]\n${String((block as { content?: unknown }).content ?? '')}`);
    }
  }
  return textBlocks.join('\n\n');
}

function scoreHistoryMatch(
  normalizedText: string,
  normalizedQuery: string,
  terms: string[],
  mode: 'smart' | 'exact' | 'all' | 'any'
): number {
  const phraseMatch = normalizedText.includes(normalizedQuery);
  if (mode === 'exact') return phraseMatch ? 1000 + normalizedQuery.length : 0;

  const hitCount = terms.filter((term) => normalizedText.includes(term)).length;
  if (mode === 'all') {
    if (hitCount === terms.length) return 500 + hitCount * 20;
    return hitCount > 0 ? hitCount * 20 : 0;
  }
  if (mode === 'any') return hitCount > 0 ? hitCount * 20 : 0;

  if (phraseMatch) return 1000 + normalizedQuery.length;
  if (hitCount === terms.length && terms.length > 1) return 500 + hitCount * 30;
  if (hitCount > 0) return hitCount * 20;
  return 0;
}

function buildHistorySnippet(
  originalText: string,
  normalizedText: string,
  normalizedQuery: string,
  terms: string[]
): string {
  const lowerOriginal = originalText.toLowerCase();
  const firstTerm = normalizedText.includes(normalizedQuery)
    ? normalizedQuery
    : terms.find((term) => normalizedText.includes(term)) || terms[0] || '';
  let index = firstTerm ? lowerOriginal.indexOf(firstTerm) : -1;
  if (index < 0) index = Math.max(0, normalizedText.indexOf(firstTerm));
  const start = Math.max(0, index - 120);
  const end = Math.min(originalText.length, index + firstTerm.length + 360);
  let snippet = originalText.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < originalText.length) snippet = `${snippet}...`;
  return snippet;
}

interface CompactionSummaryResult {
  text: string;
  usedFallback: boolean;
}

function resolveRuntimeContextWindow(runtimeConfig: {
  model?: string;
  contextWindow?: number;
}): number {
  if (runtimeConfig.contextWindow && runtimeConfig.contextWindow > 0) {
    return runtimeConfig.contextWindow;
  }
  const knownSpecs = runtimeConfig.model ? resolveKnownModelSpecs(runtimeConfig.model) : undefined;
  return knownSpecs?.contextWindow || 180000;
}

function normalizeSessionThinkingLevel(value: unknown): Session['thinkingLevel'] | undefined {
  return typeof value === 'string' && SESSION_THINKING_LEVELS.has(value)
    ? (value as Session['thinkingLevel'])
    : undefined;
}

export class SessionManager {
  private db: DatabaseInstance;
  private sendToRenderer: (event: ServerEvent) => void;
  private pathResolver: PathResolver;
  private sandboxAdapter: SandboxAdapter;
  private agentRunner!: AgentRunner;
  private mcpManager: MCPManager;
  private pluginRuntimeService?: PluginRuntimeService;
  private skillsManager?: SkillsManager;
  private backgroundTaskService?: BackgroundTaskService;
  private activeSessions: Map<string, AbortController> = new Map();
  private promptQueues: Map<
    string,
    Array<{ prompt: string; content?: ContentBlock[]; contextConfig?: SessionContextConfig }>
  > = new Map();
  private pendingPermissions: Map<string, (result: PermissionResult) => void> = new Map();
  private pendingSudoPasswords: Map<
    string,
    { sessionId: string; resolve: (password: string | null) => void }
  > = new Map();
  private sandboxInitPromises: Map<string, Promise<void>> = new Map();
  private sessionTitleAttempts: Set<string> = new Set();
  private titleGenerationTokens: Map<string, symbol> = new Map();
  private messageCache: Map<string, Message[]> = new Map();
  private projectMemoryService = new ProjectMemoryService();
  private restoreNoticeSent: Set<string> = new Set();
  private compactionFailureCounts: Map<string, number> = new Map();
  private compactingSessions: Set<string> = new Set();
  private static readonly MAX_CACHE_SIZE = 100;
  private static readonly MAX_AUTOMATIC_COMPACTION_FAILURES = 3;

  constructor(
    db: DatabaseInstance,
    sendToRenderer: (event: ServerEvent) => void,
    pluginRuntimeService?: PluginRuntimeService,
    skillsManager?: SkillsManager,
    backgroundTaskService?: BackgroundTaskService
  ) {
    this.db = db;
    this.sendToRenderer = (event) => {
      if (event.type === 'trace.step') {
        this.saveTraceStep(event.payload.sessionId, event.payload.step);
      }
      if (event.type === 'trace.update') {
        this.updateTraceStep(event.payload.stepId, event.payload.updates);
      }
      sendToRenderer(event);
    };
    this.pathResolver = new PathResolver();
    this.sandboxAdapter = getSandboxAdapter();
    this.pluginRuntimeService = pluginRuntimeService;
    this.skillsManager = skillsManager;
    this.backgroundTaskService = backgroundTaskService;

    // Initialize MCP Manager
    this.mcpManager = new MCPManager();
    this.initializeMCP();

    // Create agent runner based on current config
    this.createAgentRunner();

    log('[SessionManager] Initialized with persistent database and MCP support');
  }

  /**
   * Create agent runner based on current config
   * Can be called to recreate runner when config changes
   */
  private createAgentRunner(): void {
    this.agentRunner = this.createClaudeAgentRunner();
    log('[SessionManager] Using pi-coding-agent runner');
  }

  private createClaudeAgentRunner(): ClaudeAgentRunner {
    return new ClaudeAgentRunner(
      {
        sendToRenderer: this.sendToRenderer,
        saveMessage: (message: Message) => this.saveMessage(message),
        requestSudoPassword: (sessionId: string, toolUseId: string, command: string) =>
          this.requestSudoPassword(sessionId, toolUseId, command),
        searchHistory: (request: HistorySearchRequest) => this.searchHistory(request),
        readHistory: (request: HistoryReadRequest) => this.readHistory(request),
        getSessionPlanMode: (sessionId: string) =>
          ((this.db.sessions.get(sessionId) as { plan_mode?: number } | null)?.plan_mode ?? 0) === 1,
      },
      this.pathResolver,
      this.mcpManager,
      this.pluginRuntimeService,
      this.skillsManager,
      this.backgroundTaskService
    );
  }

  /**
   * Notify that API config changed.
   * Model/apiKey/baseUrl changes are picked up per-query via configStore.getAll()
   * and hot-swapped via piSession.setModel(). No need to recreate the runner.
   */
  reloadConfig(): void {
    log('[SessionManager] API config changed — will apply on next query');
  }

  /**
   * Reinitialize MCP servers (call only when MCP config actually changes)
   */
  async reloadMCP(): Promise<void> {
    log('[SessionManager] Reloading MCP servers');
    await this.initializeMCP();
  }

  /**
   * Invalidate cached MCP servers config so the next query rebuilds tools.
   * Call after MCP server add/update/delete.
   */
  invalidateMcpServersCache(): void {
    if (this.agentRunner && 'invalidateMcpServersCache' in this.agentRunner) {
      (this.agentRunner as ClaudeAgentRunner).invalidateMcpServersCache();
    }
  }

  /**
   * Invalidate skills setup so the next query re-links skills.
   * Call after skill install/uninstall/toggle.
   */
  invalidateSkillsSetup(): void {
    if (this.agentRunner && 'invalidateSkillsSetup' in this.agentRunner) {
      (this.agentRunner as ClaudeAgentRunner).invalidateSkillsSetup();
    }
  }

  /**
   * Reinitialize sandbox adapter (call only when sandbox config changes)
   */
  async reloadSandbox(): Promise<void> {
    await this.reinitializeSandboxAsync();
  }

  /**
   * Reinitialize sandbox adapter asynchronously
   */
  private async reinitializeSandboxAsync(): Promise<void> {
    try {
      log('[SessionManager] Reinitializing sandbox adapter...');
      await reinitializeSandbox();
      this.sandboxAdapter = getSandboxAdapter();
      log('[SessionManager] Sandbox adapter reinitialized, mode:', this.sandboxAdapter.mode);
    } catch (error) {
      logError('[SessionManager] Failed to reinitialize sandbox:', error);
    }
  }

  /**
   * Initialize MCP servers from configuration
   */
  private async initializeMCP(): Promise<void> {
    try {
      const servers = mcpConfigStore.getEnabledServers();
      await this.mcpManager.initializeServers(servers);
      log(`[SessionManager] Initialized ${servers.length} MCP servers`);
    } catch (error) {
      logError('[SessionManager] Failed to initialize MCP servers:', error);
      this.sendToRenderer({
        type: 'error',
        payload: {
          message: `Failed to initialize MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  /**
   * Get MCP manager instance
   */
  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  /**
   * Get sandbox adapter instance
   */
  getSandboxAdapter(): SandboxAdapter {
    return this.sandboxAdapter;
  }

  // Create and start a new session
  async startSession(
    title: string,
    prompt: string,
    cwd?: string,
    allowedTools?: string[],
    content?: ContentBlock[],
    contextConfig?: SessionContextConfig,
    planMode?: boolean
  ): Promise<Session> {
    log('[SessionManager] Starting new session:', title);

    const session = this.createSession(title, cwd, allowedTools, planMode);

    // Save to database
    this.saveSession(session);

    // Start processing the prompt with content blocks
    this.enqueuePrompt(session, prompt, content, contextConfig);

    return session;
  }

  // Create a new session object
  private buildMountedPaths(cwd?: string): Session['mountedPaths'] {
    if (!cwd) {
      return [];
    }
    const mountedPaths: Session['mountedPaths'] = [
      { virtual: WORKSPACE_MOUNT_VIRTUAL_PATH, real: cwd },
    ];
    return mountedPaths;
  }

  private createSession(title: string, cwd?: string, allowedTools?: string[], planMode?: boolean): Session {
    const now = Date.now();
    // Prefer frontend-provided cwd; fallback to env vars if provided
    const envCwd = process.env.COWORK_WORKDIR || process.env.WORKDIR || process.env.DEFAULT_CWD;
    const effectiveCwd = cwd || envCwd;
    const runtimeConfig = configStore.getAll();
    return {
      id: uuidv4(),
      title,
      status: 'idle',
      cwd: effectiveCwd,
      mountedPaths: this.buildMountedPaths(effectiveCwd),
      allowedTools: allowedTools || [
        'askuserquestion',
        'todowrite',
        'todoread',
        'websearch',
        'read',
        'write',
        'edit',
        'list_directory',
        'glob',
        'grep',
      ],
      memoryEnabled: false,
      model: runtimeConfig.model || undefined,
      configSetId: runtimeConfig.activeConfigSetId || undefined,
      thinkingLevel: runtimeConfig.thinkingLevel || undefined,
      planMode: planMode ?? false,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Save session to database
  private saveSession(session: Session) {
    this.db.sessions.create({
      id: session.id,
      title: session.title,
      claude_session_id: session.claudeSessionId || null,
      openai_thread_id: session.openaiThreadId || null,
      status: session.status,
      cwd: session.cwd || null,
      mounted_paths: JSON.stringify(session.mountedPaths),
      allowed_tools: JSON.stringify(session.allowedTools),
      memory_enabled: session.memoryEnabled ? 1 : 0,
      model: session.model || null,
      config_set_id: session.configSetId || null,
      thinking_level: session.thinkingLevel || null,
      plan_mode: session.planMode ? 1 : 0,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    });
  }

  // Load session from database
  private loadSession(sessionId: string): Session | null {
    const row = this.db.sessions.get(sessionId);
    if (!row) return null;

    let mountedPaths;
    try {
      mountedPaths = JSON.parse(row.mounted_paths);
    } catch (e) {
      logError('[SessionManager] Failed to parse mounted_paths:', e);
      mountedPaths = [];
    }

    let allowedTools;
    try {
      allowedTools = JSON.parse(row.allowed_tools);
    } catch (e) {
      logError('[SessionManager] Failed to parse allowed_tools:', e);
      allowedTools = [];
    }

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id || undefined,
      openaiThreadId: row.openai_thread_id || undefined,
      status: row.status as Session['status'],
      cwd: row.cwd || undefined,
      mountedPaths,
      allowedTools,
      memoryEnabled: row.memory_enabled === 1,
      model: row.model || undefined,
      configSetId: row.config_set_id || undefined,
      thinkingLevel: normalizeSessionThinkingLevel(row.thinking_level),
      planMode: row.plan_mode === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // List all sessions
  listSessions(): Session[] {
    const rows = this.db.sessions.getAll();

    return rows.map((row) => {
      let mountedPaths;
      try {
        mountedPaths = JSON.parse(row.mounted_paths);
      } catch (e) {
        logError('[SessionManager] Failed to parse mounted_paths:', e);
        mountedPaths = [];
      }

      let allowedTools;
      try {
        allowedTools = JSON.parse(row.allowed_tools);
      } catch (e) {
        logError('[SessionManager] Failed to parse allowed_tools:', e);
        allowedTools = [];
      }

      return {
        id: row.id,
        title: row.title,
        claudeSessionId: row.claude_session_id || undefined,
        openaiThreadId: row.openai_thread_id || undefined,
        status: row.status as Session['status'],
        cwd: row.cwd || undefined,
        mountedPaths,
        allowedTools,
        memoryEnabled: row.memory_enabled === 1,
        model: row.model || undefined,
        configSetId: row.config_set_id || undefined,
        thinkingLevel: normalizeSessionThinkingLevel(row.thinking_level),
        planMode: row.plan_mode === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  // Continue an existing session
  async continueSession(
    sessionId: string,
    prompt: string,
    content?: ContentBlock[],
    contextConfig?: SessionContextConfig
  ): Promise<void> {
    log('[SessionManager] Continuing session:', sessionId);

    const session = this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.enqueuePrompt(session, prompt, content, contextConfig);
  }

  async compactSession(sessionId: string, contextConfig?: SessionContextConfig): Promise<void> {
    const session = this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (this.activeSessions.has(sessionId)) {
      throw new Error(
        'Session is currently running. Please compact after the current turn finishes.'
      );
    }

    const runtime = this.getRuntimeMessages(sessionId);
    this.maybeNotifyRestoredFromBoundary(sessionId, runtime.snapshot);
    if (runtime.messages.length <= 1) {
      this.emitCompactionNotice(sessionId, 'info', '当前会话内容过短，暂时不需要压缩。');
      return;
    }

    const resolvedConfig = this.resolveContextConfig(contextConfig);
    const runtimeConfig = this.getSessionRuntimeConfig(session);
    const contextWindow = resolveRuntimeContextWindow(runtimeConfig);
    const systemPromptTokens = this.estimateSystemPromptTokens(session, '');
    const beforeBudget = buildTokenBudgetSnapshot({
      messages: runtime.messages,
      contextWindow,
      maxContextTokens: resolvedConfig.maxContextTokens,
      strategy: resolvedConfig.memoryStrategy,
      systemPromptTokens,
    });
    this.emitTokenBudget(sessionId, beforeBudget);

    const result = await this.performFullCompaction(session, runtime.messages, 'manual');
    const afterBudget = buildTokenBudgetSnapshot({
      messages: result.runtimeMessages,
      contextWindow,
      maxContextTokens: resolvedConfig.maxContextTokens,
      strategy: resolvedConfig.memoryStrategy,
      systemPromptTokens,
    });
    this.emitTokenBudget(sessionId, afterBudget);
  }

  async generateSessionTitleFromPrompt(prompt: string): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'New Session';
    }

    const generated = await this.withTimeout(
      this.generateTitleWithConfig(buildTitlePrompt(normalizedPrompt)),
      TITLE_GENERATION_TIMEOUT_MS,
      'session-title-preview'
    );
    const normalizedGenerated = normalizeGeneratedTitle(generated);
    return normalizedGenerated ?? getDefaultTitleFromPrompt(normalizedPrompt);
  }

  async generateScheduledTaskTitle(prompt: string): Promise<string> {
    const sessionTitle = await this.generateSessionTitleFromPrompt(prompt);
    return buildScheduledTaskTitle(sessionTitle);
  }

  /**
   * Ensure sandbox is initialized for the session's workspace
   */
  private async ensureSandboxInitialized(session: Session): Promise<void> {
    if (!session.cwd) {
      log('[SessionManager] No workspace directory, skipping sandbox init');
      return;
    }

    // Check if already initialized with this exact workspace
    if (this.sandboxAdapter.initialized && this.sandboxAdapter.workspacePath === session.cwd) {
      return;
    }

    // Check if initialization is already in progress
    const existingPromise = this.sandboxInitPromises.get(session.cwd);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    // Initialize sandbox with workspace
    const initPromise = initializeSandbox({
      workspacePath: session.cwd,
      mainWindow: null, // Will show dialogs globally
    }).then(() => {
      /* void */
    });

    this.sandboxInitPromises.set(session.cwd, initPromise);

    try {
      await initPromise;
      log('[SessionManager] Sandbox initialized for workspace:', session.cwd);
      log('[SessionManager] Sandbox mode:', this.sandboxAdapter.mode);
    } catch (error) {
      logError('[SessionManager] Failed to initialize sandbox:', error);
      this.sendToRenderer({
        type: 'error',
        payload: {
          message: `Failed to initialize sandbox: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      // Continue anyway - sandbox adapter will fallback to native
    } finally {
      this.sandboxInitPromises.delete(session.cwd);
    }
  }

  // Helper: Copy files to session's .tmp directory and sync to sandbox if needed
  private async processFileAttachments(
    session: Session,
    content: ContentBlock[]
  ): Promise<ContentBlock[]> {
    const processedContent: ContentBlock[] = [];

    for (const block of content) {
      if (block.type === 'file_attachment') {
        const fileBlock = block as FileAttachmentContent;

        try {
          // Create .tmp directory if it doesn't exist
          const tmpDir = path.join(session.cwd || process.cwd(), '.tmp');
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
            log('[SessionManager] Created .tmp directory:', tmpDir);
          }

          // Get source file path from the file attachment
          const sourcePath = (fileBlock.relativePath || '').trim(); // This is the full path from Electron
          // IMPORTANT: Use path.basename() to extract only the filename, not the full path
          const fallbackFilename = fileBlock.filename || sourcePath || `attachment-${Date.now()}`;
          const destFilename = path.basename(fallbackFilename);
          if (!destFilename) continue;
          const destPath = path.join(tmpDir, destFilename);
          let actualSize = 0;

          // Copy file to .tmp directory
          if (sourcePath && fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);

            // Get actual file size
            const stats = fs.statSync(destPath);
            actualSize = stats.size;

            log(
              '[SessionManager] Copied file:',
              sourcePath,
              '->',
              destPath,
              `(${actualSize} bytes)`
            );
          } else if (fileBlock.inlineDataBase64) {
            const buffer = Buffer.from(fileBlock.inlineDataBase64, 'base64');
            fs.writeFileSync(destPath, buffer);
            actualSize = buffer.length;
            log('[SessionManager] Wrote file from inline data:', destPath, `(${actualSize} bytes)`);
          } else {
            logError(
              '[SessionManager] Source file not found and inline data missing:',
              sourcePath || '(empty path)'
            );
            // Skip this file attachment
            continue;
          }

          // If sandbox is already initialized, sync the file to sandbox as well
          // This handles the case where user attaches files in subsequent messages
          const sandboxPath = SandboxSync.getSandboxPath(session.id);
          if (sandboxPath) {
            const sandboxRelativePath = `.tmp/${destFilename}`;
            log('[SessionManager] Syncing attached file to sandbox:', sandboxRelativePath);
            const syncResult = await SandboxSync.syncFileToSandbox(
              session.id,
              destPath,
              sandboxRelativePath
            );
            if (syncResult.success) {
              log('[SessionManager] File synced to sandbox:', syncResult.sandboxPath);
            } else {
              logError('[SessionManager] Failed to sync file to sandbox:', syncResult.error);
              // Continue anyway - file is in Windows .tmp, agent might still work via /mnt/
            }
          } else {
            // Check for Lima sandbox
            const { LimaSync } = await import('../sandbox/lima-sync');
            const limaSandboxPath = LimaSync.getSandboxPath(session.id);
            if (limaSandboxPath) {
              const sandboxRelativePath = `.tmp/${destFilename}`;
              log('[SessionManager] Syncing attached file to Lima sandbox:', sandboxRelativePath);
              const syncResult = await LimaSync.syncFileToSandbox(
                session.id,
                destPath,
                sandboxRelativePath
              );
              if (syncResult.success) {
                log('[SessionManager] File synced to Lima sandbox:', syncResult.sandboxPath);
              } else {
                logError('[SessionManager] Failed to sync file to Lima sandbox:', syncResult.error);
                // Continue anyway - file is in macOS .tmp, agent might still work via direct access
              }
            }
          }

          // Update the content block with the new relative path and actual size
          const relativePathFromCwd = path.join('.tmp', destFilename);
          const restFileBlock = { ...fileBlock };
          delete restFileBlock.inlineDataBase64;
          processedContent.push({
            ...restFileBlock,
            relativePath: relativePathFromCwd,
            size: actualSize,
          });
        } catch (error) {
          logError('[SessionManager] Error copying file:', error);
          this.sendToRenderer({
            type: 'error',
            payload: {
              message: `Failed to process file attachment: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
          // Skip this file attachment
        }
      } else {
        // Keep other content blocks as-is
        processedContent.push(block);
      }
    }

    return processedContent;
  }

  private resolveContextConfig(override?: SessionContextConfig): SessionContextConfig {
    const config = configStore.getAll();
    return {
      memoryStrategy: override?.memoryStrategy ?? config.memoryStrategy ?? 'auto',
      maxContextTokens: override?.maxContextTokens ?? config.maxContextTokens ?? 180000,
    };
  }

  private getSessionRuntimeConfig(session: Session): ReturnType<typeof configStore.getAll> {
    return configStore.getForConfigSet(session.configSetId, {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
    });
  }

  private estimateSystemPromptTokens(session: Session, userPrompt: string): number {
    const allConfig = configStore.getAll();
    const promptMaterial = session.cwd
      ? this.projectMemoryService.buildPromptMaterial(session.cwd, userPrompt)
      : null;
    return estimateEffectiveSystemPromptTokens({
      visibleLanguage: allConfig.language === 'zh' ? 'Chinese (中文)' : 'English',
      workspaceInfoPrompt: buildWorkspaceInfoPrompt({
        isSandboxed: false,
        workingDir: session.cwd,
        visibleLanguage: allConfig.language === 'zh' ? 'Chinese (中文)' : 'English',
      }),
      autoMemoryEnabled: Boolean(allConfig.autoMemory),
      projectMemorySections: promptMaterial?.promptSections,
    });
  }

  private emitTokenBudget(sessionId: string, snapshot: TokenBudgetSnapshot): void {
    this.sendToRenderer({
      type: 'session.tokenBudget',
      payload: { sessionId, snapshot },
    });
  }

  private emitCompaction(sessionId: string, info: SessionCompactionInfo): void {
    this.sendToRenderer({
      type: 'session.compaction',
      payload: { sessionId, info },
    });
  }

  private buildCompactionInfoFromSnapshot(snapshot: CompactionSnapshotRow): SessionCompactionInfo {
    let preservedTailCount = snapshot.preserved_tail_count ?? 0;
    let compactedContextPreview = snapshot.compacted_context_preview ?? undefined;

    if (!preservedTailCount || !compactedContextPreview) {
      try {
        const preservedTail = JSON.parse(snapshot.preserved_tail) as unknown;
        if (Array.isArray(preservedTail)) {
          preservedTailCount = preservedTailCount || preservedTail.length;
          compactedContextPreview =
            compactedContextPreview || buildCompactedContextPreview(preservedTail as Message[]);
        }
      } catch {
        // Older rows can still hydrate the numeric stats below.
      }
    }

    return {
      sessionId: snapshot.session_id,
      compactionType: snapshot.compact_type === 'micro' ? 'micro' : 'full',
      trigger: 'auto',
      status: 'created',
      boundaryCreated: true,
      estimatedTokensBefore: snapshot.estimated_tokens_before,
      estimatedTokensAfter: snapshot.estimated_tokens_after,
      preservedTailCount,
      compactedMessageCount:
        snapshot.compacted_message_count ??
        Math.max(0, snapshot.estimated_tokens_before > snapshot.estimated_tokens_after ? 1 : 0),
      createdAt: snapshot.created_at,
      summaryText: snapshot.summary_text,
      summaryPreview: snapshot.summary_preview ?? snapshot.summary_text.slice(0, 200),
      compactedContextPreview,
    };
  }

  getCompactionHistory(sessionId: string, limit = 20): SessionCompactionInfo[] {
    return this.db.compactionSnapshots
      .getBySessionId(sessionId, Math.max(1, Math.min(50, Math.floor(limit))))
      .map((snapshot) => this.buildCompactionInfoFromSnapshot(snapshot));
  }

  getTokenBudgetSnapshot(sessionId: string, modelOverride?: string): TokenBudgetSnapshot | null {
    const session = this.loadSession(sessionId);
    if (!session) {
      return null;
    }

    const runtime = this.getRuntimeMessages(sessionId);
    this.maybeNotifyRestoredFromBoundary(sessionId, runtime.snapshot);
    const contextConfig = this.resolveContextConfig();
    const runtimeConfig = this.getSessionRuntimeConfig(session);
    const modelForBudget = modelOverride || session.model || runtimeConfig.model;
    const modelSpecs = modelForBudget ? resolveKnownModelSpecs(modelForBudget) : undefined;
    const contextWindow =
      modelSpecs?.contextWindow ||
      resolveRuntimeContextWindow({
        ...runtimeConfig,
        model: modelForBudget,
      });
    const systemPromptTokens = this.estimateSystemPromptTokens(session, '');
    return buildTokenBudgetSnapshot({
      messages: runtime.messages,
      contextWindow,
      maxContextTokens: contextConfig.maxContextTokens,
      strategy: contextConfig.memoryStrategy,
      systemPromptTokens,
    });
  }

  private emitCompactionState(sessionId: string, state: SessionCompactionState | null): void {
    this.sendToRenderer({
      type: 'session.compactionState',
      payload: { sessionId, state },
    });
  }

  private emitCompactionNotice(
    sessionId: string,
    level: 'info' | 'warning' | 'error',
    message: string
  ): void {
    this.sendToRenderer({
      type: 'session.compactionNotice',
      payload: { sessionId, level, message },
    });
  }

  private emitCompactionTrace(
    sessionId: string,
    title: string,
    content: string,
    status: TraceStep['status'] = 'completed'
  ): void {
    this.sendToRenderer({
      type: 'trace.step',
      payload: {
        sessionId,
        step: {
          id: uuidv4(),
          type: 'text',
          status,
          title,
          content,
          timestamp: Date.now(),
        },
      },
    });
  }

  private getRuntimeMessages(sessionId: string): {
    messages: Message[];
    snapshot: CompactionSnapshotRow | null;
  } {
    const fullMessages = this.getMessages(sessionId);
    const snapshot = this.db.compactionSnapshots.getLatestBySessionId(sessionId);
    if (!snapshot) {
      return { messages: fullMessages, snapshot: null };
    }

    return {
      messages: rebuildRuntimeMessagesFromSnapshot(sessionId, snapshot, fullMessages),
      snapshot,
    };
  }

  private maybeNotifyRestoredFromBoundary(
    sessionId: string,
    snapshot: CompactionSnapshotRow | null
  ): void {
    if (!snapshot || this.restoreNoticeSent.has(sessionId)) {
      return;
    }
    this.restoreNoticeSent.add(sessionId);
    this.emitCompactionNotice(sessionId, 'info', '已从压缩快照恢复运行时上下文');
    this.emitCompactionTrace(
      sessionId,
      'Application context restored',
      `Restored runtime context from ${new Date(snapshot.created_at).toISOString()} boundary.`
    );
  }

  private serializeMessageForCompaction(message: Message): string {
    const blocks = message.content
      .map((block) => {
        if (block.type === 'text') {
          return block.text;
        }
        if (block.type === 'thinking') {
          return `[thinking] ${block.thinking}`;
        }
        if (block.type === 'tool_use') {
          return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
        }
        if (block.type === 'tool_result') {
          return `[tool_result ${block.toolUseId}] ${block.content}`;
        }
        if (block.type === 'file_attachment') {
          return `[file_attachment] ${block.filename} (${block.relativePath})`;
        }
        if (block.type === 'image') {
          return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return `${message.role.toUpperCase()}:\n${blocks}`.trim();
  }

  private buildFallbackCompactionSummary(messages: Message[]): string {
    const userTexts = messages
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => (block as TextContent).text.trim())
      .filter(Boolean);
    const lastUserText = userTexts[userTexts.length - 1];
    const touchedFiles = messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'file_attachment')
      .map((block) => `- ${(block as FileAttachmentContent).relativePath}`)
      .slice(0, 6);
    const recentUserMessages = userTexts.slice(-8).map((text, index) => `- ${index + 1}. ${text.slice(0, 300)}`);
    return [
      '## Primary Request and Intent',
      lastUserText ? lastUserText.slice(0, 500) : 'Continue the existing session.',
      '',
      '## Key Technical Concepts',
      '- Unknown from fallback summary.',
      '',
      '## Files and Code Sections',
      touchedFiles.length > 0 ? touchedFiles.join('\n') : '- Unknown from fallback summary.',
      '',
      '## Errors and Fixes',
      '- Unknown from fallback summary.',
      '',
      '## Problem Solving',
      '- Preserve recent decisions and continue from the latest visible tail.',
      '',
      '## User Messages',
      recentUserMessages.length > 0 ? recentUserMessages.join('\n') : '- Unknown from fallback summary.',
      '',
      '## Pending Tasks',
      '- Continue the current task using the preserved tail messages.',
      '',
      '## Current Work',
      '- Fallback summary was used because structured compaction summary generation failed or returned empty text.',
      '',
      '## Next Step',
      '- Inspect the latest preserved messages and continue the concrete implementation or debugging step.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async generateCompactionSummary(
    session: Session,
    messages: Message[],
    options: { trigger: CompactionTrigger }
  ): Promise<CompactionSummaryResult> {
    const language = (configStore.get('language') ?? 'zh') === 'zh' ? 'zh' : 'en';
    const isAutomaticCompaction = options.trigger !== 'manual';
    const serializedHistory = messages
      .map((message) => this.serializeMessageForCompaction(message))
      .filter(Boolean)
      .join('\n\n');
    const prompt = buildCompactionSummaryPrompt({
      language,
      isAutomaticCompaction,
      serializedHistory,
    });

    try {
      const result = await completeWithClaudeSdk(
        prompt,
        buildCompactionSummarySystemPrompt(language),
        this.getSessionRuntimeConfig(session)
      );
      const text = result.text.trim();
      if (text) {
        return { text, usedFallback: false };
      }
    } catch (error) {
      logWarn('[SessionManager] Compaction summary generation failed, using fallback', error);
    }

    return { text: this.buildFallbackCompactionSummary(messages), usedFallback: true };
  }

  private saveCompactionSnapshot(input: {
    sessionId: string;
    compactType: 'full';
    summaryText: string;
    preservedTail: Message[];
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    compactedMessageCount: number;
    compactedContextPreview: string;
    createdAt: number;
  }): void {
    this.db.compactionSnapshots.create({
      id: uuidv4(),
      session_id: input.sessionId,
      compact_type: input.compactType,
      summary_text: input.summaryText,
      preserved_tail: JSON.stringify(input.preservedTail),
      estimated_tokens_before: input.estimatedTokensBefore,
      estimated_tokens_after: input.estimatedTokensAfter,
      compacted_message_count: input.compactedMessageCount,
      preserved_tail_count: input.preservedTail.length,
      summary_preview: input.summaryText.slice(0, 200),
      compacted_context_preview: input.compactedContextPreview,
      created_at: input.createdAt,
    });
  }

  private buildNoopFullCompactionResult(
    sessionId: string,
    runtimeMessages: Message[],
    trigger: CompactionTrigger,
    preservedTailCount = Math.min(getPreservedTailCount(trigger), runtimeMessages.length),
    metadata?: {
      skipReason?: SessionCompactionInfo['skipReason'];
      failureCount?: number;
      emit?: boolean;
    }
  ): {
    runtimeMessages: Message[];
    info: SessionCompactionInfo;
  } {
    const estimatedTokens = estimateMessagesTokens(runtimeMessages);
    const info = buildCompactionInfo({
      sessionId,
      compactionType: 'full',
      trigger,
      status: 'skipped',
      skipReason: metadata?.skipReason,
      failureCount: metadata?.failureCount,
      boundaryCreated: false,
      estimatedTokensBefore: estimatedTokens,
      estimatedTokensAfter: estimatedTokens,
      preservedTailCount,
      compactedMessageCount: 0,
    });
    if (metadata?.emit) {
      this.emitCompaction(sessionId, info);
    }
    return {
      runtimeMessages,
      info,
    };
  }

  private async performFullCompaction(
    session: Session,
    runtimeMessages: Message[],
    trigger: CompactionTrigger
  ): Promise<{
    runtimeMessages: Message[];
    info: SessionCompactionInfo;
  }> {
    const isAutomaticCompaction = trigger !== 'manual';
    const failureCount = this.compactionFailureCounts.get(session.id) ?? 0;
    if (
      isAutomaticCompaction &&
      failureCount >= SessionManager.MAX_AUTOMATIC_COMPACTION_FAILURES
    ) {
      const message = '自动上下文压缩连续失败，已暂停本次自动压缩。可稍后手动 Compact。';
      this.emitCompactionNotice(session.id, 'warning', message);
      this.emitCompactionTrace(
        session.id,
        'Application compaction skipped',
        `Skipped ${trigger} compaction after ${failureCount} consecutive summary failures.`
      );
      return this.buildNoopFullCompactionResult(session.id, runtimeMessages, trigger, undefined, {
        skipReason: 'failure_circuit_breaker',
        failureCount,
        emit: true,
      });
    }

    if (isAutomaticCompaction && this.compactingSessions.has(session.id)) {
      const message = '检测到上下文压缩正在进行，已跳过嵌套自动压缩。';
      this.emitCompactionNotice(session.id, 'warning', message);
      this.emitCompactionTrace(
        session.id,
        'Application compaction skipped',
        `Skipped nested ${trigger} compaction while another compaction is active.`
      );
      return this.buildNoopFullCompactionResult(session.id, runtimeMessages, trigger, undefined, {
        skipReason: 'nested_compaction',
        emit: true,
      });
    }

    const startedAt = Date.now();
    this.compactingSessions.add(session.id);
    this.emitCompactionState(session.id, {
      sessionId: session.id,
      compactionType: 'full',
      trigger,
      startedAt,
      message:
        trigger === 'manual'
          ? '正在压缩上下文，请稍候…'
          : '上下文接近上限，正在自动压缩并重建运行时上下文…',
    });
    this.emitCompactionNotice(
      session.id,
      'info',
      trigger === 'manual' ? '正在压缩上下文，请稍候…' : '上下文接近上限，正在自动压缩，请稍候…'
    );

    try {
      const preservedTailCount = Math.min(getPreservedTailCount(trigger), runtimeMessages.length);
      const preservedTail = runtimeMessages.slice(-preservedTailCount);
      const olderMessages = runtimeMessages.slice(
        0,
        Math.max(0, runtimeMessages.length - preservedTailCount)
      );

      if (olderMessages.length === 0) {
        return this.buildNoopFullCompactionResult(
          session.id,
          runtimeMessages,
          trigger,
          preservedTailCount,
          { skipReason: 'no_older_messages' }
        );
      }

      const summaryResult = await this.generateCompactionSummary(session, olderMessages, { trigger });
      const summaryText = summaryResult.text;
      if (isAutomaticCompaction) {
        if (summaryResult.usedFallback) {
          const nextFailureCount = failureCount + 1;
          this.compactionFailureCounts.set(session.id, nextFailureCount);
          this.emitCompactionTrace(
            session.id,
            'Application compaction fallback',
            `Used fallback summary for ${trigger} compaction. Consecutive failures: ${nextFailureCount}.`
          );
        } else {
          this.compactionFailureCounts.delete(session.id);
        }
      }

      const boundaryMessage = createBoundarySummaryMessage(session.id, summaryText);
      const createdAt = Date.now();
      boundaryMessage.timestamp = createdAt;
      const compactedRuntimeMessages = [boundaryMessage, ...preservedTail];
      const estimatedTokensBefore = estimateMessagesTokens(runtimeMessages);
      const estimatedTokensAfter = estimateMessagesTokens(compactedRuntimeMessages);
      const compactedContextPreview = buildCompactedContextPreview(compactedRuntimeMessages);

      this.saveCompactionSnapshot({
        sessionId: session.id,
        compactType: 'full',
        summaryText,
        preservedTail,
        estimatedTokensBefore,
        estimatedTokensAfter,
        compactedMessageCount: olderMessages.length,
        compactedContextPreview,
        createdAt,
      });

      const info = buildCompactionInfo({
        sessionId: session.id,
        compactionType: 'full',
        trigger,
        status: summaryResult.usedFallback ? 'fallback' : 'created',
        failureCount: isAutomaticCompaction
          ? (this.compactionFailureCounts.get(session.id) ?? 0)
          : undefined,
        boundaryCreated: true,
        estimatedTokensBefore,
        estimatedTokensAfter,
        preservedTailCount,
        compactedMessageCount: olderMessages.length,
        summaryText,
        compactedContextPreview,
      });

      if (this.agentRunner.clearSdkSession) {
        this.agentRunner.clearSdkSession(session.id);
      }

      this.emitCompaction(session.id, info);
      this.emitCompactionNotice(
        session.id,
        'info',
        trigger === 'manual' ? '已创建压缩快照并重建运行时上下文' : '上下文已自动压缩并创建快照'
      );
      this.emitCompactionTrace(
        session.id,
        'Application compaction',
        `Created ${trigger} boundary. Tokens ${estimatedTokensBefore} -> ${estimatedTokensAfter}.`
      );

      return { runtimeMessages: compactedRuntimeMessages, info };
    } finally {
      this.compactingSessions.delete(session.id);
      this.emitCompactionState(session.id, null);
    }
  }

  // Process a prompt using ClaudeAgentRunner
  private async processPrompt(
    session: Session,
    prompt: string,
    content?: ContentBlock[],
    contextConfigOverride?: SessionContextConfig
  ): Promise<void> {
    const traceId = generateTraceId();
    return runWithLogContext({ sessionId: session.id, traceId }, async () => {
      logCtx('[SessionManager] Processing prompt for session:', session.id, 'traceId:', traceId);
      logCtx(
        '[SessionManager] Received content:',
        content
          ? JSON.stringify(
              content.map((c) => ({
                type: c.type,
                hasData: !!(c as { source?: { data?: unknown } }).source?.data,
              }))
            )
          : 'none'
      );

      // Ensure sandbox is initialized for this workspace
      await this.ensureSandboxInitialized(session);

      try {
        // Use provided content blocks or fall back to simple text
        let messageContent: ContentBlock[] =
          content && content.length > 0 ? content : [{ type: 'text', text: prompt } as TextContent];

        // Process file attachments - copy to .tmp directory
        messageContent = await this.processFileAttachments(session, messageContent);

        logCtx(
          '[SessionManager] Final message content types:',
          messageContent.map((c) => c.type)
        );

        // Build enhanced prompt with file information
        let enhancedPrompt = prompt;
        const fileAttachments = messageContent.filter(
          (c) => c.type === 'file_attachment'
        ) as FileAttachmentContent[];
        if (fileAttachments.length > 0) {
          const fileInfo = fileAttachments
            .map(
              (f) => `- ${f.filename} (${(f.size / 1024).toFixed(1)} KB) at path: ${f.relativePath}`
            )
            .join('\n');
          enhancedPrompt = `${prompt}\n\n[Attached files - use Read tool to access them]:\n${fileInfo}`;
          logCtx('[SessionManager] Enhanced prompt with file info:', enhancedPrompt);
        }

        // Save user message to database for persistence
        const existingMessages = this.getMessages(session.id);
        const userMessage: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'user',
          content: messageContent, // Save full content including images and files
          timestamp: Date.now(),
        };
        this.saveMessage(userMessage);
        logCtx(
          '[SessionManager] User message saved:',
          userMessage.id,
          'with',
          messageContent.length,
          'content blocks'
        );

        const { messages: runtimeMessagesBeforeCompaction, snapshot: latestBoundary } =
          this.getRuntimeMessages(session.id);
        this.maybeNotifyRestoredFromBoundary(session.id, latestBoundary);

        const contextConfig = this.resolveContextConfig(contextConfigOverride);
        const runtimeConfig = this.getSessionRuntimeConfig(session);
        const systemPromptTokens = this.estimateSystemPromptTokens(session, enhancedPrompt);
        const contextWindow = resolveRuntimeContextWindow(runtimeConfig);
        let budgetSnapshot = buildTokenBudgetSnapshot({
          messages: runtimeMessagesBeforeCompaction,
          contextWindow,
          maxContextTokens: contextConfig.maxContextTokens,
          strategy: contextConfig.memoryStrategy,
          systemPromptTokens,
        });
        this.emitTokenBudget(session.id, budgetSnapshot);

        let messagesForContext = runtimeMessagesBeforeCompaction;
        const thresholds = getStrategyThresholds(contextConfig.memoryStrategy);
        let sdkSessionNeedsReset = false;

        if (budgetSnapshot.usageRatio >= thresholds.microCompactRatio) {
          const microResult = microCompactMessages(
            runtimeMessagesBeforeCompaction,
            thresholds.preservedTailCount
          );
          if (microResult.compactedMessageCount > 0) {
            messagesForContext = microResult.messages;
            budgetSnapshot = buildTokenBudgetSnapshot({
              messages: messagesForContext,
              contextWindow,
              maxContextTokens: contextConfig.maxContextTokens,
              strategy: contextConfig.memoryStrategy,
              systemPromptTokens,
            });
            sdkSessionNeedsReset = true;
            const microInfo = buildCompactionInfo({
              sessionId: session.id,
              compactionType: 'micro',
              trigger:
                contextConfig.memoryStrategy === 'rolling'
                  ? 'rolling'
                  : contextConfig.memoryStrategy === 'manual'
                    ? 'manual'
                    : 'auto',
              boundaryCreated: false,
              estimatedTokensBefore: microResult.estimatedTokensBefore,
              estimatedTokensAfter: microResult.estimatedTokensAfter,
              preservedTailCount: thresholds.preservedTailCount,
              compactedMessageCount: microResult.compactedMessageCount,
              compactedContextPreview: buildCompactedContextPreview(messagesForContext),
            });
            this.emitCompaction(session.id, microInfo);
            this.emitCompactionTrace(
              session.id,
              'Application micro compact',
              `Compacted ${microResult.compactedMessageCount} older messages. Tokens ${microResult.estimatedTokensBefore} -> ${microResult.estimatedTokensAfter}.`
            );
            this.emitTokenBudget(session.id, budgetSnapshot);
          }
        }

        const compactTrigger: CompactionTrigger =
          contextConfig.memoryStrategy === 'rolling'
            ? 'rolling'
            : contextConfig.memoryStrategy === 'manual'
              ? 'manual'
              : 'auto';

        if (budgetSnapshot.usageRatio >= thresholds.fullCompactRatio) {
          const fullCompaction = await this.performFullCompaction(
            session,
            messagesForContext,
            compactTrigger
          );
          messagesForContext = fullCompaction.runtimeMessages;
          budgetSnapshot = buildTokenBudgetSnapshot({
            messages: messagesForContext,
            contextWindow,
            maxContextTokens: contextConfig.maxContextTokens,
            strategy: contextConfig.memoryStrategy,
            systemPromptTokens,
          });
          sdkSessionNeedsReset = false;
          this.emitTokenBudget(session.id, budgetSnapshot);
        } else if (budgetSnapshot.warningState === 'blocking') {
          const blockingMessage =
            contextConfig.memoryStrategy === 'manual'
              ? '当前上下文已达到阻塞阈值，请先点击 Compact Now 再继续发送。'
              : '当前上下文已达到阻塞阈值，自动压缩未能释放足够空间。';
          this.emitCompactionNotice(session.id, 'error', blockingMessage);
          throw new Error(blockingMessage);
        }

        if (sdkSessionNeedsReset && this.agentRunner.clearSdkSession) {
          this.agentRunner.clearSdkSession(session.id);
        }

        // Run the agent
        const agentRunStartedAt = Date.now();
        await this.agentRunner.run(session, enhancedPrompt, messagesForContext);

        // Keep the same app-controlled context that was sent to the runner
        // (including in-memory micro compaction), then append only messages
        // persisted during this turn.
        const postRunMessages = appendTranscriptMessagesSince(
          messagesForContext,
          this.getMessages(session.id),
          agentRunStartedAt
        );
        const postRunBudget = buildTokenBudgetSnapshot({
          messages: postRunMessages,
          contextWindow,
          maxContextTokens: contextConfig.maxContextTokens,
          strategy: contextConfig.memoryStrategy,
          systemPromptTokens,
        });
        this.emitTokenBudget(session.id, postRunBudget);

        // Note: post-run SDK session clearing is no longer needed because
        // agent-runner now replaces SDK internal messages with the compressed
        // version on every prompt() call (session reuse path), keeping the
        // SDK's state.messages within our budget at all times.

        // 标题生成不再与首轮对话并发，避免与主请求竞争同一上游配额/通道导致体感变慢。
        this.runSessionTitleGeneration(session, prompt, existingMessages).catch((err) =>
          logCtxError('[SessionManager] Title generation failed:', err)
        );
      } catch (error) {
        logCtxError('[SessionManager] Error processing prompt:', error);
        const errorText = error instanceof Error ? error.message : 'Unknown error';
        const alreadyReportedToUser = Boolean(
          error &&
          typeof error === 'object' &&
          (error as { alreadyReportedToUser?: boolean }).alreadyReportedToUser
        );
        if (!alreadyReportedToUser) {
          const assistantMessage: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: `**Error**: ${errorText}` }],
            timestamp: Date.now(),
          };
          this.saveMessage(assistantMessage);
          this.sendToRenderer({
            type: 'stream.message',
            payload: { sessionId: session.id, message: assistantMessage },
          });
        }
        this.sendToRenderer({
          type: 'error',
          payload: { message: errorText },
        });
      }
    }); // end runWithLogContext
  }

  private async runSessionTitleGeneration(
    session: Session,
    prompt: string,
    existingMessages: Message[]
  ): Promise<void> {
    const token = Symbol(`title:${session.id}`);
    this.titleGenerationTokens.set(session.id, token);
    const shouldAbort = () => {
      if (this.titleGenerationTokens.get(session.id) !== token) {
        return true;
      }
      return !this.db.sessions.get(session.id);
    };
    const userMessageCount =
      existingMessages.filter((message) => message.role === 'user').length + 1;
    try {
      await maybeGenerateSessionTitle({
        sessionId: session.id,
        prompt,
        userMessageCount,
        currentTitle: session.title,
        hasAttempted: this.sessionTitleAttempts.has(session.id),
        generateTitle: async (titlePrompt) => {
          if (shouldAbort()) {
            return null;
          }
          const title = await this.withTimeout(
            this.generateTitleWithConfig(titlePrompt),
            TITLE_GENERATION_TIMEOUT_MS,
            session.id
          );
          return normalizeGeneratedTitle(title);
        },
        getLatestTitle: () => this.db.sessions.get(session.id)?.title ?? null,
        markAttempt: () => {
          this.sessionTitleAttempts.add(session.id);
        },
        updateTitle: async (title) => {
          if (shouldAbort()) {
            log('[SessionTitle] Skip update: session no longer active', session.id);
            return false;
          }
          const updated = this.updateSessionTitle(session.id, title);
          if (updated) {
            session.title = title;
          }
          return updated;
        },
        shouldAbort,
        log,
      });
    } catch (error) {
      logError('[SessionTitle] Unexpected error', session.id, error);
    } finally {
      if (this.titleGenerationTokens.get(session.id) === token) {
        this.titleGenerationTokens.delete(session.id);
      }
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    sessionId: string
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        logError('[SessionTitle] Generation timed out', { sessionId, timeoutMs });
        resolve(null);
      }, timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          logError('[SessionTitle] Generation rejected', { sessionId, error });
          resolve(null);
        });
    });
  }

  private async generateTitleWithConfig(titlePrompt: string): Promise<string | null> {
    // Always use pi-ai SDK for title generation
    return normalizeGeneratedTitle(
      await generateTitleWithClaudeSdk(titlePrompt, configStore.getAll())
    );
  }

  private enqueuePrompt(
    session: Session,
    prompt: string,
    content?: ContentBlock[],
    contextConfig?: SessionContextConfig
  ): void {
    const queue = this.promptQueues.get(session.id) || [];
    queue.push({ prompt, content, contextConfig });
    this.promptQueues.set(session.id, queue);

    if (!this.activeSessions.has(session.id)) {
      this.processQueue(session).catch((err) => {
        logError('[SessionManager] Queue processing error:', err);
        this.sendToRenderer({
          type: 'error',
          payload: {
            message: `Failed to process message: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
    } else {
      log('[SessionManager] Session running, queued prompt:', session.id);
    }
  }

  private async processQueue(session: Session): Promise<void> {
    if (this.activeSessions.has(session.id)) return;

    const controller = new AbortController();
    this.activeSessions.set(session.id, controller);
    this.updateSessionStatus(session.id, 'running');

    try {
      // Outer loop: after the inner loop drains, re-check for items that
      // arrived while processPrompt was awaited. This keeps the session in
      // activeSessions the entire time, preventing enqueuePrompt from
      // spawning a duplicate processQueue during the gap that previously
      // existed between activeSessions.delete and the restart call.
      let shouldContinue = true;
      while (shouldContinue) {
        while (!controller.signal.aborted) {
          const queue = this.promptQueues.get(session.id);
          if (!queue || queue.length === 0) break;

          const item = queue.shift();
          if (!item) continue;

          const latestSession = this.loadSession(session.id);
          if (!latestSession) {
            log('[SessionManager] Session removed while processing queue:', session.id);
            return; // finally handles cleanup
          }

          await this.processPrompt(latestSession, item.prompt, item.content, item.contextConfig);

          if (controller.signal.aborted) return; // finally handles cleanup
        }

        // If aborted, exit immediately — finally handles cleanup.
        if (controller.signal.aborted) {
          shouldContinue = false;
          continue;
        }

        // Re-check: items may have been enqueued during the last processPrompt await.
        const pendingQueue = this.promptQueues.get(session.id);
        if (!pendingQueue || pendingQueue.length === 0) {
          shouldContinue = false;
          continue;
        }

        // Reload session before continuing with newly arrived prompts.
        const latestSession = this.loadSession(session.id);
        if (!latestSession) {
          this.promptQueues.delete(session.id);
          shouldContinue = false;
          continue;
        }
        session = latestSession;
        log('[SessionManager] Continuing queue with newly arrived prompts:', session.id);
      }
    } finally {
      // Only clean up here. The outer loop handles normal re-checking; if a
      // stop aborts the loop while a new prompt arrives, restart below.
      this.activeSessions.delete(session.id);
      const queue = this.promptQueues.get(session.id);
      if (queue && queue.length === 0) {
        this.promptQueues.delete(session.id);
      }
      if (controller.signal.aborted && queue && queue.length > 0) {
        const latestSession = this.loadSession(session.id);
        if (latestSession) {
          log('[SessionManager] Restarting queue after aborted run:', session.id);
          this.processQueue(latestSession).catch((err) => {
            logError('[SessionManager] Queue processing error after abort:', err);
            this.sendToRenderer({
              type: 'error',
              payload: {
                message: `Failed to process message: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            });
          });
          return;
        }
      }
      this.updateSessionStatus(session.id, 'idle');
    }
  }

  // Stop a running session
  stopSession(sessionId: string): void {
    log('[SessionManager] Stopping session:', sessionId);
    this.titleGenerationTokens.delete(sessionId);
    this.agentRunner.cancel(sessionId);
    // Cancel any pending sudo password requests for this session
    for (const [toolUseId, entry] of this.pendingSudoPasswords) {
      if (entry.sessionId === sessionId) {
        entry.resolve(null);
        this.pendingSudoPasswords.delete(toolUseId);
        this.sendToRenderer({ type: 'sudo.password.dismiss', payload: { toolUseId } });
      }
    }
    // Also abort any pending controller we tracked
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
    }
    this.promptQueues.delete(sessionId);
    this.messageCache.delete(sessionId);
    this.updateSessionStatus(sessionId, 'idle');
  }

  // Delete a session
  async deleteSession(sessionId: string): Promise<void> {
    // Stop if running
    this.stopSession(sessionId);

    // Sync and cleanup sandbox if it exists for this session
    if (SandboxSync.hasSession(sessionId)) {
      log('[SessionManager] Cleaning up sandbox for session:', sessionId);
      try {
        await SandboxSync.syncAndCleanup(sessionId);
        log('[SessionManager] Sandbox cleanup complete for session:', sessionId);
      } catch (error) {
        logError('[SessionManager] Failed to cleanup sandbox:', error);
        // Continue with session deletion even if sandbox cleanup fails
      }
    }

    // Delete from database (messages will be deleted automatically via CASCADE)
    this.db.sessions.delete(sessionId);
    this.messageCache.delete(sessionId);
    this.sessionTitleAttempts.delete(sessionId);
    this.titleGenerationTokens.delete(sessionId);
    this.restoreNoticeSent.delete(sessionId);

    log('[SessionManager] Session deleted:', sessionId);
  }

  async batchDeleteSessions(sessionIds: string[]): Promise<void> {
    // Stop sessions and clean up sandboxes first (async, cannot run inside SQLite transaction)
    for (const sessionId of sessionIds) {
      this.stopSession(sessionId);
      if (SandboxSync.hasSession(sessionId)) {
        try {
          await SandboxSync.syncAndCleanup(sessionId);
        } catch (error) {
          logError('[SessionManager] Failed to cleanup sandbox during batch delete:', error);
        }
      }
    }

    // Perform all SQLite deletions atomically
    this.db.raw.transaction(() => {
      for (const sessionId of sessionIds) {
        this.db.sessions.delete(sessionId);
        this.messageCache.delete(sessionId);
        this.sessionTitleAttempts.delete(sessionId);
        this.titleGenerationTokens.delete(sessionId);
        this.restoreNoticeSent.delete(sessionId);
      }
    })();

    log('[SessionManager] Batch deleted sessions:', sessionIds.length);
  }

  updateSessionPlanMode(sessionId: string, planMode: boolean): void {
    log('[SessionManager] Updating plan mode:', sessionId, planMode);
    const existing = this.db.sessions.get(sessionId) as { plan_mode?: number } | null;
    if (!existing) {
      logWarn('[SessionManager] Cannot update plan mode; session not found:', sessionId);
      return;
    }
    const previousPlanMode = (existing?.plan_mode ?? 0) === 1;
    const changed = previousPlanMode !== planMode;
    this.db.sessions.update(sessionId, { plan_mode: planMode ? 1 : 0, updated_at: Date.now() });

    if (changed) {
      const modeEvent: Message = {
        id: uuidv4(),
        sessionId,
        role: 'assistant',
        content: [{ type: 'text', text: planMode ? MODE_EVENT_ENTER_PLAN : MODE_EVENT_EXIT_PLAN }],
        timestamp: Date.now(),
      };
      this.saveMessage(modeEvent);
      if (this.agentRunner?.clearSdkSession) {
        this.agentRunner.clearSdkSession(sessionId);
      }
      log(
        '[SessionManager] Plan mode changed; mode event saved and SDK session cleared:',
        sessionId,
        planMode ? 'plan' : 'normal'
      );
    }

    this.sendToRenderer({
      type: 'session.planMode',
      payload: { sessionId, planMode },
    });
  }

  updateSessionRuntime(
    sessionId: string,
    updates: {
      model?: string;
      configSetId?: string;
      thinkingLevel?: Session['thinkingLevel'];
      planMode?: boolean;
    }
  ): Session | null {
    const existing = this.loadSession(sessionId);
    if (!existing) {
      logWarn('[SessionManager] Cannot update runtime; session not found:', sessionId);
      return null;
    }

    const normalizedModel =
      typeof updates.model === 'string' ? updates.model.trim() || null : undefined;
    const normalizedConfigSetId =
      typeof updates.configSetId === 'string' ? updates.configSetId.trim() || null : undefined;
    const normalizedThinkingLevel =
      updates.thinkingLevel !== undefined
        ? normalizeSessionThinkingLevel(updates.thinkingLevel) || 'off'
        : undefined;

    const rowUpdates: Partial<{
      model: string | null;
      config_set_id: string | null;
      thinking_level: string;
    }> = {};
    const sessionUpdates: Partial<Session> = {};
    let shouldClearSdkSession = false;

    if (normalizedModel !== undefined && normalizedModel !== (existing.model || null)) {
      rowUpdates.model = normalizedModel;
      sessionUpdates.model = normalizedModel || undefined;
      shouldClearSdkSession = true;
    }

    if (
      normalizedConfigSetId !== undefined &&
      normalizedConfigSetId !== (existing.configSetId || null)
    ) {
      rowUpdates.config_set_id = normalizedConfigSetId;
      sessionUpdates.configSetId = normalizedConfigSetId || undefined;
      shouldClearSdkSession = true;
    }

    if (
      normalizedThinkingLevel !== undefined &&
      normalizedThinkingLevel !== (existing.thinkingLevel || undefined)
    ) {
      rowUpdates.thinking_level = normalizedThinkingLevel;
      sessionUpdates.thinkingLevel = normalizedThinkingLevel;
      shouldClearSdkSession = true;
    }

    if (Object.keys(rowUpdates).length > 0) {
      this.db.sessions.update(sessionId, rowUpdates);
      if (shouldClearSdkSession && this.agentRunner?.clearSdkSession) {
        this.agentRunner.clearSdkSession(sessionId);
      }
      this.sendToRenderer({
        type: 'session.update',
        payload: { sessionId, updates: sessionUpdates },
      });
    }

    if (typeof updates.planMode === 'boolean') {
      this.updateSessionPlanMode(sessionId, updates.planMode);
    }

    return this.loadSession(sessionId);
  }

  renameSession(sessionId: string, title: string): boolean {
    const normalizedTitle = title.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!normalizedTitle) {
      return false;
    }
    return this.updateSessionTitle(sessionId, normalizedTitle);
  }

  // Update session status
  private updateSessionStatus(sessionId: string, status: Session['status']): void {
    this.db.sessions.update(sessionId, { status, updated_at: Date.now() });

    this.sendToRenderer({
      type: 'session.status',
      payload: { sessionId, status },
    });
  }

  private updateSessionTitle(sessionId: string, title: string): boolean {
    const existing = this.db.sessions.get(sessionId);
    if (!existing) {
      log('[SessionTitle] Skip title update for deleted session:', sessionId);
      return false;
    }
    this.db.sessions.update(sessionId, { title });
    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { title } },
    });
    return true;
  }

  // Update session's working directory
  // Also clears SDK session cache because Claude SDK sessions are bound to cwd
  updateSessionCwd(sessionId: string, cwd: string): void {
    if (this.activeSessions.has(sessionId)) {
      logWarn(
        '[SessionManager] CWD change requested while session running; stopping active run first',
        { sessionId, cwd }
      );
      this.stopSession(sessionId);
    }
    const mountedPaths = this.buildMountedPaths(cwd);
    // Clear claude_session_id in DB so next query creates a new SDK session
    // (Claude SDK sessions cannot change cwd mid-session)
    this.db.sessions.update(sessionId, {
      cwd,
      mounted_paths: JSON.stringify(mountedPaths),
      claude_session_id: null,
      openai_thread_id: null,
      updated_at: Date.now(),
    });

    // Also clear the in-memory SDK session cache
    if (this.agentRunner?.clearSdkSession) {
      this.agentRunner.clearSdkSession(sessionId);
    }

    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { cwd, mountedPaths } },
    });

    log('[SessionManager] Session cwd updated:', sessionId, '->', cwd, '(SDK session cleared)');
  }

  // Save message to database
  saveMessage(message: Message): void {
    this.db.messages.create({
      id: message.id,
      session_id: message.sessionId,
      role: message.role,
      content: JSON.stringify(message.content),
      timestamp: message.timestamp,
      token_usage: message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
      execution_time_ms: message.executionTimeMs ?? null,
    });
    const cached = this.messageCache.get(message.sessionId);
    if (cached) {
      cached.push(message);
    } else {
      // Only evict when the cache could actually grow (i.e. the session is
      // not cached yet). Evicting on every saveMessage call is wrong because
      // the Map size didn't increase — we just appended to an existing array —
      // and the oldest entry could be the very session we just updated.
      if (this.messageCache.size > SessionManager.MAX_CACHE_SIZE) {
        const firstKey = this.messageCache.keys().next().value;
        if (firstKey) this.messageCache.delete(firstKey);
      }
      this.messageCache.set(message.sessionId, [message]);
    }

    log('[SessionManager] Message saved:', message.id, 'role:', message.role);
  }

  // Get messages for a session
  getMessages(sessionId: string): Message[] {
    const cached = this.messageCache.get(sessionId);
    if (cached) {
      return [...cached];
    }

    const rows = this.db.messages.getBySessionId(sessionId);
    const messages = rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Message['role'],
      content: this.normalizeContent(row.content),
      timestamp: row.timestamp,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
    }));
    this.messageCache.set(sessionId, messages);
    return [...messages];
  }

  getMessagesPage(sessionId: string, limit = 5, beforeTimestamp?: number): SessionMessagesPage {
    const normalizedLimit = Math.max(1, Math.min(limit, 100));
    const queryLimit = normalizedLimit + 1;
    const rows =
      beforeTimestamp === undefined
        ? this.db.messages.getLatestBySessionId(sessionId, queryLimit)
        : this.db.messages.getBeforeTimestamp(sessionId, beforeTimestamp, queryLimit);
    const hasMore = rows.length > normalizedLimit;
    const selectedRows = hasMore ? rows.slice(0, normalizedLimit) : rows;
    const messages = selectedRows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Message['role'],
      content: this.normalizeContent(row.content),
      timestamp: row.timestamp,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
    }));

    return {
      messages,
      hasMore,
      oldestTimestamp: messages[0]?.timestamp ?? null,
    };
  }

  /**
   * Search the FULL message history of the current session (bypasses compaction boundaries).
   * This intentionally stays session-scoped; durable project-level knowledge uses memory tools.
   */
  private searchHistory(request: HistorySearchRequest): HistorySearchResult[] {
    const session = this.db.sessions.get(request.currentSessionId);
    const messages = this.getMessages(request.currentSessionId);
    const query = normalizeHistorySearchText(request.query);
    const terms = tokenizeHistoryQuery(query);
    const mode = request.mode ?? 'smart';
    const maxResults = normalizeHistoryLimit(request.maxResults, 20);
    const excludedMessageIds = new Set(request.excludeMessageIds ?? []);
    const beforeTimestamp = Number.isFinite(request.beforeTimestamp ?? NaN)
      ? (request.beforeTimestamp as number)
      : undefined;
    const results: HistorySearchResult[] = [];

    if (!query || terms.length === 0) {
      return [];
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      if (excludedMessageIds.has(msg.id)) continue;
      if (beforeTimestamp !== undefined && msg.timestamp >= beforeTimestamp) continue;

      const text = flattenMessageForHistorySearch(msg, {
        includeToolResults: request.includeToolResults === true,
        includeSearchToolResults: request.includeSearchToolResults === true,
      });
      const normalizedText = normalizeHistorySearchText(text);
      if (!normalizedText) continue;

      const score = scoreHistoryMatch(normalizedText, query, terms, mode);
      if (score <= 0) continue;

      results.push({
        sessionId: request.currentSessionId,
        sessionTitle: session?.title ?? 'Untitled',
        sessionCwd: session?.cwd ?? null,
        messageId: msg.id,
        role: msg.role as 'user' | 'assistant',
        timestamp: msg.timestamp,
        snippet: buildHistorySnippet(text, normalizedText, query, terms),
        turnIndex: i,
        score,
      });
    }

    return results
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, maxResults);
  }

  private readHistory(request: HistoryReadRequest): HistoryReadResult {
    const sessionId = request.currentSessionId;
    const session = this.db.sessions.get(sessionId);
    const messages = this.getMessages(sessionId);
    const before = normalizeHistoryWindowCount(request.before, 2);
    const after = normalizeHistoryWindowCount(request.after, 2);
    const maxChars = normalizeHistoryMaxChars(request.maxChars);
    let centerIndex = -1;

    if (request.messageId) {
      centerIndex = messages.findIndex((message) => message.id === request.messageId);
    }
    if (centerIndex < 0 && Number.isFinite(request.turnIndex ?? NaN)) {
      centerIndex = Math.floor(request.turnIndex as number);
    }
    if (centerIndex < 0 || centerIndex >= messages.length) {
      return {
        sessionId,
        sessionTitle: session?.title ?? 'Untitled',
        sessionCwd: session?.cwd ?? null,
        messages: [],
        truncated: false,
        returnedChars: 0,
        maxChars,
      };
    }

    const start = Math.max(0, centerIndex - before);
    const end = Math.min(messages.length, centerIndex + after + 1);
    const selected: HistoryReadResult['messages'] = [];
    let returnedChars = 0;
    let truncated = false;

    for (let i = start; i < end; i++) {
      const message = messages[i];
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      let text = flattenMessageForHistoryRead(message);
      const remaining = maxChars - returnedChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (text.length > remaining) {
        text = `${text.slice(0, remaining)}\n[History output truncated]`;
        truncated = true;
      }
      returnedChars += text.length;
      selected.push({
        messageId: message.id,
        role: message.role as 'user' | 'assistant',
        timestamp: message.timestamp,
        turnIndex: i,
        text,
      });
      if (truncated) break;
    }

    return {
      sessionId,
      sessionTitle: session?.title ?? 'Untitled',
      sessionCwd: session?.cwd ?? null,
      messages: selected,
      truncated,
      returnedChars,
      maxChars,
    };
  }

  private normalizeContent(raw: string): ContentBlock[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as ContentBlock[];
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        typeof (parsed as { type: unknown }).type === 'string'
      ) {
        return [parsed as ContentBlock];
      }
      if (typeof parsed === 'string') {
        return [{ type: 'text', text: parsed } as TextContent];
      }
      return [{ type: 'text', text: String(parsed) } as TextContent];
    } catch {
      return [{ type: 'text', text: raw } as TextContent];
    }
  }

  getTraceSteps(sessionId: string): TraceStep[] {
    const rows = this.db.traceSteps.getBySessionId(sessionId);
    const parseToolInput = (value: string | null): Record<string, unknown> | undefined => {
      if (!value) return undefined;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    return rows.map((row) => ({
      id: row.id,
      type: row.type as TraceStep['type'],
      status: row.status as TraceStep['status'],
      title: row.title,
      content: row.content || undefined,
      toolName: row.tool_name || undefined,
      toolInput: parseToolInput(row.tool_input),
      toolOutput: row.tool_output || undefined,
      isError: row.is_error === 1 ? true : undefined,
      timestamp: row.timestamp,
      duration: row.duration ?? undefined,
    }));
  }

  // Handle permission response
  handlePermissionResponse(toolUseId: string, result: PermissionResult): void {
    const resolver = this.pendingPermissions.get(toolUseId);
    if (resolver) {
      resolver(result);
      this.pendingPermissions.delete(toolUseId);
    }
  }

  // Request permission for a tool
  async requestPermission(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingPermissions.delete(toolUseId);
        resolve('deny');
        this.sendToRenderer({ type: 'permission.dismiss', payload: { toolUseId } });
      }, 60_000);
      this.pendingPermissions.set(toolUseId, (result: PermissionResult) => {
        clearTimeout(timeoutId);
        resolve(result);
      });
      this.sendToRenderer({
        type: 'permission.request',
        payload: { toolUseId, toolName, input, sessionId },
      });
    });
  }

  // Request sudo password from the user
  async requestSudoPassword(
    sessionId: string,
    toolUseId: string,
    command: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingSudoPasswords.delete(toolUseId);
        resolve(null);
        this.sendToRenderer({ type: 'sudo.password.dismiss', payload: { toolUseId } });
      }, 60_000);
      this.pendingSudoPasswords.set(toolUseId, {
        sessionId,
        resolve: (password: string | null) => {
          clearTimeout(timeout);
          resolve(password);
        },
      });
      this.sendToRenderer({
        type: 'sudo.password.request',
        payload: { toolUseId, command, sessionId },
      });
    });
  }

  // Handle sudo password response from renderer
  handleSudoPasswordResponse(toolUseId: string, password: string | null): void {
    const entry = this.pendingSudoPasswords.get(toolUseId);
    if (entry) {
      entry.resolve(password);
      this.pendingSudoPasswords.delete(toolUseId);
    }
  }

  private saveTraceStep(sessionId: string, step: TraceStep): void {
    this.db.traceSteps.create({
      id: step.id,
      session_id: sessionId,
      type: step.type,
      status: step.status,
      title: step.title,
      content: step.content ?? null,
      tool_name: step.toolName ?? null,
      tool_input: step.toolInput ? JSON.stringify(step.toolInput) : null,
      tool_output: step.toolOutput ?? null,
      is_error: step.isError ? 1 : null,
      timestamp: step.timestamp,
      duration: step.duration ?? null,
    });
  }

  private updateTraceStep(stepId: string, updates: Partial<TraceStep>): void {
    const rowUpdates: Partial<TraceStepRow> = {};
    if (updates.type !== undefined) rowUpdates.type = updates.type;
    if (updates.status !== undefined) rowUpdates.status = updates.status;
    if (updates.title !== undefined) rowUpdates.title = updates.title;
    if (updates.content !== undefined) rowUpdates.content = updates.content;
    if (updates.toolName !== undefined) rowUpdates.tool_name = updates.toolName;
    if (updates.toolInput !== undefined) {
      rowUpdates.tool_input = updates.toolInput ? JSON.stringify(updates.toolInput) : null;
    }
    if (updates.toolOutput !== undefined) rowUpdates.tool_output = updates.toolOutput;
    if (updates.isError !== undefined) rowUpdates.is_error = updates.isError ? 1 : 0;
    if (updates.timestamp !== undefined) rowUpdates.timestamp = updates.timestamp;
    if (updates.duration !== undefined) rowUpdates.duration = updates.duration;

    this.db.traceSteps.update(stepId, rowUpdates);
  }
}
