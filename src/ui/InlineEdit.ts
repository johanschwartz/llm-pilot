// src/ui/InlineEdit.ts
// Handles the inline edit command — applies AI edits directly to selection

import * as vscode from "vscode";
import { AgentHarness } from "../agents/AgentHarness";
import { ContextBuilder } from "../utils/ContextBuilder";

export async function handleInlineEdit(
  editor: vscode.TextEditor,
  edit: vscode.TextEditorEdit,
  instruction?: string
): Promise<void> {
  const sel = editor.selection;
  if (sel.isEmpty) {
    vscode.window.showWarningMessage("Select some code first.");
    return;
  }

  const prompt = instruction ?? await vscode.window.showInputBox({
    prompt: "What should I do with this code?",
    placeHolder: "e.g. Add error handling, refactor to async/await, add JSDoc comments...",
  });

  if (!prompt) return;

  const cfg = vscode.workspace.getConfiguration("llmPilot");
  const selectedCode = editor.document.getText(sel);
  const language = editor.document.languageId;

  const harness = new AgentHarness(
    {
      model: cfg.get<string>("model") ?? "qwen3.6:35b",
      baseUrl: cfg.get<string>("ollamaUrl") ?? "http://localhost:11434",
      temperature: cfg.get<number>("temperature") ?? 0.1,
      maxTokens: cfg.get<number>("maxTokens") ?? 32768,
      maxIterations: 1, // Single shot for inline edits
      contextLines: cfg.get<number>("contextLines") ?? 80,
    },
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  );

  const messages = [
    {
      role: "system" as const,
      content: `You are a code editor. Given code and an instruction, output ONLY the modified code with no explanation, no markdown fences, no preamble. Output exactly what should replace the selected code.`,
    },
    {
      role: "user" as const,
      content: `Language: ${language}\nInstruction: ${prompt}\n\nCode to modify:\n${selectedCode}`,
    },
  ];

  const abortController = new AbortController();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "LLM Pilot: Editing...", cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => abortController.abort());

      let result = "";
      for await (const event of harness.chat(messages, abortController.signal)) {
        if (event.type === "response") result += event.content;
      }

      // Clean up any accidental fencing
      result = result.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();

      if (result) {
        await editor.edit((editBuilder) => {
          editBuilder.replace(sel, result);
        });
        vscode.window.setStatusBarMessage(`✓ LLM Pilot: Edit applied (${harness.tokenUsage.total} tokens)`, 4000);
      }
    }
  );
}

export async function handleExplainCode(editor: vscode.TextEditor): Promise<void> {
  const sel = editor.selection;
  const code = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  const language = editor.document.languageId;

  const cfg = vscode.workspace.getConfiguration("llmPilot");
  const harness = new AgentHarness(
    {
      model: cfg.get<string>("model") ?? "qwen3.6:35b",
      baseUrl: cfg.get<string>("ollamaUrl") ?? "http://localhost:11434",
      temperature: 0.3,
      maxTokens: 1024,
      maxIterations: 1,
      contextLines: 80,
    },
    ""
  );

  const messages = [
    { role: "system" as const, content: "You are a concise code explainer. Explain what this code does in 3-5 sentences, then list any potential issues." },
    { role: "user" as const, content: `${language}:\n${code.slice(0, 2000)}` },
  ];

  const panel = vscode.window.createOutputChannel("LLM Pilot — Explanation");
  panel.show();
  panel.appendLine(`Explaining ${language} code...\n${"─".repeat(60)}\n`);

  const abort = new AbortController();
  for await (const event of harness.chat(messages, abort.signal)) {
    if (event.type === "response") panel.append(event.content);
    if (event.type === "done") panel.appendLine("\n" + "─".repeat(60));
  }
}

export async function handleFixError(editor: vscode.TextEditor): Promise<void> {
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
  const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);

  if (errors.length === 0) {
    vscode.window.showInformationMessage("No errors found in current file.");
    return;
  }

  const contextBuilder = new ContextBuilder(60);
  const fileCtx = contextBuilder.buildFileContext(editor);
  const errorSummary = errors.slice(0, 5).map(e => `Line ${e.range.start.line + 1}: ${e.message}`).join("\n");

  const cfg = vscode.workspace.getConfiguration("llmPilot");
  const harness = new AgentHarness(
    {
      model: cfg.get<string>("model") ?? "qwen3.6:35b",
      baseUrl: cfg.get<string>("ollamaUrl") ?? "http://localhost:11434",
      temperature: 0.1,
      maxTokens: 2048,
      maxIterations: 1,
      contextLines: 60,
    },
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  );

  const messages = [
    { role: "system" as const, content: "Fix the given errors. Output ONLY the corrected code, no explanation." },
    {
      role: "user" as const,
      content: `Errors:\n${errorSummary}\n\nCode:\n${fileCtx.content}`,
    },
  ];

  let result = "";
  const abort = new AbortController();
  for await (const event of harness.chat(messages, abort.signal)) {
    if (event.type === "response") result += event.content;
  }

  result = result.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();

  if (result) {
    const fullRange = new vscode.Range(0, 0, editor.document.lineCount - 1, editor.document.lineAt(editor.document.lineCount - 1).text.length);
    await editor.edit(editBuilder => editBuilder.replace(fullRange, result));
    vscode.window.setStatusBarMessage("✓ LLM Pilot: Errors fixed", 4000);
  }
}
