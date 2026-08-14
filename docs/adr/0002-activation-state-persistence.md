# ADR-0002: 激活态持久化

**状态:** Accepted · **日期:** 2026-07-21 · **修复:** D2（v3.0.19）

## 背景 / 问题
`ActivationOrchestrator` 用内存 `Map` 维护激活态，启动靠 `replayFromAudit` 从 `audit_log` 重放。未审计的 registered Agent 内存缺失，`activateAgent` 返回 `AGENT_NOT_FOUND`，编排层不可用（D2）；内存态与 DB 无权威一致。

## 考虑过的方案
- **A** 纯内存 + 仅审计重放（现状）；**B** DB 权威 + 内存热缓存（采用）。

## 决策
启动从 `agents` 表 seed registered 态进编排器；`activateAgent` 内存未命中回查 `agents.status` 并载入；激活态落库 `agents.status`（`registered/active/suspended/retired`），写先 DB 后内存，重启从 DB 重载。

## 后果 / 权衡
DB 权威、内存热缓存，激活低频可接受。必配 D8 对象级鉴权：激活态写 `agents.status` 驱动授权，缺 D8 则任意方可篡改 → 越权。`agents.status` 原表 `online/offline`，实现须区分在线态与激活态。
