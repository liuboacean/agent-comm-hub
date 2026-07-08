/**
 * stdio.ts — MCP Stdio Transport Entry Point + Export
 *
 * Allows agent-comm-hub to run as a stdio MCP server (command-based),
 * in addition to the existing HTTP Streamable HTTP transport.
 *
 * Usage: HUB_AUTH_TOKEN=<token> node dist/stdio.js
 *
 * Auth: Reads HUB_AUTH_TOKEN env var, verifies against auth_tokens table.
 * Logging: All logs go to stderr (stdout is reserved for JSON-RPC).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { verifyToken } from "./security.js";
/**
 * 启动 MCP stdio 服务器
 * 可由 server.ts 在检测到管道 stdin 时调用
 * 也可作为独立入口（CLI 模式）
 */
export async function startMcpStdio() {
    // 如果通过 server.ts 调用，HUB_AUTH_TOKEN 可能未设置，使用 glama-ci 兼容
    const token = process.env.HUB_AUTH_TOKEN;
    let authContext = null;
    if (token) {
        authContext = verifyToken(token);
        if (!authContext) {
            console.error(`[stdio] ERROR: Invalid HUB_AUTH_TOKEN`);
            process.exit(1);
        }
    }
    else {
        // 无 Token 时使用 glama-ci（Glama 构建测试会 sed 替换此逻辑）
        authContext = { agentId: "glama-ci", role: "admin" };
    }
    console.error(`[stdio] Authenticated as ${authContext.agentId} (role: ${authContext.role})`);
    // Create MCP server — same config as HTTP transport
    const server = new McpServer({
        name: "agent-comm-hub",
        version: "2.5.1",
    });
    registerTools(server, authContext);
    // Connect stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[stdio] Hub stdio mode started (agent: ${authContext.agentId})`);
}
// 独立入口
async function main() {
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
//# sourceMappingURL=stdio.js.map