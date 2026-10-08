/**
 * types.ts — DB Row 类型定义 + 工具类型
 * Phase D: 消除 any，统一类型
 */
// ─── 错误类型 ───────────────────────────────────────────────
/** 从 unknown 提取错误消息 */
export function getErrorMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === "string")
        return err;
    return String(err);
}
//# sourceMappingURL=types.js.map