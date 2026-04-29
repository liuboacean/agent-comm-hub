#!/bin/bash
# start-all.sh — 一键启动 Hub + 两个 Agent 模拟器
# 用于快速验证整个系统的运行效果

set -e

HUB_URL="http://localhost:3100"

echo "╔═══════════════════════════════════════════════╗"
echo "║   Agent Comm Hub  全栈启动                      ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# 检查端口占用
if lsof -i:3100 >/dev/null 2>&1; then
  echo "⚠️  端口 3100 已被占用，请先停止现有进程"
  echo "   kill \$(lsof -t -i:3100)"
  exit 1
fi

# 启动 Hub（后台）
echo ">>> 启动 MCP Hub Server (端口 3100)..."
cd "$(dirname "$0")/.."
npx tsx src/server.ts &
HUB_PID=$!
sleep 2

# 检查 Hub 是否启动成功
if curl -s "$HUB_URL/health" > /dev/null 2>&1; then
  echo "✅ Hub 启动成功"
else
  echo "❌ Hub 启动失败"
  kill $HUB_PID 2>/dev/null
  exit 1
fi

# 启动 WorkBuddy 模拟（后台）
echo ">>> 启动 WorkBuddy Agent 模拟..."
HUB_URL=$HUB_URL npx tsx client-sdk/workbuddy-integration.ts &
WB_PID=$!
sleep 1

# 启动 Hermes 模拟（后台）
echo ">>> 启动 Hermes Agent 模拟..."
HUB_URL=$HUB_URL HERMES_ID=hermes npx tsx client-sdk/hermes-integration.ts &
HM_PID=$!
sleep 1

echo ""
echo "═══════════════════════════════════════════════"
echo "  所有服务已启动！"
echo "  Hub PID:      $HUB_PID"
echo "  WorkBuddy:   $WB_PID"
echo "  Hermes:      $HM_PID"
echo ""
echo "  Hub 地址:     $HUB_URL"
echo "  SSE 订阅:     GET $HUB_URL/events/{agent_id}"
echo "  健康检查:     GET $HUB_URL/health"
echo ""
echo "  停止所有服务:  kill $HUB_PID $WB_PID $HM_PID"
echo "═══════════════════════════════════════════════"
echo ""

# 等待任意进程退出
wait -n $HUB_PID $WB_PID $HM_PID 2>/dev/null || true
echo ""
echo ">>> 检测到进程退出，正在清理..."
kill $HUB_PID $WB_PID $HM_PID 2>/dev/null
echo ">>> 已清理完成"
