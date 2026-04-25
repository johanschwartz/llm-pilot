// src/providers/OllamaProvider.ts
// Low-level Ollama API client with streaming support

import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  promptTokens?: number;
  completionTokens?: number;
}

export class OllamaProvider {
  constructor(private opts: OllamaOptions) {}

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
        num_predict: this.opts.maxTokens ?? 2048,
      },
    });

    const chunks = this.makeRequest(url, body, signal);

    for await (const raw of chunks) {
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
        // Skip malformed chunks
      }
    }
  }

  async chat(
    messages: OllamaMessage[],
    signal?: AbortSignal
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of this.streamChat(messages, signal)) {
      content += chunk.content;
      if (chunk.done) {
        promptTokens = chunk.promptTokens ?? 0;
        completionTokens = chunk.completionTokens ?? 0;
      }
    }

    return { content, promptTokens, completionTokens };
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
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Ollama connection timeout — is Ollama running?"));
      });
    });
  }

  private async *makeRequest(
    url: URL,
    body: string,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const client = url.protocol === "https:" ? https : http;
    let buffer = "";

    yield* await new Promise<AsyncGenerator<string>>((resolve, reject) => {
      const req = client.request(
        url.toString(),
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          resolve(
            (async function* () {
              for await (const chunk of res) {
                if (signal?.aborted) return;
                buffer += chunk.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  if (line.trim()) yield line;
                }
              }
              if (buffer.trim()) yield buffer;
            })()
          );
        }
      );

      req.on("error", reject);
      if (signal) {
        signal.addEventListener("abort", () => req.destroy());
      }
      req.write(body);
      req.end();
    });
  }
}
