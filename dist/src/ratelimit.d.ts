export interface Bucket {
    tokens: number;
    capacity: number;
    lastRefillMs: number;
    refillIntervalMs: number;
}
export interface Decision {
    allowed: boolean;
    retryAfterMs: number;
}
export declare class RateLimiter {
    private agentBuckets;
    private globalBucket;
    private agentLimitPerMin;
    private globalLimitPerMin;
    constructor(agentLimitPerMin?: number, globalLimitPerMin?: number);
    /**
     * 消费令牌
     * @param agentId  Agent 标识
     * @param tokens   本次消费令牌数（默认 1）
     * @returns Decision
     */
    consume(agentId: string, tokens?: number): Decision;
    /** 重置所有桶（测试用） */
    reset(): void;
    /** 获取 Agent 当前令牌数（测试用） */
    getAgentTokens(agentId: string): number;
    /** 获取全局桶当前令牌数 */
    getGlobalTokens(): number;
    private ensureBucket;
}
