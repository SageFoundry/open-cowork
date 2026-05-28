import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useActiveSessionId,
  useCurrentSession,
  useActiveSessionMessages,
  useActivePartialContent,
  useActiveTurn,
  usePendingTurns,
  useActiveExecutionClock,
  useActiveTraceSteps,
  useAppConfig,
} from '../store/selectors';
import { getDisplayStreamRate, useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { groupMessagesByTurn, type ConversationTurn } from '../utils/conversation-turns';
import { formatChatTurnTime } from '../utils/i18n-format';
import { AssistantTurnGroup } from './AssistantTurnGroup';
import { MessageCard } from './MessageCard';
import type { Message, ContentBlock, ThinkingLevel } from '../types';
import {
  Send,
  Square,
  Plus,
  Loader2,
  Plug,
  X,
  Clock,
  ChevronUp,
  Settings,
  Brain,
  ClipboardList,
  Activity,
} from 'lucide-react';
import { API_PROVIDER_PRESETS } from '../../shared/api-model-presets';

const CHAT_INPUT_MIN_ROWS = 2;
const CHAT_INPUT_MAX_ROWS = 10;
const CHAT_INPUT_LINE_HEIGHT_PX = 24;
const CHAT_INPUT_VERTICAL_PADDING_PX = 16;
const CHAT_INPUT_MIN_HEIGHT_PX =
  CHAT_INPUT_MIN_ROWS * CHAT_INPUT_LINE_HEIGHT_PX + CHAT_INPUT_VERTICAL_PADDING_PX;
const CHAT_INPUT_MAX_HEIGHT_PX =
  CHAT_INPUT_MAX_ROWS * CHAT_INPUT_LINE_HEIGHT_PX + CHAT_INPUT_VERTICAL_PADDING_PX;
const MESSAGES_PAGE_SIZE = 20;
const THINKING_LEVEL_OPTIONS: Array<{ value: ThinkingLevel; labelKey: string }> = [
  { value: 'off', labelKey: 'chat.thinkingOff' },
  { value: 'minimal', labelKey: 'chat.thinkingMinimal' },
  { value: 'low', labelKey: 'chat.thinkingLow' },
  { value: 'medium', labelKey: 'chat.thinkingMedium' },
  { value: 'high', labelKey: 'chat.thinkingHigh' },
  { value: 'xhigh', labelKey: 'chat.thinkingXHigh' },
];

const THINKING_LEVEL_STYLES: Record<ThinkingLevel, string> = {
  off: 'border-border-subtle bg-background/60 text-text-muted hover:bg-surface-hover hover:text-text-secondary',
  minimal: 'bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
  low: 'bg-emerald-500/10 border-emerald-500/35 text-emerald-700 dark:text-emerald-300',
  medium: 'bg-amber-500/10 border-amber-500/35 text-amber-700 dark:text-amber-300',
  high: 'bg-orange-500/12 border-orange-500/40 text-orange-700 dark:text-orange-300',
  xhigh: 'bg-red-500/12 border-red-500/45 text-red-700 dark:text-red-300',
};
const THINKING_LEVEL_MENU_STYLES: Record<ThinkingLevel, { selected: string; dot: string }> = {
  off: {
    selected: 'bg-surface-hover text-text-secondary',
    dot: 'bg-border',
  },
  minimal: {
    selected: 'bg-emerald-500/8 text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-400',
  },
  low: {
    selected: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-600',
  },
  medium: {
    selected: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  high: {
    selected: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    dot: 'bg-orange-500',
  },
  xhigh: {
    selected: 'bg-red-500/12 text-red-700 dark:text-red-300',
    dot: 'bg-red-500',
  },
};

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

interface TurnTokenSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function ChatView() {
  const { t } = useTranslation();
  // Scoped selectors — each subscription only re-renders when its slice changes
  const activeSessionId = useActiveSessionId();
  const activeSession = useCurrentSession();
  const messages = useActiveSessionMessages();
  const { partialMessage, partialThinking } = useActivePartialContent();
  const activeTurn = useActiveTurn();
  const pendingTurns = usePendingTurns();
  const executionClock = useActiveExecutionClock();
  const traceSteps = useActiveTraceSteps();
  const appConfig = useAppConfig();
  const configSets = useMemo(() => {
    if (!appConfig) return [];
    return appConfig.configSets.map((cs) => {
      const activeProfile = cs.profiles[cs.activeProfileKey];
      // Get preset models for this provider (custom provider has no presets)
      let presetModels: Array<{ id: string; name: string }> = [];
      if (cs.provider !== 'custom') {
        presetModels = API_PROVIDER_PRESETS[cs.provider]?.models || [];
      }
      const presetIds = presetModels.map((m) => m.id);
      // Merge preset + user-added models
      const userModels = activeProfile?.models || [];
      const merged = [...new Set([...presetIds, ...userModels])].filter(Boolean);
      const models: Array<{ id: string; name: string }> = merged.map((id) => ({ id, name: id }));
      // Ensure current model is in the list
      if (activeProfile?.model && !models.some((m) => m.id === activeProfile.model)) {
        models.push({ id: activeProfile.model, name: activeProfile.model });
      }
      return {
        id: cs.id,
        name: cs.name,
        models,
        isActive: cs.id === appConfig.activeConfigSetId,
      };
    });
  }, [appConfig]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    appConfig?.thinkingLevel || (appConfig?.enableThinking ? 'medium' : 'off')
  );
  const isSavingThinking = useRef(false);

  // Sync thinking level from appConfig whenever it changes
  useEffect(() => {
    if (!isSavingThinking.current) {
      setThinkingLevel(appConfig?.thinkingLevel || (appConfig?.enableThinking ? 'medium' : 'off'));
    }
  }, [appConfig?.enableThinking, appConfig?.thinkingLevel]);

  const updateThinkingLevel = useCallback(async (next: ThinkingLevel) => {
    const previous = thinkingLevel;
    setThinkingLevel(next);
    isSavingThinking.current = true;
    try {
      const result = await window.electronAPI.config.save({
        thinkingLevel: next,
        enableThinking: next !== 'off',
      });
      if (result.success) {
        useAppStore.getState().setAppConfig(result.config);
      } else {
        setThinkingLevel(previous);
      }
    } catch {
      setThinkingLevel(previous);
    } finally {
      isSavingThinking.current = false;
    }
  }, [thinkingLevel]);

  const messagePagination = useAppStore((s) =>
    activeSessionId
      ? s.sessionStates[activeSessionId]?.messagePagination ?? {
          hasMore: false,
          oldestTimestamp: null,
          initialLoaded: false,
          loadingOlder: false,
        }
      : {
          hasMore: false,
          oldestTimestamp: null,
          initialLoaded: false,
          loadingOlder: false,
        }
  );
  const prependMessages = useAppStore((s) => s.prependMessages);
  const setMessages = useAppStore((s) => s.setMessages);
  const setMessagePagination = useAppStore((s) => s.setMessagePagination);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const setSessionInputDraft = useAppStore((s) => s.setSessionInputDraft);
  const activeInputDraft = useAppStore((s) =>
    activeSessionId ? (s.sessionStates[activeSessionId]?.inputDraft ?? '') : ''
  );
  const tokenBudget = useAppStore((s) =>
    activeSessionId ? s.sessionStates[activeSessionId]?.tokenBudget ?? null : null
  );
  const streamActivity = useAppStore((s) =>
    activeSessionId ? s.sessionStates[activeSessionId]?.streamActivity ?? null : null
  );
  const { continueSession, stopSession, getSessionMessages, isElectron } = useIPC();
  const currentThinkingLabel =
    THINKING_LEVEL_OPTIONS.find((option) => option.value === thinkingLevel)?.labelKey ||
    'chat.thinkingOff';

  const modelPickerRef = useRef<HTMLDivElement>(null);
  const thinkingPickerRef = useRef<HTMLDivElement>(null);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);

  useEffect(() => {
    if (!modelPickerOpen && !thinkingPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
      if (
        thinkingPickerRef.current &&
        !thinkingPickerRef.current.contains(e.target as Node)
      ) {
        setThinkingPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modelPickerOpen, thinkingPickerOpen]);

  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeConnectors, setActiveConnectors] = useState<
    { id: string; name: string; connected: boolean; toolCount: number }[]
  >([]);
  const [showConnectorLabel, setShowConnectorLabel] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const connectorMeasureRef = useRef<HTMLDivElement>(null);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const isComposingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevMessageCountRef = useRef(0);
  const prevPartialLengthRef = useRef(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRequestRef = useRef<number | null>(null);
  const isScrollingRef = useRef(false);
  const pendingPrependRestoreRef = useRef<{ previousHeight: number; previousTop: number } | null>(
    null
  );
  const initialScrollDoneRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const isRestoringPrependRef = useRef(false);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = `${CHAT_INPUT_MIN_HEIGHT_PX}px`;
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, CHAT_INPUT_MIN_HEIGHT_PX),
      CHAT_INPUT_MAX_HEIGHT_PX
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > CHAT_INPUT_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  const focusChatInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled) return;
    textarea.focus({ preventScroll: true });
  }, []);

  const hasActiveTurn = Boolean(activeTurn);
  const pendingCount = pendingTurns.length;
  const isSessionRunning = activeSession?.status === 'running';
  const canStop = isSessionRunning || hasActiveTurn || pendingCount > 0;
  const isBlockingContext = tokenBudget?.warningState === 'blocking';

  useEffect(() => {
    adjustTextareaHeight();
  }, [adjustTextareaHeight, prompt]);

  useEffect(() => {
    setPrompt(activeInputDraft);
    if (textareaRef.current) {
      textareaRef.current.value = activeInputDraft;
    }
    requestAnimationFrame(() => adjustTextareaHeight());
  }, [activeInputDraft, activeSessionId, adjustTextareaHeight]);

  const displayedMessages = useMemo(() => {
    if (!activeSessionId) return messages;
    // Show streaming message if we have partial text OR partial thinking
    const hasStreamingContent = partialMessage || partialThinking;
    if (!hasStreamingContent || !activeTurn?.userMessageId) return messages;
    const anchorIndex = messages.findIndex((message) => message.id === activeTurn.userMessageId);
    if (anchorIndex === -1) return messages;

    let insertIndex = anchorIndex + 1;
    while (insertIndex < messages.length) {
      if (messages[insertIndex].role === 'user') break;
      insertIndex += 1;
    }

    const contentBlocks: ContentBlock[] = [];
    if (partialThinking) {
      contentBlocks.push({ type: 'thinking', thinking: partialThinking });
    }
    if (partialMessage) {
      contentBlocks.push({ type: 'text', text: partialMessage });
    }

    const streamingMessage: Message = {
      id: `partial-${activeSessionId}`,
      sessionId: activeSessionId,
      role: 'assistant',
      content: contentBlocks,
      timestamp: Date.now(),
    };

    return [...messages.slice(0, insertIndex), streamingMessage, ...messages.slice(insertIndex)];
  }, [activeSessionId, activeTurn?.userMessageId, messages, partialMessage, partialThinking]);

  const conversationTurns = useMemo(
    () => groupMessagesByTurn(displayedMessages),
    [displayedMessages]
  );

  const forceScrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (scrollRequestRef.current) {
      cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = null;
    }

    isScrollingRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior });
    setTimeout(
      () => {
        isScrollingRef.current = false;
        isUserAtBottomRef.current = true;
      },
      behavior === 'smooth' ? 300 : 50
    );
  }, []);

  const loadOlderMessages = useCallback(async () => {
    if (!activeSessionId || !isElectron) return;
    if (!messagePagination.hasMore || messagePagination.loadingOlder || loadingOlderRef.current) {
      return;
    }
    if (messagePagination.oldestTimestamp == null) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    pendingPrependRestoreRef.current = {
      previousHeight: container.scrollHeight,
      previousTop: container.scrollTop,
    };
    loadingOlderRef.current = true;
    setMessagePagination(activeSessionId, { loadingOlder: true });

    try {
      const page = await getSessionMessages(activeSessionId, {
        limit: MESSAGES_PAGE_SIZE,
        beforeTimestamp: messagePagination.oldestTimestamp,
      });
      if (page.messages.length > 0) {
        prependMessages(activeSessionId, page.messages);
      } else {
        pendingPrependRestoreRef.current = null;
      }
      setMessagePagination(activeSessionId, {
        hasMore: page.hasMore,
        oldestTimestamp: page.oldestTimestamp,
        initialLoaded: true,
        loadingOlder: false,
      });
    } catch (error) {
      pendingPrependRestoreRef.current = null;
      setMessagePagination(activeSessionId, { loadingOlder: false });
      console.error('[ChatView] Failed to load older messages:', error);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [
    activeSessionId,
    getSessionMessages,
    isElectron,
    messagePagination.hasMore,
    messagePagination.loadingOlder,
    messagePagination.oldestTimestamp,
    prependMessages,
    setMessagePagination,
  ]);

  useEffect(() => {
    if (!activeSessionId || !isElectron) return;
    if (messagePagination.initialLoaded || messagePagination.loadingOlder) return;

    if (messages.length > 0) {
      setMessagePagination(activeSessionId, {
        hasMore: messages.length >= MESSAGES_PAGE_SIZE,
        oldestTimestamp: messages[0]?.timestamp ?? null,
        initialLoaded: true,
        loadingOlder: false,
      });
      return;
    }

    let cancelled = false;
    setMessagePagination(activeSessionId, { loadingOlder: true });

    getSessionMessages(activeSessionId, { limit: MESSAGES_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setMessages(activeSessionId, page.messages);
        setMessagePagination(activeSessionId, {
          hasMore: page.hasMore,
          oldestTimestamp: page.oldestTimestamp,
          initialLoaded: true,
          loadingOlder: false,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[ChatView] Failed to load initial messages:', error);
        setMessagePagination(activeSessionId, { initialLoaded: true, loadingOlder: false });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    getSessionMessages,
    isElectron,
    messagePagination.initialLoaded,
    messagePagination.loadingOlder,
    messages,
    setMessagePagination,
    setMessages,
  ]);

  useEffect(() => {
    if (!activeSessionId || !isElectron) return;
    if (
      !messagePagination.initialLoaded ||
      !messagePagination.hasMore ||
      messagePagination.loadingOlder ||
      loadingOlderRef.current
    ) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) return;
    if (container.scrollHeight > container.clientHeight + 16) return;

    void loadOlderMessages();
  }, [
    activeSessionId,
    isElectron,
    loadOlderMessages,
    messagePagination.hasMore,
    messagePagination.initialLoaded,
    messagePagination.loadingOlder,
    messages.length,
  ]);

  // Format execution time for display
  const formatExecutionTime = useCallback((ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }, []);

  // --- Real-time execution timer ---
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    const isActive = Boolean(executionClock?.startAt && executionClock.endAt === null);
    if (!isActive) {
      return;
    }
    setClockNow(Date.now());
    const interval = setInterval(() => {
      setClockNow(Date.now());
    }, 100);
    return () => clearInterval(interval);
  }, [executionClock?.startAt, executionClock?.endAt]);

  const liveElapsed =
    executionClock?.startAt == null
      ? 0
      : Math.max(0, (executionClock.endAt ?? clockNow) - executionClock.startAt);
  const timerActive = Boolean(executionClock?.startAt && executionClock.endAt === null);
  const streamRate = getDisplayStreamRate(streamActivity, clockNow);
  const streamTokenTotal = Math.round(streamActivity?.totalEstimatedTokens ?? 0);
  const streamRecentlyActive = streamRate > 0;
  const streamKindLabel =
    streamActivity?.activeKind === 'thinking'
      ? t('chat.streamThinking')
      : streamActivity?.activeKind === 'tool_call'
        ? t('chat.streamToolCall')
        : t('chat.streamText');
  const runningToolStep = useMemo(() => {
    for (let index = traceSteps.length - 1; index >= 0; index -= 1) {
      const step = traceSteps[index];
      if (step.type === 'tool_call' && step.status === 'running') {
        return step;
      }
    }
    return null;
  }, [traceSteps]);
  const runningToolInput = runningToolStep?.toolInput ?? {};
  const runningToolTarget =
    typeof runningToolInput.path === 'string'
      ? runningToolInput.path
      : typeof runningToolInput.file_path === 'string'
        ? runningToolInput.file_path
        : typeof runningToolInput.filePath === 'string'
          ? runningToolInput.filePath
          : '';
  const runningToolName = runningToolStep?.toolName || runningToolStep?.title || t('chat.tool');
  const isGeneratingToolArgs = runningToolStep?.content === 'generating_tool_args';
  const isExecutingTool = runningToolStep?.content === 'executing_tool';
  const displayStreamRate = isExecutingTool ? 0 : streamRate;
  const streamIsVisible = !isExecutingTool && streamRecentlyActive;
  const activityLabel = streamIsVisible
    ? t('chat.outputActive')
    : runningToolStep
      ? isGeneratingToolArgs
        ? t('chat.toolArgsGenerating', {
            tool: runningToolName,
            file: runningToolTarget,
          })
        : t('chat.toolRunning', {
            tool: runningToolName,
            file: runningToolTarget,
          })
      : t('chat.running');
  const idleDetailLabel = runningToolStep ? t('chat.waitingTool') : t('chat.waitingOutput');

  const formatTokenRate = useCallback((tokensPerSecond: number): string => {
    if (tokensPerSecond >= 100) return Math.round(tokensPerSecond).toString();
    if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
    return tokensPerSecond.toFixed(2);
  }, []);

  const formatTokenCount = useCallback((tokens: number): string => {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(tokens);
  }, []);

  const formatCompactTokenCount = useCallback((tokens: number): string => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens >= 10000000 ? 0 : 1)}m`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`;
    return Math.round(tokens).toString();
  }, []);

  const getTurnStartedAt = useCallback((turn: ConversationTurn): number | null => {
    return turn.userMessage?.timestamp ?? turn.assistantMessages[0]?.timestamp ?? null;
  }, []);

  const getTurnTokenSummary = useCallback((turn: ConversationTurn): TurnTokenSummary | null => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    for (const message of turn.assistantMessages) {
      const usage = message.tokenUsage;
      if (!usage) continue;
      input += usage.input || 0;
      output += usage.output || 0;
      cacheRead += usage.cacheRead || 0;
      cacheWrite += usage.cacheWrite || 0;
    }

    const total = input + output;
    if (total <= 0 && cacheRead <= 0 && cacheWrite <= 0) return null;
    return { input, output, cacheRead, cacheWrite, total };
  }, []);

  // Debounced scroll function to prevent scroll conflicts
  const scrollToBottom = useRef((behavior: ScrollBehavior = 'auto', immediate: boolean = false) => {
    // Cancel any pending scroll requests
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (scrollRequestRef.current) {
      cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = null;
    }

    const performScroll = () => {
      if (!isUserAtBottomRef.current) return;

      // Mark as scrolling to prevent concurrent scrolls
      isScrollingRef.current = true;

      messagesEndRef.current?.scrollIntoView({ behavior });

      // Reset scrolling flag after a short delay
      setTimeout(
        () => {
          isScrollingRef.current = false;
        },
        behavior === 'smooth' ? 300 : 50
      );
    };

    if (immediate) {
      performScroll();
    } else {
      // Use RAF + timeout for debouncing
      scrollRequestRef.current = requestAnimationFrame(() => {
        scrollTimeoutRef.current = setTimeout(performScroll, 16); // ~1 frame delay
      });
    }
  }).current;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const updateScrollState = () => {
      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserAtBottomRef.current = distanceToBottom <= 80;
    };
    updateScrollState();
    // 用户阅读旧消息时，阻止新消息自动滚动打断视线
    const onScroll = () => {
      updateScrollState();
      if (!isRestoringPrependRef.current && container.scrollTop <= 80) {
        void loadOlderMessages();
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [loadOlderMessages]);

  useEffect(() => {
    initialScrollDoneRef.current = false;
    pendingPrependRestoreRef.current = null;
    isRestoringPrependRef.current = false;
  }, [activeSessionId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (pendingPrependRestoreRef.current) {
      const { previousHeight, previousTop } = pendingPrependRestoreRef.current;
      pendingPrependRestoreRef.current = null;
      isRestoringPrependRef.current = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const nextHeight = container.scrollHeight;
          container.scrollTop = previousTop + (nextHeight - previousHeight);
          isRestoringPrependRef.current = false;
        });
      });
      prevMessageCountRef.current = messages.length;
      prevPartialLengthRef.current = partialMessage.length + partialThinking.length;
      return;
    }

    const messageCount = messages.length;
    const partialLength = partialMessage.length + partialThinking.length;
    const hasNewMessage = messageCount !== prevMessageCountRef.current;
    const isStreamingTick = partialLength !== prevPartialLengthRef.current && !hasNewMessage;

    // Skip scroll if already scrolling (prevent conflicts)
    if (isScrollingRef.current) {
      prevMessageCountRef.current = messageCount;
      prevPartialLengthRef.current = partialLength;
      return;
    }

    if (isUserAtBottomRef.current) {
      if (!isStreamingTick) {
        // New message - use smooth scroll but with debounce
        const behavior: ScrollBehavior = hasNewMessage ? 'smooth' : 'auto';
        scrollToBottom(behavior, false);
      } else {
        // Streaming tick - use instant scroll with debounce
        scrollToBottom('auto', false);
      }
    }

    prevMessageCountRef.current = messageCount;
    prevPartialLengthRef.current = partialLength;
  }, [messages.length, partialMessage.length, partialThinking.length]);

  useEffect(() => {
    if (!activeSessionId || !messagePagination.initialLoaded || initialScrollDoneRef.current) {
      return;
    }
    initialScrollDoneRef.current = true;
    requestAnimationFrame(() => {
      forceScrollToBottom('auto');
    });
  }, [activeSessionId, forceScrollToBottom, messagePagination.initialLoaded]);

  // Additional scroll trigger for content height changes (e.g., TodoWrite expand/collapse)
  useEffect(() => {
    const container = scrollContainerRef.current;
    const messagesContainer = messagesContainerRef.current;
    if (!container || !messagesContainer) return;

    const resizeObserver = new ResizeObserver(() => {
      // Don't interfere with ongoing scrolls
      if (!isScrollingRef.current && !isRestoringPrependRef.current && isUserAtBottomRef.current) {
        // Scroll to bottom when content height changes
        scrollToBottom('auto', false);
      }
    });

    resizeObserver.observe(messagesContainer);

    return () => {
      resizeObserver.disconnect();
    };
  }, []); // ResizeObserver is stable — no need to recreate on message count changes

  // Cleanup scroll timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (scrollRequestRef.current) {
        cancelAnimationFrame(scrollRequestRef.current);
      }
    };
  }, []);

  useEffect(() => {
    focusChatInput();
    const raf = requestAnimationFrame(focusChatInput);
    const timers = [window.setTimeout(focusChatInput, 50), window.setTimeout(focusChatInput, 150)];

    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [activeSessionId, focusChatInput]);

  useEffect(() => {
    const handleWindowFocus = () => {
      const activeElement = document.activeElement;
      if (
        activeElement &&
        activeElement !== document.body &&
        activeElement !== document.documentElement
      ) {
        return;
      }
      window.setTimeout(focusChatInput, 0);
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleWindowFocus);
    };
  }, [focusChatInput]);

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();

    const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        // Resize if needed to stay under API limit
        const resizedBlob = await resizeImageIfNeeded(blob);
        const base64 = await blobToBase64(resizedBlob);
        const url = URL.createObjectURL(resizedBlob);
        newImages.push({
          url,
          base64,
          mediaType: resizedBlob.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        });
      } catch (err) {
        // Notify the user instead of silently dropping the error
        setGlobalNotice({
          id: `image-paste-failed-${Date.now()}`,
          type: 'warning',
          message: t('chat.imageProcessFailed'),
        });
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader result is not a string'));
          return;
        }
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const parts = result.split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Resize and compress image if needed to stay under 5MB base64 limit
  const resizeImageIfNeeded = async (blob: Blob): Promise<Blob> => {
    // Claude API limit is 5MB for base64 encoded images
    // Base64 encoding increases size by ~33%, so we target 3.75MB for the blob
    const MAX_BLOB_SIZE = 3.75 * 1024 * 1024; // 3.75MB

    if (blob.size <= MAX_BLOB_SIZE) {
      return blob; // No need to resize
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);

        // Calculate scaling factor to reduce file size
        // We use a more aggressive approach: scale down until size is acceptable
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Start with a scale factor based on size ratio
        const scale = Math.sqrt(MAX_BLOB_SIZE / blob.size);
        const quality = 0.9;

        const attemptCompress = (currentScale: number, currentQuality: number): Promise<Blob> => {
          canvas.width = Math.floor(img.width * currentScale);
          canvas.height = Math.floor(img.height * currentScale);

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          return new Promise((resolveBlob) => {
            canvas.toBlob(
              (compressedBlob) => {
                if (!compressedBlob) {
                  reject(new Error('Failed to compress image'));
                  return;
                }

                // If still too large, try again with lower quality or scale
                if (
                  compressedBlob.size > MAX_BLOB_SIZE &&
                  (currentQuality > 0.5 || currentScale > 0.3)
                ) {
                  const newQuality = Math.max(0.5, currentQuality - 0.1);
                  const newScale = currentQuality <= 0.5 ? currentScale * 0.9 : currentScale;
                  attemptCompress(newScale, newQuality).then(resolveBlob);
                } else {
                  resolveBlob(compressedBlob);
                }
              },
              blob.type || 'image/jpeg',
              currentQuality
            );
          });
        };

        attemptCompress(scale, quality).then(resolve).catch(reject);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  };

  const removeImage = (index: number) => {
    setPastedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].url);
      updated.splice(index, 1);
      return updated;
    });
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleFileSelect = async () => {
    if (!isElectron || !window.electronAPI) {
      console.log('[ChatView] Not in Electron, file selection not available');
      return;
    }

    try {
      const filePaths = await window.electronAPI.selectFiles();
      if (filePaths.length === 0) return;

      // Get file info for each selected file
      const newFiles = filePaths.map((filePath) => {
        const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
        return {
          name: fileName,
          path: filePath,
          size: 0, // Will be set by backend when copying
          type: 'application/octet-stream',
        };
      });

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    } catch (error) {
      console.error('[ChatView] Error selecting files:', error);
    }
  };

  // Handle drag and drop for images
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

    // Process images
    if (imageFiles.length > 0) {
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of imageFiles) {
        try {
          // Resize if needed to stay under API limit
          const resizedBlob = await resizeImageIfNeeded(file);
          const base64 = await blobToBase64(resizedBlob);
          const url = URL.createObjectURL(resizedBlob);
          newImages.push({
            url,
            base64,
            mediaType: resizedBlob.type,
          });
        } catch (err) {
          // Notify the user instead of silently dropping the error
          setGlobalNotice({
            id: `image-drop-failed-${Date.now()}`,
            type: 'warning',
            message: t('chat.imageProcessFailed'),
          });
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

    // Process other files
    if (otherFiles.length > 0) {
      const newFiles = await Promise.all(
        otherFiles.map(async (file) => {
          const droppedPath = 'path' in file && typeof file.path === 'string' ? file.path : '';
          const inlineDataBase64 = droppedPath ? undefined : await blobToBase64(file);

          return {
            name: file.name,
            path: droppedPath,
            size: file.size,
            type: file.type || 'application/octet-stream',
            inlineDataBase64,
          };
        })
      );

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  // Load active MCP connectors
  useEffect(() => {
    if (isElectron && typeof window !== 'undefined' && window.electronAPI) {
      const loadConnectors = async () => {
        try {
          const statuses = await window.electronAPI.mcp.getServerStatus();
          const active =
            (
              statuses as Array<{ id: string; name: string; connected: boolean; toolCount: number }>
            )?.filter((s) => s.connected && s.toolCount > 0) || [];
          setActiveConnectors(active);
        } catch (err) {
          console.error('Failed to load MCP connectors:', err);
        }
      };
      loadConnectors();
      // Refresh every 5 seconds
      const interval = setInterval(loadConnectors, 5000);
      return () => clearInterval(interval);
    }
  }, [isElectron]);

  useEffect(() => {
    const titleEl = titleRef.current;
    const headerEl = headerRef.current;
    const measureEl = connectorMeasureRef.current;
    if (!titleEl || !headerEl || !measureEl) {
      setShowConnectorLabel(true);
      return;
    }
    const updateLabelVisibility = () => {
      const isTruncated = titleEl.scrollWidth > titleEl.clientWidth;
      const headerStyle = window.getComputedStyle(headerEl);
      const paddingLeft = Number.parseFloat(headerStyle.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(headerStyle.paddingRight) || 0;
      const contentWidth = headerEl.clientWidth - paddingLeft - paddingRight;
      const titleWidth = titleEl.getBoundingClientRect().width;
      const rightColumnWidth = Math.max(0, (contentWidth - titleWidth) / 2);
      const connectorFullWidth = measureEl.getBoundingClientRect().width;
      setShowConnectorLabel(!isTruncated && rightColumnWidth >= connectorFullWidth);
    };
    updateLabelVisibility();
    const observer = new ResizeObserver(() => {
      updateLabelVisibility();
    });
    observer.observe(titleEl);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [activeSession?.title, activeConnectors.length]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() && pastedImages.length === 0 && attachedFiles.length === 0) ||
      !activeSessionId ||
      isSubmitting ||
      isBlockingContext
    )
      return;

    setIsSubmitting(true);
    try {
      // Build content blocks
      const contentBlocks: ContentBlock[] = [];

      // Add images first
      pastedImages.forEach((img) => {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.base64,
          },
        });
      });

      // Add file attachments
      attachedFiles.forEach((file) => {
        contentBlocks.push({
          type: 'file_attachment',
          filename: file.name,
          relativePath: file.path, // Will be processed by backend to copy to .tmp
          size: file.size,
          mimeType: file.type,
          inlineDataBase64: file.inlineDataBase64,
        });
      });

      // Add text if present
      if (currentPrompt.trim()) {
        contentBlocks.push({
          type: 'text',
          text: currentPrompt.trim(),
        });
      }

      // Send message with content blocks
      await continueSession(activeSessionId, contentBlocks);

      // Clean up
      setPrompt('');
      setSessionInputDraft(activeSessionId, '');
      if (textareaRef.current) {
        textareaRef.current.value = '';
      }
      requestAnimationFrame(() => adjustTextareaHeight());
      pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
      setPastedImages([]);
      setAttachedFiles([]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = () => {
    if (activeSessionId) {
      stopSession(activeSessionId);
    }
  };

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        <span>{t('chat.loadingConversation')}</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div
        ref={headerRef}
        className="relative h-12 border-b border-border-muted grid grid-cols-[1fr_auto_1fr] items-center px-4 lg:px-8 bg-background/88 backdrop-blur-md"
      >
        <div className="text-[11px] font-medium tracking-[0.08em] uppercase text-text-muted">
          Open Cowork
        </div>
        <h2
          ref={titleRef}
          className="text-[15px] font-medium text-text-primary text-center truncate max-w-[40vw] lg:max-w-[32rem]"
        >
          {activeSession.title}
        </h2>
        {activeConnectors.length > 0 && (
          <>
            <div
              ref={connectorMeasureRef}
              aria-hidden="true"
              className="absolute left-0 top-0 -z-10 opacity-0 pointer-events-none"
            >
              <div className="flex items-center gap-2 px-2 py-1 rounded-lg border border-mcp/20">
                <Plug className="w-3.5 h-3.5" />
                <span className="text-xs font-medium whitespace-nowrap">
                  {t('chat.connectorCount', { count: activeConnectors.length })}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-mcp/8 border border-mcp/15 justify-self-end">
              <Plug className="w-3.5 h-3.5 text-mcp" />
              <span className="text-xs text-mcp font-medium">
                {showConnectorLabel
                  ? t('chat.connectorCount', { count: activeConnectors.length })
                  : activeConnectors.length}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div
          ref={messagesContainerRef}
          className="w-full max-w-[920px] mx-auto py-8 px-5 lg:px-8 space-y-5"
        >
          {displayedMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-28 text-text-muted space-y-3 text-center">
              <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted/80">
                Open Cowork
              </p>
              <p className="text-base text-text-secondary">{t('chat.startConversation')}</p>
            </div>
          ) : (
            conversationTurns.map((turn, index) => (
              <div
                key={turn.userMessage?.id ?? turn.assistantMessages[0]?.id ?? `turn-${index}`}
                className="space-y-1.5"
              >
                {turn.userMessage && <MessageCard message={turn.userMessage} />}
                {turn.assistantMessages.length > 0 && (
                  <AssistantTurnGroup
                    messages={turn.assistantMessages}
                    isProcessing={
                      (turn.userMessage?.id != null &&
                        turn.userMessage.id === activeTurn?.userMessageId) ||
                      turn.assistantMessages.some((message) => message.id.startsWith('partial-'))
                    }
                  />
                )}
                {(() => {
                  const startedAt = getTurnStartedAt(turn);
                  const tokenSummary = getTurnTokenSummary(turn);
                  if (!startedAt && !tokenSummary) return null;

                  return (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-0.5 text-[11px] text-text-muted/75">
                      {startedAt && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatChatTurnTime(startedAt)}
                        </span>
                      )}
                      {startedAt && tokenSummary && <span className="text-text-muted/35">·</span>}
                      {tokenSummary && (
                        <span
                          title={t('messageCard.turnTokenUsageDetail', {
                            input: formatTokenCount(tokenSummary.input),
                            output: formatTokenCount(tokenSummary.output),
                            cacheRead: formatTokenCount(tokenSummary.cacheRead),
                            cacheWrite: formatTokenCount(tokenSummary.cacheWrite),
                          })}
                        >
                          {t('messageCard.turnTokenUsage', {
                            total: formatCompactTokenCount(tokenSummary.total),
                            input: formatCompactTokenCount(tokenSummary.input),
                            output: formatCompactTokenCount(tokenSummary.output),
                          })}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))
          )}

          {/* Processing indicator - show when we have an active turn but no streaming content yet */}
          {hasActiveTurn &&
            (!partialMessage || partialMessage.trim() === '') &&
            !partialThinking && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-full bg-background/80 border border-border-subtle max-w-fit">
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
                <span className="text-sm text-text-secondary">{t('chat.processing')}</span>
              </div>
            )}

          {/* Real-time execution timer */}
          {liveElapsed > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-1 ml-0.5">
              <Clock className="w-3 h-3" />
              <span>
                {timerActive
                  ? formatExecutionTime(liveElapsed)
                  : t('messageCard.executionTime', { time: formatExecutionTime(liveElapsed) })}
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border-muted bg-background/92 backdrop-blur-md">
        <div className="max-w-[920px] mx-auto px-5 lg:px-8 py-5">
          {canStop && (
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <div className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border-subtle bg-background/75 px-3 py-1.5 text-[11px] text-text-muted shadow-sm">
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                </span>
                <Activity className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                <span className="max-w-[14rem] truncate font-medium text-text-secondary">
                  {activityLabel}
                </span>
                <span className="hidden h-3 w-px bg-border-subtle sm:block" />
                <span className="truncate">
                  {t('chat.tokenRate', { rate: formatTokenRate(displayStreamRate) })}
                </span>
                {!streamIsVisible && (
                  <>
                    <span className="hidden h-3 w-px bg-border-subtle md:block" />
                    <span className="hidden md:inline">{idleDetailLabel}</span>
                  </>
                )}
                {streamTokenTotal > 0 && (
                  <>
                    <span className="hidden h-3 w-px bg-border-subtle sm:block" />
                    <span className="hidden sm:inline">
                      {t('chat.streamReceived', { tokens: formatTokenCount(streamTokenTotal) })}
                    </span>
                  </>
                )}
                {streamIsVisible && (
                  <>
                    <span className="hidden h-3 w-px bg-border-subtle md:block" />
                    <span className="hidden md:inline">{streamKindLabel}</span>
                  </>
                )}
              </div>
            </div>
          )}
          <form
            onSubmit={handleSubmit}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="relative w-full"
          >
            {/* Image previews */}
            {pastedImages.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mb-3">
                {pastedImages.map((img, index) => (
                  <div key={img.url || `pasted-image-${index}`} className="relative group">
                    <img
                      src={img.url}
                      alt={t('common.pastedImageAlt', { index: index + 1 })}
                      className="w-full aspect-square object-cover rounded-lg border border-border block"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* File attachments */}
            {attachedFiles.length > 0 && (
              <div className="space-y-2 mb-3">
                {attachedFiles.map((file, index) => (
                  <div
                    key={file.path || `attached-file-${index}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{file.name}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className={`flex flex-col gap-3 p-3.5 rounded-[1.75rem] bg-background/88 border border-border-muted shadow-soft transition-colors ${
                isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
              }`}
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(e) => {
                    const nextPrompt = e.target.value;
                    setPrompt(nextPrompt);
                    if (activeSessionId) {
                      setSessionInputDraft(activeSessionId, nextPrompt);
                    }
                    adjustTextareaHeight();
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    isComposingRef.current = false;
                  }}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    // Enter to send, Shift+Enter for new line
                    if (e.key === 'Enter' && !e.shiftKey) {
                      if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
                        return;
                      }
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder={t('chat.typeMessage')}
                  disabled={isSubmitting || isBlockingContext}
                  rows={CHAT_INPUT_MIN_ROWS}
                  style={{
                    minHeight: `${CHAT_INPUT_MIN_HEIGHT_PX}px`,
                    maxHeight: `${CHAT_INPUT_MAX_HEIGHT_PX}px`,
                    lineHeight: `${CHAT_INPUT_LINE_HEIGHT_PX}px`,
                  }}
                  className="flex-1 resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-[15px] py-2 overflow-y-hidden"
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleFileSelect}
                    className="w-9 h-9 rounded-2xl flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                    title={t('welcome.attachFiles')}
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  {/* Model selector — button only, no dropdown yet */}
                  <div className="relative" ref={modelPickerRef}>
                    <button
                      type="button"
                      onClick={() => setModelPickerOpen(!modelPickerOpen)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border-subtle bg-background/60 text-xs text-text-muted hover:bg-surface-hover hover:text-text-secondary transition-colors"
                      title={appConfig?.model || t('chat.noModel')}
                    >
                      <span className="max-w-[120px] truncate">
                        {appConfig?.model || t('chat.noModel')}
                      </span>
                      <ChevronUp className={`w-3 h-3 transition-transform ${modelPickerOpen ? 'rotate-0' : 'rotate-180'}`} />
                    </button>

                    {modelPickerOpen && (
                      <div className="absolute bottom-full left-0 mb-2 w-72 max-h-80 overflow-y-auto rounded-xl border border-border-subtle bg-background shadow-lg z-50 py-1.5">
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                          {t('chat.selectModel')}
                        </div>
                        {configSets.map((cs, index) => (
                          <div key={cs.id} className={index > 0 ? 'border-t border-border-subtle mt-1' : ''}>
                            {cs.isActive && (
                              <div className="px-3 pt-2 pb-0.5 text-[15px] font-semibold text-text-primary">
                                {cs.name}
                              </div>
                            )}
                            {!cs.isActive && (
                              <div className="px-3 pt-2 pb-0.5 text-[15px] text-text-muted">
                                {cs.name}
                              </div>
                            )}
                            {(cs.models || []).map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                onClick={() => {
                                  if (option.id !== appConfig?.model || !cs.isActive) {
                                    setModelPickerOpen(false);
                                    const id = cs.id;
                                    if (cs.isActive) {
                                      // Same config set, just switch model
                                      window.electronAPI.config
                                        .save({ model: option.id })
                                        .then((result) => {
                                          if (result.success) {
                                            const store = useAppStore.getState();
                                            store.setAppConfig(result.config);
                                            // Update context window for the active session immediately
                                            if (result.modelContextWindow && activeSessionId) {
                                              const cw = result.modelContextWindow;
                                              store.setSessionContextWindow(activeSessionId, cw);
                                              // Also update tokenBudget maxContextTokens to match
                                              const ss = store.sessionStates[activeSessionId];
                                              if (ss?.tokenBudget) {
                                                store.setSessionTokenBudget(activeSessionId, {
                                                  ...ss.tokenBudget,
                                                  maxContextTokens: cw,
                                                });
                                              }
                                            }
                                            // Update model name on the active session
                                            if (activeSessionId) {
                                              store.updateSession(activeSessionId, { model: option.id });
                                            }
                                          }
                                        })
                                        .catch((err) => console.error('[ChatView] Failed to switch model:', err));
                                    } else {
                                      // Different config set: switch set, then switch model
                                      window.electronAPI.config
                                        .switchSet({ id })
                                        .then((switchResult) => {
                                          if (!switchResult.success) return;
                                          return window.electronAPI.config.save({ model: option.id });
                                        })
                                        .then((saveResult) => {
                                          if (saveResult?.success) {
                                            const store = useAppStore.getState();
                                            store.setAppConfig(saveResult.config);
                                            // Update context window for the active session immediately
                                            if (saveResult.modelContextWindow && activeSessionId) {
                                              const cw = saveResult.modelContextWindow;
                                              store.setSessionContextWindow(activeSessionId, cw);
                                              // Also update tokenBudget maxContextTokens to match
                                              const ss = store.sessionStates[activeSessionId];
                                              if (ss?.tokenBudget) {
                                                store.setSessionTokenBudget(activeSessionId, {
                                                  ...ss.tokenBudget,
                                                  maxContextTokens: cw,
                                                });
                                              }
                                            }
                                            // Update model name on the active session
                                            if (activeSessionId) {
                                              store.updateSession(activeSessionId, { model: option.id });
                                            }
                                          }
                                        })
                                        .catch((err) => console.error('[ChatView] Failed to switch:', err));
                                    }
                                  }
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                                  option.id === appConfig?.model && cs.isActive
                                    ? 'bg-accent/10 text-accent'
                                    : 'text-text-primary hover:bg-surface-hover'
                                }`}
                              >
                                <span className="flex-1 truncate">{option.name}</span>
                                {option.id === appConfig?.model && cs.isActive && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                                )}
                              </button>
                            ))}
                          </div>
                        ))}
                        {configSets.length === 0 && (
                          <div className="px-3 py-3 text-xs text-text-muted">
                            {t('chat.noModelsAvailable')}
                          </div>
                        )}
                        <div className="border-t border-border-subtle mt-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setModelPickerOpen(false);
                              useAppStore.getState().setShowSettings(true);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-text-muted hover:bg-surface-hover transition-colors"
                          >
                            <Settings className="w-3 h-3" />
                            {t('chat.manageModels')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Thinking level selector */}
                  {isElectron && (
                    <div className="relative" ref={thinkingPickerRef}>
                      <button
                        type="button"
                        onClick={() => setThinkingPickerOpen((open) => !open)}
                        disabled={isSavingThinking.current}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
                          THINKING_LEVEL_STYLES[thinkingLevel]
                        } ${isSavingThinking.current ? 'opacity-60 cursor-not-allowed' : ''}`}
                        title={t('chat.toggleThinking')}
                        aria-haspopup="menu"
                        aria-expanded={thinkingPickerOpen}
                      >
                        <Brain className={`w-3 h-3 ${thinkingLevel === 'off' ? 'opacity-60' : ''}`} />
                        <span className="font-medium">{t(currentThinkingLabel)}</span>
                        <ChevronUp
                          className={`w-3 h-3 transition-transform ${
                            thinkingPickerOpen ? 'rotate-0' : 'rotate-180'
                          }`}
                        />
                      </button>

                      {thinkingPickerOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-40 rounded-xl border border-border bg-background shadow-xl z-50 py-1.5">
                          <div className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                            {t('chat.thinking')}
                          </div>
                          {THINKING_LEVEL_OPTIONS.map((option, index) => {
                            const selected = option.value === thinkingLevel;
                            const active = option.value !== 'off';
                            const menuStyle = THINKING_LEVEL_MENU_STYLES[option.value];
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => {
                                  setThinkingPickerOpen(false);
                                  updateThinkingLevel(option.value);
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                  selected
                                    ? menuStyle.selected
                                    : 'text-text-primary hover:bg-surface-hover'
                                } ${index === 1 ? 'border-t border-border-subtle mt-1 pt-2' : ''}`}
                                role="menuitemradio"
                                aria-checked={selected}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    active ? menuStyle.dot : 'bg-border'
                                  } ${selected ? 'opacity-100' : 'opacity-35'}`}
                                />
                                <span
                                  className={`flex-1 ${
                                    selected
                                      ? ''
                                      : option.value === 'off'
                                        ? 'text-text-primary'
                                        : THINKING_LEVEL_STYLES[option.value]
                                            .split(' ')
                                            .filter((part) => part.startsWith('text-') || part.startsWith('dark:text-'))
                                            .join(' ')
                                  }`}
                                >
                                  {t(option.labelKey)}
                                </span>
                                {selected && (
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${menuStyle.dot}`} />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Plan mode toggle */}
                  {isElectron && activeSessionId && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={activeSession?.planMode ?? false}
                      onClick={() => {
                        const sessionId = activeSessionId!;
                        const store = useAppStore.getState();
                        const session = store.sessions.find((s) => s.id === sessionId);
                        if (!session) return;
                        const nextPlanMode = !session.planMode;
                        // Send plan mode change to main process
                        window.electronAPI.send({
                          type: 'session.planMode',
                          payload: { sessionId, planMode: nextPlanMode },
                        });
                        // Optimistically update local state
                        store.updateSession(sessionId, { planMode: nextPlanMode });
                        store.setSessionPlanMode(sessionId, nextPlanMode);
                      }}
                      disabled={isSessionRunning}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
                        activeSession?.planMode
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
                          : 'border-border-subtle bg-background/60 text-text-muted hover:bg-surface-hover hover:text-text-secondary'
                      } ${isSessionRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={activeSession?.planMode ? t('chat.planModeActive') : t('chat.planModeOff')}
                    >
                      <ClipboardList className={`w-3 h-3 ${activeSession?.planMode ? '' : 'opacity-60'}`} />
                      <span>{t('chat.plan')}</span>
                      <span
                        className={`relative inline-block w-7 h-4 rounded-full transition-colors ${
                          activeSession?.planMode ? 'bg-amber-500' : 'bg-border'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                            activeSession?.planMode ? 'translate-x-3' : 'translate-x-0'
                          }`}
                        />
                      </span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {canStop && (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="w-9 h-9 rounded-2xl flex items-center justify-center bg-error/10 text-error hover:bg-error/20 transition-colors"
                      title={t('chat.stop')}
                    >
                      <Square className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={
                      (!prompt.trim() &&
                        !textareaRef.current?.value.trim() &&
                        pastedImages.length === 0 &&
                        attachedFiles.length === 0) ||
                      isSubmitting ||
                      isBlockingContext
                    }
                    className="w-9 h-9 rounded-2xl flex items-center justify-center bg-accent text-background disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-hover transition-colors"
                    title={t('chat.sendMessage')}
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-text-muted/60 text-center mt-2.5">
              {t('chat.disclaimer')}
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
