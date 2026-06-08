#!/bin/bash
#
# start_hub_server.sh — launchd 专用启动脚本
# 由 com.agent-comm-hub.server.plist 调用
#

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HUB_DIR"

# 使用 nvm 管理的 Node.js（如果存在），否则使用系统 node
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi
export PORT=3100

# 第 2 层：启动前一致性检查
if [ -f "$HUB_DIR/scripts/check_db_consistency.sh" ]; then
  source "$HUB_DIR/scripts/check_db_consistency.sh"
else
  export DB_PATH="$HUB_DIR/comm_hub.db"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 server.js (DB_PATH=$DB_PATH)"
exec node dist/src/server.js
