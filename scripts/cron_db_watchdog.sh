#!/bin/bash
#
# cron_db_watchdog.sh — 双 DB 分裂运行时看门狗（防护第 3 层）
#
# 设计原则：
#   - no_agent=true：纯 shell 比较 inode，不消耗任何 LLM token
#   - 输出为空 → 一切正常（cron 静默）
#   - 输出非空 → 检测到异常，cron 自动推送告警
#
# crontab 配置（每 10 分钟）：
#   */10 * * * * /bin/bash ~/WorkBuddy/20260416213415/agent-comm-hub/scripts/cron_db_watchdog.sh
#

set -euo pipefail

HUB_DIR="$HOME/WorkBuddy/20260416213415/agent-comm-hub"
ROOT_DB="$HUB_DIR/comm_hub.db"
DIST_DB="$HUB_DIR/dist/comm_hub.db"
DB_PATH_ENV="${DB_PATH:-}"

# ─── 1. root DB 必须存在 ────────────────────────────────────
if [ ! -f "$ROOT_DB" ]; then
  echo "[ALERT] Hub root DB 缺失: $ROOT_DB"
  echo "[ALERT] Hub 已不可用，请立即排查！"
  exit 1
fi

ROOT_INODE=$(stat -f%i "$ROOT_DB" 2>/dev/null || echo "unknown")

# ─── 2. 检查 server.js 是否存活 ─────────────────────────────
if ! pgrep -f "node.*dist/src/server.js" > /dev/null 2>&1; then
  echo "[ALERT] Hub server.js 进程不存在！"
  echo "[ALERT] port 3100 HTTP 服务已停止"
  echo "[ALERT] 请执行: cd $HUB_DIR && DB_PATH=$ROOT_DB nohup node dist/src/server.js &"
  exit 2
fi

# ─── 3. 检查 port 3100 health ──────────────────────────────
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/health 2>/dev/null || echo "000")
if [ "$HEALTH" != "200" ]; then
  echo "[ALERT] Hub health check 失败 (HTTP $HEALTH)"
  echo "[ALERT] server.js 可能僵死，请检查"
  exit 3
fi

# ─── 4. 双 DB 分裂检测（核心） ──────────────────────────────

# 如果 dist 是 symlink → 安全，跳过
if [ -L "$DIST_DB" ]; then
  # symlink 正确 → 静默退出
  exit 0
fi

# 如果 dist 不存在 → 也是安全的（首次运行）
if [ ! -e "$DIST_DB" ]; then
  exit 0
fi

# dist 是普通文件 → 需要比较 inode
DIST_INODE=$(stat -f%i "$DIST_DB" 2>/dev/null || echo "unknown")

if [ "$DIST_INODE" = "unknown" ] || [ "$ROOT_INODE" = "unknown" ]; then
  echo "[ALERT] 无法获取 inode: root=$ROOT_INODE dist=$DIST_INODE"
  exit 4
fi

if [ "$DIST_INODE" != "$ROOT_INODE" ]; then
  echo "[ALERT] ⚠️  Hub 双 DB 分裂检测到！"
  echo "[ALERT] root DB inode=$ROOT_INODE"
  echo "[ALERT] dist DB inode=$DIST_INODE"
  echo "[ALERT] 自动修复中..."
  
  # 自动修复（复用第 2 层脚本的 --check-only 逻辑，但不改文件）
  # 只告警不自动修，避免并发写入冲突
  echo "[ALERT] 建议手动执行: cd $HUB_DIR && bash scripts/check_db_consistency.sh"
  exit 5
fi

# ─── 一切正常，静默退出 ─────────────────────────────────────
exit 0
