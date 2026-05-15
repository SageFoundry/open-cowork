import { describe, expect, it } from 'vitest';
import {
  buildOpenCoworkAppendPrompt,
  buildPlanModeRuntimePrompt,
  buildWorkspaceInfoPrompt,
  estimateEffectiveSystemPromptTokens,
  VIRTUAL_WORKSPACE_PATH,
} from '../src/main/claude/prompt-contract';
import {
  PLAN_MODE_ALLOWED_ACTIONS,
  PLAN_MODE_BLOCKED_ACTIONS,
} from '../src/main/claude/plan-mode-guard';

describe('Open Cowork prompt contract', () => {
  it('builds a compact policy prompt without duplicated legacy sections', () => {
    const prompt = buildOpenCoworkAppendPrompt({
      visibleLanguage: 'Chinese (中文)',
      workspaceInfoPrompt: '<workspace_info>Your current workspace is: E:/repo</workspace_info>',
      autoMemoryEnabled: false,
      projectMemorySections: ['<project_memory_guidance>Use memory carefully.</project_memory_guidance>'],
      bundledPathHints: '<bundled_executables>- rg: E:/tools/rg.exe</bundled_executables>',
    });

    expect(prompt).toContain('<open_cowork_policy version="1">');
    expect(prompt).toContain('<language_policy>');
    expect(prompt).toContain('Chinese (中文)');
    expect(prompt).toContain('<work_policy>');
    expect(prompt).toContain('proceed with reasonable assumptions');
    expect(prompt).toContain('within two days');
    expect(prompt).toContain('<mode_policy>');
    expect(prompt).toContain('<memory_tool_policy>');
    expect(prompt).toContain('search_history is the full conversation lookup tool');
    expect(prompt).toContain('autoMemory is currently disabled');
    expect(prompt).toContain('<project_memory_guidance>Use memory carefully.</project_memory_guidance>');
    expect(prompt).toContain('<bundled_executables>');

    expect(prompt).not.toContain('<plan_mode_capabilities>');
    expect(prompt).not.toContain('START DOING IT');
    expect(prompt).not.toContain('https://claude.ai/chat/URL');
  });

  it('renders workspace information for sandboxed and normal workspaces', () => {
    expect(buildWorkspaceInfoPrompt({ isSandboxed: true, workingDir: 'E:/repo' })).toContain(
      VIRTUAL_WORKSPACE_PATH
    );
    expect(buildWorkspaceInfoPrompt({ isSandboxed: false, workingDir: 'E:/repo' })).toContain(
      'E:/repo'
    );
  });

  it('keeps plan mode runtime prompt aligned with guard policy lists', () => {
    const prompt = buildPlanModeRuntimePrompt({
      sessionId: 'session-123',
      cwd: 'E:/workspace/open-cowork',
    });

    for (const action of PLAN_MODE_ALLOWED_ACTIONS) {
      if (!action.includes('plan-mode scratch directory')) {
        expect(prompt).toContain(action);
      }
    }
    for (const action of PLAN_MODE_BLOCKED_ACTIONS) {
      expect(prompt).toContain(action);
    }
    expect(prompt).toContain('tmp');
    expect(prompt).toContain('session-123');
  });

  it('estimates policy prompt tokens including Open Cowork additions', () => {
    const estimated = estimateEffectiveSystemPromptTokens({
      visibleLanguage: 'English',
      workspaceInfoPrompt: buildWorkspaceInfoPrompt({ isSandboxed: false, workingDir: 'E:/repo' }),
      autoMemoryEnabled: true,
      projectMemorySections: ['<project_memory_relevant>Important detail</project_memory_relevant>'],
    });

    expect(estimated).toBeGreaterThan(1800);
  });
});
