#!/bin/bash
# install.sh — Agent Communication Hub 一键安装
# 用法：bash install.sh [安装目录]
set -e

INSTALL_DIR="${1:-$HOME/agent-comm-hub}"

echo "=== Agent Communication Hub v3.0.19 安装 ==="
echo ""

echo "[1/4] 从 GitHub 克隆..."
git clone https://github.com/liuboacean/agent-comm-hub.git "$INSTALL_DIR" 2>/dev/null || {
    echo "     GitHub 克隆失败，请手动下载源码到 $INSTALL_DIR"
    exit 1
}

cd "$INSTALL_DIR"

# 版本固定：读取 package.json 的 version 并切到对应 git tag（与 B 层权威源一致）
HUB_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "3.0.19")
echo "目标版本：v$HUB_VERSION"
git -C "$INSTALL_DIR" checkout "v$HUB_VERSION" 2>/dev/null \
  || echo "     ⚠️ 未找到 v$HUB_VERSION tag，使用默认分支（请确认版本一致性）"

echo "[2/4] 安装 npm 依赖..."
npm install --production 2>&1 | tail -1

echo "[3/4] 编译 TypeScript..."
npm run build 2>&1 | tail -1

echo "[4/4] 验证..."
# v3 实际构建产物为 dist/src/server.js（注意：不要直接执行 server.js 验证，会启动服务并阻塞）
if [ -f "dist/src/server.js" ]; then
    echo "     编译产物验证通过 (dist/src/server.js)"
else
    echo "     ⚠️ 编译产物不存在 (dist/src/server.js)，请检查 TypeScript 编译"
    exit 1
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
