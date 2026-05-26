import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const chatViewPath = path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx');
const sidebarPath = path.resolve(process.cwd(), 'src/renderer/components/Sidebar.tsx');
const storePath = path.resolve(process.cwd(), 'src/renderer/store/index.ts');

const chatViewContent = readFileSync(chatViewPath, 'utf8');
const sidebarContent = readFileSync(sidebarPath, 'utf8');
const storeContent = readFileSync(storePath, 'utf8');

describe('chat message pagination', () => {
  it('loads enough messages per page to avoid rapid prepend loops on rich turns', () => {
    expect(chatViewContent).toContain('const MESSAGES_PAGE_SIZE = 20;');
    expect(sidebarContent).toContain('const INITIAL_MESSAGES_PAGE_SIZE = 20;');
  });

  it('deduplicates prepended messages returned around pagination boundaries', () => {
    expect(storeContent).toContain('const existingIds = new Set(ss.messages.map((message) => message.id));');
    expect(storeContent).toContain(
      'const nextMessages = messages.filter((message) => !existingIds.has(message.id));'
    );
    expect(storeContent).toContain('messages: [...nextMessages, ...ss.messages]');
  });

  it('guards scroll restore from fighting the resize observer', () => {
    expect(chatViewContent).toContain('const isRestoringPrependRef = useRef(false);');
    expect(chatViewContent).toContain('!isRestoringPrependRef.current && container.scrollTop <= 80');
    expect(chatViewContent).toContain(
      '!isScrollingRef.current && !isRestoringPrependRef.current && isUserAtBottomRef.current'
    );
    expect(chatViewContent).toContain('requestAnimationFrame(() => {\n        requestAnimationFrame(() => {');
  });
});
