/**
 * web/server.ts — Web 管理面板静态文件托管（P2-7）
 *
 * 在 Express 基础上，将 Vite 构建产物（web/dist/）托管于 /dashboard 路径。
 * SPA 降级：未匹配到静态文件时返回 index.html。
 */
import { Router } from "express";
/**
 * 创建面板静态文件路由器
 * 挂载到 /dashboard 路径
 */
export declare function createDashboardRouter(): Router;
