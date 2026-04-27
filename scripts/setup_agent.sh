#!/bin/bash
# setup_agent.sh — Agent 注册 + 认证自动化
# 用法：bash setup_agent.sh <agent-name> <capabilities>
# 示例：bash setup_agent.sh "my-agent" "mcp,message,memory"
set -e

AGENT_NAME="${1:?用法: setup_agent.sh <agent-name> <capabilities>}"
CAPABILITIES="${2:-mcp,message,memory}"
HUB_URL="${HUB_URL:-http://localhost:3100}"
DB_PATH="${3:-$HOME/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db}"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== Agent 注册工具 ==="
echo "名称: $AGENT_NAME"
echo "能力: $CAPABILITIES"
echo "Hub:  $HUB_URL"
echo ""

# 检查 Hub 是否在线
if ! curl -sf "$HUB_URL/health" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Hub 未运行 ($HUB_URL/health 无响应)${NC}"
    echo ""
    echo "请先启动 Hub："
    echo "  cd ~/agent-comm-hub && npm start"
    echo ""
    echo "或使用一键安装："
    echo "  bash ~/.workbuddy/skills/agent-comm-hub/scripts/install.sh"
    exit 1
fi

echo "[1/4] Hub 在线 ✅"

# 生成 Agent ID 和 Token
AGENT_ID="agent_$(openssl rand -hex 8)_$(date +%s)"
API_TOKEN="$(openssl rand -hex 32)"
TOKEN_HASH=$(echo -n "$API_TOKEN" | sha256sum | cut -d' ' -f1)

# 能力列表转为 JSON 数组
CAPS_JSON=$(echo "$CAPABILITIES" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | awk '{printf "\"%s\"", $0; if(NR>1) printf ", "}' | awk 'BEGIN{printf "["} {printf "%s", $0} END{printf "]"}')

# 写入数据库
echo "[2/4] 写入数据库..."

if command -v sqlite3 &>/dev/null; then
    # 检查 agents 表是否存在
    TABLE_EXISTS=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='agents';" 2>/dev/null)

    if [ -z "$TABLE_EXISTS" ]; then
        echo -e "${YELLOW}⚠️  数据库表不存在，请确保 Hub 已正确初始化${NC}"
        exit 1
    fi

    # 获取当前最大 agent_rowid
    MAX_ROWID=$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(rowid), 0) FROM agents;" 2>/dev/null)
    NEW_ROWID=$((MAX_ROWID + 1))

    # 插入 agent
    sqlite3 "$DB_PATH" <<EOSQL
INSERT INTO agents (agent_id, name, role, capabilities, status, trust_score, created_at, updated_at)
VALUES ('$AGENT_ID', '$AGENT_NAME', 'member', '$CAPABILITIES', 'offline', 50, datetime('now'), datetime('now'));
EOSQL

    # 插入 auth_token（token_type='api_token', used=1）
    sqlite3 "$DB_PATH" <<EOSQL
INSERT INTO auth_tokens (agent_id, token_hash, token_type, created_at, expires_at, used)
VALUES ('$AGENT_ID', '$TOKEN_HASH', 'api_token', datetime('now'), datetime('now', '+365 days'), 1);
EOSQL

    # 插入 capabilities
    for cap in $(echo "$CAPABILITIES" | tr ',' ' '); do
        cap=$(echo "$cap" | xargs)  # trim
        sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_capabilities (agent_id, capability) VALUES ('$AGENT_ID', '$cap');"
    done

    echo "     数据库写入 ✅"
else
    echo -e "${YELLOW}⚠️  sqlite3 未安装，无法直接写入数据库${NC}"
    echo ""
    echo "请手动注册（通过 MCP 工具 register_agent 或使用 Python SDK）"
    exit 1
fi

echo "[3/4] 验证注册..."
AGENT_CHECK=$(sqlite3 "$DB_PATH" "SELECT agent_id FROM agents WHERE agent_id='$AGENT_ID';" 2>/dev/null)
if [ "$AGENT_CHECK" = "$AGENT_ID" ]; then
    echo "     注册验证 ✅"
else
    echo "     ⚠️ 注册验证失败"
fi

echo "[4/4] 生成配置..."

# 输出配置信息
echo ""
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Agent 注册成功！${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}"
echo ""
echo "Agent ID:  $AGENT_ID"
echo "API Token: $API_TOKEN"
echo ""
echo "── MCP 配置 ──"
echo '{'
echo '  "mcpServers": {'
echo '    "agent-comm-hub": {'
echo '      "url": "http://localhost:3100/mcp"'
echo '    }'
echo '  }'
echo '}'
echo ""
echo "── 环境变量（写入 .env）──"
echo "HUB_URL=$HUB_URL"
echo "HUB_AGENT_ID=$AGENT_ID"
echo "HUB_API_TOKEN=$API_TOKEN"
echo ""
echo -e "${YELLOW}⚠️  请妥善保存 API Token，丢失后需重新生成！${NC}"
