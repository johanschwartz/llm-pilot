// src/providers/OllamaProvider.ts
import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, string>;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface OllamaOptions {
  model: string;
  baseUrl: string;
  temperature?: number;
  maxTokens?: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  toolCalls?: OllamaToolCall[];
  promptTokens?: number;
  completionTokens?: number;
}

export interface CompleteResponse {
  content: string;
  toolCalls: OllamaToolCall[];
  promptTokens: number;
  completionTokens: number;
}

export class OllamaProvider {
  constructor(private opts: OllamaOptions) {}

  /** Non-streaming chat with tools — more reliable for tool calling. */
  async complete(
    messages: OllamaMessage[],
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<CompleteResponse> {
    const url = new URL("/api/chat", this.opts.baseUrl);
    const requestBody = {
      model: this.opts.model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      stream: false,
      options: {
        temperature: this.opts.temperature ?? 0.2,
        num_predict: Math.max(this.opts.maxTokens ?? 32768, 32768),
        think: false,
      },
    };

    const raw = await this.makeRequestFull(url, JSON.stringify(requestBody), signal);
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(`Ollama error: ${parsed.error}`);

    const toolCalls: OllamaToolCall[] = (parsed.message?.tool_calls ?? []).map(
      (tc: OllamaToolCall) => ({
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        },
      })
    );

    return {
      content: parsed.message?.content ?? "",
      toolCalls,
      promptTokens: parsed.prompt_eval_count ?? 0,
      completionTokens: parsed.eval_count ?? 0,
    };
  }

  /** Streaming chat without tools — for chat mode. */
  async *streamChat(
    messages: OllamaMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk> {
    const url = new URL("/api/chat", this.opts.baseUrl);
    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      stream: true,
      options: {
        temperature: this.opts.temperature ?? 0.2,
        num_predict: this.opts.maxTokens ?? 32768,
      },
    });

    for await (const raw of this.makeRequest(url, body, signal)) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error) throw new Error(`Ollama error: ${parsed.error}`);
        yield {
          content: parsed.message?.content ?? "",
          done: parsed.done ?? false,
          promptTokens: parsed.prompt_eval_count,
          completionTokens: parsed.eval_count,
        };
      } catch {
        // skip malformed chunks
      }
    }
  }

  async listModels(): Promise<string[]> {
    const url = new URL("/api/tags", this.opts.baseUrl);
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const req = client.get(url.toString(), (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve((parsed.models ?? []).map((m: { name: string }) => m.name));
          } catch {
            reject(new Error("Failed to parse model list"));
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("Ollama connection timeout")); });
    });
  }

  private makeRequestFull(url: URL, body: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const req = client.request(
        url.toString(),
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
      if (signal) signal.addEventListener("abort", () => req.destroy());
      req.write(body);
      req.end();
    });
  }

  private async *makeRequest(url: URL, body: string, signal?: AbortSignal): AsyncGenerator<string> {
    const client = url.protocol === "https:" ? https : http;
    let buffer = "";

    yield* await new Promise<AsyncGenerator<string>>((resolve, reject) => {
      const req = client.request(
        url.toString(),
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          resolve((async function* () {
            for await (const chunk of res) {
              if (signal?.aborted) return;
              buffer += chunk.toString();
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) { if (line.trim()) yield line; }
            }
            if (buffer.trim()) yield buffer;
          })());
        }
      );
      req.on("error", reject);
      if (signal) signal.addEventListener("abort", () => req.destroy());
      req.write(body);
      req.end();
    });
  }
}
