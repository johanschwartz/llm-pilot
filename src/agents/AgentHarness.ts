// src/agents/AgentHarness.ts
// ReAct-style (Reason + Act) agentic loop.
// Token-efficient: compresses tool results, caps history, prunes context.

import { OllamaProvider, OllamaMessage } from "../providers/OllamaProvider";
import { parseToolCalls, AgentToolExecutor, TOOL_SYSTEM_PROMPT, ToolResult } from "../tools/AgentTools";
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

  /**
   * Run an agentic task. Yields events for streaming UI updates.
   * This is the main ReAct loop.
   */
  async *run(
    userMessage: string,
    fileContext: FileContext | null,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    // Build system prompt — minimal, purposeful
    const systemPrompt = this.buildSystemPrompt(fileContext);

    // Conversation history — we'll prune this to stay token-efficient
    const history: OllamaMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    let iterations = 0;

    while (iterations < this.config.maxIterations) {
      if (signal.aborted) {
        yield { type: "done", content: "Cancelled." };
        return;
      }

      iterations++;

      // Stream the model's response
      let fullResponse = "";
      yield { type: "thinking", content: "" };

      let chunkPromptTokens = 0;
      let chunkCompletionTokens = 0;

      for await (const chunk of this.provider.streamChat(history, signal)) {
        if (signal.aborted) break;
        fullResponse += chunk.content;
        yield { type: "response", content: chunk.content };
        if (chunk.done) {
          chunkPromptTokens = chunk.promptTokens ?? 0;
          chunkCompletionTokens = chunk.completionTokens ?? 0;
        }
      }

      this.totalPromptTokens += chunkPromptTokens;
      this.totalCompletionTokens += chunkCompletionTokens;

      yield {
        type: "token_usage",
        content: `Tokens — prompt: ${chunkPromptTokens}, completion: ${chunkCompletionTokens} | Session total: ${this.totalPromptTokens + this.totalCompletionTokens}`,
        promptTokens: this.totalPromptTokens,
        completionTokens: this.totalCompletionTokens,
      };

      // Parse tool calls from response
      const toolCalls = parseToolCalls(fullResponse);

      if (toolCalls.length === 0) {
        // No tools — this is the final answer
        yield { type: "done", content: fullResponse };
        return;
      }

      // Add assistant turn to history
      history.push({ role: "assistant", content: fullResponse });

      // Execute tools and collect results
      const toolResults: ToolResult[] = [];
      for (const call of toolCalls) {
        yield { type: "tool_call", content: `${call.name}(${JSON.stringify(call.params)})`, toolName: call.name };

        if (call.name === "done") {
          yield { type: "done", content: call.params["summary"] ?? "Task complete." };
          return;
        }

        const result = await this.executor.execute(call);
        toolResults.push(result);

        yield {
          type: "tool_result",
          content: result.output,
          toolName: call.name,
          isError: result.isError,
        };
      }

      // Feed tool results back — compressed to save tokens
      const toolResultsText = toolResults
        .map((r) => `<tool_result name="${r.toolName}" error="${r.isError}">\n${this.compress(r.output)}\n</tool_result>`)
        .join("\n");

      history.push({ role: "user", content: toolResultsText });

      // Prune history if it's getting long (token efficiency)
      this.pruneHistory(history);
    }

    yield { type: "error", content: `Reached max iterations (${this.config.maxIterations}). Stopping.` };
  }

  /**
   * Single-shot chat (no tools) — for explain/chat panels.
   */
  async *chat(
    messages: OllamaMessage[],
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    for await (const chunk of this.provider.streamChat(messages, signal)) {
      if (signal.aborted) break;
      yield { type: "response", content: chunk.content };
      if (chunk.done) {
        this.totalPromptTokens += chunk.promptTokens ?? 0;
        this.totalCompletionTokens += chunk.completionTokens ?? 0;
        yield {
          type: "token_usage",
          content: `Tokens — prompt: ${chunk.promptTokens ?? 0}, completion: ${chunk.completionTokens ?? 0}`,
          promptTokens: this.totalPromptTokens,
          completionTokens: this.totalCompletionTokens,
        };
        yield { type: "done", content: "" };
      }
    }
  }

  private buildSystemPrompt(fileCtx: FileContext | null): string {
    const parts: string[] = [TOOL_SYSTEM_PROMPT];

    if (fileCtx) {
      parts.push("\n## Current File\n" + this.contextBuilder.formatForPrompt(fileCtx));
      if (fileCtx.selectionOrCursor) {
        parts.push(`\n## Selected Code\n\`\`\`\n${fileCtx.selectionOrCursor}\n\`\`\``);
      }
    }

    return parts.join("\n");
  }

  /**
   * Compress tool output to reduce tokens on large results.
   * Keeps first N + last M lines with a truncation marker.
   */
  private compress(text: string, maxLines = 60): string {
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    const head = lines.slice(0, 25);
    const tail = lines.slice(-15);
    return [...head, `... [${lines.length - 40} lines omitted] ...`, ...tail].join("\n");
  }

  /**
   * Prune middle of conversation history to stay token-efficient.
   * Always keeps: system prompt, first user message, last N turns.
   */
  private pruneHistory(history: OllamaMessage[], keepLast = 6): void {
    if (history.length <= keepLast + 2) return;
    const system = history[0];
    const firstUser = history[1];
    const recent = history.slice(-(keepLast));
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
