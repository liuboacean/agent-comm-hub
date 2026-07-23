/**
 * fts-memory-key.test.ts — P1-4 / P1-5 回归测试
 *
 * 验证 FTS5 索引改用 `memory_id UNINDEXED` 精确关联键后：
 *   1. 两条「内容完全相同」的记忆互相独立，召回不串台（返回 2 条，而非 1 条）。
 *   2. 按 memory_id 删除只删掉目标记忆的索引，不误删内容相同的另一条。
 *   3. 旧结构（无 memory_id）迁移到新结构后，关联依然精确。
 *
 * 该测试直接用 better-sqlite3 在内存库还原真实 DDL，不依赖 src 模块单例，
 * 与 db.ts / memory.ts 的实际 SQL 语义保持一致。
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";

function createFtsTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memories (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      title      TEXT,
      content    TEXT NOT NULL,
      fts_tokens TEXT NOT NULL DEFAULT '',
      scope      TEXT NOT NULL DEFAULT 'private',
      tags       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      title, content, tags, fts_tokens, memory_id UNINDEXED
    );
  `);
  return db;
}

/** 写入一条记忆 + 同步 FTS 索引（与 memory.ts storeMemory 同构） */
function store(db: Database.Database, id: string, agentId: string, content: string, title = "dup", scope = "private") {
  db.prepare(
    `INSERT INTO memories (id, agent_id, title, content, fts_tokens, scope, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(id, agentId, title, content, content, scope, Date.now());
  db.prepare(
    `INSERT INTO memories_fts (title, content, tags, fts_tokens, memory_id) VALUES (?, ?, ?, ?, ?)`
  ).run(title, content, null, content, id);
}

/** 召回（与 memory.ts recallMemory scope='all' 同构） */
function recall(db: Database.Database, query: string, agentId: string): any[] {
  return db.prepare(`
    SELECT m.* FROM memories m
    JOIN memories_fts fts ON fts.memory_id = m.id
    WHERE memories_fts MATCH ?
    AND (m.agent_id = ? OR m.scope IN ('group', 'collective'))
  `).all(query, agentId) as any[];
}

describe("FTS memory_id keying (P1-4 / P1-5)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFtsTestDb();
  });

  it("两条内容完全相同且均可见的记忆召回应返回 2 条（不串台/不折叠）", () => {
    // 两条 collective 记忆内容完全相同、属于不同 agent，对 agent_1 均可见
    store(db, "mem_a", "agent_1", "error handling retry logic", "dup", "collective");
    store(db, "mem_b", "agent_2", "error handling retry logic", "dup", "collective");

    const hits = recall(db, "error", "agent_1");
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(["mem_a", "mem_b"]); // 两条都命中，而非被折叠成 1 条
  });

  it("内容相同的 private 记忆不会越权串台（只返回本人那条）", () => {
    // P1-4 修复前：JOIN 按 content 相等，会误把 mem_b（agent_2 私有）也带回给 agent_1
    store(db, "mem_a", "agent_1", "error handling retry logic", "dup", "private");
    store(db, "mem_b", "agent_2", "error handling retry logic", "dup", "private");

    const hits = recall(db, "error", "agent_1");
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(["mem_a"]); // 仅本人私有记忆，mem_b 不串台
  });

  it("按 memory_id 删除只删目标索引，不误删内容相同的另一条", () => {
    store(db, "mem_x", "agent_1", "shared identical content");
    store(db, "mem_y", "agent_2", "shared identical content");

    // 仅删除 mem_x 的 FTS 索引（deleteMemory 的精确命中写法）
    db.prepare(`DELETE FROM memories_fts WHERE memory_id = ?`).run("mem_x");
    db.prepare(`DELETE FROM memories WHERE id = ?`).run("mem_x");

    // mem_y 仍可召回
    const remaining = recall(db, "shared", "agent_2");
    expect(remaining.map((r) => r.id)).toEqual(["mem_y"]);

    // mem_x 已彻底消失
    const gone = db.prepare(`SELECT COUNT(*) AS cnt FROM memories WHERE id='mem_x'`).get() as any;
    expect(gone.cnt).toBe(0);
    const ftsGone = db.prepare(`SELECT COUNT(*) AS cnt FROM memories_fts WHERE memory_id='mem_x'`).get() as any;
    expect(ftsGone.cnt).toBe(0);
  });

  it("旧结构（无 memory_id）迁移到新结构后，召回精确不串台", () => {
    // 1) 旧结构：独立 FTS（无 memory_id 列）
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT, content TEXT NOT NULL);
      CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, fts_tokens);
    `);
    legacy.prepare(`INSERT INTO memories (id, agent_id, title, content) VALUES (?,?,?,?)`)
      .run("old_1", "agent_1", "dup", "duplicate content here");
    legacy.prepare(`INSERT INTO memories (id, agent_id, title, content) VALUES (?,?,?,?)`)
      .run("old_2", "agent_2", "dup", "duplicate content here");
    legacy.prepare(`INSERT INTO memories_fts (title, content, tags, fts_tokens) VALUES (?,?,?,?)`)
      .run("dup", "duplicate content here", null, "duplicate content here");

    // 2) 检测旧结构并迁移到新结构（与 db.ts 启动迁移同构）
    const info = legacy.prepare(`PRAGMA table_info(memories_fts)`).all() as Array<{ name: string }>;
    const hasMemoryId = info.some((c) => c.name === "memory_id");
    expect(hasMemoryId).toBe(false); // 确认确实是旧结构

    const rows = legacy.prepare(`SELECT id, title, content FROM memories`).all() as any[];
    legacy.exec(`DROP TABLE IF EXISTS memories_fts`);
    legacy.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, fts_tokens, memory_id UNINDEXED)`);
    const ins = legacy.prepare(`INSERT INTO memories_fts (title, content, tags, fts_tokens, memory_id) VALUES (?,?,?,?,?)`);
    const migrate = legacy.transaction(() => {
      for (const r of rows) ins.run(r.title, r.content, null, r.content, r.id);
    });
    migrate();

    // 3) 迁移后用精确 JOIN 召回
    const hits = legacy.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON fts.memory_id = m.id
      WHERE memories_fts MATCH 'duplicate'
    `).all() as any[];
    expect(hits.map((h) => h.id).sort()).toEqual(["old_1", "old_2"]);
    legacy.close();
  });
});
