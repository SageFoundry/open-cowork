# Open Cowork Agent Notes

## Project Shape

Open Cowork is an Electron + React desktop app.

- Main process: `src/main`
- Preload bridge: `src/preload`
- Renderer UI: `src/renderer`
- Shared logic: `src/shared`

High-value areas:

- `src/main/claude/` - agent runner, provider/model routing, thinking/reasoning compatibility
- `src/main/context/` - context budget and compaction
- `src/main/session/` - session persistence, context restoration, history search
- `src/main/background/` - long-running background task service
- `src/main/tools/` - Windows shell execution paths
- `src/main/skills/` - built-in/global/user skill resolution
- `src/main/ipc/` - focused IPC handler modules
- `src/main/sandbox/` - WSL2/Lima sandbox integration

Support diagnostics:

- `docs/support-diagnostics.md` - how to inspect `opencowork-support-bundle-*.zip` files from users, verify privacy boundaries, and triage model/config/pi-agent routing issues.

## Runtime Modes

Open Cowork has two runtime modes:

- Compiled release build: `E:\opencowork\Open Cowork\Open Cowork.exe`
- Dev mode: `npm run dev` from this source tree

Source edits under `E:\workspace\open-cowork\src\` affect dev mode immediately, but compiled release mode keeps running code from `app.asar` until the user rebuilds with `npm run build:win` and relaunches the compiled app.

When checking the current version, read `package.json` and confirm the running process path if it matters.

Auto-update dev testing:

- Dev mode uses `dev-app-update.yml` plus `autoUpdater.forceDevUpdateConfig = true`, so `npm run dev` can exercise update-check UI without a full Windows build.
- For deterministic UI testing without GitHub/network dependency, set `OPEN_COWORK_MOCK_UPDATE=available|downloaded|not-available|error` before `npm run dev`. Optionally set `OPEN_COWORK_MOCK_UPDATE_VERSION=3.5.9` and `OPEN_COWORK_MOCK_UPDATE_DOWNLOAD_URL=...`.
- The update flow uses the GitHub Releases API for version detection and opens the selected release asset URL in the browser for download. It does not rely on `electron-updater` download/install behavior in this simplified flow.

## Commands

Use PowerShell on Windows.

```powershell
npm run typecheck
npm test
npm run dev
npm run build:win
```

`npm run build:win` performs the full Windows release build and writes installer assets under `release/`. Do not commit generated output from `dist*`, `.bundle-resources`, `.build-cache`, or `release`.

## Editing Rules

- Keep path containment logic centralized in `src/shared/path-containment.ts`.
- Keep IPC registration split under `src/main/ipc/`; do not grow `src/main/index.ts` with new handler bodies.
- Keep skill path logic centralized in `src/main/skills/skill-paths.ts`.
- Put scratch scripts, research notes, and temporary test data under `tmp/`; the project root is not for scratch files.
- **Within `tmp/`, organize files into purpose-named subdirectories** (`session-analysis/`, `db-query/`, `tests/`, `build-release/`, `pi-docs/`, `deadcode/`, `anysearch/`, `context-research/`, `asar-scan/`, `icon-research/`, `misc/` etc.). **Do not dump loose files at the `tmp/` root** — each file must belong to a category subdirectory. Large binary files (≥ 1 MB) like DB copies, zip archives, or cloned research directories should be flagged for cleanup after use.
- Use `rg` first for search. If `rg` hits WindowsApps access-denied issues, fall back to PowerShell `Get-ChildItem` and `Select-String`.

## Windows Execution Notes

The agent exposes two Windows command tools:

- `bash` routes to WSL sandbox when enabled, otherwise Git Bash.
- `pwsh` uses PowerShell 7 or Windows PowerShell 5.1 through `executeWindowsPowerShell`.

All Windows command execution paths inject `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`.

Important implementation details:

- `executeViaGitBash` writes temp `.sh` scripts and passes command content via `base64 -d | bash`.
- Git Bash PATH entries for Windows paths must be converted to MSYS2 POSIX form (`/d/path`, not `D:\path`); see `winPathToMsys2()` in `src/main/tools/windows-bash-executor.ts`.
- `resolvePythonFromPath()` skips WindowsApps aliases and may fall back to `py -3`.

## Known Pitfalls

- `BackgroundTaskService` is async. On Windows, `isProcessAlive` uses `Get-CimInstance Win32_Process`; do not replace it with sync `tasklist` checks.
- `spawnDetached` uses `stdio: ['ignore', 'pipe', 'pipe']`; raw fd passthrough is unreliable on Windows.
- `waitForPort` intentionally blocks the background-task tool until the requested port is ready or the timeout expires.
- `wrapBashToolForBackgroundSyntax` detects `&`, `nohup`, `disown`, and similar syntax with `findShellBackgroundOperator()` and routes to `BackgroundTaskService`.
- `electron-builder` NSIS cache rename failures may require inspecting `.build-cache\electron-builder\nsis` before rerunning the build.
- OpenAI-compatible/DeepSeek thinking mode must preserve provider-specific thinking/reasoning fields across turns; check `src/main/claude/thinking-compat.ts` and tests before touching it.
- Custom model context windows flow through `src/main/claude/pi-model-resolution.ts`, `src/main/config/config-store.ts`, and context tests.
- Model selection combines provider presets from `src/shared/api-model-presets.ts` with user-added `ProviderProfile.models`.
- `lingerai` and `deepseek` are first-class OpenAI-compatible providers; treat them like `openai` for routing, diagnostics, and auth checks.
- When a user shares an `opencowork-support-bundle-*.zip`, follow `docs/support-diagnostics.md` before drawing conclusions from logs or diagnostics.
