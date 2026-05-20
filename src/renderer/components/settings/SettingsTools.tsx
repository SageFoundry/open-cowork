import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, ExternalLink, Key, Loader2, Search, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';

const ANYSEARCH_KEY_URL = 'https://anysearch.com/console/api-keys';
const ANYSEARCH_DOCS_URL = 'https://www.anysearch.com/docs';

export function SettingsTools() {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);
  const [apiKey, setApiKey] = useState(appConfig?.anySearchApiKey || '');
  const [savedKey, setSavedKey] = useState(appConfig?.anySearchApiKey || '');
  const [isLoading, setIsLoading] = useState(!appConfig);
  const [isSaving, setIsSaving] = useState(false);
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
        setAppConfig(config);
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
