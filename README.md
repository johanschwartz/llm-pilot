# 🛸 Ollama Pilot

A token-efficient, agentic AI coding assistant for VS Code — powered entirely by your local [Ollama](https://ollama.ai) models. No cloud, no API keys, no subscriptions.

## Features

| Feature | Description |
|---|---|
| **Agent Mode** | Multi-step task execution with file read/write/search tools (ReAct loop) |
| **Chat Mode** | Conversational coding help with file context |
| **Inline Edit** | Select code → transform it with a natural language instruction |
| **Explain Code** | Concise explanation of selected code in the Output panel |
| **Fix Errors** | Auto-fix diagnostics errors in the current file |
| **Token Meter** | Live token usage shown per-response |

## Architecture

```
src/
├── extension.ts          # Entry point, command registration
├── providers/
│   └── OllamaProvider.ts # Streaming Ollama API client (no deps)
├── agents/
│   └── AgentHarness.ts   # ReAct agentic loop with history pruning
├── tools/
│   └── AgentTools.ts     # Tool definitions + XML parser + executor
├── utils/
│   └── ContextBuilder.ts # Smart context windowing (token efficiency)
└── ui/
    ├── ChatPanel.ts       # Webview chat panel
    └── InlineEdit.ts      # Inline edit / explain / fix commands
```

### Token Efficiency Strategies

1. **Context windowing** — sends only N lines around the cursor, not the full file
2. **Tool result compression** — long outputs are head+tail trimmed before re-injection
3. **History pruning** — keeps system prompt + first message + last 6 turns only
4. **Single-shot for inline** — no agentic loop overhead for simple edits
5. **No JSON schema overhead** — tools use compact XML-style tags instead of full JSON schema

## Quick Start

### 1. Install Ollama

```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

### 2. Pull a coding model

```bash
# Recommended — fast and capable
ollama pull qwen2.5-coder:7b

# More powerful (needs 16GB+ RAM)
ollama pull qwen2.5-coder:32b

# Smallest option
ollama pull deepseek-coder:1.3b
```

### 3. Install the extension

```bash
cd ollama-pilot
npm install
npm run compile

# Install via VS Code CLI
code --install-extension . --force
# Or press F5 in VS Code to launch Extension Development Host
```

## Usage

### Keyboard Shortcuts
- `Ctrl+Shift+O` — Open Chat panel
- `Ctrl+Shift+E` — Inline edit selected code

### Commands (Command Palette)
- `Ollama Pilot: Open Chat`
- `Ollama Pilot: Inline Edit Selection`
- `Ollama Pilot: Explain Code`
- `Ollama Pilot: Fix Diagnostic Error`
- `Ollama Pilot: Select Model`

### Agent Tools

In Agent mode, the model can autonomously:

| Tool | Description |
|---|---|
| `read_file` | Read a file (windowed, with start/lines params) |
| `write_file` | Create or overwrite a file |
| `apply_edit` | Replace exact text in a file |
| `list_dir` | List directory contents |
| `search_text` | Grep across workspace files |
| `get_diagnostics` | Get current errors/warnings |
| `run_terminal` | Send a command to the terminal (user-visible) |
| `done` | Signal task completion with a summary |

### Example Agent Prompts

```
Add unit tests for the function at my cursor
Refactor this file to use async/await throughout
Find all TODO comments in the project and create a summary
Fix all TypeScript errors in src/
Create a new Express route handler for /api/users
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `ollamaPilot.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `ollamaPilot.model` | `qwen2.5-coder:7b` | Active model |
| `ollamaPilot.contextLines` | `80` | Lines of code context to include |
| `ollamaPilot.maxTokens` | `2048` | Max tokens per response |
| `ollamaPilot.temperature` | `0.2` | Model temperature |
| `ollamaPilot.agentMaxIterations` | `10` | Max agent tool-use steps |

## Recommended Models (by use case)

| Model | Size | Best for |
|---|---|---|
| `qwen2.5-coder:7b` | 4.7GB | Everyday coding, fast responses |
| `qwen2.5-coder:32b` | 19GB | Complex refactoring, architecture |
| `deepseek-coder-v2:16b` | 9GB | Strong reasoning + coding |
| `codellama:13b` | 7.4GB | General coding, good instruction following |
| `phi3.5:mini` | 2.2GB | Minimal RAM, quick edits |

## Development

```bash
npm install
npm run watch   # TypeScript watch mode
# Then F5 in VS Code to launch Extension Development Host
```

## License

MIT
