// src/extension.ts
// VS Code extension entry point

import * as vscode from "vscode";
import { ChatPanel } from "./ui/ChatPanel";
import { handleInlineEdit, handleExplainCode, handleFixError } from "./ui/InlineEdit";
import { OllamaProvider } from "./providers/OllamaProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log("Ollama Pilot activated");

  // ─── Open Chat Panel ───────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaPilot.openChat", () => {
      ChatPanel.createOrShow(context.extensionUri);
    })
  );

  // ─── Inline Edit (selection) ───────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "ollamaPilot.inlineEdit",
      async (editor, edit) => {
        await handleInlineEdit(editor, edit);
      }
    )
  );

  // ─── Explain Code ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "ollamaPilot.explainCode",
      async (editor) => {
        await handleExplainCode(editor);
      }
    )
  );

  // ─── Fix Errors ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "ollamaPilot.fixError",
      async (editor) => {
        await handleFixError(editor);
      }
    )
  );

  // ─── Select Model ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("ollamaPilot.selectModel", async () => {
      const cfg = vscode.workspace.getConfiguration("ollamaPilot");
      const baseUrl = cfg.get<string>("ollamaUrl") ?? "http://localhost:11434";
      const provider = new OllamaProvider({ model: "", baseUrl });

      try {
        const models = await provider.listModels();
        if (models.length === 0) {
          vscode.window.showWarningMessage("No models found. Pull a model with: ollama pull qwen2.5-coder:7b");
          return;
        }

        const selected = await vscode.window.showQuickPick(models, {
          title: "Select Ollama Model",
          placeHolder: "Choose a model to use",
        });

        if (selected) {
          await cfg.update("model", selected, vscode.ConfigurationTarget.Global);
          vscode.window.setStatusBarMessage(`✓ Ollama Pilot: Model set to ${selected}`, 3000);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ollama connection failed: ${msg}`);
      }
    })
  );

  // ─── Status Bar ────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "ollamaPilot.openChat";
  context.subscriptions.push(statusBar);

  function updateStatusBar() {
    const model = vscode.workspace.getConfiguration("ollamaPilot").get<string>("model") ?? "?";
    statusBar.text = `$(robot) ${model.split(":")[0]}`;
    statusBar.tooltip = `Ollama Pilot — ${model}\nClick to open chat`;
    statusBar.show();
  }

  updateStatusBar();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ollamaPilot")) updateStatusBar();
    })
  );

  // ─── Welcome message on first activation ──────────────────────
  const isFirstRun = !context.globalState.get("ollamaPilot.welcomed");
  if (isFirstRun) {
    context.globalState.update("ollamaPilot.welcomed", true);
    vscode.window
      .showInformationMessage(
        "Ollama Pilot ready! Make sure Ollama is running locally.",
        "Open Chat",
        "Select Model"
      )
      .then((action) => {
        if (action === "Open Chat") vscode.commands.executeCommand("ollamaPilot.openChat");
        if (action === "Select Model") vscode.commands.executeCommand("ollamaPilot.selectModel");
      });
  }
}

export function deactivate() {}
