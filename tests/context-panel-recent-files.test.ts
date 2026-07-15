import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const contextPanelPath = path.resolve(process.cwd(), 'src/renderer/components/ContextPanel.tsx');
const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');

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
    expect(source).toContain('context.compressionInlineSummary');
  });

  it('merges session-level context management stats into the fixed context section', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('contextCompactionStats');
    expect(source).toContain('contextStatsOpen');
    expect(source).toContain('compactionHistory');
    expect(source).toContain('context.contextManageSummary');
    expect(source).not.toContain("<span>{t('context.contextManagementStats')}</span>");
    expect(source).toContain('context.contextStatsDetail');
    expect(source).toContain('expandedContextPreviewKey');
    expect(source).toContain('context.viewCompactedContext');
    expect(source).toContain('formatCompactionDateTime');
    expect(source).toContain('context.compactedSummaryTitle');
    expect(source).toContain('context.compactedRuntimeTitle');
    expect(source).toContain('expandedRuntimePreviewKey');
    expect(source).toContain('context.viewRuntimePreview');
    expect(source).toContain('item.summaryText || item.summaryPreview');
  });

  it('hydrates token budget when opening a historical session', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain("getSessionTokenBudget(activeSessionId, activeSession?.model)");
    expect(source).toContain('setSessionTokenBudget(activeSessionId, snapshot)');
  });

  it('refreshes context information when the runtime model changes', () => {
    const source = fs.readFileSync(sessionManagerPath, 'utf8');
    expect(source).toContain('const tokenBudget = this.getTokenBudgetSnapshot(sessionId);');
    expect(source).toContain("type: 'session.contextInfo'");
    expect(source).toContain('this.emitTokenBudget(sessionId, tokenBudget);');
  });

  it('uses an in-app compact confirmation dialog instead of native confirm', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('compactConfirmOpen');
    expect(source).toContain('handleConfirmCompactNow');
    expect(source).not.toContain("window.confirm(t('context.compactConfirm'))");
  });

  it('keeps the right context panel body scrollable', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('w-72 min-h-0 bg-background');
    expect(source).toContain('flex-1 min-h-0 overflow-y-auto overscroll-contain');
  });

  it('keeps model, working directory, and context usage above the scroll body', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    const modelIndex = source.indexOf('{modelName}');
    const workingDirIndex = source.indexOf("{t('context.workingDirectory')}");
    const contextUsageIndex = source.indexOf("{t('context.contextUsage')}");
    const scrollIndex = source.indexOf('flex-1 min-h-0 overflow-y-auto overscroll-contain');
    const mcpIndex = source.indexOf("{t('context.mcpConnectors')}");

    expect(modelIndex).toBeGreaterThan(-1);
    expect(workingDirIndex).toBeGreaterThan(modelIndex);
    expect(contextUsageIndex).toBeGreaterThan(workingDirIndex);
    expect(scrollIndex).toBeGreaterThan(contextUsageIndex);
    expect(mcpIndex).toBeGreaterThan(scrollIndex);
  });
});
