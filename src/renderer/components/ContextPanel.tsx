import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { resolveArtifactPath } from '../utils/artifact-path';
import { getProjectIdForCwd } from '../utils/projects';
import {
  extractFilePathFromToolInput,
  extractFilePathFromToolOutput,
} from '../utils/tool-output-path';
import {
  getArtifactLabel,
  getArtifactIconComponent,
  getArtifactSteps,
} from '../utils/artifact-steps';
import { useIPC } from '../hooks/useIPC';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileSpreadsheet,
  FilePieChart,
  FileCode2,
  FileArchive,
  FileAudio2,
  FileVideo,
  Image as ImageIcon,
  FolderOpen,
  FolderSync,
  File,
  Check,
  Loader2,
  Plug,
  Wrench,
  MessageSquare,
  Cpu,
  Copy,
  Layers,
  Terminal,
  Square,
  ExternalLink,
} from 'lucide-react';
import type { TraceStep, MCPServerInfo, BackgroundTask } from '../types';

const EMPTY_STEPS: TraceStep[] = [];

export function ContextPanel() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const sessionStates = useAppStore((s) => s.sessionStates);
  const backgroundTasks = useAppStore((s) => s.backgroundTasks);
  const backgroundTaskLogs = useAppStore((s) => s.backgroundTaskLogs);
  const appConfig = useAppStore((s) => s.appConfig);
  const contextPanelCollapsed = useAppStore((s) => s.contextPanelCollapsed);
  const toggleContextPanel = useAppStore((s) => s.toggleContextPanel);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const { getMCPServers, changeWorkingDir, compactSession, getBackgroundTaskLogTail, stopBackgroundTask } = useIPC();
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState(true);
  const [expandedConnector, setExpandedConnector] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isChangingDir, setIsChangingDir] = useState(false);
  const [recentWorkspaceFiles, setRecentWorkspaceFiles] = useState<
    Array<{
      path: string;
      modifiedAt: number;
      size: number;
    }>
  >([]);
  const ss = activeSessionId ? sessionStates[activeSessionId] : undefined;
  const steps = ss?.traceSteps ?? EMPTY_STEPS;
  const tokenBudget = ss?.tokenBudget ?? null;
  const latestCompaction = ss?.latestCompaction ?? null;
  const compactionState = ss?.compactionState ?? null;
  const isCompacting = Boolean(compactionState);

  const handleCopyPath = async (path: string) => {
    try {
      // Escape spaces for shell usage so the path can be pasted into terminal
      let shellPath = path;
      if (path.includes(' ')) {
        const isWindows = window.electronAPI?.platform === 'win32';
        shellPath = isWindows ? `"${path}"` : path.replace(/ /g, '\\ ');
      }
      await navigator.clipboard.writeText(shellPath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const handleOpenWorkingDir = async () => {
    if (!currentWorkingDir || !window.electronAPI?.openPath) {
      return;
    }

    const opened = await window.electronAPI.openPath(currentWorkingDir);
    if (!opened) {
      setGlobalNotice({
        id: `open-working-dir-failed-${Date.now()}`,
        type: 'warning',
        message: t('context.revealFailed'),
      });
    }
  };

  const handleCompactNow = async () => {
    if (!activeSessionId || ss?.compactionState) {
      return;
    }

    const confirmed = window.confirm(
      '这会创建新的压缩快照并重建运行时上下文，完整聊天记录不会删除。现在继续吗？'
    );

    if (!confirmed) {
      return;
    }

    try {
      await compactSession(activeSessionId);
    } catch (error) {
      setGlobalNotice({
        id: `compact-failed-${Date.now()}`,
        type: 'error',
        message:
          error instanceof Error && error.message
            ? `上下文压缩失败：${error.message}`
            : '上下文压缩失败，请稍后重试。',
      });
    }
  };

  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  const currentWorkingDir = activeSession?.cwd || workingDir;
  const activeProjectId = getProjectIdForCwd(currentWorkingDir);
  const { displayArtifactSteps } = getArtifactSteps(steps);
  const canShowItemInFolder =
    typeof window !== 'undefined' && !!window.electronAPI?.showItemInFolder;

  // Session info computations
  const messages = useMemo(
    () => (activeSessionId ? sessionStates[activeSessionId]?.messages || [] : []),
    [activeSessionId, sessionStates]
  );
  const messageCount = messages.length;
  const toolCallCount = steps.filter((s) => s.type === 'tool_call').length;
  const modelName = activeSession?.model || appConfig?.model || '—';
  const activeContextWindow = activeSessionId ? sessionStates[activeSessionId]?.contextWindow : 0;

  // Token usage aggregation
  const tokenUsage = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const msg of messages) {
      if (msg.tokenUsage) {
        input += msg.tokenUsage.input || 0;
        output += msg.tokenUsage.output || 0;
        cacheRead += msg.tokenUsage.cacheRead || 0;
        cacheWrite += msg.tokenUsage.cacheWrite || 0;
      }
    }
    return { input, output, cacheRead, cacheWrite, total: input + output };
  }, [messages]);

  // Context usage: prefer main-process budget snapshot over heuristic aggregation
  const contextUsage = useMemo(() => {
    if (!tokenBudget) return null;
    const percentage = Math.min(tokenBudget.usageRatio * 100, 100);
    return {
      used: tokenBudget.estimatedTotalTokens,
      total: tokenBudget.maxContextTokens,
      percentage,
      state: tokenBudget.warningState,
    };
  }, [tokenBudget]);

  const completedStepCount = useMemo(
    () => steps.reduce((n, s) => n + (s.status === 'completed' ? 1 : 0), 0),
    [steps]
  );
  const isActiveBackgroundTask = useCallback(
    (task: BackgroundTask) =>
      task.status === 'queued' ||
      task.status === 'starting' ||
      task.status === 'running' ||
      task.status === 'stopping',
    []
  );
  const visibleBackgroundTasks = useMemo(() => {
    return backgroundTasks
      .filter((task) => isActiveBackgroundTask(task))
      .sort((a, b) => {
        const aInProject = getProjectIdForCwd(a.cwd) === activeProjectId;
        const bInProject = getProjectIdForCwd(b.cwd) === activeProjectId;
        if (aInProject !== bInProject) {
          return aInProject ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      });
  }, [activeProjectId, backgroundTasks, isActiveBackgroundTask]);
  const runningBackgroundTaskCount = useMemo(
    () => visibleBackgroundTasks.length,
    [visibleBackgroundTasks]
  );

  useEffect(() => {
    if (contextPanelCollapsed) {
      return;
    }
    if (
      typeof window === 'undefined' ||
      !window.electronAPI?.artifacts?.listRecentFiles ||
      !currentWorkingDir ||
      !activeSession?.createdAt
    ) {
      setRecentWorkspaceFiles([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const files = await window.electronAPI.artifacts.listRecentFiles(
          currentWorkingDir,
          activeSession.createdAt,
          50
        );
        if (!cancelled) {
          setRecentWorkspaceFiles(files || []);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load recent workspace files:', error);
          setRecentWorkspaceFiles([]);
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    activeSession?.createdAt,
    activeSessionId,
    steps.length,
    completedStepCount,
    contextPanelCollapsed,
    currentWorkingDir,
  ]);

  const displayArtifacts = useMemo(() => {
    const seenPaths = new Set<string>();
    const items: Array<{ label: string; path: string }> = [];

    for (const step of displayArtifactSteps) {
      const fallbackPath =
        extractFilePathFromToolOutput(step.toolOutput) ||
        extractFilePathFromToolInput(step.toolInput);
      if (!fallbackPath) {
        continue;
      }

      const resolvedPath = resolveArtifactPath(fallbackPath, currentWorkingDir);
      const key = resolvedPath.trim();
      if (!key || seenPaths.has(key)) {
        continue;
      }

      seenPaths.add(key);
      items.push({
        label: getArtifactLabel(fallbackPath),
        path: resolvedPath,
      });
    }

    for (const file of recentWorkspaceFiles) {
      const resolvedPath = resolveArtifactPath(file.path, currentWorkingDir);
      const key = resolvedPath.trim();
      if (!key || seenPaths.has(key)) {
        continue;
      }

      seenPaths.add(key);
      items.push({
        label: getArtifactLabel(file.path),
        path: resolvedPath,
      });
    }

    return items;
  }, [currentWorkingDir, displayArtifactSteps, recentWorkspaceFiles]);

  useEffect(() => {
    if (contextPanelCollapsed) {
      return;
    }
    const loadMCPServers = async () => {
      try {
        const servers = await getMCPServers();
        setMcpServers(servers || []);
      } catch (error) {
        console.error('Failed to load MCP servers:', error);
      }
    };
    loadMCPServers();
    const interval = setInterval(loadMCPServers, 30000);
    return () => clearInterval(interval);
  }, [contextPanelCollapsed, getMCPServers]);

  const handleTaskToggle = useCallback(
    async (taskId: string) => {
      const nextTaskId = expandedTaskId === taskId ? null : taskId;
      setExpandedTaskId(nextTaskId);
      if (!nextTaskId || backgroundTaskLogs[nextTaskId]) {
        return;
      }
      setLoadingTaskId(nextTaskId);
      try {
        await getBackgroundTaskLogTail(nextTaskId);
      } finally {
        setLoadingTaskId((current) => (current === nextTaskId ? null : current));
      }
    },
    [backgroundTaskLogs, expandedTaskId, getBackgroundTaskLogTail]
  );

  const handleOpenTaskLog = useCallback(async (taskId: string) => {
    await window.electronAPI.tasks.openLog(taskId);
  }, []);

  const handleOpenTaskUrl = useCallback(async (taskId: string) => {
    await window.electronAPI.tasks.openDetectedUrl(taskId);
  }, []);

  const handleStopTask = useCallback(
    async (taskId: string) => {
      await stopBackgroundTask(taskId);
    },
    [stopBackgroundTask]
  );

  if (contextPanelCollapsed) {
    return (
      <div className="w-10 bg-background border-l border-border-muted flex items-start justify-center pt-3">
        <button
          onClick={toggleContextPanel}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.expandPanel')}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 bg-background border-l border-border-muted flex flex-col overflow-hidden text-sm">
      {/* Header */}
      <div className="px-3 h-10 flex items-center gap-2 border-b border-border-muted shrink-0">
        <button
          onClick={toggleContextPanel}
          className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.collapsePanel')}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {t('context.context')}
        </span>
      </div>

      {/* Session Stats */}
      {activeSession && (
        <div className="px-4 py-3 border-b border-border-muted space-y-1.5">
          <div className="flex items-center gap-1.5 text-text-primary font-medium">
            <Cpu className="w-3.5 h-3.5 text-text-muted shrink-0" />
            <span className="truncate">{modelName}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted pl-5">
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {messageCount}
            </span>
            <span className="flex items-center gap-1">
              <Wrench className="w-3 h-3" />
              {toolCallCount}
            </span>
            {tokenUsage.total > 0 && (
              <span className="ml-auto text-text-muted/70">
                {t('context.inputTokens')} {formatTokenCount(tokenUsage.input)} ·{' '}
                {t('context.outputTokens')} {formatTokenCount(tokenUsage.output)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Context Usage */}
      {activeSession && (
        <div className="px-4 py-2.5 border-b border-border-muted space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              {t('context.contextUsage')}
            </span>
            {contextUsage ? (
              <span
                className={`text-xs font-medium ${
                  contextUsage.state === 'blocking' || contextUsage.state === 'error'
                    ? 'text-error'
                    : contextUsage.state === 'warning'
                      ? 'text-warning'
                      : 'text-text-primary'
                }`}
              >
                {Math.round(contextUsage.percentage)}%
              </span>
            ) : (
              <span className="text-xs font-medium text-text-muted">--</span>
            )}
          </div>
          <div className="h-1.5 bg-surface-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                !contextUsage
                  ? 'bg-border-muted'
                  : contextUsage.state === 'blocking' || contextUsage.state === 'error'
                    ? 'bg-error'
                    : contextUsage.state === 'warning'
                      ? 'bg-warning'
                      : 'bg-gradient-to-r from-accent to-accent-hover'
              }`}
              style={{ width: `${contextUsage ? contextUsage.percentage : 0}%` }}
            />
          </div>
          {contextUsage ? (
            <div className="space-y-1">
              <p className="text-xs text-text-muted">
                {t('context.contextUsageLabel', {
                  used: formatTokenCount(contextUsage.used),
                  total: formatTokenCount(contextUsage.total),
                })}
              </p>
              {tokenBudget && (
                <>
                  <p className="text-[11px] text-text-muted">
                    Conversation {formatTokenCount(tokenBudget.estimatedConversationTokens)} ·
                    Reserve {formatTokenCount(tokenBudget.reserveTokens)}
                  </p>
                  <p className="text-[11px] text-text-muted">
                    Window {formatTokenCount(activeContextWindow || tokenBudget.contextWindow)} ·
                    Status {tokenBudget.warningState}
                  </p>
                </>
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="min-w-0 text-[11px] text-text-muted">
                  {latestCompaction ? (
                    <span className="truncate block">
                      Last compact: {latestCompaction.compactionType} ·{' '}
                      {new Date(latestCompaction.createdAt).toLocaleTimeString()}
                    </span>
                  ) : (
                    <span>No compaction yet</span>
                  )}
                </div>
                <button
                  onClick={handleCompactNow}
                  disabled={!activeSessionId || isCompacting}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border-muted text-[11px] text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCompacting && <Loader2 className="w-3 h-3 animate-spin" />}
                  <span>{isCompacting ? 'Compacting...' : 'Compact Now'}</span>
                </button>
              </div>
              {isCompacting && (
                <div className="flex items-center gap-1.5 rounded-md bg-surface-muted px-2 py-1.5 text-[11px] text-text-muted">
                  <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  <span>{compactionState?.message || '正在创建压缩快照并重建运行时上下文…'}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-muted">
              {activeContextWindow
                ? t('context.contextUsageWaiting')
                : t('context.contextUsageUnavailable')}
            </p>
          )}
        </div>
      )}

      {/* Background Tasks Section */}
      <div className="border-b border-border-muted">
        <button
          onClick={() => setBackgroundTasksOpen(!backgroundTasksOpen)}
          className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
        >
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5" />
            {t('context.backgroundTasks')}
            {runningBackgroundTaskCount > 0 && (
              <span className="text-[10px] leading-4 px-1.5 rounded-full bg-accent-muted text-accent">
                {runningBackgroundTaskCount}
              </span>
            )}
          </span>
          {backgroundTasksOpen ? (
            <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          )}
        </button>

        {backgroundTasksOpen && (
          <div className="pb-2 max-h-72 overflow-y-auto">
            {visibleBackgroundTasks.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-text-muted">
                <Terminal className="w-3.5 h-3.5 shrink-0" />
                <span>{t('context.noBackgroundTasks')}</span>
              </div>
            ) : (
              <div className="space-y-2 px-3 pb-2">
                {visibleBackgroundTasks.map((task) => {
                  const isExpanded = expandedTaskId === task.id;
                  const taskLog = backgroundTaskLogs[task.id] || '';
                  const isRunning = task.status === 'running' || task.status === 'starting';
                  return (
                    <div
                      key={task.id}
                      className="rounded-xl border border-border-subtle bg-background/40 overflow-hidden"
                    >
                      <button
                        onClick={() => void handleTaskToggle(task.id)}
                        className="w-full px-3 py-2.5 text-left hover:bg-surface-hover/60 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              task.status === 'running'
                                ? 'bg-emerald-500'
                                : task.status === 'starting'
                                  ? 'bg-amber-500'
                                  : task.status === 'failed'
                                    ? 'bg-red-500'
                                    : task.status === 'lost'
                                      ? 'bg-orange-500'
                                      : 'bg-text-muted/60'
                            }`}
                          />
                          <span className="min-w-0 flex-1 text-[13px] font-medium text-text-primary truncate">
                            {task.title}
                          </span>
                          <span className="text-[11px] text-text-muted flex-shrink-0">
                            {formatTaskDuration(task)}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-text-muted truncate">
                          {formatTaskStatus(task)}
                        </div>
                        {getProjectIdForCwd(task.cwd) !== activeProjectId && (
                          <div className="mt-1 text-[11px] text-text-muted/80 truncate">
                            {task.cwd}
                          </div>
                        )}
                        {task.detectedUrl && (
                          <div className="mt-1 text-[11px] text-accent truncate">
                            {task.detectedUrl}
                          </div>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="border-t border-border-subtle px-3 py-3 space-y-2.5 bg-background/55">
                          <div className="flex items-center gap-2 flex-wrap">
                            {task.detectedUrl && (
                              <button
                                onClick={() => void handleOpenTaskUrl(task.id)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                              >
                                <ExternalLink className="w-3 h-3" />
                                {t('context.openUrl')}
                              </button>
                            )}
                            <button
                              onClick={() => void handleOpenTaskLog(task.id)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                            >
                              <FileText className="w-3 h-3" />
                              {t('context.openLog')}
                            </button>
                            {isRunning && (
                              <button
                                onClick={() => void handleStopTask(task.id)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-error hover:bg-error/10 transition-colors"
                              >
                                <Square className="w-3 h-3 fill-current" />
                                {t('context.stopTask')}
                              </button>
                            )}
                          </div>
                          <div className="rounded-lg border border-border-subtle bg-surface/70 p-2.5">
                            <div className="text-[11px] text-text-muted mb-1.5">
                              {t('context.logTail')}
                            </div>
                            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-text-secondary font-mono">
                              {loadingTaskId === task.id
                                ? t('context.loadingLogs')
                                : taskLog || t('context.noLogsYet')}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Artifacts Section */}
      <div className="border-b border-border-muted">
        <button
          onClick={() => setArtifactsOpen(!artifactsOpen)}
          className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
        >
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
            {t('context.artifacts')}
          </span>
          {artifactsOpen ? (
            <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          )}
        </button>

        {artifactsOpen && (
          <div className="pb-2 max-h-64 overflow-y-auto">
            {displayArtifacts.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-text-muted">
                <Layers className="w-3.5 h-3.5 shrink-0" />
                <span>{t('context.noArtifactsYet')}</span>
              </div>
            ) : (
              <div>
                {displayArtifacts.map((artifact, index) => {
                  const label = artifact.label || t('context.fileCreated');
                  const artifactPath = artifact.path;
                  const canClick = Boolean(artifactPath && canShowItemInFolder);
                  const iconComponent = getArtifactIconComponent(label);
                  const IconComponent =
                    iconComponent === 'presentation'
                      ? FilePieChart
                      : iconComponent === 'table'
                        ? FileSpreadsheet
                        : iconComponent === 'document'
                          ? FileText
                          : iconComponent === 'code'
                            ? FileCode2
                            : iconComponent === 'image'
                              ? ImageIcon
                              : iconComponent === 'audio'
                                ? FileAudio2
                                : iconComponent === 'video'
                                  ? FileVideo
                                  : iconComponent === 'archive'
                                    ? FileArchive
                                    : iconComponent === 'text'
                                      ? File
                                      : File;

                  return (
                    <div
                      key={artifact.path || artifact.label || `artifact-${index}`}
                      className={`flex items-center gap-2 px-4 py-1.5 transition-colors ${canClick ? 'cursor-pointer hover:bg-surface-hover' : ''}`}
                      onClick={async () => {
                        if (!canClick) return;
                        const revealed = await window.electronAPI.showItemInFolder(
                          artifactPath,
                          currentWorkingDir ?? undefined
                        );
                        if (!revealed) {
                          setGlobalNotice({
                            id: `artifact-reveal-failed-${Date.now()}`,
                            type: 'warning',
                            message: t('context.revealFailed'),
                          });
                        }
                      }}
                      title={artifactPath || undefined}
                    >
                      <IconComponent className="w-3.5 h-3.5 text-text-muted shrink-0" />
                      <span className="text-xs text-text-primary truncate">{label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Working Directory */}
      <div className="border-b border-border-muted">
        <div className="px-4 py-2.5">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
            {t('context.workingDirectory')}
          </p>
          <div className="flex items-center gap-1.5 min-w-0">
            <FolderOpen className="w-3.5 h-3.5 text-text-muted shrink-0" />
            <span
              className={`text-xs truncate flex-1 ${currentWorkingDir ? 'text-text-primary cursor-pointer hover:text-accent-primary transition-colors' : 'text-text-muted'}`}
              title={currentWorkingDir ? t('context.openInFileManager') : ''}
              onClick={handleOpenWorkingDir}
            >
              {currentWorkingDir ? formatPath(currentWorkingDir) : t('context.noFolderSelected')}
            </span>
            {currentWorkingDir && (
              <button
                onClick={() => handleCopyPath(currentWorkingDir)}
                className="text-text-muted hover:text-text-primary transition-colors shrink-0 ml-1"
                title={t('context.copyPath')}
              >
                {copiedPath ? (
                  <Check className="w-3 h-3 text-success" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            )}
            <button
              onClick={async () => {
                setIsChangingDir(true);
                try {
                  const result = await changeWorkingDir(
                    activeSessionId || undefined,
                    currentWorkingDir || undefined
                  );
                  if (!result.success && result.error && result.error !== 'User cancelled') {
                    setGlobalNotice({
                      id: `change-dir-failed-${Date.now()}`,
                      type: 'warning',
                      message: `${t('context.changeDirFailed')}: ${result.error}`,
                    });
                  }
                } catch (error) {
                  setGlobalNotice({
                    id: `change-dir-failed-${Date.now()}`,
                    type: 'error',
                    message:
                      error instanceof Error && error.message
                        ? `${t('context.changeDirFailed')}: ${error.message}`
                        : t('context.changeDirFailed'),
                  });
                } finally {
                  setIsChangingDir(false);
                }
              }}
              disabled={isChangingDir}
              className="text-text-muted hover:text-text-primary disabled:opacity-50 transition-colors shrink-0"
              title={t('context.changeDir')}
            >
              {isChangingDir ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <FolderSync className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* MCP Connectors */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2.5">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
            {t('context.mcpConnectors')}
          </p>
          {mcpServers.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-text-muted py-1">
              <Plug className="w-3.5 h-3.5 shrink-0" />
              <span>{t('mcp.noConnectors')}</span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {mcpServers.map((server) => (
                <ConnectorItem
                  key={server.id}
                  server={server}
                  steps={steps}
                  expanded={expandedConnector === server.id}
                  onToggle={() =>
                    setExpandedConnector(expandedConnector === server.id ? null : server.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectorItem({
  server,
  steps,
  expanded,
  onToggle,
}: {
  server: MCPServerInfo;
  steps: TraceStep[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // Get MCP tools used from this server
  // Tool names are in format: mcp__ServerName__toolname (with double underscores)
  // Server name preserves original case and spaces are replaced with underscores
  const serverNamePattern = server.name.replace(/\s+/g, '_');

  const mcpToolsUsed = steps
    .filter((s) => s.toolName?.startsWith('mcp__'))
    .map((s) => s.toolName!)
    .filter((name, index, self) => self.indexOf(name) === index)
    .filter((name) => {
      // Check if this tool belongs to this server
      // Format: mcp__ServerName__toolname
      const match = name.match(/^mcp__(.+?)__(.+)$/);
      if (match) {
        const toolServerName = match[1];
        return toolServerName === serverNamePattern;
      }
      return false;
    });

  const usageCount = steps.filter(
    (s) => s.toolName?.startsWith('mcp__') && mcpToolsUsed.includes(s.toolName)
  ).length;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className={`w-full px-3 py-2 flex items-center gap-2 transition-colors ${
          server.connected ? 'bg-mcp/10 hover:bg-mcp/20' : 'bg-surface-muted hover:bg-surface-hover'
        }`}
      >
        <div
          className={`w-6 h-6 rounded flex items-center justify-center ${
            server.connected ? 'bg-mcp/20' : 'bg-surface-muted'
          }`}
        >
          <Plug className={`w-3.5 h-3.5 ${server.connected ? 'text-mcp' : 'text-text-muted'}`} />
        </div>
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{server.name}</span>
            {!server.connected && (
              <span className="text-xs text-text-muted">({t('mcp.notConnected')})</span>
            )}
          </div>
          {server.connected && (
            <p className="text-xs text-text-muted">
              {t('mcp.toolCount', { count: server.toolCount })}
              {usageCount > 0 && ` • ${t('mcp.callCount', { count: usageCount })}`}
            </p>
          )}
        </div>
        {server.connected &&
          (expanded ? (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          ))}
      </button>

      {expanded && server.connected && (
        <div className="px-3 pb-2 space-y-1 bg-surface">
          {mcpToolsUsed.length > 0 ? (
            <>
              <p className="text-xs text-text-muted px-2 py-1">{t('context.toolsUsedLabel')}</p>
              {mcpToolsUsed.map((toolName, index) => {
                const count = steps.filter((s) => s.toolName === toolName).length;
                // Extract readable tool name - remove mcp__ServerName__ prefix
                const match = toolName.match(/^mcp__(.+?)__(.+)$/);
                const readableName = match ? match[2] : toolName;

                return (
                  <div
                    key={index}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-mcp/5 hover:bg-mcp/10 transition-colors"
                  >
                    <Wrench className="w-3.5 h-3.5 text-mcp" />
                    <span className="text-xs text-text-primary flex-1">{readableName}</span>
                    <span className="text-xs text-text-muted">{count}x</span>
                  </div>
                );
              })}
            </>
          ) : (
            <p className="text-xs text-text-muted px-2 py-1">{t('context.noToolsUsedYet')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Format long paths to show abbreviated version
function formatPath(path: string): string {
  if (!path) return '';

  // Windows: Replace C:\Users\username with ~
  const winHome = /^[A-Z]:\\Users\\[^\\]+/i;
  const winMatch = path.match(winHome);
  if (winMatch) {
    return '~' + path.slice(winMatch[0].length).replace(/\\/g, '/');
  }

  // macOS/Linux: Replace /Users/username or /home/username with ~
  const unixHome = /^\/(?:Users|home)\/[^/]+/;
  const unixMatch = path.match(unixHome);
  if (unixMatch) {
    return '~' + path.slice(unixMatch[0].length);
  }

  return path;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTaskStatus(task: BackgroundTask): string {
  switch (task.status) {
    case 'queued':
      return 'Queued';
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'stopping':
      return 'Stopping';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'lost':
      return 'Lost';
    default:
      return task.status;
  }
}

function formatTaskDuration(task: BackgroundTask): string {
  const end = task.endedAt ?? Date.now();
  const diff = Math.max(0, end - task.startedAt);
  const minute = 60_000;
  const hour = 60 * minute;

  if (diff < minute) {
    return `${Math.max(1, Math.floor(diff / 1000))}s`;
  }
  if (diff < hour) {
    return `${Math.floor(diff / minute)}m`;
  }
  return `${Math.floor(diff / hour)}h`;
}
