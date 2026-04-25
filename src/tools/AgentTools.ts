// src/tools/AgentTools.ts
import * as vscode from "vscode";
import * as path from "path";
import { ToolDefinition } from "../providers/OllamaProvider";
import { ContextBuilder } from "../utils/ContextBuilder";

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export interface ToolResult {
  toolName: string;
  output: string;
  isError: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read lines from a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          start: { type: "number", description: "Start line, 0-indexed (default 0)" },
          lines: { type: "number", description: "Number of lines to read (default 80)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or overwrite a file with the given content. Use this to create new files or save generated code.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_edit",
      description: "Replace an exact string in a file. Prefer this over write_file for small changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          old: { type: "string", description: "Exact text to find and replace" },
          new: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path (default '.')" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Search for a text string across workspace files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" },
          include: { type: "string", description: "Glob pattern to filter files, e.g. **/*.ts" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diagnostics",
      description: "Get current compiler errors and warnings from VSCode.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal",
      description: "Send a command to the integrated terminal.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to run" },
        },
        required: ["cmd"],
      },
    },
  },
];

export class AgentToolExecutor {
  private contextBuilder: ContextBuilder;

  constructor(private workspaceRoot: string) {
    this.contextBuilder = new ContextBuilder(120);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      const output = await this.dispatch(call);
      return { toolName: call.name, output, isError: false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { toolName: call.name, output: `Error: ${msg}`, isError: true };
    }
  }

  private async dispatch(call: ToolCall): Promise<string> {
    switch (call.name) {
      case "read_file":      return this.readFile(call.args);
      case "write_file":     return this.writeFile(call.args);
      case "apply_edit":     return this.applyEdit(call.args);
      case "list_dir":       return this.listDir(call.args);
      case "search_text":    return this.searchText(call.args);
      case "get_diagnostics":return this.getDiagnostics();
      case "run_terminal":   return this.runTerminal(call.args);
      default: throw new Error(`Unknown tool: ${call.name}`);
    }
  }

  private async readFile(p: Record<string, string>): Promise<string> {
    const filePath = this.resolve(p["path"] ?? "");
    const start = parseInt(p["start"] ?? "0", 10);
    const lines = parseInt(p["lines"] ?? "80", 10);
    const result = await this.contextBuilder.readFileChunk(filePath, start, lines);
    const truncNote = result.truncated
      ? `\n[truncated — ${result.totalLines} total lines. Use start= to read more]`
      : "";
    return result.content + truncNote;
  }

  private async writeFile(p: Record<string, string>): Promise<string> {
    const filePath = this.resolve(p["path"] ?? "");
    const content = p["content"] ?? "";
    const uri = vscode.Uri.file(filePath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    // Open the saved file
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    return `Written ${content.split("\n").length} lines to ${p["path"]}`;
  }

  private async applyEdit(p: Record<string, string>): Promise<string> {
    const filePath = this.resolve(p["path"] ?? "");
    const oldText = p["old"] ?? "";
    const newText = p["new"] ?? "";
    const uri = vscode.Uri.file(filePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString("utf8");
    if (!content.includes(oldText)) {
      throw new Error("Could not find the exact text to replace. Check whitespace/indentation.");
    }
    const updated = content.replace(oldText, newText);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, "utf8"));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    return `Applied edit to ${p["path"]}`;
  }

  private async listDir(p: Record<string, string>): Promise<string> {
    const dirPath = this.resolve(p["path"] ?? ".");
    const uri = vscode.Uri.file(dirPath);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries
      .slice(0, 60)
      .map(([name, type]) => (type === vscode.FileType.Directory ? `📁 ${name}/` : `📄 ${name}`))
      .join("\n");
  }

  private async searchText(p: Record<string, string>): Promise<string> {
    const query = p["query"] ?? "";
    const include = p["include"] ?? "**/*";
    const results = await vscode.workspace.findFiles(include, "**/node_modules/**", 20);
    const hits: string[] = [];
    for (const uri of results) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          hits.push(`${path.relative(this.workspaceRoot, uri.fsPath)}:${i + 1}: ${lines[i].trim()}`);
          if (hits.length >= 20) break;
        }
      }
      if (hits.length >= 20) break;
    }
    return hits.length > 0 ? hits.join("\n") : "No matches found.";
  }

  private async runTerminal(p: Record<string, string>): Promise<string> {
    const terminal = vscode.window.createTerminal("LLM Pilot");
    terminal.show();
    terminal.sendText(p["cmd"] ?? "");
    return `Command sent to terminal: ${p["cmd"]}`;
  }

  private getDiagnostics(): string {
    const lines: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity <= vscode.DiagnosticSeverity.Warning) {
          const rel = path.relative(this.workspaceRoot, uri.fsPath);
          lines.push(`${d.severity === 0 ? "ERROR" : "WARN"} ${rel}:${d.range.start.line + 1} — ${d.message}`);
        }
      }
    }
    return lines.length > 0 ? lines.slice(0, 15).join("\n") : "No errors or warnings.";
  }

  private resolve(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(this.workspaceRoot, filePath);
  }
}
