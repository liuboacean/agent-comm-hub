/**
 * stdio.ts — MCP Stdio Transport Entry Point + Export
 *
 * Allows agent-comm-hub to run as a stdio MCP server (command-based),
 * in addition to the existing HTTP Streamable HTTP transport.
 *
 * Usage: HUB_AUTH_TOKEN=<token> node dist/stdio.js
 *
 * 🔴 推荐用法已变更（2026-10-08）：优先把 MCP 客户端指向 HTTP 端点
 *    `http://127.0.0.1:3100/mcp`。本 stdio 入口仅用于「3100 未起」的单写者场景。
 *
 * Auth: Reads HUB_AUTH_TOKEN env var, verifies against auth_tokens table.
 * Logging: All logs go to stderr (stdout is reserved for JSON-RPC).
 */
import { get as httpGet } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HUB_VERSION } from "./version.js";
import type { AuthContext } from "./security.js";

/**
 * ═══════════════════════════════════════════════════════════════
 * 单写者护栏（2026-10-08）
 * ═══════════════════════════════════════════════════════════════
 * 依据：he《方案-Hub分脑根因与看门狗改法-he-20261008》。
 *
 * comm_hub.db 是 WAL 库，只允许一个写者。launchd 的 `dist/src/server.js`（HTTP :3100）
 * 与 WorkBuddy.app spawn 的本 stdio 进程若并发直开同一 SQLite 文件，即构成
 * 「单文件双写」⇒ WAL 变孤儿 ⇒ 读写分脑 / 页级损坏（已有 lsof 实证：两进程同持 fd）。
 *
 * 🔴 护栏必须早于任何触达 SQLite 的模块被载入：`src/db.ts` 的
 *    `export const db = new Database(DB_PATH)` 是**模块级副作用**，一旦 import 就已开库。
 *    因此本文件对 `./security.js`、`./tools.js` 一律改为**守卫之后再 `await import()`**，
 *    顶部只保留「不触库」的静态 import。
 *
 * 行为：
 *   - 探测到 :3100 存活 ⇒ **拒绝启动**（强制单写者），退出码 1，并给出改用 HTTP 的指引。
 *   - 探测失败（服务未起 / 超时 / 异常）⇒ 视为「无冲突」，本进程正常接管为唯一写者。
 * 逃生舱：`HUB_FORCE_STDIO=1` 显式绕过（运维自检用，风险自负）。
 */
const HUB_PROBE_URL = process.env.HUB_PROBE_URL || "http://127.0.0.1:3100/health";
const PROBE_TIMEOUT_MS = Number(process.env.HUB_PROBE_TIMEOUT_MS || 800);

/**
 * 探测 3100 HTTP 服务是否存活。
 * 任何异常 / 超时都返回 false（＝「无冲突」的安全降级方向，避免误拦正常启动）。
 */
function probeHubServer(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.env.HUB_FORCE_STDIO === "1") {
      console.error("[stdio] HUB_FORCE_STDIO=1 — 单写者护栏已显式绕过（风险自负）");
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(alive);
    };

    try {
      const req = httpGet(HUB_PROBE_URL, (res) => {
        res.resume(); // 丢弃 body，立即释放 socket
        const code = res.statusCode ?? 0;
        // 2xx/3xx/4xx 均说明端口在监听（4xx 亦为「服务活着」的强证据）
        settle(code > 0 && code < 500);
      });
      req.on("error", () => settle(false));
      req.setTimeout(PROBE_TIMEOUT_MS, () => {
        req.destroy();
        settle(false);
      });
    } catch {
      settle(false);
    }
  });
}

/**
 * 启动 MCP stdio 服务器
 * 可由 server.ts 在检测到管道 stdin 时调用
 * 也可作为独立入口（CLI 模式）
 */
export async function startMcpStdio(): Promise<void> {
  // 0) 单写者护栏 —— 必须早于任何 ./db 载入（见文件头说明）
  if (await probeHubServer()) {
    console.error(`[stdio] REFUSED: agent-comm-hub HTTP server is alive at ${HUB_PROBE_URL}`);
    console.error("[stdio] 单写者护栏：同一 comm_hub.db 不允许两个写者并发直开（会致 WAL 孤儿 → 分脑 / 页级损坏）。");
    console.error("[stdio] 请把 MCP 客户端指向 HTTP 端点：http://127.0.0.1:3100/mcp");
    console.error("[stdio] 确需直开库（仅当 3100 已停）：HUB_FORCE_STDIO=1");
    process.exit(1);
  }

  // 1) 安全加固：stdio 启动强制要求 HUB_AUTH_TOKEN，缺失/非法一律退出（不再有 admin 兜底分支）
  const token = process.env.HUB_AUTH_TOKEN;
  if (!token) {
    console.error("[stdio] ERROR: HUB_AUTH_TOKEN is required to start stdio transport");
    process.exit(1);
  }

  // 2) 护栏已过，此刻才载入会触达 SQLite 的模块
  const { verifyToken } = await import("./security.js");
  const authContext: AuthContext | null = verifyToken(token);
  if (!authContext) {
    console.error("[stdio] ERROR: HUB_AUTH_TOKEN is required to start stdio transport (invalid token)");
    process.exit(1);
  }

  console.error(`[stdio] Authenticated as ${authContext.agentId} (role: ${authContext.role})`);

  // 3) Create MCP server — same config as HTTP transport
  const { registerTools } = await import("./tools.js");
  const server = new McpServer({
    name: "agent-comm-hub",
    version: HUB_VERSION,
  });
  registerTools(server, authContext);

  // 4) Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[stdio] Hub stdio mode started (agent: ${authContext.agentId})`);
}

// 独立入口
async function main(): Promise<void> {
  const token = process.env.HUB_AUTH_TOKEN;
  if (!token) {
    console.error("[stdio] ERROR: HUB_AUTH_TOKEN environment variable is required");
    process.exit(1);
  }
  await startMcpStdio();
}

// 当作为独立脚本运行时（非被 server.ts import）
const isMainModule = process.argv[1]?.endsWith("stdio.js") || process.argv[1]?.endsWith("dist/src/stdio.js");
if (isMainModule) {
  main().catch((err) => {
    console.error(`[stdio] Fatal error:`, err);
    process.exit(1);
  });
}
