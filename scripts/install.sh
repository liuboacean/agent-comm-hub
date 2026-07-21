#!/bin/bash
# install.sh — 一键安装依赖并构建
set -e
cd "$(dirname "$0")"

echo "=== 安装 Agent Communication Hub ==="
echo ""

echo "[1/3] 安装 npm 依赖..."
npm install

echo "[2/3] 编译 TypeScript..."
npm run build

echo "[3/3] 验证构建..."
[ -f "dist/src/server.js" ] && echo "✅ 构建产物验证通过 (dist/src/server.js)" || echo "⚠️ 构建产物不存在: dist/src/server.js"

echo ""
echo "✅ 安装完成！使用以下命令启动："
echo "  开发模式:  npm run dev"
echo "  生产模式:  npm start"
echo "  端到端测试: npm test"
