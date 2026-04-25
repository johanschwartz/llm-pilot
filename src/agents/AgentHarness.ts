// src/agents/AgentHarness.ts
import { OllamaProvider, OllamaMessage } from "../providers/OllamaProvider";
import { TOOL_DEFINITIONS, AgentToolExecutor, ToolCall, ToolResult } from "../tools/AgentTools";
import { ContextBuilder, FileContext } from "../utils/ContextBuilder";
import * as vscode from "vscode";

export interface AgentConfig {
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  contextLines: number;
}

export interface AgentEvent {
  type: "thinking" | "tool_call" | "tool_result" | "response" | "done" | "error" | "token_usage";
  content: string;
  toolName?: string;
  isError?: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

const AGENT_SYSTEM_PROMPT = `You are an expert coding assistant with file system tools.
When asked to create or modify files, use the provided tools — do not just output code.
Always use write_file to save new files. Use apply_edit for targeted changes to existing files.
Read files before editing when you need to see their contents.
When your task is complete, give a brief summary of what you did.`;

export class AgentHarness {
  private provider: OllamaProvider;
  private executor: AgentToolExecutor;
  private contextBuilder: ContextBuilder;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  constructor(private config: AgentConfig, workspaceRoot: string) {
    this.provider = new OllamaProvider({
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    this.executor = new AgentToolExecutor(workspaceRoot);
    this.contextBuilder = new ContextBuilder(config.contextLines);
  }

  async *run(
    userMessage: string,
    fileContext: FileContext | null,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    const systemContent = fileContext
      ? AGENT_SYSTEM_PROMPT + "\n\n## Current File\n" + this.contextBuilder.formatForPrompt(fileContext) +
        (fileContext.selectionOrCursor ? `\n\n## Selected Code\n\`\`\`\n${fileContext.selectionOrCursor}\n\`\`\`` : "")
      : AGENT_SYSTEM_PROMPT;

    const history: OllamaMessage[] = [
      { role: "system", content: systemContent },
      { role: "user", content: userMessage },
    ];

    let iterations = 0;

    while (iterations < this.config.maxIterations) {
      if (signal.aborted) { yield { type: "done", content: "Cancelled." }; return; }
      iterations++;

      yield { type: "thinking", content: "" };

      let fullContent = "";
      let toolCalls: ToolCall[] = [];
      let chunkPromptTokens = 0;
      let chunkCompletionTokens = 0;

      for await (const chunk of this.provider.streamChat(history, TOOL_DEFINITIONS, signal)) {
        if (signal.aborted) break;

        if (chunk.toolCalls && chunk.toolCalls.length > 0) {
          toolCalls = chunk.toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments }));
        } else {
          fullContent += chunk.content;
          if (chunk.content) yield { type: "response", content: chunk.content };
        }

        if (chunk.done) {
          chunkPromptTokens = chunk.promptTokens ?? 0;
          chunkCompletionTokens = chunk.completionTokens ?? 0;
        }
      }

      this.totalPromptTokens += chunkPromptTokens;
      this.totalCompletionTokens += chunkCompletionTokens;

      if (chunkPromptTokens > 0) {
        yield {
          type: "token_usage",
          content: `prompt: ${chunkPromptTokens} + completion: ${chunkCompletionTokens} | total: ${this.totalPromptTokens + this.totalCompletionTokens}`,
          promptTokens: this.totalPromptTokens,
          completionTokens: this.totalCompletionTokens,
        };
      }

      if (toolCalls.length === 0) {
        // No tool calls — final answer
        yield { type: "done", content: fullContent };
        return;
      }

      // Add assistant message with tool_calls to history
      history.push({
        role: "assistant",
        content: fullContent,
        tool_calls: toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args } })),
      });

      // Execute each tool and feed results back
      for (const call of toolCalls) {
        yield { type: "tool_call", content: `${call.name}(${JSON.stringify(call.args)})`, toolName: call.name };

        const result: ToolResult = await this.executor.execute(call);

        yield { type: "tool_result", content: result.output, toolName: call.name, isError: result.isError };

        history.push({
          role: "tool",
          content: result.isError ? `Error: ${result.output}` : result.output,
        });
      }

      this.pruneHistory(history);
    }

    yield { type: "error", content: `Reached max iterations (${this.config.maxIterations}).` };
  }

  async *chat(messages: OllamaMessage[], signal: AbortSignal): AsyncGenerator<AgentEvent> {
    for await (const chunk of this.provider.streamChat(messages, undefined, signal)) {
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
