// src/extension.ts
import * as vscode from "vscode";
import { ChatPanel } from "./ui/ChatPanel";
import { handleInlineEdit, handleExplainCode, handleFixError } from "./ui/InlineEdit";
import { OllamaProvider } from "./providers/OllamaProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log("LLM Pilot activated");

  context.subscriptions.push(
    vscode.commands.registerCommand("llmPilot.openChat", () => {
      ChatPanel.createOrShow();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "llmPilot.inlineEdit",
      async (editor, edit) => { await handleInlineEdit(editor, edit); }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "llmPilot.explainCode",
      async (editor) => { await handleExplainCode(editor); }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "llmPilot.fixError",
      async (editor) => { await handleFixError(editor); }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("llmPilot.selectModel", async () => {
      const cfg = vscode.workspace.getConfiguration("llmPilot");
      const baseUrl = cfg.get<string>("ollamaUrl") ?? "http://localhost:11434";
      const provider = new OllamaProvider({ model: "", baseUrl });
      try {
        const models = await provider.listModels();
        if (models.length === 0) {
          vscode.window.showWarningMessage("No models found. Run: ollama pull qwen3.6:35b");
          return;
        }
        const selected = await vscode.window.showQuickPick(models, { title: "Select Model" });
        if (selected) {
          await cfg.update("model", selected, vscode.ConfigurationTarget.Global);
          vscode.window.setStatusBarMessage(`✓ LLM Pilot: Model set to ${selected}`, 3000);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ollama connection failed: ${msg}`);
      }
    })
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "llmPilot.openChat";
  context.subscriptions.push(statusBar);

  function updateStatusBar() {
    const model = vscode.workspace.getConfiguration("llmPilot").get<string>("model") ?? "?";
    statusBar.text = `$(robot) ${model.split(":")[0]}`;
    statusBar.tooltip = `LLM Pilot — ${model}\nClick to open chat`;
    statusBar.show();
  }

  updateStatusBar();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("llmPilot")) updateStatusBar();
    })
  );
}

export function deactivate() {}
