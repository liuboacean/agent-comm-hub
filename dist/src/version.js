/**
 * version.ts — 版本单一真相源（Single Source of Truth）
 *
 * 运行时从 package.json 读取 version，避免多处硬编码导致版本漂移。
 * server.ts 与任何需要当前 hub 版本号的模块都应从此文件导入 HUB_VERSION，
 * 而非各自读取 package.json。
 */
import { readFileSync } from "fs";
/** 当前 hub 运行时版本号，与 package.json 的 version 字段保持一致。 */
export const HUB_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
//# sourceMappingURL=version.js.map