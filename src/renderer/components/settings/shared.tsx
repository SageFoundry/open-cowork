// Shared types, constants, and components used across settings tab files.

import type { TFunction } from 'i18next';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ScheduleWeekday } from '../../types';

// ==================== Shared Types ====================

export interface MCPServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface MCPServerStatus {
  id: string;
  name: string;
  connected: boolean;
  status: 'connecting' | 'connected' | 'failed' | 'disabled';
  toolCount: number;
}

export interface MCPToolInfo {
  serverId: string;
  name: string;
  description?: string;
}

export interface MCPPreset {
  name: string;
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  requiresEnv?: string[];
  envDescription?: Record<string, string>;
}

export type LocalizedBanner = { key?: string; text?: string };

export type ScheduleFormMode = 'once' | 'daily' | 'weekly' | 'legacy-interval';

// ==================== Shared Helpers ====================

export function renderLocalizedBannerMessage(banner: LocalizedBanner, t: TFunction): string {
  return banner.key ? t(banner.key) : banner.text || '';
}

export function getWeekdayOptions(t: TFunction): Array<{ value: ScheduleWeekday; label: string }> {
  return [
    { value: 1, label: t('schedule.weekdayMonday') },
    { value: 2, label: t('schedule.weekdayTuesday') },
    { value: 3, label: t('schedule.weekdayWednesday') },
    { value: 4, label: t('schedule.weekdayThursday') },
    { value: 5, label: t('schedule.weekdayFriday') },
    { value: 6, label: t('schedule.weekdaySaturday') },
    { value: 0, label: t('schedule.weekdaySunday') },
  ];
}

export function getScheduleModeOptions(
  t: TFunction
): Array<{ value: ScheduleFormMode; label: string }> {
  return [
    { value: 'once', label: t('schedule.modeOnce') },
    { value: 'daily', label: t('schedule.modeDaily') },
    { value: 'weekly', label: t('schedule.modeWeekly') },
  ];
}

// ==================== Shared UI Component ====================

export function SettingsContentSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 py-5 border-b border-border-muted">
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-text-primary">{title}</h4>
        {description && <p className="text-xs leading-5 text-text-muted">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function ConfirmOverlay({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  isLoading,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-[90] bg-black/45 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface shadow-elevated p-5">
        <h3 className="text-base font-semibold text-text-primary">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 rounded-lg border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 rounded-lg bg-error text-white hover:bg-error/90 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
