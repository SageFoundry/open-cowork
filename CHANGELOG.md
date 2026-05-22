# Changelog

All notable changes to the Open Cowork AI agent desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.3] - 2026-05-22

### Added

- **`webextract` 工具**：基于 AnySearch MCP extract API 提取任意网页内容为 Markdown 文本
  - 支持 URL 参数，自动限制 50,000 字符输出
  - 复用 AnySearch 客户端认证、速率限制、错误处理
  - 在 Plan 模式下也可用

### Fixed

## [3.5.2] - 2026-05-20

### Added

- **内置 AnySearch 网页搜索**：集成 AnySearch API，提供联网搜索 + 网页内容提取能力
  - 支持 23 个垂直领域搜索、批量搜索、多语言/区域过滤
  - 搜索结果显示在 Settings → Tools 面板中，支持配置 API Key
  - 新增模块：`src/main/search/anysearch-client.ts`、`anysearch-tool.ts`
- **工具结果上下文限制**：当工具返回结果过大时自动截断，避免上下文预算被撑爆
  - 新增 `src/main/context/tool-result-utils.ts`，集中管理工具结果的占位控制

### Fixed

- **修复图标嵌入问题（Windows）**：`winCodeSign` 在 Windows 上因符号链接解压失败，导致打包时图标无法嵌入。改用 `after-pack` 钩子直接调用 `rcedit.exe` 嵌入 icon.ico 和版本资源
- **修复 skill 存储管理**：统一技能安装/删除/刷新逻辑，重写 `skills-manager.ts`，简化文件操作流程；UI 端 `SettingsSkills.tsx` 同步更新

### Changed

- 更新项目预览截图 `resources/preview.png`

### Release

- Source tag: `v3.5.2` commit [`03e97d1`](https://github.com/SageFoundry/open-cowork/commit/03e97d1)
- **注意**：本版 Windows 安装包由开发者手动上传至 GitHub Release（文件过大未纳入 CI），其他构件已自动上传

## [3.5.1] - 2026-05-15

### Changed

- 项目 Logo 全面更换为卡通奶牛形象：侧边栏、欢迎页、favicon、应用图标、系统托盘图标全部替换
- 新增 `scripts/generate-cow-logo.py`：从 `resources/cow.png` 一键生成全套图标资源（icon.png/ico/icns、logo、favicon、tray-icon）

### Fixed

- 修复 Windows 安装包图标显示为 Electron 默认图标的问题：手动构建多尺寸 ICO（16/24/32/48/64/128/256），确保 Windows 安装程序和任务栏正确显示奶牛图标

### Release

- Published Windows installer `Open-Cowork-3.5.1-win-x64.exe` with `.blockmap` and `latest.yml` for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.5.1

## [3.5.0] - 2026-05-15

### Added

- 计划模式底层行为重构：工具列表稳定 + 每轮动态注入模式提示 + 工具执行前动态拦截，切换模式不再重建 SDK session
- 计划模式下支持只读操作：文件读取、代码搜索、只读调研命令、测试/typecheck 运行、临时脚本写入 `tmp/plan-mode/<sessionId>/`
- `<plan_mode_capabilities>` 稳定系统提示，让模型长期了解计划模式能力边界
- `<current_mode>` 动态提示，每轮告知模型当前模式和 scratch 目录
- `plan-mode-guard` 单测覆盖只读/写操作拦截场景
- MCP tool metadata 保留 `readOnlyHint`，计划模式下放行可信只读 MCP 工具
- 计划模式零开销：切换计划/执行模式时不再重建 piSession，充分利用 SDK 缓存

### Changed

- 聊天输入区计划模式按钮改为 switch 样式：只显示图标、计划 和滑块状态，不再用"执行/开/关"等易混淆文字
- 计划模式拦截逻辑统一到工具执行前守护函数，而非切换时过滤工具列表

### Fixed

- 频繁切换计划/执行模式不再破坏 piSession 上下文缓存

### Release

- Published Windows installer `Open-Cowork-3.5.0-win-x64.exe` with `.blockmap` and `latest.yml` for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.5.0

## [3.4.0] - 2026-05-14

### Added

- 项目级长期记忆系统：记忆按 `project_path` 隔离，同一项目内跨 session 共享记忆
- 模型提炼引擎（`memory-evaluation.ts`）：手动"提炼记忆"和 agent 主动 `save_knowledge` 统一走真实模型评估，输出 `create/update/ignore` 决策，支持本地去重、合并、数量限制和字段校验
- 新增 agent 记忆读取工具：`query_knowledge`（按项目搜索）、`list_knowledge`（列出项目记忆）、`get_knowledge`（读取单条）、`delete_knowledge`（删除当前项目内指定记忆）
- Agent prompt 自动注入项目记忆：每轮根据用户 prompt 检索 FTS5/关键词，注入最多 6 条正文 + 20 条索引标题
- 明确的 memory 与 `search_history` 分工策略：memory 存长期压缩知识（架构决策、项目约定），`search_history` 查完整历史对话（临时过程、一次性 bug）
- FTS5 安全降级：FTS5 不可用时自动回退 keyword 搜索

### Changed

- `database.ts` 新增 `knowledge` 表 `project_path` 列和 FTS5 全文检索表；包含旧数据回填迁移逻辑
- `save_knowledge` 不再直接入库，先走记忆评估引擎
- 自主保存（autoMemory）比手动保存更严格的触发门槛，只保存长期稳定、高价值信息
- IPC memory handlers 全部改为按 `cwd/projectPath` 隔离
- ContextPanel 记忆面板按当前项目路径展示不同记忆
- `configStore` 补充 `autoMemory` 到 `DIRECT_READ_KEYS`
- 旧数据通过 `session_id -> sessions.cwd` 自动回填项目路径

### Release

- Published Windows installer `Open-Cowork-3.4.0-win-x64.exe` with `.blockmap` and `latest.yml` for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.4.0

## [3.3.9] - 2026-05-13

### Changed

- Context budget now uses CJK-aware token estimation: CJK characters weighted at 2.5 chars/token, non-CJK at 4 chars/token. All compaction thresholds tightened accordingly for better token-count accuracy on Chinese text.
- Cold-start budget parameters tightened: `CHARS_PER_TOKEN` 4→2, `COLD_START_BUDGET_RATIO` 0.3→0.15, `SMALL_CONTEXT` 0.15→0.08, `MAX_COLD_START_HISTORY_TURNS` 48→32, reducing wasted token budget on first agent invocation.

### Fixed

- Post-run SDK session cleanup: agent now explicitly calls `clearSdkSession` after each run, preventing SDK-internal history accumulation across runs that caused context overflow and erratic agent behavior.
- Model input guidance updated for recommended models across providers.

### Release

- Published Windows installer `Open-Cowork-3.3.9-win-x64.exe` with `.blockmap` and `latest.yml` for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.3.9

## [3.3.8] - 2026-05-12

### Added

- `lingyi-json` (零一万物JSON) and `lingyi-vl` (零一万物VL) configured as OpenAI-compatible providers with recommended models.

### Release

- Published Windows installer `Open-Cowork-3.3.8-win-x64.exe` with `.blockmap` and `latest.yml` for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.3.8

## [3.3.7] - 2026-05-12

### Added

- Thinking language is now controlled by the UI language setting (通用 → 语言), replacing the previous guess-based approach. Switching between 中文/English in settings causes agent thinking to output in the matching language deterministically.

## [3.3.6] - 2026-05-12

### Fixed

- Background task service (`BackgroundTaskService`) on Windows: `spawnDetached` now uses `pipe` mode (`stdio: ['ignore', 'pipe', 'pipe']`) instead of raw file descriptors, and logs are written via `child.stdout.on('data')` + `appendFileSync` instead of fd passthrough, fixing unreliable log capture.
- Background task service: `isProcessAlive` on Windows now uses `Get-CimInstance Win32_Process` via PowerShell instead of `tasklist`, providing more reliable process-liveness detection.
- Logger (`src/main/utils/logger.ts`): registered `process.stdout` / `process.stderr` `error` event handlers to detect EPIPE, preventing application crashes when stdout/stderr pipes are broken (e.g., parent process exits).
- Background task service: `reconcileTasks` now correctly uses `await isProcessAlive()` instead of synchronous fd-based checks, preventing false-positive "lost" status for healthy tasks.

## [3.3.4] - 2026-05-09

### Added

- Chat view now includes a quick thinking-mode toggle switch next to the model picker, with localized labels in English and Chinese.

### Fixed

- Saving API configuration from the renderer now preserves `configSets`, preventing user-created config sets from being collapsed during the main-process save flow.
- Encrypted config store recovery now detects legacy plain-JSON stores and re-saves them with the stable encryption key instead of backing them up as unreadable data, avoiding config-set loss on upgrade.

## [3.3.3] - 2026-05-08

### Added

- New built-in `lingerai` provider (`灵儿AI`) with OpenAI-compatible routing, default base URL `https://xc.lifesecretary.com:8000/v1`, and preset model `gpt-5.4`.
- New built-in `deepseek` provider (`DeepSeek`) with OpenAI-compatible routing, default base URL `https://api.deepseek.com`, and preset models `deepseek-v4-flash`, `deepseek-v4-pro`.
- Multi-model support per config set: `ProviderProfile` now has an optional `models: string[]` field for user-added custom models. The model picker in ChatView displays preset models merged with user-added models, enabling quick switching within a single config set.
- Model management UI in Settings: unified model dropdown (preset + custom) with an "add custom model" input and removable chips for user-added models.
- `removeModel` callback in `useApiConfigState` for deleting user-added custom models.
- New `pwsh` tool for PowerShell 7 / Windows PowerShell 5.1 execution on Windows, complementing the existing `bash` tool. Registered in `agent-runner.ts` on Windows only.
- `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1` injected across all Windows command execution paths (`windows-bash-executor.ts`, `windows-powershell-executor.ts`, `background-task-service.ts`, `tool-executor.ts`, `native-executor.ts`, `plugin-runtime-service.ts`, `gui-operate-server.ts`) to prevent GBK/CP936 encoding errors.

### Changed

- Removed the `useCustomModel` / `customModel` / toggle system — model selection is now a single unified dropdown. Old configs with `useCustomModel` + `customModel` are auto-migrated to `models[]` on load.
- Custom provider ("更多模型") now has an empty preset model list; only user-added models appear.
- `modelPresetForProfile` now returns the `custom` preset for all `custom:*` protocol keys instead of mapping to provider-specific presets.
- Provider tabs now include `灵儿AI`, treated as a first-class OpenAI-compatible provider instead of a custom protocol variant.
- ChatView model picker now correctly switches config sets when selecting a model from a non-active set (previously it incorrectly saved the model to the current set).
- Model picker dropdown now closes when clicking outside (previously required clicking the toggle button).
- Git Bash command execution on Windows now uses temp `.sh` scripts with base64-encoded command content, bypassing MSYS2 argument-level encoding mangling that broke Chinese characters and other non-ASCII input.
- `chcp 65001` UTF-8 code page injection centralized into `executeWindowsPowerShell()`; removed from individual callers in `tool-executor.ts`.
- `runtime-resolver.ts`: `resolvePythonFromPath()` now skips WindowsApps alias entries and falls back to `py -3` launcher to find real Python installations.

### Fixed

- Chinese characters in bash tool commands no longer cause "No such file or directory" errors on Windows Git Bash.
- Python stdout encoding now defaults to UTF-8 across all Windows execution paths, preventing `UnicodeEncodeError` from GBK/CP936 code pages.
- Windows release packaging now clears Electron build output directories before rebuilding, preventing stale `dist-electron/main` bundles from accumulating into oversized installers.

### Release

- Published Windows installer `Open-Cowork-3.3.3-win-x64.exe` with corrected asset naming, `.blockmap`, `latest.yml`, and legacy cleanup helpers for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.3.3

## [3.3.2] - 2026-04-30

### Added

- Background task management: AI agents can start long-running processes (dev servers, API servers, etc.) via `execute_background_command` tool with port readiness waiting, and users can monitor, view logs, and stop tasks from the Context Panel sidebar.
- Background task shell syntax interception: bash tool automatically detects background syntax (`&`, `nohup`, `disown`, `pm2`, `Start-Process`) and routes to the background task tool.
- Web-design-engineer and ddg-web-search skills added to skill ecosystem.
- Image attachments are now passed to pi-ai models via `PromptOptions.images` (images were previously stored in messages but never sent to the model).

### Changed

- `BackgroundTaskService` core operations (`isProcessAlive`, `reconcileTasks`, `terminateProcess`, `forceKillProcess`) are now fully async using `execFile` instead of synchronous `execFileSync`, preventing main-process blocking during task reconciliation.
- `SkillsAdapter.getSkillPaths()` now accepts optional `projectPath` to support per-project skill directories (`.skills/`, `skills/`).
- `DefaultResourceLoader` now uses `noSkills: true`; Open Cowork controls all skill path resolution.
- Thinking/reasoning content is always displayed in the UI — the `enableThinking` toggle now only controls whether thinking is requested from the API, not whether it is shown.

### Fixed

- Thinking toggle now works for DeepSeek and other OpenAI-compatible providers via `thinking: { type: 'disabled' }` in the API payload (previously only Anthropic protocol was handled).
- Image ContentBlock conversion (Open Cowork `source.data`/`source.media_type` → pi-ai `data`/`mimeType`) for passing images to models.
- Temporary files now enforced to go under `tmp/` directory; root-level junk files cleaned up.

## [3.3.1] - 2026-04-28

### Added

- Codex-style project -> conversation sidebar: sessions are grouped by working directory, project groups expand inline, and new conversations launched from a project inherit that project's cwd.
- Slack channel support for remote workflows, including Slack configuration UI and remote channel plumbing.
- Context budgeting and compaction infrastructure, including renderer context usage updates and tests.
- Windows environment doctor and runtime guidance, plus bundled `rg.exe` resolution for Windows hosts.
- Project memory/session runtime groundwork for more reliable project-scoped context.

### Changed

- Refactored main-process IPC registration into focused handler modules for config, MCP, skills, sandbox, logs, remote, and schedule flows.
- Consolidated duplicated path-containment logic into `src/shared/path-containment.ts`.
- Centralized built-in/global/user skill path resolution in `src/main/skills/skill-paths.ts`.
- Switched WSL/Lima sandbox agent builds to bundled outputs via `scripts/bundle-sandbox-agent.js`.
- Improved chat message density, composer ergonomics, assistant turn grouping, thinking block display, and tool block rendering.
- Updated release metadata and GitHub publishing target to `SageFoundry/open-cowork`.

### Fixed

- Stabilized OpenAI-compatible and DeepSeek thinking-mode payload replay across multi-turn conversations.
- Fixed model context-window configuration persistence and config switching edge cases.
- Improved session history restoration and assistant message aggregation by conversation turn.
- Hardened Windows runtime/tool resolution, including PowerShell and Bash executor handling.
- Removed noisy optional native dependency references from package metadata.

### Release

- Published Windows installer `Open-Cowork-3.3.1-win-x64.exe` with `.blockmap` and `latest.yml` for auto-update.
- GitHub Release: https://github.com/SageFoundry/open-cowork/releases/tag/v3.3.1

## [3.3.0] - 2026-04-18

First stable release of the 3.3.x series. Graduated from 9 beta releases with 30+ commits since beta.9.

### Added

- Pairing mode UI guidance and approval panel for Feishu remote control (#109)
- Official project website with VitePress (#122)
- Codex-powered PR review bot with GPT-5.3-codex (#94)
- Codex issue auto-response workflow (#95)
- Platform-based issue auto-assignment (#96)
- ROADMAP.md with versioned planning (v3.4.0+)
- SEO optimizations — llms.txt, social preview, FAQ
- Dependency management policy in CONTRIBUTING.md

### Fixed

- Feishu DM policy now correctly syncs to gateway auth mode (#107)
- Feishu WebSocket connection failures (#93, #105)
- Screenshot tool results display as images instead of bloating text context (#135, #124)
- GUI tool-result image deduplication via content hashing
- Gemini and other providers: empty probe response handling (#88)
- Model probe error causes now preserved in diagnostics (#121)
- MCP: prefer system npx on Windows (#120)
- Security: zip-slip and path traversal hardening (#139)
- Dark/light theme switching on website
- Outdated model fallbacks updated to current versions (claude-sonnet-4-6, gemini-3-flash-preview, gpt-5.4-mini)

### Changed

- OpenAI model presets updated: gpt-5.4-mini, gpt-5.4-nano, o4-mini (replaced retired gpt-4.1)
- CI: platform builds moved to release-only, smoke tests added
- Dependabot: grouped CI actions, separated production patch/minor, ignored Electron major

### Removed

- Unused credentials store module and Keychain integration (eliminated macOS Keychain popup on startup)

### Contributors

- [@hqhq1025](https://github.com/hqhq1025)
- [@Sun-sunshine06](https://github.com/Sun-sunshine06)
- [@JackXFan](https://github.com/JackXFan)
- [@andoan16](https://github.com/andoan16)

## [3.3.0-beta.8] - 2026-03-29

### Added

- Build verification and post-install reliability checks for Windows and macOS installers
- ~100 test files with coverage thresholds enforced in CI pipeline

### Fixed

- 8 critical + 10 high security findings from Round 3 security audit
- 20 medium-severity hardening fixes across sandbox and MCP modules
- VM sandbox security against command injection and symlink attacks (WSL2 & Lima)
- MCP server staging and lifecycle issues for external tool integration
- Skills ENOTDIR error when built-in skills (PPTX, DOCX, PDF, XLSX) symlink into .asar archive
- Remote gateway null check in `loadPairedUsers` for Feishu/Slack integration
- Scrypt `maxmem` parameter for startup key derivation performance
- CI pipeline stabilization for cross-platform builds

## [3.2.0] - 2026-03-02

### Added

- GUI automation support for Windows desktop applications (computer use with WeChat workflow)
- Drag-and-drop file and image attachments with bubble layout in chat interface

### Changed

- Updated Open Cowork app icons for Windows and macOS packaging (branding refresh)
- Widened chat content area layout for better readability

### Fixed

- Improved `key_press` robustness for GUI automation on Windows and macOS

## [3.1.0] - 2026-02-13

### Added

- Full V2 plugin runtime and management system for custom MCP connectors
- Demo videos showcasing file organization, PPTX generation, XLSX creation, and GUI operation

### Fixed

- Custom Anthropic API timeout handling for Claude model requests
- Agent runner `sdkPlugins` runtime ReferenceError in multi-model configurations
- Hardcoded Chinese text removed from config modal and titlebar (full English/Chinese localization)
- Sensitive log redaction hardened for API keys and credentials
- Packaged app version alignment to 3.0.0 for consistent update detection

## [3.0.0] - 2026-02-08

### Changed

- **Breaking**: Removed proxy layer — all AI model requests now go through Claude Agent SDK directly
- Architecture redesigned to SDK-first approach for better multi-model support (Claude, OpenAI, Gemini, DeepSeek)

### Fixed

- GUI dock click targeting and verification gating for macOS computer use

## [2.0.0] - 2026-01-25

### Changed

- Major architecture overhaul: Electron-based desktop app with React UI, sandbox isolation, and Skills system

## [1.0.0] - 2025-12-01

### Added

- Initial release of Open Cowork — open-source AI agent desktop app with one-click install for Windows and macOS

[Unreleased]: https://github.com/SageFoundry/open-cowork/compare/v3.5.0...HEAD
[3.5.0]: https://github.com/SageFoundry/open-cowork/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/SageFoundry/open-cowork/compare/v3.3.9...v3.4.0
[3.3.9]: https://github.com/SageFoundry/open-cowork/compare/v3.3.8...v3.3.9
[3.3.8]: https://github.com/SageFoundry/open-cowork/compare/v3.3.7...v3.3.8
[3.3.3]: https://github.com/SageFoundry/open-cowork/compare/v3.3.2...v3.3.3
[3.3.2]: https://github.com/SageFoundry/open-cowork/compare/v3.3.1...v3.3.2
[3.3.1]: https://github.com/SageFoundry/open-cowork/compare/2a282b1...v3.3.1
[3.3.0]: https://github.com/SageFoundry/open-cowork/commit/2a282b1
[3.3.0-beta.8]: https://github.com/SageFoundry/open-cowork/compare/v3.2.0...v3.3.0-beta.8
[3.2.0]: https://github.com/SageFoundry/open-cowork/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/SageFoundry/open-cowork/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/SageFoundry/open-cowork/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/SageFoundry/open-cowork/compare/v1.0...v2.0.0
[1.0.0]: https://github.com/SageFoundry/open-cowork/releases/tag/v1.0
