/**
 * backup.ts — 数据库备份模块
 *
 * 定时将 Hub DB 文件拷贝到备份目录，保留最近 N 份备份。
 * 可查询备份状态（上次备份时间、备份数量、总大小）。
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
    : resolve(homedir(), "agent-comm-hub", "backups");
const BACKUP_INTERVAL = parseInt(process.env.BACKUP_INTERVAL ?? "3600000", 10); // 默认 1 小时
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS ?? "24", 10); // 保留最近 24 份
let backupTimer = null;
let lastBackupTime = null;
let backupCount = 0;
/**
 * 启动定时备份
 * @param dbPath SQLite DB 文件路径
 */
export function startBackupScheduler(dbPath) {
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
function doBackup(dbPath) {
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
        }
        catch (err) {
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
                }
                catch (err) {
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
    }
    catch (err) {
        logger.error("Backup failed", {
            module: "backup",
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
/**
 * 清理超出保留数量的旧备份
 */
function cleanupOldBackups() {
    try {
        if (!existsSync(BACKUP_DIR))
            return;
        const files = readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith("comm_hub_") && f.endsWith(".db"))
            .map(f => ({ name: f, path: join(BACKUP_DIR, f), mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime); // 最新在前
        if (files.length <= MAX_BACKUPS)
            return;
        const toDelete = files.slice(MAX_BACKUPS);
        for (const f of toDelete) {
            unlinkSync(f.path);
            logger.info("Backup pruned", { module: "backup", filename: f.name });
        }
    }
    catch (err) {
        logger.error("Backup cleanup failed", {
            module: "backup",
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
/**
 * 获取备份状态
 */
export function getBackupStatus() {
    let totalSize = 0;
    try {
        if (existsSync(BACKUP_DIR)) {
            const files = readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith("comm_hub_") && f.endsWith(".db"));
            for (const f of files) {
                totalSize += statSync(join(BACKUP_DIR, f)).size;
            }
        }
    }
    catch { /* ignore */ }
    return {
        enabled: backupTimer !== null,
        last_backup: lastBackupTime,
        backup_count: backupCount,
        backup_dir: BACKUP_DIR,
        total_size_bytes: totalSize,
        total_size_mb: (totalSize / 1024 / 1024).toFixed(2),
        interval_ms: BACKUP_INTERVAL,
        max_backups: MAX_BACKUPS,
    };
}
/**
 * 停止备份调度器
 */
export function stopBackupScheduler() {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
        logger.info("BackupScheduler stopped", { module: "backup" });
    }
}
//# sourceMappingURL=backup.js.map