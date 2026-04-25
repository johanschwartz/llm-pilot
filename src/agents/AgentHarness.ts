// src/agents/AgentHarness.ts
import { OllamaProvider, OllamaMessage } from "../providers/OllamaProvider";
import { TOOL_DEFINITIONS, AgentToolExecutor, ToolCall, ToolResult, ApprovalCallback } from "../tools/AgentTools";
import { ContextBuilder, FileContext } from "../utils/ContextBuilder";
import { buildProjectSummary, resolveAtMentions } from "../utils/ProjectScanner";

export interface AgentConfig {
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  contextLines: number;
}

export interface AgentEvent {
  type: "tool_call" | "tool_result" | "response" | "done" | "error" | "token_usage" | "save_prompt";
  content: string;
  toolName?: string;
  isError?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  codeBlocks?: CodeBlock[];
}

export interface CodeBlock {
  lang: string;
  code: string;
}

const AGENT_SYSTEM_PROMPT = `You are a coding assistant. You have tools to read and write files.

Rules:
- NEVER output code in your message text. ALWAYS call write_file to save code instead.
- If asked to build or create something, call write_file immediately with the complete file content.
- Do not describe what you will do — just do it by calling the tool.
- After saving, give a one-sentence summary.`;

export class AgentHarness {
  private provider: OllamaProvider;
  private executor: AgentToolExecutor;
  private contextBuilder: ContextBuilder;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  constructor(private config: AgentConfig, private workspaceRoot: string, private requestApproval?: ApprovalCallback) {
    this.provider = new OllamaProvider({
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    this.executor = new AgentToolExecutor(workspaceRoot, requestApproval);
    this.contextBuilder = new ContextBuilder(config.contextLines);
  }

  async *run(
    userMessage: string,
    fileContext: FileContext | null,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    const projectSummary = await buildProjectSummary(this.workspaceRoot).catch(() => "");
    const resolvedMessage = await resolveAtMentions(userMessage, this.workspaceRoot);

    let systemContent = AGENT_SYSTEM_PROMPT;
    if (projectSummary) systemContent += `\n\n${projectSummary}`;
    if (fileContext) {
      systemContent += "\n\n## Current File\n" + this.contextBuilder.formatForPrompt(fileContext);
      if (fileContext.selectionOrCursor)
        systemContent += `\n\n## Selected Code\n\`\`\`\n${fileContext.selectionOrCursor}\n\`\`\``;
    }

    const history: OllamaMessage[] = [
      { role: "system", content: systemContent },
      { role: "user", content: `/no_think\n${resolvedMessage}` },
    ];

    let iterations = 0;
    let lastToolSig = "";

    while (iterations < this.config.maxIterations) {
      if (signal.aborted) { yield { type: "done", content: "Cancelled." }; return; }
      iterations++;

      const response = await this.provider.complete(history, TOOL_DEFINITIONS, signal);

      this.totalPromptTokens += response.promptTokens;
      this.totalCompletionTokens += response.completionTokens;

      yield {
        type: "token_usage",
        content: `prompt: ${response.promptTokens} + completion: ${response.completionTokens} | total: ${this.totalPromptTokens + this.totalCompletionTokens}`,
        promptTokens: this.totalPromptTokens,
        completionTokens: this.totalCompletionTokens,
      };

      // Strip <think>...</think> blocks from visible content
      const visibleContent = response.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

      if (response.toolCalls.length === 0) {
        // No tool calls — check if response contains unsaved code blocks
        if (visibleContent) yield { type: "response", content: visibleContent };

        const codeBlocks = extractCodeBlocks(visibleContent);
        if (codeBlocks.length > 0) {
          yield { type: "save_prompt", content: "Modellen genererade kod men sparade ingen fil.", codeBlocks };
        }

        yield { type: "done", content: visibleContent };
        return;
      }

      if (visibleContent) yield { type: "response", content: visibleContent };

      // Add assistant message with tool_calls to history
      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Execute each tool
      const calls: ToolCall[] = response.toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments }));

      // Break if same tool+args called twice in a row (stuck in loop)
      const sig = JSON.stringify(calls);
      if (sig === lastToolSig) {
        yield { type: "done", content: "Task complete." };
        return;
      }
      lastToolSig = sig;

      for (const call of calls) {
        yield { type: "tool_call", content: `${call.name}(${JSON.stringify(call.args)})`, toolName: call.name };

        const result: ToolResult = await this.executor.execute(call);
        yield { type: "tool_result", content: result.output, toolName: call.name, isError: result.isError };

        history.push({ role: "tool", content: result.isError ? `Error: ${result.output}` : result.output });
      }

      this.pruneHistory(history);
    }

    yield { type: "error", content: `Reached max iterations (${this.config.maxIterations}).` };
  }

  async *chat(messages: OllamaMessage[], signal: AbortSignal): AsyncGenerator<AgentEvent> {
    for await (const chunk of this.provider.streamChat(messages, signal)) {
      if (signal.aborted) break;
      if (chunk.content) yield { type: "response", content: chunk.content };
      if (chunk.done) {
        this.totalPromptTokens += chunk.promptTokens ?? 0;
        this.totalCompletionTokens += chunk.completionTokens ?? 0;
        yield {
          type: "token_usage",
          content: `prompt: ${chunk.promptTokens ?? 0} + completion: ${chunk.completionTokens ?? 0}`,
          promptTokens: this.totalPromptTokens,
          completionTokens: this.totalCompletionTokens,
        };
        yield { type: "done", content: "" };
      }
    }
  }

  private pruneHistory(history: OllamaMessage[], keepLast = 8): void {
    if (history.length <= keepLast + 2) return;
    const system = history[0];
    const firstUser = history[1];
    const recent = history.slice(-keepLast);
    history.length = 0;
    history.push(system, firstUser, ...recent);
  }

  get tokenUsage() {
    return {
      prompt: this.totalPromptTokens,
      completion: this.totalCompletionTokens,
      total: this.totalPromptTokens + this.totalCompletionTokens,
    };
  }
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2].trim()) blocks.push({ lang: m[1] || "text", code: m[2] });
  }
  return blocks;
}
