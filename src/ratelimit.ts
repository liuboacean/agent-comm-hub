/**
 * ratelimit.ts — 令牌桶限流（P2-8）
 *
 * 设计：
 *  - 每 Agent 独立令牌桶（默认 100 msg/min，env AGENT_RATE_LIMIT 可配）
 *  - 全局令牌桶（默认 1000 msg/min，env GLOBAL_RATE_LIMIT 可配）
 *  - 令牌消费 O(1)，refill 基于时间差惰性计算（无需定时器）
 *  - 超限返回 Decision{allowed:false, retryAfterMs}
 *  - 限流计数写入 Metrics（供面板 Top N 查询）
 */
import { incrementCounter } from "./metrics.js";

export interface Bucket {
  tokens: number;
  capacity: number;
  lastRefillMs: number;
  refillIntervalMs: number; // 每毫秒补充的令牌数
}

export interface Decision {
  allowed: boolean;
  retryAfterMs: number;
}

function createBucket(limitPerMin: number): Bucket {
  return {
    tokens: limitPerMin,
    capacity: limitPerMin,
    lastRefillMs: Date.now(),
    refillIntervalMs: limitPerMin / 60_000, // tokens per ms
  };
}

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed > 0) {
    const earned = elapsed * bucket.refillIntervalMs;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + earned);
    bucket.lastRefillMs = now;
  }
}

export class RateLimiter {
  private agentBuckets: Map<string, Bucket> = new Map();
  private globalBucket: Bucket;
  private agentLimitPerMin: number;
  private globalLimitPerMin: number;

  constructor(
    agentLimitPerMin: number = parseInt(process.env.AGENT_RATE_LIMIT ?? "100", 10),
    globalLimitPerMin: number = parseInt(process.env.GLOBAL_RATE_LIMIT ?? "1000", 10),
  ) {
    this.agentLimitPerMin = agentLimitPerMin;
    this.globalLimitPerMin = globalLimitPerMin;
    this.globalBucket = createBucket(globalLimitPerMin);
  }

  /**
   * 消费令牌
   * @param agentId  Agent 标识
   * @param tokens   本次消费令牌数（默认 1）
   * @returns Decision
   */
  consume(agentId: string, tokens: number = 1): Decision {
    // Agent 级限流
    const agentBucket = this.ensureBucket(agentId);
    refill(agentBucket);

    if (agentBucket.tokens < tokens) {
      incrementCounter("rate_limit_total", { agent_id: agentId, type: "agent" });
      const deficit = tokens - agentBucket.tokens;
      const retryAfterMs = Math.ceil((deficit / agentBucket.refillIntervalMs) * 1.1);
      return { allowed: false, retryAfterMs: Math.max(100, retryAfterMs) };
    }

    // 全局限流
    refill(this.globalBucket);
    if (this.globalBucket.tokens < tokens) {
      incrementCounter("rate_limit_total", { agent_id: agentId, type: "global" });
      const deficit = tokens - this.globalBucket.tokens;
      const retryAfterMs = Math.ceil((deficit / this.globalBucket.refillIntervalMs) * 1.1);
      return { allowed: false, retryAfterMs: Math.max(100, retryAfterMs) };
    }

    // 扣减令牌
    agentBucket.tokens -= tokens;
    this.globalBucket.tokens -= tokens;
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 重置所有桶（测试用） */
  reset(): void {
    this.agentBuckets.clear();
    this.globalBucket = createBucket(this.globalLimitPerMin);
  }

  /** 获取 Agent 当前令牌数（测试用） */
  getAgentTokens(agentId: string): number {
    const bucket = this.agentBuckets.get(agentId);
    if (!bucket) return this.agentLimitPerMin;
    refill(bucket);
    return bucket.tokens;
  }

  /** 获取全局桶当前令牌数 */
  getGlobalTokens(): number {
    refill(this.globalBucket);
    return this.globalBucket.tokens;
  }

  private ensureBucket(agentId: string): Bucket {
    let bucket = this.agentBuckets.get(agentId);
    if (!bucket) {
      bucket = createBucket(this.agentLimitPerMin);
      this.agentBuckets.set(agentId, bucket);
    }
    return bucket;
  }
}
