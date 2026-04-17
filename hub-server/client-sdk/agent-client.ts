/**
 * agent-client.ts — 通用 Agent 客户端 SDK
 * WorkBuddy 和 Hermes 都用这个文件接入 Hub
 *
 * 功能：
 *  1. SSE 长连接（自动重连，零轮询）
 *  2. MCP 工具调用封装（HTTP POST /mcp，含 initialize 握手）
 *  3. 事件路由（new_message / task_assigned / task_updated / pending_messages）
 */

import { EventEmitter } from "events";

// ─── 类型定义 ──────────────────────────────────────────
export interface AgentClientOptions {
  agentId:  string;          // 本 Agent 的唯一标识，如 "workbuddy" 或 "hermes"
  hubUrl:   string;          // Hub 地址，如 "http://localhost:3100"
  onTaskAssigned?: (task: TaskEvent) => Promise<void>;   // 收到新任务时的处理函数
  onMessage?:      (msg:  MessageEvent) => Promise<void>;// 收到消息时的处理函数
  onTaskUpdated?:  (upd:  TaskUpdateEvent) => Promise<void>; // 任务进度回调
  reconnectDelay?: number;   // 断线重连间隔（ms），默认 3000
  mcpTimeout?:     number;   // MCP 请求超时（ms），默认 15000
}

export interface TaskEvent {
  id:          string;
  assigned_by: string;
  assigned_to: string;
  description: string;
  context?:    string;
  priority:    string;
  status:      string;
  instruction: string;
}

export interface MessageEvent {
  id:         string;
  from_agent: string;
  to_agent:   string;
  content:    string;
  type:       string;
  metadata?:  Record<string, unknown>;
  created_at: number;
}

export interface TaskUpdateEvent {
  task_id:    string;
  status:     string;
  result?:    string;
  progress:   number;
  updated_by: string;
  timestamp:  number;
}

// ─── AgentClient 类 ────────────────────────────────────
export class AgentClient extends EventEmitter {
  private opts:       AgentClientOptions;
  private sse:        any = null;  // EventSource 实例
  private stopping:   boolean = false;
  private sessionId:  string | null = null;  // MCP session ID
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;  // 并发安全

  constructor(opts: AgentClientOptions) {
    super();
    this.opts = {
      reconnectDelay: 3000,
      mcpTimeout:     15000,
      ...opts,
    };
  }

  // ── 启动：MCP 握手 + 建立 SSE 连接 ──────────────────
  async start(): Promise<void> {
    this.stopping = false;
    await this.ensureInitialized();
    this.connectSSE();
    console.log(`[${this.opts.agentId}] 已启动，连接 Hub: ${this.opts.hubUrl}`);
  }

  stop(): void {
    this.stopping = true;
    this.initialized = false;
    this.sessionId = null;
    this.initPromise = null;
    this.sse?.close();
    console.log(`[${this.opts.agentId}] 已停止`);
  }

  // ── MCP Initialize 握手（P0 修复）──────────────────
  /**
   * MCP Streamable HTTP Transport 要求先完成 initialize 握手：
   *   1. POST /mcp { method: "initialize", ... }
   *   2. 服务端返回 { result: { capabilities, ... } }
   *   3. POST /mcp { method: "notifications/initialized" }
   *
   * 注意：Hub 使用 Stateless 模式，每次请求独立，无需 session ID。
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // 防止并发多次握手
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    const timeout = this.opts.mcpTimeout!;

    // Step 1: initialize 请求（stateless 模式：每次都成功）
    const initRes = await this.postMcp(
      {
        jsonrpc: "2.0",
        id:      1,
        method:  "initialize",
        params:  {
          protocolVersion: "2025-03-26",
          capabilities:   {},
          clientInfo:     {
            name:    `agent-client-${this.opts.agentId}`,
            version: "1.0.0",
          },
        },
      },
      timeout
    );

    if (initRes.body?.error) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(initRes.body.error)}`);
    }

    console.log(`[${this.opts.agentId}] MCP initialized (stateless)`);

    // Step 2: 发送 initialized 通知（无 id 字段 = notification）
    await this.postMcp(
      {
        jsonrpc: "2.0",
        method:  "notifications/initialized",
      },
      timeout
    );

    this.initialized = true;
  }

  /**
   * 底层 MCP POST 请求封装
   * 返回 { body: parsedJson, sessionId: Mcp-Session-Id header value }
   *
   * 注意：MCP Streamable HTTP 用 SSE 格式返回响应：
   *   event: message\n
   *   data: {"result":...,"jsonrpc":"2.0","id":1}\n
   *   \n
   * Hub 使用 Stateless 模式，每个请求独立，无需 session ID。
   */
  private async postMcp(payload: object, timeout: number): Promise<{ body: any; sessionId: string | null }> {
    const url = `${this.opts.hubUrl}/mcp`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept":        "application/json, text/event-stream",
        },
        body:    JSON.stringify(payload),
        signal:  controller.signal,
      });

      const sessionId = res.headers.get("mcp-session-id");

      // 解析 SSE 格式响应：提取 data: 行的 JSON
      const raw = await res.text();
      let body: any;

      if (res.headers.get("content-type")?.includes("text/event-stream")) {
        // SSE 格式：找 "data: " 开头的行
        const dataLine = raw.split("\n")
          .map(line => line.trim())
          .find(line => line.startsWith("data: "));

        if (dataLine) {
          const jsonStr = dataLine.slice(6); // 去掉 "data: " 前缀
          body = JSON.parse(jsonStr);
        } else {
          body = null;
        }
      } else {
        // 普通 JSON 响应
        body = raw ? JSON.parse(raw) : null;
      }

      return { body, sessionId };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`MCP request timeout (${timeout}ms): ${JSON.stringify(payload)}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── SSE 连接（含自动重连）───────────────────────────
  private connectSSE(): void {
    const url = `${this.opts.hubUrl}/events/${this.opts.agentId}`;

    try {
      // 尝试浏览器原生
      this.sse = new (globalThis as any).EventSource(url);
    } catch {
      // Node.js 回退：动态 import eventsource 包（ESM 兼容）
      import("eventsource").then((mod: any) => {
        this.sse = new (mod.default || mod.EventSource || mod)(url);
        this.bindSSEEvents();
      });
      return; // bindSSEEvents 将在 import 完成后调用
    }

    this.bindSSEEvents();
  }

  private bindSSEEvents(): void {
    if (!this.sse) return;

    // P0-3: 重连超时缩短到 5 秒（原来依赖 opts.reconnectDelay 3000ms）
    // EventSource 内置重连逻辑由服务端心跳控制，这里用 onerror兜底
    this.sse.onmessage = (e: { data: string }) => {
      try {
        const data = JSON.parse(e.data);
        this.routeEvent(data);
      } catch (err) {
        console.error(`[${this.opts.agentId}] SSE 解析失败:`, err);
      }
    };

    this.sse.onerror = () => {
      if (this.stopping) return;
      console.warn(`[${this.opts.agentId}] SSE 断线，${this.opts.reconnectDelay}ms 后重连...`);
      this.sse?.close();
      this.sse = null;
      setTimeout(() => {
        if (!this.stopping) this.connectSSE();
      }, this.opts.reconnectDelay);
    };
  }

  // ── 事件路由 ─────────────────────────────────────────
  private async routeEvent(data: any): Promise<void> {
    switch (data.event) {
      case "task_assigned":
        this.emit("task_assigned", data.task);
        await this.opts.onTaskAssigned?.(data.task);
        break;

      case "new_message":
        this.emit("new_message", data.message);
        await this.opts.onMessage?.(data.message);
        break;

      case "task_updated":
        this.emit("task_updated", data.update);
        await this.opts.onTaskUpdated?.(data.update);
        break;

      case "pending_messages":
        for (const msg of data.messages ?? []) {
          this.emit("new_message", msg);
          await this.opts.onMessage?.(msg);
        }
        break;
    }
  }

  // ── MCP 工具调用封装 ─────────────────────────────────
  private async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    // 每次调用前确保握手完成
    await this.ensureInitialized();
    return this._callTool(toolName, args);
  }

  private async _callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    const { body } = await this.postMcp(
      {
        jsonrpc: "2.0",
        id:      Date.now(),
        method:  "tools/call",
        params:  { name: toolName, arguments: args },
      },
      this.opts.mcpTimeout!
    );

    // 错误处理
    if (body.error) {
      const errMsg = body.error.message ?? JSON.stringify(body.error);
      throw new Error(`MCP tool error [${toolName}]: ${errMsg}`);
    }

    // 从标准 MCP 响应中提取结果
    const text = body?.result?.content?.[0]?.text ?? body?.result;
    if (typeof text === "string") {
      try { return JSON.parse(text); } catch { return text; }
    }
    return body;
  }

  // ── 对外 API ─────────────────────────────────────────

  /** 发送消息给另一个 Agent */
  async sendMessage(to: string, content: string, metadata?: Record<string, unknown>) {
    return this.callTool("send_message", {
      from: this.opts.agentId, to, content, type: "message", metadata,
    });
  }

  /** 分配任务给另一个 Agent */
  async assignTask(to: string, description: string, context?: string, priority?: string) {
    return this.callTool("assign_task", {
      from: this.opts.agentId, to, description, context,
      priority: priority ?? "normal",
    });
  }

  /** 汇报任务进度 */
  async updateTaskStatus(
    taskId: string,
    status: "in_progress" | "completed" | "failed",
    result?: string,
    progress?: number
  ) {
    return this.callTool("update_task_status", {
      task_id: taskId, agent_id: this.opts.agentId, status, result, progress: progress ?? 0,
    });
  }

  /** 查询任务状态 */
  async getTaskStatus(taskId: string) {
    return this.callTool("get_task_status", { task_id: taskId });
  }

  /** 查询在线 Agent */
  async getOnlineAgents(): Promise<string[]> {
    const result = await this.callTool("get_online_agents", {});
    return result?.online_agents ?? [];
  }

  /** 广播消息 */
  async broadcast(agentIds: string[], content: string, metadata?: Record<string, unknown>) {
    return this.callTool("broadcast_message", {
      from: this.opts.agentId, agent_ids: agentIds, content, metadata,
    });
  }
}
