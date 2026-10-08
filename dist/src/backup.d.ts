/**
 * 启动定时备份
 * @param dbPath SQLite DB 文件路径
 */
export declare function startBackupScheduler(dbPath: string): void;
/**
 * 获取备份状态
 *
 * 大小与件数均按「成套」统计（.db + .db-wal + .db-shm），
 * 因为 sidecar 是备份的组成部分，只统计 .db 会低报磁盘占用。
 */
export declare function getBackupStatus(): {
    enabled: boolean;
    last_backup: number | null;
    backup_count: number;
    backup_dir: string;
    total_size_bytes: number;
    total_size_mb: string;
    host_count: number;
    interval_ms: number;
    max_backups: number;
};
/**
 * 停止备份调度器
 */
export declare function stopBackupScheduler(): void;
