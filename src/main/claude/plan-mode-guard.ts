import * as path from 'path';
import { isPathWithinRoot } from '../../shared/path-containment';

export interface PlanModeToolGuardInput {
  toolName: string;
  params?: unknown;
  cwd: string;
  sessionId: string;
  getPlanMode: (sessionId: string) => boolean;
  mcpReadOnlyHint?: boolean;
}

export interface PlanModeToolDecision {
  allowed: boolean;
  reason?: string;
}

export const PLAN_MODE_DENIED_MESSAGE =
  'Plan mode is active. This action may modify workspace state. Use a read-only inspection command or write scratch files under tmp/plan-mode/<sessionId>.';

const READ_ONLY_MEMORY_TOOLS = new Set([
  'search_history',
  'query_knowledge',
  'list_knowledge',
  'get_knowledge',
]);

const WRITE_MEMORY_TOOLS = new Set(['save_knowledge', 'delete_knowledge']);

const SHELL_WRITE_COMMAND_RE =
  /\b(sed\s+-i|git\s+(commit|push|checkout|reset|merge|rebase|tag|clean)|npm\s+run\s+(format|lint:fix|codegen|migrate|migration)|prettier\b[^;&|]*\s+--write|eslint\b[^;&|]*\s+--fix|prisma\s+migrate)\b/i;

const POWERSHELL_WRITE_CMD_RE =
  /\b(Set-Content|Add-Content|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Out-File|Tee-Object|Export-\w+)\b/i;

const SHELL_WRITE_CMD_RE = /\b(rm|mv|cp|touch|mkdir|rmdir)\b/i;

const READ_COMMAND_RE =
  /(^|[\s;&|()])((rg|grep|git\s+(status|diff|log|show|grep|ls-files|branch)|Get-ChildItem|Select-String|Get-Content|Test-Path|Resolve-Path|Measure-Object|Sort-Object|Where-Object|Select-Object|Format-List|Format-Table|ls|dir|type|cat|head|tail|wc|tree)\b)/i;

const TEST_COMMAND_RE = /\b(npm\s+(test|run\s+(test|typecheck))|pnpm\s+(test|run\s+(test|typecheck))|yarn\s+(test|typecheck))\b/i;

const SCRIPT_RUNNER_RE = /\b(node|python|python3|py|bash|sh|pwsh|powershell)\b/i;

export function getPlanModeScratchDir(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.resolve(cwd, 'tmp', 'plan-mode', safeSessionId);
}

export function isPlanModeToolAllowed(input: PlanModeToolGuardInput): PlanModeToolDecision {
  if (!input.getPlanMode(input.sessionId)) {
    return { allowed: true };
  }

  const toolName = input.toolName.toLowerCase();
  if (toolName === 'write' || toolName === 'edit') {
    return areToolPathsInsideScratch(input)
      ? { allowed: true }
      : denied('File edits are only allowed in the plan-mode scratch directory.');
  }

  if (toolName === 'bash' || toolName === 'pwsh') {
    return isShellCommandAllowed(input);
  }

  if (toolName === 'http') {
    const method = getParamString(input.params, 'method')?.toUpperCase() || 'GET';
    return method === 'GET' || method === 'HEAD'
      ? { allowed: true }
      : denied('Plan mode only allows HTTP GET and HEAD requests.');
  }

  if (toolName === 'execute_background_command') {
    return denied('Plan mode does not allow starting background processes.');
  }

  if (READ_ONLY_MEMORY_TOOLS.has(toolName)) {
    return { allowed: true };
  }
  if (WRITE_MEMORY_TOOLS.has(toolName)) {
    return denied('Plan mode does not allow persistent memory writes.');
  }

  if (toolName.startsWith('mcp__')) {
    return input.mcpReadOnlyHint === true
      ? { allowed: true }
      : denied('Plan mode only allows MCP tools marked read-only by a trusted server.');
  }

  return { allowed: true };
}

export function assertPlanModeToolAllowed(input: PlanModeToolGuardInput): void {
  const decision = isPlanModeToolAllowed(input);
  if (!decision.allowed) {
    throw new Error(decision.reason || PLAN_MODE_DENIED_MESSAGE);
  }
}

function denied(detail: string): PlanModeToolDecision {
  return {
    allowed: false,
    reason: `${PLAN_MODE_DENIED_MESSAGE}\n\n${detail}`,
  };
}

function areToolPathsInsideScratch(input: PlanModeToolGuardInput): boolean {
  const strings = collectPathStrings(input.params);
  const pathCandidates = strings.filter((value) => looksLikePath(value));
  if (pathCandidates.length === 0) {
    return false;
  }
  return pathCandidates.every((candidate) => isInsideScratch(candidate, input.cwd, input.sessionId));
}

function isShellCommandAllowed(input: PlanModeToolGuardInput): PlanModeToolDecision {
  const command = getParamString(input.params, 'command') || '';
  const trimmed = command.trim();
  if (!trimmed) {
    return denied('Empty shell commands are not useful for plan-mode research.');
  }

  const redirectionTargets = extractRedirectionTargets(trimmed);
  if (redirectionTargets.length > 0) {
    if (!redirectionTargets.every((target) => isInsideScratch(target, input.cwd, input.sessionId))) {
      return denied('Shell redirection may only write inside tmp/plan-mode/<sessionId>.');
    }
    if (!hasKnownDangerousShellWrite(trimmed)) {
      return { allowed: true };
    }
  }

  const powershellWriteTargets = extractPowerShellWriteTargets(trimmed);
  if (POWERSHELL_WRITE_CMD_RE.test(trimmed)) {
    if (
      powershellWriteTargets.length > 0 &&
      powershellWriteTargets.every((target) => isInsideScratch(target, input.cwd, input.sessionId))
    ) {
      return { allowed: true };
    }
    return denied('PowerShell write cmdlets may only target tmp/plan-mode/<sessionId>.');
  }

  const shellWriteTargets = extractSimpleShellWriteTargets(trimmed);
  if (SHELL_WRITE_CMD_RE.test(trimmed)) {
    if (
      shellWriteTargets.length > 0 &&
      shellWriteTargets.every((target) => isInsideScratch(target, input.cwd, input.sessionId))
    ) {
      return { allowed: true };
    }
    return denied('Filesystem mutation commands may only target tmp/plan-mode/<sessionId>.');
  }

  if (SHELL_WRITE_COMMAND_RE.test(trimmed)) {
    return denied('This command is known to modify source, git state, or generated project files.');
  }

  if (runsScratchScript(trimmed, input.cwd, input.sessionId)) {
    return { allowed: true };
  }

  if (READ_COMMAND_RE.test(trimmed) || TEST_COMMAND_RE.test(trimmed)) {
    return { allowed: true };
  }

  if (SCRIPT_RUNNER_RE.test(trimmed)) {
    return denied('Script runners are only allowed when executing a script from tmp/plan-mode/<sessionId>.');
  }

  return denied('This shell command is not recognized as a read-only research command.');
}

function hasKnownDangerousShellWrite(command: string): boolean {
  return SHELL_WRITE_COMMAND_RE.test(command) || POWERSHELL_WRITE_CMD_RE.test(command);
}

function getParamString(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function collectPathStrings(value: unknown, keyHint = ''): string[] {
  if (typeof value === 'string') {
    return isPathKey(keyHint) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectPathStrings(item, keyHint));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => collectPathStrings(item, key));
  }
  return [];
}

function isPathKey(key: string): boolean {
  return /(path|file|filename|target|source|destination)/i.test(key);
}

function looksLikePath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /\.[a-zA-Z0-9]{1,8}$/.test(value)
  );
}

function isInsideScratch(candidate: string, cwd: string, sessionId: string): boolean {
  const stripped = stripShellQuotes(candidate);
  const absolute = path.isAbsolute(stripped) ? path.resolve(stripped) : path.resolve(cwd, stripped);
  return isPathWithinRoot(absolute, getPlanModeScratchDir(cwd, sessionId), process.platform === 'win32');
}

function stripShellQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function extractRedirectionTargets(command: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|[\s])(?:\d?>{1,2}|>{1,2})\s*(['"]?)([^'"|&;\s]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    targets.push(match[2]);
  }
  return targets;
}

function extractPowerShellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const cmdRe =
    /\b(?:Set-Content|Add-Content|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Out-File|Tee-Object|Export-\w+)\b([^;&|]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = cmdRe.exec(command)) !== null) {
    const segment = match[1] || '';
    const pathArg =
      /-(?:Path|LiteralPath|FilePath)\s+(['"]?)([^'"\s]+)\1/i.exec(segment)?.[2] ||
      /^\s+(['"]?)([^'"\s]+)\1/.exec(segment)?.[2];
    if (pathArg) targets.push(pathArg);
  }
  return targets;
}

function extractSimpleShellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const cmdRe = /\b(?:rm|mv|cp|touch|mkdir|rmdir)\b([^;&|]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = cmdRe.exec(command)) !== null) {
    const args = (match[1] || '')
      .trim()
      .split(/\s+/)
      .filter((arg) => arg && !arg.startsWith('-'));
    targets.push(...args);
  }
  return targets;
}

function runsScratchScript(command: string, cwd: string, sessionId: string): boolean {
  if (!SCRIPT_RUNNER_RE.test(command)) return false;
  const tokens = command.match(/(?:"[^"]+"|'[^']+'|[^\s]+)/g) || [];
  return tokens.some((token) => isInsideScratch(token, cwd, sessionId));
}
