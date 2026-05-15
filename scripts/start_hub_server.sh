#!/bin/bash
#
# start_hub_server.sh — launchd 专用启动脚本
# 由 com.agent-comm-hub.server.plist 调用
#

set -euo pipefail

HUB_DIR="/Users/liubo/WorkBuddy/20260416213415/agent-comm-hub"
cd "$HUB_DIR"

export PATH="/Users/liubo/.nvm/versions/node/v24.15.0/bin:$PATH"
export PORT=3100

# 第 2 层：启动前一致性检查
if [ -f "$HUB_DIR/scripts/check_db_consistency.sh" ]; then
  source "$HUB_DIR/scripts/check_db_consistency.sh"
else
  export DB_PATH="$HUB_DIR/comm_hub.db"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 server.js (DB_PATH=$DB_PATH)"
exec node dist/src/server.js
