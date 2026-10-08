/**
 * 启动定时备份
 * @param dbPath SQLite DB 文件路径
 */
export declare function startBackupScheduler(dbPath: string): void;
/**
 * 获取备份状态
 */
export declare function getBackupStatus(): {
    enabled: boolean;
    last_backup: number | null;
    backup_count: number;
    backup_dir: string;
    total_size_bytes: number;
    total_size_mb: string;
    interval_ms: number;
    max_backups: number;
};
/**
 * 停止备份调度器
 */
export declare function stopBackupScheduler(): void;
