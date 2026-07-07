/**
 * tests/fixtures/db.ts — 共享内存 SQLite 测试数据库工厂
 *
 * 用法：
 *   import { createTestDb } from "../fixtures/db.js";
 *   const db = createTestDb();
 *   db.prepare("SELECT ...").all();
 */
import Database from "better-sqlite3";

export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id      TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      api_token     TEXT,
      status        TEXT NOT NULL DEFAULT 'offline',
      trust_score   INTEGER NOT NULL DEFAULT 50,
      last_heartbeat INTEGER,
      managed_group_id TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_id      TEXT PRIMARY KEY,
      token_type    TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      token_hash    TEXT,
      expires_at    INTEGER,
      created_at    INTEGER NOT NULL,
      created_by    TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id    TEXT PRIMARY KEY,
      from_agent    TEXT NOT NULL,
      to_agent      TEXT NOT NULL,
      content       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      priority      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      memory_id     TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT 'private',
      content       TEXT NOT NULL,
      tags          TEXT,
      source_confidence REAL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS tasks (
      task_id       TEXT PRIMARY KEY,
      pipeline_id   TEXT,
      agent_id      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipelines (
      pipeline_id   TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'draft',
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      strategy_id   TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'proposed',
      proposed_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      action        TEXT NOT NULL,
      agent_id      TEXT,
      target        TEXT,
      details       TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      invite_id     TEXT PRIMARY KEY,
      role          TEXT NOT NULL DEFAULT 'member',
      expires_at    INTEGER,
      created_at    INTEGER NOT NULL,
      created_by    TEXT
    );
  `);

  return db;
}

/**
 * 创建一个含基础测试数据的 DB（方便集成测试）
 */
export function createSeededTestDb(): Database.Database {
  const db = createTestDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`INSERT INTO agents (agent_id, name, role, status, trust_score, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "test-agent-1", "TestAgent1", "admin", "online", 80, now
  );
  db.prepare(`INSERT INTO agents (agent_id, name, role, status, trust_score, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "test-agent-2", "TestAgent2", "member", "offline", 50, now
  );
  db.prepare(`INSERT INTO messages (message_id, from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "msg-1", "test-agent-1", "test-agent-2", "hello", "delivered", now
  );

  return db;
}
