// src/ui/ChatPanel.ts
import * as vscode from "vscode";
import { AgentHarness, AgentEvent } from "../agents/AgentHarness";
import { ContextBuilder } from "../utils/ContextBuilder";
import { OllamaProvider, OllamaMessage } from "../providers/OllamaProvider";

export class ChatPanel {
  static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private abortController: AbortController | null = null;
  private contextBuilder: ContextBuilder;
  private chatHistory: OllamaMessage[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.contextBuilder = new ContextBuilder();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
    this.panel.webview.html = this.getHtml();
  }

  static createOrShow() {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "llmPilotChat",
      "LLM Pilot",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ChatPanel.currentPanel = new ChatPanel(panel);
  }

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration("llmPilot");
    return {
      model: cfg.get<string>("model") ?? "qwen3.6:35b",
      baseUrl: cfg.get<string>("ollamaUrl") ?? "http://localhost:11434",
      temperature: cfg.get<number>("temperature") ?? 0.2,
      maxTokens: cfg.get<number>("maxTokens") ?? 32768,
      maxIterations: cfg.get<number>("agentMaxIterations") ?? 10,
      contextLines: cfg.get<number>("contextLines") ?? 80,
    };
  }

  private async handleMessage(message: { command: string; text?: string; mode?: string }) {
    switch (message.command) {
      case "send":   await this.handleSend(message.text ?? "", message.mode ?? "agent"); break;
      case "cancel": this.abortController?.abort(); break;
      case "clear":  this.chatHistory = []; break;
      case "getModels": await this.sendModelList(); break;
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
      case "response":    this.post({ command: "chunk", text: event.content }); break;
      case "tool_call":   this.post({ command: "toolCall", toolName: event.toolName, text: event.content }); break;
      case "tool_result": this.post({ command: "toolResult", toolName: event.toolName, text: event.content, isError: event.isError }); break;
      case "token_usage": this.post({ command: "tokenUsage", text: event.content, promptTokens: event.promptTokens, completionTokens: event.completionTokens }); break;
      case "error":       this.post({ command: "error", text: event.content }); break;
      case "done":        this.post({ command: "done", text: event.content }); break;
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

  dispose() {
    ChatPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Pilot</title>
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
  #header { padding: 6px 10px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  #model-select { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 3px; padding: 2px 4px; font-size: 11px; cursor: pointer; flex: 1; min-width: 0; }
  #mode-toggle { display: flex; gap: 3px; flex-shrink: 0; }
  .mode-btn { background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 3px; padding: 2px 7px; font-size: 11px; cursor: pointer; opacity: 0.6; }
  .mode-btn.active { background: var(--btn-bg); color: var(--btn-fg); opacity: 1; border-color: var(--btn-bg); }
  #messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .msg { display: flex; flex-direction: column; gap: 3px; }
  .msg-header { font-size: 11px; font-weight: 600; opacity: 0.6; }
  .msg-body { line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user .msg-body { background: var(--tool-bg); border-left: 2px solid var(--accent); padding: 5px 8px; border-radius: 0 3px 3px 0; }
  .tool-block { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 3px; padding: 5px 8px; font-size: 11px; margin-top: 3px; }
  .tool-block .tool-name { font-weight: 600; font-size: 10px; margin-bottom: 3px; display: flex; align-items: center; gap: 3px; }
  .tool-block .tool-name.call { color: #569cd6; }
  .tool-block .tool-name.result { color: var(--success); }
  .tool-block .tool-name.error { color: var(--error); }
  .tool-output { font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; max-height: 120px; overflow-y: auto; opacity: 0.85; }
  code { font-family: var(--vscode-editor-font-family); background: var(--tool-bg); padding: 1px 3px; border-radius: 2px; }
  pre { background: var(--tool-bg); border: 1px solid var(--border); border-radius: 3px; padding: 8px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .thinking { display: flex; gap: 4px; align-items: center; padding: 4px 0; opacity: 0.5; }
  .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)} }
  #input-area { padding: 6px 10px; border-top: 1px solid var(--border); display: flex; gap: 5px; flex-shrink: 0; }
  #user-input { flex: 1; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 3px; padding: 5px 8px; font-family: var(--vscode-font-family); font-size: 13px; resize: none; min-height: 32px; max-height: 100px; outline: none; }
  #user-input:focus { border-color: var(--accent); }
  #send-btn { background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 3px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  #send-btn:disabled { opacity: 0.5; cursor: default; }
  #cancel-btn { background: transparent; color: var(--error); border: 1px solid var(--error); border-radius: 3px; padding: 5px 8px; cursor: pointer; font-size: 11px; display: none; }
  #cancel-btn.visible { display: block; }
  #status { font-size: 10px; color: var(--token-fg); padding: 0 10px 3px; text-align: right; flex-shrink: 0; }
</style>
</head>
<body>
<div id="header">
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
  <button id="cancel-btn">■</button>
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

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
  });
});
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isStreaming) sendMessage(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
});
sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;
  appendUserMessage(text);
  inputEl.value = ''; inputEl.style.height = 'auto';
  vscode.postMessage({ command: 'send', text, mode: currentMode });
}
function appendUserMessage(text) {
  const div = el('div','msg user');
  div.innerHTML = \`<div class="msg-header">You</div><div class="msg-body">\${esc(text)}</div>\`;
  messagesEl.appendChild(div); scrollBottom();
}
function startAssistantMessage() {
  const div = el('div','msg assistant');
  div.innerHTML = '<div class="msg-header">LLM Pilot</div>';
  const thinking = el('div','thinking');
  thinking.id = 'thinking-indicator';
  thinking.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  div.appendChild(thinking);
  currentMsgBody = el('div','msg-body');
  div.appendChild(currentMsgBody);
  currentAssistantMsg = div;
  messagesEl.appendChild(div); scrollBottom();
}
let rawContent = '';
function appendChunk(text) {
  document.getElementById('thinking-indicator')?.remove();
  rawContent += text;
  currentMsgBody.innerHTML = renderMarkdown(rawContent);
  scrollBottom();
}
function appendToolCall(toolName, text) {
  document.getElementById('thinking-indicator')?.remove();
  const b = el('div','tool-block');
  b.innerHTML = \`<div class="tool-name call">⚡ \${esc(toolName)}</div><div class="tool-output">\${esc(text)}</div>\`;
  currentAssistantMsg.appendChild(b); scrollBottom();
}
function appendToolResult(toolName, text, isError) {
  const b = el('div','tool-block');
  const cls = isError ? 'error' : 'result';
  b.innerHTML = \`<div class="tool-name \${cls}">\${isError?'✗':'✓'} \${esc(toolName)}</div><div class="tool-output">\${esc(text.slice(0,400))}\${text.length>400?'\\n...':''}</div>\`;
  currentAssistantMsg.appendChild(b); scrollBottom();
}
function renderMarkdown(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g,'<pre><code>$2</code></pre>')
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
}
function esc(t) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function el(tag,cls) { const e = document.createElement(tag); e.className=cls; return e; }
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

window.addEventListener('message', event => {
  const msg = event.data;
  switch(msg.command) {
    case 'startResponse':
      isStreaming=true; rawContent=''; sendBtn.disabled=true; cancelBtn.classList.add('visible');
      startAssistantMessage(); break;
    case 'chunk': appendChunk(msg.text); break;
    case 'toolCall': appendToolCall(msg.toolName, msg.text); break;
    case 'toolResult': appendToolResult(msg.toolName, msg.text, msg.isError); break;
    case 'tokenUsage': statusEl.textContent = msg.text; break;
    case 'error':
      if (currentAssistantMsg) {
        const err = el('div','tool-block');
        err.innerHTML = \`<div class="tool-name error">✗ Error</div><div class="tool-output">\${esc(msg.text)}</div>\`;
        currentAssistantMsg.appendChild(err); scrollBottom();
      } break;
    case 'done':
    case 'endResponse':
      isStreaming=false; sendBtn.disabled=false; cancelBtn.classList.remove('visible');
      document.getElementById('thinking-indicator')?.remove(); break;
    case 'modelList':
      modelSelect.innerHTML = '';
      if (msg.error) { modelSelect.innerHTML='<option>Ollama offline</option>'; statusEl.textContent=msg.error; }
      else msg.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value=m; opt.textContent=m; opt.selected=(m===msg.current);
        modelSelect.appendChild(opt);
      }); break;
  }
});
vscode.postMessage({ command: 'getModels' });
inputEl.focus();
</script>
</body>
</html>`;
  }
}
