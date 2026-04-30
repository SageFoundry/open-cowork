import { ipcMain } from 'electron';
import type { BackgroundTaskStartInput } from '../../renderer/types';
import type { BackgroundTaskService } from '../background/background-task-service';

export interface RegisterTasksHandlersDeps {
  getBackgroundTaskService: () => BackgroundTaskService | null;
}

export function registerTasksHandlers({
  getBackgroundTaskService,
}: RegisterTasksHandlersDeps): void {
  ipcMain.handle('tasks.list', () => {
    return getBackgroundTaskService()?.listTasks() || [];
  });

  ipcMain.handle('tasks.start', async (_event, payload: BackgroundTaskStartInput) => {
    const service = getBackgroundTaskService();
    if (!service) {
      throw new Error('Background task service not initialized');
    }
    return service.startTask(payload);
  });

  ipcMain.handle('tasks.stop', async (_event, taskId: string) => {
    const service = getBackgroundTaskService();
    if (!service) {
      throw new Error('Background task service not initialized');
    }
    return service.stopTask(taskId);
  });

  ipcMain.handle('tasks.getLogTail', (_event, taskId: string, maxChars?: number) => {
    const service = getBackgroundTaskService();
    if (!service) {
      return '';
    }
    return service.getLogTail(taskId, maxChars);
  });

  ipcMain.handle('tasks.openLog', async (_event, taskId: string) => {
    const service = getBackgroundTaskService();
    if (!service) {
      return false;
    }
    return service.openLog(taskId);
  });

  ipcMain.handle('tasks.openDetectedUrl', async (_event, taskId: string) => {
    const service = getBackgroundTaskService();
    if (!service) {
      return false;
    }
    return service.openDetectedUrl(taskId);
  });
}
