import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Key,
  Plug,
  Server,
  Cpu,
  Loader2,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Plus,
  X,
} from 'lucide-react';
import { useApiConfigState } from '../../hooks/useApiConfigState';
import { ApiConfigSetManager } from '../ApiConfigSetManager';
import { CommonProviderSetupsCard, GuidanceInlineHint } from '../ProviderGuidance';
import ApiDiagnosticsPanel from '../ApiDiagnosticsPanel';
import type { ThinkingLevel } from '../../types';

// ==================== API Settings Tab ====================

const THINKING_LEVEL_OPTIONS: Array<{ value: ThinkingLevel; labelKey: string }> = [
  { value: 'off', labelKey: 'api.thinkingLevels.off' },
  { value: 'minimal', labelKey: 'api.thinkingLevels.minimal' },
  { value: 'low', labelKey: 'api.thinkingLevels.low' },
  { value: 'medium', labelKey: 'api.thinkingLevels.medium' },
  { value: 'high', labelKey: 'api.thinkingLevels.high' },
  { value: 'xhigh', labelKey: 'api.thinkingLevels.xhigh' },
];

export function SettingsAPI() {
  const { t } = useTranslation();
  const [newModelInput, setNewModelInput] = useState('');
  const {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    model,
    models,
    contextWindow,
    maxTokens,
    presets,
    currentPreset,
    modelOptions,
    isSaving,
    isLoadingConfig,
    error,
    successMessage,
    isRefreshingModels,
    isRefreshingOpenRouterSpecs,
    openRouterSpecsStatus,
    isDiscoveringLocalOllama,
    thinkingLevel,
    isOllamaMode,
    requiresApiKey,
    protocolGuidanceText,
    protocolGuidanceTone,
    baseUrlGuidanceText,
    commonProviderSetups,
    configSets,
    activeConfigSetId,
    currentConfigSet,
    pendingConfigSetAction,
    pendingConfigSet,
    hasUnsavedChanges,
    isMutatingConfigSet,
    canDeleteCurrentConfigSet,
    setApiKey,
    setBaseUrl,
    setModel,
    addModel,
    removeModel,
    setContextWindow,
    setMaxTokens,
    setThinkingLevel,
    applyCommonProviderSetup,
    changeProvider,
    changeProtocol,
    requestConfigSetSwitch,
    requestCreateBlankConfigSet,
    cancelPendingConfigSetAction,
    saveAndContinuePendingConfigSetAction,
    discardAndContinuePendingConfigSetAction,
    renameConfigSet,
    deleteConfigSet,
    handleSave,
    refreshModelOptions,
    refreshOpenRouterSpecs,
    discoverLocalOllama,
    diagnosticResult,
    isDiagnosing,
    handleDiagnose,
    handleDeepDiagnose,
  } = useApiConfigState();

  if (isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Config Set Switcher */}
      <ApiConfigSetManager
        configSets={configSets}
        activeConfigSetId={activeConfigSetId}
        currentConfigSet={currentConfigSet}
        pendingConfigSetAction={pendingConfigSetAction}
        pendingConfigSet={pendingConfigSet}
        hasUnsavedChanges={hasUnsavedChanges}
        isMutatingConfigSet={isMutatingConfigSet}
        isSaving={isSaving}
        canDeleteCurrentConfigSet={canDeleteCurrentConfigSet}
        onSwitchSet={requestConfigSetSwitch}
        onRequestCreateBlankSet={requestCreateBlankConfigSet}
        onSaveCurrentSet={handleSave}
        onRenameSet={renameConfigSet}
        onDeleteSet={deleteConfigSet}
        onCancelPendingAction={cancelPendingConfigSetAction}
        onSaveAndContinuePendingAction={saveAndContinuePendingConfigSetAction}
        onDiscardAndContinuePendingAction={discardAndContinuePendingConfigSetAction}
      />

      {/* Provider Selection */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Server className="w-4 h-4" />
          {t('api.provider')}
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('api.providerDescription')}</p>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
          {(['anthropic', 'openai', 'lingerai', 'deepseek', 'ollama', 'custom'] as const).map(
            (p) => (
              <button
                key={p}
                onClick={() => changeProvider(p)}
                disabled={isLoadingConfig}
                className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                  provider === p
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary disabled:opacity-50'
                }`}
              >
                {p === 'custom' ? t('api.moreModels') : presets?.[p]?.name || p}
              </button>
            )
          )}
        </div>
      </div>

      {/* API Key */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <label
          htmlFor="api-key-input"
          className="flex items-center gap-2 text-sm font-medium text-text-primary"
        >
          <Key className="w-4 h-4" />
          {t('api.apiKey')}
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('api.apiKeyDescription')}</p>
        <input
          id="api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={currentPreset?.keyPlaceholder || t('api.enterApiKey')}
          className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
        />
        {currentPreset?.keyHint && (
          <p className="text-xs text-text-muted">{currentPreset.keyHint}</p>
        )}
      </div>

      {/* Custom Protocol */}
      {provider === 'custom' && (
        <div className="space-y-3 py-5 border-b border-border-muted">
          <label
            id="api-protocol-label"
            className="flex items-center gap-2 text-sm font-medium text-text-primary"
          >
            <Server className="w-4 h-4" />
            {t('api.protocol')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(
              [
                { id: 'anthropic', label: 'Anthropic' },
                { id: 'openai', label: 'OpenAI' },
                { id: 'gemini', label: 'Gemini' },
              ] as const
            ).map((mode) => (
              <button
                key={mode.id}
                onClick={() => changeProtocol(mode.id)}
                className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                  customProtocol === mode.id
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">{t('api.selectProtocol')}</p>
          <GuidanceInlineHint text={protocolGuidanceText} tone={protocolGuidanceTone} />
        </div>
      )}

      {(provider === 'custom' || provider === 'ollama') && (
        <div className="space-y-3 py-5 border-b border-border-muted">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="api-base-url-input"
              className="flex items-center gap-2 text-sm font-medium text-text-primary"
            >
              <Server className="w-4 h-4" />
              {t('api.baseUrl')}
            </label>
            {isOllamaMode && (
              <button
                type="button"
                onClick={() => {
                  void discoverLocalOllama();
                }}
                disabled={isDiscoveringLocalOllama}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-accent-muted text-accent hover:bg-accent-muted/80 disabled:opacity-50"
              >
                <Plug className="w-3 h-3" />
                {isDiscoveringLocalOllama
                  ? t('api.discoveringLocalOllama')
                  : t('api.discoverLocalOllama')}
              </button>
            )}
          </div>
          <input
            id="api-base-url-input"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              provider === 'ollama'
                ? 'http://localhost:11434/v1'
                : customProtocol === 'openai'
                  ? 'https://api.openai.com/v1'
                  : customProtocol === 'gemini'
                    ? 'https://generativelanguage.googleapis.com'
                    : currentPreset?.baseUrl || 'https://api.anthropic.com'
            }
            className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <p className="text-xs text-text-muted">
            {provider === 'ollama'
              ? t('api.enterOllamaUrl')
              : customProtocol === 'openai'
                ? t('api.enterOpenAIUrl')
                : customProtocol === 'gemini'
                  ? t('api.enterGeminiUrl')
                  : t('api.enterAnthropicUrl')}
          </p>
          {isOllamaMode && (
            <p className="text-xs text-text-muted">{t('api.discoverLocalOllamaHint')}</p>
          )}
          {provider === 'custom' && <GuidanceInlineHint text={baseUrlGuidanceText} />}
        </div>
      )}

      {/* Model Selection */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-center justify-between">
          <label
            htmlFor="api-model-input"
            className="flex items-center gap-2 text-sm font-medium text-text-primary"
          >
            <Cpu className="w-4 h-4" />
            {t('api.model')}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void refreshOpenRouterSpecs();
              }}
              disabled={isRefreshingOpenRouterSpecs}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-surface-hover text-text-secondary hover:bg-surface-active disabled:opacity-50"
              title={t(
                'api.refreshOpenRouterSpecsHint',
                '从 OpenRouter 更新上下文窗口和多模态支持信息'
              )}
            >
              <RefreshCw
                className={`w-3 h-3 ${isRefreshingOpenRouterSpecs ? 'animate-spin' : ''}`}
              />
              {isRefreshingOpenRouterSpecs
                ? t('api.refreshingOpenRouterSpecs', '更新中')
                : t('api.refreshOpenRouterSpecs', '更新规格')}
            </button>
            {isOllamaMode && (
              <button
                type="button"
                onClick={() => {
                  void refreshModelOptions();
                }}
                disabled={isRefreshingModels}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-surface-hover text-text-secondary hover:bg-surface-active disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} />
                {isRefreshingModels ? t('api.refreshingModels') : t('api.refreshModels')}
              </button>
            )}
          </div>
        </div>

        {/* Unified model dropdown: preset models + user-added models */}
        {(() => {
          const presetIds = modelOptions.map((m) => m.id);
          const merged = [...new Set([...presetIds, ...models])].filter(Boolean);
          return (
            <select
              id="api-model-input"
              value={model || ''}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all appearance-none cursor-pointer"
            >
              {merged.length > 0 ? (
                merged.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              ) : (
                <option value="" disabled>
                  {t('api.noModelsAvailable')}
                </option>
              )}
            </select>
          );
        })()}

        {/* User-added custom models - removable chips */}
        {(() => {
          const presetIds = modelOptions.map((m) => m.id);
          const customModels = models.filter((m) => !presetIds.includes(m));
          if (customModels.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-1.5">
              {customModels.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/10 text-xs text-accent border border-accent/20"
                >
                  <span className="max-w-[180px] truncate">{m}</span>
                  <button
                    type="button"
                    onClick={() => removeModel(m)}
                    className="text-accent/60 hover:text-error transition-colors"
                    title={t('api.removeCustomModel')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          );
        })()}

        {/* Add custom model */}
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newModelInput}
            onChange={(e) => setNewModelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newModelInput.trim()) {
                e.preventDefault();
                addModel(newModelInput.trim());
                setNewModelInput('');
              }
            }}
            placeholder={t('api.addCustomModelPlaceholder')}
            className="flex-1 px-3 py-1.5 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <button
            type="button"
            onClick={() => {
              addModel(newModelInput.trim());
              setNewModelInput('');
            }}
            disabled={!newModelInput.trim()}
            className="px-2 py-1.5 rounded-lg border border-border-muted bg-surface-hover text-text-secondary hover:bg-surface-active disabled:opacity-40 transition-colors"
            title={t('api.addCustomModel')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-text-muted">{t('api.addCustomModelHint')}</p>
        {openRouterSpecsStatus && (
          <p className="text-xs text-text-muted">
            {t('api.openRouterSpecsStatus', {
              count: openRouterSpecsStatus.count,
              image: openRouterSpecsStatus.imageCapable,
              updatedAt: openRouterSpecsStatus.updatedAt
                ? new Date(openRouterSpecsStatus.updatedAt).toLocaleString()
                : t('api.openRouterSpecsBuiltIn', '内置'),
              defaultValue:
                '模型规格缓存：{{count}} 个模型，{{image}} 个支持多模态，更新时间 {{updatedAt}}',
            })}
          </p>
        )}

        {/* Context Window & Max Tokens — only for non-registry providers */}
        {(provider === 'ollama' || provider === 'custom') && (
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div>
              <label
                htmlFor="api-context-window-input"
                className="block text-xs font-medium text-text-secondary mb-1"
              >
                {t('api.contextWindow')}
              </label>
              <input
                id="api-context-window-input"
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder={t('api.contextWindowPlaceholder')}
                min={1024}
                step={1024}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
              />
            </div>
            <div>
              <label
                htmlFor="api-max-tokens-input"
                className="block text-xs font-medium text-text-secondary mb-1"
              >
                {t('api.maxOutputTokens')}
              </label>
              <input
                id="api-max-tokens-input"
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder={t('api.maxOutputTokensPlaceholder')}
                min={256}
                step={256}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
              />
            </div>
            <p className="col-span-2 text-xs text-text-muted">{t('api.contextWindowHint')}</p>
          </div>
        )}
      </div>

      {provider === 'custom' && (
        <CommonProviderSetupsCard
          setups={commonProviderSetups}
          onApplySetup={applyCommonProviderSetup}
        />
      )}

      {/* Thinking Level */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-start justify-between gap-4 text-xs text-text-muted">
          <label htmlFor="thinking-level" className="space-y-0.5 flex-1">
            <div className="text-text-primary font-medium">{t('api.thinkingLevel')}</div>
            <div>{t('api.enableThinkingHint')}</div>
            {isOllamaMode && (
              <div className="text-amber-500 dark:text-amber-400 text-xs mt-1">
                {t('api.enableThinkingOllamaHint')}
              </div>
            )}
          </label>
          <select
            id="thinking-level"
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            className="min-w-[132px] px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          >
            {THINKING_LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {successMessage && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {successMessage}
        </div>
      )}
      {/* Diagnostics Panel */}
      <ApiDiagnosticsPanel
        result={diagnosticResult}
        isRunning={isDiagnosing}
        onRunDiagnostics={handleDiagnose}
        onRunDeepDiagnostics={isOllamaMode ? handleDeepDiagnose : undefined}
        disabled={requiresApiKey && !apiKey.trim()}
      />

      {/* Save Button */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="grid grid-cols-1 gap-2">
          <button
            onClick={() => {
              void handleSave();
            }}
            disabled={isSaving || (requiresApiKey && !apiKey.trim())}
            className="w-full py-3 px-4 rounded-lg bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.saving')}
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4" />
                {t('api.saveSettings')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
