/**
 * 当前 hub 运行时版本号，与 package.json 的 version 字段保持一致。
 * P2-7 修复：原代码对 readFileSync/JSON.parse 无 try/catch，
 * 若 dist/package.json 缺失或格式损坏会直接让服务启动崩溃（v3.0.20 之前正是此类崩溃）。
 */
export declare const HUB_VERSION: string;
