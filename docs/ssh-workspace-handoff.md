# SSH 工作区交接

本文记录截至 2026-07-13 的 SSH 工作区实现状态，供后续开发 Agent 接手。当前改动仍在未提交工作区内；先阅读本文件、检查 `git status`，不要覆盖现有改动。

## 当前目标与阶段

目标是在 Open Cowork 中提供受会话授权约束的 SSH 资源访问：用户管理服务器和资源目录，Agent 只能访问当前会话明确授权的资源；用户也可以打开独立的交互终端。

已完成：

- 服务器配置：名称、主机、端口、用户名、密码或私钥认证、默认远程目录、标签。
- 凭证只保存在主进程的 `ssh_servers.credential`，通过 Electron `safeStorage` 加密；Renderer 和 Agent 工具结果均不接触凭证。
- Host Key 首次测试要求用户确认 SHA-256 指纹；主机或端口变更会清除旧信任。
- 资源树：根节点 `ssh-root`（“全部服务器”）、目录和服务器节点；可创建目录并移动服务器节点。
- 会话资源授权：可授权根、目录或单服务器，权限为 `read` 或 `execute`；目录授权递归解析为有效服务器列表。
- Agent 内置 SSH provider：`ssh_list_servers`、`ssh_list_directory`、`ssh_read_file`、`ssh_list_terminals`、`ssh_open_terminal`、`ssh_close_terminal`、`ssh_exec`（持久可见终端）和 `ssh_exec_background`（独立后台执行）。
- 首次 Agent SSH 访问自动授权：当前会话没有任何有效服务器授权时，主进程通知 Renderer 弹出授权树；授权后恢复等待的调用，取消或停止会话则拒绝。
- 共享连接：同一服务器只保留一个 SSH TCP 连接；SFTP、后台 exec、用户终端和 Agent 可见终端使用各自 channel。
- 显式终端：服务器页可打开 xterm.js PTY，支持输入、输出、resize 和关闭。
- Agent 可为同一 Session + Server 管理多个独立的持久 PTY；`ssh_list_terminals` 返回实时窗口列表，`ssh_open_terminal` 创建窗口，`ssh_close_terminal` 关闭窗口，`ssh_exec` 可用 `terminalId` 指定目标。终端停靠在聊天主区域底部，可拖拽调整高度或折叠，用户可实时观察、直接输入接管或关闭标签。
- 会话授权可选择“可见终端”或“后台执行”。后台模式使用独立非交互 exec channel，不与可见终端共享 shell 状态。

尚未完成：

- 远程后台任务、批量任务、任务列表/重连/日志持久化。
- `ServersPage` 的显式用户终端仍只有一个 `terminalServer` 状态，打开另一台服务器会替换前一个终端组件；这不影响聊天区的 Agent 多终端标签。
- 目录管理的删除、重命名、拖拽排序和移动目录 UI。
- SSH 审计记录的 Renderer 查询与查看界面。
- 完整的资源树、授权 broker、SFTP、终端服务和 IPC 集成测试。

## 运行与验证

项目根目录：`E:\workspace\open-cowork`

```powershell
npm run typecheck
npm test
npm run dev
```

此前阶段已报告 `npm run typecheck`、相关 SSH 测试和 `git diff --check` 通过。此次交接仅重新确认了 `git diff --check` 无输出，未重新运行完整测试套件。源码修改只影响 Dev 版；正式编译版需在 Dev 联调后执行 `npm run build:win`。

建议的手工冒烟顺序：

1. 打开侧栏服务器页，创建目录并添加一台测试服务器。
2. 点击“测试”，确认 Host Key 指纹后再次测试。
3. 在会话右侧 “已授权服务器” 选择目录，分别验证只读和可执行授权。
4. 让 Agent 首次调用 SSH 工具，确认自动弹出授权框；取消后应返回授权错误，授权后原调用应继续。
5. 使用 `ssh_list_directory`、`ssh_read_file`、`ssh_exec`；确认活动面板实时输出和停止按钮。
6. 打开交互终端，连续输入命令、调整窗口尺寸、关闭，再验证 Agent exec 不受影响。

## 模块地图

| 路径 | 职责 |
| --- | --- |
| `src/main/ssh/ssh-service.ts` | SSH 领域服务：服务器 CRUD、Host Key、资源授权解析、SFTP、exec、审计、取消、连接入口。 |
| `src/main/ssh/ssh-connection-manager.ts` | 每台服务器一个共享 TCP `Client`；并发 `acquire` 复用同一次握手。 |
| `src/main/ssh/ssh-terminal-service.ts` | 用户 PTY 与 Session 级 Agent 持久 PTY 的创建、命令串行化、完成标记解析、输入、resize 和关闭。 |
| `src/main/ssh/ssh-authorization-broker.ts` | 按 Session 合并并等待首次授权请求，批准/拒绝时唤醒所有等待方。 |
| `src/main/mcp/providers/ssh-mcp-provider.ts` | 内置 MCP 风格工具定义；不得转移到外部 MCP transport。 |
| `src/main/ipc/ssh-handlers.ts` | 所有 Renderer SSH IPC handler；新增 handler 应继续放在此文件。 |
| `src/main/index.ts` | 创建服务、转发 `ssh.*` 事件、注册 IPC、退出时关闭 SSH 资源。 |
| `src/main/session/session-manager.ts` | 将 `SshService` 传给 Agent；停止 Session 时取消命令与等待授权。 |
| `src/main/claude/agent-runner.ts` | 为每次 Agent run 注册内置 SSH provider 工具；不再自行定义 SSH 工具。 |
| `src/preload/index.ts` | SSH IPC 白名单桥接和 `window.electronAPI.ssh` 类型。 |
| `src/renderer/components/servers/ServersPage.tsx` | 服务器页、编辑表单、Host Key 确认、资源树和当前单终端入口。 |
| `src/renderer/components/servers/SshResourceTree.tsx` | 资源树展示与选择。 |
| `src/renderer/components/servers/SshTerminalPane.tsx` | xterm.js Renderer 端。 |
| `src/renderer/components/ssh/SessionServersSection.tsx` | 会话右侧授权列表、手动授权和自动授权弹窗。 |
| `src/renderer/components/ssh/SshActivitySection.tsx` | 聊天区底部可调高度的 Agent 可见终端、直接接管输入，以及后台任务简要状态。 |
| `src/main/db/database.ts` | SSH 表、根节点迁移与索引。 |

## 数据模型与授权语义

SQLite 表：

- `ssh_servers`：服务器元数据、加密凭证、已确认 Host Key、默认目录、标签。
- `ssh_resource_nodes`：资源树。服务器节点 ID 固定为 `server:<serverId>`；根节点固定为 `ssh-root`。
- `session_ssh_resource_grants`：新资源树授权。
- `session_ssh_grants`：旧单服务器授权，仍需保留兼容，`listSessionGrants()` 会合并两种来源并取更高权限。
- `ssh_audit_events`：SFTP/exec 的审计写入，当前未在 UI 展示。

权限：

- `read` 允许 `ssh_list_servers`、目录读取和文件读取。
- `execute` 包含 read 权限并允许 `ssh_exec`。
- execute 授权额外记录 `execution_mode`：`foreground` 允许持久可见 PTY，`background` 允许独立后台 exec；两者不可互相绕过。
- 无授权时 provider 等待 `SshAuthorizationBroker`，而非向模型暴露所有服务器。
- 计划模式禁止 `ssh_exec`，但保留受授权的只读工具。
- 显式用户终端不经会话授权，但必须先确认 Host Key；这是用户主动服务器管理能力，和 Agent 资源访问是不同边界。

重要已知限制：`SshResourceGrant.includeFutureChildren` 已存库并经 IPC 暴露，但当前 `resolveGrantedServerIdsForGrant()` 仅根据调用时的资源树递归解析，未使用该字段。因此 UI 目前传入 `true` 的效果与普通递归授权相同；若要定义“未来子节点”语义，先补测试并明确撤销/移动节点时的语义。

## IPC 与事件契约

Renderer 通过 `window.electronAPI.ssh` 调用：服务器/资源树 CRUD、测试和信任 Host Key、会话授权、命令取消、终端 open/write/resize/close，以及 Agent 终端 list/open/close。新增 IPC 必须同时修改：

1. `src/main/ipc/ssh-handlers.ts`
2. `src/preload/index.ts` 的 bridge
3. 同文件底部的 `Window.electronAPI` 声明
4. `src/renderer/types/index.ts`（需要共享数据或事件时）

主进程推送的 `ServerEvent`：

- `ssh.execution`：Agent 后台 exec 生命周期与 stdout/stderr 流。
- `ssh.connection`：连接状态。
- `ssh.terminal`：PTY opened/data/closed/error。
- `ssh.authorization.request`：Session 的首次授权请求。

所有事件经 `sendToRenderer({ type, payload })` 发送；不要把 SSH 凭证、私钥或原始连接对象放入事件或普通日志。

## 生命周期与并发约束

- 一个 server 同时只能有一个 `ssh2.Client`；后台 exec、SFTP、用户终端和 Agent 可见终端必须各开独立 SSH channel。
- Agent 可见终端按 Session 管理，允许同一 Server 同时存在多个独立 PTY；每个 PTY 内部串行执行命令，结束标记只用于向工具返回退出码，不改变远程 shell 的 cwd 和环境状态。
- 用户关闭 Agent 终端标签或主进程关闭 channel 时，终端会从会话注册表移除；后续 `ssh_list_terminals` 将立即反映当前数量。
- 编辑端点、端口、用户名、认证方式或凭证时会断开旧连接；删除服务器、手动断开和应用退出也会清理。
- 停止 Agent Session 只取消该 Session 的 exec 和授权等待，不能关闭同服务器的用户终端或其他 Session 的操作。
- `SshAuthorizationBroker` 将同一 Session 的并发工具等待合并为一个授权框，批准/拒绝会处理全部等待 Promise。
- Host Key 是连接前置条件，不能在终端、SFTP 或 exec 路径中绕过。
- `ssh_exec_background` 当前最大输出为 256 KiB；两种执行模式默认超时 120 秒、最大 600 秒；SFTP 单次读取上限 256 KiB。

## 测试现状与下一步建议

已有：

- `src/tests/ssh-connection-manager.test.ts`：并发连接复用、主动断开后重连，以及握手期间断开的 client 清理。
- `src/tests/ssh-service.test.ts`：凭证切换、Host Key、资源权限校验、只读禁 exec、SFTP channel 关闭、文件读取截断、取消和超时。
- `src/tests/ssh-terminal-service.test.ts`：默认 PTY 复用、多 PTY 创建/列出/关闭、按 `terminalId` 定向执行，以及输出和退出码解析。
- 现有会话/Context Panel 测试也已随 UI 接入更新。

优先补充：

1. 用真实 SQLite 测试资源树：根/目录/单服务器授权、递归、移动、撤销、与旧 grant 合并及 execute 覆盖 read。
2. 测 `SshAuthorizationBroker`：同 Session 并发 request 仅 emit 一次，approve/deny/cancel 都解除所有 Promise。
3. 为 `SshMcpProvider` 测首次授权、计划模式、工具参数和未授权服务器拒绝。
4. 为 `SshTerminalService` 测 PTY 事件、resize 参数顺序、关闭和 `closeByServer`。
推荐开发顺序：先完成资源授权与终端的自动化测试，再设计远程后台任务。后台任务应复用 `SshConnectionManager`，但必须拥有独立的运行记录、取消语义、输出持久化和 UI；不要直接套用本地 `BackgroundTaskService` 的进程模型。
