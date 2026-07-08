<p align="center">
  <img src="https://img.shields.io/badge/Node.js-22-green?logo=node.js" alt="Node.js 22">
  <img src="https://img.shields.io/badge/159_Tests-Passing-3fb950?logo=vitest" alt="159 Tests Passing">
  <img src="https://img.shields.io/badge/Zero_External_Deps-success?logo=package" alt="Zero External Deps">
  <img src="https://img.shields.io/badge/Web_Panel-Live-7c3aed?logo=htmx" alt="Web Panel Live">
  <img src="https://img.shields.io/badge/Python-3.9+-blue?logo=python" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/MCP_Protocol-1.0-orange?logo=robot" alt="MCP Protocol">
  <img src="https://img.shields.io/badge/DB_Split_Protection-v3-green?logo=shield" alt="DB Split Protection">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-SDK-blue?logo=typescript" alt="TypeScript SDK">
  <img src="https://img.shields.io/badge/Python_SDK-Zero_Dependencies-brightgreen?logo=python" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/CI-Passing-3fb950?logo=githubactions" alt="CI">
  <a href="https://glama.ai/mcp/servers/liuboacean/agent-comm-hub">
    <img src="https://glama.ai/mcp/servers/liuboacean/agent-comm-hub/badges/score.svg" alt="Glama score">
  </a>
  <a href="../demo/index.html">
    <img src="https://img.shields.io/badge/Live_Demo-7f77dd?logo=github" alt="Live Demo">
  </a>
</p>

<h1 align="center">🤖 Agent Communication Hub</h1>
<p align="center">
  <strong>Production-grade multi-agent communication infrastructure</strong><br>
  Real-time messaging · Task scheduling · Shared memory · Evolution engine<br>
  Built on MCP + SSE protocol · 56 tools · Zero external dependencies
</p>

<p align="center">
  <a href="../README.md">中文</a> · <a href="#readme">English</a>
</p>

---

## 📖 The Problem

AI Agents (Claude Code, OpenClaw, WorkBuddy, etc.) are naturally isolated:

- ❌ No **direct communication** (requires fragile webhooks or shared databases)
- ❌ No **cross-agent task scheduling**
- ❌ No **shared context** (beyond single prompts)
- ❌ No **collective evolution** (learning from each other's experience)

**Agent Communication Hub** provides a shared neural center for every MCP-compatible Agent — message bus, task queue, memory layer, and evolution engine.

---

## 🚀 Quick Start

```bash
# 1. Start the Hub (Docker, recommended)
docker run -d -p 3100:3100 --name ach ghcr.io/liuboacean/agent-comm-hub:v2.5.1

# 2. Register an Agent
python3 -c "
from hub_client import SynergyHubClient
hub = SynergyHubClient('http://localhost:3100')
result = hub.register(invite_code='INVITE-001', name='my-agent')
print(f'Token: {result[\"api_token\"]}')
hub.set_token(result['api_token'])
"

# 3. Send a Message
python3 -c "
from hub_client import SynergyHubClient
hub = SynergyHubClient('http://localhost:3100')
hub.set_token('your-api-token')
hub.send_message(to='other-agent', content='Hello, Agent!')
"
```

> Zero config. Zero external services. Ready locally.

---

## ✨ Features

| Category | Tools | Description |
|----------|-------|-------------|
| 🔐 Identity | 6 | Registration, heartbeat, RBAC, trust scoring |
| 💬 Messaging | 5 | P2P / broadcast, FTS5 full-text search, dedup |
| 📋 Task Scheduling | 8 | 7-state machine, Pipeline, parallel groups, retry |
| 🧠 Shared Memory | 5 | private / team / collective scopes |
| 🔀 Orchestration | 11 | Dependency chains (DFS cycle detection), quality gates, handoff |
| 📈 Evolution Engine | 12 | Experience sharing, 4-tier strategy approval, feedback loop |
| 🛡️ Security & Audit | 6 | Token auth, 4-level RBAC, audit hash chain, CORS whitelist |
| 📎 File Transfer | 3 | Upload / download / list, Base64 10MB limit |
| 🔧 High Availability | 3 | DB split auto-detection + merge + watchdog self-heal |

**56 MCP tools** · SQLite WAL (zero message loss) · SSE push latency < 50ms

### 📊 Stats Snapshot

| Metric | Value |
|--------|:-----:|
| MCP tools | **56** |
| Python SDK methods | **68** |
| TypeScript SDK methods | **35** |
| Unit tests | **159 ✅** |
| Database tables | **32** |
| External dependencies | **0** |
| SSE push latency | **< 50ms** |
| Deployment | Docker / npm / SkillHub |

---

## 🏗️ Architecture

```
┌──────────────┐    ┌──────────────────────────┐    ┌──────────────┐
│  Agent A     │SSE │   Agent Communication    │SSE │  Agent B     │
│ (Claude Code)│◄──►│       Hub v2.5           │◄──►│  (WorkBuddy) │
│              │MCP │    localhost:3100        │MCP │              │
└──────────────┘◄───►│                          │◄───►└──────────────┘
                     │  ┌────────────────────┐  │
                     │  │ Identity / RBAC    │  │
                     │  │ Message / Broadcast│  │
                     │  │ Task Scheduler     │  │
                     │  │ Memory (3 scopes)  │  │
                     │  │ Evolution Engine   │  │
                     │  │ Orchestrator       │  │
                     │  └────────┬───────────┘  │
                     └───────────┼──────────────┘
                                 │
                            SQLite (WAL)
```

Any MCP-compatible agent can connect: Claude Code, OpenClaw, WorkBuddy, custom agents, and more.

---

## 🔧 SDK Examples

### Python (zero external dependencies)

```python
from hub_client import SynergyHubClient

hub = SynergyHubClient(
    hub_url="http://localhost:3100",
    agent_id="my-agent"
)
hub.set_token("your-api-token")

# Send a message
hub.send_message(to="other-agent", content="Task complete, handing over.")

# Store shared memory
hub.store_memory(
    content="User prefers JSON responses",
    scope="collective"
)

# Create a task
task = hub.create_task(
    title="Review PR #42",
    assignee="claude-code",
    priority=2
)

# Share experience
hub.share_experience(
    title="DB lock timeout fix",
    content="...",
    category="fix"
)

# Real-time SSE listener (blocking)
hub.on_message = lambda msg: print(f"Received: {msg}")
hub.connect_sse()
```

### TypeScript (zero external dependencies)

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  token: "your-api-token",
  onMessage: async (msg) => { /* handle message */ },
  onTaskAssigned: async (task) => { /* handle task */ },
});

await client.start();
await client.sendMessage({ to: "other-agent", content: "Done!" });
```

---

## 📦 Deployment

### Docker (recommended)

```bash
docker run -d -p 3100:3100 --name ach ghcr.io/liuboacean/agent-comm-hub:v2.5.1
```

### Docker Compose (with Prometheus + Grafana)

```bash
cd deploy/
docker compose up -d
# Hub:      http://localhost:3100
# Grafana:  http://localhost:3000 (admin/admin)
# Prometheus: http://localhost:9090
```

### From Source

```bash
git clone https://github.com/liuboacean/agent-comm-hub.git
cd agent-comm-hub
npm install
npm run build

# Development (hot reload)
npm run dev

# Production
npm start
```

---

## ⚠️ Node Version Requirement (Important)

This project depends on the native module **`better-sqlite3`, which is compiled against Node 22 (NODE_MODULE_VERSION 127)**. Therefore:

- 🔒 **The Hub (`dist/src/server.js` or `dist/src/stdio.js`) MUST be started with Node 22.** If you use Node 24 (or higher), it will immediately throw `ERR_DLOPEN_FAILED` due to ABI mismatch and crash on startup — it will not run at all.
- 🧪 **Node 24 in CI is only used to run unit tests** (and the smoke tests that involve stdio startup have been conditionally `skip`ped). The `engines.node` declaration of `>=24` in `package.json` is a legacy CI declaration that **conflicts with the actual runtime constraint — please follow Node 22 as stated in this section.**
- ✅ **Recommended approach**: pin Node 22 with a version manager (e.g. `nvm use 22`), or hard-code the absolute path to the Node 22 binary in your startup script / MCP configuration.

---

## 🔌 MCP Configuration

### Method 1: stdio (recommended)

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "command": "/path/to/node22/bin/node",
      "args": ["dist/src/stdio.js"],
      "env": {
        "HUB_AUTH_TOKEN": "your-connection-key",
        "DB_PATH": "/path/to/comm_hub.db"
      }
    }
  }
}
```

> ⚠️ **You MUST start with the Node 22 binary** (e.g. the absolute path `/path/to/node22/bin/node`), **not** Node 24. The native module `better-sqlite3` is compiled against Node 22 (NODE_MODULE_VERSION 127), so launching `dist/src/stdio.js` / `dist/src/server.js` with Node 24 will immediately crash with `ERR_DLOPEN_FAILED` due to ABI mismatch.

### Method 2: HTTP + SSE

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

---

## 🛡️ Security

| Feature | Description |
|---------|-------------|
| **RBAC** | 4 levels: public → member → group_admin → admin |
| **Token Auth** | SHA-256 hashed storage, raw token never persisted |
| **Audit Hash Chain** | `prev_hash → record_hash`, DB triggers ensure integrity |
| **Trust Scoring** | Automatic, influences strategy approval tier |
| **CORS** | Whitelist-based, denied by default |
| **Security Headers** | X-Frame-Options, CSP, HSTS, X-XSS-Protection |
| **Request Tracing** | Every request gets traceId + response header |

---

## 📁 Project Structure

```
agent-comm-hub/
├── src/                    # Hub server (TypeScript)
│   ├── server.ts          # Express + SSE + MCP entry point
│   ├── stdio.ts           # stdio MCP entry point
│   ├── db.ts              # SQLite WAL schema & queries
│   ├── identity.ts        # Registration, heartbeat, RBAC
│   ├── memory.ts          # 3-scope memory + FTS5
│   ├── task.ts            # 7-state task scheduler
│   ├── orchestrator.ts    # Dependency chains, pipelines
│   ├── evolution.ts       # Strategy engine, trust scoring
│   └── security.ts        # Auth, token, RBAC, audit
├── client-sdk/
│   ├── hub_client.py      # Python SDK (zero deps, 68 methods)
│   ├── agent-client.ts    # TypeScript SDK (35 public methods)
│   └── package.json       # npm publish config
├── deploy/
│   ├── docker-compose.yml # Prometheus + Grafana
│   └── prometheus.yml     # Metrics collection
├── docs/
│   ├── API_REFERENCE.md           # All 56 tool signatures
│   ├── advanced-orchestration-guide.md
│   ├── evolution-engine-guide.md
│   ├── hermes-integration-guide.md
│   ├── README_EN.md               # This file
│   └── hub-db-split-three-layer-protection.md
├── scripts/                # Install, test, migration
├── tests/                  # Unit & integration tests
└── .github/workflows/
    ├── ci.yml              # CI pipeline
    └── docker.yml          # Docker build & publish
```

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [API Reference](API_REFERENCE.md) | All 56 tool signatures + examples |
| [Orchestration Guide](advanced-orchestration-guide.md) | Pipelines, parallel groups, quality gates |
| [Evolution Engine](evolution-engine-guide.md) | Trust scoring, strategy approval flow |
| [Hermes Integration](hermes-integration-guide.md) | Step-by-step Hermes Agent setup |
| [DB Split Protection](hub-db-split-three-layer-protection.md) | Auto-detection, merge, watchdog |

---

## 🤝 Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.

---

## 🆕 Changelog / Update History

<details>
<summary><strong>v2.5.1</strong> (2026-07-08) — Stability fixes + Node 22 constraint lock</summary>

- 🐛 **`get_db_stats` fix** — ESM module misused `require("fs")` causing `require is not defined`; changed to `import * as fs`
- 🔄 **DB path fallback** — `resolveDbPath` now auto-falls-back on empty DB, fixing the false "data reset" of the memory / evolution engine from connecting to an empty DB
- 🔒 **Node 22 lock** — startup script pins Node 22 to match the `better-sqlite3` native module (Node 24 would ABI-crash)
- 🧪 **Guard test** — added a contract test ensuring stdio / Hub must run on Node 22, preventing accidental revert to Node 24
- 🧹 **Test hygiene** — fixed unit tests leaking `undefined*` stray files in the repo root (`isValidDbPath` guard)

</details>

<details>
<summary><strong>v2.5.0</strong> (2026-07-07) — Web admin panel + backup module</summary>

- 🖥️ **Web admin panel** — zero-framework static HTML dashboard with 6 real-time pages
- 🔄 **Online-status improvement** — binary label → last-active timestamp, no more flickering
- 📦 **Backup module** — local + remote rsync backup status display
- ⏱️ **Persistent uptime** — survives restarts
- 📊 **New API** — `GET /api/agents`
- 🔧 **`.gitignore` cleanup** — removed tracked build artifacts

</details>

<details>
<summary><strong>v2.4.7</strong> (2026-06-09) — Tag tokenization fix + full-chain logging</summary>

- 🔍 FTS5 tag tokenization fix (space-joined instead of JSON)
- 📊 12 silently-swallowed exceptions → `logError` full-chain observability
- 🔐 `authed()` unified auth middleware refactor

</details>

<details>
<summary><strong>v2.4.6</strong> (2026-06-09) — FTS5 index guard + externalized paths</summary>

- 🔒 FTS5 index auto-verified after every store
- 🛣️ Supports `HUB_ROOT` environment variable
- 📨 New `generate_invite` invite-code tool
- 🧪 Added 19 test cases

</details>

---

## 📄 License

MIT — Free for personal and commercial use.

---

<p align="center">
  <em>Built with the MCP protocol + SSE. No external services. No vendor lock-in.</em>
</p>
