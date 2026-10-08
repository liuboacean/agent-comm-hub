export class LlmHostExecutor {
    provider;
    baseUrl;
    apiKey;
    model;
    systemPrompt;
    timeoutMs;
    constructor(opts = {}) {
        this.provider =
            opts.provider ?? process.env.HOST_LLM_PROVIDER ?? "anthropic";
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
    async execute(task, report) {
        if (!this.apiKey) {
            throw new Error("LlmHostExecutor: 未配置 HOST_LLM_API_KEY，无法调用 LLM。" +
                "请设置环境变量，或改用 HttpHostExecutor / 自定义 HostExecutor。");
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
            const data = await res.json();
            const text = this.extractText(data);
            report(85, "整理结果");
            return JSON.stringify({ agent: "host-llm", model: this.model, result: text, taskId: task.id }, null, 2);
        }
        finally {
            clearTimeout(timer);
        }
    }
    buildHeaders() {
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
    buildBody(userContent) {
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
    extractText(data) {
        if (this.provider === "anthropic") {
            return (data?.content ?? [])
                .map((b) => (b?.type === "text" ? b.text ?? "" : ""))
                .join("");
        }
        return data?.choices?.[0]?.message?.content ?? "";
    }
}
export class HttpHostExecutor {
    endpoint;
    headers;
    timeoutMs;
    constructor(opts = {}) {
        this.endpoint = opts.endpoint ?? process.env.HOST_EXEC_ENDPOINT ?? "";
        this.headers = opts.headers ?? {};
        this.timeoutMs = opts.timeoutMs ?? 120_000;
    }
    async execute(task, report) {
        if (!this.endpoint) {
            throw new Error("HttpHostExecutor: 未配置 endpoint（HOST_EXEC_ENDPOINT 或构造参数）。");
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
        }
        finally {
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
export function defaultHostExecutor() {
    if (process.env.HOST_EXEC_ENDPOINT) {
        return new HttpHostExecutor({ endpoint: process.env.HOST_EXEC_ENDPOINT });
    }
    return new LlmHostExecutor();
}
//# sourceMappingURL=host-executor.js.map