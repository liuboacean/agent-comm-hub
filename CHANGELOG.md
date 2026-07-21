# Changelog

## [3.0.19] - Unreleased — 文档与版本一致性修复 (D10)

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
