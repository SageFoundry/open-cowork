# Changelog

All notable changes to the Open Cowork AI agent desktop app will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.10] - 2026-06-18

### 🚀 新功能

#### 模型设置重构（per-model 配置）
- contextWindow/maxTokens/imageInputMode 从 profile 级别改为**每个模型独立设置**
- 新增 `ModelSettingsList` 组件，每个模型可展开配置
- 新增 `model-capabilities.ts`，支持按模型名称自动推断能力（视觉/推理/工具等）并手动覆盖
- 新增 27 个 i18n key 支持模型设置界面中英文

#### 运行时安全加固
- agent-runner 启动时固定配置快照，会话运行中禁止切 model/configSet/thinkingLevel
- 新增 5min 独立工具超时追踪（`TOOL_EXECUTION_TIMEOUT`）
- `stopSession` 强制释放 active session slot，避免 stuck SDK 阻塞重试

### 🔧 改进
- Pi SDK 模型路由集成 `resolveImageInputOverride()` 透传用户图片输入设置
- 旧 profile 级配置自动迁移到新的 modelSettings 结构
- SettingsAPI 简化：原有 contextWindow/maxTokens 输入框移除，纳入 ModelSettingsList

### 🧪 测试
- 新增 config-store-context-window.test.ts（多模型独立设置）
- 新增 api-config-state.test.ts（旧字段自动迁移）
- 新增 pi-model-resolution.test.ts（resolveImageInputOverride）
- 新增 agent-runner-pi.test.ts（运行时快照/安全守卫/release session slot）

## [3.5.9] - 2026-06-06

### 🚀 新功能

#### 会话级配置隔离
- 每个会话独立保存 model、configSet、thinkingLevel，切换会话时配置自动跟随
- 新增 `session.updateRuntime` IPC 事件，运行时修改会话配置无需重建
- 数据库 sessions 表新增 `config_set_id`、`thinking_level` 字段

#### 诊断包重构
- 导出改为以当前会话为中心，不再收集所有会话
- 日志自动脱敏（API key、路径、token 替换）
- 新增 Pi 路由诊断（provider、protocol、model、thinkingLevel）
- 按钮文案改为"生成当前会话支持包"

### 🔧 改进
- sudo 检测改为逐字符引号解析，避免误匹配 commit message
- ChatView turn 结束时自动滚动到底部
- agent-runner 使用 `getForConfigSet()` 替代 `getAll()` 确保会话配置独立
- 移除旧的"全局 model 覆盖会话 model"逻辑

### 📦 发布构成
- Open Cowork v3.5.9 Windows 安装包

## [3.5.7] - 2026-05-28

### 🚀 重大更新

#### 语言运行时重构
- **每轮语言注入**：新增 `<language_runtime>` 块（`buildVisibleLanguageRuntimePrompt`），每轮对话前动态注入，与 `<language_policy>` 解耦
- **中英文双路径**：UI 语言切换后下一轮对话自动生效，无需重启会话
- **中文压缩摘要**：压缩 LLM 调用使用中文 system prompt（`COMPACTION_SUMMARY_SYSTEM_PROMPT_ZH`）
- **中文记忆抽取**：记忆评估 LLM 调用根据 UI 语言使用中文 prompt

#### Thinking Level 粒度化
- `enableThinking` boolean → **6 级 ThinkingLevel**：`off` / `minimal` / `low` / `medium` / `high` / `xhigh`
- 配置层自动迁移：旧 boolean 值映射为 `medium`
- ChatView：下拉选择器替代开关按钮
- 每级对应不同的 Pi SDK thinking 配置（`extended` / `medium` / `high`）

### 🖥️ 前端体验
- **每轮 Token 统计**：ChatView 显示每轮 input/output/cache tokens 用量
- **i18n 时间格式化**：新增 `i18n-format.ts`，`formatChatTurnTime` 支持中英文时间格式
- **会话状态 reconcile**：会话结束时从 DB 拉消息同步状态，清理 partials
- **分页优化**：MESSAGES_PAGE_SIZE 5 → 20

### 🧪 测试
- 新增 `i18n-format.test.ts`
- 新增 `use-ipc-session-status-reconcile.test.ts`
- 更新 `prompt-contract.test.ts`、`config-store-config-sets.test.ts`、`session-compaction-history.test.ts`、`memory-evaluation.test.ts`

## [3.5.6] - 2026-05-28

### 🚀 重大更新

#### Pi SDK 升级 & 包迁移
- **Pi Coding Agent SDK**：`@mariozechner/pi-ai@0.60` / `@mariozechner/pi-coding-agent@0.60` → **`@earendil-works/pi-ai@0.75.5` / `@earendil-works/pi-coding-agent@0.75.5`**
- **TypeBox 迁移**：`@sinclair/typebox` → `typebox@1.1.38`
- 新增 runtime 依赖 `typebox`
- Node.js 最低版本要求提升至 `>=22.19.0`

#### 新工具（AI Agent 可用）
- **`read_full` 工具**：带路径安全检查的大文件分页读取（支持 startLine/endLine/maxChars），压缩策略跳过（semantic_sensitive）
- **`list_background_tasks` 工具**：列出后台任务，支持 scope 过滤（`current_session` / `current_project` / `all`）和 `includeCompleted` 标志
- **`read_background_task_log` 工具**：按 taskId 读取后台任务日志尾部（默认 12000 字符）
- **`stop_background_task` 工具**：按 taskId 停止后台任务
- **AnySearch Extract 工具**：`anySearchExtractTool` 现正式注册到工具列表

#### 后端 & 基础设施
- **OpenRouter 模型规格缓存**：新增 `openrouter-model-specs-cache.ts`，应用启动时自动缓存，提供 IPC 查询和刷新接口
- **PiSettingsManager 集成**：使用 `PiSettingsManager.inMemory()` 管理压缩和重试配置
- **ResourceLoader 重构**：使用新的 SDK DefaultResourceLoader，指定 `piAgentDir = ~/.pi/agent`
- **Session 队列重启**：会话队列被中止时若有待处理项则自动重启处理
- **run-aborted 安全检查**：在模型解析、Session 创建/销毁、Prompt 前后等关键阶段增加 `throwIfRunAborted()` 兜底
- **数据库扩展**：`compaction_snapshots` 表新增 `compacted_message_count`、`preserved_tail_count`、`summary_preview`、`compacted_context_preview` 字段

#### 前端 & 用户体验
- **上下文面板增强**：ContextPanel 展开时自动加载压缩历史 + Token 预算信息
- **流式速率显示**：ChatView 新增 tokens/秒 速率、thinking/tool_call 流标签显示
- **分页优化**：`MESSAGES_PAGE_SIZE` 从 5 提升至 **20**
- **Prepend 滚动修复**：加载更早消息时使用 `requestAnimationFrame` 恢复滚动位置，`isRestoringPrependRef` 防止重复触发
- **配置自动填充**：切换模型时自动从 `resolveKnownModelSpecs` 填入 `contextWindow`
- **设置页面新增**：SettingsAPI 新增相关设置页面

### 🔧 改进

#### Agent 上下文 & 工具
- **工具输出 Recall 扩展**：
  - 最大字符上限从 20K → 100K，默认从 8K → 20K
  - 新增 `startLine`/`endLine` 行范围读取
  - 提示信息更智能：标注续读格式 (`recall_tool_output({"handle":"...","start":...,"maxChars":...})`)
  - 新增 `query` 参数提示
- **Partial Tool Arguments**：新增 `partialToolArgSnapshots` 映射，记录工具调用的实时参数
- **Tool 参数签名字段**：`read_full` 和 `recall_tool_output` 增加 `startLine`/`endLine` 字段
- **Shell 工具重构**：工具限制包装逻辑重构，分离 shell 工具和基础工具

#### Session 管理
- 会话队列中止时若栈不为空则自动重启处理
- 模型切换时 `contextWindow` 自动填充
- 配置变更监听 OpenRouter 规格缓存

#### SDK 适配
- 迁移所有导入路径：agent-runner、pi-model-resolution、claude-sdk-one-shot、config-store、anysearch-tool、agent-runner-message-end
- 事件名称更新：`auto_compaction_start` → `compaction_start`、`auto_compaction_end` → `compaction_end`
- `agent.replaceMessages()` → `agent.state.messages = ...`
- DeepSeek thinking 日志增强：payload 日志开关（`COWORK_LOG_SDK_MESSAGES_FULL`）

### 🧪 测试
- 新增 `tool-output-compression.test.ts`（read_full 敏感压缩测试）
- 新增 `tool-output-recall.test.ts`（line-range 召回测试）
- 新增 `tool-result-utils.test.ts`
- 新增 `session-compaction-history.test.ts`（压缩历史 + Token 预算测试）
- 新增 `chat-view-pagination.test.ts`（分页测试）
- 新增 `context-panel-recent-files.test.ts`（Token 预算调用断言）
- 新增 `use-ipc-session-list.test.ts`
- 新增 `agent-runner-pi.test.ts`（后台任务管理工具测试 + 原有扩展现有测试）
- 更新 `pi-model-resolution.test.ts`、`claude-sdk-one-shot.test.ts`

### 📝 文档
- `AGENTS.md`：增加 `tmp/` 子目录组织规范
- `prompt-contract.ts`：新增两条工具使用指令（recall_tool_output 续读 / read_full 替代细碎读取）

## [3.5.5] - 2026-05-25

### Added

- **Trace Step 中断状态**：新增 `interrupted` 状态类型，agent-runner 在超时或取消时同步中止 pi SDK session，并清理残留的 running trace step 标记为 `interrupted`

### Changed

- **Plan Mode 工具名同步**：更新 plan-mode-guard 的允许工具列表为当前记忆系统 API（`read_history`/`search_knowledge`/`read_knowledge`），禁用 `save_knowledge`/`delete_knowledge` 等写操作
- **提示词对齐**：prompt-contract 中的 `get_knowledge_evidence` 更新为 `read_knowledge with evidence`
- **Mode 事件过滤**：conversation-turns 工具新增 `isModeEventMessage()` 过滤函数，mode 切换事件不显示在对话中

### Fixed

- **Session 清理安全**：agent-runner 兜底清理所有 SDK 残留的 running step

## [3.5.4] - 2026-05-23

### Added

- **Tool Output Recall**：被压缩或截断的工具输出自动保存为 SQLite 快照，LLM 可通过 `recall_tool_output` 工具按 handle、关键词、字符范围回顾原始完整内容
- **`read_history` 工具**：通过 messageId 或 turnIndex 读取完整的会话历史窗口，与 `search_history` 配合实现定位→查阅

### Changed

- **上下文压缩系统全面重构**：
  - 熔断保护：自动压缩连续失败 3 次后暂停，防止反复重试
  - 嵌套保护：同一会话压缩中不会重复触发
  - 搜索命令跳过：rg/grep/Select-String 搜索结果不再被 Micro-Compact 压缩
  - 三明治截断：工具输出截断改为保留头 60% + [中略] + 尾 40%
  - 结构化摘要：Auto-Compact 改为固定 9 段 Markdown，压缩恢复后信息确定性更高
- **`search_history` 结构化查询升级**：支持 query/mode（smart/exact/all/any）/工具结果过滤/排除指定消息/按时间范围过滤；中英文停词表过滤，防自指
- **ContextPanel 布局重构**：顶部固定区合并展示模型/工作目录/上下文用量，底部统一滚动；压缩确认改为应用内模态弹窗
- **会话配置面板**：新增压缩统计和执行记录展示

### Fixed

- 修复 AnySearch MCP 端点路径
- 修复 `search_knowledge` 工具名不一致问题
- 修复压缩确认弹窗焦点丢失问题

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
