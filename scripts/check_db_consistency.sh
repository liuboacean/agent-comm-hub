#!/bin/bash
#
# check_db_consistency.sh — 双 DB 分裂检测与修复脚本（防护第 2 层）
#
# 每次启动 server.js 前执行，确保不会出现两个 comm_hub.db 的悲剧。
# 2026-05-15 双 DB 分裂事故永久防护。
#
# 检测逻辑：
#   1. 对比 root/comm_hub.db 和 dist/comm_hub.db 的 inode
#   2. 若不同 → 分裂已发生，自动合并 dist → root，重命名 dist 旧文件
#   3. 强制 export DB_PATH 指向 root
#
# 使用方式：
#   source check_db_consistency.sh && node dist/src/server.js
#   或单独执行检查：
#   bash check_db_consistency.sh --check-only

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DB="$HUB_DIR/comm_hub.db"
DIST_DB="$HUB_DIR/dist/comm_hub.db"
SQLITE3="$(command -v sqlite3 || echo "")"

log_info()  { echo "[INFO]  $*"; }
log_warn()  { echo "[WARN]  $*"; }
log_error() { echo "[ERROR] $*"; }

check_only=false
if [ "${1:-}" = "--check-only" ]; then
  check_only=true
fi

# ─── Step 1: 检查 root DB 是否存在 ────────────────────────
if [ ! -f "$ROOT_DB" ]; then
  log_error "root DB 不存在: $ROOT_DB"
  log_error "请先初始化数据库，或设置 DB_PATH 环境变量"
  exit 1
fi
ROOT_INODE=$(stat -f%i "$ROOT_DB" 2>/dev/null)
log_info "root DB: $ROOT_DB (inode=$ROOT_INODE)"

# ─── Step 2: 检查 dist DB 状态 ────────────────────────────
if [ -L "$DIST_DB" ]; then
  DIST_TARGET=$(readlink "$DIST_DB")
  if [ "$DIST_TARGET" = "$ROOT_DB" ]; then
    log_info "dist DB 是 symlink → root DB ✅（指向正确）"
    DIST_INODE=-1  # 标记为一致，跳过分裂检测
  else
    log_warn "dist DB 是 symlink 但指向错误目标: $DIST_TARGET"
    log_warn "预期: $ROOT_DB"
    DIST_INODE=-2
  fi
elif [ ! -e "$DIST_DB" ]; then
  log_info "dist DB 不存在（首次运行，无分裂风险）"
  DIST_INODE=-1
else
  DIST_INODE=$(stat -f%i "$DIST_DB" 2>/dev/null)
  log_info "dist DB: $DIST_DB (inode=$DIST_INODE)"
fi

# ─── Step 3: 检测分裂 ─────────────────────────────────────
if [ "$DIST_INODE" != -1 ] && [ "$DIST_INODE" != "$ROOT_INODE" ]; then
  log_warn "===================================================="
  log_warn "  双 DB 分裂检测到！"
  log_warn "  root inode=$ROOT_INODE  ≠  dist inode=$DIST_INODE"
  log_warn "===================================================="

  if $check_only; then
    log_info "仅检查模式，退出码 2 表示分裂"
    exit 2
  fi

  # ── Step 3a: 合并 dist → root（最佳努力，失败不阻塞后续步骤） ──
  if [ -x "$SQLITE3" ]; then
    log_info "正在合并 dist DB 到 root DB..."
    if "$SQLITE3" "$DIST_DB" ".schema messages" &>/dev/null; then
      if "$SQLITE3" "$ROOT_DB" ".restore $DIST_DB" 2>&1; then
        log_info "合并完成（.restore）"
      else
        # fallback: dump & import
        "$SQLITE3" "$DIST_DB" ".dump" | "$SQLITE3" "$ROOT_DB" 2>/dev/null && \
          log_info "合并完成（.dump 回退）" || \
          log_warn "合并失败（跳过，dist DB 已备份可手动恢复）"
      fi
    else
      log_warn "dist DB 不是有效 SQLite 数据库，跳过合并"
    fi
  else
    log_warn "sqlite3 不可用，跳过合并"
  fi

  # ── Step 3b: 重命名 dist 旧文件 ──
  BAK_NAME="$DIST_DB.$(date +%Y%m%d%H%M%S).bak"
  mv "$DIST_DB" "$BAK_NAME"
  log_info "已重命名旧 dist DB → $BAK_NAME"

  # 如果有 shm/wal，也带上
  for ext in "-shm" "-wal"; do
    file="${DIST_DB}${ext}"
    [ -f "$file" ] && mv "$file" "${BAK_NAME}${ext}" && log_info "  连带移动: $file"
  done

  log_info "分裂已修复"
fi

# ─── Step 4: 创建 symlink（安全带）─────────────────────────
# 让任何误写 dist/comm_hub.db 的代码实际写入 root DB
if [ ! -L "$DIST_DB" ] && [ ! -e "$DIST_DB" ]; then
  log_info "创建 symlink: dist/comm_hub.db → root/comm_hub.db"
  mkdir -p "$(dirname "$DIST_DB")"
  ln -sf "$ROOT_DB" "$DIST_DB"
  log_info "symlink 创建成功"
elif [ ! -L "$DIST_DB" ] && [ -f "$DIST_DB" ]; then
  log_warn "dist DB 是普通文件（不是 symlink），检查 symlink 一致性..."
  if [ "$DIST_INODE" != "$ROOT_INODE" ]; then
    log_warn "inode 不同，替换为 symlink"
    rm "$DIST_DB"
    ln -sf "$ROOT_DB" "$DIST_DB"
    log_info "已替换为 symlink"
  fi
fi

# ─── Step 5: 导出 DB_PATH（供调用者使用）───────────────────
export DB_PATH="$ROOT_DB"
log_info "已设置 DB_PATH=$DB_PATH"

# ─── 完成 ───────────────────────────────────────────────────
if $check_only; then
  log_info "一致性检查通过 ✅"
  exit 0
fi

log_info "一致性检查通过，准备启动 server.js..."
