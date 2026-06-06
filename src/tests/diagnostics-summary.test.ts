import { describe, expect, it } from 'vitest';
import { buildDiagnosticsSummary } from '../main/utils/diagnostics-summary';
import type { Message, Session, TraceStep } from '../renderer/types';

describe('buildDiagnosticsSummary', () => {
  it('includes session runtime metadata without message bodies or full tool output', () => {
    const session: Session = {
      id: 'session-1',
      title: 'Sensitive task',
      status: 'error',
      cwd: 'C:\\Users\\alice\\secret-project',
      mountedPaths: [],
      allowedTools: [],
      memoryEnabled: true,
      model: 'deepseek-r1',
      configSetId: 'config-deepseek',
      thinkingLevel: 'xhigh',
      planMode: true,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const messages: Message[] = [
      {
        id: 'message-1',
        sessionId: session.id,
        role: 'user',
        content: [{ type: 'text', text: 'do not leak this prompt' }],
        timestamp: 1500,
      },
      {
        id: 'message-2',
        sessionId: session.id,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '**Error**: 请求被上游拒绝（400） 原始错误: 400 Param Incorrect apiKey=sk-test_abcdefghijklmnopqrstuvwxyz123456789',
          },
        ],
        timestamp: 1600,
      },
    ];
    const traceSteps: TraceStep[] = [
      {
        id: 'step-1',
        type: 'tool_result',
        status: 'error',
        title: 'Request failed: 400 Param Incorrect',
        toolName: 'bash',
        toolInput: {
          command: 'echo ok',
          apiKey: 'sk-test_abcdefghijklmnopqrstuvwxyz123456789',
        },
        toolOutput: 'do not leak this trace output',
        timestamp: 1700,
        duration: 25,
        isError: true,
      },
    ];

    const summary = buildDiagnosticsSummary({
      exportedAt: new Date('2026-01-01T00:00:00.000Z'),
      targetSessionId: session.id,
      app: {
        version: '1.0.0',
        isPackaged: false,
        platform: 'win32',
        arch: 'x64',
        nodeVersion: 'v22.0.0',
      },
      runtime: {
        currentWorkingDir: 'C:\\Users\\alice\\workspace',
        logsDirectory: 'C:\\Users\\alice\\AppData\\Roaming\\Open Cowork\\logs',
        logFileCount: 1,
        totalLogSizeBytes: 128,
        devLogsEnabled: true,
      },
      config: {
        provider: 'deepseek',
        model: 'deepseek-r1',
        baseUrl: 'https://api.deepseek.com',
        customProtocol: 'openai',
        activeConfigSetId: 'config-deepseek',
        activeProfileKey: 'deepseek',
        sandboxEnabled: true,
        thinkingEnabled: true,
        thinkingLevel: 'xhigh',
        apiKeyConfigured: true,
        claudeCodePathConfigured: false,
        defaultWorkdir: 'C:\\Users\\alice\\workspace',
        globalSkillsPathConfigured: false,
      },
      sandbox: {
        mode: 'native',
        initialized: true,
      },
      sessions: [session],
      logFiles: [],
      deps: {
        getMessages: () => messages,
        getTraceSteps: () => traceSteps,
        getPiRouteDiagnostic: () => ({
          sessionId: session.id,
          configSetId: 'config-deepseek',
          requested: {
            provider: 'deepseek',
            protocol: 'openai',
            model: 'deepseek-r1',
            thinkingLevel: 'xhigh',
          },
          resolved: {
            provider: 'deepseek',
            model: 'deepseek-r1',
            api: 'openai-completions',
            baseUrl: 'https://api.deepseek.com',
            contextWindow: 64000,
            maxTokens: null,
          },
          thinking: {
            requestedLevel: 'xhigh',
            effectiveLevel: 'high',
            mappedForCompatibility: true,
            supportsReasoningEffort: true,
            thinkingFormat: 'deepseek',
            thinkingLevelMapKeys: ['high'],
          },
          usedSyntheticModel: false,
          error: null,
        }),
      },
    });

    const serialized = JSON.stringify(summary);

    expect(summary.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(summary.targetSessionId).toBe('session-1');
    expect(summary.redaction.defaultIncludesMessageBodies).toBe(false);
    expect(summary.sessions.items[0]).toMatchObject({
      configSetId: 'config-deepseek',
      title: 'Sensitive task',
      model: 'deepseek-r1',
      thinkingLevel: 'xhigh',
      planMode: true,
    });
    expect(summary.piRouteDiagnostics[0].thinking.mappedForCompatibility).toBe(true);
    expect(summary.recentAgentErrors[0]).toMatchObject({
      httpStatus: 400,
      providerErrorCode: 'Param Incorrect',
      route: {
        provider: 'deepseek',
        protocol: 'openai',
        model: 'deepseek-r1',
        api: 'openai-completions',
      },
    });
    expect(summary.recentErrorSteps[0].toolInputKeys).toEqual(['command', 'apiKey']);
    expect(serialized).not.toContain('do not leak this prompt');
    expect(serialized).not.toContain('do not leak this trace output');
    expect(serialized).not.toContain('sk-test_abcdefghijklmnopqrstuvwxyz123456789');
  });

  it('scopes session diagnostics to the requested session', () => {
    const sessions: Session[] = [
      {
        id: 'older-session',
        title: 'Older',
        status: 'completed',
        cwd: 'C:\\workspace\\older',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: true,
        model: 'older-model',
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'target-session',
        title: 'Target',
        status: 'error',
        cwd: 'C:\\workspace\\target',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: true,
        model: 'target-model',
        configSetId: 'target-config',
        createdAt: 2000,
        updatedAt: 2000,
      },
      {
        id: 'newer-session',
        title: 'Newer',
        status: 'completed',
        cwd: 'C:\\workspace\\newer',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: true,
        model: 'newer-model',
        createdAt: 3000,
        updatedAt: 3000,
      },
    ];

    const summary = buildDiagnosticsSummary({
      exportedAt: new Date('2026-01-01T00:00:00.000Z'),
      targetSessionId: 'target-session',
      app: {
        version: '1.0.0',
        isPackaged: false,
        platform: 'win32',
        arch: 'x64',
        nodeVersion: 'v22.0.0',
      },
      runtime: {
        currentWorkingDir: null,
        logsDirectory: 'logs',
        logFileCount: 0,
        totalLogSizeBytes: 0,
        devLogsEnabled: false,
      },
      config: {
        provider: 'openai',
        model: 'global-model',
        baseUrl: null,
        customProtocol: null,
        sandboxEnabled: false,
        thinkingEnabled: false,
        apiKeyConfigured: false,
        claudeCodePathConfigured: false,
        defaultWorkdir: null,
        globalSkillsPathConfigured: false,
      },
      sandbox: {
        mode: 'native',
        initialized: false,
      },
      sessions,
      logFiles: [],
      deps: {
        getMessages: () => [],
        getTraceSteps: () => [],
      },
    });

    expect(summary.sessions.total).toBe(3);
    expect(summary.sessions.included).toBe(1);
    expect(summary.sessions.items).toHaveLength(1);
    expect(summary.sessions.items[0].id).toBe('target-session');
  });

  it('falls back to the latest session metadata when no target session is provided', () => {
    const sessions: Session[] = [
      {
        id: 'old-session',
        title: 'Old',
        status: 'completed',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: true,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'latest-session',
        title: 'Latest',
        status: 'completed',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: true,
        createdAt: 2000,
        updatedAt: 2000,
      },
    ];

    const summary = buildDiagnosticsSummary({
      app: {
        version: '1.0.0',
        isPackaged: false,
        platform: 'win32',
        arch: 'x64',
        nodeVersion: 'v22.0.0',
      },
      runtime: {
        currentWorkingDir: null,
        logsDirectory: 'logs',
        logFileCount: 0,
        totalLogSizeBytes: 0,
        devLogsEnabled: false,
      },
      config: {
        provider: 'openai',
        model: 'global-model',
        baseUrl: null,
        customProtocol: null,
        sandboxEnabled: false,
        thinkingEnabled: false,
        apiKeyConfigured: false,
        claudeCodePathConfigured: false,
        defaultWorkdir: null,
        globalSkillsPathConfigured: false,
      },
      sandbox: {
        mode: 'native',
        initialized: false,
      },
      sessions,
      logFiles: [],
      deps: {
        getMessages: () => [],
        getTraceSteps: () => [],
      },
    });

    expect(summary.targetSessionId).toBeNull();
    expect(summary.sessions.included).toBe(1);
    expect(summary.sessions.items[0].id).toBe('latest-session');
  });
});
