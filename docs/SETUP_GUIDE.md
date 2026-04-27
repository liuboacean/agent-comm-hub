# Agent Communication Hub — 部署指南

> 从零部署一个多智能体通信中心

## 前置条件

- Node.js 18+（推荐 20+）
- Python 3.9+（SDK 使用，可选）
- macOS / Linux（Windows 需 WSL）

## 方式一：一键安装（推荐）

```bash
bash ~/.workbuddy/skills/agent-comm-hub/scripts/install.sh
```

自动完成：克隆仓库 → 安装依赖 → 编译 TypeScript → 启动服务。

## 方式二：手动安装

### 1. 获取源码

```bash
# 如果已安装 Skill，源码在代码仓库
cd ~/WorkBuddy/<workspace>/agent-comm-hub

# 或从 GitHub 克隆
git clone https://github.com/<user>/agent-comm-hub.git
cd agent-comm-hub
```

### 2. 安装依赖

```bash
npm install
```

依赖清单（5 个）：
- `@modelcontextprotocol/sdk` — MCP 协议
- `express` — HTTP 服务器
- `better-sqlite3` — SQLite 数据库
- `zod` — 参数校验
- `eventsource` — SSE 客户端

### 3. 编译

```bash
npm run build
```

### 4. 启动

```bash
# 开发模式（热重载，推荐调试用）
npm run dev

# 生产模式
npm start
```

输出：
```
╔════════════════════════════════════════╗
║   Agent Communication Hub  v2.2.0     ║
║   Stateless Mode — Multi-Client       ║
╚════════════════════════════════════════╝
```

### 5. 验证

```bash
curl http://localhost:3100/health
# → {"status":"ok","version":"2.2.0",...}
```

## 注册 Agent

### 使用脚本（推荐）

```bash
bash ~/.workbuddy/skills/agent-comm-hub/scripts/setup_agent.sh "agent-name" "mcp,message,memory"
# 输出 agent_id 和 api_token
```

### 手动注册

1. 获取邀请码（需要已有 admin 权限的 Agent）：
```bash
# 通过 MCP 工具或直接 DB 操作生成邀请码
```

2. 调用 MCP 工具注册：
```json
{
  "name": "register_agent",
  "arguments": {
    "invite_code": "your-invite-code",
    "name": "my-agent",
    "capabilities": ["mcp", "message", "memory"]
  }
}
```

3. 保存返回的 `agent_id` 和 `token`。

## 配置 MCP 连接

### WorkBuddy / CodeBuddy

在 MCP 配置中添加：
```json
{
  "mcpServers": {
    "agent-comm-hub": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### Hermes

在 Hermes 的 MCP 配置中添加相同条目，然后在 `config.yaml` 中：
```yaml
mcp_servers:
  agent-comm-hub:
    url: http://localhost:3100/mcp
```

### 其他 MCP 兼容客户端

任何支持 MCP Streamable HTTP Transport 的客户端，配置 `http://localhost:3100/mcp` 即可。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3100 | 监听端口 |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `CORS_ORIGINS` | （空） | CORS 白名单，逗号分隔 |

## 数据库

SQLite WAL 模式，数据文件 `comm_hub.db`。

首次启动自动创建 17 张表 + FTS5 索引。无需手动 migration。

## 守护进程（可选）

### launchd（macOS）

```bash
# 创建 plist 文件
cat > ~/Library/LaunchAgents/com.agent-comm-hub.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-comm-hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/agent-comm-hub/dist/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/agent-comm-hub</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.agent-comm-hub.plist
```

## 多机部署

Hub 默认绑定 `localhost`。多机部署需要：

1. 设置 `HOST=0.0.0.0`（需修改 server.ts 或设环境变量）
2. 配置 `CORS_ORIGINS` 允许跨域
3. SQLite 不支持网络访问，需替换为 PostgreSQL（当前版本不支持）

## 端口冲突

```bash
# 检查端口占用
lsof -i :3100

# 使用其他端口
PORT=3200 npm start
```
