/**
 * db.test.ts — 独立回归测试：验证「寇豆码」的 db.ts Bug 修复
 *
 * 背景（Hermes 观察的 3 个异常）：
 *   ① get_db_stats 报 `require is not defined`
 *   ② 记忆库空
 *   ③ 进化引擎归零
 *
 * 工程师声称的修复（需本测试独立验证，不轻信）：
 *   根因 A：getDbSize() / getEnhancedDbStats() 在 ESM 模块里误用 require("fs")，
 *           已改为模块顶部 `import * as fs from "fs"`。
 *   根因 B：resolveDbPath() 重写——若解析出的库为空、而其它候选有数据，
 *           自动回退到「有数据的库」，避免记忆/进化归零的假象。
 *           测试环境（VITEST / NODE_ENV=test）严格使用显式 DB_PATH。
 *
 * 本测试覆盖：
 *   - 用例 1（根因 A）：在 ESM 运行环境下调用 getEnhancedDbStats() 不得抛
 *     `ReferenceError: require is not defined`。
 *   - 用例 2（根因 B）：resolveDbPath 在「DB_PATH 指向空库 + HUB_ROOT 指向有数据的库」
 *     时，连接到「有数据的库」而非空库。
 *
 * 隔离原则：所有用例均使用临时 DB_PATH / 临时目录，绝不连接仓库根的真实
 * comm_hub.db（274 记忆 / 67 策略），也不污染仓库数据。用例 2 的「有数据的库」
 * 由 db.ts 自身建表后插入数据生成，保证 Schema 与源码一致。
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// db.ts 源码路径（vitest 会按需 transform TS）
const DB_TS = "../../src/db.ts";

// ─── 临时目录管理 ──────────────────────────────────────────
const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-dbtest-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// 创建一个「空」SQLite 文件（仅打开后关闭）
function createEmptyDb(p: string): void {
  const d = new Database(p);
  d.close();
}

describe("db.ts 回归 — 根因 A：ESM 下 getEnhancedDbStats 不得抛 require is not defined", () => {
  it("在 VITEST（ESM）环境中调用 getEnhancedDbStats() 不抛错且返回结构化统计", async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "test_db_a.db");
    createEmptyDb(dbPath);

    const prevDbPath = process.env.DB_PATH;
    // VITEST=true 时 resolveDbPath 严格使用显式 DB_PATH，保证隔离
    process.env.DB_PATH = dbPath;

    try {
      vi.resetModules();
      const mod = await import(`${DB_TS}?a=${Date.now()}`);
      // 关键断言：若修复不完整（仍误用 require("fs")），此处会抛
      // ReferenceError: require is not defined
      expect(() => mod.getEnhancedDbStats()).not.toThrow();

      const stats = mod.getEnhancedDbStats();
      expect(stats).toHaveProperty("table_counts");
      expect(stats).toHaveProperty("database_size_bytes");
      expect(typeof stats.database_size_bytes).toBe("number");
      expect(typeof stats.database_size_mb).toBe("number");
      // 临时空库场景下，memories 表存在但为空（计数为 0）
      expect(stats.table_counts.memories).toBe(0);

      // 顺带验证 getDbSize() 同样不抛 require 错误
      expect(() => mod.getDbSize()).not.toThrow();
      expect(mod.getDbSize()).toBeGreaterThan(0);

      try {
        mod.db.close();
      } catch {
        /* ignore */
      }
    } finally {
      // 必须显式 delete，不可赋值为 undefined：
      // Node 中 `process.env.X = undefined` 会被隐式 coerce 成字符串 "undefined"，
      // 污染后续同 worker 内的测试（它们 import db.ts 时会以 "undefined" 为名创建游离文件）。
      if (prevDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = prevDbPath;
      }
      vi.resetModules();
    }
  });
});

describe("db.ts 回归 — 根因 B：resolveDbPath 空库回退到有数据的库", () => {
  it("DB_PATH 指向空库、HUB_ROOT 指向有数据的库时，连接的是有数据的库", async () => {
    const base = makeTmpDir();
    const emptyDbPath = path.join(base, "empty.db");
    const hubRoot = path.join(base, "hubroot");
    fs.mkdirSync(hubRoot);
    const populatedDbPath = path.join(hubRoot, "comm_hub.db");

    createEmptyDb(emptyDbPath);

    // ── 阶段 1：用 db.ts 自身建立「有数据的库」（Schema 与源码一致）──
    const saved1 = snapshotEnv();
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
    process.env.DB_PATH = populatedDbPath;
    delete process.env.HUB_ROOT;
    let phase1Mod: any;
    const N = 5;
    try {
      vi.resetModules();
      phase1Mod = await import(`${DB_TS}?p1=${Date.now()}`);
      const ins = phase1Mod.db.prepare(
        "INSERT INTO memories (id, agent_id, content, created_at) VALUES (?, ?, ?, ?)"
      );
      for (let i = 0; i < N; i++) {
        ins.run(`m${i}`, "agent_x", `content-${i}`, Date.now());
      }
    } finally {
      restoreEnv(saved1);
      try {
        phase1Mod?.db.close();
      } catch {
        /* ignore */
      }
      vi.resetModules();
    }

    // 校验阶段 1 确实生成了「有数据」的库
    const populatedSize = fs.statSync(populatedDbPath).size;
    expect(populatedSize).toBeGreaterThan(0);

    // ── 阶段 2：验证 resolveDbPath 空库回退 ──
    // 关闭 VITEST 守卫，让 resolveDbPath 走「空库回退」分支。
    // （VITEST=true 时该分支被禁用，严格使用 DB_PATH，无法验证回退逻辑。）
    const saved2 = snapshotEnv();
    process.env.VITEST = "false";
    process.env.NODE_ENV = "production";
    process.env.DB_PATH = emptyDbPath; // 候选 1：空库
    process.env.HUB_ROOT = hubRoot; // 候选 3：有数据的库
    delete process.env.HOME;
    const oldCwd = process.cwd();
    process.chdir(base); // cwd/comm_hub.db 不存在，排除干扰候选

    try {
      vi.resetModules();
      const mod = await import(`${DB_TS}?p2=${Date.now()}`);
      const stats = mod.getEnhancedDbStats();

      // 关键断言 1：连接的是「有数据的库」（文件大小等于有数据的库），
      // 而非空库（空库大小为 0）。
      expect(stats.database_size_bytes).toBe(populatedSize);

      // 关键断言 2：能读到数据，证明未误用空库（记忆库未归零）。
      expect(stats.table_counts.memories).toBe(N);

      try {
        mod.db.close();
      } catch {
        /* ignore */
      }
    } finally {
      restoreEnv(saved2);
      process.chdir(oldCwd);
      vi.resetModules();
    }
  });
});

describe("db.ts 回归 — 防御 DB_PATH 字面量 'undefined'", () => {
  it("DB_PATH 被误设为字符串 'undefined' 时，不创建名为 'undefined' 的游离文件", async () => {
    // 模拟 Node 中 `process.env.X = undefined` 被隐式 coerce 成字符串 "undefined" 的场景。
    // 这是本次 Bug 的根因：此前 resolveDbPath 直接返回 "undefined"，
    // better-sqlite3 把它当相对路径文件名，在仓库根创建 `undefined` / `undefined-shm` / `undefined-wal`。
    const saved = snapshotEnv();
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
    process.env.DB_PATH = "undefined";
    const cwd = process.cwd();
    try {
      vi.resetModules();
      const mod = await import(`${DB_TS}?undefguard=${Date.now()}`);
      // 关键断言：resolveDbPath 必须拒绝字面量 "undefined"，回退到有效路径，
      // 不得在 cwd 创建游离文件。
      expect(fs.existsSync(path.join(cwd, "undefined"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "undefined-shm"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "undefined-wal"))).toBe(false);
      // 兜底：即使回退到有效库也能正常取统计（不抛错）。
      expect(() => mod.getEnhancedDbStats()).not.toThrow();
      try {
        mod.db.close();
      } catch {
        /* ignore */
      }
    } finally {
      restoreEnv(saved);
      vi.resetModules();
    }
  });
});

// ─── 环境变量快照 / 还原 ────────────────────────────────────
type EnvSnapshot = Record<string, string | undefined>;
function snapshotEnv(): EnvSnapshot {
  return {
    VITEST: process.env.VITEST,
    NODE_ENV: process.env.NODE_ENV,
    DB_PATH: process.env.DB_PATH,
    HUB_ROOT: process.env.HUB_ROOT,
    HOME: process.env.HOME,
  };
}
function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
