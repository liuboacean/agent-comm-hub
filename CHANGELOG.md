# Changelog

## [3.0.21] - 2026-07-23 — 审计修复（稳定性 / 安全 / 质量）

### Fixed (P1 — 稳定性 / 安全)
- **P1-1 SSE 重连竞态**：`registerClient`/`removeClient` 增加连接级 `connId` 校验，旧 socket 的 `close` 事件不再误删「当前」实时连接，重连后消息 / 任务 / 激活通知不再静默丢失
- **P1-2 并发写 `SQLITE_BUSY`**：`db` 初始化增加 `busy_timeout=5000` + `foreign_keys=ON` + `wal_autocheckpoint`，消除 HTTP handler / SSE push / 后台调度并发写导致的静默丢数据
- **P1-3 限流绕过**：认证前置 IP / 全局限流（防令牌爆破与未认证 `/mcp` 耗尽资源）；`/mcp` 增加并发在途上限（默认 50）防 DoS
- **P1-4 / P1-5 FTS 值碰撞**：`memories_fts` 增加 `memory_id` 精确关联键（启动迁移旧表），召回按 `id` 关联、删除按 `id` 命中，内容相同的两条记忆不再互相串台（删除一条误伤另一条）

### Fixed (P2 — 质量 / 文档)
- **P2-1 信任分误扣**：`revoke_token` 审计将「被吊销者」写入 `target` 列，信任分公式改按 `target` 统计，管理员不再被误扣、被吊销者正确扣分
- **P2-2 metrics 无界数组**：`counters` 改为 keyed `Map`，消除高基数标签下的 O(N) 扫描与内存增长
- **P2-3 对象级授权**：并行组内跨任务访问保持协作语义（by-design）；资源不存在时正确交由调用方 404
- **P2-4 优雅关闭顺序**：`await httpServer.close()` 后再关 DB，避免 WAL 写后关
- **P2-5 SSE 写后关保护**：`pushToAgent` / `writeStoredEvent` 写前校验 `res` 可写
- **P2-6 令牌泄漏**：受保护端点移除 `?token=` 与 `x-api-key` 接受，仅保留 Bearer
- **P2-7 死代码清理**：移除 `RateLimiter.getTopLimited` 死桩；`version.ts` 增加 `readFileSync`/`JSON.parse` 的 `try/catch` 防启动崩溃
- **P2-8 文档漂移**：README 修正 `engines.node` 声明（实际为 `>=22 <23`）；补齐 CHANGELOG；SKILL.md 版本号同步

## [3.0.20] - 2026-07-23 — 构建产物固化

### Fixed
- 固化 `dist/package.json` 生成到 `build` 脚本与启动脚本，消除「安装即崩溃」类问题（`version.ts` 启动依赖 `../package.json`）

## [3.0.19] - 2026-07-23 — 文档与版本一致性修复 (D10)

### Fixed
- 文档工具数统一为 **58**（与 `src/security.ts` 的 `TOOL_PERMISSIONS` 矩阵一致）：README 与 SKILL.md 中残留的 56 / 53 全部更正
- 新建 `docs/API_REFERENCE.md`：准确的 HTTP / SSE / MCP 端点速查，含 Bearer 鉴权与 SSE `Last-Event-ID` 断线重连说明
- 修复 README 三处死链：`API_REFERENCE.md`（已新建）、`evolution-engine-guide.md` 与 `hermes-integration-guide.md`（标注 TODO，计划从 A 层同步）
- SKILL.md 文件传输工具名更正：`send_file` / `receive_file` → `upload_file` / `download_file`
- A 层 `install.sh`：构建产物路径 `dist/server.js` → `dist/src/server.js`；新增版本固定（从 `package.json` 读取 version 并 `git checkout v<version>`）
- 在 README 注明 B 层为文档权威源；因 `scripts/sync-docs.ts` 暂缺，A 层 Skill 分发包需手动同步

## [2.5.0] - 2026-07-07

### Added
- P1-4 激活编排层：Agent 状态机 (registered/active/suspended/retired) + Pipeline 状态机 (draft/active/paused/completed/cancelled) + ActivationOrchestrator
- P1-4 MCP 工具：activate_agent / deactivate_agent / pause_pipeline / resume_pipeline
- P2-8 令牌桶限流：RateLimiter（单 Agent 100/min + 全局 1000/min，env 可配）
- P2-8 Backoff 指数退避：client-sdk/backoff.ts（base 200ms, cap 10s, jitter）
- P2-8 send_message 限流接入：超限返回 429 + Retry-After
- P2-7 Web 管理面板：Vite + React + MUI + Tailwind 运维仪表盘
- P2-7 面板后端端点：GET /api/status + GET /api/audit/tail + /dashboard 静态托管
- Metrics 增强：getTopLimited() 限流 Top N 查询
- SSE 增强：broadcastToAll() 全连接广播
- 版本同步：CHANGELOG.md 变更日志
