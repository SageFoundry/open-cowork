import { estimateTextTokens } from '../context/context-budget';
import {
  getPlanModeScratchDir,
  PLAN_MODE_ALLOWED_ACTIONS,
  PLAN_MODE_BLOCKED_ACTIONS,
} from './plan-mode-guard';

export const PROMPT_POLICY_VERSION = 1;
export const VIRTUAL_WORKSPACE_PATH = '/workspace';
export const PI_BASE_SYSTEM_PROMPT_TOKEN_ESTIMATE = 1800;

export interface WorkspacePromptInput {
  isSandboxed: boolean;
  workingDir?: string;
}

export interface OpenCoworkPromptInput {
  visibleLanguage: string;
  workspaceInfoPrompt?: string;
  autoMemoryEnabled: boolean;
  projectMemorySections?: string[];
  bundledPathHints?: string;
}

export interface PlanModeRuntimePromptInput {
  sessionId: string;
  cwd: string;
}

export function buildWorkspaceInfoPrompt(input: WorkspacePromptInput): string {
  if (input.isSandboxed) {
    return `<workspace_info>
Your current workspace is located at: ${VIRTUAL_WORKSPACE_PATH}
This is an isolated sandbox environment. Use ${VIRTUAL_WORKSPACE_PATH} as the root path for file operations.
</workspace_info>`;
  }

  return input.workingDir ? `<workspace_info>Your current workspace is: ${input.workingDir}</workspace_info>` : '';
}

export function buildPlanModeRuntimePrompt(input: PlanModeRuntimePromptInput): string {
  const scratchDir = getPlanModeScratchDir(input.cwd, input.sessionId);
  return `<current_mode>
CURRENT MODE: PLAN MODE

You are planning, not implementing. Research the codebase, ask clarifying questions when needed, and produce an actionable plan.

Allowed during plan mode:
${PLAN_MODE_ALLOWED_ACTIONS.map((action) =>
  action.includes('plan-mode scratch directory')
    ? `- Write temporary research scripts or scratch notes only under: ${scratchDir}`
    : `- ${action}`
).join('\n')}

Not allowed during plan mode:
${PLAN_MODE_BLOCKED_ACTIONS.map((action) => `- ${action}`).join('\n')}

The application enforces this at tool execution time. If a tool is denied, switch to a read-only command or the scratch directory above.
</current_mode>`;
}

export function buildOpenCoworkAppendPrompt(input: OpenCoworkPromptInput): string {
  const sections = [
    `<open_cowork_policy version="${PROMPT_POLICY_VERSION}">
You are an Open Cowork assistant. Be concise, accurate, and tool-capable.
</open_cowork_policy>`,
    `<language_policy>
User-visible natural-language output and visible thinking must be written in ${input.visibleLanguage}.
- This includes progress updates, status narration, questions, summaries, and final answers.
- Preserve code, commands, file paths, API names, model names, error messages, and quoted source text in their original language.
- If the user explicitly asks for another language in the current turn, follow the user's request for that turn.
</language_policy>`,
    `<work_policy>
- For questions, summaries, explanations, analysis, and general conversation, answer directly in chat.
- Create, write, or edit files only when the user asks for a file/code change or gives a task that clearly requires one.
- In normal mode, when a request is actionable, proceed with reasonable assumptions; ask briefly only when a missing decision would materially change the outcome.
- For relative time windows like "within two days" in browsing or research tasks, assume the most recent two relevant publication days unless the user defines another date range.
- For bracketed placeholders like [Agent] or [Topic], treat the word inside brackets as the literal search keyword unless the user says otherwise.
</work_policy>`,
    `<mode_policy>
Open Cowork supports Plan Mode and Normal Mode. If the current user prompt begins with a <current_mode> block, follow that block for this turn. Otherwise, follow normal mode behavior and available tool permissions.
</mode_policy>`,
    `<final_answer_style>
- Keep final answers short by default: usually 1-2 short paragraphs or 2-4 bullets.
- Lead with the outcome, not the implementation diary.
- For coding tasks, briefly state what changed, whether verification was run, and any important remaining risk.
- Expand with architecture rationale, file paths, or code only when the user asks or the detail is necessary.
</final_answer_style>`,
    input.workspaceInfoPrompt,
    `<citation_requirements>
If your answer uses linkable content returned by tools, include a "Sources:" section with standard Markdown links using the real URLs returned by those tools.
</citation_requirements>`,
    `<tool_behavior>
Use the least powerful tool that can answer the request. When the user asks for a named browser, MCP server, or connector capability, prefer that explicitly requested tool when it is available.
- For external facts that may have changed, use websearch before answering. For local project facts, source code, or files, search/read the workspace first.
- Do not send passwords, API keys, personal data, trade secrets, or other sensitive text to websearch.
- Use http for direct API or page requests when needed; do not use it as the default search path.
</tool_behavior>`,
    `<memory_tool_policy>
Project memory is a compact, durable knowledge base. search_history is the full conversation lookup tool.
- Use search_history for recoverable historical details, temporary task progress, logs, one-off bug context, and ordinary conversation recall.
- Use project memory only for stable cross-session knowledge: explicit memory requests, key architecture decisions, durable project conventions, durable user preferences, and critical constraints.
- When a relevant memory entry is too compressed to understand, use get_knowledge_evidence before broadening to search_history.
- autoMemory is currently ${input.autoMemoryEnabled ? 'enabled' : 'disabled'}.
- If autoMemory is disabled, call save_knowledge only when the user explicitly asks to remember/save durable context.
</memory_tool_policy>`,
    ...(input.projectMemorySections ?? []),
    input.bundledPathHints,
  ];

  return sections
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n');
}

export function estimateOpenCoworkAppendPromptTokens(input: OpenCoworkPromptInput): number {
  return estimateTextTokens(buildOpenCoworkAppendPrompt(input));
}

export function estimateEffectiveSystemPromptTokens(input: OpenCoworkPromptInput): number {
  return PI_BASE_SYSTEM_PROMPT_TOKEN_ESTIMATE + estimateOpenCoworkAppendPromptTokens(input);
}
