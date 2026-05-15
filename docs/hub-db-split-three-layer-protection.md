# Hub DB 分裂修复 · 三层防护系统

## 问题根因

`server.js` 默认使用 `dist/comm_hub.db`，而启动脚本使用根目录 `comm_hub.db`。
`src/db.js` 中 `__dirname = dist/src/`，因此 `join(__dirname, "../comm_hub.db")` 解析为 `dist/comm_hub.db`。

当 Node.js 版本切换（nvm）后，server 重启走默认 DB 路径，导致两个 DB 文件分裂：

| DB 文件 | 路径 | 大小(示例) | 用途 |
|---------|------|-----------|------|
| root DB | `comm_hub.db` | 1.19MB | 启动脚本写入 |
| dist DB | `dist/comm_hub.db` | 1.52MB | server.js 默认读取 |

两个独立的 SQLite 文件，无锁争用但数据分裂。消息/agent/token 分布在不同 DB 中，导致：
- 旧 agent 无法登录（token 在 root DB）
- 新注册的 agent 互相看不见（在不同 DB）

---

## 三层防护架构

### 第1层 — db.ts 四级回退（源码层）

**位置**: `src/db.ts`（编译到 `dist/src/db.js`）
**完成**: Hermes

四级回退优先级：
1. `DB_PATH` 环境变量（最高优先）
2. `process.cwd() + /comm_hub.db`（当前工作目录）
3. `~/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db`（固定路径）
4. 抛错

**效果**: 无论从哪个目录启动，只要显式传入 DB_PATH env 或用固定路径，都能读取正确的 DB 文件。

### 第2层 — 启动检测脚本

**位置**: `scripts/check_db_consistency.sh`
**完成**: Hermes

功能：
- inode 对比检测 root DB 和 dist DB 是否为同一文件
- 如分裂 → 自动合并（grep + 去重 + 保留最新记录）
- 无效 SQLite 文件跳过，不阻塞后续步骤
- symlink 作为创建兜底

在启动 server.js 前执行，确保双 DB 一致。

### 第3层 — cron 看门狗 + launchd 自启动

**位置**:
- cron: `scripts/cron_db_watchdog.sh`
- launchd: `~/Library/LaunchAgents/com.agent-comm-hub.server.plist`
**完成**: WorkBuddy

cron 看门狗（每 10 分钟）:
- 检测 root DB 存在
- 检测 server.js 进程存活
- 检测 health endpoint 200
- 检测 inode 一致性
- 静默退出码 0=正常，非 0=告警
- 纯 shell，零 token 消耗

launchd:
- KeepAlive=true，崩溃自动重启
- 通过 `scripts/start_hub_server.sh` 启动
- 启动前先执行第 2 层检测
- 日志: `/tmp/agent-comm-hub-server.log`

---

## 故障恢复流程（全自动）

```
Hub 进程崩溃
    │
    ├─ launchd KeepAlive 检测到退出
    │
    └─ 自动重启 start_hub_server.sh
            │
            ├─ 执行 check_db_consistency.sh（第 2 层）
            │       │
            │       ├─ inode 一致 → 正常启动
            │       │
            │       └─ inode 不一致（分裂）
            │               │
            │               ├─ 自动合并 root DB + dist DB
            │               ├─ 去重，保留最新记录
            │               └─ 创建 symlink 兜底
            │
            └─ 启动 server.js → 监听 :3100
                    │
                    └─ cron 看门狗每 10 分钟巡检
                            │
                            ├─ 一切正常 → 静默退出（exit 0）
                            └─ 异常 → 告警
```

**无需人工介入** — 这是本方案的核心设计目标。

---

## 完成清单

| 层 | 完成者 | 状态 | 文件 |
|---|--------|------|------|
| 第1层 db.ts 四级回退 | Hermes | ✅ | `src/db.ts` → `dist/src/db.js` |
| 第2层 启动检测 | Hermes | ✅ | `scripts/check_db_consistency.sh` |
| 第3层 cron 看门狗 | WorkBuddy | ✅ | `scripts/cron_db_watchdog.sh` |
| launchd 自启动 | WorkBuddy | ✅ | `com.agent-comm-hub.server.plist` |

## 验证

- `curl localhost:3100/health` → 200 ✅
- WorkBuddy MCP 正常 ✅
- 看门狗测试 exit=0 静默 ✅
- 唯一 server.js 进程，无残留 ✅

---

## 经验教训

1. **DB 路径不匹配是根源** — 旧 troubleshooting doc 说"Hub 重启使所有 token 无效"，错。实际上是 server.js 读了错误的 DB 文件。复制 root DB 到 dist 即可恢复所有 token，无需重新注册。

2. **双 DB 竞争不报错** — SQLite 允许多个文件独立写入，没有任何错误提示。必须通过 inode 比对才能发现。

3. **最佳实践**: 启用任何 Node.js 服务时，明确设置所有路径环境变量，不要依赖 `__dirname` 的相对路径推导。

---

*最后更新: 2026-05-15*
