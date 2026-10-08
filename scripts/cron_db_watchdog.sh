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
#   */10 * * * * /bin/bash <hub-install-path>/scripts/cron_db_watchdog.sh
#
# ─────────────────────────────────────────────────────────────────────────────
# 🔴 2026-10-08 重构（依据 he《方案-Hub分脑根因与看门狗改法-he-20261008》）
#
#   根因（he 机制实测）：外部进程以 `sqlite3 "file:<db>?mode=ro"` **直开 WAL 活库**
#   一轮，即会摘掉 `-wal`/`-shm` ⇒ hub 进程手里的 WAL 变**孤儿** ⇒ 其后写入对
#   读者不可见 ⇒ 累积成「分脑 ＋ 页级损坏」，且**一摘即自我延续**（换库/重启只治标）。
#
#   本件改动：
#     (1) 【废止直开】原第 5 节两处 `sqlite3 "file:$ROOT_DB?mode=ro"` **全部移除**；
#         结构检查（quick_check）与 FTS 漂移检查**一律改在 `cp` 出的一次性快照上做**，
#         绝不触碰活库。原注释「只读打开…属正常」系当时误解，与实测相反。
#     (2) 【新增探针】`-wal`/`-shm` 缺失探针：确证库为 WAL 模式且 server.js 存活，
#         而 `-wal`/`-shm` 缺失 ⇒ ALERT（疑被外部直开进程摘掉）。
#     (3) 【死代码修复】原结构探针置于「dist 为 symlink ⇒ exit 0」之后，**正常部署下
#         永不执行**（实测本机 `dist/comm_hub.db` 即为 symlink）。故把结构探针**前置**
#         为第 4 节，分裂检测降为第 5 节 ⇒ 探针每 10 分钟真正执行。
#     (4) 【超时】health 探针加 `--max-time 5`，避免 cron 进程堆积（原无超时）。
#
#   未覆盖（另案）：he 改法 3（stdio.js 改 HTTP 转发 3100）、改法 4
#   （`PRAGMA journal_mode=DELETE`）不在本件范围；`src/db.ts:23` 启动期
#   `readonly` 直开 probe 亦为候选直开点，待另批评估。
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HUB_DIR="${HUB_ROOT:-$SCRIPT_DIR/..}"
ROOT_DB="$HUB_DIR/comm_hub.db"
DIST_DB="$HUB_DIR/dist/comm_hub.db"
DB_PATH_ENV="${DB_PATH:-}"

# 一次性快照目录（EXIT 时清理）
SNAP_DIR=""
cleanup_snapshot() {
  if [ -n "$SNAP_DIR" ] && [ -d "$SNAP_DIR" ]; then
    rm -rf "$SNAP_DIR"
  fi
  return 0
}
trap cleanup_snapshot EXIT

# 取一份「主库 + WAL + SHM」快照到 $1/comm_hub.db
take_snapshot() {
  local d="$1"
  cp -p "$ROOT_DB" "$d/comm_hub.db" 2>/dev/null || true
  if [ -f "$ROOT_DB-wal" ]; then
    cp -p "$ROOT_DB-wal" "$d/comm_hub.db-wal" 2>/dev/null || true
  fi
  if [ -f "$ROOT_DB-shm" ]; then
    cp -p "$ROOT_DB-shm" "$d/comm_hub.db-shm" 2>/dev/null || true
  fi
}

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
HEALTH=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://localhost:3100/health 2>/dev/null || echo "000")
if [ "$HEALTH" != "200" ]; then
  echo "[ALERT] Hub health check 失败 (HTTP $HEALTH)"
  echo "[ALERT] server.js 可能僵死，请检查"
  exit 3
fi

# ─── 4. 活库保护与结构探针（2026-10-08 重构：禁直开活库）────
# 🔴 铁律：本脚本**绝不**直开活库；一切 sqlite3 操作只在 `cp` 出的快照上做。
if command -v sqlite3 > /dev/null 2>&1; then
  SNAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hub_watchdog.XXXXXX")"
  SNAP_DB="$SNAP_DIR/comm_hub.db"
  take_snapshot "$SNAP_DIR"

  # ── 4a. journal_mode 探针（读快照，不碰活库）────────────────
  SNAP_JOURNAL="$(sqlite3 "$SNAP_DB" "PRAGMA journal_mode;" 2>/dev/null || echo "")"

  # ── 4b. `-wal`/`-shm` 缺失探针（he 改法 2）──────────────────
  #   仅在**确证库为 WAL 模式**（且 server.js 已存活，见第 2 节）时开火，避免假阳性：
  #   非 WAL 库（如 journal_mode=DELETE）本就不应有 -wal/-shm；server 刚起且
  #   从未写入时 WAL 亦可未创建 —— 故以 journal_mode==wal 为告警前提。
  if [ "$SNAP_JOURNAL" = "wal" ]; then
    WAL_HAS=no; SHM_HAS=no
    [ -f "$ROOT_DB-wal" ] && WAL_HAS=yes
    [ -f "$ROOT_DB-shm" ] && SHM_HAS=yes
    if [ "$WAL_HAS" = "no" ] || [ "$SHM_HAS" = "no" ]; then
      echo "[ALERT] ⚠️  Hub 活库 WAL 侧文件缺失（疑似被外部直开进程摘掉）"
      echo "[ALERT] root DB: $ROOT_DB"
      echo "[ALERT] -wal 存在=$WAL_HAS   -shm 存在=$SHM_HAS"
      echo "[ALERT] 判据: journal_mode=wal ∧ server.js 存活 ⇒ -wal/-shm 应恒在"
      echo "[ALERT] 后果: hub 手里的 WAL 或已变孤儿，其后写入对读者不可见（分脑）"
      echo "[ALERT] 处置: ⚠️ 勿强杀 hub；读库走 API；干净停机后再启（把孤儿 WAL checkpoint 回主库）"
      exit 8
    fi
  fi

  # ── 4c. 结构完整性（quick_check，跑在快照上；失败重取一次降假阳性）──
  #   守卫：若快照本身不可用（mktemp/cp 失败 ⇒ 文件缺失或 0 字节），**跳过结构判定**，
  #   否则 sqlite3 会对不存在的快照报 `unable to open database file` ⇒ 误报「结构损坏」。
  SNAP_OK=no
  [ -s "$SNAP_DB" ] && SNAP_OK=yes
  DB_CHECK=""
  attempt=0
  while [ "$SNAP_OK" = "yes" ] && [ "$attempt" -lt 2 ]; do
    attempt=$((attempt + 1))
    DB_CHECK="$(sqlite3 "$SNAP_DB" "PRAGMA quick_check;" 2>&1 | head -5 || true)"
    if [ "$DB_CHECK" = "ok" ]; then
      break
    fi
    # 快照可能因复制竞态而不可用（空/打不开）⇒ 重取一份再判
    rm -rf "$SNAP_DIR"
    SNAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hub_watchdog.XXXXXX" 2>/dev/null || echo '')"
    if [ -z "$SNAP_DIR" ]; then
      SNAP_OK=no
      break
    fi
    SNAP_DB="$SNAP_DIR/comm_hub.db"
    take_snapshot "$SNAP_DIR"
    SNAP_OK=no
    [ -s "$SNAP_DB" ] && SNAP_OK=yes
  done
  if [ "$SNAP_OK" = "yes" ] && [ -n "$DB_CHECK" ] && [ "$DB_CHECK" != "ok" ]; then
    echo "[ALERT] ⚠️  Hub DB 结构完整性检查失败（quick_check，快照口径）"
    echo "[ALERT] $ROOT_DB"
    echo "[ALERT] 输出: $DB_CHECK"
    echo "[ALERT] 修复 SOP: 1) 字节级备份 db/-wal/-shm  2) sqlite3 old.db '.recover' | sqlite3 new.db"
    echo "[ALERT]          3) 重建 memories_fts / strategies_fts  4) VACUUM  5) 换库并重启 server.js"
    exit 6
  fi

  # ── 4d. FTS5 与主表行数一致性（快照口径）──────────────────
  FTS_DRIFT=""
  if [ "$SNAP_OK" = "yes" ]; then
    FTS_DRIFT="$(sqlite3 "$SNAP_DB" \
      "SELECT (SELECT COUNT(*) FROM memories) - (SELECT COUNT(*) FROM memories_fts);" 2>/dev/null || echo "")"
  fi
  if [ -n "$FTS_DRIFT" ] && [ "$FTS_DRIFT" != "0" ]; then
    echo "[ALERT] ⚠️  Hub FTS5 索引漂移：memories 比 memories_fts 多 $FTS_DRIFT 条"
    echo "[ALERT] 影响：search_memories / recall_memory 搜不到内容（但不报错，极易被忽略）"
    echo "[ALERT] 修复：sqlite3 $ROOT_DB \"INSERT INTO memories_fts(memories_fts) VALUES('rebuild');\""
    exit 7
  fi
fi

# ─── 5. 双 DB 分裂检测（原第 4 节）───────────────────────────

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
