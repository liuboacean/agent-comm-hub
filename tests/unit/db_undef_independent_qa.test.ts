/**
 * db_undef_independent_qa.test.ts — QA 独立回归验证（不与工程师用例混用）
 *
 * 目的：独立验证「寇豆码」对 DB_PATH 字面量 "undefined" 防御的修复真实有效，
 * 不依赖工程师自写的 db.test.ts。
 *
 * 验证点：
 *   1. 当 process.env.DB_PATH 被误设为字符串 "undefined"（模拟 Node 把
 *      `process.env.X = undefined` 隐式 coerce 成 "undefined" 的场景）时，
 *      db.ts 模块加载过程中 resolveDbPath() 不得返回字面量 "undefined"。
 *   2. 不得在 cwd 生成游离文件 undefined / undefined-shm / undefined-wal。
 *   3. 实际连接的是某个真实存在、命名合法的数据库文件。
 *
 * 隔离：全程在临时目录内 chdir，finally 恢复原 cwd / 原 env，不污染仓库根。
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DB_TS = "../../src/db.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-qa-undef-"));
afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("QA 独立验证 — DB_PATH='undefined' 字面量防御", () => {
  it("env 泄漏为字符串 'undefined' 时，resolveDbPath 回退有效路径且不在 cwd 创建 undefined 游离文件", async () => {
    const oldCwd = process.cwd();
    process.chdir(tmpDir);

    const saved: Record<string, string | undefined> = {
      VITEST: process.env.VITEST,
      NODE_ENV: process.env.NODE_ENV,
      DB_PATH: process.env.DB_PATH,
    };
    process.env.VITEST = "true";
    process.env.NODE_ENV = "test";
    process.env.DB_PATH = "undefined"; // 模拟 Node 的 undefined→"undefined" coerce 泄漏

    try {
      vi.resetModules();
      const mod = await import(`${DB_TS}?qa-undef=${Date.now()}`);

      // 断言 1：实际使用的库文件名是字符串且不是字面量 "undefined"
      expect(typeof mod.db.name).toBe("string");
      expect(mod.db.name).not.toBe("undefined");
      expect(mod.db.name).not.toBe(path.resolve(tmpDir, "undefined"));

      // 断言 2：临时 cwd 下不存在 undefined 游离文件（核心卫生断言）
      expect(fs.existsSync(path.join(tmpDir, "undefined"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "undefined-shm"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "undefined-wal"))).toBe(false);

      // 断言 3：回退到的库文件真实存在（证明走了有效候选，而非 "undefined"）
      expect(fs.existsSync(mod.db.name)).toBe(true);

      // 兜底：统计接口不抛错
      expect(() => mod.getEnhancedDbStats()).not.toThrow();
      try {
        mod.db.close();
      } catch {
        /* ignore */
      }
    } finally {
      process.chdir(oldCwd);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      vi.resetModules();
    }
  });
});
