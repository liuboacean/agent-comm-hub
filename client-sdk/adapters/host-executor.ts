/**
 * host-executor.ts — 宿主执行器（Host Executor）
 * ------------------------------------------------------------------
 * 这是「宿主到底怎么干活」的契约与参考实现。
 *
 * 背景：Feature A 的 AgentRuntime 只负责状态机 + 护栏，宿主的真实能力
 * 通过一个 HostExecutor 注入。之前 WorkBuddy/Hermes 桥里是 setTimeout
 * 占位回显；本文件把它换成**真实可运行**的执行器，使「任务派发 →
 * Agent 自动调用宿主能力 → 回写结果」真正闭环。
 *
 * 两个开箱即用的参考实现：
 *   - LlmHostExecutor  : 直接调 LLM（Anthropic / OpenAI 兼容），
 *                        配置 HOST_LLM_* 环境变量即可工作。
 *   - HttpHostExecutor : 调宿主自身暴露的 HTTP 任务端点（适配 Hermes
 *                        这类自带 API 的宿主）。
 *
 * 你也可以实现自己的 HostExecutor（比如接 WorkBuddy/Hermes 的内部
 * 运行时、MCP 工具、脚本引擎），只要满足 HostExecutor 接口即可。
 */
import type { TaskEvent } from "../agent-client.js";
import type { ProgressReporter, HostExecutor } from "./host-task-bridge.js";

// ─── 1. LLM 驱动的执行器（开箱即用，需 API Key）─────────────
export type LlmProvider = "anthropic" | "openai";

export interface LlmHostExecutorOptions {
  provider?: LlmProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export class LlmHostExecutor implements HostExecutor {
  private readonly provider: LlmProvider;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly timeoutMs: number;

  constructor(opts: LlmHostExecutorOptions = {}) {
    this.provider =
      opts.provider ?? (process.env.HOST_LLM_PROVIDER as LlmProvider) ?? "anthropic";
    this.baseUrl =
      opts.baseUrl ??
      process.env.HOST_LLM_BASE_URL ??
      (this.provider === "anthropic"
        ? "https://api.anthropic.com/v1/messages"
        : "https://api.openai.com/v1/chat/completions");
    this.apiKey = opts.apiKey ?? process.env.HOST_LLM_API_KEY ?? "";
    this.model =
      opts.model ??
      process.env.HOST_LLM_MODEL ??
      (this.provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini");
    this.systemPrompt =
      opts.systemPrompt ??
      "你是一个自主 Agent，正在执行通过多智能体中枢（agent-comm-hub）委派的任务。" +
        "请直接产出清晰、可操作的结果，不要寒暄。";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async execute(task: TaskEvent, report: ProgressReporter): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        "LlmHostExecutor: 未配置 HOST_LLM_API_KEY，无法调用 LLM。" +
          "请设置环境变量，或改用 HttpHostExecutor / 自定义 HostExecutor。"
      );
    }

    report(40, "规划并调用 LLM 执行任务");
    const userContent = [
      task.context ? `上下文:\n${task.context}` : "",
      `任务: ${task.description}`,
      task.priority ? `优先级: ${task.priority}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(userContent)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM 调用失败 (${res.status}): ${text.slice(0, 300)}`);
      }
      const data: unknown = await res.json();
      const text = this.extractText(data);
      report(85, "整理结果");
      return JSON.stringify(
        { agent: "host-llm", model: this.model, result: text, taskId: task.id },
        null,
        2
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private buildHeaders(): Record<string, string> {
    if (this.provider === "anthropic") {
      return {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      };
    }
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildBody(userContent: string): unknown {
    if (this.provider === "anthropic") {
      return {
        model: this.model,
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: [{ role: "user", content: userContent }],
      };
    }
    return {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: userContent },
      ],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractText(data: any): string {
    if (this.provider === "anthropic") {
      return (data?.content ?? [])
        .map((b: { type?: string; text?: string }) => (b?.type === "text" ? b.text ?? "" : ""))
        .join("");
    }
    return data?.choices?.[0]?.message?.content ?? "";
  }
}

// ─── 2. HTTP 端点驱动的执行器（适配自带 API 的宿主）──────────
export interface HttpHostExecutorOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpHostExecutor implements HostExecutor {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: HttpHostExecutorOptions = {}) {
    this.endpoint = opts.endpoint ?? process.env.HOST_EXEC_ENDPOINT ?? "";
    this.headers = opts.headers ?? {};
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async execute(task: TaskEvent, report: ProgressReporter): Promise<string> {
    if (!this.endpoint) {
      throw new Error(
        "HttpHostExecutor: 未配置 endpoint（HOST_EXEC_ENDPOINT 或构造参数）。"
      );
    }
    report(40, "调用宿主 HTTP 端点");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ task }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`宿主端点调用失败 (${res.status}): ${text.slice(0, 300)}`);
      }
      report(85, "汇总结果");
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── 3. 默认执行器工厂 ───────────────────────────────────
/**
 * 按优先级选择默认执行器：
 *   1. 配置了 HOST_EXEC_ENDPOINT → HttpHostExecutor（宿主自带 API，如 Hermes）
 *   2. 否则 → LlmHostExecutor（需要 HOST_LLM_API_KEY）
 */
export function defaultHostExecutor(): HostExecutor {
  if (process.env.HOST_EXEC_ENDPOINT) {
    return new HttpHostExecutor({ endpoint: process.env.HOST_EXEC_ENDPOINT });
  }
  return new LlmHostExecutor();
}
