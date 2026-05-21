import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const contextPanelPath = path.resolve(process.cwd(), 'src/renderer/components/ContextPanel.tsx');

describe('ContextPanel memory module integration', () => {
  it('loads memory list through electron memory API', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('window.electronAPI.memory.list');
    expect(source).toContain('setMemoryList');
  });

  it('renders memory list with type icons and delete button', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('TypeIcon');
    expect(source).toContain('Trash2');
    expect(source).toContain('handleDeleteMemory');
  });

  it('supports auto memory toggle and extract memory button', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('handleToggleAutoMemory');
    expect(source).toContain('autoMemory');
    expect(source).toContain('handleExtractMemory');
    expect(source).toContain('extractMemory');
  });

  it('shows session-level tool compression stats below memory', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('getSessionStats(activeSessionId)');
    expect(source).toContain('sessionCompressionStats');
    expect(source).toContain('compressionStatsOpen');
    expect(source).toContain('context.compressionStats');
  });
});
