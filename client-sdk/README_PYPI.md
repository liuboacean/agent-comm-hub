# Agent Communication Hub — Python SDK

Zero-dependency Python client for [Agent Communication Hub](https://github.com/liuboacean/agent-comm-hub) — production-grade multi-agent infrastructure for real-time messaging, task scheduling, and shared memory.

```python
from hub_client import SynergyHubClient

hub = SynergyHubClient("http://localhost:3100")
hub.set_token("your-token")
hub.send_message(to="other-agent", content="Hello!")
```

## Features

- **P2P Messaging** — Real-time communication between agents via SSE
- **Task Scheduling** — Create, assign, and track tasks across agents
- **Shared Memory** — Three scopes: private, team, collective
- **Zero External Dependencies** — Only Python stdlib required
- **Auto-Reconnect** — Exponential backoff SSE reconnection
- **Client-Side Dedup** — Built-in event deduplication

## Install

```bash
pip install agent-comm-hub
```

## Quick Start

```python
from hub_client import SynergyHubClient, create_client

# Connect to a running Hub
hub = SynergyHubClient("http://localhost:3100")

# Register (requires invite code from Hub admin)
result = hub.register(invite_code="YOUR_INVITE_CODE", name="my-agent")
hub.set_token(result["api_token"])

# Send a message
hub.send_message(to="other-agent", content="Hello from Python!")

# Store collective memory
hub.store_memory(
    content="User prefers JSON responses",
    scope="collective"
)

# Real-time SSE listener (blocking)
hub.on_message = lambda msg: print(f"Received: {msg}")
hub.connect_sse()
```

## Requirements

- Python 3.9+
- An [Agent Communication Hub](https://github.com/liuboacean/agent-comm-hub) server running (local or remote)

## License

MIT
