import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  getPlanModeScratchDir,
  isPlanModeToolAllowed,
} from '../src/main/claude/plan-mode-guard';

const cwd = path.resolve('E:/workspace/open-cowork');
const sessionId = 'session-123';

function check(toolName: string, params: unknown, extra?: { mcpReadOnlyHint?: boolean }) {
  return isPlanModeToolAllowed({
    toolName,
    params,
    cwd,
    sessionId,
    getPlanMode: () => true,
    ...extra,
  });
}

describe('plan mode guard', () => {
  it('allows read-only research shell commands', () => {
    expect(check('bash', { command: 'rg foo src' }).allowed).toBe(true);
    expect(check('bash', { command: 'git diff -- src/main/claude/agent-runner.ts' }).allowed).toBe(true);
    expect(check('bash', { command: 'npm run typecheck' }).allowed).toBe(true);
    expect(
      check('pwsh', { command: '$lines = Get-Content src/main/claude/agent-runner.ts; $lines[0..10]' })
        .allowed
    ).toBe(true);
  });

  it('blocks source and git mutations from shell commands', () => {
    expect(check('bash', { command: 'sed -i s/foo/bar/g src/a.ts' }).allowed).toBe(false);
    expect(check('bash', { command: 'echo x > src/a.ts' }).allowed).toBe(false);
    expect(check('pwsh', { command: 'Set-Content src/a.ts x' }).allowed).toBe(false);
    expect(check('pwsh', { command: 'Remove-Item src/a.ts' }).allowed).toBe(false);
    expect(check('bash', { command: 'git commit -m plan' }).allowed).toBe(false);
  });

  it('allows scratch writes and scratch script execution', () => {
    const scratch = getPlanModeScratchDir(cwd, sessionId);
    const script = path.join(scratch, 'search.ps1');
    expect(check('Write', { path: script, content: 'mentions src/a.ts but is scratch content' }).allowed).toBe(
      true
    );
    expect(check('pwsh', { command: `Set-Content "${script}" "Get-ChildItem"` }).allowed).toBe(true);
    expect(check('pwsh', { command: `pwsh -File "${script}"` }).allowed).toBe(true);
    expect(check('bash', { command: `echo script > tmp/plan-mode/${sessionId}/search.ps1` }).allowed).toBe(true);
  });

  it('allows only read-only HTTP methods', () => {
    expect(check('http', { method: 'GET', url: 'https://example.com' }).allowed).toBe(true);
    expect(check('http', { method: 'HEAD', url: 'https://example.com' }).allowed).toBe(true);
    expect(check('http', { method: 'POST', url: 'https://example.com' }).allowed).toBe(false);
  });

  it('allows only trusted read-only MCP tools', () => {
    expect(check('mcp__Repo__search', {}, { mcpReadOnlyHint: true }).allowed).toBe(true);
    expect(check('mcp__Repo__write_file', {}).allowed).toBe(false);
    expect(check('mcp__Repo__write_file', {}, { mcpReadOnlyHint: false }).allowed).toBe(false);
  });

  it('does not restrict tools when plan mode is off', () => {
    const decision = isPlanModeToolAllowed({
      toolName: 'bash',
      params: { command: 'echo x > src/a.ts' },
      cwd,
      sessionId,
      getPlanMode: () => false,
    });
    expect(decision.allowed).toBe(true);
  });
});
