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

## Self-Optimization Workflow (编译版本 / Dev 版本)

Open Cowork has **two runtime modes**, and the agent (you) must understand which you're running in.

### How to tell which mode you're in

| Signal | Compiled (Release Build) | Dev (`npm run dev`) |
|--------|--------------------------|---------------------|
| Running process | `Open Cowork.exe` from `E:\opencowork\Open Cowork\` | Electron from the source tree |
| `app.asar` location | `E:\opencowork\Open Cowork\resources\app.asar` | No asar (rendered from source) |
| Source edits take effect? | ❌ No — needs rebuild | ✅ Yes — hot reload |
| `npm run build:win` produces | `release/` installer assets | N/A (dev mode) |
| Package version in `package.json` | Matches running version | Matches running version |

**To check**: Look at the running process path. If it's `E:\opencowork\Open Cowork\Open Cowork.exe`, you're in the **compiled release build**.

### The workflow

```
1. Agent runs inside COMPILED BUILD
   → Discovers bugs, identifies issues
   → Reads source code to understand root cause
   → Edits source files in E:\workspace\open-cowork\src\
   → Source edits do NOT affect the running app

2. User runs npm run dev (DEV VERSION)
   → Dev version uses the edited source directly
   → User verifies the fix works

3. User runs npm run build:win
   → Compiles the fixed source into a new release build
   → New build at E:\opencowork\Open Cowork\

4. User launches the NEW COMPILED BUILD
   → Agent now runs in the updated build
   → The fix is live and can be verified end-to-end
   → Cycle continues with next issue
```

### Important rules for agents

- **When running in the compiled build**: You CAN read and edit source files at `E:\workspace\open-cowork\src\`, but the running code comes from `app.asar`. Edits will only take effect after the user rebuilds.
- **When asking about the current version**: Check `E:\workspace\open-cowork\package.json` for `version`, and check the running process path to confirm compiled vs dev.
- **After making source fixes**: Remind the user that the fix is in the source but needs a rebuild to take effect in the compiled app.
- **When the user says "基于最新代码编译运行的版本"**: They mean the running compiled build already includes recent edits. Verify this when possible.
- **Don't confuse `npm run dev` with the compiled build**: Dev mode hot-reloads from source; compiled mode uses `app.asar`.
- **Git Bash encoding chain**: `executeViaGitBash` writes temp `.sh` scripts and passes command content via `base64 -d | bash` through stdin. The resolved Python directory must be converted to MSYS2 POSIX format (`/d/path` not `D:\path`) before injecting into the script's `export PATH`. See `winPathToMsys2()` in `src/main/tools/windows-bash-executor.ts`.

### Commands

Use PowerShell on Windows.

```powershell
npm run typecheck   # TypeScript check (always run after edits)
npm test            # Run unit tests
npm run dev         # Dev mode with hot reload
npm run build:win   # Full Windows release build + pre-build checks
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

- `BackgroundTaskService` is fully async. On Windows, `isProcessAlive` uses `powershell.exe -Command "Get-CimInstance Win32_Process -Filter 'ProcessId = <pid>'"` (not `tasklist`). `spawnDetached` uses `stdio: ['ignore', 'pipe', 'pipe']` — raw fd mode is unreliable on Windows. Logs are written via `child.stdout.on('data', ...) + appendFileSync`, not fd passthrough. `reconcileTasks` runs every 5s via `setInterval` and calls `await isProcessAlive()` — never use sync process checks.
- `waitForPort` in `BackgroundTaskService` is called synchronously (via `await`) from `buildBackgroundTaskTool`'s `execute` function. When a model passes `waitForPort`, the tool blocks the agent event loop for up to `waitTimeoutMs` (default 10s). This is by design — the tool waits for the server to become ready before returning results to the model. If the port never opens, the full timeout is consumed.
- `wrapBashToolForBackgroundSyntax` in `agent-runner.ts` intercepts bash commands containing `&`, `nohup`, `disown`, etc. and routes them to `BackgroundTaskService.startTask()`. The detection uses `findShellBackgroundOperator()` — a character-level scanner that handles quoting and escaping, not regex. The old regex-based approach with `\$` bugs has been replaced.
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
