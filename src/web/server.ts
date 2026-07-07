/**
 * web/server.ts — Web 管理面板静态文件托管（P2-7）
 *
 * 在 Express 基础上，将 Vite 构建产物（web/dist/）托管于 /dashboard 路径。
 * SPA 降级：未匹配到静态文件时返回 index.html。
 */
import { Router } from "express";
import { existsSync, readFileSync, statSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const WEB_DIST = join(__dirname, "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
};

/**
 * 创建面板静态文件路由器
 * 挂载到 /dashboard 路径
 */
export function createDashboardRouter(): Router {
  const router = Router();

  router.get("*", (req, res) => {
    // 解析请求路径，去掉 /dashboard 前缀
    let relativePath = req.path;
    if (!relativePath || relativePath === "/") relativePath = "/index.html";

    const filePath = join(WEB_DIST, relativePath);

    // 安全检查：防止目录遍历
    if (!filePath.startsWith(WEB_DIST)) {
      res.status(403).send("Forbidden");
      return;
    }

    // 如果文件存在，返回文件内容
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      if (stat.isFile()) {
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME[ext] ?? "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        res.send(readFileSync(filePath));
        return;
      }
    }

    // SPA 降级：返回 index.html
    const indexPath = join(WEB_DIST, "index.html");
    if (existsSync(indexPath)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(readFileSync(indexPath));
    } else {
      res.status(404).send("Dashboard not built. Run: cd web && npx vite build");
    }
  });

  return router;
}
