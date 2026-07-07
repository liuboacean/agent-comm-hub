# Changelog

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
