/**
 * @module main/claude/agent-runner
 *
 * AI query execution engine (1514 lines).
 *
 * Responsibilities:
 * - Runs AI conversations via the pi-coding-agent SDK (createAgentSession)
 * - Routes providers via pi-ai SDK for model resolution
 * - Bridges MCP tools into SDK ToolDefinition format
 * - Streams responses back as ServerEvents (stream.message, stream.partial, trace.step)
 * - Skills injection, system prompt assembly, permission handling
 *
 * Dependencies: session-manager, mcp-manager, config-store, skills-manager
 */
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  createCodingTools,
  type BashOperations,
  type AgentSession as PiAgentSession,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { ImageContent as PiImageContent } from '@mariozechner/pi-ai';
import { Type, type TSchema } from '@sinclair/typebox';
import { getSharedAuthStorage, ModelRegistry } from './shared-auth';
import type { Session, Message, TraceStep, ServerEvent, ContentBlock } from '../../renderer/types';
import { v4 as uuidv4 } from 'uuid';
import { PathResolver } from '../sandbox/path-resolver';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import {
  log,
  logWarn,
  logError,
  logCtx,
  logCtxWarn,
  logCtxError,
  logTiming,
} from '../utils/logger';
import { executeWindowsPowerShell } from '../tools/windows-powershell-executor';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'child_process';
import { app } from 'electron';
import { setMaxListeners } from 'node:events';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { pathConverter } from '../sandbox/wsl-bridge';
import { SandboxSync } from '../sandbox/sandbox-sync';
import { extractArtifactsFromText, buildArtifactTraceSteps } from '../utils/artifact-parser';
import { getDefaultShell } from '../utils/shell-resolver';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import type { SkillsAdapter } from '../skills/skills-adapter';
import type { BackgroundTaskService } from '../background/background-task-service';
import { configStore } from '../config/config-store';
import { normalizeOpenAICompatibleBaseUrl } from '../config/auth-utils';
import { resolveMessageEndPayload, toUserFacingErrorText } from './agent-runner-message-end';
import {
  normalizeProjectPath,
  ProjectMemoryService,
  type KnowledgeEntry,
  type KnowledgeType,
} from '../memory/project-memory';
import {
  applyMemoryActions,
  buildKnowledgeSourceCandidates,
  buildCandidateEvaluationAction,
} from '../memory/memory-evaluation';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import {
  buildPiSessionRuntimeSignature,
  diffPiSessionRuntimeSignatures,
} from './pi-session-runtime';
import { ThinkTagStreamParser } from './think-tag-parser';
import {
  limitToolExecutionResultForModel,
  normalizeMcpToolResultForModel,
  normalizeToolExecutionResultForUi,
} from './tool-result-utils';
import {
  disableThinkingForAnthropicPayload,
  disableThinkingForOpenAIPayload,
  restoreOpenAIReasoningContentForPayload,
  restoreUnsignedThinkingBlocksForAnthropicPayload,
} from './thinking-compat';
import { fetchOllamaModelInfo } from '../config/ollama-api';
import { executeWindowsBash } from '../tools/windows-bash-executor';
import { compressToolExecutionResultForModel } from '../tools/tool-output-compression';
import { recordToolOutputCompressionEvent } from '../tools/tool-output-compression-stats';
import { getDatabase } from '../db/database';
import {
  resolvePreferredWindowsShell,
  getWindowsRegistryPathEntries,
} from '../runtime/runtime-resolver';
import {
  getGlobalSkillsDir,
  getProjectSkillsDir,
  resolveBuiltinSkillsPath,
} from '../skills/skill-paths';
import { isPlanModeToolAllowed, type PlanModeToolDecision } from './plan-mode-guard';
import {
  buildOpenCoworkAppendPrompt,
  buildPlanModeRuntimePrompt,
  buildWorkspaceInfoPrompt,
  VIRTUAL_WORKSPACE_PATH,
} from './prompt-contract';
import { buildAnySearchTool } from '../search/anysearch-tool';

const DEFAULT_HISTORY_CHARS_PER_TOKEN = 2; // Conservative estimate: 2 chars ≈ 1 token (handles CJK-heavy content)
const DEFAULT_COLD_START_HISTORY_BUDGET_RATIO = 0.15; // Use 15% of context window for cold start history
const SMALL_CONTEXT_HISTORY_BUDGET_RATIO = 0.08;
const MAX_COLD_START_HISTORY_TURNS = 32; // Fewer turns to keep preamble lean

interface StableHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
}

interface StableHistoryPreambleResult {
  preamble: string;
  availableMessages: number;
  injectedMessages: number;
  omittedMessages: number;
  excludedCurrentTurnUser: boolean;
  historyCharBudget: number;
}

function normalizeHistoryText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractStableHistoryEntries(messages: Message[]): StableHistoryEntry[] {
  const entries: StableHistoryEntry[] = [];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    const text = message.content
      .map((content) => {
        if (content.type === 'text') {
          return normalizeHistoryText((content as { text: string }).text);
        }
        if (content.type === 'thinking') {
          const thinkingText = (content as { thinking: string }).thinking;
          return `<thinking>${escapeXmlText(thinkingText)}</thinking>`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    if (!text.trim()) {
      continue;
    }

    entries.push({
      role: message.role,
      text,
    });
  }

  return entries;
}

function serializeStableHistoryTurn(entry: StableHistoryEntry): string {
  return `<turn role="${entry.role}">${escapeXmlText(entry.text)}</turn>`;
}

/**
 * Convert Open Cowork Message[] to pi SDK AgentMessage[] format.
 * Tool results are omitted — the SDK manages its own tool result flow.
 */
function convertToPiAgentMessages(messages: Message[]): import('@mariozechner/pi-ai').Message[] {
  const result: import('@mariozechner/pi-ai').Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content: (
        | import('@mariozechner/pi-ai').TextContent
        | import('@mariozechner/pi-ai').ImageContent
      )[] = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          content.push({ type: 'text' as const, text: c.text });
        } else if (c.type === 'image' && c.source.type === 'base64') {
          content.push({
            type: 'image' as const,
            data: c.source.data,
            mimeType: c.source.media_type,
          });
        }
      }
      result.push({
        role: 'user',
        content,
        timestamp: msg.timestamp ?? Date.now(),
      });
    } else if (msg.role === 'assistant') {
      const content: import('@mariozechner/pi-ai').AssistantMessage['content'] = [];
      for (const c of msg.content) {
        if (c.type === 'text') {
          content.push({ type: 'text' as const, text: c.text });
        } else if (c.type === 'thinking') {
          content.push({
            type: 'thinking' as const,
            thinking: c.thinking,
            ...(c.thinkingSignature ? { thinkingSignature: c.thinkingSignature } : {}),
          });
        } else if (c.type === 'tool_use') {
          content.push({ type: 'toolCall' as const, id: c.id, name: c.name, arguments: c.input });
        }
      }
      result.push({
        role: 'assistant',
        content,
        api: '' as import('@mariozechner/pi-ai').Api,
        provider: '' as import('@mariozechner/pi-ai').Provider,
        model: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: msg.timestamp ?? Date.now(),
      });
    }
    // toolResult messages are skipped — SDK manages its own tool result flow
  }
  return result;
}

function buildStableConversationHistoryPreamble(input: {
  messages: Message[];
  provider: string;
  contextWindow: number;
}): StableHistoryPreambleResult {
  const historyEntries = extractStableHistoryEntries(input.messages);
  const excludedCurrentTurnUser =
    historyEntries.length > 0 && historyEntries[historyEntries.length - 1]?.role === 'user';
  const candidateEntries = excludedCurrentTurnUser ? historyEntries.slice(0, -1) : historyEntries;

  if (candidateEntries.length === 0) {
    return {
      preamble: '',
      availableMessages: 0,
      injectedMessages: 0,
      omittedMessages: 0,
      excludedCurrentTurnUser,
      historyCharBudget: 0,
    };
  }

  const historyBudgetRatio =
    input.provider === 'ollama' && input.contextWindow < 16384
      ? SMALL_CONTEXT_HISTORY_BUDGET_RATIO
      : DEFAULT_COLD_START_HISTORY_BUDGET_RATIO;
  const historyTokenBudget = Math.floor(input.contextWindow * historyBudgetRatio);
  const historyCharBudget = Math.max(
    1024,
    Math.floor(historyTokenBudget * DEFAULT_HISTORY_CHARS_PER_TOKEN)
  );

  const selectedEntries: StableHistoryEntry[] = [];
  let charCount = 0;

  for (let i = candidateEntries.length - 1; i >= 0; i -= 1) {
    if (selectedEntries.length >= MAX_COLD_START_HISTORY_TURNS) {
      break;
    }

    const entry = candidateEntries[i];
    const serialized = serializeStableHistoryTurn(entry);
    const nextCharCount = charCount + serialized.length;

    if (selectedEntries.length > 0 && nextCharCount > historyCharBudget) {
      break;
    }

    selectedEntries.unshift(entry);
    charCount = nextCharCount;
  }

  const omittedMessages = candidateEntries.length - selectedEntries.length;
  const historyNote = omittedMessages > 0 ? `[${omittedMessages} older messages omitted]\n` : '';
  const preamble = `<conversation_history>\n${historyNote}${selectedEntries
    .map((entry) => serializeStableHistoryTurn(entry))
    .join('\n')}\n</conversation_history>`;

  return {
    preamble,
    availableMessages: candidateEntries.length,
    injectedMessages: selectedEntries.length,
    omittedMessages,
    excludedCurrentTurnUser,
    historyCharBudget,
  };
}

// Bundled node/npx paths never change at runtime — resolve once.
let cachedBundledNodePaths: { node: string; npx: string } | null | undefined = undefined;

function getBundledNodePaths(): { node: string; npx: string } | null {
  if (cachedBundledNodePaths !== undefined) {
    return cachedBundledNodePaths;
  }
  const platform = process.platform;
  const arch = process.arch;
  let resourcesPath: string;
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
  } else {
    resourcesPath = path.join(process.resourcesPath, 'node');
  }
  const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
  const nodePath = path.join(binDir, platform === 'win32' ? 'node.exe' : 'node');
  const npxPath = path.join(binDir, platform === 'win32' ? 'npx.cmd' : 'npx');
  cachedBundledNodePaths =
    fs.existsSync(nodePath) && fs.existsSync(npxPath) ? { node: nodePath, npx: npxPath } : null;
  return cachedBundledNodePaths;
}

/**
 * On Windows, the bundled Node.js binary lives in `resources/node/win32-x64/`
 * with a `node.exe` and `npx.cmd`, but no npm module (lib/node_modules/npm).
 * If a user's global npm.cmd picks up this bundled `node.exe`, npm will fail
 * with "Cannot find module npm-cli.js" because the npm module tree is absent.
 *
 * This function restores the user's global npm/npx entries to the front of PATH
 * over the bundled node bin dir, ensuring `npm run` and `npx` resolve correctly.
 */
function restoreWindowsUserNodeModulesPaths(delimiter: string, merged: string[]): void {
  const nodePathSegments: string[] = [];
  const currentPath = (process.env.PATH || '').split(delimiter).filter((p: string) => p.trim());

  // Collect the first user-level npm/npx.cmd path entry found
  for (const entry of currentPath) {
    const npmCmd = path.join(entry, 'npm.cmd');
    const npxCmd = path.join(entry, 'npx.cmd');
    if (fs.existsSync(npmCmd) || fs.existsSync(npxCmd)) {
      // Read the npm.cmd to check if it points to the bundled node
      try {
        const content = fs.readFileSync(npmCmd, 'utf8');
        // User-level npm.cmd typically uses "%~dp0..\node.exe" which resolves
        // to something outside the bundled node tree. If the path in the script
        // points to our resources/node/ path, DON'T add it — it will break.
        if (!content.includes('resources' + path.sep + 'node')) {
          nodePathSegments.push(entry);
        }
      } catch {
        nodePathSegments.push(entry);
      }
    }
  }

  if (nodePathSegments.length === 0) return;

  // Prepend the user's npm/npx directory so npm and npx resolve correctly
  // even when PATH enrichment placed bundled node bin dir first.
  merged.unshift(...nodePathSegments.reverse());

  // Deduplicate: keep first occurrence, remove subsequent ones
  const seen = new Set<string>();
  let writeIdx = 0;
  for (let i = 0; i < merged.length; i++) {
    const normalized = process.platform === 'win32' ? merged[i].toLowerCase() : merged[i];
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged[writeIdx++] = merged[i];
    }
  }
  merged.length = writeIdx;

  log(
    `[ClaudeAgentRunner] Restored user npm/npx paths (${nodePathSegments.length} segments) before bundled node bin`
  );
}

/**
 * Resolve bundled Python bin directory path (if available).
 * Checks packaged and dev layouts, returns the bin dir containing python3.
 */
function resolveBundledPythonBinDir(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    if (platform === 'darwin') {
      candidates.push(path.join(projectRoot, 'resources', 'python', `darwin-${arch}`, 'bin'));
    }
    candidates.push(path.join(projectRoot, 'resources', 'python', 'bin'));
  } else {
    // Packaged layout: Resources/python/bin/python3
    candidates.push(path.join(process.resourcesPath, 'python', 'bin'));
  }

  const pythonExe = platform === 'win32' ? 'python.exe' : 'python3';
  for (const binDir of candidates) {
    if (fs.existsSync(path.join(binDir, pythonExe))) return binDir;
  }
  return null;
}

/**
 * Resolve bundled tools directory (ripgrep, cliclick, etc.).
 */
function resolveBundledToolsBinDir(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    if (process.platform === 'darwin') {
      candidates.push(path.join(projectRoot, 'resources', 'tools', `darwin-${arch}`, 'bin'));
    }
    if (process.platform === 'win32') {
      candidates.push(path.join(projectRoot, 'resources', 'tools', 'win32-x64', 'bin'));
    }
    candidates.push(path.join(projectRoot, 'resources', 'tools', 'bin'));
  } else {
    if (process.platform === 'darwin') {
      candidates.push(path.join(process.resourcesPath, 'tools', `darwin-${arch}`, 'bin'));
    }
    candidates.push(path.join(process.resourcesPath, 'tools', 'bin'));
  }

  for (const binDir of candidates) {
    if (fs.existsSync(binDir)) return binDir;
  }
  return null;
}

/**
 * One-time enrichment of process.env.PATH for runtime.
 *
 * In packaged mode, Electron often starts with a minimal PATH.
 * In dev mode, Electron usually inherits the user's shell PATH, but we still
 * prepend bundled tool directories so local runtime matches packaged behavior.
 *
 * This function:
 * 1. Restores the user's login-shell PATH when needed
 * 2. Prepends bundled Node, Python, and tools bin dirs (highest priority)
 * 3. Deduplicates all entries
 * 4. Writes the result back to `process.env.PATH`
 *
 * Called once before the first `createCodingTools()` — subsequent calls are no-ops.
 */
let pathEnriched = false;

async function enrichProcessPathForBuild(): Promise<void> {
  if (pathEnriched) return;
  pathEnriched = true;

  const platform = process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const currentPaths = (process.env.PATH || '').split(delimiter).filter((p: string) => p.trim());

  // 1. Restore user's login-shell PATH
  let shellPaths: string[] = [];
  if (platform === 'darwin' || platform === 'linux') {
    try {
      const shell = getDefaultShell();
      const output = (
        execFileSync(shell, ['-l', '-c', 'echo $PATH'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env, HOME: os.homedir() },
        }) as string
      ).trim();
      if (output) {
        shellPaths = output.split(':').filter((p: string) => p.trim());
        log(`[ClaudeAgentRunner] Restored ${shellPaths.length} paths from login shell`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[ClaudeAgentRunner] Could not restore shell PATH: ${message}`);
    }
  } else if (platform === 'win32') {
    try {
      shellPaths = getWindowsRegistryPathEntries();
      if (shellPaths.length > 0) {
        const shellRuntime = resolvePreferredWindowsShell();
        log(
          `[ClaudeAgentRunner] Restored ${shellPaths.length} paths from Windows registry via ${shellRuntime?.flavor || 'powershell'}`
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[ClaudeAgentRunner] Could not restore Windows PATH: ${message}`);
    }
  }

  // 2. Collect bundled bin directories (highest priority)
  const bundledDirs: string[] = [];

  const nodePaths = getBundledNodePaths();
  if (nodePaths) {
    bundledDirs.push(path.dirname(nodePaths.node));
  }

  const pythonBinDir = resolveBundledPythonBinDir();
  if (pythonBinDir) {
    bundledDirs.push(pythonBinDir);
  }

  const toolsBinDir = resolveBundledToolsBinDir();
  if (toolsBinDir) {
    bundledDirs.push(toolsBinDir);
  }

  // 3. Merge: bundled (highest) → shell → current process, deduplicate
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const p of [...bundledDirs, ...shellPaths, ...currentPaths]) {
    const normalized = platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(p);
    }
  }

  // On Windows, ensure user-level npm/npx paths come before the bundled node
  // bin dir so that `npm run` commands (which recursively invoke npm) work
  // correctly. The bundled node bin dir has node.exe + npx.cmd but no npm module.
  if (platform === 'win32') {
    restoreWindowsUserNodeModulesPaths(delimiter, merged);
  }

  process.env.PATH = merged.join(delimiter);
  log(
    `[ClaudeAgentRunner] Enriched process.env.PATH for runtime: ${bundledDirs.length} bundled + ${shellPaths.length} shell + ${currentPaths.length} process → ${merged.length} total${app.isPackaged ? ' (packaged)' : ' (dev)'}`
  );
}

// Shared pi-ai auth storage — created once, reused across sessions.

/**
 * Bridge MCP tools from MCPManager into pi-coding-agent ToolDefinition[] format.
 * Each MCP tool becomes a customTool whose execute() delegates to mcpManager.callTool().
 */
type PlanModeGuardedTool = ToolDefinition & {
  openCoworkPlanMode?: {
    mcpReadOnlyHint?: boolean;
  };
};

function buildMcpCustomTools(mcpManager: MCPManager): ToolDefinition[] {
  const mcpTools = mcpManager.getTools();
  return mcpTools.map((mcpTool) => {
    // Wrap the raw JSON Schema inputSchema as a TypeBox TSchema
    const parameters = Type.Unsafe<Record<string, unknown>>(
      mcpTool.inputSchema as Record<string, unknown>
    );

    const toolDef: PlanModeGuardedTool = {
      name: mcpTool.name,
      label: mcpTool.name.replace(/^mcp__/, '').replace(/__/g, ' → '),
      description: mcpTool.description || `MCP tool from ${mcpTool.serverName}`,
      parameters,
      openCoworkPlanMode: {
        mcpReadOnlyHint: mcpTool.annotations?.readOnlyHint === true,
      },
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const result = await mcpManager.callTool(mcpTool.name, params as Record<string, unknown>);
          const normalizedResult = normalizeMcpToolResultForModel(result);
          return {
            content: [{ type: 'text' as const, text: normalizedResult.text }],
            details:
              normalizedResult.images.length > 0
                ? { openCoworkImages: normalizedResult.images }
                : undefined,
          };
        } catch (err: unknown) {
          logError(`[ClaudeAgentRunner] MCP tool ${mcpTool.name} failed:`, err);
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
    };
    return toolDef;
  });
}

/**
 * Get shell environment with proper PATH (including node, npm, etc.)
 * GUI apps on macOS don't inherit shell PATH, so we need to extract it
 */

function safeStringify(value: unknown, space = 0): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return `[Unserializable: ${details}]`;
  }
}

function normalizeForStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'undefined') {
    return '[undefined]';
  }
  if (typeof value === 'function') {
    return `[Function:${value.name || 'anonymous'}]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeForStableJson(nestedValue, seen)]);
    seen.delete(value);
    return Object.fromEntries(entries);
  }
  return String(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function fingerprintText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintValue(value: unknown): string {
  return fingerprintText(stableStringify(value));
}

function pickUsageNumber(usage: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

interface CacheDiagnosticsPayload {
  version: 1;
  provider: string;
  modelId: string;
  sessionReuse: boolean;
  coldStart: boolean;
  historySerializationVersion: 'stable-v1';
  runtimeSignatureFingerprint: string;
  runtimeSignatureChangeReasons: string[];
  historyMessagesAvailable: number;
  historyMessagesInjected: number;
  historyMessagesOmitted: number;
  excludedCurrentTurnUser: boolean;
  historyCharBudget: number;
  historyPreambleFingerprint?: string;
  systemPromptFingerprint: string;
  toolsFingerprint: string;
  fullRequestPrefixFingerprint: string;
  cacheUsage?: Message['tokenUsage'];
}

function describeToolForFingerprint(
  tool:
    | ToolDefinition
    | { name?: string; type?: string; description?: string; parameters?: unknown }
): Record<string, unknown> {
  const typedTool = tool as {
    name?: string;
    type?: string;
    description?: string;
    parameters?: unknown;
  };
  return {
    name: typedTool.name || typedTool.type || 'unknown',
    description: typedTool.description || '',
    parametersFingerprint:
      typedTool.parameters !== undefined ? fingerprintValue(typedTool.parameters) : '',
  };
}

function summarizeMessageForLog(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') {
    return { present: false };
  }

  const typedMessage = message as {
    role?: unknown;
    stopReason?: unknown;
    content?: unknown[];
    usage?: unknown;
  };
  const content = Array.isArray(typedMessage.content) ? typedMessage.content : [];

  return {
    present: true,
    role: typeof typedMessage.role === 'string' ? typedMessage.role : undefined,
    stopReason: typedMessage.stopReason ?? undefined,
    contentBlocks: content.length,
    contentTypes: content.slice(0, 8).map((block) => {
      if (!block || typeof block !== 'object') {
        return typeof block;
      }
      const type = (block as { type?: unknown }).type;
      return typeof type === 'string' ? type : 'unknown';
    }),
    usage: normalizeTokenUsage(typedMessage.usage),
  };
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
  }
  const serialized = safeStringify(error);
  if (serialized.startsWith('[Unserializable:')) {
    return String(error);
  }
  return serialized;
}

function normalizeTokenUsage(usage: unknown): Message['tokenUsage'] | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const raw = usage as Record<string, unknown>;

  const input = pickUsageNumber(raw, ['input', 'input_tokens', 'inputTokens']);
  const output = pickUsageNumber(raw, ['output', 'output_tokens', 'outputTokens']);
  const cacheRead = pickUsageNumber(raw, [
    'cacheRead',
    'cache_read',
    'cache_read_tokens',
    'cache_read_input_tokens',
    'cacheReadTokens',
    'cacheReadInputTokens',
  ]);
  const cacheWrite = pickUsageNumber(raw, [
    'cacheWrite',
    'cache_write',
    'cache_write_tokens',
    'cache_creation_input_tokens',
    'cacheWriteTokens',
    'cacheWriteInputTokens',
    'cacheCreationInputTokens',
  ]);

  if (
    typeof input !== 'number' &&
    typeof output !== 'number' &&
    typeof cacheRead !== 'number' &&
    typeof cacheWrite !== 'number'
  ) {
    return undefined;
  }

  const normalized: Message['tokenUsage'] = {
    input: input ?? 0,
    output: output ?? 0,
  };
  if (typeof cacheRead === 'number') {
    normalized.cacheRead = cacheRead;
    normalized.cacheHit = cacheRead > 0;
  }
  if (typeof cacheWrite === 'number') {
    normalized.cacheWrite = cacheWrite;
    if (normalized.cacheHit === undefined) {
      normalized.cacheHit = false;
    }
  }

  return normalized;
}

export interface HistorySearchResult {
  messageId: string;
  role: 'user' | 'assistant';
  timestamp: number;
  /** Matched fragment: keyword + surrounding context, max ~300 chars */
  snippet: string;
  /** Turn index within the session (0-based) */
  turnIndex: number;
}

interface AgentRunnerOptions {
  sendToRenderer: (event: ServerEvent) => void;
  saveMessage?: (message: Message) => void;
  requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  /** Search the full message history of a session (bypasses compaction boundaries). */
  searchSessionMessages?: (
    sessionId: string,
    keywords: string[],
    maxResults?: number
  ) => HistorySearchResult[];
  getSessionPlanMode?: (sessionId: string) => boolean;
}

interface CachedPiSession {
  session: PiAgentSession;
  modelId: string;
  thinkingLevel: string;
  runtimeSignature: string;
  ollamaNumCtx?: { value: number };
}

/**
 * ClaudeAgentRunner - Uses @mariozechner/pi-coding-agent SDK
 *
 * Environment variables should be set before running:
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api
 *   ANTHROPIC_AUTH_TOKEN=your_openrouter_api_key
 *   ANTHROPIC_API_KEY="" (must be empty)
 */
export class ClaudeAgentRunner {
  private sendToRenderer: (event: ServerEvent) => void;
  private saveMessage?: (message: Message) => void;
  private requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  private searchSessionMessages?: (
    sessionId: string,
    keywords: string[],
    maxResults?: number
  ) => HistorySearchResult[];
  private getSessionPlanMode?: (sessionId: string) => boolean;
  private pathResolver: PathResolver;
  private mcpManager?: MCPManager;
  // @ts-expect-error stored for future plugin support
  private _pluginRuntimeService?: PluginRuntimeService;
  private _skillsAdapter?: SkillsAdapter;
  private backgroundTaskService?: BackgroundTaskService;
  private projectMemoryService = new ProjectMemoryService();
  private activeControllers: Map<string, AbortController> = new Map();
  private piSessions: Map<string, CachedPiSession> = new Map();
  private static readonly MAX_CACHED_SESSIONS = 50;

  // Per-instance caches — invalidated when the underlying config changes.
  private _mcpServersCache: { fingerprint: string; servers: Record<string, unknown> } | null = null;
  private _skillsSetupDone = false;

  /**
   * Clear SDK session cache for a session
   * Called when session's cwd changes - SDK sessions are bound to cwd
   */
  clearSdkSession(sessionId: string): void {
    const cached = this.piSessions.get(sessionId);
    if (cached) {
      try {
        cached.session.dispose();
      } catch (e) {
        logWarn('[ClaudeAgentRunner] dispose error:', e);
      }
      this.piSessions.delete(sessionId);
      log('[ClaudeAgentRunner] Disposed pi session for:', sessionId);
    }
  }

  /** Call after the user installs / removes a skill so the next query re-links everything. */
  invalidateSkillsSetup(): void {
    this._skillsSetupDone = false;
  }

  /** Call after the user changes MCP server config so the next query rebuilds mcpServers. */
  invalidateMcpServersCache(): void {
    this._mcpServersCache = null;
    // Sessions stay alive — MCP tools are rebuilt each query via buildMcpCustomTools()
    log('[ClaudeAgentRunner] MCP servers cache invalidated — tools will rebuild on next query');
  }

  // TODO: Credentials should be served via a secure MCP tool or IPC channel,
  // not injected as plaintext into the system prompt. The getCredentialsPrompt()
  // method was removed to eliminate credential leakage risk.

  /**
   * Generate bundled executable path hints for production mode system prompt.
   * In dev mode returns empty string (user PATH already works).
   * This is a defense-in-depth layer — even if PATH enrichment works, explicit
   * paths help the model avoid ambiguity when Skills reference bare commands.
   */
  private getBundledPathHints(): string {
    if (!app.isPackaged) return '';

    const hints: string[] = [];

    const nodePaths = getBundledNodePaths();
    if (nodePaths) {
      hints.push(`- node: ${nodePaths.node}`);
      hints.push(`- npx: ${nodePaths.npx}`);
    }

    const pythonBinDir = resolveBundledPythonBinDir();
    if (pythonBinDir) {
      const pythonExe = process.platform === 'win32' ? 'python.exe' : 'python3';
      const pipExe = process.platform === 'win32' ? 'pip.exe' : 'pip3';
      hints.push(`- python3: ${path.join(pythonBinDir, pythonExe)}`);
      if (fs.existsSync(path.join(pythonBinDir, pipExe))) {
        hints.push(`- pip3: ${path.join(pythonBinDir, pipExe)}`);
      }
    }

    const toolsBinDir = resolveBundledToolsBinDir();
    if (toolsBinDir) {
      const rgExe = process.platform === 'win32' ? 'rg.exe' : 'rg';
      const rgPath = path.join(toolsBinDir, rgExe);
      if (fs.existsSync(rgPath)) {
        hints.push(`- rg: ${rgPath}`);
      }
    }

    if (hints.length === 0) return '';

    return `<bundled_executables>
This application bundles its own executables. When executing commands, prefer these absolute paths:
${hints.join('\n')}
</bundled_executables>`;
  }

  /** Fallback skill path resolution when SkillsAdapter is not provided. */
  private legacySkillPaths(projectPath?: string): string[] {
    const paths: string[] = [];
    const builtin = resolveBuiltinSkillsPath({
      onFound: (skillsPath) => log('[ClaudeAgentRunner] Found built-in skills at:', skillsPath),
      onMissing: () => logWarn('[ClaudeAgentRunner] No built-in skills directory found'),
    });
    if (builtin && fs.existsSync(builtin)) paths.push(builtin);
    const global = getGlobalSkillsDir();
    if (fs.existsSync(global)) paths.push(global);

    // Project-level skills
    if (projectPath) {
      const dir = getProjectSkillsDir(projectPath);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        paths.push(dir);
      }
    }

    return paths;
  }

  private getBuiltinSkillsPath(): string {
    return resolveBuiltinSkillsPath({
      onFound: (skillsPath) => log('[ClaudeAgentRunner] Found built-in skills at:', skillsPath),
      onMissing: () => logWarn('[ClaudeAgentRunner] No built-in skills directory found'),
    });
  }

  constructor(
    options: AgentRunnerOptions,
    pathResolver: PathResolver,
    mcpManager?: MCPManager,
    pluginRuntimeService?: PluginRuntimeService,
    skillsAdapter?: SkillsAdapter,
    backgroundTaskService?: BackgroundTaskService
  ) {
    this.sendToRenderer = options.sendToRenderer;
    this.saveMessage = options.saveMessage;
    this.requestSudoPassword = options.requestSudoPassword;
    this.searchSessionMessages = options.searchSessionMessages;
    this.getSessionPlanMode = options.getSessionPlanMode;
    this.pathResolver = pathResolver;
    this.mcpManager = mcpManager;
    this._pluginRuntimeService = pluginRuntimeService;
    this._skillsAdapter = skillsAdapter;
    this.backgroundTaskService = backgroundTaskService;

    log('[ClaudeAgentRunner] Initialized with pi-coding-agent SDK');
    log('[ClaudeAgentRunner] Skills enabled: settingSources=[user, project], Skill tool enabled');
    if (mcpManager) {
      log('[ClaudeAgentRunner] MCP support enabled');
    }
  }

  /**
   * Check if a command contains sudo
   */
  private static isSudoCommand(command: string): boolean {
    return /\bsudo\b/.test(command);
  }

  /**
   * Decode HTML entities that LLMs commonly emit in tool-call arguments:
   *   &amp;  -> &
   *   &lt;   -> <
   *   &gt;   -> >
   *   &#39;  -> '
   *   &quot; -> "
   */
  private static decodeHtmlEntities(command: string): string {
    return command
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
  }

  private static hasBackgroundShellSyntax(command: string): boolean {
    const decoded = ClaudeAgentRunner.decodeHtmlEntities(command);
    const normalized = decoded.replace(/\r\n?/g, '\n');
    return (
      ClaudeAgentRunner.findShellBackgroundOperator(normalized) !== -1 ||
      /\bnohup\b/i.test(normalized) ||
      /\bdisown\b/i.test(normalized) ||
      /\bpm2\s+start\b/i.test(normalized) ||
      /\bstart\s+\/b\b/i.test(normalized) ||
      /\bstart-process\b/i.test(normalized)
    );
  }

  private static findShellBackgroundOperator(command: string): number {
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;

    for (let i = 0; i < command.length; i += 1) {
      const char = command[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (quote) {
        if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }

      if (char !== '&') {
        continue;
      }

      const previous = command[i - 1] || '';
      const next = command[i + 1] || '';
      if (previous === '&' || next === '&' || previous === '>' || next === '>') {
        continue;
      }

      return i;
    }

    return -1;
  }

  private static splitBackgroundCommand(command: string): {
    backgroundCommand: string;
    followupCommand: string | null;
  } | null {
    const decoded = ClaudeAgentRunner.decodeHtmlEntities(command);
    const normalized = decoded.replace(/\r\n?/g, '\n').trim();
    const ampIndex = ClaudeAgentRunner.findShellBackgroundOperator(normalized);
    if (ampIndex !== -1) {
      const backgroundCommand = normalized.slice(0, ampIndex).trim();
      const followupCommand = normalized.slice(ampIndex + 1).trim();
      if (backgroundCommand) {
        return {
          backgroundCommand,
          followupCommand: followupCommand || null,
        };
      }
    }
    // NOTE: A multiline fallback (first line ending with &) used to live here.
    // It's dead code — findShellBackgroundOperator always finds a trailing &
    // in any practical command, because & at end-of-line has next char=\n
    // (not & or >), so the scanner never skips it. Removed to avoid confusion.
    return null;
  }

  private static formatBashToolText(result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }): string {
    return [
      result.stdout ? `STDOUT:\n${result.stdout}` : '',
      result.stderr ? `STDERR:\n${result.stderr}` : '',
      `Exit code: ${result.exitCode}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private isSessionInPlanMode(sessionId: string): boolean {
    return this.getSessionPlanMode?.(sessionId) ?? false;
  }

  private static planModeDeniedToolResult(decision: PlanModeToolDecision) {
    return {
      content: [
        {
          type: 'text' as const,
          text: decision.reason || 'Plan mode is active. This tool call is not allowed.',
        },
      ],
      details: undefined as unknown,
    };
  }

  private wrapToolsWithPlanModeGuard(
    tools: ToolDefinition[],
    sessionId: string,
    effectiveCwd: string
  ): ToolDefinition[] {
    return tools.map((tool) => {
      const originalExecute = tool.execute;
      const guardMetadata = (tool as PlanModeGuardedTool).openCoworkPlanMode;
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const decision = isPlanModeToolAllowed({
            toolName: tool.name,
            params,
            cwd: effectiveCwd,
            sessionId,
            getPlanMode: (id) => this.isSessionInPlanMode(id),
            mcpReadOnlyHint: guardMetadata?.mcpReadOnlyHint,
          });
          if (!decision.allowed) {
            logCtx('[PlanModeGuard] Tool blocked:', tool.name, decision.reason || '');
            return ClaudeAgentRunner.planModeDeniedToolResult(decision);
          }
          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        },
      } as ToolDefinition;
    });
  }

  private wrapToolsWithResultLimit(
    tools: ToolDefinition[],
    sessionId: string,
    effectiveCwd: string
  ): ToolDefinition[] {
    return tools.map((tool) => {
      const originalExecute = tool.execute;
      if (!originalExecute) {
        return tool;
      }

      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
          const level = configStore.get('toolOutputCompressionLevel') ?? 'off';
          if (level === 'off') {
            return limitToolExecutionResultForModel(result);
          }

          const compressed = compressToolExecutionResultForModel(result, {
            toolName: tool.name || 'tool',
            params,
            level,
          });

          if (compressed.event) {
            try {
              recordToolOutputCompressionEvent(getDatabase(), {
                sessionId,
                projectPath: effectiveCwd,
                event: compressed.event,
              });
            } catch (error) {
              logCtxWarn('[ToolCompression] Failed to record compression stats:', error);
            }
          }

          return limitToolExecutionResultForModel(compressed.result);
        },
      } as ToolDefinition;
    });
  }

  private buildBackgroundTaskTool(
    sessionId: string,
    effectiveCwd: string
  ): ToolDefinition<TSchema, unknown>[] {
    if (!this.backgroundTaskService) {
      return [];
    }

    return [
      {
        name: 'execute_background_command',
        label: 'Execute Background Command',
        description:
          'Start a long-running local command in the background so it does not block the current workflow. Use this for dev servers, preview servers, Electron apps, and other persistent processes.',
        parameters: Type.Object({
          command: Type.String({
            description:
              'The shell command to run in the background, for example "npm run dev" or "python -m http.server 8000".',
          }),
          title: Type.Optional(
            Type.String({
              description: 'Optional short label shown in the background tasks panel.',
            })
          ),
          cwd: Type.Optional(
            Type.String({
              description:
                'Optional working directory. Defaults to the current session working directory.',
            })
          ),
          waitForPort: Type.Optional(
            Type.Number({
              description:
                'Optional local TCP port to wait for after starting the task. Use this when the workflow must confirm a dev server or API server is ready before continuing.',
            })
          ),
          waitTimeoutMs: Type.Optional(
            Type.Number({
              description: 'Optional timeout in milliseconds for waitForPort. Defaults to 10000.',
            })
          ),
        }),
        execute: async (_toolCallId, params) => {
          const typedParams = params as {
            command: string;
            title?: string;
            cwd?: string;
            waitForPort?: number;
            waitTimeoutMs?: number;
          };
          const task = await this.backgroundTaskService!.startTask({
            command: typedParams.command,
            title: typedParams.title,
            cwd: typedParams.cwd?.trim() || effectiveCwd,
            sourceSessionId: sessionId,
            waitForPort: typedParams.waitForPort,
            waitTimeoutMs: typedParams.waitTimeoutMs,
          });

          let readinessLine = 'Readiness: not requested';
          if (typedParams.waitForPort) {
            const ready = await this.backgroundTaskService!.waitForPort(
              task.id,
              typedParams.waitForPort,
              typedParams.waitTimeoutMs ?? 10000
            );
            readinessLine = ready
              ? `Readiness: port ${typedParams.waitForPort} is accepting connections`
              : `Readiness: timed out waiting for port ${typedParams.waitForPort}`;
          }

          const latestTask = this.backgroundTaskService!.getTask(task.id) || task;
          const logTail =
            typedParams.waitForPort && readinessLine.includes('timed out')
              ? this.backgroundTaskService!.getLogTail(task.id, 2000)
              : '';

          const lines = [
            `Background task started: ${latestTask.title}`,
            `Status: ${latestTask.status}`,
            `PID: ${latestTask.pid ?? 'unknown'}`,
            `Working directory: ${latestTask.cwd}`,
            `Log: ${latestTask.logPath}`,
            latestTask.detectedUrl
              ? `Detected URL: ${latestTask.detectedUrl}`
              : 'Detected URL: pending',
            readinessLine,
            'Use the sidebar Background Tasks panel to inspect logs or stop it later.',
          ];
          if (logTail) {
            lines.push('', 'Recent log tail:', logTail);
          }

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            details: undefined as unknown,
          };
        },
      } as ToolDefinition<TSchema, unknown>,
    ];
  }

  private replaceBashToolForWindows(
    tools: ToolDefinition[],
    sessionId: string,
    effectiveCwd: string,
    sanitizeOutputPaths?: (content: string) => string
  ): ToolDefinition[] {
    if (process.platform !== 'win32') {
      return tools;
    }

    const sanitize = sanitizeOutputPaths ?? ((content: string) => content);

    return tools.map((tool) => {
      if (tool.name !== 'bash') {
        return tool;
      }

      return {
        ...tool,
        execute: async (
          _toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined
        ) => {
          const decodedCommand = ClaudeAgentRunner.decodeHtmlEntities(params.command || '');
          const result = await executeWindowsBash({
            sessionId,
            command: decodedCommand,
            cwd: effectiveCwd,
            timeout: params.timeout,
            signal,
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: sanitize(ClaudeAgentRunner.formatBashToolText(result)),
              },
            ],
            details: undefined as unknown,
          };
        },
      } as ToolDefinition;
    });
  }

  private createWindowsBashOperations(sessionId: string): BashOperations {
    return {
      exec: async (
        command: string,
        cwd: string,
        options: {
          onData: (data: Buffer) => void;
          signal?: AbortSignal;
          timeout?: number;
          env?: NodeJS.ProcessEnv;
        }
      ) => {
        const rawCommand = ClaudeAgentRunner.decodeHtmlEntities(command || '');
        if (ClaudeAgentRunner.hasBackgroundShellSyntax(rawCommand)) {
          logCtx(
            '[BackgroundGuard] BashOperations intercepted background syntax:',
            rawCommand.substring(0, 120)
          );
          const split = ClaudeAgentRunner.splitBackgroundCommand(rawCommand);
          if (split && this.backgroundTaskService) {
            const task = await this.backgroundTaskService.startTask({
              command: split.backgroundCommand,
              cwd,
              sourceSessionId: sessionId,
            });
            const latestTask = this.backgroundTaskService.getTask(task.id) || task;
            const lines = [
              `Background task started: ${latestTask.title}`,
              `Status: ${latestTask.status}`,
              `PID: ${latestTask.pid ?? 'unknown'}`,
              `Working directory: ${latestTask.cwd}`,
              `Log: ${latestTask.logPath}`,
              latestTask.detectedUrl
                ? `Detected URL: ${latestTask.detectedUrl}`
                : 'Detected URL: pending',
              'Use the sidebar Background Tasks panel to inspect logs or stop it later.',
            ];
            options.onData(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));

            if (!split.followupCommand) {
              logCtx('[BackgroundGuard] BashOperations background task started');
              return { exitCode: 0 };
            }

            logCtx(
              '[BackgroundGuard] BashOperations running follow-up command:',
              split.followupCommand.substring(0, 120)
            );
            const followupResult = await executeWindowsBash({
              sessionId,
              command: split.followupCommand,
              cwd,
              timeout: options.timeout,
              signal: options.signal,
            });

            if (followupResult.stdout) {
              options.onData(Buffer.from(followupResult.stdout, 'utf8'));
            }
            if (followupResult.stderr) {
              options.onData(Buffer.from(followupResult.stderr, 'utf8'));
            }

            return { exitCode: followupResult.exitCode };
          }

          logCtx('[BackgroundGuard] BashOperations could not split background command');
          options.onData(
            Buffer.from(
              'This command contains background shell syntax. Use execute_background_command for long-running commands.\n',
              'utf8'
            )
          );
          return { exitCode: 1 };
        }

        const result = await executeWindowsBash({
          sessionId,
          command: rawCommand,
          cwd,
          timeout: options.timeout,
          signal: options.signal,
        });

        if (result.stdout) {
          options.onData(Buffer.from(result.stdout, 'utf8'));
        }
        if (result.stderr) {
          options.onData(Buffer.from(result.stderr, 'utf8'));
        }

        return { exitCode: result.exitCode };
      },
    };
  }

  /**
   * Wrap the bash tool in the coding tools array to intercept sudo commands.
   * When a sudo command is detected, prompts the user for a password,
   * then rewrites the command to pipe the password into sudo -S.
   */
  private wrapBashToolForSudo(
    tools: ToolDefinition[],
    sessionId: string,
    effectiveCwd: string,
    sanitizeOutputPaths?: (content: string) => string
  ): ToolDefinition[] {
    if (!this.requestSudoPassword) return tools;

    const requestSudoPassword = this.requestSudoPassword;
    const sanitize = sanitizeOutputPaths ?? ((content: string) => content);

    return tools.map((tool) => {
      if (tool.name !== 'bash') return tool;

      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const command = ClaudeAgentRunner.decodeHtmlEntities(params.command || '');

          if (ClaudeAgentRunner.isSudoCommand(command)) {
            log('[ClaudeAgentRunner] Sudo command detected, requesting password');
            const password = await requestSudoPassword(sessionId, toolCallId, command);

            if (!password) {
              log('[ClaudeAgentRunner] Sudo password cancelled by user');
              return {
                content: [
                  { type: 'text' as const, text: 'Command cancelled: user denied sudo password.' },
                ],
                details: undefined as unknown,
              };
            }

            // Add -S flag to sudo invocations that don't already have it
            const rewrittenCommand = command.replace(/\bsudo\b(?!\s+-S)/g, 'sudo -S');

            log(
              '[ClaudeAgentRunner] Executing sudo command with password injection (via stdin pipe)'
            );
            try {
              if (process.platform === 'win32') {
                const result = await executeWindowsBash({
                  sessionId,
                  command: rewrittenCommand,
                  cwd: effectiveCwd,
                  timeout: params.timeout,
                  signal,
                  stdin: `${password}\n`,
                });
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: sanitize(ClaudeAgentRunner.formatBashToolText(result)),
                    },
                  ],
                  details: undefined as unknown,
                };
              }

              const timeoutMs = (params.timeout ?? 120) * 1000;
              const output = await new Promise<string>((resolve, reject) => {
                const child = spawn('/bin/sh', ['-c', rewrittenCommand], {
                  stdio: ['pipe', 'pipe', 'pipe'],
                  cwd: effectiveCwd,
                });
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => {
                  child.kill('SIGKILL');
                  reject(new Error(`Sudo command timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                child.stdout.on('data', (chunk: Buffer) => {
                  stdout += chunk.toString();
                });
                child.stderr.on('data', (chunk: Buffer) => {
                  stderr += chunk.toString();
                });
                child.on('error', (err) => {
                  clearTimeout(timer);
                  reject(err);
                });
                child.on('close', () => {
                  clearTimeout(timer);
                  resolve(stdout + stderr);
                });
                child.stdin.write(password + '\n');
                child.stdin.end();
              });
              return {
                content: [{ type: 'text' as const, text: output || '(no output)' }],
                details: undefined as unknown,
              };
            } catch (sudoErr) {
              logError('[ClaudeAgentRunner] Sudo command failed:', sudoErr);
              throw sudoErr instanceof Error ? sudoErr : new Error(String(sudoErr));
            }
          }

          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        },
      } as ToolDefinition;
    });
  }

  /**
   * Wrap the bash tool to inject a default timeout when the model omits one.
   * The pi-coding-agent SDK's bash tool has no default timeout, which means
   * commands can run indefinitely if the model doesn't specify a timeout.
   */
  private static wrapBashToolWithDefaultTimeout(tools: ToolDefinition[]): ToolDefinition[] {
    const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

    return tools.map((tool) => {
      if (tool.name !== 'bash') return tool;

      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const effectiveParams =
            params.timeout != null ? params : { ...params, timeout: DEFAULT_BASH_TIMEOUT_SECONDS };
          return originalExecute(toolCallId, effectiveParams, signal, onUpdate, ctx);
        },
      } as ToolDefinition;
    });
  }

  private wrapBashToolForBackgroundSyntax(
    tools: ToolDefinition[],
    sessionId: string,
    effectiveCwd: string
  ): ToolDefinition[] {
    const backgroundTaskService = this.backgroundTaskService;
    return tools.map((tool) => {
      if (tool.name !== 'bash' && tool.name !== 'pwsh') return tool;

      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined,
          onUpdate: ((update: unknown) => void) | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx: any
        ) => {
          const rawCommand = ClaudeAgentRunner.decodeHtmlEntities(params.command || '');
          if (ClaudeAgentRunner.hasBackgroundShellSyntax(rawCommand)) {
            const split = ClaudeAgentRunner.splitBackgroundCommand(rawCommand);
            if (split && backgroundTaskService) {
              logCtx(
                '[BackgroundGuard] Starting background task directly for:',
                split.backgroundCommand.substring(0, 80)
              );
              try {
                const task = await backgroundTaskService.startTask({
                  command: split.backgroundCommand,
                  cwd: effectiveCwd,
                  sourceSessionId: sessionId,
                });

                const latestTask = backgroundTaskService.getTask(task.id) || task;
                const lines = [
                  `Background task started: ${latestTask.title}`,
                  `Status: ${latestTask.status}`,
                  `PID: ${latestTask.pid ?? 'unknown'}`,
                  `Working directory: ${latestTask.cwd}`,
                  `Log: ${latestTask.logPath}`,
                  latestTask.detectedUrl
                    ? `Detected URL: ${latestTask.detectedUrl}`
                    : 'Detected URL: pending',
                  'Use the sidebar Background Tasks panel to inspect logs or stop it later.',
                ];

                const backgroundResult = {
                  content: [{ type: 'text' as const, text: lines.join('\n') }],
                  details: undefined as unknown,
                };

                if (!split.followupCommand) {
                  logCtx('[BackgroundGuard] Background task started successfully');
                  return backgroundResult;
                }

                const followupResult = await originalExecute(
                  toolCallId,
                  { ...params, command: split.followupCommand },
                  signal,
                  onUpdate,
                  ctx
                );

                const backgroundText = backgroundResult.content
                  .map((item) => item.text || '')
                  .filter(Boolean)
                  .join('\n');
                const followupText = Array.isArray(
                  (followupResult as { content?: Array<{ text?: string }> }).content
                )
                  ? (followupResult as { content: Array<{ text?: string }> }).content
                      .map((item) => item.text || '')
                      .filter(Boolean)
                      .join('\n')
                  : '';

                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: [backgroundText, followupText].filter(Boolean).join('\n\n'),
                    },
                  ],
                  details: undefined as unknown,
                };
              } catch (error) {
                logCtx('[BackgroundGuard] Background task start failed:', error);
                throw error;
              }
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'This command contains background shell syntax (for example &, nohup, disown, pm2, or Start-Process). Do not run it through the normal synchronous bash tool. Use execute_background_command instead, and if the workflow depends on readiness, pass waitForPort so the command runs in the background while the workflow waits only for the service to become ready.',
                },
              ],
              details: undefined as unknown,
            };
          }

          return originalExecute(toolCallId, params, signal, onUpdate, ctx);
        },
      } as ToolDefinition;
    });
  }

  /**
   * Resolve current model string from runtime config.
   */
  private getCurrentModelString(preferredModel?: string): string {
    const routeModel = preferredModel?.trim();
    const configuredModel = configStore.get('model')?.trim();
    const model = routeModel || configuredModel || 'anthropic/claude-sonnet-4-6';
    logCtx('[ClaudeAgentRunner] Current model:', model);
    logCtx(
      '[ClaudeAgentRunner] Model source:',
      routeModel ? 'runtimeRoute.model' : configuredModel ? 'configStore.model' : 'default'
    );
    return model;
  }

  async run(session: Session, prompt: string, existingMessages: Message[]): Promise<void> {
    const runStartTime = Date.now();
    logCtx('[ClaudeAgentRunner] run() started');

    const controller = new AbortController();
    try {
      // SDK 会在同一 AbortSignal 上挂载较多监听器，放开上限避免无意义告警干扰排错。
      setMaxListeners(0, controller.signal);
    } catch {
      // 旧运行时不支持 EventTarget 调整监听上限时忽略即可。
    }
    this.activeControllers.set(session.id, controller);

    // Sandbox isolation state (defined outside try for finally access)
    let sandboxPath: string | null = null;
    let useSandboxIsolation = false;

    // Helper to convert real sandbox paths back to virtual workspace paths in output
    // Cache the compiled regex to avoid recompilation on every call
    let sandboxPathRegex: RegExp | null = null;
    const sanitizeOutputPaths = (content: string): string => {
      if (!sandboxPath || !useSandboxIsolation) return content;
      if (!sandboxPathRegex) {
        sandboxPathRegex = new RegExp(sandboxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      }
      // Replace real sandbox path with virtual workspace path
      return content.replace(sandboxPathRegex, VIRTUAL_WORKSPACE_PATH);
    };

    const thinkingStepId = uuidv4();
    let abortedByTimeout = false;

    try {
      this.pathResolver.registerSession(session.id, session.mountedPaths);
      logTiming('pathResolver.registerSession', runStartTime);

      // Note: User message is now added by the frontend immediately for better UX
      // No need to send it again from backend

      // Send initial thinking trace
      this.sendTraceStep(session.id, {
        id: thinkingStepId,
        type: 'thinking',
        status: 'running',
        title: 'Processing request...',
        timestamp: Date.now(),
      });
      logTiming('sendTraceStep (thinking)', runStartTime);

      // Use session's cwd - each session has its own working directory
      const workingDir = session.cwd || undefined;
      logCtx('[ClaudeAgentRunner] Working directory:', workingDir || '(none)');

      // Initialize sandbox sync if WSL mode is active
      const sandbox = getSandboxAdapter();

      if (sandbox.isWSL && sandbox.wslStatus?.distro && workingDir) {
        log('[ClaudeAgentRunner] WSL mode active, initializing sandbox sync...');

        // Only show sync UI for new sessions (first message)
        const isNewSession = !SandboxSync.hasSession(session.id);

        if (isNewSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated WSL environment',
            },
          });
        }

        const syncResult = await SandboxSync.initSync(
          workingDir,
          session.id,
          sandbox.wslStatus.distro
        );

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[ClaudeAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(
            `[ClaudeAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`
          );

          if (isNewSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'syncing_skills',
                message: 'Configuring skills...',
                detail: 'Copying built-in skills to sandbox',
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.getBuiltinSkillsPath();
          try {
            const distro = sandbox.wslStatus!.distro!;
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            execFileSync('wsl', ['-d', distro, '-e', 'mkdir', '-p', sandboxSkillsPath], {
              encoding: 'utf-8',
              timeout: 10000,
            });

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync via execFileSync with array args to avoid shell injection
              const wslSourcePath = pathConverter.toWSL(builtinSkillsPath);
              log(
                `[ClaudeAgentRunner] Copying skills with rsync: ${wslSourcePath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'wsl',
                ['-d', distro, '-e', 'rsync', '-av', wslSourcePath + '/', sandboxSkillsPath + '/'],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            const appSkillsDir = getGlobalSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }

            if (fs.existsSync(appSkillsDir)) {
              const wslSourcePath = pathConverter.toWSL(appSkillsDir);
              log(
                `[ClaudeAgentRunner] Copying app skills with rsync: ${wslSourcePath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'wsl',
                ['-d', distro, '-e', 'rsync', '-avL', wslSourcePath + '/', sandboxSkillsPath + '/'],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            // List copied skills for verification
            const copiedSkills = execFileSync(
              'wsl',
              ['-d', distro, '-e', 'ls', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean);

            log(`[ClaudeAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[ClaudeAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to copy skills to sandbox:', error);
          }

          if (isNewSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'ready',
                message: 'Sandbox ready',
                detail: `Synced ${syncResult.fileCount} files`,
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }
        } else {
          logError('[ClaudeAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[ClaudeAgentRunner] Falling back to /mnt/ access (less secure)');

          if (isNewSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'error',
                message: 'Sandbox file sync failed, falling back to direct access mode',
                detail: 'Falling back to direct access mode (less secure)',
              },
            });
          }
        }
      }

      // Initialize sandbox sync if Lima mode is active
      if (sandbox.isLima && sandbox.limaStatus?.instanceRunning && workingDir) {
        log('[ClaudeAgentRunner] Lima mode active, initializing sandbox sync...');

        const { LimaSync } = await import('../sandbox/lima-sync');

        // Only show sync UI for new sessions (first message)
        const isNewLimaSession = !LimaSync.hasSession(session.id);

        if (isNewLimaSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated Lima environment',
            },
          });
        }

        const syncResult = await LimaSync.initSync(workingDir, session.id);

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[ClaudeAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(
            `[ClaudeAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`
          );

          if (isNewLimaSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'syncing_skills',
                message: 'Configuring skills...',
                detail: 'Copying built-in skills to sandbox',
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.getBuiltinSkillsPath();
          try {
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            execFileSync(
              'limactl',
              ['shell', 'claude-sandbox', '--', 'mkdir', '-p', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            );

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync via execFileSync with array args to avoid shell injection
              // Lima mounts /Users directly, so paths are the same
              log(
                `[ClaudeAgentRunner] Copying skills with rsync: ${builtinSkillsPath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'limactl',
                [
                  'shell',
                  'claude-sandbox',
                  '--',
                  'rsync',
                  '-av',
                  builtinSkillsPath + '/',
                  sandboxSkillsPath + '/',
                ],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            const appSkillsDir = getGlobalSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }

            if (fs.existsSync(appSkillsDir)) {
              log(
                `[ClaudeAgentRunner] Copying app skills with rsync: ${appSkillsDir}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'limactl',
                [
                  'shell',
                  'claude-sandbox',
                  '--',
                  'rsync',
                  '-avL',
                  appSkillsDir + '/',
                  sandboxSkillsPath + '/',
                ],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            // List copied skills for verification
            const copiedSkills = execFileSync(
              'limactl',
              ['shell', 'claude-sandbox', '--', 'ls', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean);

            log(`[ClaudeAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[ClaudeAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to copy skills to sandbox:', error);
          }

          if (isNewLimaSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'ready',
                message: 'Sandbox ready',
                detail: `Synced ${syncResult.fileCount} files`,
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }
        } else {
          logError('[ClaudeAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[ClaudeAgentRunner] Falling back to direct access (less secure)');

          if (isNewLimaSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'error',
                message: 'Sandbox file sync failed, falling back to direct access mode',
                detail: 'Falling back to direct access mode (less secure)',
              },
            });
          }
        }
      }

      // Check if current user message includes images
      const lastUserMessage =
        existingMessages.length > 0 ? existingMessages[existingMessages.length - 1] : null;

      logCtx('[ClaudeAgentRunner] Total messages:', existingMessages.length);

      const hasImages =
        lastUserMessage?.content.some((c) => (c as { type?: string }).type === 'image') || false;
      let piImages: PiImageContent[] | undefined;
      if (hasImages && lastUserMessage) {
        const rawImages = lastUserMessage.content.filter(
          (c) => (c as { type?: string }).type === 'image'
        ) as Array<{
          type: 'image';
          source: { type: string; media_type: string; data: string };
        }>;
        piImages = rawImages.map((img) => ({
          type: 'image' as const,
          data: img.source.data,
          mimeType: img.source.media_type || 'image/png',
        }));
        log(`[ClaudeAgentRunner] Extracted ${piImages.length} image(s) for pi-ai prompt`);
      }

      logTiming('before pi-ai model resolution', runStartTime);

      // Resolve model via pi-ai
      const runtimeConfig = configStore.getAll();
      const modelString = this.getCurrentModelString(runtimeConfig.model);
      const configProtocol = resolvePiRouteProtocol(
        runtimeConfig.provider,
        runtimeConfig.customProtocol
      );

      // Normalize base URL for OpenAI-compatible providers (strips copy-pasted endpoint suffixes)
      const rawBaseUrl = runtimeConfig.baseUrl?.trim() || undefined;
      const effectiveBaseUrl =
        configProtocol === 'openai' && runtimeConfig.provider !== 'ollama'
          ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
          : rawBaseUrl;

      let usedSyntheticModel = false;
      let piModel = resolvePiRegistryModel(modelString, {
        configProvider: configProtocol,
        customBaseUrl: effectiveBaseUrl,
        rawProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
      });

      if (!piModel) {
        usedSyntheticModel = true;
        // Synthetic fallback: construct a Model for unknown/custom models
        const synthetic = resolveSyntheticPiModelFallback({
          rawModel: runtimeConfig.model,
          resolvedModelString: modelString,
          rawProvider: runtimeConfig.provider,
          routeProtocol: configProtocol,
          baseUrl: effectiveBaseUrl,
        });
        piModel = buildSyntheticPiModel(
          synthetic.modelId,
          synthetic.provider,
          configProtocol,
          effectiveBaseUrl,
          undefined,
          undefined,
          runtimeConfig.contextWindow,
          runtimeConfig.maxTokens
        );
        // Apply the same runtime overrides (developer role compat, base URL, API downgrade)
        // that resolvePiRegistryModel applies to registry models
        piModel = applyPiModelRuntimeOverrides(piModel, {
          configProvider: configProtocol,
          customBaseUrl: effectiveBaseUrl,
          rawProvider: runtimeConfig.provider,
          customProtocol: runtimeConfig.customProtocol,
        });
        logCtxWarn(
          '[ClaudeAgentRunner] Model not in pi-ai registry, using synthetic model:',
          modelString,
          '→',
          piModel.api
        );
      }
      logCtx('[ClaudeAgentRunner] Resolved pi-ai model:', piModel.provider, piModel.id);

      // For Ollama: query actual context window from /api/show if user hasn't configured one
      const provider = runtimeConfig.provider || 'anthropic';
      if (provider === 'ollama' && !runtimeConfig.contextWindow) {
        const ollamaBaseUrl =
          piModel.baseUrl || runtimeConfig.baseUrl || 'http://localhost:11434/v1';
        const ollamaInfo = await fetchOllamaModelInfo({
          baseUrl: ollamaBaseUrl,
          model: piModel.id,
          apiKey: runtimeConfig.apiKey,
        });
        if (ollamaInfo.contextWindow) {
          log(
            '[ClaudeAgentRunner] Ollama /api/show reported contextWindow:',
            ollamaInfo.contextWindow,
            '(was:',
            piModel.contextWindow,
            ')'
          );
          piModel = { ...piModel, contextWindow: ollamaInfo.contextWindow };
        }
      }

      if (runtimeConfig.contextWindow && runtimeConfig.contextWindow > 0) {
        logCtx(
          '[ClaudeAgentRunner] Applying configured contextWindow override:',
          runtimeConfig.contextWindow,
          '(registry:',
          piModel.contextWindow,
          ')'
        );
        piModel = { ...piModel, contextWindow: runtimeConfig.contextWindow };
      }
      if (runtimeConfig.maxTokens && runtimeConfig.maxTokens > 0) {
        piModel = { ...piModel, maxTokens: runtimeConfig.maxTokens };
      }

      // Send context window info to renderer for UI display
      this.sendToRenderer({
        type: 'session.contextInfo',
        payload: {
          sessionId: session.id,
          contextWindow: piModel.contextWindow || 128000,
        },
      });

      // Set up API keys via AuthStorage
      const authStorage = getSharedAuthStorage();
      const apiKey = runtimeConfig.apiKey?.trim();
      if (apiKey) {
        // Map our config provider to pi-ai provider name
        const piProvider =
          provider === 'custom' ? runtimeConfig.customProtocol || 'anthropic' : provider;
        authStorage.setRuntimeApiKey(piProvider, apiKey);
        // Also set the key for the model's native provider (e.g., when using
        // google/gemini via openrouter, pi-ai looks up "google" not "openrouter")
        if (piModel.provider !== piProvider) {
          authStorage.setRuntimeApiKey(piModel.provider, apiKey);
          log('[ClaudeAgentRunner] Set runtime API key for model provider:', piModel.provider);
        }
        log('[ClaudeAgentRunner] Set runtime API key for config provider:', piProvider);
      } else {
        if (provider === 'ollama') {
          log(
            '[ClaudeAgentRunner] Ollama configured without explicit API key; relying on OpenAI-compatible placeholder/env auth path',
            safeStringify({
              provider,
              modelProvider: piModel.provider,
              modelId: piModel.id,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
            })
          );
        } else {
          logWarn('[ClaudeAgentRunner] No API key configured for provider:', provider);
        }
      }

      // baseUrl is now embedded in the model object via resolvePiModel()
      logCtx('[ClaudeAgentRunner] Model baseUrl:', piModel.baseUrl, 'api:', piModel.api);

      logTiming('after pi-ai model resolution', runStartTime);

      // pi-coding-agent handles path sandboxing via its own tools
      const imageCapable = true; // pi-ai models generally support images; let the model handle unsupported cases
      const effectiveCwd =
        useSandboxIsolation && sandboxPath ? sandboxPath : workingDir || process.cwd();

      // Skills directory setup: only run on the first query per runner instance.
      // Symlinks and directories are stable across queries; re-running every time
      // wastes ~10-30 syscalls per query for no benefit. Call invalidateSkillsSetup()
      // to force a re-run after the user installs or removes a skill.
      if (!this._skillsSetupDone) {
        // Set flag at start to prevent re-entrant calls from concurrent queries
        this._skillsSetupDone = true;

        // Ensure global skills directory exists
        const appSkillsDir = getGlobalSkillsDir();
        if (!fs.existsSync(appSkillsDir)) {
          fs.mkdirSync(appSkillsDir, { recursive: true });
        }

        // Built-in skills remain in the bundled read-only directory and are
        // passed separately via additionalSkillPaths.
      }

      // Build available skills section dynamically — now handled by pi's DefaultResourceLoader
      // via additionalSkillPaths. No custom prompt building needed.

      log('[ClaudeAgentRunner] Skills dir:', getGlobalSkillsDir());
      log('[ClaudeAgentRunner] User working directory:', workingDir);

      logTiming('before building conversation context', runStartTime);

      // pi-ai handles auth and model routing natively — no proxy, no env overrides needed.
      logCtx('[ClaudeAgentRunner] Using pi-ai native routing for:', piModel.provider, piModel.id);

      // Resolve thinking level early — needed for session reuse check below
      const enableThinking = configStore.get('enableThinking') ?? false;
      logCtx('[ClaudeAgentRunner] Enable thinking mode:', enableThinking);
      type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      const thinkingLevel: PiThinkingLevel = enableThinking ? 'medium' : 'off';
      const sessionRuntimeSignature = buildPiSessionRuntimeSignature({
        configProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
        modelProvider: piModel.provider,
        modelApi: piModel.api,
        modelBaseUrl: piModel.baseUrl,
        contextWindow: piModel.contextWindow,
        maxTokens: piModel.maxTokens,
        effectiveCwd,
        apiKey,
      });

      // Build contextual prompt — if reusing an existing SDK session, the SDK
      // already has conversation history so we only pass the new prompt.
      // For cold starts (new SDK session with existing DB history), we inject
      // a token-budgeted summary of recent history as a preamble.
      let cachedSession = this.piSessions.get(session.id);
      let runtimeSignatureChangeReasons: string[] = [];
      if (cachedSession && cachedSession.runtimeSignature !== sessionRuntimeSignature) {
        runtimeSignatureChangeReasons = diffPiSessionRuntimeSignatures(
          cachedSession.runtimeSignature,
          sessionRuntimeSignature
        );
        logCtx('[ClaudeAgentRunner] Runtime changed, recreating cached pi session:', session.id);
        logCtx(
          '[ClaudeAgentRunner] Runtime signature change reasons:',
          runtimeSignatureChangeReasons.join(', ') || '(unknown)'
        );
        try {
          cachedSession.session.dispose();
        } catch (disposeError) {
          logWarn('[ClaudeAgentRunner] dispose error while recreating pi session:', disposeError);
        }
        this.piSessions.delete(session.id);
        cachedSession = undefined;
      }
      if (cachedSession && cachedSession.thinkingLevel !== thinkingLevel) {
        runtimeSignatureChangeReasons = [
          ...runtimeSignatureChangeReasons,
          `thinking:${cachedSession.thinkingLevel}->${thinkingLevel}`,
        ];
        logCtx(
          '[ClaudeAgentRunner] Thinking level changed, recreating cached pi session:',
          cachedSession.thinkingLevel,
          '→',
          thinkingLevel
        );
        try {
          cachedSession.session.dispose();
        } catch (disposeError) {
          logWarn(
            '[ClaudeAgentRunner] dispose error while recreating pi session for thinking change:',
            disposeError
          );
        }
        this.piSessions.delete(session.id);
        cachedSession = undefined;
      }
      let contextualPrompt = prompt;
      let historyPreamble = '';
      let historyMessagesAvailable = 0;
      let historyMessagesInjected = 0;
      let historyMessagesOmitted = 0;
      let excludedCurrentTurnUser = false;
      let historyCharBudget = 0;
      if (!cachedSession) {
        // Cold start: inject recent history into prompt if available
        const conversationMessages = existingMessages.filter(
          (msg) => msg.role === 'user' || msg.role === 'assistant'
        );
        // Filter out messages that contain images (images can't be serialized into text preamble)
        const textOnlyMessages = conversationMessages.filter(
          (msg) => !msg.content.some((c) => (c as { type?: string }).type === 'image')
        );
        if (textOnlyMessages.length > 0) {
          const contextWindow = piModel.contextWindow || 128000;
          const historyBuild = buildStableConversationHistoryPreamble({
            messages: textOnlyMessages,
            provider,
            contextWindow,
          });

          historyMessagesAvailable = historyBuild.availableMessages;
          historyMessagesInjected = historyBuild.injectedMessages;
          historyMessagesOmitted = historyBuild.omittedMessages;
          excludedCurrentTurnUser = historyBuild.excludedCurrentTurnUser;
          historyCharBudget = historyBuild.historyCharBudget;

          if (historyBuild.preamble) {
            historyPreamble = historyBuild.preamble;
            contextualPrompt = `${historyPreamble}\n\n${prompt}`;
            log(
              '[ClaudeAgentRunner] Cold start: injecting stable history preamble',
              safeStringify({
                injectedMessages: historyMessagesInjected,
                availableMessages: historyMessagesAvailable,
                omittedMessages: historyMessagesOmitted,
                excludedCurrentTurnUser,
                historyCharBudget,
                contextWindow,
              })
            );
          }
        }
      } else {
        // Reusing session — SDK already has the full conversation context
        logCtx('[ClaudeAgentRunner] Reusing existing SDK session for:', session.id);
      }

      if (session.planMode) {
        contextualPrompt = `${buildPlanModeRuntimePrompt({ sessionId: session.id, cwd: effectiveCwd })}\n\n${contextualPrompt}`;
      }

      logTiming('before building MCP servers config', runStartTime);

      // Build MCP servers configuration for SDK
      // IMPORTANT: SDK uses tool names in format: mcp__<ServerKey>__<toolName>
      const mcpServers: Record<string, unknown> = {};
      if (this.mcpManager) {
        const serverStatuses = this.mcpManager.getServerStatus();
        const connectedServers = serverStatuses.filter((s) => s.connected);
        log('[ClaudeAgentRunner] MCP server statuses:', safeStringify(serverStatuses));
        log('[ClaudeAgentRunner] Connected MCP servers:', connectedServers.length);

        let allConfigs: ReturnType<typeof mcpConfigStore.getEnabledServers> = [];
        try {
          allConfigs = mcpConfigStore.getEnabledServers();
          log(
            '[ClaudeAgentRunner] Enabled MCP configs:',
            allConfigs.map((c) => c.name)
          );
        } catch (error) {
          logWarn(
            '[ClaudeAgentRunner] Failed to read enabled MCP configs; MCP tools will be unavailable this query',
            error
          );
          allConfigs = [];
        }

        // Cache key: serialized config list + imageCapable flag.  The bundled node
        // paths are stable for the lifetime of the process so they don't need to be
        // part of the fingerprint.
        const mcpFingerprint = JSON.stringify(allConfigs) + String(imageCapable);
        if (this._mcpServersCache?.fingerprint === mcpFingerprint) {
          Object.assign(mcpServers, this._mcpServersCache.servers);
          log('[ClaudeAgentRunner] MCP servers config reused from cache');
        } else {
          // Use the module-level memoized helper — no more per-query fs.existsSync calls.
          const bundledNodePaths = getBundledNodePaths();
          const bundledNpx = bundledNodePaths?.npx ?? null;

          for (const config of allConfigs) {
            try {
              // Use a simpler key without spaces to avoid issues
              const serverKey = config.name;

              if (config.type === 'stdio') {
                // 当命令是 npx 或 node 时优先使用内置路径
                const command =
                  config.command === 'npx' && bundledNpx
                    ? bundledNpx
                    : config.command === 'node' && bundledNodePaths
                      ? bundledNodePaths.node
                      : config.command;

                // 使用内置 npx/node 时，将内置 node bin 注入 PATH
                const serverEnv = { ...config.env };
                if (bundledNodePaths && (config.command === 'npx' || config.command === 'node')) {
                  const nodeBinDir = path.dirname(bundledNodePaths.node);
                  const currentPath = process.env.PATH || '';
                  // Prepend bundled node bin to PATH so npx can find node
                  serverEnv.PATH = `${nodeBinDir}${path.delimiter}${currentPath}`;
                  log(`[ClaudeAgentRunner]   Added bundled node bin to PATH: ${nodeBinDir}`);
                }

                if (!imageCapable) {
                  serverEnv.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT = '1';
                }

                // Resolve path placeholders for presets
                let resolvedArgs = config.args || [];

                // Check if any args contain placeholders that need resolving
                const hasPlaceholders = resolvedArgs.some(
                  (arg) =>
                    arg.includes('{SOFTWARE_DEV_SERVER_PATH}') ||
                    arg.includes('{GUI_OPERATE_SERVER_PATH}')
                );

                if (hasPlaceholders) {
                  // Get the appropriate preset based on config name
                  let presetKey: string | null = null;
                  if (
                    config.name === 'Software_Development' ||
                    config.name === 'Software Development'
                  ) {
                    presetKey = 'software-development';
                  } else if (config.name === 'GUI_Operate' || config.name === 'GUI Operate') {
                    presetKey = 'gui-operate';
                  }

                  if (presetKey) {
                    const preset = mcpConfigStore.createFromPreset(presetKey, true);
                    if (preset && preset.args) {
                      resolvedArgs = preset.args;
                    }
                  }
                }

                mcpServers[serverKey] = {
                  type: 'stdio',
                  command,
                  args: resolvedArgs,
                  env: serverEnv,
                };
                log(`[ClaudeAgentRunner] Added STDIO MCP server: ${serverKey}`);
                log(`[ClaudeAgentRunner]   Command: ${command} ${resolvedArgs.join(' ')}`);
                log(`[ClaudeAgentRunner]   Tools will be named: mcp__${serverKey}__<toolName>`);
              } else if (config.type === 'sse') {
                mcpServers[serverKey] = {
                  type: 'sse',
                  url: config.url,
                  headers: config.headers || {},
                };
                log(`[ClaudeAgentRunner] Added SSE MCP server: ${serverKey}`);
              }
            } catch (error) {
              logError('[ClaudeAgentRunner] Failed to prepare MCP server config, skipping server', {
                serverId: config.id,
                serverName: config.name,
                error: toErrorText(error),
              });
            }
          }

          // Store in cache for subsequent queries
          this._mcpServersCache = { fingerprint: mcpFingerprint, servers: { ...mcpServers } };
        }

        const mcpServersSummary = Object.entries(mcpServers).map(([name, serverConfig]) => {
          const typedServerConfig = serverConfig as {
            type?: string;
            command?: string;
            args?: unknown[];
            env?: Record<string, unknown>;
          };
          return {
            name,
            type: typedServerConfig.type ?? 'unknown',
            command: typedServerConfig.command ?? '',
            argsCount: Array.isArray(typedServerConfig.args) ? typedServerConfig.args.length : 0,
            envKeys: typedServerConfig.env ? Object.keys(typedServerConfig.env).length : 0,
          };
        });
        log('[ClaudeAgentRunner] Final mcpServers summary:', safeStringify(mcpServersSummary, 2));
        if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
          log('[ClaudeAgentRunner] Final mcpServers config:', safeStringify(mcpServers, 2));
        }
      }
      logTiming('after building MCP servers config', runStartTime);

      const workspaceInfoPrompt = buildWorkspaceInfoPrompt({
        isSandboxed: Boolean(useSandboxIsolation && sandboxPath),
        workingDir,
      });

      const projectMemoryMaterial = workingDir
        ? this.projectMemoryService.buildPromptMaterial(workingDir, prompt)
        : null;

      const uiLanguage = configStore.get('language') ?? 'zh';
      const visibleLanguage = uiLanguage === 'zh' ? 'Chinese (中文)' : 'English';
      const coworkAppendPrompt = buildOpenCoworkAppendPrompt({
        visibleLanguage,
        workspaceInfoPrompt,
        autoMemoryEnabled: Boolean(configStore.get('autoMemory')),
        projectMemorySections: projectMemoryMaterial?.promptSections,
        bundledPathHints: this.getBundledPathHints(),
      });

      logTiming('before pi-coding-agent session creation', runStartTime);

      // Create or reuse pi-coding-agent session

      // Collect skill directories for pi's native skill discovery.
      // SkillsAdapter handles path resolution, disabled skill filtering,
      // and compatibility with Claude Code / OpenClaw ecosystems.
      const skillPaths = this._skillsAdapter
        ? this._skillsAdapter.getSkillPaths(effectiveCwd)
        : this.legacySkillPaths(effectiveCwd);
      log('[ClaudeAgentRunner] Skill paths for pi ResourceLoader:', skillPaths);

      // Bridge MCP tools as customTools for pi-coding-agent.
      // Re-read every query so newly added/removed MCP servers take effect immediately.
      const mcpCustomTools = this.mcpManager ? buildMcpCustomTools(this.mcpManager) : [];
      const backgroundTaskTools = this.buildBackgroundTaskTool(session.id, effectiveCwd);
      const anySearchTool = buildAnySearchTool();
      const baseCustomTools = [anySearchTool, ...backgroundTaskTools, ...mcpCustomTools];
      log('[ClaudeAgentRunner] Registered AnySearch websearch custom tool');
      if (mcpCustomTools.length > 0) {
        log(
          `[ClaudeAgentRunner] Registered ${mcpCustomTools.length} MCP tools as customTools:`,
          mcpCustomTools.map((t) => t.name).join(', ')
        );
      }
      if (backgroundTaskTools.length > 0) {
        log('[ClaudeAgentRunner] Registered background task tool');
      }

      // Register search_history custom tool — allows the agent to search
      // the full (pre-compaction) message history of the current session.
      if (this.searchSessionMessages) {
        const searchSessionMessages = this.searchSessionMessages;
        const searchHistoryTool: ToolDefinition = {
          name: 'search_history',
          label: 'Search History',
          description:
            'Search the FULL message history of the current conversation session (including messages that were compacted/truncated from context). Use this when you need to recall details from earlier in the conversation that are no longer visible in the current context. Returns matching message snippets with timestamps.',
          parameters: Type.Object({
            keyword: Type.String({
              description:
                'One or more search keywords, separated by spaces. Messages containing ALL keywords will match (AND logic). For example: "database migration postgres" will match messages that contain all three words.',
            }),
            maxResults: Type.Optional(
              Type.Number({
                description: 'Maximum number of results to return. Defaults to 20.',
              })
            ),
          }),
          execute: async (
            _toolCallId: string,
            params: { keyword: string; maxResults?: number }
          ) => {
            const keywords = params.keyword
              .split(/\s+/)
              .map((w: string) => w.toLowerCase())
              .filter((w: string) => w.length > 0);

            if (keywords.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No search keywords provided.' }],
                details: undefined as unknown,
              };
            }

            const results = searchSessionMessages(session.id, keywords, params.maxResults ?? 20);

            if (results.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No messages found matching: "${params.keyword}"`,
                  },
                ],
                details: undefined as unknown,
              };
            }

            const formatted = results
              .map(
                (r) =>
                  `[${new Date(r.timestamp).toISOString()}] ${r.role === 'user' ? '🧑 User' : '🤖 Assistant'} (turn #${r.turnIndex}): ${r.snippet}`
              )
              .join('\n\n---\n\n');

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Found ${results.length} matching messages (out of the full pre-compaction history):\n\n${formatted}`,
                },
              ],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(searchHistoryTool);
        log('[ClaudeAgentRunner] Registered search_history custom tool');
      }

      // Register memory tools for durable cross-session project knowledge.
      {
        const projectMemory = this.projectMemoryService;
        const autoMemory = configStore.get('autoMemory');
        const memoryProjectPath = workingDir || null;
        const normalizedMemoryProjectPath = normalizeProjectPath(memoryProjectPath);
        const validKnowledgeTypes: KnowledgeType[] = [
          'fact',
          'preference',
          'decision',
          'reference',
          'project',
        ];
        const formatKnowledgeEntry = (entry: KnowledgeEntry, includeContent: boolean): string => {
          const tags = entry.tags.length > 0 ? entry.tags.join(', ') : 'none';
          const parts = [
            `ID: ${entry.id}`,
            `Title: ${entry.title}`,
            `Type: ${entry.type}`,
            `Importance: ${entry.importance}`,
            `Tags: ${tags}`,
          ];
          if (includeContent) {
            parts.push(`Content:\n${entry.content}`);
          } else {
            const summary =
              entry.content.length > 300 ? `${entry.content.slice(0, 300)}...` : entry.content;
            parts.push(`Preview: ${summary}`);
          }
          return parts.join('\n');
        };
        const normalizeKnowledgeLimit = (value: number | undefined, fallback: number): number => {
          if (!Number.isFinite(value ?? NaN)) return fallback;
          return Math.max(1, Math.min(20, Math.floor(value as number)));
        };

        const saveKnowledgeTool: ToolDefinition = {
          name: 'save_knowledge',
          label: 'Save Knowledge',
          description:
            'Propose a durable knowledge entry for project memory. The app will still dedupe, merge, or ignore the proposal before writing. ' +
            'Use trigger=explicit_user_request when the user directly asks to remember/save something, including Chinese phrases like "记一下", "记住", "帮我记一下", "保存到记忆", "记入记忆系统", "以后记得", or "这个要记住". Do not answer with only a summary in those cases; call this tool. ' +
            `Currently autoMemory is ${autoMemory ? 'enabled' : 'disabled'}. ` +
            (autoMemory
              ? 'For autonomous_high_value, call this rarely and only for stable cross-session knowledge: key architecture decisions, durable project conventions, explicit user preferences, or critical constraints. '
              : 'Because autoMemory is disabled, do not use autonomous_high_value. ') +
            'Do not save temporary task progress, logs, one-off bug details, tool output summaries, or ordinary history recall; use search_history for those.',
          parameters: Type.Object({
            trigger: Type.String({
              description:
                'Why this memory is being saved: explicit_user_request when the user directly asks to remember/save it (for example "记一下", "记住", "保存到记忆", or "remember this"), or autonomous_high_value for rare high-value automatic memory when autoMemory is enabled.',
            }),
            type: Type.String({
              description: 'Knowledge type: fact, preference, decision, reference, project',
            }),
            title: Type.String({
              description: 'Short descriptive title for the knowledge entry',
            }),
            content: Type.String({
              description: 'Detailed content of the knowledge entry',
            }),
            importance: Type.Optional(
              Type.Number({
                description: 'Importance level 1-5 (default: 3). Use 4-5 for critical information.',
              })
            ),
            tags: Type.Optional(
              Type.String({
                description: 'Optional comma-separated tags for categorization',
              })
            ),
            reason: Type.Optional(
              Type.String({
                description:
                  'Brief reason this is durable cross-session memory rather than searchable history.',
              })
            ),
          }),
          execute: async (
            _toolCallId: string,
            params: {
              trigger: string;
              type: string;
              title: string;
              content: string;
              importance?: number;
              tags?: string;
              reason?: string;
            }
          ) => {
            const tags = params.tags
              ? params.tags
                  .split(',')
                  .map((t: string) => t.trim())
                  .filter(Boolean)
              : [];
            const action = buildCandidateEvaluationAction(
              {
                trigger:
                  params.trigger === 'explicit_user_request'
                    ? 'explicit_user_request'
                    : 'autonomous_high_value',
                type: params.type,
                title: params.title,
                content: params.content,
                importance: params.importance ?? 3,
                tags,
                reason: params.reason,
              },
              memoryProjectPath ? projectMemory.listKnowledge(memoryProjectPath) : [],
              Boolean(autoMemory)
            );
            const applied = applyMemoryActions(projectMemory, [action], {
              sessionId: session.id,
              projectPath: memoryProjectPath,
              source: 'auto',
              sourceMessages: buildKnowledgeSourceCandidates(existingMessages, { maxMessages: 8 }),
            });

            if (applied.created === 0 && applied.updated === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Knowledge not saved: ${applied.reasons[0] || action.reason || 'candidate was ignored as duplicate or low-value memory.'}`,
                  },
                ],
                details: undefined as unknown,
              };
            }

            const entry = applied.entries[0];
            const verb = applied.updated > 0 ? 'updated' : 'saved';
            this.sendToRenderer({
              type: 'memory.changed',
              payload: {
                projectPath: entry.projectPath,
                action: applied.updated > 0 ? 'update' : 'create',
                id: entry.id,
              },
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Knowledge ${verb}: "${entry.title}" (id: ${entry.id}, type: ${entry.type}, importance: ${entry.importance})`,
                },
              ],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(saveKnowledgeTool);

        const queryKnowledgeTool: ToolDefinition = {
          name: 'query_knowledge',
          label: 'Query Knowledge',
          description:
            'Search durable project memory for relevant knowledge entries. Use this when you need to recall prior decisions, preferences, constraints, references, or project facts.',
          parameters: Type.Object({
            query: Type.String({
              description: 'Search query describing the knowledge you need to recall',
            }),
            maxResults: Type.Optional(
              Type.Number({
                description: 'Maximum number of entries to return, from 1 to 20 (default: 8)',
              })
            ),
          }),
          execute: async (_toolCallId: string, params: { query: string; maxResults?: number }) => {
            const limit = normalizeKnowledgeLimit(params.maxResults, 8);
            const entries = projectMemory
              .searchKnowledge(params.query, memoryProjectPath)
              .slice(0, limit);
            for (const entry of entries) {
              projectMemory.markAccessed(entry.id);
            }

            if (entries.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No matching knowledge entries found for query: ${params.query}`,
                  },
                ],
                details: undefined as unknown,
              };
            }

            const formatted = entries
              .map((entry) => formatKnowledgeEntry(entry, true))
              .join('\n\n---\n\n');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Found ${entries.length} knowledge entries:\n\n${formatted}`,
                },
              ],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(queryKnowledgeTool);

        const listKnowledgeTool: ToolDefinition = {
          name: 'list_knowledge',
          label: 'List Knowledge',
          description:
            'List durable project memory entries, optionally filtered by type. Use this to inspect available memory before choosing a specific entry to read.',
          parameters: Type.Object({
            type: Type.Optional(
              Type.String({
                description:
                  'Optional type filter: fact, preference, decision, reference, or project',
              })
            ),
            maxResults: Type.Optional(
              Type.Number({
                description: 'Maximum number of entries to return, from 1 to 20 (default: 12)',
              })
            ),
          }),
          execute: async (_toolCallId: string, params: { type?: string; maxResults?: number }) => {
            const type =
              params.type && validKnowledgeTypes.includes(params.type as KnowledgeType)
                ? (params.type as KnowledgeType)
                : undefined;
            const limit = normalizeKnowledgeLimit(params.maxResults, 12);
            const entries = projectMemory.listKnowledge(memoryProjectPath, type).slice(0, limit);

            if (entries.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: type
                      ? `No knowledge entries found for type: ${type}`
                      : 'No knowledge entries found.',
                  },
                ],
                details: undefined as unknown,
              };
            }

            const formatted = entries
              .map((entry) => formatKnowledgeEntry(entry, false))
              .join('\n\n---\n\n');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Listed ${entries.length} knowledge entries:\n\n${formatted}`,
                },
              ],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(listKnowledgeTool);

        const getKnowledgeTool: ToolDefinition = {
          name: 'get_knowledge',
          label: 'Get Knowledge',
          description:
            'Read one durable project memory entry by ID. Use this after list_knowledge or query_knowledge when you need the full stored content. If the summary is too compressed, call get_knowledge_evidence for bounded source snippets.',
          parameters: Type.Object({
            id: Type.String({
              description: 'The ID of the knowledge entry to read',
            }),
          }),
          execute: async (_toolCallId: string, params: { id: string }) => {
            const entry = projectMemory.getKnowledge(params.id);
            if (
              !entry ||
              !normalizedMemoryProjectPath ||
              entry.projectPath !== normalizedMemoryProjectPath
            ) {
              return {
                content: [
                  { type: 'text' as const, text: `Knowledge entry not found: ${params.id}` },
                ],
                details: undefined as unknown,
              };
            }

            projectMemory.markAccessed(entry.id);
            return {
              content: [{ type: 'text' as const, text: formatKnowledgeEntry(entry, true) }],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(getKnowledgeTool);

        const getKnowledgeEvidenceTool: ToolDefinition = {
          name: 'get_knowledge_evidence',
          label: 'Get Knowledge Evidence',
          description:
            'Read bounded source snippets or a small nearby history window for one project memory entry. Use this when a memory entry is relevant but you need its original conversation evidence. This is budget-limited and should be preferred before broad search_history.',
          parameters: Type.Object({
            id: Type.String({
              description: 'The ID of the knowledge entry whose source evidence should be read',
            }),
            mode: Type.Optional(
              Type.String({
                description:
                  'Evidence mode: snippets for short saved source snippets, or window for a small nearby conversation window. Default: snippets',
              })
            ),
            maxChars: Type.Optional(
              Type.Number({
                description:
                  'Maximum characters to return. Defaults: 3000 for snippets, 6000 for window. Hard capped by the app.',
              })
            ),
          }),
          execute: async (
            _toolCallId: string,
            params: { id: string; mode?: string; maxChars?: number }
          ) => {
            const entry = projectMemory.getKnowledge(params.id);
            if (
              !entry ||
              !normalizedMemoryProjectPath ||
              entry.projectPath !== normalizedMemoryProjectPath
            ) {
              return {
                content: [
                  { type: 'text' as const, text: `Knowledge entry not found: ${params.id}` },
                ],
                details: undefined as unknown,
              };
            }

            const mode = params.mode === 'window' ? 'window' : 'snippets';
            const evidence = projectMemory.getKnowledgeEvidence(entry.id, {
              mode,
              maxChars: params.maxChars,
            });
            if (evidence.sources.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No source evidence is recorded for knowledge entry: ${entry.id}`,
                  },
                ],
                details: undefined as unknown,
              };
            }

            const formatted = evidence.sources
              .map((source) =>
                [
                  `Session: ${source.sessionId}`,
                  `Message: ${source.messageId}`,
                  `Role: ${source.role}`,
                  `Turn: ${source.turnIndex}`,
                  `Time: ${new Date(source.timestamp).toISOString()}`,
                  `Snippet:\n${source.snippet}`,
                ].join('\n')
              )
              .join('\n\n---\n\n');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Evidence for "${entry.title}" (${mode}; ${evidence.returnedChars}/${evidence.maxChars} chars${evidence.truncated ? ', truncated' : ''}):\n\n${formatted}`,
                },
              ],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(getKnowledgeEvidenceTool);

        const deleteKnowledgeTool: ToolDefinition = {
          name: 'delete_knowledge',
          label: 'Delete Knowledge',
          description:
            'Delete a knowledge entry by its ID. Use this when the user asks to forget or remove specific knowledge.',
          parameters: Type.Object({
            id: Type.String({
              description: 'The ID of the knowledge entry to delete',
            }),
          }),
          execute: async (_toolCallId: string, params: { id: string }) => {
            const entry = projectMemory.getKnowledge(params.id);
            if (
              !entry ||
              !normalizedMemoryProjectPath ||
              entry.projectPath !== normalizedMemoryProjectPath
            ) {
              return {
                content: [
                  { type: 'text' as const, text: `Knowledge entry not found: ${params.id}` },
                ],
                details: undefined as unknown,
              };
            }
            projectMemory.deleteKnowledge(params.id);
            this.sendToRenderer({
              type: 'memory.changed',
              payload: { projectPath: entry.projectPath, action: 'delete', id: params.id },
            });
            return {
              content: [{ type: 'text' as const, text: `Knowledge entry deleted: ${params.id}` }],
              details: undefined as unknown,
            };
          },
        };
        baseCustomTools.push(deleteKnowledgeTool);

        log('[ClaudeAgentRunner] Registered project memory custom tools');
      }

      // Enrich process.env.PATH for build mode — ensures Skill commands (python3, node)
      // executed via Pi SDK's Bash tool can find bundled and user-installed executables.
      await enrichProcessPathForBuild();

      const codingTools = createCodingTools(
        effectiveCwd,
        process.platform === 'win32'
          ? {
              bash: {
                operations: this.createWindowsBashOperations(session.id),
              },
            }
          : undefined
      );
      const windowsBashTools = this.replaceBashToolForWindows(
        codingTools as ToolDefinition[],
        session.id,
        effectiveCwd,
        sanitizeOutputPaths
      );

      // Inject a default 120s timeout for bash commands when the model omits one
      const withTimeout = ClaudeAgentRunner.wrapBashToolWithDefaultTimeout(windowsBashTools);
      // Wrap the bash tool to intercept sudo commands and request passwords
      // Note: wrapBashToolForSudo returns ToolDefinition[] (5-param execute) but
      // createAgentSession.tools expects Tool[] (4-param execute). The extra ctx
      // parameter is simply not passed by the session runner — safe to cast.
      const wrappedTools = this.wrapBashToolForSudo(
        withTimeout,
        session.id,
        effectiveCwd,
        sanitizeOutputPaths
      );

      // On Windows, add a pwsh tool for PowerShell execution
      if (process.platform === 'win32') {
        const pwshTool: ToolDefinition = {
          name: 'pwsh',
          label: 'PowerShell',
          description:
            'Execute a PowerShell command on Windows. Use this instead of bash for Windows-native tasks (file operations, registry, services, WMI, etc.). Supports PowerShell 7 (pwsh) and Windows PowerShell 5.1.',
          parameters: Type.Object({
            command: Type.String({
              description:
                'The PowerShell command to execute. Supports all PowerShell syntax including pipelines, objects, and .NET calls.',
            }),
            timeout: Type.Optional(
              Type.Number({
                description: 'Optional timeout in seconds. Defaults to 120 seconds.',
              })
            ),
          }),
          execute: async (
            _toolCallId: string,
            params: { command: string; timeout?: number },
            signal: AbortSignal | undefined
          ) => {
            const timeout = (params.timeout ?? 120) * 1000;
            const decodedCommand = ClaudeAgentRunner.decodeHtmlEntities(params.command || '');
            const result = await executeWindowsPowerShell({
              script: decodedCommand,
              cwd: effectiveCwd,
              timeoutMs: Math.max(1, timeout),
              signal,
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: ClaudeAgentRunner.formatBashToolText(result),
                },
              ],
              details: undefined as unknown,
            };
          },
        };
        wrappedTools.push(pwshTool);
      }

      // Register the http tool for making HTTP requests directly
      // (avoids Git Bash/MSYS2 encoding issues with curl and non-ASCII payloads)
      {
        const httpTool: ToolDefinition = {
          name: 'http',
          label: 'HTTP Request',
          description:
            'Make an HTTP request (GET, POST, PUT, PATCH, DELETE, HEAD). Use this instead of curl/wget for API calls — it avoids shell encoding issues and works with non-ASCII payloads. Returns status, headers, and body.',
          parameters: Type.Object({
            method: Type.String({
              description: 'HTTP method: GET, POST, PUT, PATCH, DELETE, or HEAD.',
            }),
            url: Type.String({
              description: 'Full URL including protocol (https://...)',
            }),
            headers: Type.Optional(
              Type.Record(Type.String(), Type.String(), {
                description:
                  'Optional request headers, e.g. {"Content-Type": "application/json", "Authorization": "Bearer token"}',
              })
            ),
            body: Type.Optional(
              Type.String({
                description:
                  'Optional request body as a string. For JSON APIs, pass JSON.stringify(...) result here.',
              })
            ),
            timeout: Type.Optional(
              Type.Number({
                description: 'Optional timeout in seconds. Defaults to 30.',
              })
            ),
          }),
          execute: async (
            _toolCallId: string,
            params: {
              method: string;
              url: string;
              headers?: Record<string, string>;
              body?: string;
              timeout?: number;
            },
            signal: AbortSignal | undefined
          ) => {
            const method = (params.method || 'GET').toUpperCase();
            const url = params.url?.trim();
            if (!url) {
              throw new Error('URL is required');
            }

            // Validate URL
            let parsed: URL;
            try {
              parsed = new URL(url);
            } catch {
              throw new Error('Invalid URL');
            }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              throw new Error('Only http/https URLs are supported');
            }

            const timeoutMs = Math.max(1, params.timeout ?? 30) * 1000;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            // Forward external abort signal
            if (signal) {
              signal.addEventListener('abort', () => controller.abort(), { once: true });
            }

            try {
              const response = await fetch(url, {
                method,
                headers: {
                  'User-Agent': 'open-cowork',
                  ...(params.headers ?? {}),
                },
                body: ['GET', 'HEAD'].includes(method) ? undefined : (params.body ?? undefined),
                signal: controller.signal,
                redirect: 'follow',
              });

              clearTimeout(timeoutId);

              const responseHeaders: string[] = [];
              response.headers.forEach((value, key) => {
                responseHeaders.push(`${key}: ${value}`);
              });

              let body: string;
              try {
                body = await response.text();
              } catch {
                body = '[Binary or unreadable body]';
              }

              const limit = 50000;
              const truncated =
                body.length > limit
                  ? `${body.slice(0, limit)}\n\n[Truncated ${body.length - limit} chars]`
                  : body;

              const output = [
                `HTTP ${response.status} ${response.statusText}`,
                ...responseHeaders,
                '',
                truncated,
              ].join('\n');

              return {
                content: [{ type: 'text' as const, text: output }],
                details: undefined as unknown,
              };
            } catch (error) {
              clearTimeout(timeoutId);
              if (
                error instanceof Error &&
                (error.name === 'AbortError' || error.name === 'TimeoutError')
              ) {
                throw new Error('Request timed out');
              }
              throw error;
            }
          },
        };
        wrappedTools.push(httpTool);
      }

      const shellGuardedTools = this.wrapBashToolForBackgroundSyntax(
        wrappedTools,
        session.id,
        effectiveCwd
      );

      const guardedShellTools = this.wrapToolsWithPlanModeGuard(
        shellGuardedTools,
        session.id,
        effectiveCwd
      );
      const guardedBaseCustomTools = this.wrapToolsWithPlanModeGuard(
        baseCustomTools,
        session.id,
        effectiveCwd
      );

      const shellOverrideTools = guardedShellTools.filter(
        (tool) => tool.name === 'bash' || tool.name === 'pwsh' || tool.name === 'http'
      );
      const limitedShellTools = this.wrapToolsWithResultLimit(
        guardedShellTools,
        session.id,
        effectiveCwd
      );
      const customTools = this.wrapToolsWithResultLimit(
        [...guardedBaseCustomTools, ...shellOverrideTools],
        session.id,
        effectiveCwd
      );

      // Diagnostic: log tools being passed to SDK (helps debug Ollama tool use)
      logCtx(`[ClaudeAgentRunner] Session reuse check: cached=${!!cachedSession}`);
      logCtx(`[ClaudeAgentRunner] Model=${piModel.id}, thinkingLevel=${thinkingLevel}`);
      if (session.planMode) {
        log(
          `[ClaudeAgentRunner] PLAN MODE — dynamic tool guard is active; research commands and scratch writes are allowed`
        );
      }
      log(
        `[ClaudeAgentRunner] Built-in tools (${guardedShellTools.length}): ${guardedShellTools.map((t: { name?: string; type?: string }) => t.name || t.type).join(', ')}`
      );
      log(
        `[ClaudeAgentRunner] Custom MCP tools (${mcpCustomTools.length}): ${mcpCustomTools.map((t) => t.name).join(', ')}`
      );
      log(
        `[ClaudeAgentRunner] Shell override tools (${shellOverrideTools.length}): ${shellOverrideTools.map((t) => t.name).join(', ')}`
      );

      const toolFingerprintInput = {
        builtIn: limitedShellTools.map((tool) => describeToolForFingerprint(tool)),
        custom: customTools.map((tool) => describeToolForFingerprint(tool)),
      };
      const cacheDiagnostics: CacheDiagnosticsPayload = {
        version: 1,
        provider,
        modelId: piModel.id,
        sessionReuse: Boolean(cachedSession),
        coldStart: !cachedSession,
        historySerializationVersion: 'stable-v1',
        runtimeSignatureFingerprint: fingerprintText(sessionRuntimeSignature),
        runtimeSignatureChangeReasons,
        historyMessagesAvailable,
        historyMessagesInjected,
        historyMessagesOmitted,
        excludedCurrentTurnUser,
        historyCharBudget,
        ...(historyPreamble
          ? { historyPreambleFingerprint: fingerprintText(historyPreamble) }
          : {}),
        systemPromptFingerprint: fingerprintText(coworkAppendPrompt),
        toolsFingerprint: fingerprintValue(toolFingerprintInput),
        fullRequestPrefixFingerprint: fingerprintValue({
          systemPrompt: coworkAppendPrompt,
          historyPreamble,
          tools: toolFingerprintInput,
        }),
      };
      const cacheDiagnosticsStepId = uuidv4();
      this.sendTraceStep(session.id, {
        id: cacheDiagnosticsStepId,
        type: 'text',
        status: 'completed',
        title: 'Cache diagnostics',
        content: JSON.stringify(cacheDiagnostics, null, 2),
        timestamp: Date.now(),
      });

      let piSession: PiAgentSession;
      if (cachedSession) {
        // Reuse existing session — SDK retains full conversation history and handles compaction
        piSession = cachedSession.session;

        // Hot-swap model/thinking if changed — SDK supports this natively
        if (cachedSession.modelId !== piModel.id) {
          logCtx(
            '[ClaudeAgentRunner] Model changed, hot-swapping:',
            cachedSession.modelId,
            '→',
            piModel.id
          );
          await piSession.setModel(piModel);
          cachedSession.modelId = piModel.id;
          // Update Ollama num_ctx ref if present
          if (cachedSession.ollamaNumCtx) {
            cachedSession.ollamaNumCtx.value = piModel.contextWindow || 128000;
            log(
              '[ClaudeAgentRunner] Updated Ollama num_ctx on hot-swap:',
              cachedSession.ollamaNumCtx.value
            );
          }
          // Notify renderer of updated context window info on model switch
          this.sendToRenderer({
            type: 'session.contextInfo',
            payload: {
              sessionId: session.id,
              contextWindow: piModel.contextWindow || 128000,
            },
          });
        }
        if (cachedSession.thinkingLevel !== thinkingLevel) {
          logCtx(
            '[ClaudeAgentRunner] Thinking level changed, hot-swapping:',
            cachedSession.thinkingLevel,
            '→',
            thinkingLevel
          );
          piSession.setThinkingLevel(thinkingLevel);
          cachedSession.thinkingLevel = thinkingLevel;
        }

        // 🔑 Replace SDK agent internal messages with the compressed version from session-manager.
        // Without this, SDK accumulates ALL previous turns' messages in state.messages and sends
        // them to the model, causing context ballooning (~400K → 780K+). By injecting the
        // budgeted/compacted messages here, the SDK only sends what we control.
        if (existingMessages.length > 0) {
          const agent = piSession.agent;
          const compressedMessages = convertToPiAgentMessages(existingMessages);
          agent.replaceMessages(compressedMessages);
          logCtx(
            '[ClaudeAgentRunner] Replaced SDK agent messages with compressed version:',
            compressedMessages.length,
            'messages (from',
            existingMessages.length,
            'existing)'
          );
        }

        logCtx('[ClaudeAgentRunner] Reusing cached pi session for:', session.id);
        logTiming('pi-coding-agent session reused', runStartTime);
      } else {
        // First query in this session — create new pi-coding-agent session
        // ResourceLoader + ModelRegistry only needed for session creation — skip on reuse
        const { DefaultResourceLoader } = await import('@mariozechner/pi-coding-agent');
        const resourceLoader = new DefaultResourceLoader({
          cwd: effectiveCwd,
          noSkills: true, // Disable pi's default skill discovery; Open Cowork controls all skill paths
          additionalSkillPaths: skillPaths,
          appendSystemPrompt: coworkAppendPrompt,
        });
        await resourceLoader.reload();

        const modelRegistry = new ModelRegistry(authStorage);

        // Ollama-specific compaction tuning based on actual context window
        const contextWindow = piModel.contextWindow || 128000;
        let compactionSettings: {
          enabled: boolean;
          reserveTokens?: number;
          keepRecentTokens?: number;
        };
        if (provider === 'ollama' && contextWindow < 16384) {
          // Very small context: disable compaction (weak models produce unreliable summaries)
          compactionSettings = { enabled: false };
          log(
            '[ClaudeAgentRunner] Ollama small context model, disabling auto-compaction (contextWindow:',
            contextWindow,
            ')'
          );
        } else if (provider === 'ollama' && contextWindow < 65536) {
          // Medium context: scale reserves proportionally
          compactionSettings = {
            enabled: true,
            reserveTokens: Math.floor(contextWindow * 0.15),
            keepRecentTokens: Math.floor(contextWindow * 0.25),
          };
          log(
            '[ClaudeAgentRunner] Ollama medium context, scaled compaction:',
            JSON.stringify(compactionSettings)
          );
        } else {
          compactionSettings = { enabled: true };
        }

        const { session: newPiSession } = await createAgentSession({
          model: piModel,
          thinkingLevel,
          authStorage,
          modelRegistry,
          tools: limitedShellTools as unknown as ReturnType<typeof createCodingTools>,
          customTools,
          sessionManager: PiSessionManager.inMemory(),
          settingsManager: PiSettingsManager.inMemory({
            compaction: compactionSettings,
            retry: { enabled: true, maxRetries: 2 },
          }),
          resourceLoader,
          cwd: effectiveCwd,
        });
        piSession = newPiSession;

        // Store session for reuse — evict oldest if cache is full
        if (this.piSessions.size >= ClaudeAgentRunner.MAX_CACHED_SESSIONS) {
          const oldestKey = this.piSessions.keys().next().value;
          if (oldestKey) {
            const oldest = this.piSessions.get(oldestKey);
            if (oldest) {
              try {
                oldest.session.dispose();
              } catch (e) {
                logWarn('[ClaudeAgentRunner] dispose error on eviction:', e);
              }
            }
            this.piSessions.delete(oldestKey);
            log('[ClaudeAgentRunner] Evicted oldest cached session:', oldestKey);
          }
        }
        this.piSessions.set(session.id, {
          session: piSession,
          modelId: piModel.id,
          thinkingLevel,
          runtimeSignature: sessionRuntimeSignature,
        });

        // Ollama: wrap _onPayload to inject num_ctx into every request
        if (provider === 'ollama') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const agent = piSession.agent as any;
          // Guard: only patch if the SDK exposes _onPayload (private API)
          if (!('_onPayload' in agent)) {
            logWarn(
              '[ClaudeAgentRunner] SDK agent does not expose _onPayload — skipping Ollama num_ctx patch'
            );
          } else {
            const originalOnPayload = agent._onPayload as
              | ((
                  payload: Record<string, unknown>,
                  modelArg: unknown
                ) => Promise<Record<string, unknown>>)
              | undefined;
            const ollamaNumCtx = {
              value: piModel.contextWindow || 128000,
            };
            agent._onPayload = async (payload: Record<string, unknown>, modelArg: unknown) => {
              let result = originalOnPayload
                ? await originalOnPayload.call(agent, payload, modelArg)
                : payload;
              if (result === undefined) result = payload;
              return { ...result, num_ctx: ollamaNumCtx.value };
            };
            this.piSessions.get(session.id)!.ollamaNumCtx = ollamaNumCtx;
            log(
              '[ClaudeAgentRunner] Ollama _onPayload wrapper installed, num_ctx:',
              ollamaNumCtx.value
            );
          } // end else (_onPayload exists)
        }

        logTiming('pi-coding-agent session created', runStartTime);
      }

      const usesAnthropicMessagesProtocol =
        configProtocol === 'anthropic' || piModel.api === 'anthropic-messages';
      const usesOpenAICompletionsProtocol =
        configProtocol === 'openai' || piModel.api === 'openai-completions';

      // Set up event handler to bridge pi-coding-agent events → our ServerEvent protocol
      if (usesAnthropicMessagesProtocol || usesOpenAICompletionsProtocol) {
        const agent = (piSession as unknown as { agent?: unknown }).agent as
          | {
              _onPayload?: (
                payload: Record<string, unknown>,
                modelArg: unknown
              ) =>
                | Promise<Record<string, unknown> | undefined>
                | Record<string, unknown>
                | undefined;
              __openCoworkOriginalOnPayload?: (
                payload: Record<string, unknown>,
                modelArg: unknown
              ) =>
                | Promise<Record<string, unknown> | undefined>
                | Record<string, unknown>
                | undefined;
              state?: { messages?: unknown[] };
            }
          | undefined;

        if (agent && '_onPayload' in agent) {
          if (!agent.__openCoworkOriginalOnPayload) {
            agent.__openCoworkOriginalOnPayload = agent._onPayload;
          }
          const originalOnPayload = agent.__openCoworkOriginalOnPayload;
          agent._onPayload = async (payload: Record<string, unknown>, modelArg: unknown) => {
            const nextPayload = originalOnPayload
              ? ((await originalOnPayload.call(agent, payload, modelArg)) ?? payload)
              : payload;
            if (!enableThinking) {
              return (
                usesAnthropicMessagesProtocol
                  ? disableThinkingForAnthropicPayload(nextPayload)
                  : disableThinkingForOpenAIPayload(nextPayload)
              ) as Record<string, unknown>;
            }
            let patchedPayload: unknown = nextPayload;
            if (usesAnthropicMessagesProtocol) {
              patchedPayload = restoreUnsignedThinkingBlocksForAnthropicPayload(
                patchedPayload,
                agent.state?.messages ?? []
              );
            }
            if (usesOpenAICompletionsProtocol) {
              patchedPayload = restoreOpenAIReasoningContentForPayload(
                patchedPayload,
                agent.state?.messages ?? []
              );
            }
            return patchedPayload as Record<string, unknown>;
          };
        }
      }

      // Accumulate streamed text deltas in case message_end.content is empty (pi SDK streaming behaviour)
      let streamedText = '';
      let streamedThinking = '';
      let streamedThinkingSignature: string | undefined;
      let compactionStepId: string | undefined;
      let hasEmittedError = false;
      let terminalErrorText: string | undefined;
      const thinkParser = new ThinkTagStreamParser();
      const promptStartedAt = Date.now();
      const streamEventCounts = new Map<string, number>();

      // Ollama cold-start feedback: if provider is 'ollama' and no stream event arrives
      // within 10 seconds, show a "model loading" trace update so users know what's happening.
      let ollamaColdStartTimerId: ReturnType<typeof setTimeout> | undefined;
      let receivedFirstStreamEvent = false;
      let firstStreamEventAt: number | undefined;
      if (provider === 'ollama') {
        ollamaColdStartTimerId = setTimeout(() => {
          if (!receivedFirstStreamEvent && !controller.signal.aborted) {
            this.sendTraceUpdate(session.id, thinkingStepId, {
              title: 'Waiting for model to load into memory...',
            });
          }
        }, 10000);
      }

      const markFirstStreamEvent = (eventType: string) => {
        if (receivedFirstStreamEvent) {
          return;
        }
        receivedFirstStreamEvent = true;
        firstStreamEventAt = Date.now();
        if (ollamaColdStartTimerId) {
          clearTimeout(ollamaColdStartTimerId);
        }
        this.sendTraceUpdate(session.id, thinkingStepId, {
          title: 'Processing request...',
        });
        if (provider === 'ollama') {
          log(
            '[ClaudeAgentRunner] Ollama first stream event received',
            safeStringify({
              sessionId: session.id,
              eventType,
              modelId: piModel.id,
              modelProvider: piModel.provider,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
              latencyMs: firstStreamEventAt - promptStartedAt,
            })
          );
        }
      };

      // Activity-based timeout: reset the 5-min timer whenever the SDK sends events
      const PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      let activityTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const resetActivityTimeout = () => {
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        activityTimeoutId = setTimeout(() => {
          logWarn('[ClaudeAgentRunner] Prompt timed out (no activity for 5 min), aborting');
          abortedByTimeout = true;
          controller.abort();
        }, PROMPT_TIMEOUT_MS);
      };

      const recordStreamEvent = (eventType: string) => {
        streamEventCounts.set(eventType, (streamEventCounts.get(eventType) ?? 0) + 1);
      };

      const getStreamEventSummary = () =>
        Object.fromEntries(
          Array.from(streamEventCounts.entries()).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        );

      const unsubscribe = piSession.subscribe((event) => {
        try {
          if (controller.signal.aborted) return;

          // Reset activity timeout on meaningful events
          resetActivityTimeout();

          if (event.type === 'message_update') {
            const updateType = event.assistantMessageEvent.type;
            recordStreamEvent(updateType);
            if (
              updateType !== 'text_delta' &&
              updateType !== 'thinking_delta' &&
              updateType !== 'toolcall_delta'
            ) {
              log(`[ClaudeAgentRunner] Event: ${event.type} → ${updateType}`);
            }
          } else if (event.type === 'message_start') {
            log(
              '[ClaudeAgentRunner] Event: message_start',
              safeStringify(summarizeMessageForLog(event.message), 2)
            );
          } else if (event.type === 'message_end') {
            log(
              '[ClaudeAgentRunner] Event: message_end',
              safeStringify(
                {
                  message: summarizeMessageForLog(event.message),
                  messageUpdateCounts: getStreamEventSummary(),
                },
                2
              )
            );
          } else if (event.type === 'turn_end') {
            log(`[ClaudeAgentRunner] Event: ${event.type}`);
          } else {
            log(`[ClaudeAgentRunner] Event: ${event.type}`);
          }

          switch (event.type) {
            case 'message_update': {
              if (controller.signal.aborted) break;
              const ame = event.assistantMessageEvent;
              if (ame.type === 'text_delta') {
                markFirstStreamEvent(ame.type);
                const parsed = enableThinking
                  ? thinkParser.push(ame.delta)
                  : { text: ame.delta, thinking: '' };
                if (parsed.thinking) {
                  streamedThinking += parsed.thinking;
                  this.sendToRenderer({
                    type: 'stream.thinking',
                    payload: { sessionId: session.id, delta: parsed.thinking },
                  });
                }
                if (parsed.text) {
                  streamedText += parsed.text;
                  this.sendPartial(session.id, parsed.text);
                }
              } else if (ame.type === 'thinking_delta') {
                markFirstStreamEvent(ame.type);
                streamedThinking += ame.delta;
                const thinkingBlock = ame.partial?.content?.[ame.contentIndex];
                if (
                  thinkingBlock?.type === 'thinking' &&
                  typeof thinkingBlock.thinkingSignature === 'string' &&
                  thinkingBlock.thinkingSignature.trim().length > 0
                ) {
                  streamedThinkingSignature = thinkingBlock.thinkingSignature;
                } else if (!streamedThinkingSignature && usesOpenAICompletionsProtocol) {
                  streamedThinkingSignature = 'reasoning_content';
                }
                // Forward thinking delta to renderer for real-time display
                this.sendToRenderer({
                  type: 'stream.thinking',
                  payload: { sessionId: session.id, delta: ame.delta },
                });
              } else if (ame.type === 'toolcall_start') {
                markFirstStreamEvent(ame.type);
                const partial = ame.partial;
                const toolContent = partial?.content?.[ame.contentIndex];
                const toolName = toolContent?.type === 'toolCall' ? toolContent.name : 'unknown';
                const toolCallId = toolContent?.type === 'toolCall' ? toolContent.id : uuidv4();
                this.sendTraceStep(session.id, {
                  id: toolCallId,
                  type: 'tool_call',
                  status: 'running',
                  title: toolName,
                  toolName,
                  toolInput:
                    toolContent?.type === 'toolCall'
                      ? (toolContent.arguments as Record<string, unknown>) || {}
                      : undefined,
                  timestamp: Date.now(),
                });
              } else if (ame.type === 'done') {
                // Some providers emit 'done' via message_update — we handle it
                // in message_end below as a unified path for all providers.
                log('[ClaudeAgentRunner] message_update done event (handled in message_end)');
              } else if (ame.type === 'error') {
                const errorDetail = JSON.stringify(ame.error?.content || 'no content');
                logCtxError('[ClaudeAgentRunner] pi-ai stream error:', ame.reason, errorDetail);
              }
              break;
            }

            case 'message_end': {
              // Unified handler: send the final assistant message to the renderer.
              // Works for all providers (some emit 'done' via message_update, others don't).
              if (controller.signal.aborted) break;

              // Flush any buffered content from the think-tag parser
              const flushed = enableThinking ? thinkParser.flush() : { text: '', thinking: '' };
              if (flushed.thinking) {
                streamedThinking += flushed.thinking;
                this.sendToRenderer({
                  type: 'stream.thinking',
                  payload: { sessionId: session.id, delta: flushed.thinking },
                });
              }
              if (flushed.text) {
                streamedText += flushed.text;
                this.sendPartial(session.id, flushed.text);
              }

              const msg = event.message;
              if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
                log('[ClaudeAgentRunner] message_end raw message:', safeStringify(msg, 2));
              }
              const resolvedPayload = resolveMessageEndPayload({
                message: msg as Parameters<typeof resolveMessageEndPayload>[0]['message'],
                streamedText,
                streamedThinking,
                streamedThinkingSignature,
              });
              streamedText = resolvedPayload.nextStreamedText;
              streamedThinking = resolvedPayload.nextStreamedThinking;
              streamedThinkingSignature = undefined;
              if (provider === 'ollama') {
                log(
                  '[ClaudeAgentRunner] Ollama message_end diagnostics',
                  safeStringify({
                    sessionId: session.id,
                    modelId: piModel.id,
                    modelProvider: piModel.provider,
                    usedSyntheticModel,
                    receivedFirstStreamEvent,
                    firstStreamLatencyMs: firstStreamEventAt
                      ? firstStreamEventAt - promptStartedAt
                      : null,
                    stopReason: (msg as { stopReason?: unknown })?.stopReason ?? null,
                    contentBlocks: Array.isArray((msg as { content?: unknown[] })?.content)
                      ? ((msg as { content?: unknown[] }).content?.length ?? 0)
                      : 0,
                    emittedError: Boolean(resolvedPayload.errorText),
                  })
                );
              }
              if (resolvedPayload.errorText) {
                terminalErrorText = resolvedPayload.errorText;
                if (!hasEmittedError) {
                  hasEmittedError = true;
                  this.sendMessage(session.id, {
                    id: uuidv4(),
                    sessionId: session.id,
                    role: 'assistant',
                    content: [
                      {
                        type: 'text',
                        text: `**Error**: ${resolvedPayload.errorText}\n\n${
                          /\b4\d{2}\b/.test(resolvedPayload.errorText)
                            ? '_请检查配置后重试。_'
                            : '_Agent 正在自动重试，请稍候..._'
                        }`,
                      },
                    ],
                    timestamp: Date.now(),
                  });
                }
                break;
              }
              if (resolvedPayload.shouldEmitMessage) {
                const contentBlocks: ContentBlock[] = [];
                for (const block of resolvedPayload.effectiveContent) {
                  if (block.type === 'text') {
                    const { cleanText, artifacts } = extractArtifactsFromText(block.text);
                    if (cleanText) {
                      contentBlocks.push({ type: 'text', text: sanitizeOutputPaths(cleanText) });
                    }
                    if (artifacts.length > 0) {
                      for (const step of buildArtifactTraceSteps(artifacts)) {
                        this.sendTraceStep(session.id, step);
                      }
                    }
                  } else if (block.type === 'toolCall') {
                    contentBlocks.push({
                      type: 'tool_use',
                      id: block.id,
                      name: block.name,
                      input: block.arguments,
                    });
                  } else if (block.type === 'thinking') {
                    // Always include thinking blocks from the model response —
                    // if the model natively produces reasoning, show it to the user.
                    // enableThinking only controls whether we REQUEST thinking from the API.
                    contentBlocks.push({
                      type: 'thinking',
                      thinking: block.thinking,
                      ...(block.thinkingSignature
                        ? { thinkingSignature: block.thinkingSignature }
                        : {}),
                      ...(block.redacted ? { redacted: true } : {}),
                    });
                  } else {
                    // Unknown block type — pass through as text so content isn't silently lost
                    const unknownBlock = block as { type?: string; text?: string };
                    log(`[ClaudeAgentRunner] Unknown content block type: ${unknownBlock.type}`);
                    const text = unknownBlock.text || JSON.stringify(block);
                    if (text) contentBlocks.push({ type: 'text', text });
                  }
                }
                // Always clear partial text; send message even if only artifacts were extracted
                this.sendToRenderer({
                  type: 'stream.partial',
                  payload: { sessionId: session.id, delta: '' },
                });
                const msgWithUsage = msg as { usage?: unknown };
                const tokenUsage = normalizeTokenUsage(msgWithUsage.usage);
                if (msgWithUsage.usage) {
                  log(
                    '[ClaudeAgentRunner] normalized usage:',
                    safeStringify(
                      {
                        raw: msgWithUsage.usage,
                        normalized: tokenUsage,
                      },
                      2
                    )
                  );
                }
                if (tokenUsage) {
                  cacheDiagnostics.cacheUsage = tokenUsage;
                  this.sendTraceUpdate(session.id, cacheDiagnosticsStepId, {
                    content: JSON.stringify(cacheDiagnostics, null, 2),
                    title:
                      tokenUsage.cacheHit === true
                        ? 'Cache diagnostics (hit)'
                        : tokenUsage.cacheHit === false
                          ? 'Cache diagnostics (miss)'
                          : 'Cache diagnostics',
                  });
                }
                if (contentBlocks.length > 0) {
                  const assistantMsg: Message = {
                    id: uuidv4(),
                    sessionId: session.id,
                    role: 'assistant',
                    content: contentBlocks,
                    timestamp: Date.now(),
                    tokenUsage,
                  };
                  this.sendMessage(session.id, assistantMsg);
                }
              }
              break;
            }

            case 'tool_execution_start': {
              logCtx(`[ClaudeAgentRunner] Tool execution start: ${event.toolName}`);
              break;
            }

            case 'tool_execution_end': {
              if (controller.signal.aborted) break;
              const toolCallId = event.toolCallId;
              const isError = event.isError;
              const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);
              const outputText = normalizedToolResult.content;
              this.sendTraceUpdate(session.id, toolCallId, {
                status: isError ? 'error' : 'completed',
                toolName: event.toolName,
                toolOutput: sanitizeOutputPaths(outputText).slice(0, 800),
              });

              // Send tool result message
              const toolResultMsg: Message = {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: [
                  {
                    type: 'tool_result',
                    toolUseId: toolCallId,
                    content: sanitizeOutputPaths(outputText),
                    isError,
                    ...(normalizedToolResult.images.length > 0
                      ? { images: normalizedToolResult.images }
                      : {}),
                  },
                ],
                timestamp: Date.now(),
              };
              this.sendMessage(session.id, toolResultMsg);
              break;
            }

            case 'agent_end': {
              logCtx('[ClaudeAgentRunner] Agent finished');
              break;
            }

            case 'auto_compaction_start': {
              log('[ClaudeAgentRunner] Auto-compaction started, reason:', event.reason);
              compactionStepId = `compaction-${Date.now()}`;
              this.sendTraceStep(session.id, {
                id: compactionStepId,
                type: 'thinking',
                status: 'running',
                title: `Compacting context (${event.reason})...`,
                timestamp: Date.now(),
              });
              break;
            }

            case 'auto_compaction_end': {
              const status = event.aborted ? 'error' : event.errorMessage ? 'error' : 'completed';
              const title = event.aborted
                ? 'Context compaction aborted'
                : event.errorMessage
                  ? `Context compaction failed: ${event.errorMessage}`
                  : 'Context compaction completed';
              log(
                '[ClaudeAgentRunner] Auto-compaction ended:',
                title,
                'willRetry:',
                event.willRetry
              );
              if (compactionStepId) {
                this.sendTraceUpdate(session.id, compactionStepId, { status, title });
                compactionStepId = undefined;
              } else {
                // Fallback: no matching start event, send as new step
                this.sendTraceStep(session.id, {
                  id: `compaction-end-${Date.now()}`,
                  type: 'thinking',
                  status,
                  title,
                  timestamp: Date.now(),
                });
              }
              break;
            }
          }
        } catch (subscribeErr) {
          logError('[ClaudeAgentRunner] Error in subscribe callback:', subscribeErr);
          if (compactionStepId) {
            this.sendTraceUpdate(session.id, compactionStepId, {
              status: 'error',
              title: 'Error during context compaction',
            });
            compactionStepId = undefined;
          }
          if (!hasEmittedError) {
            hasEmittedError = true;
            const errorText = toUserFacingErrorText(toErrorText(subscribeErr));
            this.sendMessage(session.id, {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: `**Error**: ${errorText}` }],
              timestamp: Date.now(),
            });
          }
        }
      });

      // Execute the prompt — unsubscribe in finally to prevent event listener leak
      try {
        resetActivityTimeout();
        if (provider === 'ollama') {
          log(
            '[ClaudeAgentRunner] Starting Ollama prompt',
            safeStringify({
              sessionId: session.id,
              modelId: piModel.id,
              modelProvider: piModel.provider,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
              usedSyntheticModel,
              hasExplicitApiKey: Boolean(apiKey),
              thinkingLevel,
            })
          );
        }
        const promptResult = await piSession.prompt(contextualPrompt, {
          images: piImages,
        });
        log(
          '[ClaudeAgentRunner] prompt() returned:',
          JSON.stringify(promptResult ?? 'void').substring(0, 1000)
        );
      } finally {
        try {
          unsubscribe();
        } catch (e) {
          logWarn('[ClaudeAgentRunner] unsubscribe error:', e);
        }
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        if (ollamaColdStartTimerId) clearTimeout(ollamaColdStartTimerId);
      }

      logTiming('pi-coding-agent prompt completed', runStartTime);

      // If the SDK swallowed the AbortError and returned void, detect timeout here
      if (controller.signal.aborted && abortedByTimeout) {
        logCtx('[ClaudeAgentRunner] Aborted due to timeout (detected after prompt returned)');
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: '**请求超时**：长时间未收到响应，操作已中止。' }],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);
        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request timed out',
        });
        return;
      }
      if (
        terminalErrorText &&
        /content\[\]\.thinking|thinking mode|thinking.*passed back/i.test(terminalErrorText)
      ) {
        logCtx(
          '[ClaudeAgentRunner] Clearing cached SDK session after upstream thinking payload error'
        );
        this.clearSdkSession(session.id);
      }
      // Complete - update the initial thinking step
      this.sendTraceUpdate(session.id, thinkingStepId, {
        status: terminalErrorText ? 'error' : 'completed',
        title: terminalErrorText ? 'Request failed' : 'Task completed',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (abortedByTimeout) {
          logCtx('[ClaudeAgentRunner] Aborted due to timeout');
          const errorMsg: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: '**请求超时**：长时间未收到响应，操作已中止。' }],
            timestamp: Date.now(),
          };
          this.sendMessage(session.id, errorMsg);
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Request timed out',
          });
        } else {
          logCtx('[ClaudeAgentRunner] Aborted by user');
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'completed',
            title: 'Cancelled',
          });
        }
      } else {
        logCtxError('[ClaudeAgentRunner] Error:', error);

        const errorText = toUserFacingErrorText(toErrorText(error));
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: `**Error**: ${errorText}` }],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);

        this.sendTraceStep(session.id, {
          id: uuidv4(),
          type: 'thinking',
          status: 'error',
          title: 'Error occurred',
          timestamp: Date.now(),
        });

        // Mark so session-manager doesn't report again
        if (error instanceof Error) {
          (error as Error & { alreadyReportedToUser?: boolean }).alreadyReportedToUser = true;
        }
      }
    } finally {
      this.activeControllers.delete(session.id);
      this.pathResolver.unregisterSession(session.id);

      // Sync changes from sandbox back to host OS (but don't cleanup - sandbox persists)
      if (useSandboxIsolation && sandboxPath) {
        try {
          const sandbox = getSandboxAdapter();

          if (sandbox.isWSL) {
            log('[ClaudeAgentRunner] Syncing sandbox changes to Windows...');
            const syncResult = await SandboxSync.syncToWindows(session.id);
            if (syncResult.success) {
              log('[ClaudeAgentRunner] Sync completed successfully');
            } else {
              logError('[ClaudeAgentRunner] Sync failed:', syncResult.error);
            }
          } else if (sandbox.isLima) {
            log('[ClaudeAgentRunner] Syncing sandbox changes to macOS...');
            const { LimaSync } = await import('../sandbox/lima-sync');
            const syncResult = await LimaSync.syncToMac(session.id);
            if (syncResult.success) {
              log('[ClaudeAgentRunner] Sync completed successfully');
            } else {
              logError('[ClaudeAgentRunner] Sync failed:', syncResult.error);
            }
          }
        } catch (syncErr) {
          logError('[ClaudeAgentRunner] Sandbox sync error:', syncErr);
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `**Warning**: Sandbox sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
              },
            ],
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  cancel(sessionId: string): void {
    const controller = this.activeControllers.get(sessionId);
    if (controller) controller.abort();

    // Also abort the pi-coding-agent session to cancel in-flight HTTP requests.
    // The controller abort() alone only stops processing stream events on the
    // renderer side, but the SDK's underlying fetch/HTTP call continues running.
    // piSession.abort() aborts the agent's internal operation (network I/O, tool
    // execution, etc.) and waits for it to become idle. We call it fire-and-forget
    // because SessionManager.stopSession() is synchronous.
    const cached = this.piSessions.get(sessionId);
    if (cached) {
      cached.session.abort().catch((err) => {
        logWarn('[ClaudeAgentRunner] Error aborting pi session:', err);
      });
    }
  }

  private sendTraceStep(sessionId: string, step: TraceStep): void {
    log(`[Trace] ${step.type}: ${step.title}`);
    this.sendToRenderer({ type: 'trace.step', payload: { sessionId, step } });
  }

  private sendTraceUpdate(sessionId: string, stepId: string, updates: Partial<TraceStep>): void {
    log(`[Trace] Update step ${stepId}:`, updates);
    this.sendToRenderer({ type: 'trace.update', payload: { sessionId, stepId, updates } });
  }

  private sendMessage(sessionId: string, message: Message): void {
    // Save message to database for persistence
    if (this.saveMessage) {
      this.saveMessage(message);
    }
    // Send to renderer for UI update
    this.sendToRenderer({ type: 'stream.message', payload: { sessionId, message } });
  }

  private sendPartial(sessionId: string, delta: string): void {
    this.sendToRenderer({ type: 'stream.partial', payload: { sessionId, delta } });
  }
}
