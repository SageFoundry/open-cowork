import { ipcMain } from 'electron';
import { ProjectMemoryService } from '../memory/project-memory';

export interface RegisterMemoryHandlersDeps {
  getSessionMessages: (sessionId: string) => Array<{ role: string; content: string | unknown[] }>;
}

export function registerMemoryHandlers({
  getSessionMessages,
}: RegisterMemoryHandlersDeps): void {
  const service = new ProjectMemoryService();

  ipcMain.handle('memory.list', () => {
    const entries = service.listKnowledge();
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

  ipcMain.handle('memory.get', (_event, id: string) => {
    const entry = service.getKnowledge(id);
    if (!entry) return null;
    return entry;
  });

  ipcMain.handle('memory.delete', (_event, id: string) => {
    service.deleteKnowledge(id);
  });

  ipcMain.handle('memory.save', (_event, entry: {
    type: string;
    title: string;
    content: string;
    importance?: number;
    tags?: string[];
    sessionId?: string;
  }) => {
    const result = service.saveKnowledge({
      sessionId: entry.sessionId ?? null,
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
    // Gather messages from the session
    const messages = getSessionMessages(sessionId);
    let count = 0;

    // Build a simple text summary of the conversation
    const textParts: string[] = [];
    for (const msg of messages.slice(-50)) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
      }
      if (content.trim()) {
        textParts.push(`[${role}]: ${content}`);
      }
    }

    if (textParts.length === 0) return { entries: 0 };

    // Extract candidate knowledge entries via simple heuristic:
    // 1. Check for "remember" / "记住" patterns in user messages
    // 2. Check for importance markers in context
    const userMessages = messages.filter((m) => m.role === 'user').slice(-20);

    for (const msg of userMessages) {
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
      }

      const rememberMatch = text.match(/记住[：:]\s*(.+)/);
      if (rememberMatch) {
        const content = rememberMatch[1].trim();
        service.saveKnowledge({
          sessionId,
          type: 'fact',
          title: content.slice(0, 80),
          content,
          importance: 3,
          source: 'manual',
          tags: ['extracted'],
        });
        count++;
        continue;
      }

      // Also handle English "remember this"
      const engMatch = text.match(/remember\s+(?:that\s+)?(?:this\s+)?[：:]\s*(.+)/i);
      if (engMatch) {
        const content = engMatch[1].trim();
        service.saveKnowledge({
          sessionId,
          type: 'fact',
          title: content.slice(0, 80),
          content,
          importance: 3,
          source: 'manual',
          tags: ['extracted'],
        });
        count++;
      }
    }

    return { entries: count };
  });
}
