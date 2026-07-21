# ADR-0001: SSE 可靠投递

**状态:** Accepted · **日期:** 2026-07-21 · **修复:** D1（v3.0.19）

## 背景 / 问题
`sse.ts` 的 `event_id` 是 per-connection 内存计数器，重连归零；事件不持久化，离线补发不可行；`Last-Event-ID` 与 `_hub_event_id` 脱钩，致首连丢消息、重连无法补发。

## 考虑过的方案
- **A** 毫秒时间戳 + 固定窗口；**B** 持久化 `event_log` + 全局 `event_seq`（采用）。

## 决策
新增 `event_log` 表（`event_seq` 全局单调、`delivered` 标记）。服务端以 `event_seq` 作 SSE `id`；客户端以其作 `Last-Event-ID`。重连仅重放 `seq > Last-Event-ID` 的 event（覆盖全部类型），仅推送成功才标 `delivered`。

## 后果 / 权衡
不用 A：同毫秒乱序、跨进程不单调、窗口外永久丢失。持久化使服务端成重放权威源；代价为写开销 + 需归档（参考 `messages_archive`）防膨胀。
