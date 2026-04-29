/**
 * utils.ts — MCP 工具共享工具函数
 * 从 tools.ts 提取，供 src/tools/ 下所有模块共用
 */
import { type AuthContext } from "./security.js";
import { checkPermission, getRequiredPermission } from "./security.js";
import { logError } from "./logger.js";

// ─── 通用工具：带指数退避的重试 ──────────────────────────
export async function withRetry<T>(
  fn: () => T,
  label: string,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: any) {
      const isLast = attempt === maxRetries;
      logError("withRetry_failed", err, { label, attempt, maxRetries });
      if (isLast) throw err;
      const delay = Math.pow(2, attempt - 1) * 100;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`unreachable`);
}

/**
 * 创建带权限检查的工具包装器
 */
export function requireAuth(
  authContext: AuthContext | undefined,
  toolName: string
): AuthContext {
  if (!authContext) {
    throw new Error(`Authentication required for tool: ${toolName}`);
  }
  if (!checkPermission(toolName, authContext.role)) {
    const required = getRequiredPermission(toolName) ?? "member";
    throw new Error(
      `Permission denied: ${toolName} requires '${required}' role, current role is '${authContext.role}'`
    );
  }
  return authContext;
}
