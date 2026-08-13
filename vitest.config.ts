import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "node:url";

// vitest.config.ts 在 ESM（package.json "type": "module"）下 __dirname 不可用，
// 直接用会导致别名 replacement 的 path.resolve(undefined, ...) 抛错、别名静默失效
// （表现为 "Cannot find module '../../client-sdk/...js'"）。
// 用 fileURLToPath(import.meta.url) 正确推导目录，保证别名 client-sdk/(.+)\.js$ -> .ts 生效。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    // 让 vitest 直接 transform TS 源码（不依赖预编译的 .js）
    // 这样 v8 coverage 能正确映射到 .ts 文件
    transformMode: {
      web: ["js", "ts"],
      ssr: ["js", "ts"],
    },
    deps: {
      inline: ["better-sqlite3"],  // native module，不做 transform
    },
    coverage: {
      provider: "v8",
      reporter: ["text"],
      clean: false,
      cleanOnRerun: false,
      // 覆盖编译后的 .js 文件，通过 source map 映射回 .ts
      include: ["src/**/*.js"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.d.ts.map",
        "src/tools/**/*.js",  // tools/ 是 MCP handler 包装层，逻辑在核心模块
        "src/server.js",
        "src/stdio.js",
      ],
      thresholds: {
        // 核心模块分支覆盖率门禁
        "src/security.ts": { branches: 70, functions: 70 },
        "src/dedup.ts": { branches: 60, functions: 70 },
        "src/utils.ts": { branches: 60, functions: 60 },
        // 整体阈值（151 测试全过，覆盖率实测 40%+，设保守基线）
        lines: 35,
        branches: 25,
        functions: 35,
        statements: 35,
      },
    },
  },
  resolve: {
    // client-sdk 与 src 目录同时存在源码 .ts 与陈旧编译 .js（如 agent-client.js 是 5 月旧构建，
    // 尚未导出 8 月新增的 AuthorizationRejected/AuthorizationExpired）。
    // Vite 默认 extensions 把 .js 放在 .ts 前，会优先解析到陈旧 .js，导致跨模块类 instanceof 身份不一致。
    // 这里把 .ts 提到 .js 之前，保证“无扩展名”的导入一律走源码 .ts。
    extensions: [".mjs", ".ts", ".mts", ".js", ".jsx", ".tsx", ".json"],
    alias: [
      // 将项目内“相对路径的 .js 导入”改写为 .ts 源码，覆盖两类场景：
      //  1) 测试里的 "../../client-sdk/xxx.js"
      //  2) 源码内部的相对导入 "./agent-client.js"（runtime.ts 内即如此，旧的 client-sdk/(.+)\.js$ 别名
      //     因要求 "client-sdk/" 前缀而匹配不到这类相对导入，导致它解析到陈旧 .js、AuthorizationRejected 为 undefined）
      // 只匹配以 ./ 或 ../ 开头的相对导入，不会误伤 node_modules 的裸模块说明符。
      // 注意 replacement 必须保留相对前缀（$1 含 "../../client-sdk/xxx" 或 "./agent-client"），否则会生成畸形路径。
      { find: /(\.\.?\/.*)\.js$/, replacement: "$1.ts" },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
});
