// src/utils/ContextBuilder.ts
// Smart context windowing — the core of token efficiency.
// Sends only what the model NEEDS, not the entire file.

import * as vscode from "vscode";
import * as path from "path";

export interface FileContext {
  filePath: string;
  language: string;
  content: string;
  selectionOrCursor: string | null;
  lineRange: [number, number];
  totalLines: number;
}

export interface ProjectContext {
  workspaceRoot: string;
  openFiles: string[];
  activeFile: FileContext | null;
  diagnostics: DiagnosticInfo[];
}

export interface DiagnosticInfo {
  file: string;
  line: number;
  severity: string;
  message: string;
}

export class ContextBuilder {
  private maxContextLines: number;

  constructor(maxContextLines = 80) {
    this.maxContextLines = maxContextLines;
  }

  /**
   * Build a minimal, token-efficient context for the current editor state.
   * Strategy:
   *   1. Selection → send selection + N lines around it
   *   2. No selection → send a window around the cursor
   *   3. Never send the full file unless it's small
   */
  buildFileContext(editor: vscode.TextEditor): FileContext {
    const doc = editor.document;
    const sel = editor.selection;
    const totalLines = doc.lineCount;
    const filePath = doc.fileName;
    const language = doc.languageId;

    let content: string;
    let selectionOrCursor: string | null = null;
    let lineRange: [number, number];

    if (!sel.isEmpty) {
      // Has a selection — send selection + surrounding context
      selectionOrCursor = doc.getText(sel);
      const selStart = sel.start.line;
      const selEnd = sel.end.line;
      const pad = Math.floor((this.maxContextLines - (selEnd - selStart)) / 2);
      const start = Math.max(0, selStart - pad);
      const end = Math.min(totalLines - 1, selEnd + pad);
      lineRange = [start, end];
      content = this.extractLines(doc, start, end, selStart, selEnd);
    } else {
      // No selection — window around cursor
      const cursor = sel.active.line;
      const half = Math.floor(this.maxContextLines / 2);
      const start = Math.max(0, cursor - half);
      const end = Math.min(totalLines - 1, cursor + half);
      lineRange = [start, end];
      content = this.extractLines(doc, start, end, cursor, cursor);
    }

    return { filePath, language, content, selectionOrCursor, lineRange, totalLines };
  }

  /**
   * Build workspace-level context: open files list + diagnostics.
   * Does NOT include file contents — those are fetched on demand.
   */
  buildProjectContext(): ProjectContext {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const openFiles = vscode.workspace.textDocuments
      .filter((d) => !d.isUntitled && d.uri.scheme === "file")
      .map((d) => path.relative(workspaceRoot, d.fileName))
      .slice(0, 20); // cap at 20 for token efficiency

    const diagnostics: DiagnosticInfo[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity <= vscode.DiagnosticSeverity.Warning) {
          diagnostics.push({
            file: path.relative(workspaceRoot, uri.fsPath),
            line: d.range.start.line + 1,
            severity: d.severity === 0 ? "error" : "warning",
            message: d.message,
          });
        }
      }
    }

    const activeEditor = vscode.window.activeTextEditor;
    const activeFile = activeEditor ? this.buildFileContext(activeEditor) : null;

    return { workspaceRoot, openFiles, activeFile, diagnostics: diagnostics.slice(0, 10) };
  }

  /**
   * Read a file from disk with a line limit (for tool use).
   */
  async readFileChunk(
    filePath: string,
    startLine = 0,
    maxLines?: number
  ): Promise<{ content: string; totalLines: number; truncated: boolean }> {
    const uri = vscode.Uri.file(filePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const allLines = Buffer.from(bytes).toString("utf8").split("\n");
    const total = allLines.length;
    const limit = maxLines ?? this.maxContextLines * 2;
    const slice = allLines.slice(startLine, startLine + limit);
    return {
      content: slice.join("\n"),
      totalLines: total,
      truncated: startLine + limit < total,
    };
  }

  /** Format context into a compact system prompt section */
  formatForPrompt(ctx: FileContext): string {
    const rel = vscode.workspace.asRelativePath(ctx.filePath);
    const truncNote =
      ctx.lineRange[0] > 0 || ctx.lineRange[1] < ctx.totalLines - 1
        ? ` [showing lines ${ctx.lineRange[0] + 1}–${ctx.lineRange[1] + 1} of ${ctx.totalLines}]`
        : "";
    return `\`\`\`${ctx.language} [${rel}${truncNote}]\n${ctx.content}\n\`\`\``;
  }

  private extractLines(
    doc: vscode.TextDocument,
    start: number,
    end: number,
    highlightStart: number,
    highlightEnd: number
  ): string {
    const lines: string[] = [];
    for (let i = start; i <= end; i++) {
      const lineText = doc.lineAt(i).text;
      // Mark cursor/selection region with a comment for the model
      if (i === highlightStart && highlightStart === highlightEnd) {
        lines.push(lineText + "  // ← cursor");
      } else {
        lines.push(lineText);
      }
    }
    return lines.join("\n");
  }
}
