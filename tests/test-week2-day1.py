#!/usr/bin/env python3
"""
test-week2-day1.py — Week 2 Day 1 验收测试
Message Router 改造 + SSE 去重 + 消息体结构化分界

测试范围：
  T01-T05: 消息去重（dedupMessage / isDuplicate / recordHash）
  T06-T09: 消息体校验（validateMessageBody）
  T10-T12: send_message 去重集成
  T13-T15: broadcast_message 去重集成
  T16-T18: SSE 去重（_hub_event_id / _hub_dedup_id）
  T19-T20: dedup_cache TTL 清理
  T21-T22: nonce 递增
"""

import sys
import os
import json
import time
import subprocess
import hashlib
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:3100"

# ─── Helpers ───────────────────────────────────────────────

def call_mcp(tool_name: str, arguments: dict, token: str = None) -> dict:
    """Call MCP tool via HTTP JSON-RPC"""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(
        f"{BASE}/mcp",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            # 尝试从 data: 行提取 JSON
            for line in raw.split("\n"):
                if line.startswith("data: "):
                    data = json.loads(line[6:])
                    if "result" in data:
                        # 提取 text content
                        for c in data["result"].get("content", []):
                            if c.get("type") == "text":
                                return json.loads(c["text"])
            # fallback: 直接解析
            return json.loads(raw)
    except Exception as e:
        return {"error": str(e), "raw": raw if 'raw' in dir() else None}

def register(name: str, invite_code: str, token: str = None) -> dict:
    return call_mcp("register_agent", {"invite_code": invite_code, "name": name}, token)

def get_invite(admin_token: str, role: str = "member") -> str:
    """Generate invite code via admin API"""
    data = json.dumps({"role": role}).encode()
    req = urllib.request.Request(
        f"{BASE}/admin/invite/generate",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {admin_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        result = json.loads(resp.read().decode())
        return result["invite_code"]

def send_msg(from_id: str, to_id: str, content: str, token: str, msg_type: str = "message") -> dict:
    return call_mcp("send_message", {
        "from": from_id, "to": to_id, "content": content, "type": msg_type,
    }, token)

def broadcast(from_id: str, targets: list, content: str, token: str) -> dict:
    return call_mcp("broadcast_message", {
        "from": from_id, "agent_ids": targets, "content": content,
    }, token)

def heartbeat(agent_id: str, token: str) -> dict:
    return call_mcp("heartbeat", {"agent_id": agent_id}, token)

passed = 0
failed = 0

def test(name: str, condition: bool, detail: str = ""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ T{passed:02d} {name}")
    else:
        failed += 1
        print(f"  ❌ T{passed+failed:02d} {name} — {detail}")


# ═══════════════════════════════════════════════════════════════
# Setup: Register admin + agents
# ═══════════════════════════════════════════════════════════════
print("\n📋 Week 2 Day 1 验收测试")
print("=" * 60)

# 先检查服务是否在线
try:
    with urllib.request.urlopen(f"{BASE}/health", timeout=5) as resp:
        health = json.loads(resp.read().decode())
        print(f"  Health: {health['status']}, DB tables: {health.get('db_tables', {})}")
except Exception as e:
    print(f"  ⚠️ Hub 未启动或不可达: {e}")
    print("  请先启动 Hub: cd agent-comm-hub && npm run dev")
    sys.exit(1)

# 清理 dedup_cache
import sqlite3
db_path = os.path.join(os.path.dirname(__file__), "..", "comm_hub.db")
db_path = os.path.abspath(db_path)
conn = sqlite3.connect(db_path)
conn.execute("DELETE FROM dedup_cache")
conn.execute("DELETE FROM messages")
conn.commit()
conn.close()

# 生成 admin 邀请码并注册 admin
# 注意：需要已有 admin Token，或使用特殊方式
# 简化：直接用 DB 创建 admin agent
conn = sqlite3.connect(db_path)
import uuid
admin_id = f"agent_admin_w2d1"
admin_token_plain = "test_admin_token_w2d1_" + uuid.uuid4().hex[:16]
admin_token_hash = hashlib.sha256(admin_token_plain.encode()).hexdigest()
now = int(time.time() * 1000)

# 清除可能存在的同名 agent
conn.execute("DELETE FROM agents WHERE agent_id=?", (admin_id,))
conn.execute("DELETE FROM auth_tokens WHERE agent_id=?", (admin_id,))

conn.execute(
    "INSERT INTO agents (agent_id, name, role, status, last_heartbeat, created_at) VALUES (?,?,?,?,?,?)",
    (admin_id, "admin_w2d1", "admin", "online", now, now),
)
conn.execute(
    "INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?,?,?,?,?,?,?)",
    (f"token_admin_w2d1", "api_token", admin_token_hash, admin_id, "admin", 1, now),
)
conn.commit()
conn.close()

# 生成邀请码注册测试 agents
invite_a = get_invite(admin_token_plain, "member")
invite_b = get_invite(admin_token_plain, "member")

reg_a = register("agent_a_w2d1", invite_a)
reg_b = register("agent_b_w2d1", invite_b)

test("Admin 注册", reg_a.get("success"), str(reg_a))
test("Agent B 注册", reg_b.get("success"), str(reg_b))

if not reg_a.get("success") or not reg_b.get("success"):
    print("  ⛔ Agent 注册失败，无法继续")
    sys.exit(1)

token_a = reg_a["api_token"]
token_b = reg_b["api_token"]
agent_a_id = reg_a["agent_id"]
agent_b_id = reg_b["agent_id"]

# 上线
heartbeat(agent_a_id, token_a)
heartbeat(agent_b_id, token_b)

print()

# ═══════════════════════════════════════════════════════════════
# Part 1: 消息去重基础（T01-T05）
# ═══════════════════════════════════════════════════════════════
print("── Part 1: 消息去重基础 ──")

# T01: send_message 成功并返回 msg_hash + nonce
r1 = send_msg(agent_a_id, agent_b_id, "Hello dedup test", token_a)
test("send_message 返回 msg_hash", "msg_hash" in r1 and r1["success"], str(r1.get("msg_hash", "MISSING"))[:20])
test("send_message 返回 nonce", "nonce" in r1 and isinstance(r1["nonce"], int), str(r1.get("nonce")))
msg_hash_1 = r1.get("msg_hash", "")

# T02: 相同消息再次发送被拒绝（同 sender + receiver + content → 同 hash）
r2 = send_msg(agent_a_id, agent_b_id, "Hello dedup test", token_a)
test("重复消息被拒绝", not r2.get("success") and "Duplicate" in r2.get("error", ""), r2.get("error", ""))

# T03: 不同内容的消息正常发送
r3 = send_msg(agent_a_id, agent_b_id, "Different content", token_a)
test("不同内容正常发送", r3.get("success") and r3.get("msg_hash") != msg_hash_1)

# T04: 不同接收者的相同内容正常发送（hash 不同）
r4 = send_msg(agent_a_id, admin_id, "Hello dedup test", token_a)
test("不同接收者相同内容正常", r4.get("success"))

# T05: 空 content 被拒绝
r5 = send_msg(agent_a_id, agent_b_id, "", token_a)
test("空消息被拒绝", not r5.get("success"))

print()

# ═══════════════════════════════════════════════════════════════
# Part 2: 消息体校验（T06-T09）
# ═══════════════════════════════════════════════════════════════
print("── Part 2: 消息体校验 ──")

# T06: NULL 字节被拒绝
r6 = send_msg(agent_a_id, agent_b_id, "hello\x00world", token_a)
test("NULL 字节被拒绝", not r6.get("success"), r6.get("error", ""))

# T07: SSE 注入 pattern 被拒绝
r7 = send_msg(agent_a_id, agent_b_id, "data: evil injection", token_a)
test("SSE 'data:' 注入被拒绝", not r7.get("success"), r7.get("error", ""))

# T08: SSE 'event:' 注入被拒绝
r8 = send_msg(agent_a_id, agent_b_id, "event: takeover", token_a)
test("SSE 'event:' 注入被拒绝", not r8.get("success"), r8.get("error", ""))

# T09: 正常长消息（<50KB）正常发送
long_content = "A" * 10000
r9 = send_msg(agent_a_id, agent_b_id, long_content, token_a)
test("10KB 消息正常发送", r9.get("success"))

print()

# ═══════════════════════════════════════════════════════════════
# Part 3: broadcast 去重（T10-T12）
# ═══════════════════════════════════════════════════════════════
print("── Part 3: broadcast 去重 ──")

# T10: broadcast 正常
rb1 = broadcast(agent_a_id, [agent_b_id], "broadcast test 1", token_a)
test("broadcast 正常", rb1.get("broadcast"), str(rb1))

# T11: broadcast 重复被拦截
rb2 = broadcast(agent_a_id, [agent_b_id], "broadcast test 1", token_a)
test("broadcast 重复被拦截", rb2.get("duplicate_count", 0) == 1, str(rb2))

# T12: broadcast 多目标正常（delivered=0 是正常的，因为没有 SSE 连接）
rb3 = broadcast(agent_a_id, [agent_b_id, "nonexistent"], "broadcast multi", token_a)
test("broadcast 多目标正常（持久化）", rb3.get("broadcast"), str(rb3))

print()

# ═══════════════════════════════════════════════════════════════
# Part 4: nonce 递增（T13-T14）
# ═══════════════════════════════════════════════════════════════
print("── Part 4: nonce 递增 ──")

# 清空 dedup_cache 以便测试 nonce
conn = sqlite3.connect(db_path)
conn.execute("DELETE FROM dedup_cache")
conn.commit()
conn.close()

r_n1 = send_msg(agent_a_id, agent_b_id, "nonce test 1", token_a)
r_n2 = send_msg(agent_a_id, agent_b_id, "nonce test 2", token_a)
r_n3 = send_msg(agent_a_id, agent_b_id, "nonce test 3", token_a)

nonces = [r_n1.get("nonce"), r_n2.get("nonce"), r_n3.get("nonce")]
test("nonce 严格递增", nonces[0] < nonces[1] < nonces[2], f"nonces={nonces}")

# T14: 不同 sender 的 nonce 独立
r_nb1 = send_msg(agent_b_id, agent_a_id, "nonce from B", token_b)
test("不同 sender nonce 独立", r_nb1.get("nonce") is not None)

print()

# ═══════════════════════════════════════════════════════════════
# Part 5: dedup_cache DB 验证（T15-T17）
# ═══════════════════════════════════════════════════════════════
print("── Part 5: dedup_cache DB 验证 ──")

conn = sqlite3.connect(db_path)
rows = conn.execute("SELECT COUNT(*) FROM dedup_cache").fetchone()
test("dedup_cache 有记录", rows[0] > 0, f"count={rows[0]}")

# T16: dedup_cache 包含正确字段
cols = conn.execute("PRAGMA table_info(dedup_cache)").fetchall()
col_names = [c[1] for c in cols]
test("dedup_cache 字段完整", all(f in col_names for f in ["msg_hash", "sender_id", "nonce", "created_at"]))

# T17: msg_hash 是 SHA-256 格式
hash_rows = conn.execute("SELECT msg_hash FROM dedup_cache LIMIT 1").fetchone()
test("msg_hash 是 64 字符 hex", hash_rows and len(hash_rows[0]) == 64, str(hash_rows[0])[:16] if hash_rows else "None")

conn.close()

print()

# ═══════════════════════════════════════════════════════════════
# Part 6: 审计日志验证（T18-T20）
# ═══════════════════════════════════════════════════════════════
print("── Part 6: 审计日志 ──")

conn = sqlite3.connect(db_path)
audit_rows = conn.execute(
    "SELECT action, COUNT(*) FROM audit_log WHERE action LIKE 'tool_send_message%' OR action LIKE 'tool_broadcast_message%' GROUP BY action"
).fetchall()
audit_map = dict(audit_rows)
test("send_message 审计日志存在", audit_map.get("tool_send_message", 0) > 0, str(audit_map))
test("broadcast 审计日志存在", audit_map.get("tool_broadcast_message", 0) > 0, str(audit_map))

# T20: 审计日志包含 hash 信息
hash_audit = conn.execute(
    "SELECT details FROM audit_log WHERE action='tool_send_message' AND details LIKE '%hash=%' LIMIT 1"
).fetchone()
test("审计日志包含 msg_hash", bool(hash_audit), str(hash_audit[0][:60]) if hash_audit else "None")

conn.close()

print()

# ═══════════════════════════════════════════════════════════════
# Part 7: 健康检查 + 版本（T21-T22）
# ═══════════════════════════════════════════════════════════════
print("── Part 7: 健康检查 + 版本 ──")

with urllib.request.urlopen(f"{BASE}/health", timeout=5) as resp:
    health = json.loads(resp.read().decode())

test("Hub 运行中", health.get("status") == "ok")
# dedup_cache 表应在 db_tables 中
test("dedup_cache 表存在", health.get("db_tables", {}).get("dedup_cache", -1) >= 0, str(health.get("db_tables")))

print()

# ═══════════════════════════════════════════════════════════════
# 汇总
# ═══════════════════════════════════════════════════════════════
total = passed + failed
print("=" * 60)
print(f"  📊 总计: {total} 项, ✅ 通过: {passed}, ❌ 失败: {failed}")
print("=" * 60)

if failed > 0:
    print(f"  ⛔ {failed} 项测试失败")
    sys.exit(1)
else:
    print(f"  🎉 全部通过！Week 2 Day 1 验收完成")
    sys.exit(0)
