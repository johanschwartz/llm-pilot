// src/utils/ContextBuilder.ts
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

export class ContextBuilder {
  constructor(private maxContextLines = 80) {}

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
      selectionOrCursor = doc.getText(sel);
      const selStart = sel.start.line;
      const selEnd = sel.end.line;
      const pad = Math.floor((this.maxContextLines - (selEnd - selStart)) / 2);
      const start = Math.max(0, selStart - pad);
      const end = Math.min(totalLines - 1, selEnd + pad);
      lineRange = [start, end];
      content = this.extractLines(doc, start, end, selStart, selEnd);
    } else {
      const cursor = sel.active.line;
      const half = Math.floor(this.maxContextLines / 2);
      const start = Math.max(0, cursor - half);
      const end = Math.min(totalLines - 1, cursor + half);
      lineRange = [start, end];
      content = this.extractLines(doc, start, end, cursor, cursor);
    }

    return { filePath, language, content, selectionOrCursor, lineRange, totalLines };
  }

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
      if (i === highlightStart && highlightStart === highlightEnd) {
        lines.push(lineText + "  // ← cursor");
      } else {
        lines.push(lineText);
      }
    }
    return lines.join("\n");
  }
}
