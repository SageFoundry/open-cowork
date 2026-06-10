import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useAppStore } from '../store';

export function UpdateBadge() {
  const { t } = useTranslation();
  const updateState = useAppStore((s) => s.updateState);
  const setShowUpdateDialog = useAppStore((s) => s.setShowUpdateDialog);
  const [isVisible, setIsVisible] = useState(false);

  // Determine visibility based on update status
  useEffect(() => {
    if (!updateState) {
      setIsVisible(false);
      return;
    }

    const shouldShow =
      updateState.status === 'available' ||
      updateState.status === 'downloading' ||
      updateState.status === 'downloaded' ||
      updateState.status === 'error';

    setIsVisible(shouldShow);
  }, [updateState]);

  const handleClick = useCallback(() => {
    setShowUpdateDialog(true);
  }, [setShowUpdateDialog]);

  if (!isVisible || !updateState) {
    return null;
  }

  const getStatusIcon = () => {
    switch (updateState.status) {
      case 'available':
        return <Download className="w-4 h-4" />;
      case 'downloading':
        return <Loader2 className="w-4 h-4 animate-spin" />;
      case 'downloaded':
        return <CheckCircle className="w-4 h-4" />;
      case 'error':
        return <AlertCircle className="w-4 h-4" />;
      default:
        return <Download className="w-4 h-4" />;
    }
  };

  const getStatusColor = () => {
    switch (updateState.status) {
      case 'available':
        return 'bg-blue-500 hover:bg-blue-600';
      case 'downloading':
        return 'bg-yellow-500 hover:bg-yellow-600';
      case 'downloaded':
        return 'bg-green-500 hover:bg-green-600';
      case 'error':
        return 'bg-red-500 hover:bg-red-600';
      default:
        return 'bg-gray-500 hover:bg-gray-600';
    }
  };

  const getTooltipText = () => {
    switch (updateState.status) {
      case 'available':
        return t('update.tooltip.available', { version: updateState.latestVersion });
      case 'downloading':
        return t('update.tooltip.downloading', {
          progress: updateState.downloadProgress?.percent?.toFixed(0) || 0,
        });
      case 'downloaded':
        return t('update.tooltip.downloaded');
      case 'error':
        return t('update.tooltip.error');
      default:
        return '';
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`
        relative flex items-center justify-center w-8 h-8 rounded-full
        text-white transition-all duration-200 transform hover:scale-110
        ${getStatusColor()}
        shadow-lg shadow-black/20 dark:shadow-black/40
      `}
      title={getTooltipText()}
    >
      {getStatusIcon()}

      {/* Pulse animation for available updates */}
      {updateState.status === 'available' && (
        <span className="absolute inset-0 rounded-full animate-ping bg-blue-400 opacity-75" />
      )}

      {/* Progress indicator for downloading */}
      {updateState.status === 'downloading' && updateState.downloadProgress && (
        <svg className="absolute inset-0 w-8 h-8 -rotate-90" viewBox="0 0 32 32">
          <circle
            cx="16"
            cy="16"
            r="14"
            fill="none"
            stroke="rgba(255,255,255,0.3)"
            strokeWidth="3"
          />
          <circle
            cx="16"
            cy="16"
            r="14"
            fill="none"
            stroke="white"
            strokeWidth="3"
            strokeDasharray={`${(updateState.downloadProgress.percent / 100) * 88} 88`}
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
