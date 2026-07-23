/**
 * backoff.ts — 指数退避（P2-8）
 *
 * 供 ClientSDK.sendMessage() 自动嵌入退避逻辑。
 * base=200ms, cap=10s, next = min(cap, base * 2^attempt) + jitter
 */
export class Backoff {
    baseMs;
    capMs;
    attempt = 0;
    constructor(baseMs = 200, capMs = 10_000) {
        this.baseMs = baseMs;
        this.capMs = capMs;
    }
    /**
     * 计算下一次等待时间（毫秒）
     * 每次调用自动递增 attempt 计数器
     */
    next() {
        const delay = Math.min(this.capMs, this.baseMs * Math.pow(2, this.attempt));
        const jitter = Math.random() * 100; // 0-100ms 随机 jitter
        this.attempt++;
        return Math.round(delay + jitter);
    }
    /**
     * 重置退避状态（成功后调用）
     */
    reset() {
        this.attempt = 0;
    }
    /**
     * 获取当前尝试次数
     */
    getAttempt() {
        return this.attempt;
    }
}
//# sourceMappingURL=backoff.js.map