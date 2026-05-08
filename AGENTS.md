# Open Cowork Agent Notes

## Project Shape

Open Cowork is an Electron + React desktop app. Main process code lives in `src/main`, preload bridge code in `src/preload`, and renderer UI in `src/renderer`.

Important main-process areas:

- `src/main/claude/` - agent runner, model/provider compatibility, thinking payload handling
- `src/main/background/` - background task service for long-running processes (dev servers, etc.)
- `src/main/ipc/` - focused IPC handler registration modules
- `src/main/session/` - session persistence, context tracking, history restoration
- `src/main/context/` - context budget and compaction logic
- `src/main/remote/` - Feishu/Slack remote control channels
- `src/main/sandbox/` - WSL2/Lima sandbox integration
- `src/main/skills/` - built-in/global/user skill resolution and loading
- `src/shared/` - shared logic used by main tools and sandbox agents

Renderer areas:

- `src/renderer/components/Sidebar.tsx` - project/conversation grouped sidebar
- `src/renderer/components/ContextPanel.tsx` - context usage display and compaction controls
- `src/renderer/utils/projects.ts` - derived project summaries from session cwd
- `src/renderer/utils/conversation-turns.ts` - assistant/user turn grouping

## Commands

Use PowerShell on Windows.

```powershell
npm run typecheck
npm test
npm run build:win
```

`npm run build:win` runs the full Windows release build and pre-build checks. It generates installer assets under `release/`.

## Release Notes

Release publishing for this repo is captured in the local Codex skill:

```text
C:\Users\user\.codex\skills\open-cowork-release\SKILL.md
```

Current GitHub repository and release target:

```text
https://github.com/SageFoundry/open-cowork
```

For `v3.3.1`, the release baseline was commit `2a282b1 release: v3.3.0 stable` because the local `v3.3.0` tag was unavailable.

## Known Pitfalls

- `BackgroundTaskService` uses async `execFile` for process-liveness checks and `readFile` for log tailing. All `isProcessAlive`, `reconcileTasks`, `terminateProcess`, and `forceKillProcess` are now async. Never call them synchronously — they will return `Promise<boolean>` / `Promise<void>`.
- `rg` can fail in this Windows environment with WindowsApps access denied. Use PowerShell `Get-ChildItem` and `Select-String` as fallback.
- `electron-builder` NSIS downloads can fail to rename extracted cache directories. If so, inspect `.build-cache\electron-builder\nsis` and copy numeric extraction directories to the expected `nsis-...` / `nsis-resources-...` cache directory names before rerunning `npm run build:win`.
- GitHub Release assets must match `latest.yml`. Local installer names contain spaces, but uploaded assets should use hyphenated names such as `Open-Cowork-3.3.1-win-x64.exe`.
- OpenAI-compatible/DeepSeek thinking mode requires preserving and replaying provider-specific thinking/reasoning fields across turns. See `src/main/claude/thinking-compat.ts` and its tests before changing this path.
- Custom model context windows are resolved through config plus model metadata. Check `src/main/claude/pi-model-resolution.ts`, `src/main/config/config-store.ts`, and context tests when touching this area.
- Model selection uses `ProviderProfile.models?: string[]` for user-added custom models. The UI merges preset models (from `API_PROVIDER_PRESETS` in `src/shared/api-model-presets.ts`) with `models[]` for display. When changing model-related logic, update both `useApiConfigState.ts` (hook) and `ChatView.tsx` (picker). Custom provider ("更多模型") has empty presets — only user-added models appear. Old `useCustomModel`/`customModel` fields are auto-migrated to `models[]` in `normalizeProfile`.
- `lingerai` (`灵儿AI`) is a first-class OpenAI-compatible provider with default base URL `https://xc.lifesecretary.com:8000/v1` and preset model `gpt-5.4`. Treat it like `openai` for protocol routing, diagnostics, and auth checks.
- `deepseek` (`DeepSeek`) is a first-class OpenAI-compatible provider with default base URL `https://api.deepseek.com` and preset models `deepseek-v4-flash`, `deepseek-v4-pro`. Treat it like `openai` for protocol routing, diagnostics, and auth checks.

## Windows Execution Infrastructure

The agent exposes two command execution tools on Windows:

- `bash` — routes to WSL sandbox (if enabled) or Git Bash. On Git Bash, commands are written into a temp `.sh` script (100% ASCII via base64-encoded command content) and executed with `bash --noprofile --norc <scriptPath>`, bypassing MSYS2's argument-level encoding mangling.
- `pwsh` — uses PowerShell 7 (pwsh) or Windows PowerShell 5.1. The `executeWindowsPowerShell` function in `src/main/tools/windows-powershell-executor.ts` injects `chcp 65001`, `$OutputEncoding`, and `[Console]::InputEncoding`/`[Console]::OutputEncoding` as `UTF-8` into every execution.

All Windows command execution paths (`windows-bash-executor.ts`, `windows-powershell-executor.ts`, `background-task-service.ts`, `tool-executor.ts`, `native-executor.ts`, `plugin-runtime-service.ts`, `gui-operate-server.ts`) inject `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` into process and script environments to prevent GBK/CP936 encoding errors.

**Runtime resolver** (`src/main/runtime/runtime-resolver.ts`):
- `resolvePythonFromPath()` skips WindowsApps alias entries on Windows and prefers real Python installations.
- Falls back to `py -3 -c "import sys; print(sys.executable)"` to locate Python when only WindowsApps aliases exist on PATH.
- Both `executeWindowsPowerShell` and `executeViaGitBash` prepend the resolved Python directory to PATH before execution.

**pwsh tool** is registered in `agent-runner.ts` only on Windows. It uses `executeWindowsPowerShell` under the hood. UI support includes `toolHelpers.tsx` icon/label, `context-compaction.ts` compactable tools list, and `store/index.ts` default permission rule.

## Editing Rules

- Keep path containment logic in `src/shared/path-containment.ts`; do not reintroduce duplicate copies under tools or sandbox agents.
- Keep IPC registration split under `src/main/ipc/`; avoid growing `src/main/index.ts` with new handler bodies.
- Keep skill path logic centralized in `src/main/skills/skill-paths.ts`.
- Do not commit generated build output from `dist*`, `.bundle-resources`, `.build-cache`, or `release`.
- Temporary files (research scripts, test data, scratch notes) must go under `tmp/`, never in the project root. The `tmp/` directory is gitignored.
