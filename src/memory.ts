/**
 * memory.ts — Memory Service (Phase 1 Week 2)
 *
 * 功能：
 *   - storeMemory: 存储记忆（private/group/collective 三种 scope）
 *   - recallMemory: 通过 FTS5 全文搜索召回记忆
 *   - listMemories: 列出 Agent 的记忆（支持 scope 筛选）
 *   - deleteMemory: 删除记忆
 *   - getMemoryStats: 获取记忆统计
 *
 * 设计要点：
 *   - FTS5 全文索引自动同步（通过 triggers）
 *   - scope 控制：private 仅本人可见，group 组内可见，collective 全局可见
 *   - 内容长度限制 10KB
 *   - 标签支持：JSON array 字符串存储
 */
import { randomUUID } from "crypto";
import { db } from "./db.js";
import { buildFtsTokens, buildSearchQuery } from "./tokenizer.js";
import { auditLog } from "./security.js";
import type { MemoryRow, CountRow } from "./types.js";
import { getErrorMessage } from "./types.js";
import { logError, logger } from "./logger.js";

// ─── 常量 ────────────────────────────────────────────────
const MAX_CONTENT_LENGTH = 10000;
const MAX_TITLE_LENGTH = 500;
const MAX_RECALL_RESULTS = 20;
const MAX_LIST_RESULTS = 50;

// ─── P1-1: 向后兼容 tags 解析 ────────────────────────────
// v2.4.6+ 存空格拼接字符串（"v2.2.0 source:hermes"），旧数据仍为 JSON 数组

export function parseTags(tagsStr: string | null): string[] {
  if (!tagsStr) return [];
  // 检测是否为旧 JSON 数组格式
  if (tagsStr.startsWith("[") && tagsStr.endsWith("]")) {
    try { return JSON.parse(tagsStr) as string[]; } catch { /* fall through */ }
  }
  // 新格式：空格分隔
  return tagsStr.split(" ").filter(Boolean);
}

// ─── 类型定义 ────────────────────────────────────────────
export interface MemoryEntry {
  id: string;
  agent_id: string;
  title: string | null;
  content: string;
  scope: "private" | "group" | "collective";
  tags: string | null;  // space-separated (v2.4.6+), legacy JSON array
  source_agent_id: string | null;  // Phase 2 Day 4: 溯源
  source_task_id: string | null;   // Phase 2 Day 4: 溯源
  created_at: number;
  updated_at: number | null;
}

export interface MemoryStats {
  total: number;
  by_agent: Record<string, number>;
  by_scope: Record<string, number>;
  fts_entries: number;
}

// ─── 存储记忆 ────────────────────────────────────────────

/**
 * 存储新记忆
 *
 * @returns
 *   - { ok: true, memory } — 成功
 *   - { ok: false, error } — 失败
 */
export function storeMemory(
  agentId: string,
  content: string,
  options?: {
    title?: string;
    scope?: "private" | "group" | "collective";
    tags?: string[];
    source_agent_id?: string;   // Phase 2 Day 4: 溯源（collective 写入时自动设置）
    source_task_id?: string;    // Phase 2 Day 4: 溯源（关联任务）
  }
): { ok: true; memory: MemoryEntry } | { ok: false; error: string } {
  // 参数校验
  if (!content || content.trim().length === 0) {
    return { ok: false, error: "Memory content cannot be empty" };
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      ok: false,
      error: `Memory content too long (${content.length} > ${MAX_CONTENT_LENGTH} chars)`,
    };
  }

  const title = options?.title?.trim() ?? null;
  if (title && title.length > MAX_TITLE_LENGTH) {
    return {
      ok: false,
      error: `Memory title too long (${title.length} > ${MAX_TITLE_LENGTH} chars)`,
    };
  }

  const scope = options?.scope ?? "private";
  if (!["private", "group", "collective"].includes(scope)) {
    return { ok: false, error: `Invalid scope: ${scope}` };
  }

  const tags = options?.tags ?? null;
  // P1-1: 空格拼接替代 JSON，避免 FTS5 tokenizer 拆分版本号/hash
  // 旧格式: ["v2.2.0","source:hermes"] → 新格式: "v2.2.0 source:hermes"
  const tagsStr = tags ? tags.join(" ") : null;
  const sourceAgentId = options?.source_agent_id ?? null;
  const sourceTaskId = options?.source_task_id ?? null;

  const now = Date.now();
  const id = randomUUID();

  try {
    const ftsTokens = buildFtsTokens(title, content);

    db.prepare(
      `INSERT INTO memories (id, agent_id, title, content, fts_tokens, scope, tags, source_agent_id, source_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, agentId, title, content, ftsTokens, scope, tagsStr, sourceAgentId, sourceTaskId, now, now);

    // 同步写入 FTS5 索引（P1-4/P1-5 修复：携带 memory_id 作精确关联键）
    db.prepare(
      `INSERT INTO memories_fts (title, content, tags, fts_tokens, memory_id) VALUES (?, ?, ?, ?, ?)`
    ).run(title, content, tagsStr, ftsTokens, id);

    const memory: MemoryEntry = {
      id,
      agent_id: agentId,
      title,
      content,
      scope,
      tags: tagsStr,
      source_agent_id: sourceAgentId,
      source_task_id: sourceTaskId,
      created_at: now,
      updated_at: now,
    };

    return { ok: true, memory };
  } catch (err: unknown) {
    return { ok: false, error: `Failed to store memory: ${getErrorMessage(err)}` };
  }
}

// ─── 召回记忆（FTS5 全文搜索） ──────────────────────────

/**
 * 通过全文搜索召回记忆
 *
 * 搜索范围：
 *   - private: 仅本人的记忆
 *   - group: scope=group 或 scope=collective 的记忆
 *   - collective: scope=collective 的记忆
 *
 * @param query 搜索关键词（FTS5 query syntax）
 * @param agentId 查询者 ID（用于 scope 过滤）
 * @param options 可选参数
 * @returns 匹配的记忆列表
 */
export function recallMemory(
  query: string,
  agentId: string,
  options?: {
    limit?: number;
    scope?: "private" | "group" | "collective" | "all";
  }
): MemoryEntry[] {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const limit = Math.min(options?.limit ?? MAX_RECALL_RESULTS, MAX_RECALL_RESULTS);
  const scope = options?.scope ?? "all";

  // 构建 FTS5 查询（N-gram 中文分词）
  const safeQuery = buildSearchQuery(query);

  if (!safeQuery) {
    return [];
  }

  try {
    let sql: string;
    let params: (string | number)[];

    if (scope === "all") {
      // 搜索所有可见的记忆（private 仅限本人 + group + collective）
      // Phase 2 Day 4: 按 agent trust_score 加权排序（高信任排名靠前）
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        JOIN memories_fts fts ON fts.memory_id = m.id
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE memories_fts MATCH ?
        AND (m.agent_id = ? OR m.scope IN ('group', 'collective'))
        ORDER BY source_trust_score DESC, rank
        LIMIT ?
      `;
      params = [safeQuery, agentId, limit];
    } else if (scope === "private") {
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        JOIN memories_fts fts ON fts.memory_id = m.id
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE memories_fts MATCH ?
        AND m.agent_id = ? AND m.scope = 'private'
        ORDER BY source_trust_score DESC, rank
        LIMIT ?
      `;
      params = [safeQuery, agentId, limit];
    } else if (scope === "group") {
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        JOIN memories_fts fts ON fts.memory_id = m.id
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE memories_fts MATCH ?
        AND (m.agent_id = ? OR m.scope IN ('group', 'collective'))
        AND m.scope != 'private'
        ORDER BY source_trust_score DESC, rank
        LIMIT ?
      `;
      params = [safeQuery, agentId, limit];
    } else {
      // collective
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        JOIN memories_fts fts ON fts.memory_id = m.id
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE memories_fts MATCH ?
        AND m.scope = 'collective'
        ORDER BY source_trust_score DESC, rank
        LIMIT ?
      `;
      params = [safeQuery, limit];
    }

    return db.prepare(sql).all(...params) as MemoryEntry[];
  } catch (err: unknown) {
    logError("memory_recallMemory_error", err);
    return [];
  }
}

// ─── 列出记忆 ────────────────────────────────────────────

/**
 * 列出 Agent 的记忆
 */
export function listMemories(
  agentId: string,
  options?: {
    scope?: "private" | "group" | "collective" | "all";
    limit?: number;
    offset?: number;
  }
): MemoryEntry[] {
  const limit = Math.min(options?.limit ?? MAX_LIST_RESULTS, MAX_LIST_RESULTS);
  const offset = options?.offset ?? 0;
  const scope = options?.scope ?? "all";

  try {
    let sql: string;
    let params: (string | number)[];

    if (scope === "all") {
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE m.agent_id = ? OR m.scope IN ('group', 'collective')
        ORDER BY source_trust_score DESC, m.created_at DESC
        LIMIT ? OFFSET ?
      `;
      params = [agentId, limit, offset];
    } else if (scope === "private") {
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE m.agent_id = ? AND m.scope = 'private'
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
      `;
      params = [agentId, limit, offset];
    } else {
      sql = `
        SELECT m.*, COALESCE(a.trust_score, 50) AS source_trust_score
        FROM memories m
        LEFT JOIN agents a ON m.agent_id = a.agent_id
        WHERE (m.agent_id = ? OR m.scope IN ('group', 'collective'))
        AND m.scope = ?
        ORDER BY source_trust_score DESC, m.created_at DESC
        LIMIT ? OFFSET ?
      `;
      params = [agentId, scope, limit, offset];
    }

    return db.prepare(sql).all(...params) as MemoryEntry[];
  } catch (err: unknown) {
    logError("memory_listMemories_error", err);
    return [];
  }
}

// ─── 删除记忆 ────────────────────────────────────────────

/**
 * 删除记忆
 * 仅允许删除自己的记忆，或 admin 删除任何记忆
 */
export function deleteMemory(
  memoryId: string,
  agentId: string,
  role: string
): { ok: true; deleted: boolean } | { ok: false; error: string } {
  try {
    // 查找记忆
    const memory = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(memoryId) as MemoryEntry | undefined;
    if (!memory) {
      return { ok: false, error: `Memory ${memoryId} not found` };
    }

    // 权限检查：只能删除自己的记忆（admin 可以删除任何）
    if (memory.agent_id !== agentId && role !== "admin") {
      return { ok: false, error: "Permission denied: can only delete own memories" };
    }

    // 删除 FTS 索引（P1-4 修复：按 memory_id 精确命中，不再按 title+content 值相等
    // 误删内容相同的其他记忆）
    try {
      db.prepare(
        `DELETE FROM memories_fts WHERE memory_id = ?`
      ).run(memoryId);

      // Phase 5a Day 2: 审计 FTS 索引删除
      auditLog("delete_memory_fts", agentId, memoryId, `title=${memory.title?.slice(0, 50) ?? "null"}`);
    } catch {
      // FTS 删除失败不影响主表删除
    }

    db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);

    // Phase 5a Day 2: 审计记忆主表删除
    auditLog("delete_memory_db", agentId, memoryId, `scope=${memory.scope}, agent=${memory.agent_id}`);

    return { ok: true, deleted: true };
  } catch (err: unknown) {
    return { ok: false, error: `Failed to delete memory: ${getErrorMessage(err)}` };
  }
}

// ─── 记忆统计 ────────────────────────────────────────────

/**
 * 获取记忆统计信息
 * @param caller 调用者上下文（可选）。若传入且非 admin，则裁剪 by_agent 防止泄露他人记忆分布（T5 守卫）。
 *               当前该函数未被任何 MCP 工具暴露（死代码），加守卫以防未来误暴露。
 */
export function getMemoryStats(caller?: { role: string }): MemoryStats {
  try {
    const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get() as CountRow;
    let ftsEntries = 0;
    try {
      const ftsRow = db.prepare(`SELECT COUNT(*) as cnt FROM memories_fts`).get() as CountRow;
      ftsEntries = ftsRow?.cnt ?? 0;
    } catch {
      // FTS 表可能不存在
    }

    const byAgentRows = db.prepare(
      `SELECT agent_id, COUNT(*) as cnt FROM memories GROUP BY agent_id`
    ).all() as { agent_id: string; cnt: number }[];

    const byScopeRows = db.prepare(
      `SELECT scope, COUNT(*) as cnt FROM memories GROUP BY scope`
    ).all() as { scope: string; cnt: number }[];

    const rawByAgent: Record<string, number> = {};
    for (const row of byAgentRows) {
      rawByAgent[row.agent_id] = row.cnt;
    }

    // T5 守卫：非 admin 调用者不暴露他人记忆分布
    const byAgent = caller && caller.role !== "admin" ? {} : rawByAgent;

    const byScope: Record<string, number> = {};
    for (const row of byScopeRows) {
      byScope[row.scope] = row.cnt;
    }

    return {
      total: totalRow?.cnt ?? 0,
      by_agent: byAgent,
      by_scope: byScope,
      fts_entries: ftsEntries,
    };
  } catch (err: unknown) {
    logError("memory_getMemoryStats_error", err);
    return { total: 0, by_agent: {}, by_scope: {}, fts_entries: 0 };
  }
}

// ─── FTS 索引重建 ────────────────────────────────────────

/**
 * 为所有已有 memories 重建 FTS 索引（Phase 2 Migration）
 * 在 server.ts 启动时调用一次
 */
export function rebuildFtsIndex(): void {
  try {
    const memCount = (db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get() as CountRow)?.cnt ?? 0;
    let ftsCount = 0;
    try {
      ftsCount = (db.prepare(`SELECT COUNT(*) as cnt FROM memories_fts`).get() as CountRow)?.cnt ?? 0;
    } catch {
      // FTS 表不存在，跳过
      return;
    }

    if (memCount === 0 || ftsCount >= memCount) {
      return; // 不需要重建
    }

    logger.info("memory_fts_rebuild_start", { module: "memory", mem_count: memCount, fts_count: ftsCount });

    const memories = db.prepare(
      `SELECT id, title, content, tags, source_agent_id, source_task_id FROM memories`
    ).all() as Pick<MemoryRow, "id" | "title" | "content" | "tags" | "source_agent_id" | "source_task_id">[];

    const insertFts = db.prepare(
      `INSERT INTO memories_fts (title, content, tags, fts_tokens, memory_id) VALUES (?, ?, ?, ?, ?)`
    );

    const rebuildBatch = db.transaction((mems: Pick<MemoryRow, "id" | "title" | "content" | "tags" | "source_agent_id" | "source_task_id">[]) => {
      for (const m of mems) {
        const tokens = buildFtsTokens(m.title ?? null, m.content);
        insertFts.run(m.title, m.content, m.tags ?? null, tokens, m.id);
      }
    });

    rebuildBatch(memories);
    logger.info("memory_fts_rebuild_done", { module: "memory", entries: memories.length });
  } catch (err: unknown) {
    logError("memory_rebuildFtsIndex_error", err);
  }
}
