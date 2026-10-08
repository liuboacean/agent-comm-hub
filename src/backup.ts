/**
 * backup.ts — 数据库备份模块
 *
 * 定时将 Hub DB 文件拷贝到备份目录，保留最近 N 份备份。
 * 可查询备份状态（上次备份时间、备份数量、总大小）。
 *
 * 目录约定（本模块与外部 hub-backup.sh 各写各的子目录，两套保留策略互不干扰）：
 *   ~/agent-comm-hub/backups/hourly/  ← 本模块写（宿主 .db 及其 -wal / -shm 三件）
 *   ~/agent-comm-hub/backups/remote/  ← hub-backup.sh 写（.db.gz 远程推送副本）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { logger } from "./logger.js";
import { db } from "./db.js";

// ─── 配置 ────────────────────────────────────────────────
// 备份目录固定到用户主目录下的稳定路径（与 launchd 备份脚本一致），
// 不再依赖 process.cwd()（易失 workspace 被清则备份丢失）。
// 可用 BACKUP_DIR 环境变量覆盖。
const BACKUP_DIR = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(homedir(), "agent-comm-hub", "backups", "hourly");
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL ?? "3600000", 10); // 默认 1 小时
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS ?? "24", 10);              // 保留最近 24 份

// 一次备份 = 一个「宿主」文件 comm_hub_<ts>.db 及其伴随文件 -wal / -shm。
// 保留与清理一律以宿主为键「成套」进行：
//   只按 .db 计数 ⇒ 宿主被裁掉、sidecar 却无限堆积（历史积压 1797 个 -wal / 1797 个 -shm）；
//   只按文件计数 ⇒ 可能拆散一次完整备份（wal_checkpoint(TRUNCATE) 失败时 -wal 非零，
//   它是恢复该次备份所必需的组成部分，不能单独丢弃）。
const HOST_RE = /^comm_hub_(\d{8}_\d{6})\.db$/;
const ARTIFACT_RE = /^comm_hub_(\d{8}_\d{6})\.db(-wal|-shm)?$/;

/** 删除排序键：宿主（.db）排在前，sidecar 在后，避免出现「宿主仍在、sidecar 先缺」的中间态 */
function rankHostFirst(name: string): number {
  return name.endsWith(".db") ? 0 : 1;
}

let backupTimer: ReturnType<typeof setInterval> | null = null;
let lastBackupTime: number | null = null;
let backupCount = 0;

/**
 * 启动定时备份
 * @param dbPath SQLite DB 文件路径
 */
export function startBackupScheduler(dbPath: string): void {
  if (backupTimer) {
    clearInterval(backupTimer);
  }

  // 确保备份目录存在
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
  }

  logger.info("BackupScheduler started", {
    module: "backup",
    interval_ms: BACKUP_INTERVAL,
    db_path: dbPath,
    backup_dir: BACKUP_DIR,
    max_backups: MAX_BACKUPS,
  });

  // 立即执行一次
  doBackup(dbPath);

  backupTimer = setInterval(() => doBackup(dbPath), BACKUP_INTERVAL);
}

/**
 * 执行一次备份
 */
function doBackup(dbPath: string): void {
  try {
    if (!existsSync(dbPath)) {
      logger.warn("Backup skipped: DB file not found", { module: "backup", dbPath });
      return;
    }

    const now = new Date();
    const filename = `comm_hub_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}.db`;
    const destPath = join(BACKUP_DIR, filename);

    // D5 修复：WAL 模式下主库文件可能尚未包含最近提交，先执行检查点刷盘，
    // 再连同 -wal / -shm 伴随文件一起拷贝，避免备份不一致 / 丢失最近数据。
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      logger.warn("Backup wal_checkpoint failed", {
        module: "backup",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    copyFileSync(dbPath, destPath);
    for (const ext of ["-wal", "-shm"]) {
      const src = dbPath + ext;
      if (existsSync(src)) {
        try {
          copyFileSync(src, destPath + ext);
        } catch (err) {
          logger.warn("Backup companion copy failed", {
            module: "backup",
            ext,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    lastBackupTime = Date.now();
    backupCount++;

    logger.info("Backup completed", {
      module: "backup",
      filename,
      size_bytes: statSync(destPath).size,
      backup_count: backupCount,
    });

    // 清理旧备份
    cleanupOldBackups();
  } catch (err: unknown) {
    logger.error("Backup failed", {
      module: "backup",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 清理超出保留数量的旧备份
 *
 * 以宿主为键成套清理：枚举 comm_hub_<ts>.db，按 mtime 新→旧保留最近 MAX_BACKUPS 个 ts，
 * 然后删除所有宿主 ts 不在保留集合内的本模块产物（.db / .db-wal / .db-shm）。
 * 这样同时覆盖两类残留：① 超期宿主及其 sidecar；② 宿主已消失的孤儿 sidecar。
 */
function cleanupOldBackups(): void {
  try {
    if (!existsSync(BACKUP_DIR)) return;

    const entries = readdirSync(BACKUP_DIR);

    // 1) 枚举宿主并排序，得出保留集合
    const hosts: Array<{ ts: string; mtime: number }> = [];
    for (const name of entries) {
      const m = HOST_RE.exec(name);
      if (!m) continue;
      try {
        hosts.push({ ts: m[1], mtime: statSync(join(BACKUP_DIR, name)).mtimeMs });
      } catch {
        // 并发删除等竞态：跳过该项，不影响其余清理
      }
    }
    hosts.sort((a, b) => b.mtime - a.mtime); // 最新在前
    const keepTs = new Set(hosts.slice(0, MAX_BACKUPS).map(h => h.ts));

    // 2) 凡宿主 ts 不在保留集合内的备份件，一律成套删除
    const doomed = entries
      .filter(name => {
        const m = ARTIFACT_RE.exec(name);
        return m !== null && !keepTs.has(m[1]);
      })
      .sort((a, b) => {
        const ra = rankHostFirst(a);
        const rb = rankHostFirst(b);
        if (ra !== rb) return ra - rb;
        return a < b ? -1 : a > b ? 1 : 0;
      });

    for (const name of doomed) {
      try {
        unlinkSync(join(BACKUP_DIR, name));
        logger.info("Backup pruned", { module: "backup", filename: name });
      } catch (err: unknown) {
        logger.warn("Backup prune failed", {
          module: "backup",
          filename: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err: unknown) {
    logger.error("Backup cleanup failed", {
      module: "backup",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 获取备份状态
 *
 * 大小与件数均按「成套」统计（.db + .db-wal + .db-shm），
 * 因为 sidecar 是备份的组成部分，只统计 .db 会低报磁盘占用。
 */
export function getBackupStatus(): {
  enabled: boolean;
  last_backup: number | null;
  backup_count: number;
  backup_dir: string;
  total_size_bytes: number;
  total_size_mb: string;
  host_count: number;
  interval_ms: number;
  max_backups: number;
} {
  let totalSize = 0;
  let hostCount = 0;
  try {
    if (existsSync(BACKUP_DIR)) {
      for (const name of readdirSync(BACKUP_DIR)) {
        if (!ARTIFACT_RE.test(name)) continue;
        totalSize += statSync(join(BACKUP_DIR, name)).size;
        if (HOST_RE.test(name)) hostCount++;
      }
    }
  } catch { /* ignore */ }

  return {
    enabled: backupTimer !== null,
    last_backup: lastBackupTime,
    backup_count: backupCount,
    backup_dir: BACKUP_DIR,
    total_size_bytes: totalSize,
    total_size_mb: (totalSize / 1024 / 1024).toFixed(2),
    host_count: hostCount,
    interval_ms: BACKUP_INTERVAL,
    max_backups: MAX_BACKUPS,
  };
}

/**
 * 停止备份调度器
 */
export function stopBackupScheduler(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    logger.info("BackupScheduler stopped", { module: "backup" });
  }
}
