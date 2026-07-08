/**
 * stdio-node-version.test.ts — 防护性测试：锁定「stdio / Hub 必须用 Node 22 启动」
 * ---------------------------------------------------------------------------
 * 根因（运维约束）：
 *   agent-comm-hub 依赖原生模块 better-sqlite3，它是按
 *   Node 22（NODE_MODULE_VERSION 127）编译的。若用 Node 24 启动
 *   dist/src/stdio.js（MCP stdio 入口）或 dist/src/server.js（HTTP 入口），
 *   会立即崩溃：
 *     Error: The module '.../better_sqlite3.node' was compiled against a
 *     different Node.js version using NODE_MODULE_VERSION 127.
 *     This version of Node.js requires NODE_MODULE_VERSION 137 (ERR_DLOPEN_FAILED)
 *
 * 目标：锁定两处运维约束，防止 mcp.json 或启动脚本未来被误改回 Node v24，
 *      再次引发 better-sqlite3 ABI 崩溃。覆盖两类回归：
 *   用例 1：scripts/start_hub_server.sh 的 Node 22 锁定契约（仓库内文件，必加）。
 *   用例 2：/Users/liubo/.workbuddy/mcp.json 的 agent-comm-hub command 必须用 Node 22
 *          （仓库外文件；不存在则 skip + 告警，不 fail）。
 *   用例 3（条件冒烟）：Node 22 下 stdio 能真正启动且 get_db_stats 成功。
 *          —— 仅当 process.versions.node 主版本 == 22 时执行；
 *             若是其它版本（如 CI 的 Node 24）则 skip，避免 better-sqlite3 在
 *             错误版本下必然崩溃导致 CI 误 fail。
 *
 * 隔离原则：
 *   用例 3 启动子进程时，将真实库 comm_hub.db 复制到临时文件作 DB_PATH，
 *   只读调用 get_db_stats，绝不向真实库写数据，也不依赖真实库的 token。
 *   abort 安全性：整体超时保护（≤ ~10s），结束必 kill 子进程。
 *
 * 运行：
 *   npx vitest run tests/integration/stdio-node-version.test.ts
 *   或纳入套件： npx vitest run   （vitest.config include 已包含本目录）
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

// ─── 路径常量 ──────────────────────────────────────────────
// 仓库根：tests/integration -> 上两级
const ROOT = path.resolve(__dirname, "..", "..");
const START_SCRIPT = path.join(ROOT, "scripts", "start_hub_server.sh");
const STDIO_JS = path.join(ROOT, "dist", "src", "stdio.js");
const REAL_DB = path.join(ROOT, "comm_hub.db");
// 仓库外文件（WorkBuddy 的 MCP client 配置），路径写死
const MCP_JSON_PATH = "/Users/liubo/.workbuddy/mcp.json";

// ─── 工具函数 ──────────────────────────────────────────────
/**
 * 从 node 可执行路径中提取主版本号。
 * 匹配：/Users/liubo/.nvm/versions/node/v22.22.0/bin/node
 *       /Users/liubo/.nvm/versions/node/v22.22.2/bin
 * 返回 22 / 24 等，未命中返回 null。
 */
function extractNodeMajor(p: string): number | null {
  const m = p.match(/node[\\/]v(\d+)(?:\.\d+)*/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 解析冒烟测试所需的有效 HUB_AUTH_TOKEN（明文）。
 * 优先取仓库外 mcp.json 中 agent-comm-hub.env.HUB_AUTH_TOKEN —— 该明文经
 * sha256 后命中库内 admin api_token（已验证），可作为 admin 调用 get_db_stats。
 * 取不到则返回 null（调用方应 skip 全流程用例）。
 */
function resolveSmokeToken(): string | null {
  if (!fs.existsSync(MCP_JSON_PATH)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_JSON_PATH, "utf-8"));
    const t = cfg?.mcpServers?.["agent-comm-hub"]?.env?.HUB_AUTH_TOKEN;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * 将真实库复制为临时隔离副本（含 -wal/-shm 若存在），返回副本路径。
 * 子进程对副本只读调用 get_db_stats，绝不污染真实数据。
 */
function copyDbToTemp(src: string): string {
  const tmp = path.join(os.tmpdir(), `ach-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  fs.copyFileSync(src, tmp);
  for (const ext of ["-wal", "-shm"]) {
    const side = src + ext;
    if (fs.existsSync(side)) {
      try { fs.copyFileSync(side, tmp + ext); } catch { /* ignore */ }
    }
  }
  return tmp;
}

function cleanupTmp(tmp: string | null): void {
  if (!tmp) return;
  for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 等待子进程退出或超时；收集 stderr 用于 ABI 崩溃判定。
 */
function waitForExitOrTimeout(child: ChildProcess, ms: number): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const timer = setTimeout(() => resolve({ code: null, signal: "timeout", stderr }), ms);
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (c: string) => { stderr += c; });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

/**
 * 运行 JSON-RPC 冒烟：initialize → notifications/initialized →
 * tools/call get_db_stats，断言返回含 memories 的成功响应。
 * 始终设置整体超时（≤9s），结束必杀子进程。
 */
function runJsonRpcSmoke(child: ChildProcess): Promise<{ crashedAbi: boolean; gotDbStatsOk: boolean }> {
  return new Promise((resolve) => {
    let buf = "";
    let stderr = "";
    let gotInit = false;
    let finished = false;
    const overall = setTimeout(() => finish({ crashedAbi: false, gotDbStatsOk: false }), 9000);

    function finish(r: { crashedAbi: boolean; gotDbStatsOk: boolean }): void {
      if (finished) return;
      finished = true;
      clearTimeout(overall);
      try { child.stdin?.end(); } catch { /* ignore */ }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(r);
    }

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        // initialize 响应：发送 initialized 通知，随后调用 get_db_stats
        if (msg.id === 1 && msg.result && !gotInit) {
          gotInit = true;
          child.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
          );
          setTimeout(() => {
            child.stdin?.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "get_db_stats", arguments: {} },
              }) + "\n"
            );
          }, 300);
        }
        // get_db_stats 响应：result.content[].text 含 memories
        if (msg.id === 2 && msg.result && !finished) {
          const text = JSON.stringify(msg.result);
          if (/memories/.test(text)) {
            finish({ crashedAbi: false, gotDbStatsOk: true });
          }
        }
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (c: string) => { stderr += c; });

    child.on("exit", () => {
      if (finished) return;
      const abi = /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(stderr);
      // 进程提前退出（如 auth 失败）视为「未成功拿到 get_db_stats」，但仅 ABI 崩溃为硬失败
      finish({ crashedAbi: abi, gotDbStatsOk: false });
    });

    // 发送 initialize 请求
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "qa-node-version-smoke", version: "1.0.0" },
        },
      }) + "\n"
    );
  });
}

// 模块级判定（describe 收集期同步确定，保证报告稳定）
const mcpJsonExists = fs.existsSync(MCP_JSON_PATH);
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
const RUN_SMOKE = nodeMajor === 22;

// ═══════════════════════════════════════════════════════════
// 用例 1：start_hub_server.sh 必须锁定 Node 22（仓库内，核心）
// ═══════════════════════════════════════════════════════════
describe("用例1: start_hub_server.sh 必须锁定 Node 22（防 better-sqlite3 ABI 崩溃）", () => {
  it("脚本存在且包含 Node 22 锁定线索（nvm use 22 或 PATH 兜底 node/v22）", () => {
    // 仓库内被断言对象，必须存在
    expect(fs.existsSync(START_SCRIPT), "scripts/start_hub_server.sh 必须存在（仓库内运维约束文件）").toBe(true);

    const content = fs.readFileSync(START_SCRIPT, "utf-8");
    const hasNvmUse22 = /nvm\s+use\s+22(\.|$|\s)/.test(content);
    const hasPathV22 = /node\/v22/.test(content);

    expect(
      hasNvmUse22 || hasPathV22,
      "start_hub_server.sh 必须含 'nvm use 22' 或 PATH 兜底 'node/v22'，" +
        "否则切回 v24 会令 better-sqlite3 (NODE_MODULE_VERSION 127) ABI 不匹配崩溃"
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 用例 2：mcp.json 的 agent-comm-hub command 必须用 Node 22
// ═══════════════════════════════════════════════════════════
describe("用例2: mcp.json 的 agent-comm-hub command 必须用 Node 22", () => {
  if (!mcpJsonExists) {
    it.skip("mcp.json 不存在（仓库外文件），跳过 agent-comm-hub command 契约检查", () => {
      console.warn(
        `[WARN] ${MCP_JSON_PATH} 不存在，跳过 mcp.json command 契约断言（仓库外文件，不视为失败）`
      );
    });
    return;
  }

  it("agent-comm-hub.command 解析出的 Node 主版本必须为 22（且不得是 v24）", () => {
    const raw = fs.readFileSync(MCP_JSON_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    expect(cfg.mcpServers, "mcp.json 应包含 mcpServers 对象").toBeTypeOf("object");

    const srv = cfg.mcpServers["agent-comm-hub"];
    expect(srv, "mcpServers 应包含 agent-comm-hub").toBeTruthy();
    expect(typeof srv.command, "agent-comm-hub.command 应为字符串").toBe("string");

    const major = extractNodeMajor(srv.command);
    expect(major, `command 应包含 'node/vXX' 版本锁定，实际: ${srv.command}`).not.toBeNull();
    expect(
      major,
      `agent-comm-hub 必须用 Node 22 启动（防 better-sqlite3 ABI 崩溃），实际主版本: ${major}`
    ).toBe(22);
    // 防御：明确禁止 v24
    expect(/v24/.test(srv.command), `command 不得指向 v24: ${srv.command}`).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 用例 3：Node 22 下 stdio 能真正启动且 get_db_stats 成功（条件冒烟）
// ═══════════════════════════════════════════════════════════
describe("用例3: Node 22 下 stdio 进程能启动且 get_db_stats 成功（冒烟）", () => {
  if (!RUN_SMOKE) {
    it.skip("当前 Node 主版本非 22（实际 " + nodeMajor + "），跳过 stdio 冒烟（需在 Node 22 下验证，避免 better-sqlite3 在 v24 ABI 崩溃导致 CI 误 fail）", () => {});
    return;
  }

  // 子测试 A：ABI 加载检查（始终执行，不需要 token）
  it("A: stdio.js 在 Node 22 下加载 better-sqlite3 不崩溃（无 ERR_DLOPEN_FAILED）", async () => {
    expect(fs.existsSync(STDIO_JS), "dist/src/stdio.js 必须存在").toBe(true);

    // 用临时空库避免 better-sqlite3 在仓库根创建脏文件；仅验证「加载不崩」
    const abiDb = path.join(os.tmpdir(), `ach-abi-${Date.now()}.db`);
    const child = spawn(process.execPath, [STDIO_JS], {
      env: { ...process.env, DB_PATH: abiDb },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const { stderr } = await waitForExitOrTimeout(child, 5000);
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    try { fs.rmSync(abiDb, { force: true }); } catch { /* ignore */ }

    // 即使因缺少 HUB_AUTH_TOKEN 退出(1)，也不应出现 ABI 崩溃
    expect(
      /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/.test(stderr),
      `better-sqlite3 ABI 崩溃（说明被错误 Node 版本启动）: ${stderr.slice(0, 300)}`
    ).toBe(false);
  }, 10000);

  // 准备隔离副本 + token
  const token = resolveSmokeToken();
  const tmpDb = token && fs.existsSync(REAL_DB) ? copyDbToTemp(REAL_DB) : null;
  if (tmpDb) afterAll(() => cleanupTmp(tmpDb));

  if (!token || !tmpDb) {
    it.skip("B: 未解析到有效 HUB_AUTH_TOKEN / 真实库缺失，跳过 get_db_stats 全流程冒烟", () => {
      console.warn("[WARN] 跳过 get_db_stats 全流程冒烟（缺少有效 HUB_AUTH_TOKEN 或真实库）");
    });
  } else {
    it("B: JSON-RPC 全流程 initialize→initialized→get_db_stats 返回含 memories 的成功响应", async () => {
      const child = spawn(process.execPath, [STDIO_JS], {
        env: { ...process.env, HUB_AUTH_TOKEN: token, DB_PATH: tmpDb },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const r = await runJsonRpcSmoke(child);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }

      expect(r.crashedAbi, "stdio 进程不应因 ERR_DLOPEN_FAILED (better-sqlite3 ABI) 崩溃").toBe(false);
      expect(r.gotDbStatsOk, "get_db_stats 应返回成功响应（content 文本含 memories 字段）").toBe(true);
    }, 15000);
  }
});
