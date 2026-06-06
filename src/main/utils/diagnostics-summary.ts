import type { Message, Session, TraceStep } from '../../renderer/types';
import type { EnvironmentDoctorReport } from '../runtime/environment-doctor';
import {
  DIAGNOSTIC_REDACTION_VERSION,
  redactDiagnosticText,
  redactDiagnosticValue,
  redactFileSystemPath,
} from './diagnostic-redaction';

const MAX_DIAGNOSTIC_ERROR_STEPS = 20;
const MAX_RECENT_AGENT_ERRORS = 12;
const MAX_AGENT_ERROR_MESSAGE_LENGTH = 500;
const DIAGNOSTICS_BUNDLE_SCHEMA_VERSION = 2;

export interface DiagnosticLogFile {
  name: string;
  path: string;
  size: number;
  mtime: Date;
}

export interface DiagnosticsSummarySessionItem {
  id: string;
  title: string | null;
  status: Session['status'];
  cwd: string | null;
  model: string | null;
  configSetId: string | null;
  thinkingLevel: Session['thinkingLevel'] | null;
  planMode: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  traceStepCount: number;
  errorStepCount: number;
  lastUserMessageMeta: MessageMetaSummary | null;
  lastAssistantMessageMeta: MessageMetaSummary | null;
  latestErrorStep: TraceStepMetaSummary | null;
}

export interface MessageMetaSummary {
  timestamp: string | null;
  blockTypes: string[];
  textBlockCount: number;
  imageBlockCount: number;
  fileAttachmentCount: number;
  toolUseCount: number;
  toolResultCount: number;
}

export interface TraceStepMetaSummary {
  id: string;
  type: TraceStep['type'];
  status: TraceStep['status'];
  toolName: string | null;
  timestamp: string | null;
  durationMs: number | null;
  contentLength: number;
  toolOutputLength: number;
  toolInputKeys: string[];
  isError: boolean;
}

export interface PiRouteDiagnosticSummary {
  sessionId: string;
  configSetId: string | null;
  requested: {
    provider: string;
    protocol: string;
    model: string;
    thinkingLevel: string | null;
  };
  resolved: {
    provider: string | null;
    model: string | null;
    api: string | null;
    baseUrl: string | null;
    contextWindow: number | null;
    maxTokens: number | null;
  };
  thinking: {
    requestedLevel: string | null;
    effectiveLevel: string | null;
    mappedForCompatibility: boolean;
    supportsReasoningEffort: boolean;
    thinkingFormat: string | null;
    thinkingLevelMapKeys: string[];
  };
  usedSyntheticModel: boolean;
  error: string | null;
}

export interface RecentAgentErrorSummary {
  sessionId: string;
  source: 'trace_step' | 'assistant_error_message';
  stage: string | null;
  timestamp: string | null;
  httpStatus: number | null;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
  piErrorMessage: string | null;
  toolName: string | null;
  requestShape: Record<string, string> | null;
  route: {
    provider: string | null;
    protocol: string | null;
    model: string | null;
    api: string | null;
    baseUrl: string | null;
    thinkingLevel: string | null;
  } | null;
}

export interface DiagnosticsSummary {
  schemaVersion: number;
  exportedAt: string;
  targetSessionId: string | null;
  redaction: {
    version: number;
    defaultIncludesMessageBodies: false;
    defaultIncludesToolInputs: false;
    defaultIncludesToolOutputs: false;
    notes: string[];
  };
  app: {
    version: string;
    isPackaged: boolean;
    platform: string;
    arch: string;
    nodeVersion: string;
    electronVersion?: string;
    chromeVersion?: string;
  };
  runtime: {
    currentWorkingDir: string | null;
    logsDirectory: string;
    logFileCount: number;
    totalLogSizeBytes: number;
    devLogsEnabled: boolean;
  };
  config: {
    provider: string;
    model: string;
    baseUrl: string | null;
    customProtocol: string | null;
    activeConfigSetId?: string;
    activeProfileKey?: string;
    contextWindow?: number;
    maxTokens?: number;
    memoryStrategy?: string;
    toolOutputCompressionLevel?: string;
    sandboxEnabled: boolean;
    thinkingEnabled: boolean;
    thinkingLevel?: string;
    apiKeyConfigured: boolean;
    claudeCodePathConfigured: boolean;
    defaultWorkdir: string | null;
    globalSkillsPathConfigured: boolean;
  };
  sandbox: {
    mode: string;
    initialized: boolean;
  };
  environmentDoctor?: EnvironmentDoctorReport;
  sessions: {
    total: number;
    included: number;
    items: DiagnosticsSummarySessionItem[];
  };
  piRouteDiagnostics: PiRouteDiagnosticSummary[];
  recentAgentErrors: RecentAgentErrorSummary[];
  recentErrorSteps: Array<
    TraceStepMetaSummary & {
      sessionId: string;
    }
  >;
  logFiles: Array<{
    name: string;
    size: number;
    modifiedAt: string | null;
  }>;
}

export interface DiagnosticsSummaryDependencies {
  getMessages(sessionId: string): Message[];
  getTraceSteps(sessionId: string): TraceStep[];
  getPiRouteDiagnostic?(session: Session): PiRouteDiagnosticSummary;
}

export interface BuildDiagnosticsSummaryInput {
  exportedAt?: Date;
  targetSessionId?: string | null;
  app: DiagnosticsSummary['app'];
  runtime: DiagnosticsSummary['runtime'];
  config: DiagnosticsSummary['config'];
  sandbox: DiagnosticsSummary['sandbox'];
  environmentDoctor?: EnvironmentDoctorReport;
  sessions: Session[];
  logFiles: DiagnosticLogFile[];
  deps: DiagnosticsSummaryDependencies;
}

function toIsoTimestamp(value?: number | Date | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function truncateDiagnosticMessage(value: string): string {
  const trimmed = redactDiagnosticText(value).replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_AGENT_ERROR_MESSAGE_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_AGENT_ERROR_MESSAGE_LENGTH)}...`;
}

function extractHttpStatus(value: string): number | null {
  const explicit = value.match(/\b(?:status|http status|statusCode|status code)\D{0,12}([1-5]\d{2})\b/i);
  if (explicit) {
    return Number(explicit[1]);
  }
  const generic = value.match(/\b([1-5]\d{2})\b/);
  return generic ? Number(generic[1]) : null;
}

function extractProviderErrorCode(value: string): string | null {
  const codeMatch = value.match(
    /\b(?:error[_\s-]?code|code|type)\s*[:=]\s*["']?([A-Za-z0-9_.:-]{2,80})/i
  );
  if (codeMatch) {
    return codeMatch[1];
  }
  const namedCode = value.match(/\b(Param Incorrect|Bad Request|Invalid Request|Unauthorized|Forbidden|Rate Limit|Too Many Requests)\b/i);
  return namedCode ? namedCode[1] : null;
}

function extractStage(step?: TraceStep): string | null {
  if (!step) {
    return null;
  }
  if (step.toolName) {
    return `tool:${step.toolName}`;
  }
  if (step.type === 'thinking') {
    return 'agent_response';
  }
  if (step.type === 'tool_call' || step.type === 'tool_result') {
    return step.type;
  }
  return step.type || null;
}

function summarizeRequestShape(input?: Record<string, unknown>): Record<string, string> | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const redacted = redactDiagnosticValue(input) as Record<string, unknown>;
  const entries = Object.entries(redacted)
    .slice(0, 20)
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    ]);
  return Object.fromEntries(entries);
}

function routeForSession(
  routeBySessionId: Map<string, PiRouteDiagnosticSummary>,
  sessionId: string
): RecentAgentErrorSummary['route'] {
  const route = routeBySessionId.get(sessionId);
  if (!route) {
    return null;
  }
  return {
    provider: route.requested.provider || route.resolved.provider,
    protocol: route.requested.protocol,
    model: route.requested.model || route.resolved.model,
    api: route.resolved.api,
    baseUrl: route.resolved.baseUrl,
    thinkingLevel: route.thinking.effectiveLevel || route.requested.thinkingLevel,
  };
}

function buildAgentErrorFromText(input: {
  sessionId: string;
  source: RecentAgentErrorSummary['source'];
  text: string;
  timestamp: number;
  step?: TraceStep;
  route: RecentAgentErrorSummary['route'];
}): RecentAgentErrorSummary {
  const message = truncateDiagnosticMessage(input.text);
  return {
    sessionId: input.sessionId,
    source: input.source,
    stage: extractStage(input.step),
    timestamp: toIsoTimestamp(input.timestamp),
    httpStatus: extractHttpStatus(message),
    providerErrorCode: extractProviderErrorCode(message),
    providerErrorMessage: message || null,
    piErrorMessage: message || null,
    toolName: input.step?.toolName || null,
    requestShape: summarizeRequestShape(input.step?.toolInput),
    route: input.route,
  };
}

function getTextFromMessage(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function isAssistantErrorText(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^\*\*Error\*\*/i.test(trimmed) ||
    /^Error[:：]/i.test(trimmed) ||
    trimmed.includes('原始错误:') ||
    trimmed.includes('请求被上游拒绝') ||
    trimmed.includes('认证失败') ||
    trimmed.includes('请求被限流') ||
    trimmed.includes('上游服务异常')
  );
}

function summarizeMessageMeta(message?: Message): MessageMetaSummary | null {
  if (!message) {
    return null;
  }

  return {
    timestamp: toIsoTimestamp(message.timestamp),
    blockTypes: message.content.map((block) => block.type),
    textBlockCount: message.content.filter((block) => block.type === 'text').length,
    imageBlockCount: message.content.filter((block) => block.type === 'image').length,
    fileAttachmentCount: message.content.filter((block) => block.type === 'file_attachment').length,
    toolUseCount: message.content.filter((block) => block.type === 'tool_use').length,
    toolResultCount: message.content.filter((block) => block.type === 'tool_result').length,
  };
}

export function summarizeTraceStepMeta(step: TraceStep): TraceStepMetaSummary {
  return {
    id: step.id,
    type: step.type,
    status: step.status,
    toolName: step.toolName || null,
    timestamp: toIsoTimestamp(step.timestamp),
    durationMs: step.duration ?? null,
    contentLength: step.content?.length ?? 0,
    toolOutputLength: step.toolOutput?.length ?? 0,
    toolInputKeys:
      step.toolInput && typeof step.toolInput === 'object'
        ? Object.keys(redactDiagnosticValue(step.toolInput) as Record<string, unknown>).slice(0, 12)
        : [],
    isError: !!step.isError || step.status === 'error',
  };
}

function buildSessionDiagnosticSummary(
  session: Session,
  deps: DiagnosticsSummaryDependencies
): DiagnosticsSummarySessionItem {
  const messages = deps.getMessages(session.id);
  const traceSteps = deps.getTraceSteps(session.id);
  const recentMessages = [...messages].sort((a, b) => b.timestamp - a.timestamp);
  const recentUserMessage = recentMessages.find((message) => message.role === 'user');
  const recentAssistantMessage = recentMessages.find((message) => message.role === 'assistant');
  const errorSteps = traceSteps.filter((step) => step.isError || step.status === 'error');
  const latestErrorStep =
    errorSteps.length > 0
      ? [...errorSteps].sort((a, b) => b.timestamp - a.timestamp)[0]
      : undefined;

  return {
    id: session.id,
    title: session.title || null,
    status: session.status,
    cwd: redactFileSystemPath(session.cwd),
    model: session.model || null,
    configSetId: session.configSetId || null,
    thinkingLevel: session.thinkingLevel || null,
    planMode: !!session.planMode,
    createdAt: toIsoTimestamp(session.createdAt),
    updatedAt: toIsoTimestamp(session.updatedAt),
    messageCount: messages.length,
    traceStepCount: traceSteps.length,
    errorStepCount: errorSteps.length,
    lastUserMessageMeta: summarizeMessageMeta(recentUserMessage),
    lastAssistantMessageMeta: summarizeMessageMeta(recentAssistantMessage),
    latestErrorStep: latestErrorStep ? summarizeTraceStepMeta(latestErrorStep) : null,
  };
}

export function buildDiagnosticsSummary(input: BuildDiagnosticsSummaryInput): DiagnosticsSummary {
  const sessions = [...input.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const targetSessionId = input.targetSessionId?.trim() || null;
  const targetSession = targetSessionId
    ? sessions.find((session) => session.id === targetSessionId)
    : undefined;
  const selectedSessions = targetSession
    ? [targetSession]
    : sessions.slice(0, targetSessionId ? 0 : 1);
  const sessionSummaries = selectedSessions.map((session) =>
    buildSessionDiagnosticSummary(session, input.deps)
  );
  const piRouteDiagnostics = input.deps.getPiRouteDiagnostic
    ? selectedSessions.map((session) => input.deps.getPiRouteDiagnostic!(session))
    : [];
  const routeBySessionId = new Map(piRouteDiagnostics.map((route) => [route.sessionId, route]));

  const recentErrorStepPairs = selectedSessions
    .flatMap((session) =>
      input.deps
        .getTraceSteps(session.id)
        .filter((step) => step.isError || step.status === 'error')
        .map((step) => ({
          sessionId: session.id,
          step,
        }))
    )
    .sort((a, b) => b.step.timestamp - a.step.timestamp)
    .slice(0, MAX_DIAGNOSTIC_ERROR_STEPS);
  const recentErrorSteps = recentErrorStepPairs
    .map(({ sessionId, step }) => ({
      sessionId,
      ...summarizeTraceStepMeta(step),
    }));
  const traceAgentErrors = recentErrorStepPairs.map(({ sessionId, step }) =>
    buildAgentErrorFromText({
      sessionId,
      source: 'trace_step',
      text: [step.title, step.content].filter(Boolean).join('\n'),
      timestamp: step.timestamp,
      step,
      route: routeForSession(routeBySessionId, sessionId),
    })
  );
  const messageAgentErrors = selectedSessions.flatMap((session) =>
    input.deps
      .getMessages(session.id)
      .filter((message) => message.role === 'assistant')
      .map((message) => ({ message, text: getTextFromMessage(message) }))
      .filter(({ text }) => isAssistantErrorText(text))
      .map(({ message, text }) =>
        buildAgentErrorFromText({
          sessionId: session.id,
          source: 'assistant_error_message',
          text,
          timestamp: message.timestamp,
          route: routeForSession(routeBySessionId, session.id),
        })
      )
  );
  const recentAgentErrors = [...traceAgentErrors, ...messageAgentErrors]
    .sort((a, b) => {
      const at = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
      return bt - at;
    })
    .slice(0, MAX_RECENT_AGENT_ERRORS);

  return {
    schemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
    exportedAt: (input.exportedAt || new Date()).toISOString(),
    targetSessionId,
    redaction: {
      version: DIAGNOSTIC_REDACTION_VERSION,
      defaultIncludesMessageBodies: false,
      defaultIncludesToolInputs: false,
      defaultIncludesToolOutputs: false,
      notes: [
        'Message bodies, full tool inputs, and full tool outputs are excluded by default.',
        'Secrets and local filesystem paths are redacted or summarized before entering JSON diagnostics.',
      ],
    },
    app: input.app,
    runtime: {
      ...input.runtime,
      currentWorkingDir: redactFileSystemPath(input.runtime.currentWorkingDir),
      logsDirectory:
        redactFileSystemPath(input.runtime.logsDirectory) || input.runtime.logsDirectory,
    },
    config: {
      ...input.config,
      defaultWorkdir: redactFileSystemPath(input.config.defaultWorkdir),
    },
    sandbox: input.sandbox,
    environmentDoctor: input.environmentDoctor,
    sessions: {
      total: sessions.length,
      included: sessionSummaries.length,
      items: sessionSummaries,
    },
    piRouteDiagnostics,
    recentAgentErrors,
    recentErrorSteps,
    logFiles: input.logFiles.map((file) => ({
      name: file.name,
      size: file.size,
      modifiedAt: toIsoTimestamp(file.mtime),
    })),
  };
}
