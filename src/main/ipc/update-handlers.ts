import { ipcMain, BrowserWindow } from 'electron';
import { log } from '../utils/logger';
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  dismissUpdate,
  getUpdateState,
  openReleasePage,
  sanitizeUpdateError,
} from '../update/update-manager';
import type { UpdateState } from '../update/update-manager';

/**
 * Register IPC handlers for the auto-update feature.
 */
export function registerUpdateHandlers(_getMainWindow: () => BrowserWindow | null): void {
  // update.check - Check for updates
  ipcMain.handle('update.check', async (): Promise<UpdateState> => {
    log('[IPC] update.check requested');
    return checkForUpdates();
  });

  // update.download - Download available update
  ipcMain.handle('update.download', async (): Promise<{ success: boolean; error?: string }> => {
    log('[IPC] update.download requested');
    try {
      await downloadUpdate();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: sanitizeUpdateError(err) };
    }
  });

  // update.install - Install downloaded update (quit and install)
  ipcMain.handle('update.install', async (): Promise<void> => {
    log('[IPC] update.install requested');
    installUpdate();
  });

  // update.dismiss - Dismiss current update notification
  ipcMain.handle('update.dismiss', async (): Promise<void> => {
    log('[IPC] update.dismiss requested');
    dismissUpdate();
  });

  // update.getState - Get current update state
  ipcMain.handle('update.getState', async (): Promise<UpdateState> => {
    return getUpdateState();
  });

  // update.openReleasePage - Open release page in browser
  ipcMain.handle('update.openReleasePage', async (): Promise<void> => {
    log('[IPC] update.openReleasePage requested');
    openReleasePage();
  });
}
