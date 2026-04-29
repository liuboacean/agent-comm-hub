# Changelog

All notable changes to this project will be documented in this file.

## [2.3.0] - 2026-04-29

### 新增功能
- **文件传输**：新增 `upload_file`、`download_file`、`list_attachments` 3 个 MCP 工具，支持 Agent 间文件传输（Base64 编码，10MB 限制）
- **消息格式校验**：`send_message` 工具新增 from/to 参数格式校验，支持完整 agent_id、别名映射（workbuddy/hermes/qclaw）、子串匹配
- **策略反馈闭环**：`apply_strategy` 采纳后自动创建 neutral 反馈占位；新增 `score_applied_strategies` 管理工具，7 天无有效反馈自动降分为 negative
- **批量消息确认**：新增 `batch_acknowledge_messages` 工具，支持按 agent/时间/状态批量确认消息
- **心跳信任增长**：连续 3 次心跳 trust_score 自动 +1，上限 100；offline 时重置计数器
- **stdio 模式**：新增 stdio transport 入口（`src/stdio.ts`），支持 command-based MCP 客户端直接接入

### 技术变更
- 新增 `attachments` 数据表（总 28 表）
- MCP 工具 46 → 51 个
- 代码 +1286 行（Phase 1 + Phase 2 合计，21 文件）
- 历史消息 from_agent 格式迁移（43 条记录规范化）
- `provideFeedback()` 使用 UPSERT 实现（ON CONFLICT DO UPDATE）

### 迁移说明
- 从 v2.2.2 升级：`npm run build`（自动建 attachments 表）
- 可选迁移：`node scripts/migrate_from_agent.js`（清理历史消息 from_agent 格式）
- stdio 模式需设置 `HUB_AUTH_TOKEN` 环境变量

---

## [2.2.2] - 2026-04-28

### Fixed (QoderWork Round 2 Code Review)

**API Documentation (API_REFERENCE.md)**
- Fix tool count: 40 → 46 (was out of sync with README and SKILL.md)
- Add missing tool docs: `search_messages`, `search_memories`, `create_pipeline`, `get_pipeline`, `list_pipelines`, `add_task_to_pipeline`
- Fix `store_memory` param: `agent_id` marked as deprecated (server auto-infers from Bearer token)
- Fix `recall_memory` param: remove unnecessary `agent_id` required field
- Fix `group_admin` permission description: was "不可操作记忆/策略/消息/evolution 工具", now correctly states group_admin = member + parallel_group management
- Fix permission matrix: group_admin now shows ✅ for all memory/evolution tools (same as member)

**TypeScript SDK (agent-client.ts)**
- Fix `postMcp` null body NPE: when SSE response has no `data:` line, `body` was set to `null` causing `body.error` to throw; now throws descriptive error
- Fix `postMcp` multi-line SSE parsing: collect all `data:` lines and join per SSE spec, instead of taking only the first
- Fix `connectSSE` import failure: add `.catch()` handler for dynamic `import("eventsource")` with clear install instructions and reconnect fallback

**Python SDK (hub_client.py)**
- Fix `_raw_mcp` SSE parsing: was only taking first `data:` line; now collects all `data:` lines per SSE spec, joins them, then parses; ignores `event:`/`id:`/comment lines properly; fallback to line-by-line parsing

## [2.2.1] - 2026-04-28

### Fixed (Hermes + QoderWork Code Review)

**Python SDK (hub_client.py)**
- Fix fake async: `set_agent_role` and `recalculate_trust_scores` removed `async` keyword (they call sync `_call_tool`)
- Add 7 missing MCP tool wrappers: `search_messages`, `search_memories`, `create_pipeline`, `get_pipeline`, `list_pipelines`, `add_task_to_pipeline`, `cancel_task`
- Fix SSE token exposure: removed token from URL query parameter, keep Authorization header only
- Fix dedup trim: use ordered list instead of unordered set for correct FIFO eviction

**TypeScript SDK (agent-client.ts)**
- Add `private _apiToken` field (replaced `(this as any)._apiToken` hack)
- Add `setToken()` method for authentication
- Add 7 missing methods: `setTrustScore`, `revokeToken`, `searchMemories`, `createPipeline`, `getPipeline`, `listPipelines`, `addTaskToPipeline`
- Fix MCP request ID: `Date.now()` → `crypto.randomUUID()`

**Documentation**
- Fix 2 dead links: `evolution-engine-guide.md` → `evolution-guide.md`, `advanced-orchestration-guide.md` → `orchestrator-guide.md`
- Unify tool counts to 46 across README.md, SKILL.md, hermes-integration-guide.md
- Fix scope enum: `private/team/global` → `private/group/collective` (per server code)
- Update Hub version requirement: `v2.0.0+` → `v2.2.0+` in orchestrator-guide.md and evolution-guide.md

**Scripts**
- Fix `install.sh`: correct repo URL `liubotype` → `liuboacean`, remove hardcoded local path

## [2.2.0] - 2026-04-27

### Added

- Phase 6 finalization: SSE reconnection, config externalization, token cleanup
- Legacy adapter for old bridge system retirement
- 6 new MCP tools: `create_pipeline`, `get_pipeline`, `list_pipelines`, `add_task_to_pipeline`, `search_messages`, `search_memories`
- TS SDK: +22 methods (35 public methods total)
- Python SDK: 39 methods
- Total MCP tools: 46

## [2.1.0] - 2026-04-25

### Added

- Phase 5a: RBAC with `group_admin` role, audit hash chain, trust score formula
- Phase 5b: structured logging, Prometheus metrics, CORS whitelist, graceful shutdown
- 2 new MCP tools: `set_agent_role`, `recalculate_trust_scores`
- Total MCP tools: 44

## [2.0.0] - 2026-04-24

### Added

- Phase 4b: dependency chain (DFS cycle detection), parallel groups, handoff protocol, quality gates
- Phase 4a: Task Orchestrator (7-state machine, Pipeline container, agent capability matching)
- Evolution Engine: 4-tier approval, strategy sharing, experience publishing
- Total MCP tools: 38

## [1.0.0] - 2026-04-23

### Added

- Initial release: MCP + SSE + SQLite WAL + FTS5
- Agent identity, messaging, task management, memory, evolution
- Python SDK and TypeScript SDK
- 26 MCP tools
