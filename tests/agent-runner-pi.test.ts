import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/claude/agent-runner.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');

describe('ClaudeAgentRunner pi-coding-agent integration', () => {
  it('avoids dynamic re-import shadowing for config store singletons', () => {
    expect(agentRunnerContent).toContain(
      "import { mcpConfigStore } from '../mcp/mcp-config-store'"
    );
    expect(agentRunnerContent).not.toContain(
      "const { configStore } = await import('../config/config-store')"
    );
    expect(agentRunnerContent).not.toContain(
      "const { mcpConfigStore } = await import('../mcp/mcp-config-store')"
    );
  });

  it('keeps MCP config build resilient', () => {
    expect(agentRunnerContent).toContain('function safeStringify');
    expect(agentRunnerContent).toContain('Failed to prepare MCP server config, skipping server');
  });

  it('uses standard markdown link guidance for sources citations', () => {
    expect(agentRunnerContent).toContain('buildOpenCoworkAppendPrompt');
    expect(agentRunnerContent).not.toContain('https://claude.ai/chat/URL');
  });

  it('avoids duplicating the current user prompt in contextual history assembly', () => {
    expect(agentRunnerContent).toContain('const conversationMessages = existingMessages');
    // Image-containing messages are filtered out individually (not skipping entire history)
    expect(agentRunnerContent).toContain('const textOnlyMessages = conversationMessages');
    expect(agentRunnerContent).toContain(
      'const candidateEntries = excludedCurrentTurnUser ? historyEntries.slice(0, -1)'
    );
    expect(agentRunnerContent).toContain(
      "historyEntries[historyEntries.length - 1]?.role === 'user'"
    );
  });

  it('keeps MCP server logging compact unless full debug logging is enabled', () => {
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Final mcpServers summary:'");
    expect(agentRunnerContent).toContain("if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {");
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Final mcpServers config:'");
  });

  it('summarizes noisy SDK message updates instead of logging every text delta', () => {
    expect(agentRunnerContent).toContain('const streamEventCounts = new Map<string, number>();');
    expect(agentRunnerContent).toContain("updateType !== 'text_delta'");
    expect(agentRunnerContent).toContain("updateType !== 'thinking_delta'");
    expect(agentRunnerContent).toContain("updateType !== 'toolcall_delta'");
    expect(agentRunnerContent).toContain("'[ClaudeAgentRunner] Event: message_end'");
    expect(agentRunnerContent).toContain('messageUpdateCounts: getStreamEventSummary()');
    expect(agentRunnerContent).toContain("if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {");
    expect(agentRunnerContent).toContain("'[ClaudeAgentRunner] message_end raw message:'");
  });

  it('reuses the shared user-facing error helper', () => {
    expect(agentRunnerContent).toContain(
      "import { resolveMessageEndPayload, toUserFacingErrorText } from './agent-runner-message-end'"
    );
    expect(agentRunnerContent).toContain(
      'const errorText = toUserFacingErrorText(toErrorText(error));'
    );
  });

  it('uses pi DefaultResourceLoader with additionalSkillPaths and appendSystemPrompt', () => {
    expect(agentRunnerContent).toContain('additionalSkillPaths: skillPaths');
    expect(agentRunnerContent).toContain('appendSystemPrompt: [coworkAppendPrompt]');
    expect(agentRunnerContent).toContain('buildPlanModeRuntimePrompt');
    expect(agentRunnerContent).not.toContain('<plan_mode_capabilities>');
    expect(agentRunnerContent).not.toContain('systemPromptOverride');
  });

  it('recreates cached pi sessions when the runtime signature changes', () => {
    expect(agentRunnerContent).toContain('buildPiSessionRuntimeSignature,');
    expect(agentRunnerContent).toContain(
      'const sessionRuntimeSignature = buildPiSessionRuntimeSignature({'
    );
    expect(agentRunnerContent).toContain(
      'cachedSession.runtimeSignature !== sessionRuntimeSignature'
    );
    expect(agentRunnerContent).toContain('Runtime changed, recreating cached pi session:');
    expect(agentRunnerContent).toContain('runtimeSignature: sessionRuntimeSignature');
  });

  it('uses the per-turn runtime config snapshot instead of rereading model config mid-run', () => {
    expect(agentRunnerContent).toContain('runtimeConfigSnapshot?: ReturnType<typeof configStore.getAll>');
    expect(agentRunnerContent).toContain('const runtimeConfig =');
    expect(agentRunnerContent).toContain('runtimeConfigSnapshot ||');
    expect(agentRunnerContent).not.toContain("const configuredModel = configStore.get('model')");

    const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');
    const sessionManagerContent = readFileSync(sessionManagerPath, 'utf8');
    expect(sessionManagerContent).toContain(
      'await this.agentRunner.run(session, enhancedPrompt, messagesForContext, runtimeConfig)'
    );
  });

  it('does not clear the SDK session by changing runtime settings while a turn is active', () => {
    const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');
    const sessionManagerContent = readFileSync(sessionManagerPath, 'utf8');
    expect(sessionManagerContent).toContain('this.activeSessions.has(sessionId)');
    expect(sessionManagerContent).toContain(
      '[SessionManager] Ignoring runtime update while session is running'
    );

    const chatViewPath = path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx');
    const chatViewContent = readFileSync(chatViewPath, 'utf8');
    expect(chatViewContent).toContain('const isRuntimeSwitchDisabled = isSessionRunning || hasActiveTurn');
    expect(chatViewContent).toContain('disabled={isRuntimeSwitchDisabled}');
    expect(chatViewContent).toContain('disabled={isSavingThinking.current || isRuntimeSwitchDisabled}');
  });

  it('stopSession force-releases the active session slot so a stuck SDK run cannot block retries', () => {
    const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');
    const sessionManagerContent = readFileSync(sessionManagerPath, 'utf8');
    expect(sessionManagerContent).toContain('controller.abort();');
    expect(sessionManagerContent).toContain('this.activeSessions.delete(sessionId);');
  });

  it('uses the normalized route protocol so openrouter follows the openai-compatible path', () => {
    expect(agentRunnerContent).toContain('resolvePiRouteProtocol');
    expect(agentRunnerContent).toContain('const configProtocol = resolvePiRouteProtocol(');
    expect(agentRunnerContent).toContain('resolveSyntheticPiModelFallback');
  });

  it('nudges the model to proceed with reasonable assumptions', () => {
    expect(agentRunnerContent).toContain('buildOpenCoworkAppendPrompt');
  });

  it('teaches the model to use recall and read_full for truncated large context', () => {
    const promptContractPath = path.resolve(process.cwd(), 'src/main/claude/prompt-contract.ts');
    const promptContractContent = readFileSync(promptContractPath, 'utf8');
    expect(promptContractContent).toContain('tool-output://');
    expect(promptContractContent).toContain('recall_tool_output with start, startLine/endLine');
    expect(promptContractContent).toContain('use read_full with startLine/endLine/maxChars');
  });

  it('routes MCP image results through structured helpers instead of stringifying base64 into text', () => {
    expect(agentRunnerContent).toContain(
      "import {\n  limitToolExecutionResultForModelWithInfo,\n  normalizeMcpToolResultForModel,\n  normalizeToolExecutionResultForUi,\n} from './tool-result-utils'"
    );
    expect(agentRunnerContent).toContain('limitToolExecutionResultForModelWithInfo(result);');
    expect(agentRunnerContent).toContain('recall_tool_output');
    expect(agentRunnerContent).toContain(
      'const normalizedResult = normalizeMcpToolResultForModel(result);'
    );
    expect(agentRunnerContent).toContain(
      'const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);'
    );
    expect(agentRunnerContent).not.toContain('else textParts.push(JSON.stringify(part));');
    expect(agentRunnerContent).not.toContain(": JSON.stringify(event.result || '');");
  });

  it('registers a large-file aware read_full tool and richer recall pagination', () => {
    expect(agentRunnerContent).toContain("name: 'read_full'");
    expect(agentRunnerContent).toContain('buildReadFullTool(session.id, effectiveCwd)');
    expect(agentRunnerContent).toContain("tool.name === 'recall_tool_output' || tool.name === 'read_full'");
    expect(agentRunnerContent).toContain('startLine');
    expect(agentRunnerContent).toContain('endLine');
    expect(agentRunnerContent).toContain('Defaults to 20000, capped at 100000');
  });

  it('does not remap Windows absolute paths as workspace-relative read_full paths', () => {
    expect(agentRunnerContent).toContain(
      'const isWindowsAbsolutePath = /^[a-zA-Z]:[\\\\/]/.test(trimmed) || /^\\\\\\\\/.test(trimmed);'
    );
    expect(agentRunnerContent).toContain(
      'if (!isNativeAbsolutePath || /^\\/(?:workspace|mnt\\/workspace)(?:\\/|$)/.test(slashPath)) {'
    );
    expect(agentRunnerContent).toContain(
      'const candidate = isNativeAbsolutePath ? trimmed : path.resolve(root, trimmed);'
    );
  });

  it('does not reference removed AskUserQuestion or TodoWrite tools', () => {
    expect(agentRunnerContent).not.toContain('AskUserQuestion');
    expect(agentRunnerContent).not.toContain('TodoWrite');
    expect(agentRunnerContent).not.toContain('pendingQuestions');
  });

  it('chat-first behavioral rules are present', () => {
    expect(agentRunnerContent).toContain('buildOpenCoworkAppendPrompt');
    expect(agentRunnerContent).not.toContain('START DOING IT');
  });

  it('provides an explicit background command tool with readiness waiting', () => {
    expect(agentRunnerContent).toContain("name: 'execute_background_command'");
    expect(agentRunnerContent).toContain('waitForPort');
    expect(agentRunnerContent).toContain("name: 'list_background_tasks'");
    expect(agentRunnerContent).toContain("name: 'read_background_task_log'");
    expect(agentRunnerContent).toContain("name: 'stop_background_task'");
    expect(agentRunnerContent).toContain('filterTasksForScope');
    expect(agentRunnerContent).toContain('waitTimeoutMs');
    expect(agentRunnerContent).toContain('timed out waiting for port');
    expect(agentRunnerContent).toContain(
      'port ${typedParams.waitForPort} is accepting connections'
    );
  });

  it('teaches the model to manage Open Cowork background resources through tools', () => {
    const promptContractPath = path.resolve(process.cwd(), 'src/main/claude/prompt-contract.ts');
    const promptContractContent = readFileSync(promptContractPath, 'utf8');
    expect(promptContractContent).toContain('list_background_tasks');
    expect(promptContractContent).toContain('read_background_task_log');
    expect(promptContractContent).toContain('stop_background_task');
    expect(promptContractContent).toContain('Prefer these tools over manually finding or killing pids');
  });

  it('blocks background shell syntax in the normal bash tool', () => {
    expect(agentRunnerContent).toContain('hasBackgroundShellSyntax');
    expect(agentRunnerContent).toContain('wrapBashToolForBackgroundSyntax');
    expect(agentRunnerContent).toContain('Use execute_background_command instead');
  });

  it('does not abort a turn for SDK silence while a tool is still executing', () => {
    expect(agentRunnerContent).toContain('const activeToolExecutions = new Set<string>();');
    expect(agentRunnerContent).toContain('activeToolExecutions.add(toolCallId);');
    expect(agentRunnerContent).toContain('activeToolExecutions.delete(toolCallId);');
    expect(agentRunnerContent).toContain('SDK silence timeout deferred while tools are running');
  });

  it('auto-splits mixed background shell commands into background plus follow-up execution', () => {
    expect(agentRunnerContent).toContain('splitBackgroundCommand');
    expect(agentRunnerContent).toContain('findShellBackgroundOperator');
    expect(agentRunnerContent).toContain('backgroundTaskService.startTask');
    expect(agentRunnerContent).toContain('followupCommand');
  });
});
