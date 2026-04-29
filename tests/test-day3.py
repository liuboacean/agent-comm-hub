#!/usr/bin/env python3
"""
Day 3 验收测试 — Phase 1 Week 1 Day 3
核心：心跳超时检测（90s → offline, 5min → notify）

测试策略：
  - Day 1-2 回归：认证、邀请码、注册、工具权限
  - Day 3 核心：心跳超时（通过直接修改 DB last_heartbeat 模拟）

系统可用 Python 命令：python3
"""

import json
import subprocess
import sys
import time
import sqlite3
import requests

HUB_URL = "http://localhost:3100"
DB_PATH = "/Users/liubo/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db"

passed = 0
failed = 0
total = 0

def test(name, condition, detail=""):
    global passed, failed, total
    total += 1
    if condition:
        passed += 1
        print(f"  ✅ T{total:02d}: {name}")
    else:
        failed += 1
        print(f"  ❌ T{total:02d}: {name} {detail}")
        if detail:
            print(f"         → {detail}")

def call_mcp(tool_name, arguments, token=None, raw=False):
    """调用 MCP 工具"""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    }
    
    resp = requests.post(f"{HUB_URL}/mcp", json=payload, headers=headers, timeout=10)
    
    if raw:
        return resp
    
    # Parse SSE response — format: "event: message\ndata: {json}\n\n"
    text = resp.text.strip()
    
    # 尝试直接解析（如果是纯 JSON）
    try:
        return json.loads(text)
    except:
        pass
    
    # 尝试从 SSE data 行提取
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            json_str = line[6:]
            try:
                data = json.loads(json_str)
                if "result" in data:
                    for content in data["result"].get("content", []):
                        if content.get("type") == "text":
                            inner = content["text"]
                            # inner 可能是嵌套 JSON 字符串
                            try:
                                return json.loads(inner)
                            except:
                                return {"_text": inner}
                if "error" in data:
                    return {"_error": data["error"]}
            except json.JSONDecodeError:
                pass
    
    return {"_raw": text, "_status": resp.status_code}

def get_db():
    return sqlite3.connect(DB_PATH)

def set_agent_heartbeat(agent_id, heartbeat_ms_ago):
    """直接设置 Agent 的 last_heartbeat 为 N 毫秒前"""
    db = get_db()
    new_time = int(time.time() * 1000) - heartbeat_ms_ago
    db.execute("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?", (new_time, agent_id))
    db.commit()
    db.close()

def get_agent_status(agent_id):
    """从 DB 查询 Agent 状态"""
    db = get_db()
    row = db.execute("SELECT status, last_heartbeat FROM agents WHERE agent_id = ?", (agent_id,)).fetchone()
    db.close()
    return row

# ═══════════════════════════════════════════════════════════
print("=" * 60)
print("Day 3 验收测试 — Phase 1 Week 1 Day 3")
print("=" * 60)

# ── Section 1: 基础功能回归（Day 1-2） ─────────────────
print("\n--- Section 1: 基础功能回归 ---")

# T01: Health check 免认证
resp = requests.get(f"{HUB_URL}/health")
data = resp.json()
test("Health check 免认证", data.get("status") == "ok" and "db_tables" in data)

# T02: 无 Token 请求被拒绝
resp = requests.get(f"{HUB_URL}/api/tasks?agent_id=test")
test("无 Token → 401", resp.status_code == 401)

# T03: 无效 Token 被拒绝
resp = requests.get(f"{HUB_URL}/api/tasks?agent_id=test", headers={"Authorization": "Bearer invalid"})
test("无效 Token → 401", resp.status_code == 401)

# T04: 需要先创建 admin Token 来生成邀请码
# 直接通过 DB 创建 admin agent + token
db = get_db()
admin_token_plain = "admin_test_token_" + str(int(time.time()))
from security_utils import sha256
admin_hash = sha256(admin_token_plain)
now = int(time.time() * 1000)

db.execute("INSERT OR IGNORE INTO agents (agent_id, name, role, status, created_at) VALUES (?, ?, ?, 'offline', ?)",
           ("admin_bootstrap", "Bootstrap Admin", "admin", now))
db.execute("INSERT OR REPLACE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?, 'api_token', ?, ?, 'admin', 1, ?)",
           ("admin_bootstrap_token", admin_hash, "admin_bootstrap", now))
db.commit()
db.close()

# T05: Admin Token 有效
resp = requests.post(f"{HUB_URL}/admin/invite/generate",
                     json={},
                     headers={"Authorization": f"Bearer {admin_token_plain}"})
test("Admin Token 生成邀请码", resp.status_code == 200 and resp.json().get("success"))
invite_code = resp.json().get("invite_code", "")

# T06: 无效邀请码注册失败
result = call_mcp("register_agent", {"invite_code": "wrong_code", "name": "BadAgent"})
test("无效邀请码 → 注册失败", result.get("success") == False or "_error" in result)

# T07: 有效邀请码注册成功
result = call_mcp("register_agent", {"invite_code": invite_code, "name": "TestAgent", "capabilities": ["mcp", "sse"]})
test("有效邀请码 → 注册成功", result.get("success") == True)
agent_id = result.get("agent_id")
agent_token = result.get("api_token")
test("返回 agent_id", bool(agent_id))
test("返回 api_token", bool(agent_token))

# T08: 用新 Token 调用 heartbeat
result = call_mcp("heartbeat", {"agent_id": agent_id}, token=agent_token)
test("heartbeat 成功", result.get("success") == True)
test("Agent 状态 online", result.get("status") == "online")

# T09: 查询 Agent 列表
result = call_mcp("query_agents", {"status": "all"}, token=agent_token)
test("query_agents 返回列表", isinstance(result.get("agents"), list))
test("Agent 列表包含 TestAgent", any(a.get("name") == "TestAgent" for a in result.get("agents", [])))

# T10: 未认证调用 member 工具 → 被拒绝
result = call_mcp("send_message", {"from": "test", "to": "test2", "content": "hello"})
test("未认证 send_message → 权限拒绝", "_error" in result or "Permission denied" in str(result) or "Authentication required" in str(result))

# T11: 未认证调用 heartbeat → 被拒绝
result = call_mcp("heartbeat", {"agent_id": agent_id})
test("未认证 heartbeat → 被拒绝", "_error" in result or "Permission denied" in str(result) or "Authentication required" in str(result))

# T12: member 调用 admin 工具 → 被拒绝
result = call_mcp("revoke_token", {"token_id": "any"}, token=agent_token)
test("member 调用 revoke_token → 被拒绝", "_error" in result or "Permission denied" in str(result))

# ── Section 2: Day 3 核心 — 心跳超时检测 ──────────────
print("\n--- Section 2: 心跳超时检测（Day 3 核心） ---")

# T13: heartbeat 更新 DB 中的 last_heartbeat
status = get_agent_status(agent_id)
test("Agent DB 状态为 online", status is not None and status[0] == "online")
test("last_heartbeat 已更新", status is not None and status[1] is not None)

# T14: 模拟心跳超时 90s — 标记 offline
set_agent_heartbeat(agent_id, 95_000)  # 95 秒前的心跳

# 等待心跳监控触发（30s 间隔 + 少量缓冲）
print("  ⏳ 等待心跳监控触发（最长 35s）...")
for i in range(7):  # 最多等 35 秒
    time.sleep(5)
    status = get_agent_status(agent_id)
    if status and status[0] == "offline":
        break

status = get_agent_status(agent_id)
test("90s 无心跳 → 自动标记 offline", status is not None and status[0] == "offline",
     f"实际状态: {status}")

# T15: Agent 重新发送心跳 → 恢复 online
result = call_mcp("heartbeat", {"agent_id": agent_id}, token=agent_token)
test("重新 heartbeat → 恢复 online", result.get("success") == True and result.get("status") == "online")

status = get_agent_status(agent_id)
test("DB 状态恢复 online", status is not None and status[0] == "online")

# T16: 审计日志记录
db = get_db()
rows = db.execute("SELECT action FROM audit_log ORDER BY created_at DESC LIMIT 5").fetchall()
db.close()
actions = [r[0] for r in rows]
test("审计日志记录了 agent_registered", "agent_registered" in actions or "tool_register_agent" in actions)
test("审计日志记录了 agent_offline", "agent_offline" in actions)

# ── Section 3: send_message 兼容性 ─────────────────────
print("\n--- Section 3: send_message 兼容性 ---")

# 注册第二个 Agent 用于消息测试
resp = requests.post(f"{HUB_URL}/admin/invite/generate",
                     json={},
                     headers={"Authorization": f"Bearer {admin_token_plain}"})
invite_code_2 = resp.json().get("invite_code")
result2 = call_mcp("register_agent", {"invite_code": invite_code_2, "name": "AgentB"})
agent_id_b = result2.get("agent_id")
token_b = result2.get("api_token")

# T17: A 发消息给 B
result = call_mcp("send_message", {
    "from": agent_id,
    "to": agent_id_b,
    "content": "Hello from TestAgent",
    "type": "message"
}, token=agent_token)
test("A→B 发消息成功", result.get("success") == True)

# T18: 查询 B 的未读消息
resp = requests.get(f"{HUB_URL}/api/messages?agent_id={agent_id_b}&status=unread",
                    headers={"Authorization": f"Bearer {token_b}"})
data = resp.json()
test("B 有未读消息", data.get("count", 0) >= 1)

# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print(f"验收结果：{passed}/{total} 通过，{failed} 失败")
print("=" * 60)

if failed > 0:
    print("⚠️  存在失败测试项，需要修复后重新验证")
    sys.exit(1)
else:
    print("🎉 所有测试通过！Day 3 验收完成")
    sys.exit(0)
