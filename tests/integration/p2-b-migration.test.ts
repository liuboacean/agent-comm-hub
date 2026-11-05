/**
 * p2-b-migration.test.ts — P1 老库 → P2-B 表结构迁移专项
 *
 * 这次改了 subscriptions 的表级唯一约束（三列 → 四列），是唯一会动生产老库结构的点。
 * 必须在【独立进程】里加载真实编译产物 dist/src/db.js 验证迁移，不能靠 mock：
 *   1) 先造一张 P1 时代的老表（无 condition_json、三列唯一约束）+ 2 条旧规则；
 *   2) 子进程以 NODE_ENV=test + DB_PATH=老库 加载 db.js，触发 DDL + 幂等重建；
 *   3) 断言列已加、旧数据无损（condition_json='' = 仅 L1）、新唯一约束允许
 *      同 L1 不同 L2 的规则并存。
 *
 * CI 与本地流程均先 `npm run build`，dist 存在；未 build 时跳过（避免误判）。
 */
import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const DIST_DB = fileURLToPath(new URL("../../dist/src/db.js", import.meta.url));
const LEGACY_FILE = path.join(os.tmpdir(), `hub-p2b-legacy-${process.pid}-${Date.now()}.db`);

afterAll(() => {
  for (const f of [LEGACY_FILE, `${LEGACY_FILE}-wal`, `${LEGACY_FILE}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

describe("P2-B 老库迁移（幂等重建 subscriptions）", () => {
  it.skipIf(!fs.existsSync(DIST_DB))("旧订阅无损保留 + 新四列唯一约束生效", () => {
    // 1. 构造 P1 时代老表
    const legacy = new Database(LEGACY_FILE);
    legacy.exec(`
      CREATE TABLE subscriptions (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL,
        event_type   TEXT NOT NULL DEFAULT '*',
        topic_filter TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        UNIQUE(agent_id, event_type, topic_filter)
      );
      CREATE INDEX idx_subscriptions_agent ON subscriptions(agent_id);
      INSERT INTO subscriptions VALUES ('r1','agent-X','message','',100);
      INSERT INTO subscriptions VALUES ('r2','agent-Y','task_assigned','URGENT',200);
    `);
    legacy.close();

    // 2. 独立进程加载真实编译产物，触发迁移
    const script = `
import { db } from ${JSON.stringify(pathToFileURL(DIST_DB).href)};
const cols = db.pragma("table_info(subscriptions)").map(c => c.name);
const rows = db.prepare("SELECT agent_id,event_type,topic_filter,condition_json FROM subscriptions ORDER BY agent_id, topic_filter").all();
const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='subscriptions'").get();
const ins = db.prepare("INSERT OR IGNORE INTO subscriptions (id,agent_id,event_type,topic_filter,condition_json,created_at) VALUES (?,?,?,?,?,?)");
ins.run('n1','agent-X','message','','[{"path":"a","op":"exists"}]',300);
ins.run('n2','agent-X','message','','[{"path":"b","op":"exists"}]',400);
const count = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE agent_id='agent-X'").get();
console.log("RESULT:" + JSON.stringify({ cols, rows, ddl: ddl.sql, count: count.c }));
`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      timeout: 20_000,
      env: { ...process.env, NODE_ENV: "test", DB_PATH: LEGACY_FILE, HUB_EVENT_DRIVEN: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
    expect(line, "迁移子进程应输出 RESULT 行").toBeTruthy();
    const r = JSON.parse(line!.slice("RESULT:".length));

    // 3. 断言
    expect(r.cols).toContain("condition_json");
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((x: any) => x.condition_json === "")).toBe(true); // 旧规则语义不变
    expect(r.rows.find((x: any) => x.agent_id === "agent-Y").topic_filter).toBe("URGENT");
    expect(r.rows.find((x: any) => x.agent_id === "agent-X").event_type).toBe("message");
    expect(String(r.ddl).replace(/\s+/g, " "))
      .toContain("UNIQUE(agent_id, event_type, topic_filter, condition_json)");
    expect(r.count).toBe(3); // r1 + n1 + n2：同 L1 不同 L2 不再互相覆盖

    // 4. 二次加载（幂等）：不应重复重建、不应丢数据
    const out2 = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      timeout: 20_000,
      env: { ...process.env, NODE_ENV: "test", DB_PATH: LEGACY_FILE, HUB_EVENT_DRIVEN: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line2 = out2.split("\n").find((l) => l.startsWith("RESULT:"));
    const r2 = JSON.parse(line2!.slice("RESULT:".length));
    expect(r2.cols).toContain("condition_json");
    // 二次加载不再重建：首次写入的 n1/n2 仍在，两条旧规则（condition_json=''）也仍在
    expect(r2.rows).toHaveLength(4);
    expect(r2.rows.filter((x: any) => x.condition_json === "")).toHaveLength(2);
  });
});
