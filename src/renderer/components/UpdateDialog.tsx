import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Download, ExternalLink, Loader2, X } from 'lucide-react';
import { useAppStore } from '../store';

export function UpdateDialog() {
  const { t } = useTranslation();
  const updateState = useAppStore((s) => s.updateState);
  const showUpdateDialog = useAppStore((s) => s.showUpdateDialog);
  const setShowUpdateDialog = useAppStore((s) => s.setShowUpdateDialog);
  const [isOpeningDownload, setIsOpeningDownload] = useState(false);

  const handleDownload = useCallback(async () => {
    setIsOpeningDownload(true);
    try {
      const result = await window.electronAPI?.update?.download?.();
      if (!result?.success) {
        setIsOpeningDownload(false);
      } else {
        setShowUpdateDialog(false);
      }
    } catch (err) {
      console.error('[UpdateDialog] Failed to open download:', err);
      setIsOpeningDownload(false);
    }
  }, [setShowUpdateDialog]);

  const handleDismiss = useCallback(() => {
    window.electronAPI?.update?.dismiss?.();
    setShowUpdateDialog(false);
  }, [setShowUpdateDialog]);

  const handleOpenReleasePage = useCallback(() => {
    window.electronAPI?.update?.openReleasePage?.();
  }, []);

  if (!showUpdateDialog) {
    return null;
  }

  const currentVersion = updateState?.currentVersion || '0.0.0';
  const latestVersion = updateState?.latestVersion || '0.0.0';
  const hasUpdate = updateState?.status === 'available';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-md mx-4 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="relative px-6 pt-6 pb-4">
          <button
            onClick={handleDismiss}
            className="absolute top-4 right-4 p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>

          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-500">
              <Download className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
                {t('update.dialog.title')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('update.dialog.subtitle')}
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 pb-4">
          <div className="p-4 rounded-xl bg-gray-50 dark:bg-gray-700/50 mb-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                {t('update.dialog.currentVersion')}
              </span>
              <span className="font-mono text-sm text-gray-900 dark:text-white">
                v{currentVersion}
              </span>
            </div>

            {hasUpdate && (
              <>
                <div className="flex items-center justify-center my-2">
                  <div className="flex-1 border-t border-gray-200 dark:border-gray-600" />
                  <span className="px-3 text-xs text-gray-400 dark:text-gray-500">
                    {t('update.dialog.updateAvailable')}
                  </span>
                  <div className="flex-1 border-t border-gray-200 dark:border-gray-600" />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                    {t('update.dialog.latestVersion')}
                  </span>
                  <span className="font-mono text-sm font-semibold text-blue-600 dark:text-blue-400">
                    v{latestVersion}
                  </span>
                </div>
              </>
            )}

            {updateState?.status === 'error' && (
              <div className="flex items-start gap-2 mt-3 text-red-600 dark:text-red-400">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span className="text-sm leading-5 break-words whitespace-pre-wrap max-h-28 overflow-y-auto">
                  {updateState.error}
                </span>
              </div>
            )}
          </div>

          {updateState?.releaseUrl && (
            <button
              onClick={handleOpenReleasePage}
              className="flex items-center gap-2 w-full p-3 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <ExternalLink className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('update.dialog.viewReleaseNotes')}
              </span>
            </button>
          )}
        </div>

        <div className="px-6 pb-6 flex flex-col gap-3">
          {hasUpdate && (
            <button
              onClick={handleDownload}
              disabled={isOpeningDownload}
              className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white font-medium rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isOpeningDownload ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Download className="w-5 h-5" />
              )}
              {t('update.dialog.downloadLatest')}
            </button>
          )}

          <button
            onClick={handleDismiss}
            className="w-full py-2.5 px-4 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl transition-colors"
          >
            {t('update.dialog.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
