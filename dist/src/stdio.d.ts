/**
 * 启动 MCP stdio 服务器
 * 可由 server.ts 在检测到管道 stdin 时调用
 * 也可作为独立入口（CLI 模式）
 */
export declare function startMcpStdio(): Promise<void>;
