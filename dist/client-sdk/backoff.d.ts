/**
 * backoff.ts — 指数退避（P2-8）
 *
 * 供 ClientSDK.sendMessage() 自动嵌入退避逻辑。
 * base=200ms, cap=10s, next = min(cap, base * 2^attempt) + jitter
 */
export declare class Backoff {
    readonly baseMs: number;
    readonly capMs: number;
    private attempt;
    constructor(baseMs?: number, capMs?: number);
    /**
     * 计算下一次等待时间（毫秒）
     * 每次调用自动递增 attempt 计数器
     */
    next(): number;
    /**
     * 重置退避状态（成功后调用）
     */
    reset(): void;
    /**
     * 获取当前尝试次数
     */
    getAttempt(): number;
}
