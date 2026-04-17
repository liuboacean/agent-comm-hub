#!/bin/bash
# Agent Communication Hub 一键安装脚本
set -e

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "════════════════════════════════════════"
echo "  Agent Communication Hub Installer"
echo "════════════════════════════════════════"
echo "  安装目录: $HUB_DIR"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未找到 Node.js，请先安装 Node.js 18+"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 版本过低（当前 v$NODE_VERSION），需要 18+"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# 检查 Python 3
if ! command -v python3 &> /dev/null; then
    echo "❌ 未找到 Python 3"
    exit 1
fi
echo "✅ Python $(python3 --version)"

# 安装 Hub 服务器依赖
echo ""
echo "📦 安装 Hub 服务器依赖..."
cd "$HUB_DIR"
npm install

# 创建数据库目录
mkdir -p "$(dirname "$HUB_DIR")"

echo ""
echo "════════════════════════════════════════"
echo "  ✅ 安装完成！"
echo "════════════════════════════════════════"
echo ""
echo "启动 Hub 服务器："
echo "  cd $HUB_DIR && npm run dev"
echo ""
echo "配置 Agent 接入："
echo "  在 Agent 的 MCP 配置中添加："
echo '  { "mcpServers": { "agent-comm-hub": { "url": "http://localhost:3100/mcp" } } }'
echo ""
