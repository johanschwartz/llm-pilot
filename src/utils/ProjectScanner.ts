// src/utils/ProjectScanner.ts
import * as vscode from "vscode";
import * as path from "path";

const IGNORE = new Set(["node_modules", ".git", "out", "dist", ".vscode-test"]);
const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "cs", "cpp", "c", "html", "css", "json", "md", "yaml", "yml"]);
const MAX_TREE_FILES = 60;

export async function buildProjectSummary(workspaceRoot: string): Promise<string> {
  const lines: string[] = [];
  await collectTree(vscode.Uri.file(workspaceRoot), workspaceRoot, "", lines, { count: 0 });
  const openFiles = vscode.workspace.textDocuments
    .filter(d => !d.isUntitled && d.uri.scheme === "file")
    .map(d => path.relative(workspaceRoot, d.uri.fsPath).replace(/\\/g, "/"));

  const parts: string[] = [`## Project: ${path.basename(workspaceRoot)}`, lines.join("\n")];
  if (openFiles.length > 0) parts.push(`\n### Open files\n${openFiles.join("\n")}`);
  return parts.join("\n");
}

async function collectTree(
  uri: vscode.Uri,
  root: string,
  indent: string,
  out: string[],
  counter: { count: number }
): Promise<void> {
  if (counter.count >= MAX_TREE_FILES) return;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return;
  }
  entries.sort(([a, at], [b, bt]) => {
    if (at !== bt) return at === vscode.FileType.Directory ? -1 : 1;
    return a.localeCompare(b);
  });
  for (const [name, type] of entries) {
    if (IGNORE.has(name)) continue;
    if (type === vscode.FileType.Directory) {
      out.push(`${indent}${name}/`);
      await collectTree(vscode.Uri.joinPath(uri, name), root, indent + "  ", out, counter);
    } else {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (CODE_EXTS.has(ext)) {
        out.push(`${indent}${name}`);
        counter.count++;
        if (counter.count >= MAX_TREE_FILES) { out.push(`${indent}... (truncated)`); return; }
      }
    }
  }
}

/** Replace @filename mentions with file contents inline. */
export async function resolveAtMentions(text: string, workspaceRoot: string): Promise<string> {
  const pattern = /@([\w./\\-]+)/g;
  let result = text;
  const matches = [...text.matchAll(pattern)];
  for (const m of matches) {
    const filePath = path.isAbsolute(m[1]) ? m[1] : path.join(workspaceRoot, m[1]);
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const content = Buffer.from(bytes).toString("utf8");
      const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
      const ext = path.extname(rel).slice(1) || "text";
      result = result.replace(m[0], `\n### ${rel}\n\`\`\`${ext}\n${content}\n\`\`\``);
    } catch {
      // file not found — leave mention as-is
    }
  }
  return result;
}
