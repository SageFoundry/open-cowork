import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import type {
  AppConfig,
  ClientEvent,
  ServerEvent,
  PermissionResult,
  Session,
  Message,
  TraceStep,
  ContentBlock,
  SessionMessagesPage,
  SessionCompactionInfo,
  TokenBudgetSnapshot,
  BackgroundTask,
  BackgroundTaskStartInput,
  ForkSessionResult,
} from '../types';
import i18n from '../i18n/config';

// Check if running in Electron
const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

let ipcListenerRefCount = 0;
let ipcListenerCleanup: (() => void) | null = null;

export function useIPC() {
  // Handle incoming server events - only setup once
  useEffect(() => {
    if (!isElectron) {
      return;
    }

    ipcListenerRefCount += 1;
    if (ipcListenerCleanup) {
      return () => {
        ipcListenerRefCount = Math.max(0, ipcListenerRefCount - 1);
        if (ipcListenerRefCount === 0) {
          ipcListenerCleanup?.();
          ipcListenerCleanup = null;
        }
      };
    }

    let disposed = false;

    // --- RAF batching for high-frequency events ---
    const pendingPartials: Record<string, string[]> = {};
    let partialRafId: number | null = null;

    const pendingThinking: Record<string, string[]> = {};
    let thinkingRafId: number | null = null;

    const flushPartials = () => {
      partialRafId = null;
      const store = useAppStore.getState();
      for (const sessionId in pendingPartials) {
        const chunks = pendingPartials[sessionId];
        if (chunks.length > 0) {
          store.setPartialMessage(sessionId, chunks.join(''));
          pendingPartials[sessionId] = [];
        }
      }
    };

    const bufferPartial = (sessionId: string, delta: string) => {
      if (!pendingPartials[sessionId]) pendingPartials[sessionId] = [];
      pendingPartials[sessionId].push(delta);
      if (partialRafId === null) {
        partialRafId = requestAnimationFrame(flushPartials);
      }
    };

    const flushThinking = () => {
      thinkingRafId = null;
      const store = useAppStore.getState();
      for (const sessionId in pendingThinking) {
        const chunks = pendingThinking[sessionId];
        if (chunks.length > 0) {
          store.setPartialThinking(sessionId, chunks.join(''));
          pendingThinking[sessionId] = [];
        }
      }
    };

    const bufferThinking = (sessionId: string, delta: string) => {
      if (!pendingThinking[sessionId]) pendingThinking[sessionId] = [];
      pendingThinking[sessionId].push(delta);
      if (thinkingRafId === null) {
        thinkingRafId = requestAnimationFrame(flushThinking);
      }
    };

    type TraceAction =
      | { kind: 'add'; sessionId: string; step: TraceStep }
      | { kind: 'update'; sessionId: string; stepId: string; updates: Partial<TraceStep> };
    let pendingTraces: TraceAction[] = [];
    let traceRafId: number | null = null;

    const flushTraces = () => {
      traceRafId = null;
      const store = useAppStore.getState();
      for (const action of pendingTraces) {
        if (action.kind === 'add') {
          store.addTraceStep(action.sessionId, action.step);
        } else {
          store.updateTraceStep(action.sessionId, action.stepId, action.updates);
        }
      }
      pendingTraces = [];
    };

    const bufferTrace = (action: TraceAction) => {
      pendingTraces.push(action);
      if (traceRafId === null) {
        traceRafId = requestAnimationFrame(flushTraces);
      }
    };

    const applyConfigSnapshot = (config: AppConfig, isConfigured: boolean) => {
      const store = useAppStore.getState();
      const isInitialConfigStatus = !store.hasSeenInitialConfigStatus;
      store.setIsConfigured(isConfigured);
      store.setAppConfig(config);
      store.setSettings({
        theme: config.theme || 'light',
        language: config.language || 'zh',
        memoryStrategy: config.memoryStrategy || store.settings.memoryStrategy,
        maxContextTokens: config.maxContextTokens || store.settings.maxContextTokens,
      });
      if (isInitialConfigStatus) {
        store.markInitialConfigStatusSeen();
      }
    };

    const reconcileSessionMessagesFromDisk = async (sessionId: string) => {
      try {
        const page = await window.electronAPI.invoke<SessionMessagesPage>({
          type: 'session.getMessages',
          payload: { sessionId, limit: 20 },
        });
        if (disposed || !page?.messages?.length) return;

        const store = useAppStore.getState();
        const current = store.sessionStates[sessionId]?.messages ?? [];
        const mergedById = new Map<string, Message>();
        for (const message of current) mergedById.set(message.id, message);
        for (const message of page.messages) mergedById.set(message.id, message);
        const merged = Array.from(mergedById.values()).sort((a, b) => a.timestamp - b.timestamp);
        if (merged.length !== current.length) {
          store.setMessages(sessionId, merged);
          store.setMessagePagination(sessionId, {
            hasMore: page.hasMore,
            oldestTimestamp: merged[0]?.timestamp ?? page.oldestTimestamp,
            initialLoaded: true,
            loadingOlder: false,
          });
        }
      } catch (error) {
        console.error('[useIPC] Failed to reconcile session messages after status change:', error);
      }
    };

    const cleanup = window.electronAPI.on((event: ServerEvent) => {
      const store = useAppStore.getState();

      try {
        switch (event.type) {
          case 'session.list':
            store.setSessions(event.payload.sessions);
            break;

          case 'session.status':
            store.updateSession(event.payload.sessionId, {
              status: event.payload.status,
            });
            if (event.payload.status !== 'running') {
              delete pendingPartials[event.payload.sessionId];
              delete pendingThinking[event.payload.sessionId];
              store.finishExecutionClock(event.payload.sessionId);
              store.finishStreamActivity(event.payload.sessionId);
              store.setLoading(false);
              store.clearPartialMessage(event.payload.sessionId);
              store.clearPartialThinking(event.payload.sessionId);
              store.clearActiveTurn(event.payload.sessionId);
              store.clearPendingTurns(event.payload.sessionId);
              store.clearQueuedMessages(event.payload.sessionId);
              void reconcileSessionMessagesFromDisk(event.payload.sessionId);
            }
            break;

          case 'session.update':
            store.updateSession(event.payload.sessionId, event.payload.updates);
            break;

          case 'stream.message':
            // Clear pending partial buffer to prevent RAF from appending stale chunks
            delete pendingPartials[event.payload.sessionId];
            // Clear thinking buffer too — final thinking is in the message content blocks
            delete pendingThinking[event.payload.sessionId];
            store.addMessage(event.payload.sessionId, event.payload.message);
            break;

          case 'stream.partial':
            store.recordStreamActivity(event.payload.sessionId, event.payload.delta, 'text');
            bufferPartial(event.payload.sessionId, event.payload.delta);
            break;

          case 'stream.thinking':
            store.recordStreamActivity(event.payload.sessionId, event.payload.delta, 'thinking');
            bufferThinking(event.payload.sessionId, event.payload.delta);
            break;

          case 'stream.toolCallDelta':
            store.recordStreamActivity(event.payload.sessionId, event.payload.delta, 'tool_call');
            break;

          case 'trace.step': {
            if (event.payload.step.type === 'thinking' && event.payload.step.status === 'running') {
              const currentState = useAppStore.getState();
              const ss = currentState.sessionStates[event.payload.sessionId];
              const pending = ss?.pendingTurns || [];
              const activeTurn = ss?.activeTurn;
              if (pending.length > 0) {
                store.activateNextTurn(event.payload.sessionId, event.payload.step.id);
              } else if (activeTurn) {
                // 绑定真实 stepId，避免 mock stepId 导致无法清理
                store.updateActiveTurnStep(event.payload.sessionId, event.payload.step.id);
              }
            }
            bufferTrace({
              kind: 'add',
              sessionId: event.payload.sessionId,
              step: event.payload.step,
            });
            break;
          }

          case 'trace.update':
            if (
              event.payload.updates.status &&
              (event.payload.updates.status === 'completed' ||
                event.payload.updates.status === 'error' ||
                event.payload.updates.status === 'interrupted')
            ) {
              store.clearActiveTurn(event.payload.sessionId, event.payload.stepId);
            }
            bufferTrace({
              kind: 'update',
              sessionId: event.payload.sessionId,
              stepId: event.payload.stepId,
              updates: event.payload.updates,
            });
            break;

          case 'permission.request':
            store.setPendingPermission(event.payload);
            break;

          case 'permission.dismiss': {
            const currentPermission = useAppStore.getState().pendingPermission;
            if (currentPermission?.toolUseId === event.payload.toolUseId) {
              store.setPendingPermission(null);
            }
            break;
          }

          case 'stream.executionTime':
            store.updateMessage(event.payload.sessionId, event.payload.messageId, {
              executionTimeMs: event.payload.executionTimeMs,
            });
            break;

          case 'sudo.password.request':
            store.setPendingSudoPassword(event.payload);
            break;

          case 'sudo.password.dismiss': {
            const currentSudo = useAppStore.getState().pendingSudoPassword;
            if (currentSudo?.toolUseId === event.payload.toolUseId) {
              store.setPendingSudoPassword(null);
            }
            break;
          }

          case 'config.status': {
            applyConfigSnapshot(event.payload.config, event.payload.isConfigured);
            break;
          }

          case 'sandbox.progress':
            store.setSandboxSetupProgress(event.payload);
            break;

          case 'sandbox.sync':
            store.setSandboxSyncStatus(event.payload);
            break;

          case 'workdir.changed':
            store.setWorkingDir(event.payload.path || null);
            break;

          case 'tasks.updated':
            store.upsertBackgroundTask(event.payload.task);
            break;

          case 'tasks.logAppended':
            store.appendBackgroundTaskLog(event.payload.taskId, event.payload.text);
            break;

          case 'session.contextInfo':
            store.setSessionContextWindow(event.payload.sessionId, event.payload.contextWindow);
            break;

          case 'session.tokenBudget':
            store.setSessionTokenBudget(event.payload.sessionId, event.payload.snapshot);
            break;

          case 'session.compactionState':
            store.setSessionCompactionState(event.payload.sessionId, event.payload.state);
            break;

          case 'session.compaction':
            store.setSessionCompaction(event.payload.sessionId, event.payload.info);
            break;

          case 'session.compactionNotice':
            store.setGlobalNotice({
              id: `notice-compaction-${Date.now()}`,
              type:
                event.payload.level === 'error'
                  ? 'error'
                  : event.payload.level === 'warning'
                    ? 'warning'
                    : 'info',
              message: event.payload.message,
            });
            break;

          case 'error':
            console.error('[useIPC] Server error:', event.payload.message);
            store.setLoading(false);
            if (event.payload.code === 'CONFIG_REQUIRED_ACTIVE_SET') {
              store.setGlobalNotice({
                id: `notice-config-required-${Date.now()}`,
                type: 'warning',
                message: i18n.t('api.configRequiredActiveSet'),
                messageKey: 'api.configRequiredActiveSet',
                action:
                  event.payload.action === 'open_api_settings'
                    ? 'open_api_settings'
                    : event.payload.action === 'open_tools_settings'
                      ? 'open_tools_settings'
                      : undefined,
              });
            } else {
              store.setGlobalNotice({
                id: `notice-error-${Date.now()}`,
                type: 'error',
                message: event.payload.message,
              });
            }
            break;

          case 'native-theme.changed':
            store.setSystemDarkMode(event.payload.shouldUseDarkColors);
            break;

          case 'new-session':
            store.setActiveSession(null);
            store.setShowSettings(false);
            break;

          case 'session.planMode':
            store.updateSession(event.payload.sessionId, { planMode: event.payload.planMode });
            store.setSessionPlanMode(event.payload.sessionId, event.payload.planMode);
            break;

          case 'memory.changed':
            store.markMemoryChanged(event.payload.projectPath);
            break;

          case 'navigate':
            if (event.payload === 'settings') {
              store.setShowSettings(true);
            }
            break;

          case 'update.status':
            store.setUpdateState(event.payload);
            break;

          case 'update.downloaded':
            store.setUpdateState(event.payload.state);
            break;

          case 'update.error':
            store.setUpdateState(event.payload.state);
            break;

          default:
            break;
        }
      } catch (err) {
        console.error('[useIPC] Error handling server event:', event.type, err);
      }
    });

    void (async () => {
      try {
        const [config, isConfigured, systemTheme] = await Promise.all([
          window.electronAPI.config.get(),
          window.electronAPI.config.isConfigured(),
          window.electronAPI.getSystemTheme(),
        ]);
        if (disposed) {
          return;
        }
        const store = useAppStore.getState();
        store.setSystemDarkMode(Boolean(systemTheme?.shouldUseDarkColors));
        applyConfigSnapshot(config, Boolean(isConfigured));
      } catch (error) {
        console.error('[useIPC] Failed to bootstrap config/theme state:', error);
      }
    })();

    void (async () => {
      try {
        const tasks = await window.electronAPI.tasks.list();
        if (!disposed) {
          useAppStore.getState().setBackgroundTasks(tasks || []);
        }
      } catch (error) {
        console.error('[useIPC] Failed to bootstrap background tasks:', error);
      }
    })();

    void (async () => {
      try {
        const presets = await window.electronAPI.config.getPresets();
        if (!disposed) {
          useAppStore.getState().setProviderPresets(presets);
        }
      } catch (error) {
        console.error('[useIPC] Failed to bootstrap provider presets:', error);
      }
    })();

    void (async () => {
      try {
        const state = await window.electronAPI.update?.getState?.();
        if (!disposed && state) {
          useAppStore.getState().setUpdateState(state);
        }
      } catch (error) {
        console.error('[useIPC] Failed to bootstrap update state:', error);
      }
    })();

    ipcListenerCleanup = () => {
      disposed = true;
      // Flush any pending RAF batches before cancelling to avoid lost updates
      if (partialRafId !== null) {
        cancelAnimationFrame(partialRafId);
        flushPartials();
      }
      if (thinkingRafId !== null) {
        cancelAnimationFrame(thinkingRafId);
        flushThinking();
      }
      if (traceRafId !== null) {
        cancelAnimationFrame(traceRafId);
        flushTraces();
      }
      cleanup?.();
    };

    // Cleanup on final unmount only
    return () => {
      ipcListenerRefCount = Math.max(0, ipcListenerRefCount - 1);
      if (ipcListenerRefCount === 0) {
        ipcListenerCleanup?.();
        ipcListenerCleanup = null;
      }
    };
  }, []); // Empty deps - setup listener only once!

  // Get actions for the rest of the hook
  const addSession = useAppStore((s) => s.addSession);
  const updateSession = useAppStore((s) => s.updateSession);
  const addMessage = useAppStore((s) => s.addMessage);
  const setMessages = useAppStore((s) => s.setMessages);
  const setMessagePagination = useAppStore((s) => s.setMessagePagination);
  const setLoading = useAppStore((s) => s.setLoading);
  const setPendingPermission = useAppStore((s) => s.setPendingPermission);
  const clearActiveTurn = useAppStore((s) => s.clearActiveTurn);
  const activateNextTurn = useAppStore((s) => s.activateNextTurn);
  const clearPendingTurns = useAppStore((s) => s.clearPendingTurns);
  const cancelQueuedMessages = useAppStore((s) => s.cancelQueuedMessages);
  const startExecutionClock = useAppStore((s) => s.startExecutionClock);
  const finishExecutionClock = useAppStore((s) => s.finishExecutionClock);

  // Send event to main process
  const send = useCallback((event: ClientEvent) => {
    if (!isElectron) {
      return;
    }
    window.electronAPI.send(event);
  }, []);

  // Invoke and wait for response
  const invoke = useCallback(async <T>(event: ClientEvent): Promise<T> => {
    if (!isElectron) {
      return null as T;
    }
    return window.electronAPI.invoke<T>(event);
  }, []);

  // Start a new session
  const startSession = useCallback(
    async (
      title: string,
      promptOrContent: string | ContentBlock[],
      cwd?: string,
      planMode?: boolean
    ) => {
      setLoading(true);

      // Normalize input to ContentBlock array
      const content: ContentBlock[] =
        typeof promptOrContent === 'string'
          ? [{ type: 'text', text: promptOrContent }]
          : promptOrContent;

      // Extract text for legacy backend and session title (if needed)
      const textContent = content.find((block) => block.type === 'text');
      const prompt = textContent && 'text' in textContent ? textContent.text : '';

      // Browser mode mock
      if (!isElectron) {
        const sessionId = `mock-session-${Date.now()}`;
        const session: Session = {
          id: sessionId,
          title: title || 'New Session',
          status: 'running',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          cwd: cwd || '',
          mountedPaths: [],
          allowedTools: ['websearch', 'read', 'write', 'edit', 'list_directory', 'glob', 'grep'],
          memoryEnabled: false,
          planMode: planMode ?? false,
        };

        addSession(session);
        useAppStore.getState().setActiveSession(sessionId);

        const userMessage: Message = {
          id: `msg-user-${Date.now()}`,
          sessionId,
          role: 'user',
          content,
          timestamp: Date.now(),
        };
        addMessage(sessionId, userMessage);
        startExecutionClock(sessionId, userMessage.timestamp);
        const mockStepId = `mock-step-${Date.now()}`;
        activateNextTurn(sessionId, mockStepId);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const assistantMessage: Message = {
          id: `msg-assistant-${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: `Mock response to: "${prompt}"` }],
          timestamp: Date.now(),
        };
        addMessage(sessionId, assistantMessage);

        updateSession(sessionId, { status: 'idle' });
        clearActiveTurn(sessionId, mockStepId);
        setLoading(false);

        return session;
      }

      // Electron mode
      try {
        const runtimeSettings = useAppStore.getState().settings;
        const clientTimestamp = Date.now();
        const clientMessageId = `msg-user-${clientTimestamp}`;
        const session = await invoke<Session>({
          type: 'session.start',
          payload: {
            title,
            prompt,
            cwd,
            content, // Send full content blocks including images
            contextConfig: {
              memoryStrategy: runtimeSettings.memoryStrategy,
              maxContextTokens: runtimeSettings.maxContextTokens,
            },
            planMode,
            clientMessageId,
            clientTimestamp,
          },
        });
        if (session) {
          addSession(session);
          useAppStore.getState().setActiveSession(session.id);

          // Immediately add user message to UI
          const userMessage: Message = {
            id: clientMessageId,
            sessionId: session.id,
            role: 'user',
            content,
            timestamp: clientTimestamp,
          };
          addMessage(session.id, userMessage);
          startExecutionClock(session.id, userMessage.timestamp);

          // Immediately activate turn to show processing indicator while waiting for API
          const mockStepId = `pending-step-${Date.now()}`;
          activateNextTurn(session.id, mockStepId);
        }
        // Loading will be reset when we receive session.status event
        return session;
      } catch (e) {
        setLoading(false);
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-start-${Date.now()}`,
          type: 'error',
          message: e instanceof Error ? e.message : i18n.t('chat.startFailed'),
          messageKey: e instanceof Error ? undefined : 'chat.startFailed',
        });
        return null;
      }
    },
    [
      invoke,
      addSession,
      addMessage,
      updateSession,
      setLoading,
      activateNextTurn,
      clearActiveTurn,
      startExecutionClock,
    ]
  );

  // Continue an existing session
  const continueSession = useCallback(
    async (sessionId: string, promptOrContent: string | ContentBlock[]) => {
      setLoading(true);

      // Normalize input to ContentBlock array
      const content: ContentBlock[] =
        typeof promptOrContent === 'string'
          ? [{ type: 'text', text: promptOrContent }]
          : promptOrContent;

      // Extract text for legacy backend (if needed)
      const textContent = content.find((block) => block.type === 'text');
      const prompt = textContent && 'text' in textContent ? textContent.text : '';

      // Immediately add user message to UI (for both modes)
      const store = useAppStore.getState();
      const tokenBudget = store.sessionStates[sessionId]?.tokenBudget;
      if (tokenBudget?.warningState === 'blocking') {
        setLoading(false);
        store.setGlobalNotice({
          id: `notice-session-blocking-${Date.now()}`,
          type: 'warning',
          message: '当前上下文已达到阻塞阈值，请先点击 Compact Now。',
        });
        return;
      }
      const isSessionRunning =
        store.sessions.find((session) => session.id === sessionId)?.status === 'running';
      const ss = store.sessionStates[sessionId];
      const hasActiveTurn = Boolean(ss?.activeTurn);
      const hasPending = (ss?.pendingTurns?.length ?? 0) > 0;
      const shouldQueue = isSessionRunning || hasActiveTurn || hasPending;
      const clientTimestamp = Date.now();
      const clientMessageId = `msg-user-${clientTimestamp}`;
      const userMessage: Message = {
        id: clientMessageId,
        sessionId,
        role: 'user',
        content,
        timestamp: clientTimestamp,
        localStatus: shouldQueue ? 'queued' : undefined,
      };
      addMessage(sessionId, userMessage);
      startExecutionClock(sessionId, userMessage.timestamp);

      // Browser mode mock
      if (!isElectron) {
        updateSession(sessionId, { status: 'running' });
        const mockStepId = `mock-step-${Date.now()}`;
        activateNextTurn(sessionId, mockStepId);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const assistantMessage: Message = {
          id: `msg-assistant-${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: `Mock response to: "${prompt}"` }],
          timestamp: Date.now(),
        };
        addMessage(sessionId, assistantMessage);

        updateSession(sessionId, { status: 'idle' });
        clearActiveTurn(sessionId, mockStepId);
        clearPendingTurns(sessionId);
        setLoading(false);
        return;
      }

      // Electron mode - send to backend (user message already added above)
      // Immediately activate turn to show processing indicator while waiting for API
      if (!shouldQueue) {
        const mockStepId = `pending-step-${Date.now()}`;
        activateNextTurn(sessionId, mockStepId);
      }

      try {
        const runtimeSettings = useAppStore.getState().settings;
        send({
          type: 'session.continue',
          payload: {
            sessionId,
            prompt,
            content, // Send full content blocks including images
            contextConfig: {
              memoryStrategy: runtimeSettings.memoryStrategy,
              maxContextTokens: runtimeSettings.maxContextTokens,
            },
            clientMessageId,
            clientTimestamp,
          },
        });
        // Loading will be reset when we receive session.status event
      } catch (e) {
        setLoading(false);
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-continue-${Date.now()}`,
          type: 'error',
          message: e instanceof Error ? e.message : i18n.t('chat.startFailed'),
          messageKey: e instanceof Error ? undefined : 'chat.startFailed',
        });
      }
    },
    [
      send,
      addMessage,
      updateSession,
      setLoading,
      activateNextTurn,
      clearActiveTurn,
      clearPendingTurns,
      startExecutionClock,
    ]
  );

  const forkSession = useCallback(
    async (sourceSessionId: string, messageId: string): Promise<Session | null> => {
      if (!isElectron) {
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-fork-${Date.now()}`,
          type: 'error',
          message: i18n.t('chat.forkFailed'),
          messageKey: 'chat.forkFailed',
        });
        return null;
      }

      try {
        const result = await invoke<ForkSessionResult>({
          type: 'session.fork',
          payload: { sourceSessionId, messageId },
        });
        if (!result?.session) return null;

        addSession(result.session);
        setMessages(result.session.id, result.messages || []);
        setMessagePagination(result.session.id, {
          hasMore: false,
          oldestTimestamp: result.messages?.[0]?.timestamp ?? null,
          initialLoaded: true,
          loadingOlder: false,
        });
        useAppStore.getState().setActiveSession(result.session.id);
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-fork-${Date.now()}`,
          type: 'success',
          message: i18n.t('chat.forkCreated'),
          messageKey: 'chat.forkCreated',
        });

        return result.session;
      } catch (e) {
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-fork-${Date.now()}`,
          type: 'error',
          message: e instanceof Error ? e.message : i18n.t('chat.forkFailed'),
          messageKey: e instanceof Error ? undefined : 'chat.forkFailed',
        });
        return null;
      }
    },
    [invoke, addSession, setMessages, setMessagePagination]
  );

  const stopSession = useCallback(
    (sessionId: string) => {
      cancelQueuedMessages(sessionId);
      clearPendingTurns(sessionId);
      clearActiveTurn(sessionId);
      finishExecutionClock(sessionId);
      if (!isElectron) {
        updateSession(sessionId, { status: 'idle' });
        setLoading(false);
        return;
      }
      send({ type: 'session.stop', payload: { sessionId } });
      setLoading(false);
    },
    [
      send,
      updateSession,
      setLoading,
      cancelQueuedMessages,
      clearPendingTurns,
      clearActiveTurn,
      finishExecutionClock,
    ]
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<boolean> => {
      const normalizedTitle = title.trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!normalizedTitle) return false;

      if (!isElectron) {
        updateSession(sessionId, { title: normalizedTitle });
        return true;
      }

      const updated = await invoke<boolean>({
        type: 'session.rename',
        payload: { sessionId, title: normalizedTitle },
      });
      return Boolean(updated);
    },
    [invoke, isElectron, updateSession]
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      useAppStore.getState().removeSession(sessionId);
      if (isElectron) {
        send({ type: 'session.delete', payload: { sessionId } });
      }
    },
    [send]
  );

  const batchDeleteSessions = useCallback(
    (sessionIds: string[]) => {
      useAppStore.getState().removeSessions(sessionIds);
      if (isElectron) {
        send({ type: 'session.batchDelete', payload: { sessionIds } });
      }
    },
    [send]
  );

  const listSessions = useCallback(async () => {
    if (!isElectron) return [];

    const load = async (): Promise<Session[]> => {
      const sessions = await invoke<Session[]>({ type: 'session.list', payload: {} });
      const nextSessions = sessions || [];
      useAppStore.getState().setSessions(nextSessions);
      return nextSessions;
    };

    try {
      return await load();
    } catch (error) {
      console.error('[useIPC] Failed to list sessions, retrying once:', error);
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      try {
        return await load();
      } catch (retryError) {
        console.error('[useIPC] Failed to list sessions after retry:', retryError);
        return [];
      }
    }
  }, [invoke]);

  // Get messages for a session (from persistent storage)
  const getSessionMessages = useCallback(
    async (
      sessionId: string,
      options?: { limit?: number; beforeTimestamp?: number }
    ): Promise<SessionMessagesPage> => {
      if (!isElectron) {
        return { messages: [], hasMore: false, oldestTimestamp: null };
      }
      const page = await invoke<SessionMessagesPage>({
        type: 'session.getMessages',
        payload: {
          sessionId,
          limit: options?.limit,
          beforeTimestamp: options?.beforeTimestamp,
        },
      });
      return page || { messages: [], hasMore: false, oldestTimestamp: null };
    },
    [invoke]
  );

  const getSessionTraceSteps = useCallback(
    async (sessionId: string): Promise<TraceStep[]> => {
      if (!isElectron) {
        return [];
      }
      return (
        (await invoke<TraceStep[]>({ type: 'session.getTraceSteps', payload: { sessionId } })) || []
      );
    },
    [invoke]
  );

  const getSessionCompactionHistory = useCallback(
    async (sessionId: string, limit = 20): Promise<SessionCompactionInfo[]> => {
      if (!isElectron) {
        return [];
      }
      return (
        (await invoke<SessionCompactionInfo[]>({
          type: 'session.getCompactionHistory',
          payload: { sessionId, limit },
        })) || []
      );
    },
    [invoke]
  );

  const getSessionTokenBudget = useCallback(
    async (sessionId: string, model?: string): Promise<TokenBudgetSnapshot | null> => {
      if (!isElectron) {
        return null;
      }
      return (
        (await invoke<TokenBudgetSnapshot | null>({
          type: 'session.getTokenBudget',
          payload: { sessionId, model },
        })) || null
      );
    },
    [invoke]
  );

  const respondToPermission = useCallback(
    (toolUseId: string, result: PermissionResult) => {
      send({
        type: 'permission.response',
        payload: { toolUseId, result },
      });
      setPendingPermission(null);
    },
    [send, setPendingPermission]
  );

  const setPendingSudoPassword = useAppStore((s) => s.setPendingSudoPassword);

  const respondToSudoPassword = useCallback(
    (toolUseId: string, password: string | null) => {
      send({
        type: 'sudo.password.response',
        payload: { toolUseId, password },
      });
      setPendingSudoPassword(null);
    },
    [send, setPendingSudoPassword]
  );

  const selectFolder = useCallback(async (): Promise<string | null> => {
    if (!isElectron) {
      return '/mock/folder/path';
    }
    return invoke<string | null>({ type: 'folder.select', payload: {} });
  }, [invoke]);

  const getWorkingDir = useCallback(async (): Promise<string | null> => {
    if (!isElectron) {
      return '/mock/working/dir';
    }
    return invoke<string | null>({ type: 'workdir.get', payload: {} });
  }, [invoke]);

  const changeWorkingDir = useCallback(
    async (
      sessionId?: string,
      currentPath?: string
    ): Promise<{ success: boolean; path: string; error?: string }> => {
      if (!isElectron) {
        return { success: true, path: '/mock/working/dir' };
      }
      return invoke<{ success: boolean; path: string; error?: string }>({
        type: 'workdir.select',
        payload: { sessionId, currentPath },
      });
    },
    [invoke]
  );

  const getMCPServers = useCallback(async () => {
    if (!isElectron) {
      return [];
    }
    // Use the exposed mcp.getServerStatus method
    return window.electronAPI.mcp.getServerStatus();
  }, []);

  const compactSession = useCallback(
    async (sessionId: string) => {
      if (!isElectron) {
        return;
      }
      await invoke<void>({
        type: 'session.compact',
        payload: { sessionId },
      });
    },
    [invoke]
  );

  const listBackgroundTasks = useCallback(async (): Promise<BackgroundTask[]> => {
    if (!isElectron) {
      return [];
    }
    return window.electronAPI.tasks.list();
  }, []);

  const startBackgroundTask = useCallback(
    async (payload: BackgroundTaskStartInput): Promise<BackgroundTask | null> => {
      if (!isElectron) {
        return null;
      }
      const task = await window.electronAPI.tasks.start(payload);
      if (task) {
        useAppStore.getState().upsertBackgroundTask(task);
      }
      return task;
    },
    []
  );

  const stopBackgroundTask = useCallback(async (taskId: string): Promise<BackgroundTask | null> => {
    if (!isElectron) {
      return null;
    }
    const task = await window.electronAPI.tasks.stop(taskId);
    if (task) {
      useAppStore.getState().upsertBackgroundTask(task);
    }
    return task;
  }, []);

  const getBackgroundTaskLogTail = useCallback(
    async (taskId: string, maxChars = 8000): Promise<string> => {
      if (!isElectron) {
        return '';
      }
      const content = await window.electronAPI.tasks.getLogTail(taskId, maxChars);
      useAppStore.getState().setBackgroundTaskLog(taskId, content || '');
      return content || '';
    },
    []
  );

  return {
    send,
    invoke,
    startSession,
    continueSession,
    forkSession,
    stopSession,
    renameSession,
    deleteSession,
    batchDeleteSessions,
    listSessions,
    getSessionMessages,
    getSessionCompactionHistory,
    getSessionTokenBudget,
    getSessionTraceSteps,
    respondToPermission,
    respondToSudoPassword,
    selectFolder,
    getWorkingDir,
    changeWorkingDir,
    getMCPServers,
    compactSession,
    listBackgroundTasks,
    startBackgroundTask,
    stopBackgroundTask,
    getBackgroundTaskLogTail,
    isElectron,
  };
}
