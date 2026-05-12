<p align="center">
  <img src="resources/logo.png" alt="Open Cowork Logo" width="200" />
</p>

<h1 align="center">Open Cowork</h1>

<p align="center">Open-source AI Agent desktop app for Windows & macOS</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/Node.js-22+-brightgreen" alt="Node.js" />
  <a href="https://discord.gg/pynjtQDf"><img src="https://img.shields.io/discord/1493588403260883078?logo=discord&label=Discord&color=5865F2" alt="Discord" /></a>
</p>

---

Open Cowork wraps Claude Code, OpenAI, Gemini, DeepSeek, and other AI models in a graphical desktop application. It provides VM-level sandbox isolation (WSL2 on Windows, Lima on macOS), a built-in Skills system (PPTX / DOCX / XLSX / PDF generation), MCP protocol integration, and remote control via Feishu / Slack.

> [!WARNING]
> Open Cowork is an AI collaboration tool. Please remain cautious about file modifications and deletions. The VM sandbox isolates most risks, but you should still review critical operations yourself.

---

## Preview

<p align="center">
  <img src="resources/preview.png" alt="Open Cowork Preview" width="100%" />
</p>

---

## Architecture

```
open-cowork/
├── src/
│   ├── main/                  # Electron main process (Node.js)
│   │   ├── background/        # Background task manager (dev servers, etc.)
│   │   ├── claude/            # Agent execution engine
│   │   ├── config/            # Configuration persistence
│   │   ├── db/                # SQLite data layer
│   │   ├── ipc/               # IPC handlers
│   │   ├── mcp/               # MCP protocol integration
│   │   ├── remote/            # Feishu / Slack remote control
│   │   ├── sandbox/           # Sandbox isolation (WSL2 / Lima)
│   │   ├── session/           # Session & context management
│   │   └── skills/            # Skill loading & management
│   ├── preload/               # Electron context bridge
│   └── renderer/              # Frontend UI (React + Tailwind)
│       ├── components/        # UI components
│       ├── hooks/             # React Hooks
│       └── store/             # Zustand state management
└── .claude/skills/            # Built-in skills (pptx / docx / pdf / xlsx)
```

**Tech Stack**: Electron · React 18 · TypeScript · Vite · Tailwind CSS · Zustand · better-sqlite3

**Sandbox Isolation**:

| Level | Platform | Implementation |
|-------|----------|----------------|
| Basic | All platforms | Path guard, operations restricted to workspace |
| Enhanced | Windows | WSL2, commands executed in isolated Linux VM |
| Enhanced | macOS | Lima, commands executed in isolated Linux VM |

---

## Installation

**macOS (Recommended)**

```bash
brew tap SageFoundry/tap
brew install --cask --no-quarantine open-cowork
```

**Windows / macOS Installer**: Download the appropriate package from [Releases](https://github.com/SageFoundry/open-cowork/releases).

**Run from Source**

```bash
git clone https://github.com/SageFoundry/open-cowork.git
cd open-cowork
npm install
npm run rebuild
npm run dev
```

Package: `npm run build`

---

## Quick Start

### 1. Get an API Key

| Provider | Base URL | Recommended Model |
|----------|----------|-------------------|
| [Anthropic](https://console.anthropic.com/) | Default | `claude-sonnet-4-5` |
| [OpenRouter](https://openrouter.ai/) | `https://openrouter.ai/api` | `claude-sonnet-4-5` |
| [Zhipu GLM](https://bigmodel.cn/glm-coding) | `https://open.bigmodel.cn/api/anthropic` | `glm-4.7` |
| [MiniMax](https://platform.minimaxi.com/subscribe/coding-plan) | `https://api.minimaxi.com/anthropic` | `minimax-m2` |
| [Kimi](https://www.kimi.com/membership/pricing) | `https://api.kimi.com/coding/` | `kimi-k2` |

### 2. Configure the App

Open the app → ⚙️ Settings (bottom-left) → Enter your API Key, Base URL, and Model name.

### 3. Pick a Workspace and Go

Choose a folder as your workspace, then type instructions in the chat.

---

## License

MIT © Open Cowork Team
