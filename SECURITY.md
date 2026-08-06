# Security Policy

## 🛡️ Supported Versions

我们只维护最新稳定线，旧版本不再接收安全补丁：

| 版本线 | 状态 |
|--------|------|
| `v3.0.x`（最新） | ✅ 受支持 |
| `< v3.0`（v2.5.x 及更早） | ❌ 不再维护 |

请始终升级到最新的 `v3.0.x` 发布以获得安全修复。

## 🔐  Reporting a Vulnerability

**首选方式：通过 GitHub 私有漏洞报告（Private Vulnerability Reporting）。**

1. 打开仓库 **Security** 选项卡 → **Report a vulnerability**（GitHub 私有安全公告）。
2. 提交后，维护者会在 **5 个工作日内** 确认收到并给出初步评估（严重级别、影响面、预计修复窗口）。
3. 确认有效后，我们会在私有分支中修复，并在修复发布时：
   - 在对应 GitHub Release 的 Release Notes 中注明安全修复；
   - 通过 GitHub Security Advisory 发布安全公告（含 CVE 编号，如适用）；
   - 通过漏洞报告对话私下通知原始报告者。
4. 在公开披露前，请不要在 Issue、Discussions 或任何公开渠道透露细节，以便我们留出修复与升级窗口。

> 我们**不**通过公开 Issue 或私人邮箱接收安全报告——请统一使用 GitHub 的私有漏洞报告机制，它能在披露前保持信息机密。

## 🏗️ 安全设计概览

Agent Communication Hub（ACH）在安全上采用「默认失败关闭（fail-closed）」原则，核心设计如下（详见 [README 安全体系章节](README.md#-安全体系)）：

- **4 级 RBAC 授权**：`public → member → group_admin → admin` 四级角色，权限矩阵 fail-closed，未显式授权的操作一律拒绝。
- **审计哈希链**：操作日志以区块链式哈希链存储（`prev_hash → record_hash`），由数据库触发器保障不可篡改，支持事后全量追溯。
- **Token 不落盘**：认证 Token 以 SHA-256 哈希存储，原始 Token 永不写入磁盘；受保护端点仅接受 `Bearer` 头，移除 `?token=` 与 `x-api-key` 等令牌泄漏面。
- **传输与网络**：CORS 白名单制 + `X-Frame-Options` / `CSP` / `HSTS` 等响应头加固。
- **限流与防 DoS**：认证前置的单 IP / 全局限流，以及 `/mcp` 并发在途上限，防止令牌爆破与资源耗尽。

感谢你帮助 ACH 保持安全 🤖✨
