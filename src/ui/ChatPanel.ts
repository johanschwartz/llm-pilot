// src/ui/ChatPanel.ts
// Webview panel for the chat interface

import * as vscode from "vscode";
import * as path from "path";
import { AgentHarness, AgentEvent } from "../agents/AgentHarness";
import { ContextBuilder } from "../utils/ContextBuilder";
import { OllamaProvider } from "../providers/OllamaProvider";
import { OllamaMessage } from "../providers/OllamaProvider";

export class ChatPanel {
  static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private abortController: AbortController | null = null;
  private contextBuilder: ContextBuilder;
  private chatHistory: OllamaMessage[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.contextBuilder = new ContextBuilder();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
    this.panel.webview.html = this.getHtml();
  }

  static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : undefined;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(column);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "ollamaPilotChat",
      "Ollama Pilot",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    return ChatPanel.currentPanel;
  }

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration("ollamaPilot");
    return {
      model: cfg.get<string>("model") ?? "qwen2.5-coder:7b",
      baseUrl: cfg.get<string>("ollamaUrl") ?? "http://localhost:11434",
      temperature: cfg.get<number>("temperature") ?? 0.2,
      maxTokens: cfg.get<number>("maxTokens") ?? 2048,
      maxIterations: cfg.get<number>("agentMaxIterations") ?? 10,
      contextLines: cfg.get<number>("contextLines") ?? 80,
    };
  }

  private async handleMessage(message: { command: string; text?: string; mode?: string }) {
    switch (message.command) {
      case "send":
        await this.handleSend(message.text ?? "", message.mode ?? "agent");
        break;
      case "cancel":
        this.abortController?.abort();
        break;
      case "clear":
        this.chatHistory = [];
        break;
      case "getModels":
        await this.sendModelList();
        break;
    }
  }

  private async handleSend(userText: string, mode: string) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const config = this.getConfig();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const editor = vscode.window.activeTextEditor;
    const fileContext = editor ? this.contextBuilder.buildFileContext(editor) : null;

    const harness = new AgentHarness(config, workspaceRoot);

    this.post({ command: "startResponse" });

    try {
      if (mode === "chat") {
        // Simple chat mode — no tools
        const systemMsg: OllamaMessage = {
          role: "system",
          content: "You are an expert coding assistant. Be concise and precise." +
            (fileContext ? `\n\nCurrent file: ${vscode.workspace.asRelativePath(fileContext.filePath)}\n` +
              this.contextBuilder.formatForPrompt(fileContext) : ""),
        };
        this.chatHistory.push({ role: "user", content: userText });
        const msgs: OllamaMessage[] = [systemMsg, ...this.chatHistory];

        let assistantContent = "";
        for await (const event of harness.chat(msgs, signal)) {
          this.handleEvent(event);
          if (event.type === "response") assistantContent += event.content;
        }
        this.chatHistory.push({ role: "assistant", content: assistantContent });
      } else {
        // Agent mode — full tool use
        for await (const event of harness.run(userText, fileContext, signal)) {
          this.handleEvent(event);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ command: "error", text: msg });
    } finally {
      this.post({ command: "endResponse" });
    }
  }

  private handleEvent(event: AgentEvent) {
    switch (event.type) {
      case "response":
        this.post({ command: "chunk", text: event.content });
        break;
      case "tool_call":
        this.post({ command: "toolCall", toolName: event.toolName, text: event.content });
        break;
      case "tool_result":
        this.post({ command: "toolResult", toolName: event.toolName, text: event.content, isError: event.isError });
        break;
      case "token_usage":
        this.post({ command: "tokenUsage", text: event.content, promptTokens: event.promptTokens, completionTokens: event.completionTokens });
        break;
      case "error":
        this.post({ command: "error", text: event.content });
        break;
      case "done":
        this.post({ command: "done", text: event.content });
        break;
    }
  }

  private async sendModelList() {
    const cfg = this.getConfig();
    try {
      const provider = new OllamaProvider({ model: cfg.model, baseUrl: cfg.baseUrl });
      const models = await provider.listModels();
      this.post({ command: "modelList", models, current: cfg.model });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ command: "modelList", models: [], error: msg });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private post(msg: Record<string, any>) {
    this.panel.webview.postMessage(msg);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ollama Pilot</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --tool-bg: var(--vscode-textBlockQuote-background);
    --accent: var(--vscode-focusBorder);
    --error: var(--vscode-errorForeground);
    --success: var(--vscode-testing-iconPassed);
    --token-fg: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  
  #header { padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  #header h1 { font-size: 13px; font-weight: 600; flex: 1; }
  #model-select { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 3px; padding: 2px 6px; font-size: 12px; cursor: pointer; }
  #mode-toggle { display: flex; gap: 4px; }
  .mode-btn { background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer; opacity: 0.6; }
  .mode-btn.active { background: var(--btn-bg); color: var(--btn-fg); opacity: 1; border-color: var(--btn-bg); }
  
  #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  
  .msg { display: flex; flex-direction: column; gap: 4px; }
  .msg-header { font-size: 11px; font-weight: 600; opacity: 0.7; }
  .msg-body { line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user .msg-body { background: var(--tool-bg); border-left: 2px solid var(--accent); padding: 6px 10px; border-radius: 0 4px 4px 0; }
  .msg.assistant .msg-body { }
  
  .tool-block { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-size: 12px; margin-top: 4px; }
  .tool-block .tool-name { font-weight: 600; font-size: 11px; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
  .tool-block .tool-name.call { color: #569cd6; }
  .tool-block .tool-name.result { color: var(--success); }
  .tool-block .tool-name.error { color: var(--error); }
  .tool-output { font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; max-height: 150px; overflow-y: auto; opacity: 0.85; }
  
  .token-badge { font-size: 10px; color: var(--token-fg); text-align: right; padding: 2px 0; }
  
  code { font-family: var(--vscode-editor-font-family); background: var(--tool-bg); padding: 1px 4px; border-radius: 2px; }
  pre { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 4px; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  
  .thinking { display: flex; gap: 4px; align-items: center; padding: 4px 0; opacity: 0.5; }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%,80%,100% { opacity: 0.2; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }
  
  #input-area { padding: 8px 12px; border-top: 1px solid var(--border); display: flex; gap: 6px; flex-shrink: 0; }
  #user-input { flex: 1; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-family: var(--vscode-font-family); font-size: 13px; resize: none; min-height: 36px; max-height: 120px; outline: none; }
  #user-input:focus { border-color: var(--accent); }
  #send-btn { background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 4px; padding: 6px 14px; cursor: pointer; font-size: 13px; white-space: nowrap; }
  #send-btn:hover { filter: brightness(1.1); }
  #send-btn:disabled { opacity: 0.5; cursor: default; }
  #cancel-btn { background: transparent; color: var(--error); border: 1px solid var(--error); border-radius: 4px; padding: 6px 10px; cursor: pointer; font-size: 12px; display: none; }
  #cancel-btn.visible { display: block; }
  
  #status { font-size: 11px; color: var(--token-fg); padding: 0 12px 4px; text-align: right; flex-shrink: 0; }
</style>
</head>
<body>
<div id="header">
  <h1>🛸 Ollama Pilot</h1>
  <select id="model-select"><option>Loading...</option></select>
  <div id="mode-toggle">
    <button class="mode-btn active" data-mode="agent">Agent</button>
    <button class="mode-btn" data-mode="chat">Chat</button>
  </div>
</div>
<div id="messages"></div>
<div id="status"></div>
<div id="input-area">
  <textarea id="user-input" placeholder="Ask anything... (Shift+Enter for newline)" rows="1"></textarea>
  <button id="cancel-btn">■ Stop</button>
  <button id="send-btn">Send</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const statusEl = document.getElementById('status');
const modelSelect = document.getElementById('model-select');

let currentMode = 'agent';
let currentAssistantMsg = null;
let currentMsgBody = null;
let isStreaming = false;
let totalTokens = 0;

// Mode toggle
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
  });
});

// Model select
modelSelect.addEventListener('change', () => {
  // Update config via command (would need extension support for live update)
  statusEl.textContent = 'Model change takes effect on next message.';
});

// Input handling
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming) sendMessage();
  }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  
  appendUserMessage(text);
  inputEl.value = '';
  inputEl.style.height = 'auto';
  
  vscode.postMessage({ command: 'send', text, mode: currentMode });
}

function appendUserMessage(text) {
  const div = createElement('div', 'msg user');
  div.innerHTML = \`<div class="msg-header">You</div><div class="msg-body">\${escHtml(text)}</div>\`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function startAssistantMessage() {
  const div = createElement('div', 'msg assistant');
  div.innerHTML = \`<div class="msg-header">Ollama Pilot</div>\`;
  
  const thinking = createElement('div', 'thinking');
  thinking.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  thinking.id = 'thinking-indicator';
  div.appendChild(thinking);
  
  currentMsgBody = createElement('div', 'msg-body');
  div.appendChild(currentMsgBody);
  
  currentAssistantMsg = div;
  messagesEl.appendChild(div);
  scrollToBottom();
}

let rawContent = '';

function appendChunk(text) {
  const thinkingEl = document.getElementById('thinking-indicator');
  if (thinkingEl) thinkingEl.remove();
  
  rawContent += text;
  currentMsgBody.innerHTML = renderMarkdown(rawContent);
  scrollToBottom();
}

function appendToolCall(toolName, text) {
  const thinkingEl = document.getElementById('thinking-indicator');
  if (thinkingEl) thinkingEl.remove();
  
  const block = createElement('div', 'tool-block');
  block.innerHTML = \`<div class="tool-name call">⚡ \${escHtml(toolName)}</div><div class="tool-output">\${escHtml(text)}</div>\`;
  currentAssistantMsg.appendChild(block);
  scrollToBottom();
}

function appendToolResult(toolName, text, isError) {
  const block = createElement('div', 'tool-block');
  const cls = isError ? 'error' : 'result';
  const icon = isError ? '✗' : '✓';
  block.innerHTML = \`<div class="tool-name \${cls}">\${icon} \${escHtml(toolName)}</div><div class="tool-output">\${escHtml(text.slice(0, 500))}\${text.length > 500 ? '\\n...' : ''}</div>\`;
  currentAssistantMsg.appendChild(block);
  scrollToBottom();
}

function renderMarkdown(text) {
  // Minimal markdown: code blocks, inline code, bold
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
}

function escHtml(text) {
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function createElement(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Message handling from extension
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.command) {
    case 'startResponse':
      isStreaming = true;
      rawContent = '';
      sendBtn.disabled = true;
      cancelBtn.classList.add('visible');
      startAssistantMessage();
      break;
    case 'chunk':
      appendChunk(msg.text);
      break;
    case 'toolCall':
      appendToolCall(msg.toolName, msg.text);
      break;
    case 'toolResult':
      appendToolResult(msg.toolName, msg.text, msg.isError);
      break;
    case 'tokenUsage':
      totalTokens = (msg.promptTokens || 0) + (msg.completionTokens || 0);
      statusEl.textContent = msg.text;
      break;
    case 'error':
      if (currentAssistantMsg) {
        const err = createElement('div', 'tool-block');
        err.innerHTML = \`<div class="tool-name error">✗ Error</div><div class="tool-output">\${escHtml(msg.text)}</div>\`;
        currentAssistantMsg.appendChild(err);
        scrollToBottom();
      }
      break;
    case 'done':
      isStreaming = false;
      sendBtn.disabled = false;
      cancelBtn.classList.remove('visible');
      const thinkingEl = document.getElementById('thinking-indicator');
      if (thinkingEl) thinkingEl.remove();
      break;
    case 'endResponse':
      isStreaming = false;
      sendBtn.disabled = false;
      cancelBtn.classList.remove('visible');
      break;
    case 'modelList':
      modelSelect.innerHTML = '';
      if (msg.error) {
        modelSelect.innerHTML = '<option>Ollama not found</option>';
        statusEl.textContent = msg.error;
      } else {
        msg.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          opt.selected = m === msg.current;
          modelSelect.appendChild(opt);
        });
      }
      break;
  }
});

// Load models on startup
vscode.postMessage({ command: 'getModels' });
inputEl.focus();
</script>
</body>
</html>`;
  }

  dispose() {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
