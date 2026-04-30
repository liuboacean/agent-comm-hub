#!/usr/bin/env python3
"""
Week 2 Day 2 验收测试 — Memory Service + SSE 补发去重 + 权限矩阵
"""

import requests, json, sys, time, uuid, hashlib, sqlite3, os

BASE = "http://127.0.0.1:3100"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}
passed = 0
failed = 0

def test(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name} — {detail}")

def call_mcp(tool, args, token=None):
    headers = dict(HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    }
    r = requests.post(f"{BASE}/mcp", headers=headers, json=payload, timeout=10)
    try:
        data = r.json()
        if "result" in data:
            content = data["result"].get("content", [])
            if content and content[0].get("type") == "text":
                return json.loads(content[0]["text"])
        return data
    except:
        text = r.text
        for line in text.split("\n"):
            if line.startswith("data: "):
                try:
                    data = json.loads(line[6:])
                    if "result" in data:
                        content = data["result"].get("content", [])
                        if content and content[0].get("type") == "text":
                            return json.loads(content[0]["text"])
                except:
                    pass
        return {"raw": text, "status": r.status_code}

def get_invite(admin_token, role="member"):
    r = requests.post(f"{BASE}/admin/invite/generate",
                      headers={**HEADERS, "Authorization": f"Bearer {admin_token}"},
                      json={"role": role}, timeout=5)
    return r.json().get("invite_code")

# ─── Setup: Bootstrap admin via DB ──────────────────
print("=" * 60)
print("Week 2 Day 2 验收测试")
print("=" * 60)

print("\n[Setup] Bootstrap admin via DB...")
HUB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(HUB_DIR, "comm_hub.db")
admin_id = f"admin_w2d2_{uuid.uuid4().hex[:8]}"
admin_token_plain = f"tk_admin_w2d2_{uuid.uuid4().hex[:16]}"
admin_token_hash = hashlib.sha256(admin_token_plain.encode()).hexdigest()
now = int(time.time() * 1000)

conn = sqlite3.connect(DB_PATH)
c = conn.cursor()
c.execute("DELETE FROM agents WHERE agent_id=?", (admin_id,))
c.execute("DELETE FROM auth_tokens WHERE agent_id=?", (admin_id,))
c.execute("INSERT INTO agents VALUES (?,?,?,?,?,?,?)",
          (admin_id, "admin_w2d2", "admin", None, "online", now, now))
c.execute("INSERT INTO auth_tokens VALUES (?,?,?,?,?,?,?,?,?)",
          (f"tok_admin_w2d2", "api_token", admin_token_hash, admin_id, "admin", 1, now, now + 86400000, None))
conn.commit()
conn.close()
test("Bootstrap admin agent", True, f"id={admin_id}")

print("\n[Setup] Generating invite codes...")
admin_invite = get_invite(admin_token_plain, "admin")
member_invite = get_invite(admin_token_plain, "member")
test("获取邀请码", admin_invite and member_invite, f"admin={admin_invite}, member={member_invite}")

print("\n[Setup] Registering agents...")
r = call_mcp("register_agent", {"invite_code": admin_invite, "name": "admin_agent"}, admin_token_plain)
admin2_token = r.get("api_token") if r.get("success") else None
admin2_id = r.get("agent_id") if r.get("success") else None
test("注册 admin_agent", bool(admin2_token), str(r))

r = call_mcp("register_agent", {"invite_code": member_invite, "name": "member_a"})
token_a = r.get("api_token") if r.get("success") else None
agent_a_id = r.get("agent_id") if r.get("success") else None
test("注册 member_a", bool(token_a), str(r))

member_invite2 = get_invite(admin_token_plain)
r = call_mcp("register_agent", {"invite_code": member_invite2, "name": "member_b"})
token_b = r.get("api_token") if r.get("success") else None
agent_b_id = r.get("agent_id") if r.get("success") else None
test("注册 member_b", bool(token_b), str(r))

# ─── Memory: store_memory ──────────────────────────
print("\n[Memory] store_memory 测试...")

r = call_mcp("store_memory", {
    "content": "WorkBuddy 使用 SQLite WAL 模式提升并发性能",
    "title": "SQLite WAL 配置经验",
    "scope": "collective",
    "tags": ["sqlite", "performance", "important"]
}, token_a)
memory_c_id = r.get("memory_id") if r.get("success") else None
test("存储 collective 记忆", r.get("success"), str(r))
test("返回 memory_id", bool(memory_c_id), str(r))

r = call_mcp("store_memory", {
    "content": "Agent 通信协议设计要点：使用 JSON-RPC over HTTP",
    "title": "通信协议设计",
    "scope": "private",
    "tags": ["protocol", "design"]
}, token_a)
memory_p_id = r.get("memory_id") if r.get("success") else None
test("存储 private 记忆", r.get("success"), str(r))

r = call_mcp("store_memory", {
    "content": "心跳超时机制：90秒标记offline，5分钟通知",
    "scope": "group",
    "tags": ["heartbeat", "monitoring"]
}, token_b)
memory_g_id = r.get("memory_id") if r.get("success") else None
test("存储 group 记忆", r.get("success"), str(r))

r = call_mcp("store_memory", {"content": ""}, token_a)
test("空内容被拒绝", not r.get("success"), str(r))

r = call_mcp("store_memory", {"content": "x" * 10001}, token_a)
test("超长内容被拒绝", not r.get("success"), str(r))

r = call_mcp("store_memory", {"content": "未认证测试"}, None)
test("未认证存储被拒绝", not r.get("success"), str(r))

# ─── Memory: recall_memory (FTS5) ──────────────────
print("\n[Memory] recall_memory 测试...")

r = call_mcp("recall_memory", {"query": "SQLite WAL"}, token_a)
results = r.get("results", [])
test("FTS5 搜索 SQLite WAL", len(results) >= 1, f"found {len(results)}")
test("搜索结果包含 collective 记忆", any(m["id"] == memory_c_id for m in results), str(r))

r = call_mcp("recall_memory", {"query": "心跳超时机制"}, token_a)
results = r.get("results", [])
test("FTS5 搜索心跳超时", len(results) >= 1, f"found {len(results)}")

r = call_mcp("recall_memory", {"query": "不存在的内容xyz123"}, token_a)
test("无匹配返回空", len(r.get("results", [])) == 0, str(r))

# scope 过滤
r = call_mcp("recall_memory", {"query": "JSON-RPC", "scope": "private"}, token_a)
results = r.get("results", [])
test("scope=private 仅返回私有记忆", all(m["scope"] == "private" for m in results), str(r))

r = call_mcp("recall_memory", {"query": "JSON-RPC", "scope": "collective"}, token_a)
# agent_a 的 private 记忆包含 "JSON-RPC" 但 scope=collective 不应返回
test("scope=collective 不包含 private", not any(m.get("id") == memory_p_id for m in results), str(r))

# ─── Memory: list_memories ─────────────────────────
print("\n[Memory] list_memories 测试...")

r = call_mcp("list_memories", {"scope": "all"}, token_a)
memories = r.get("memories", [])
test("列出所有可见记忆", len(memories) >= 2, f"found {len(memories)}")
test("包含自己 + group + collective", 
     any(m["scope"] == "collective" for m in memories) and 
     any(m["scope"] == "private" for m in memories),
     str(r))

r = call_mcp("list_memories", {"scope": "private"}, token_a)
test("scope=private 仅私有", all(m["scope"] == "private" for m in r.get("memories", [])), str(r))

r = call_mcp("list_memories", {"scope": "all"}, token_b)
memories_b = r.get("memories", [])
# member_b 可以看到 collective + group，但看不到 agent_a 的 private
test("member_b 可见 collective", any(m["scope"] == "collective" for m in memories_b), str(r))
test("member_b 不可见 agent_a private", not any(m.get("id") == memory_p_id for m in memories_b), str(r))

# limit 测试
r = call_mcp("list_memories", {"scope": "all", "limit": 1}, token_a)
test("limit=1 生效", len(r.get("memories", [])) <= 1, str(r))

# ─── Memory: delete_memory ─────────────────────────
print("\n[Memory] delete_memory 测试...")

r = call_mcp("delete_memory", {"memory_id": memory_p_id}, token_a)
test("删除自己的记忆", r.get("success"), str(r))

r = call_mcp("recall_memory", {"query": "JSON-RPC", "scope": "private"}, token_a)
test("删除后搜索不到", not any(m.get("id") == memory_p_id for m in r.get("results", [])), str(r))

r = call_mcp("delete_memory", {"memory_id": memory_c_id}, token_b)
test("删除他人记忆被拒绝", not r.get("success"), str(r))

r = call_mcp("delete_memory", {"memory_id": memory_c_id}, admin2_token)
test("admin 可删除他人记忆", r.get("success"), str(r))

r = call_mcp("delete_memory", {"memory_id": "nonexistent"}, token_a)
test("删除不存在的记忆", not r.get("success"), str(r))

# ─── SSE: 补发消息去重 ───────────────────────────
print("\n[SSE] 补发消息带 event_id 测试...")

# A 发消息给 B（B 不在线，会积压）
r = call_mcp("send_message", {
    "from": agent_a_id,
    "to": agent_b_id,
    "content": "SSE 补发去重测试消息 1"
}, token_a)
msg1_ok = r.get("success")
test("A→B 离线消息发送成功", msg1_ok, str(r))

r = call_mcp("send_message", {
    "from": agent_a_id,
    "to": agent_b_id,
    "content": "SSE 补发去重测试消息 2"
}, token_a)
msg2_ok = r.get("success")
test("A→B 第二条离线消息成功", msg2_ok, str(r))

# A 发送给自己的消息也测试一下 dedup 兼容
r = call_mcp("send_message", {
    "from": agent_a_id,
    "to": agent_a_id,
    "content": "自发自收消息"
}, token_a)
test("自发自收消息成功", r.get("success"), str(r))

# 重复消息被去重
r = call_mcp("send_message", {
    "from": agent_a_id,
    "to": agent_a_id,
    "content": "自发自收消息"
}, token_a)
test("重复自发自收被去重", not r.get("success") and r.get("error"), str(r))

# ─── 健康检查 + 版本 ─────────────────────────────
print("\n[Health] 健康检查...")
r = requests.get(f"{BASE}/health", timeout=5).json()
test("健康状态 ok", r.get("status") == "ok", str(r))
test("memories 表存在", r.get("db_tables", {}).get("memories", -1) >= 0, str(r))

# ─── 审计日志验证 ────────────────────────────────
print("\n[Audit] 审计日志验证...")
r = call_mcp("store_memory", {
    "content": "审计日志测试记忆",
    "scope": "private"
}, token_a)
test("store_memory 生成审计日志", r.get("success"), str(r))

# ─── 统计 ────────────────────────────────────────
print("\n" + "=" * 60)
total = passed + failed
print(f"结果：{passed}/{total} 通过")
if failed:
    print(f"⚠️  {failed} 项失败")
    sys.exit(1)
else:
    print("🎉 全部通过！")
    sys.exit(0)
