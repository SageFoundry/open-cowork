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

## Editing Rules

- Keep path containment logic in `src/shared/path-containment.ts`; do not reintroduce duplicate copies under tools or sandbox agents.
- Keep IPC registration split under `src/main/ipc/`; avoid growing `src/main/index.ts` with new handler bodies.
- Keep skill path logic centralized in `src/main/skills/skill-paths.ts`.
- Do not commit generated build output from `dist*`, `.bundle-resources`, `.build-cache`, or `release`.
- Temporary files (research scripts, test data, scratch notes) must go under `tmp/`, never in the project root. The `tmp/` directory is gitignored.
