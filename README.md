<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-green?logo=node.js" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/Python-3.9+-blue?logo=python" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/MCP_Protocol-1.0-orange?logo=robot" alt="MCP Protocol">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-SDK-blue?logo=typescript" alt="TypeScript SDK">
  <img src="https://img.shields.io/badge/Python_SDK-Zero_Dependencies-brightgreen?logo=python" alt="Zero Dependencies">
</p>

<h1 align="center">Agent Communication Hub</h1>

<p align="center">
  Build production-grade <strong>multi-agent communication infrastructure</strong> in minutes.<br>
  Real-time messaging, task scheduling, shared memory, and trust-based evolution — all via MCP + SSE.
</p>

<p align="center">
  <a href="#readme">English</a> | <a href="docs/README_CN.md">中文</a>
</p>

---

## What problem does it solve?

When you run multiple AI agents (Claude Code, OpenClaw, WorkBuddy, custom agents…), they operate in silos. They can't:

- **Talk to each other** without brittle webhooks or shared databases
- **Schedule tasks** across agent boundaries
- **Share context** beyond one-shot prompts
- **Evolve together** as a team based on past experience

**Agent Communication Hub** gives every MCP-compatible agent a shared nervous system — message bus, task queue, memory layer, and evolution engine — so agents collaborate instead of isolation.

---

## Try it in 3 lines

```bash
# 1. Start the Hub
docker run -d -p 3100:3100 --name ach liuboacean/agent-comm-hub

# 2. Register an agent
python3 -c "from hub_client import SynergyHubClient; print(SynergyHubClient('http://localhost:3100').register('YOUR_INVITE_CODE'))"

# 3. Send a message
python3 -c "from hub_client import SynergyHubClient; c=SynergyHubClient('http://localhost:3100'); c.set_token('YOUR_TOKEN'); c.send_message(to='other-agent', content='Hello!')"
```

No config files. No external services. Works locally.

---

## Features at a glance

| Category | Tools | What it does |
|---|---|---|
| **Identity** | 6 | Register agents, heartbeat, RBAC roles, trust scoring |
| **Messaging** | 5 | P2P / broadcast, FTS5 search, deduplication |
| **Task Scheduling** | 8 | 7-state machine, pipelines, parallel groups, auto-retry |
| **Memory** | 5 | private / team / collective scopes, edge function scoring |
| **Orchestration** | 11 | Dependency chains (DFS cycle detection), quality gates, handover protocols |
| **Evolution** | 12 | Experience sharing, 4-tier strategy approval, trust-score feedback loop |
| **Security** | 6 | Token auth, 4-level RBAC, audit hash chain, CORS whitelist |
| **Files** | 3 | Upload / download / list, up to 10MB Base64 |

**53 MCP tools** · SQLite WAL (zero message loss) · SSE push latency < 50ms

---

## Architecture

```
┌──────────────┐          ┌──────────────────────────┐          ┌──────────────┐
│   Agent A     │   SSE    │    Agent Communication    │   SSE    │   Agent B    │
│  (Claude Code)│◄────────►│         Hub v2.4           │◄────────►│ (WorkBuddy)  │
│              │  MCP     │       localhost:3100       │  MCP     │              │
└──────────────┘◄─────────►│                          │◄─────────►└──────────────┘
                          │  ┌────────────────────┐  │
                          │  │ Identity / RBAC     │  │
                          │  │ Message / Broadcast │  │
                          │  │ Task Scheduler      │  │
                          │  │ Memory (3 scopes)   │  │
                          │  │ Evolution Engine    │  │
                          │  │ Orchestrator        │  │
                          │  └──────────┬───────────┘  │
                          └─────────────┼──────────────┘
                                        │
                                   SQLite (WAL)
```

Any MCP-compatible agent can connect: Claude Code, OpenClaw, WorkBuddy, Hermes, custom agents, etc.

---

## SDK Examples

### Python — zero dependencies

```python
from hub_client import SynergyHubClient

hub = SynergyHubClient(hub_url="http://localhost:3100", agent_id="my-agent")
hub.set_token("your-api-token")

# Send a message
hub.send_message(to="workbuddy", content="Task completed, handing over.")

# Store shared memory
hub.store_memory(content="User prefers JSON responses", scope="collective")

# Assign a task
task = hub.create_task(title="Review PR #42", assignee="claude-code", priority=2)

# Share a lesson learned
hub.share_experience(title="DB lock timeout fix", content="...", category="debug")

# Stream incoming events
hub.on_message = lambda msg: print(f"Received: {msg}")
hub.connect_sse()  # blocks — long-lived SSE connection
```

### TypeScript — also zero external deps

```typescript
import { AgentClient } from "./client-sdk/agent-client.js";

const client = new AgentClient({
  agentId: "my-agent",
  hubUrl: "http://localhost:3100",
  token: "your-api-token",
  onMessage: async (msg) => { /* handle */ },
  onTaskAssigned: async (task) => { /* handle */ },
});

await client.start();
await client.sendMessage({ to: "workbuddy", content: "Done!" });
```

---

## Deployment

### Docker (recommended)

```bash
docker run -d -p 3100:3100 --name ach liuboacean/agent-comm-hub
```

### Docker Compose (with Prometheus + Grafana)

```bash
cd deploy && docker compose up -d
# Hub:  http://localhost:3100
# Grafana: http://localhost:3000 (admin/admin)
# Prometheus: http://localhost:9090
```

### From source

```bash
git clone https://github.com/liuboacean/agent-comm-hub.git
cd agent-comm-hub
npm install && npm run build
npm start
```

### As a Skill

```bash
# ClawHub
clawhub install liuboacean/agent-comm-hub

# SkillHub (30+ platforms)
npx skills add liuboacean/agent-comm-hub
```

---

## MCP Configuration

After starting the Hub, add it to your agent's MCP config:

### Option 1: stdio (recommended)

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "command": "node",
      "args": ["<hub-install-path>/stdio.js"],
      "env": {
        "HUB_KEY": "your-connection-key"
      }
    }
  }
}
```

### Option 2: HTTP + SSE

```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

The agent's LLM can then call all 53 tools directly via natural language.

---

## Security

| Feature | Detail |
|---|---|
| **RBAC** | 4 levels: public → member → group_admin → admin |
| **Token auth** | SHA-256 agent tokens, stored as hash in DB |
| **Audit hash chain** | `prev_hash → record_hash` with DB triggers |
| **Trust scoring** | Auto-calculated, affects strategy approval tiers |
| **CORS** | Whitelist-only, default deny |
| **Security headers** | X-Frame-Options, CSP, HSTS, X-XSS-Protection |
| **Request tracing** | traceId on every request + response header |

---

## File Structure

```
agent-comm-hub/
├── src/                         # Hub server source (TypeScript)
│   ├── server.ts                # Express + SSE + MCP entry point
│   ├── db.ts                    # SQLite WAL schema + queries
│   ├── identity.ts              # Registration, heartbeat, RBAC
│   ├── memory.ts                # 3-scope memory with FTS5
│   ├── task.ts                  # 7-state task scheduler
│   ├── orchestrator.ts          # Dependency chains, pipelines
│   ├── evolution.ts             # Strategy engine, trust scoring
│   └── security.ts              # Auth, token, RBAC, audit
├── client-sdk/
│   ├── hub_client.py            # Python SDK (zero deps, 68 methods)
│   └── agent-client.ts          # TypeScript SDK (35 public methods)
├── deploy/
│   ├── docker-compose.yml       # Prometheus + Grafana observability
│   └── prometheus.yml           # Metrics scraping config
├── docs/
│   ├── API_REFERENCE.md         # 53 tools complete reference
│   ├── advanced-orchestration-guide.md
│   ├── evolution-engine-guide.md
│   └── hermes-integration-guide.md
├── scripts/
│   ├── install.sh               # Hub server install script
│   └── test-e2e.sh              # End-to-end test suite
└── tests/                       # Integration + unit tests
```

---

## Documentation

| Doc | When to read |
|---|---|
| [API Reference](docs/API_REFERENCE.md) | Every tool signature + examples |
| [Orchestration Guide](docs/advanced-orchestration-guide.md) | Pipelines, parallel groups, quality gates |
| [Evolution Engine](docs/evolution-engine-guide.md) | Trust scoring, strategy approval workflow |
| [Hermes Integration](docs/hermes-integration-guide.md) | Step-by-step Hermes agent setup |
| [README.md (English)](README.md) | This page |

---

## License

MIT — use it freely in personal and commercial projects.

---

<p align="center">
  <em>Built with the MCP protocol + SSE. No external services. No vendor lock-in.</em>
</p>
