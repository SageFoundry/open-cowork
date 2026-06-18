import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import { configStore } from '../config/config-store';
import type { SessionManager } from '../session/session-manager';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import {
  closeLogFile,
  getAllLogFiles,
  getLogFilePath,
  getLogsDirectory,
  isDevLogsEnabled,
  log,
  logError,
  logWarn,
  setDevLogsEnabled,
} from '../utils/logger';
import { buildDiagnosticsSummary } from '../utils/diagnostics-summary';
import { collectEnvironmentDoctorReport } from '../runtime/environment-doctor';
import { normalizeOpenAICompatibleBaseUrl } from '../config/auth-utils';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  resolveImageInputOverride,
  resolvePiModelString,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from '../claude/pi-model-resolution';
import { redactDiagnosticText, sanitizeDiagnosticUrl } from '../utils/diagnostic-redaction';
import type { Session } from '../../renderer/types';

export interface RegisterLogHandlersDeps {
  getMainWindow: () => BrowserWindow | null;
  getCurrentWorkingDir: () => string | null;
  sanitizeDiagnosticBaseUrl: (value: string | undefined) => string | null;
  getSessionManager: () => SessionManager | null;
}

type DiagnosticThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function mapThinkingLevelForDiagnostics(
  level: DiagnosticThinkingLevel,
  model: {
    api?: string;
    thinkingLevelMap?: Record<string, string | null | undefined>;
    compat?: unknown;
  }
): DiagnosticThinkingLevel {
  if (level === 'off') {
    return 'off';
  }

  if (
    model.thinkingLevelMap &&
    Object.prototype.hasOwnProperty.call(model.thinkingLevelMap, level)
  ) {
    return level;
  }

  const compat =
    model.compat && typeof model.compat === 'object'
      ? (model.compat as Record<string, unknown>)
      : {};
  const thinkingFormat = typeof compat.thinkingFormat === 'string' ? compat.thinkingFormat : '';
  const usesReasoningEffort =
    model.api === 'openai-completions' ||
    model.api === 'openai-responses' ||
    compat.supportsReasoningEffort === true ||
    ['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen'].includes(thinkingFormat);

  if (!usesReasoningEffort) {
    return level;
  }

  if (level === 'minimal') {
    return 'low';
  }
  if (level === 'xhigh') {
    return 'high';
  }
  return level;
}

function buildPiRouteDiagnostic(session: Session) {
  try {
    const runtimeConfig = configStore.getForConfigSet(session.configSetId, {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
    });
    const routeProtocol = resolvePiRouteProtocol(
      runtimeConfig.provider,
      runtimeConfig.customProtocol
    );
    const modelString = resolvePiModelString({
      provider: routeProtocol,
      customProtocol: runtimeConfig.customProtocol,
      model: runtimeConfig.model,
    });
    const rawBaseUrl = runtimeConfig.baseUrl?.trim() || undefined;
    const effectiveBaseUrl =
      routeProtocol === 'openai' && runtimeConfig.provider !== 'ollama'
        ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
        : rawBaseUrl;

    let usedSyntheticModel = false;
    let piModel = resolvePiRegistryModel(modelString, {
      configProvider: routeProtocol,
      customBaseUrl: effectiveBaseUrl,
      rawProvider: runtimeConfig.provider,
      customProtocol: runtimeConfig.customProtocol,
    });

    if (!piModel) {
      usedSyntheticModel = true;
      const synthetic = resolveSyntheticPiModelFallback({
        rawModel: runtimeConfig.model,
        resolvedModelString: modelString,
        rawProvider: runtimeConfig.provider,
        routeProtocol,
        baseUrl: effectiveBaseUrl,
      });
      piModel = buildSyntheticPiModel(
        synthetic.modelId,
        synthetic.provider,
        routeProtocol,
        effectiveBaseUrl,
        undefined,
        undefined,
        runtimeConfig.contextWindow,
        runtimeConfig.maxTokens,
        resolveImageInputOverride(runtimeConfig.imageInputMode)
      );
      piModel = applyPiModelRuntimeOverrides(piModel, {
        configProvider: routeProtocol,
        customBaseUrl: effectiveBaseUrl,
        rawProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
      });
    }

    const requestedThinkingLevel = (runtimeConfig.thinkingLevel || 'off') as DiagnosticThinkingLevel;
    const effectiveThinkingLevel = mapThinkingLevelForDiagnostics(requestedThinkingLevel, piModel);
    const compat =
      piModel.compat && typeof piModel.compat === 'object'
        ? (piModel.compat as Record<string, unknown>)
        : {};
    const thinkingFormat = typeof compat.thinkingFormat === 'string' ? compat.thinkingFormat : null;

    return {
      sessionId: session.id,
      configSetId: session.configSetId || runtimeConfig.activeConfigSetId || null,
      requested: {
        provider: runtimeConfig.provider,
        protocol: routeProtocol,
        model: runtimeConfig.model,
        thinkingLevel: runtimeConfig.thinkingLevel || null,
      },
      resolved: {
        provider: piModel.provider || null,
        model: piModel.id || null,
        api: piModel.api || null,
        baseUrl: sanitizeDiagnosticUrl(piModel.baseUrl || effectiveBaseUrl || null),
        contextWindow: piModel.contextWindow ?? runtimeConfig.contextWindow ?? null,
        maxTokens: piModel.maxTokens ?? runtimeConfig.maxTokens ?? null,
      },
      thinking: {
        requestedLevel: requestedThinkingLevel,
        effectiveLevel: effectiveThinkingLevel,
        mappedForCompatibility: requestedThinkingLevel !== effectiveThinkingLevel,
        supportsReasoningEffort: compat.supportsReasoningEffort === true,
        thinkingFormat,
        thinkingLevelMapKeys: Object.keys(piModel.thinkingLevelMap || {}).slice(0, 12),
      },
      usedSyntheticModel,
      error: null,
    };
  } catch (error) {
    return {
      sessionId: session.id,
      configSetId: session.configSetId || null,
      requested: {
        provider: '',
        protocol: '',
        model: session.model || '',
        thinkingLevel: session.thinkingLevel || null,
      },
      resolved: {
        provider: null,
        model: null,
        api: null,
        baseUrl: null,
        contextWindow: null,
        maxTokens: null,
      },
      thinking: {
        requestedLevel: session.thinkingLevel || null,
        effectiveLevel: null,
        mappedForCompatibility: false,
        supportsReasoningEffort: false,
        thinkingFormat: null,
        thinkingLevelMapKeys: [],
      },
      usedSyntheticModel: false,
      error: error instanceof Error ? error.message : 'Unknown route diagnostic error',
    };
  }
}

export function registerLogHandlers({
  getMainWindow,
  getCurrentWorkingDir,
  sanitizeDiagnosticBaseUrl,
  getSessionManager,
}: RegisterLogHandlersDeps): void {
  ipcMain.handle('logs.getPath', () => {
    try {
      return getLogFilePath();
    } catch (error) {
      logError('[Logs] Error getting log path:', error);
      return null;
    }
  });

  ipcMain.handle('logs.getDirectory', () => {
    try {
      return getLogsDirectory();
    } catch (error) {
      logError('[Logs] Error getting logs directory:', error);
      return null;
    }
  });

  ipcMain.handle('logs.getAll', () => {
    try {
      return getAllLogFiles();
    } catch (error) {
      logError('[Logs] Error getting all log files:', error);
      return [];
    }
  });

  ipcMain.handle('diagnostics.environmentDoctor', () => {
    try {
      return { success: true, report: collectEnvironmentDoctorReport() };
    } catch (error) {
      logError('[Diagnostics] Error collecting environment doctor report:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.export', async (_event, options?: { sessionId?: string | null }) => {
    try {
      const logFiles = getAllLogFiles();
      const sessionManager = getSessionManager();
      const targetSessionId =
        typeof options?.sessionId === 'string' ? options.sessionId.trim() || null : null;
      const diagnosticsSummary = buildDiagnosticsSummary({
        targetSessionId,
        app: {
          version: app.getVersion(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          chromeVersion: process.versions.chrome,
        },
        runtime: {
          currentWorkingDir: getCurrentWorkingDir(),
          logsDirectory: getLogsDirectory(),
          logFileCount: logFiles.length,
          totalLogSizeBytes: logFiles.reduce((total, file) => total + file.size, 0),
          devLogsEnabled: isDevLogsEnabled(),
        },
        config: {
          provider: configStore.get('provider'),
          model: configStore.get('model'),
          baseUrl:
            sanitizeDiagnosticBaseUrl(configStore.get('baseUrl') || undefined) ||
            sanitizeDiagnosticUrl(configStore.get('baseUrl') || undefined),
          customProtocol: configStore.get('customProtocol') || null,
          activeConfigSetId: configStore.get('activeConfigSetId'),
          activeProfileKey: configStore.get('activeProfileKey'),
          contextWindow: configStore.get('contextWindow'),
          maxTokens: configStore.get('maxTokens'),
          memoryStrategy: configStore.get('memoryStrategy'),
          toolOutputCompressionLevel: configStore.get('toolOutputCompressionLevel'),
          sandboxEnabled: !!configStore.get('sandboxEnabled'),
          thinkingEnabled: !!configStore.get('enableThinking'),
          thinkingLevel: configStore.get('thinkingLevel'),
          apiKeyConfigured: !!configStore.get('apiKey'),
          claudeCodePathConfigured: !!configStore.get('claudeCodePath'),
          defaultWorkdir: configStore.get('defaultWorkdir') || null,
          globalSkillsPathConfigured: !!configStore.get('globalSkillsPath'),
        },
        sandbox: {
          mode: getSandboxAdapter().mode,
          initialized: getSandboxAdapter().initialized,
        },
        environmentDoctor: collectEnvironmentDoctorReport(),
        sessions: sessionManager ? sessionManager.listSessions() : [],
        logFiles,
        deps: {
          getMessages: (sessionId: string) =>
            sessionManager ? sessionManager.getMessages(sessionId) : [],
          getTraceSteps: (sessionId: string) =>
            sessionManager ? sessionManager.getTraceSteps(sessionId) : [],
          getPiRouteDiagnostic: buildPiRouteDiagnostic,
        },
      });

      const result = await dialog.showSaveDialog(getMainWindow()!, {
        title: 'Generate Support Bundle',
        defaultPath: `opencowork-support-bundle-${new Date().toISOString().split('T')[0]}.zip`,
        filters: [
          { name: 'ZIP Archive', extensions: ['zip'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'User cancelled' };
      }

      const archiver = await import('archiver');
      const output = fs.createWriteStream(result.filePath);
      const archive = archiver.default('zip', { zlib: { level: 9 } });

      return new Promise((resolve) => {
        let settled = false;
        const settle = (value: {
          success: boolean;
          path?: string;
          size?: number;
          error?: string;
        }) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };

        output.on('close', () => {
          log('[Logs] Exported logs to:', result.filePath);
          settle({
            success: true,
            path: result.filePath,
            size: archive.pointer(),
          });
        });

        output.on('error', (err: Error) => {
          logError('[Logs] Error writing exported archive:', err);
          settle({ success: false, error: err.message });
        });

        archive.on('error', (err: Error) => {
          logError('[Logs] Error creating archive:', err);
          settle({ success: false, error: err.message });
        });

        archive.pipe(output);

        for (const logFile of logFiles) {
          try {
            const logContent = fs.readFileSync(logFile.path, 'utf8');
            archive.append(redactDiagnosticText(logContent), { name: `logs/${logFile.name}` });
          } catch (err) {
            logWarn('[Logs] Failed to read log file for redacted archive:', logFile.name, err);
            archive.append(
              `Log file could not be included: ${
                err instanceof Error ? err.message : 'Unknown read error'
              }\n`,
              { name: `logs/${logFile.name}.omitted.txt` }
            );
          }
        }

        const systemInfo = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          appVersion: app.getVersion(),
          exportDate: new Date().toISOString(),
          logFiles: logFiles.map((f) => ({
            name: f.name,
            size: f.size,
            modified: f.mtime,
          })),
          privacy: {
            messageBodiesIncluded: false,
            toolInputsIncluded: false,
            toolOutputsIncluded: false,
          },
        };
        archive.append(JSON.stringify(systemInfo, null, 2), { name: 'system-info.json' });
        archive.append(JSON.stringify(diagnosticsSummary, null, 2), {
          name: 'diagnostics-summary.json',
        });
        archive.append(
          [
            'Open Cowork diagnostic bundle',
            `Exported at: ${diagnosticsSummary.exportedAt}`,
            `Target session: ${diagnosticsSummary.targetSessionId || 'latest session metadata fallback'}`,
            '',
            'Included files:',
            '- logs/*.log (redacted copies)',
            '- system-info.json',
            '- diagnostics-summary.json',
            '',
            'diagnostics-summary.json contains a redacted runtime/config snapshot,',
            'plus metadata-only session summaries, recent error traces, and redacted agent error summaries.',
            '',
            'Privacy defaults:',
            '- Message bodies are not included.',
            '- Full tool inputs and outputs are not included.',
            '- API keys, tokens, URL credentials, and local filesystem paths are redacted where detected.',
          ].join('\n'),
          { name: 'README.txt' }
        );

        archive.finalize();
      });
    } catch (error) {
      logError('[Logs] Error exporting logs:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.open', async () => {
    try {
      const logsDir = getLogsDirectory();
      await shell.openPath(logsDir);
      return { success: true };
    } catch (error) {
      logError('[Logs] Error opening logs directory:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.clear', async () => {
    try {
      const logFiles = getAllLogFiles();
      closeLogFile();

      for (const logFile of logFiles) {
        try {
          fs.unlinkSync(logFile.path);
          log('[Logs] Deleted log file:', logFile.name);
        } catch (err) {
          logError('[Logs] Failed to delete log file:', logFile.name, err);
        }
      }

      log('[Logs] Log files cleared and reinitialized');
      return { success: true, deletedCount: logFiles.length };
    } catch (error) {
      logError('[Logs] Error clearing logs:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.setEnabled', async (_event, enabled: boolean) => {
    try {
      setDevLogsEnabled(enabled);
      configStore.set('enableDevLogs', enabled);
      log('[Logs] Developer logs', enabled ? 'enabled' : 'disabled');
      return { success: true, enabled };
    } catch (error) {
      logError('[Logs] Error setting dev logs enabled:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.isEnabled', () => {
    try {
      return { success: true, enabled: isDevLogsEnabled() };
    } catch (error) {
      logError('[Logs] Error getting dev logs enabled:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.write', (_event, level: 'info' | 'warn' | 'error', args: unknown[]) => {
    try {
      if (level === 'warn') {
        logWarn(...args);
      } else if (level === 'error') {
        logError(...args);
      } else {
        log(...args);
      }
      return { success: true };
    } catch (error) {
      console.error('[Logs] Error writing log:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
}
