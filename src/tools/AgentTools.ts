// src/tools/AgentTools.ts
// Tool definitions parsed from model output via XML-style tags.
// No JSON schema overhead — token-efficient text-based tool calling.

import * as vscode from "vscode";
import * as path from "path";
import { ContextBuilder } from "../utils/ContextBuilder";

export interface ToolCall {
  name: string;
  params: Record<string, string>;
}

export interface ToolResult {
  toolName: string;
  output: string;
  isError: boolean;
}

/**
 * Parse tool calls from model output.
 * Models emit: <tool:read_file path="src/foo.ts" start="10" lines="40"/>
 * or multi-line: <tool:write_file path="...">...content...</tool:write_file>
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Self-closing: <tool:name attr="val" .../>
  const selfClosing = /<tool:(\w+)([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = selfClosing.exec(text)) !== null) {
    calls.push({ name: m[1], params: parseAttrs(m[2]) });
  }

  // Block: <tool:name attr="val">content</tool:name>
  const block = /<tool:(\w+)([^>]*)>([\s\S]*?)<\/tool:\1>/g;
  while ((m = block.exec(text)) !== null) {
    const params = parseAttrs(m[2]);
    params["__body__"] = m[3].trim();
    calls.push({ name: m[1], params });
  }

  return calls;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

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
      case "read_file":
        return this.readFile(call.params);
      case "write_file":
        return this.writeFile(call.params);
      case "list_dir":
        return this.listDir(call.params);
      case "search_text":
        return this.searchText(call.params);
      case "apply_edit":
        return this.applyEdit(call.params);
      case "run_terminal":
        return this.runTerminal(call.params);
      case "get_diagnostics":
        return this.getDiagnostics();
      case "done":
        return call.params["summary"] ?? "Task complete.";
      default:
        throw new Error(`Unknown tool: ${call.name}`);
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
    const content = p["__body__"] ?? p["content"] ?? "";
    const uri = vscode.Uri.file(filePath);
    const bytes = Buffer.from(content, "utf8");
    await vscode.workspace.fs.writeFile(uri, bytes);
    return `Written ${content.split("\n").length} lines to ${p["path"]}`;
  }

  private async listDir(p: Record<string, string>): Promise<string> {
    const dirPath = this.resolve(p["path"] ?? ".");
    const uri = vscode.Uri.file(dirPath);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    // Token-efficient: show tree, cap at 60 entries
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
          const rel = path.relative(this.workspaceRoot, uri.fsPath);
          hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          if (hits.length >= 20) break;
        }
      }
      if (hits.length >= 20) break;
    }

    return hits.length > 0 ? hits.join("\n") : "No matches found.";
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

    // Open the file and show the change
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });

    return `Applied edit to ${p["path"]}`;
  }

  private async runTerminal(p: Record<string, string>): Promise<string> {
    const cmd = p["cmd"] ?? "";
    // Safety: surface to user, don't auto-run arbitrary commands
    const terminal = vscode.window.createTerminal("Ollama Pilot");
    terminal.show();
    terminal.sendText(cmd);
    return `Command sent to terminal: ${cmd}\n(Review output in the terminal panel)`;
  }

  private getDiagnostics(): string {
    const lines: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity <= vscode.DiagnosticSeverity.Warning) {
          const rel = path.relative(this.workspaceRoot, uri.fsPath);
          const sev = d.severity === 0 ? "ERROR" : "WARN";
          lines.push(`${sev} ${rel}:${d.range.start.line + 1} — ${d.message}`);
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

/** The system prompt section that teaches the model to use tools. Token-efficient. */
export const TOOL_SYSTEM_PROMPT = `You are an expert coding assistant with access to tools. Use tools when you need to read/write files or search code. 

TOOLS — emit exactly as shown:
<tool:read_file path="relative/path.ts" start="0" lines="80"/>
<tool:write_file path="relative/path.ts">
full file content here
</tool:write_file>
<tool:apply_edit path="relative/path.ts" old="exact text to find" new="replacement text"/>
<tool:list_dir path="src/"/>
<tool:search_text query="functionName" include="**/*.ts"/>
<tool:get_diagnostics/>
<tool:run_terminal cmd="npm test"/>
<tool:done summary="Brief description of what was done"/>

Rules:
- Use apply_edit for small changes, write_file for new files or rewrites
- Read files before editing if you need to see their content
- When finished, emit <tool:done summary="..."/>
- Think step by step before choosing a tool
- Be concise in explanations; be precise in code`;
