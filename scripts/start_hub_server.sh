#!/bin/bash
#
# start_hub_server.sh — launchd 专用启动脚本
# 由 com.agent-comm-hub.server.plist 调用
#

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HUB_DIR"

# 使用 nvm 管理的 Node.js —— 固定 v22，匹配 better-sqlite3 原生模块(NODE_MODULE_VERSION 127)
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi
# 兜底：确保 node 为 v22（避免 nvm default 切到 v24 导致 better-sqlite3 ABI 不匹配崩溃）
export PATH="/Users/liubo/.nvm/versions/node/v22.22.2/bin:$PATH"
export PORT=3100

# 第 2 层：启动前一致性检查
if [ -f "$HUB_DIR/scripts/check_db_consistency.sh" ]; then
  source "$HUB_DIR/scripts/check_db_consistency.sh"
else
  export DB_PATH="$HUB_DIR/comm_hub.db"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 server.js (DB_PATH=$DB_PATH)"

# 确保 dist/package.json 存在：version.ts 启动期硬依赖 readFileSync("../package.json")，
# 缺失会导致 server 启动即崩。tsc 不会拷贝 package.json，故这里兜底同步。
if [ ! -f "dist/package.json" ] || [ "package.json" -nt "dist/package.json" ]; then
  cp -f package.json dist/package.json
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已同步 dist/package.json（version.ts 启动依赖）"
fi

exec node dist/src/server.js
