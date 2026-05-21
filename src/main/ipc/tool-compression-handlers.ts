import { ipcMain } from 'electron';
import { getDatabase } from '../db/database';
import {
  getToolOutputCompressionStats,
  resetToolOutputCompressionStats,
} from '../tools/tool-output-compression-stats';
import { logError } from '../utils/logger';

export function registerToolCompressionHandlers(): void {
  ipcMain.handle('toolCompression.getStats', () => {
    try {
      return getToolOutputCompressionStats(getDatabase());
    } catch (error) {
      logError('[ToolCompression] Failed to load stats:', error);
      throw error;
    }
  });

  ipcMain.handle('toolCompression.getSessionStats', (_event, sessionId: string) => {
    try {
      return getToolOutputCompressionStats(getDatabase(), { sessionId });
    } catch (error) {
      logError('[ToolCompression] Failed to load session stats:', error);
      throw error;
    }
  });

  ipcMain.handle('toolCompression.resetStats', () => {
    try {
      resetToolOutputCompressionStats(getDatabase());
      return getToolOutputCompressionStats(getDatabase());
    } catch (error) {
      logError('[ToolCompression] Failed to reset stats:', error);
      throw error;
    }
  });
}
