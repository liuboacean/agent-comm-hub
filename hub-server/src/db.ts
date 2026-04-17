/**
 * db.ts — SQLite 持久化层
 * 消息 + 任务 两张表，进程重启数据不丢失
 */
import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, "../comm_hub.db");

export const db: DatabaseType = new Database(DB_PATH);

// 开启 WAL 模式，提升并发读写性能
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ─── 建表 ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    from_agent  TEXT NOT NULL,
    to_agent    TEXT NOT NULL,
    content     TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'message',
    metadata    TEXT,
    status      TEXT NOT NULL DEFAULT 'unread',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    assigned_by  TEXT NOT NULL,
    assigned_to  TEXT NOT NULL,
    description  TEXT NOT NULL,
    context      TEXT,
    priority     TEXT NOT NULL DEFAULT 'normal',
    status       TEXT NOT NULL DEFAULT 'pending',
    result       TEXT,
    progress     INTEGER DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_to_agent  ON messages(to_agent, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to  ON tasks(assigned_to, status);
`);

// ─── Message 操作 ──────────────────────────────────────
export interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  type: "message" | "task_assign" | "task_update" | "ack";
  metadata?: string | null;
  status: "unread" | "delivered" | "read";
  created_at: number;
}

export const msgStmt: Record<string, Statement> = {
  insert: db.prepare<Message>(
    `INSERT INTO messages VALUES (@id,@from_agent,@to_agent,@content,@type,@metadata,@status,@created_at)`
  ),
  markDelivered: db.prepare(
    `UPDATE messages SET status='delivered' WHERE id=?`
  ),
  pendingFor: db.prepare<string>(
    `SELECT * FROM messages WHERE to_agent=? AND status='unread' ORDER BY created_at ASC`
  ),
  markAllDelivered: db.prepare(
    `UPDATE messages SET status='delivered' WHERE to_agent=? AND status='unread'`
  ),
};

// ─── Task 操作 ─────────────────────────────────────────
export interface Task {
  id: string;
  assigned_by: string;
  assigned_to: string;
  description: string;
  context?: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "pending" | "in_progress" | "completed" | "failed";
  result?: string | null;
  progress: number;
  created_at: number;
  updated_at: number;
}

export const taskStmt: Record<string, Statement> = {
  insert: db.prepare<Task>(
    `INSERT INTO tasks VALUES (@id,@assigned_by,@assigned_to,@description,@context,@priority,@status,@result,@progress,@created_at,@updated_at)`
  ),
  getById: db.prepare<string>(
    `SELECT * FROM tasks WHERE id=?`
  ),
  update: db.prepare(
    `UPDATE tasks SET status=?,result=?,progress=?,updated_at=? WHERE id=?`
  ),
  listFor: db.prepare<[string, string]>(
    `SELECT * FROM tasks WHERE assigned_to=? AND status=? ORDER BY created_at DESC`
  ),
};
