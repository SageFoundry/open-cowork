import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  CheckCircle,
  ExternalLink,
  Key,
  Loader2,
  Search,
  Trash2,
  Zap,
} from 'lucide-react';
import { useAppStore } from '../../store';
import type { ToolCompressionStats, ToolOutputCompressionLevel } from '../../../shared/ipc-types';
import { ConfirmOverlay } from './shared';

const ANYSEARCH_KEY_URL = 'https://anysearch.com/console/api-keys';
const ANYSEARCH_DOCS_URL = 'https://www.anysearch.com/docs';

export function SettingsTools() {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const [apiKey, setApiKey] = useState(appConfig?.anySearchApiKey || '');
  const [savedKey, setSavedKey] = useState(appConfig?.anySearchApiKey || '');
  const [compressionLevel, setCompressionLevel] = useState<ToolOutputCompressionLevel>(
    appConfig?.toolOutputCompressionLevel || 'off'
  );
  const [stats, setStats] = useState<ToolCompressionStats | null>(null);
  const [isLoading, setIsLoading] = useState(!appConfig);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingCompression, setIsSavingCompression] = useState(false);
  const [isResettingStats, setIsResettingStats] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      if (!window.electronAPI?.config) {
        setIsLoading(false);
        return;
      }
      try {
        const config = await window.electronAPI.config.get();
        if (cancelled) return;
        const key = config.anySearchApiKey || '';
        setApiKey(key);
        setSavedKey(key);
        setCompressionLevel(config.toolOutputCompressionLevel || 'off');
        setAppConfig(config);
        const compressionStats = await window.electronAPI?.toolCompression?.getStats?.();
        if (!cancelled && compressionStats) {
          setStats(compressionStats);
        }
      } catch {
        if (!cancelled) {
          setMessage({ type: 'error', text: t('tools.anySearch.loadFailed') });
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [setAppConfig, t]);

  const hasSavedKey = Boolean(savedKey.trim());
  const hasUnsavedChanges = apiKey !== savedKey;
  const maxDailySaved = useMemo(
    () => Math.max(1, ...(stats?.daily.map((item) => item.savedTokens) ?? [0])),
    [stats]
  );

  const formatTokens = (value: number) => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(Math.round(value));
  };

  const saveCompressionLevel = async (level: ToolOutputCompressionLevel) => {
    if (!window.electronAPI?.config) {
      return;
    }
    setCompressionLevel(level);
    setIsSavingCompression(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.config.save({
        toolOutputCompressionLevel: level,
      });
      if (result.success) {
        setCompressionLevel(result.config.toolOutputCompressionLevel || 'off');
        setAppConfig(result.config);
        setMessage({ type: 'success', text: t('tools.compression.saved') });
      }
    } catch {
      setMessage({ type: 'error', text: t('tools.compression.saveFailed') });
    } finally {
      setIsSavingCompression(false);
    }
  };

  const resetCompressionStats = async () => {
    if (!window.electronAPI?.toolCompression) {
      return;
    }
    setIsResettingStats(true);
    setMessage(null);
    try {
      const nextStats = await window.electronAPI.toolCompression.resetStats();
      setStats(nextStats);
      setShowResetConfirm(false);
      setMessage({ type: 'success', text: t('tools.compression.resetDone') });
    } catch {
      setMessage({ type: 'error', text: t('tools.compression.resetFailed') });
    } finally {
      setIsResettingStats(false);
    }
  };

  const saveKey = async (nextKey = apiKey) => {
    if (!window.electronAPI?.config) {
      return;
    }
    setIsSaving(true);
    setMessage(null);
    try {
      const result = await window.electronAPI.config.save({
        anySearchApiKey: nextKey.trim(),
      });
      if (result.success) {
        const key = result.config.anySearchApiKey || '';
        setApiKey(key);
        setSavedKey(key);
        setAppConfig(result.config);
        setMessage({ type: 'success', text: t('tools.anySearch.saved') });
      }
    } catch {
      setMessage({ type: 'error', text: t('tools.anySearch.saveFailed') });
    } finally {
      setIsSaving(false);
    }
  };

  const openExternal = (url: string) => {
    void window.electronAPI?.openExternal?.(url);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4 py-5 border-b border-border-muted">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Zap className="w-4 h-4" />
              {t('tools.compression.title')}
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted max-w-[42rem]">
              {t('tools.compression.description')}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border-muted bg-surface-muted px-2.5 py-1 text-xs text-text-secondary">
            {t(`tools.compression.levels.${compressionLevel}`)}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {(['off', 'conservative', 'aggressive'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => void saveCompressionLevel(level)}
              disabled={isSavingCompression}
              className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                compressionLevel === level
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {t(`tools.compression.levels.${level}`)}
            </button>
          ))}
        </div>
        <p className="text-xs leading-5 text-text-muted">{t('tools.compression.levelHint')}</p>

        <div className="rounded-lg border border-border-muted bg-background/60 p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <BarChart3 className="w-4 h-4" />
              {t('tools.compression.statsTitle')}
            </div>
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              disabled={isResettingStats || !stats || stats.totalCommands === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-border-muted px-3 py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              {isResettingStats && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('tools.compression.resetStats')}
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg bg-surface px-3 py-2">
              <div className="text-xs text-text-muted">{t('tools.compression.savedTotal')}</div>
              <div className="mt-1 text-lg font-semibold text-text-primary">
                {formatTokens(stats?.totalSavedTokens ?? 0)}
              </div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <div className="text-xs text-text-muted">{t('tools.compression.avgSavings')}</div>
              <div className="mt-1 text-lg font-semibold text-text-primary">
                {(stats?.avgSavingsPct ?? 0).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <div className="text-xs text-text-muted">{t('tools.compression.commands')}</div>
              <div className="mt-1 text-lg font-semibold text-text-primary">
                {stats?.compressedCommands ?? 0}/{stats?.totalCommands ?? 0}
              </div>
            </div>
            <div className="rounded-lg bg-surface px-3 py-2">
              <div className="text-xs text-text-muted">{t('tools.compression.saved30d')}</div>
              <div className="mt-1 text-lg font-semibold text-text-primary">
                {formatTokens(stats?.savedTokens30d ?? 0)}
              </div>
            </div>
          </div>

          <div className="flex h-20 items-end gap-1 rounded-lg bg-surface px-3 py-2">
            {(stats?.daily ?? []).map((point) => (
              <div
                key={point.date}
                title={`${point.date}: ${formatTokens(point.savedTokens)} tokens`}
                className="flex-1 rounded-t bg-accent/70 min-h-[2px]"
                style={{ height: `${Math.max(2, (point.savedTokens / maxDailySaved) * 100)}%` }}
              />
            ))}
            {!stats?.daily?.length && (
              <div className="text-xs text-text-muted">{t('tools.compression.noStats')}</div>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <div className="text-xs font-medium text-text-secondary">
                {t('tools.compression.topCategories')}
              </div>
              {(stats?.topCategories ?? []).slice(0, 4).map((item) => (
                <div key={item.name} className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">{item.name}</span>
                  <span className="text-text-primary">{formatTokens(item.savedTokens)}</span>
                </div>
              ))}
              {(stats?.topCategories.length ?? 0) === 0 && (
                <div className="text-xs text-text-muted">{t('tools.compression.noStats')}</div>
              )}
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-text-secondary">
                {t('tools.compression.skipReasons')}
              </div>
              {(stats?.skipReasons ?? []).slice(0, 4).map((item) => (
                <div key={item.reason} className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">{item.reason}</span>
                  <span className="text-text-primary">{item.count}</span>
                </div>
              ))}
              {(stats?.skipReasons.length ?? 0) === 0 && (
                <div className="text-xs text-text-muted">{t('tools.compression.noStats')}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showResetConfirm && (
        <ConfirmOverlay
          title={t('tools.compression.resetTitle')}
          message={t('tools.compression.resetConfirm')}
          confirmLabel={t('tools.compression.resetStats')}
          onCancel={() => setShowResetConfirm(false)}
          onConfirm={() => void resetCompressionStats()}
          isLoading={isResettingStats}
        />
      )}

      <div className="space-y-4 py-5 border-b border-border-muted">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <label
              htmlFor="anysearch-key-input"
              className="flex items-center gap-2 text-sm font-medium text-text-primary"
            >
              <Search className="w-4 h-4" />
              {t('tools.anySearch.title')}
            </label>
            <p className="mt-2 text-xs leading-5 text-text-muted max-w-[42rem]">
              {t('tools.anySearch.description')}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
              hasSavedKey
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-border-muted bg-surface-muted text-text-secondary'
            }`}
          >
            {hasSavedKey && <CheckCircle className="w-3.5 h-3.5" />}
            {hasSavedKey ? t('tools.anySearch.configured') : t('tools.anySearch.anonymous')}
          </span>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="anysearch-key-input"
            className="flex items-center gap-2 text-xs font-medium text-text-secondary"
          >
            <Key className="w-3.5 h-3.5" />
            {t('tools.anySearch.apiKey')}
          </label>
          <input
            id="anysearch-key-input"
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setMessage(null);
            }}
            placeholder="as_sk_..."
            className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <p className="text-xs leading-5 text-text-muted">{t('tools.anySearch.apiKeyHint')}</p>
        </div>

        {message && (
          <p className={`text-xs ${message.type === 'success' ? 'text-success' : 'text-error'}`}>
            {message.text}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={isSaving || !hasUnsavedChanges}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent transition-colors"
          >
            {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('common.save')}
          </button>
          <button
            type="button"
            onClick={() => {
              setApiKey('');
              void saveKey('');
            }}
            disabled={isSaving || !hasSavedKey}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted px-4 py-2 text-sm text-text-secondary hover:border-border hover:text-text-primary disabled:opacity-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('tools.anySearch.clearKey')}
          </button>
          <button
            type="button"
            onClick={() => openExternal(ANYSEARCH_KEY_URL)}
            className="inline-flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/20 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            {t('tools.anySearch.getFreeKey')}
          </button>
          <button
            type="button"
            onClick={() => openExternal(ANYSEARCH_DOCS_URL)}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            {t('tools.anySearch.docs')}
          </button>
        </div>
      </div>
    </div>
  );
}
