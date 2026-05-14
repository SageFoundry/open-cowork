import { ipcMain } from 'electron';
import { normalizeProjectPath, ProjectMemoryService } from '../memory/project-memory';
import { completeWithClaudeSdk } from '../claude/claude-sdk-one-shot';
import { configStore } from '../config/config-store';
import {
  applyMemoryActions,
  buildMemoryExtractionPrompt,
  parseMemoryEvaluationResponse,
} from '../memory/memory-evaluation';

export interface RegisterMemoryHandlersDeps {
  getSessionMessages: (sessionId: string) => Array<{ role: string; content: string | unknown[] }>;
  getSessionCwd: (sessionId: string) => string | null | undefined;
}

export function registerMemoryHandlers({
  getSessionMessages,
  getSessionCwd,
}: RegisterMemoryHandlersDeps): void {
  const service = new ProjectMemoryService();

  ipcMain.handle('memory.list', (_event, cwd?: string | null) => {
    const projectPath = normalizeProjectPath(cwd);
    const entries = projectPath ? service.listKnowledge(projectPath) : [];
    return entries.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      importance: e.importance,
      tags: e.tags,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
  });

  ipcMain.handle('memory.get', (_event, id: string, cwd?: string | null) => {
    const entry = service.getKnowledge(id);
    if (!entry) return null;
    const projectPath = normalizeProjectPath(cwd);
    if (!projectPath || entry.projectPath !== projectPath) return null;
    return entry;
  });

  ipcMain.handle('memory.delete', (_event, id: string, cwd?: string | null) => {
    const entry = service.getKnowledge(id);
    const projectPath = normalizeProjectPath(cwd);
    if (!entry || !projectPath || entry.projectPath !== projectPath) return;
    service.deleteKnowledge(id);
  });

  ipcMain.handle('memory.save', (_event, entry: {
    type: string;
    title: string;
    content: string;
    importance?: number;
    tags?: string[];
    sessionId?: string;
    projectPath?: string | null;
  }) => {
    const result = service.saveKnowledge({
      sessionId: entry.sessionId ?? null,
      projectPath: entry.projectPath ?? null,
      type: entry.type as any,
      title: entry.title,
      content: entry.content,
      importance: entry.importance ?? 3,
      source: 'manual',
      tags: entry.tags ?? [],
    });
    return { id: result.id };
  });

  ipcMain.handle('memory.extract', async (_event, sessionId: string) => {
    const messages = getSessionMessages(sessionId);
    const projectPath = normalizeProjectPath(getSessionCwd(sessionId));
    if (!projectPath) {
      return { entries: 0 };
    }
    const existingEntries = service.listKnowledge(projectPath);
    const { prompt, systemPrompt } = buildMemoryExtractionPrompt(messages, existingEntries);
    const response = await completeWithClaudeSdk(prompt, systemPrompt, configStore.getAll());
    const actions = parseMemoryEvaluationResponse(response.text);
    if (actions.length === 0) {
      return { entries: 0 };
    }

    const applied = applyMemoryActions(service, actions, {
      sessionId,
      projectPath,
      source: 'manual',
    });

    return { entries: applied.created + applied.updated };
  });
}
