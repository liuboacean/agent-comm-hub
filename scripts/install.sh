#!/bin/bash
# install.sh — Agent Communication Hub 一键安装
# 用法：bash install.sh [安装目录]
set -e

INSTALL_DIR="${1:-$HOME/agent-comm-hub}"

echo "=== Agent Communication Hub v2.2 安装 ==="
echo ""

echo "[1/4] 从 GitHub 克隆..."
git clone https://github.com/liuboacean/agent-comm-hub.git "$INSTALL_DIR" 2>/dev/null || {
    echo "     GitHub 克隆失败，请手动下载源码到 $INSTALL_DIR"
    exit 1
}

cd "$INSTALL_DIR"

echo "[2/4] 安装 npm 依赖..."
npm install --production 2>&1 | tail -1

echo "[3/4] 编译 TypeScript..."
npm run build 2>&1 | tail -1

echo "[4/4] 验证..."
if node dist/server.js --help 2>/dev/null; then
    echo "     构建成功!"
else
    # 验证编译产物存在
    if [ -f "dist/server.js" ]; then
        echo "     编译产物验证通过"
    else
        echo "     ⚠️ 编译产物不存在，请检查 TypeScript 编译"
        exit 1
    fi
fi

echo ""
echo "✅ 安装完成!"
echo ""
echo "启动命令："
echo "  cd $INSTALL_DIR"
echo "  npm run dev    # 开发模式（热重载）"
echo "  npm start      # 生产模式"
echo ""
echo "注册 Agent："
echo "  bash ~/.workbuddy/skills/agent-comm-hub/scripts/setup_agent.sh <name> <capabilities>"
echo ""
echo "MCP 端点：http://localhost:3100/mcp"
echo "健康检查：http://localhost:3100/health"
