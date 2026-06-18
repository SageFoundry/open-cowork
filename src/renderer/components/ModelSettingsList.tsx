import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Settings, X } from 'lucide-react';
import {
  MODEL_CAPABILITIES,
  resolveModelCapabilities,
  type CapabilityMode,
  type ImageInputMode,
  type ModelCapabilityId,
} from '../../shared/model-capabilities';
import type { ProviderModelInfo } from '../types';
import type { UIProviderModelSettings } from '../hooks/useApiConfigState';

interface ModelSettingsListProps {
  model: string;
  models: string[];
  modelOptions: ProviderModelInfo[];
  modelSettings: Record<string, UIProviderModelSettings>;
  compact?: boolean;
  onSelectModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onSetContextWindow: (modelId: string, value: string) => void;
  onSetMaxTokens: (modelId: string, value: string) => void;
  onSetImageInputMode: (modelId: string, value: ImageInputMode) => void;
  onSetCapabilityMode?: (
    modelId: string,
    capabilityId: ModelCapabilityId,
    value: CapabilityMode
  ) => void;
}

const EMPTY_MODEL_SETTINGS: UIProviderModelSettings = {
  contextWindow: '',
  maxTokens: '',
  imageInputMode: 'auto',
  capabilities: {},
};

function nextCapabilityMode(current: CapabilityMode): CapabilityMode {
  if (current === 'auto') return 'enabled';
  if (current === 'enabled') return 'disabled';
  return 'auto';
}

export function ModelSettingsList({
  model,
  models,
  modelOptions,
  modelSettings,
  compact = false,
  onSelectModel,
  onRemoveModel,
  onSetContextWindow,
  onSetMaxTokens,
  onSetImageInputMode,
  onSetCapabilityMode,
}: ModelSettingsListProps) {
  const { t } = useTranslation();
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  const presetIds = useMemo(() => modelOptions.map((item) => item.id), [modelOptions]);
  const modelIds = useMemo(() => new Set(models), [models]);
  const rows = useMemo(
    () => [...new Set([...presetIds, ...models])].filter(Boolean),
    [models, presetIds]
  );

  if (rows.length === 0) {
    return (
      <div className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-text-muted">
        {t('api.noModelsAvailable')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((modelId) => {
        const settings = modelSettings[modelId] || EMPTY_MODEL_SETTINGS;
        const capabilityModes = {
          ...settings.capabilities,
          ...(settings.imageInputMode !== 'auto' ? { imageInput: settings.imageInputMode } : {}),
        };
        const resolvedCapabilities = resolveModelCapabilities(capabilityModes, modelId);
        const isActive = model === modelId;
        const canRemove = modelIds.has(modelId);
        const isExpanded = expandedModel === modelId;
        const visibleBadges = MODEL_CAPABILITIES.filter(
          (capability) => resolvedCapabilities[capability.id]
        );
        const manualCount = Object.keys(capabilityModes).length;

        return (
          <div
            key={modelId}
            className={`rounded-lg border transition-colors ${
              isActive ? 'border-accent/40 bg-accent/5' : 'border-border bg-background'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                onSelectModel(modelId);
                setExpandedModel(isExpanded ? null : modelId);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">{modelId}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {visibleBadges.slice(0, 5).map((capability) => (
                    <span
                      key={capability.id}
                      className={`px-1.5 py-0.5 rounded text-[11px] border ${
                        capability.group === 'input'
                          ? 'border-accent/25 bg-accent/10 text-accent'
                          : 'border-border-muted bg-surface-hover text-text-secondary'
                      }`}
                    >
                      {t(capability.labelKey)}
                    </span>
                  ))}
                  {manualCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[11px] border border-border-muted bg-surface-hover text-text-secondary">
                      {t('api.capabilityManual')}
                    </span>
                  )}
                </div>
              </div>
              <Settings
                className={`w-4 h-4 flex-shrink-0 transition-colors ${
                  isExpanded ? 'text-accent' : 'text-text-muted'
                }`}
              />
              {canRemove && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveModel(modelId);
                }}
                className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                title={t('api.removeCustomModel')}
              >
                <X className="w-4 h-4" />
              </button>
              )}
            </button>

            {isExpanded && (
              <div className={`grid ${compact ? 'grid-cols-1' : 'grid-cols-2'} gap-3 px-3 pb-3`}>
                <div className={compact ? 'space-y-2' : 'col-span-2 space-y-2'}>
                  {(['input', 'feature', 'output'] as const).map((group) => (
                    <div key={group}>
                      <div className="mb-1 text-xs font-medium text-text-secondary">
                        {t(`api.capabilityGroup.${group}`)}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {MODEL_CAPABILITIES.filter((capability) => capability.group === group).map(
                          (capability) => {
                            const mode = capabilityModes[capability.id] || 'auto';
                            const enabled = resolvedCapabilities[capability.id];
                            return (
                              <button
                                key={capability.id}
                                type="button"
                                onClick={() => {
                                  const next = nextCapabilityMode(mode);
                                  if (capability.id === 'imageInput') {
                                    onSetImageInputMode(modelId, next);
                                  }
                                  onSetCapabilityMode?.(modelId, capability.id, next);
                                }}
                                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                                  enabled
                                    ? 'border-accent/30 bg-accent/10 text-accent'
                                    : 'border-border-muted bg-surface-hover text-text-muted opacity-70'
                                } ${
                                  mode !== 'auto' ? 'ring-1 ring-amber-500/30' : ''
                                }`}
                                title={t(
                                  mode === 'auto'
                                    ? 'api.capabilityAutoHint'
                                    : mode === 'enabled'
                                      ? 'api.capabilityEnabledHint'
                                      : 'api.capabilityDisabledHint'
                                )}
                              >
                                {enabled && <Check className="w-3 h-3" />}
                                {t(capability.labelKey)}
                              </button>
                            );
                          }
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    {t('api.contextWindow')}
                  </label>
                  <input
                    type="number"
                    value={settings.contextWindow}
                    onChange={(event) => onSetContextWindow(modelId, event.target.value)}
                    placeholder={t('api.contextWindowPlaceholder')}
                    min={1024}
                    step={1024}
                    className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    {t('api.maxOutputTokens')}
                  </label>
                  <input
                    type="number"
                    value={settings.maxTokens}
                    onChange={(event) => onSetMaxTokens(modelId, event.target.value)}
                    placeholder={t('api.maxOutputTokensPlaceholder')}
                    min={256}
                    step={256}
                    className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                  />
                </div>
                <p className={compact ? 'text-xs text-text-muted' : 'col-span-2 text-xs text-text-muted'}>
                  {t('api.modelSettingsHint')}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
