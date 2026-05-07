# Contributing to Agent Communication Hub

Thank you for your interest in contributing! This project is the shared nervous system for multi-agent AI infrastructure — every improvement benefits every agent that runs on the Hub.

---

## Ways to Contribute

- 🐛 **Report bugs** — Open an issue with the bug report template
- ✨ **Feature requests** — Open an issue with the feature request template
- 📖 **Improve docs** — Submit a PR to fix typos, add examples, or translate
- 🔧 **Code contributions** — Fix bugs, add tools, improve SDKs
- 🧪 **Add tests** — Increase test coverage for untested modules
- 📣 **Share the project** — Star the repo, write about it, tell a friend

---

## Development Setup

### Prerequisites

- Node.js 18+ (for Hub server)
- Python 3.9+ (for Python SDK)
- SQLite 3 (usually pre-installed)

### Install dependencies

```bash
git clone https://github.com/liuboacean/agent-comm-hub.git
cd agent-comm-hub
npm install
npm run build
```

### Start the Hub

```bash
npm start
# or for development with hot reload:
npm run dev
```

### Run tests

```bash
# Unit tests with coverage
npm run test:unit

# End-to-end tests (requires Hub running)
npm run test:e2e
```

### Code style

- TypeScript: follow the project's `tsconfig.json` settings
- Python: follow PEP 8 (max line length 120)
- Commit messages: use [Conventional Commits](https://www.conventionalcommits.org/)

---

## Project Structure

```
src/
  server.ts      — Express + SSE + MCP entry point
  db.ts          — SQLite WAL schema and queries
  identity.ts    — Agent registration, heartbeat, RBAC
  memory.ts      — 3-scope memory layer with FTS5
  task.ts        — Task scheduler, 7-state machine
  orchestrator.ts — Dependency chains, pipelines, quality gates
  evolution.ts   — Strategy engine, trust scoring
  security.ts    — Token auth, RBAC, audit hash chain

client-sdk/
  hub_client.py   — Python SDK (no external deps)
  agent-client.ts — TypeScript SDK

docs/             — Architecture & integration guides
scripts/          — Install, test, migration scripts
deploy/           — Docker Compose, Prometheus, Grafana
```

---

## Pull Request Process

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-description
   ```

2. **Make your changes.** Follow the code style guidelines above.

3. **Add tests** for any new functionality. The project uses vitest for unit tests.

4. **Ensure tests pass:**
   ```bash
   npm run test:unit
   npx tsc --noEmit
   ```

5. **Commit** using Conventional Commits format:
   ```bash
   git commit -m "feat(memory): add FTS5 search for collective memories"
   git commit -m "fix(task): prevent duplicate state transitions"
   ```

6. **Push and open a Pull Request.** Fill out the PR template.

7. A maintainer will review within 48 hours. Be responsive to feedback.

---

## Releasing a Version

Versions are released by tagging on `main`:

```bash
# Update version in package.json
npm version patch  # 2.4.1 → 2.4.2
# or
npm version minor  # 2.4.1 → 2.5.0
# or
npm version major  # 2.4.1 → 3.0.0

git push --follow-tags
```

This triggers the `docker.yml` workflow, which builds and publishes the Docker image automatically.

---

## Code of Conduct

Be respectful and constructive. We welcome contributors from all backgrounds. This project follows the [Contributor Covenant](https://www.contributor-covenant.org/).

---

## Questions?

Open a GitHub Discussion or ping the maintainer. We respond within 48 hours.
