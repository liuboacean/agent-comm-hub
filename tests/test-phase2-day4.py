#!/usr/bin/env python3
"""
Phase 2 Week 2 Day 4 验收测试 — 记忆溯源 + trust_score 加权排序

验收标准：
- [P1] collective 记忆写入时自动记录 source_agent_id
- [P2] recall 结果中包含溯源信息（source_agent_id, source_task_id, source_trust_score）
- [P3] trust_score 高的 Agent 的记忆排名靠前
- [P4] set_trust_score 工具正常工作（admin only）
- [P5] private 记忆不记录 source_agent_id
- [P6] source_task_id 正确关联
- [P7] query_agents 返回 trust_score
- [R1] 现有 store/recall/list/delete 功能不回归
"""
import sys, os, json, time, sqlite3, subprocess, http.client as httplib, hashlib

HUB_HOST = "localhost"
HUB_PORT = 3100
DB = os.path.join(os.path.dirname(__file__), "..", "comm_hub.db")
HUB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NPX_BIN = "/opt/homebrew/bin/npx"

passed = 0
failed = 0

def log(ok, desc, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✅ {desc} — {detail}" if detail else f"  ✅ {desc}")
    else:
        failed += 1
        print(f"  ❌ {desc} — {detail}" if detail else f"  ❌ {desc}")

def http(method, path, data=None, headers=None, **kwargs):
    if headers is None:
        headers = {}
    body = json.dumps(data).encode() if data else b""
    try:
        conn = httplib.HTTPConnection(HUB_HOST, HUB_PORT, timeout=8)
        h = {"Content-Type": "application/json", "Accept": "application/json", "Connection": "close"}
        if body:
            h["Content-Length"] = str(len(body))
        h.update(headers)
        conn.request(method, path, body if body else None, h)
        resp = conn.getresponse()
        raw = b""
        while len(raw) < 131072:
            chunk = resp.read(4096)
            if not chunk:
                break
            raw += chunk
        conn.close()
        return resp.status, json.loads(raw.decode(errors="replace"))
    except Exception as e:
        return 0, {"error": str(e)}

def mcp_call(tool_name, args, token):
    """MCP tool call via HTTP — handles both JSON and SSE response formats."""
    import urllib.request
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": args}
    })
    try:
        req = urllib.request.Request(
            f"http://{HUB_HOST}:{HUB_PORT}/mcp",
            data=payload.encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
                "Connection": "close",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            decoded = resp.read().decode(errors="replace")

        # Try direct JSON parse
        try:
            jdata = json.loads(decoded)
            if isinstance(jdata, dict):
                if "result" in jdata and "content" in jdata["result"]:
                    text = jdata["result"]["content"][0]["text"]
                    return json.loads(text)
                elif "error" in jdata:
                    return {"success": False, "error": jdata["error"].get("message", str(jdata["error"]))}
            return jdata
        except json.JSONDecodeError:
            pass

        # SSE fallback: parse each data: line individually
        for line in decoded.split("\n"):
            stripped = line.strip()
            if not stripped.startswith("data:"):
                continue
            data_content = stripped[5:].strip()
            if not data_content or data_content == "[DONE]":
                continue
            try:
                jdata = json.loads(data_content)
                if isinstance(jdata, dict):
                    if "result" in jdata and "content" in jdata["result"]:
                        text = jdata["result"]["content"][0]["text"]
                        return json.loads(text)
                    elif "error" in jdata:
                        return {"success": False, "error": jdata["error"].get("message", str(jdata["error"]))}
            except json.JSONDecodeError:
                pass

        # Last resort: concatenate all data lines
        sse_data = ""
        for line in decoded.split("\n"):
            stripped = line.strip()
            if stripped.startswith("data:"):
                sse_data += stripped[5:].strip()
        if sse_data:
            try:
                jdata = json.loads(sse_data)
                if isinstance(jdata, dict):
                    if "result" in jdata and "content" in jdata["result"]:
                        text = jdata["result"]["content"][0]["text"]
                        return json.loads(text)
                    elif "error" in jdata:
                        return {"success": False, "error": jdata["error"].get("message", str(jdata["error"]))}
            except json.JSONDecodeError:
                pass

        return {"success": False, "error": f"Parse error: {decoded[:300]}"}
    except Exception as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}

def sha256hex(text):
    return hashlib.sha256(text.encode()).hexdigest()

def get_invite(role="member", admin_token=None):
    s, r = http("POST", "/admin/invite/generate", {"role": role},
                headers={"Authorization": f"Bearer {admin_token}"})
    return r.get("invite_code", "")

def register(name, role="member", admin_token=None):
    code = get_invite(role, admin_token)
    if not code:
        return None, None, f"Failed to get invite code for {name}"
    unique_name = f"{name}_{int(time.time())}"
    r = mcp_call("register_agent", {"invite_code": code, "name": unique_name}, "fake")
    return r.get("api_token"), r.get("agent_id"), r.get("error")

def get_db_trust_score(agent_id):
    try:
        conn = sqlite3.connect(DB)
        cur = conn.cursor()
        cur.execute("SELECT trust_score FROM agents WHERE agent_id=?", (agent_id,))
        row = cur.fetchone()
        conn.close()
        return row[0] if row else None
    except:
        return None

# ═══════════════════════════════════════════════════════════
print("=" * 60)
print("Phase 2 Week 2 Day 4 验收测试 — 记忆溯源 + trust_score")
print("=" * 60)

# ─── Pre: 健康检查 ──────────────────────────────────
print("\n[Pre] Hub 健康检查...")
s, r = http("GET", "/health")
log(s == 200, "Hub 在线", f"status={s}")

# ─── Setup: 获取 admin token ────────────────────────
print("\n[Setup] 准备 admin token...")
ADMIN_PLAIN_TOKEN = f"test_admin_day4_{int(time.time())}"
ADMIN_TOKEN_HASH = sha256hex(ADMIN_PLAIN_TOKEN)
admin_token_ready = False
admin_agent_id = None

try:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("SELECT agent_id FROM agents WHERE role='admin' LIMIT 1")
    row = cur.fetchone()
    if row:
        admin_agent_id = row[0]
        token_id = f"tok_test_day4_{int(time.time())}"
        now_ms = int(time.time() * 1000)
        cur.execute(
            "INSERT OR REPLACE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at) VALUES (?, 'api_token', ?, ?, 'admin', 1, ?, ?)",
            (token_id, ADMIN_TOKEN_HASH, admin_agent_id, now_ms, now_ms + 86400000)
        )
        conn.commit()
        conn.close()
        admin_token_ready = True
    else:
        conn.close()
except Exception as e:
    print(f"  WARNING: {e}")

# ─── 注册 4 个 Agent ──────────────────────────────
print("\n[Setup] 注册 Agent...")
alice_token, alice_id, alice_err = register("alice_d4", "member", ADMIN_PLAIN_TOKEN if admin_token_ready else None)
log(bool(alice_token) and bool(alice_id), "alice 注册成功", f"id={str(alice_id)[:20]}..." + (f" err={alice_err}" if alice_err else ""))

time.sleep(0.3)

bob_token, bob_id, bob_err = register("bob_d4", "member", ADMIN_PLAIN_TOKEN if admin_token_ready else None)
log(bool(bob_token) and bool(bob_id), "bob 注册成功", f"id={str(bob_id)[:20]}..." + (f" err={bob_err}" if bob_err else ""))

time.sleep(0.3)

charlie_token, charlie_id, charlie_err = register("charlie_d4", "member", ADMIN_PLAIN_TOKEN if admin_token_ready else None)
log(bool(charlie_token) and bool(charlie_id), "charlie 注册成功", f"id={str(charlie_id)[:20]}..." + (f" err={charlie_err}" if charlie_err else ""))

time.sleep(0.3)

admin_r = mcp_call("register_agent", {"invite_code": get_invite("admin", ADMIN_PLAIN_TOKEN if admin_token_ready else None), "name": f"admin_d4_{int(time.time())}"}, "fake")
admin_token = admin_r.get("api_token")
admin_id = admin_r.get("agent_id")
if not admin_token and admin_token_ready:
    admin_token = ADMIN_PLAIN_TOKEN
    admin_id = admin_agent_id
log(bool(admin_token) and bool(admin_id), "admin token 准备就绪", f"id={str(admin_id)[:20]}...")

time.sleep(0.5)

# ═══════════════════════════════════════════════════════════
# P 组：溯源功能测试
# ═══════════════════════════════════════════════════════════
print("\n[P 组] 溯源功能测试...")

# P1: collective 记忆自动记录 source_agent_id
r = mcp_call("store_memory", {"content": "溯源测试内容", "scope": "collective", "title": "溯源标题"}, alice_token)
ok_p1 = r.get("success") and r.get("source_agent_id") == alice_id
log(ok_p1, "P1 collective 自动记录 source_agent_id", f"source={str(r.get('source_agent_id', 'NONE'))[:20]}...")
mem1_id = r.get("memory_id")

time.sleep(0.3)

# P2: recall 结果包含溯源信息
r = mcp_call("recall_memory", {"query": "溯源标题", "scope": "collective"}, bob_token)
ok_p2 = False
p2_detail = "无结果"
if r.get("results") and len(r["results"]) > 0:
    first = r["results"][0]
    ok_p2 = ("source_agent_id" in first and "source_task_id" in first and "source_trust_score" in first)
    p2_detail = f"trust={first.get('source_trust_score')} sa={str(first.get('source_agent_id', ''))[:12]}..."
log(ok_p2, "P2 recall 返回溯源信息", p2_detail)

# P5: private 不记录 source_agent_id
r = mcp_call("store_memory", {"content": "私有记忆无溯源", "scope": "private"}, alice_token)
ok_p5 = r.get("success") and r.get("source_agent_id") is None
log(ok_p5, "P5 private 不记录 source_agent_id", f"source={r.get('source_agent_id')}")
mem_priv = r.get("memory_id")

# P6: source_task_id 关联
r = mcp_call("store_memory", {"content": "任务关联记忆", "scope": "collective", "source_task_id": "task_demo_456"}, alice_token)
ok_p6 = r.get("success") and r.get("source_task_id") == "task_demo_456"
log(ok_p6, "P6 source_task_id 正确关联", f"task={r.get('source_task_id')}")
mem6_id = r.get("memory_id")

# P7: query_agents 返回 trust_score
r = mcp_call("query_agents", {"status": "all"}, admin_token)
ok_p7 = any("trust_score" in a for a in (r.get("agents") or []))
log(ok_p7, "P7 query_agents 返回 trust_score", f"first_trust={next((a.get('trust_score') for a in (r.get('agents') or []) if 'trust_score' in a), 'N/A')}")

# ═══════════════════════════════════════════════════════════
# T 组：trust_score 功能测试
# ═══════════════════════════════════════════════════════════
print("\n[T 组] trust_score 功能测试...")

r = mcp_call("set_trust_score", {"agent_id": alice_id, "delta": 30}, admin_token)
ok_t1 = r.get("success") and r.get("new_score") == 80
log(ok_t1, "T1 alice +30 = 80", f"score={r.get('new_score')}")
log(get_db_trust_score(alice_id) == 80, "T1 DB 验证 alice=80", f"db={get_db_trust_score(alice_id)}")

time.sleep(0.3)

r = mcp_call("set_trust_score", {"agent_id": bob_id, "delta": -30}, admin_token)
ok_t2 = r.get("success") and r.get("new_score") == 20
log(ok_t2, "T2 bob -30 = 20", f"score={r.get('new_score')}")

time.sleep(0.3)

r = mcp_call("set_trust_score", {"agent_id": charlie_id, "delta": 10}, admin_token)
ok_t3 = r.get("success") and r.get("new_score") == 60
log(ok_t3, "T3 charlie +10 = 60", f"score={r.get('new_score')}")

# T4: member 不能设置 trust_score
r = mcp_call("set_trust_score", {"agent_id": bob_id, "delta": 10}, bob_token)
ok_t4 = not r.get("success") or "Permission" in str(r.get("error", ""))
log(ok_t4, "T4 member 被拒绝", f"error={str(r.get('error',''))[:50]}")

time.sleep(0.5)

# ═══════════════════════════════════════════════════════════
# P3: trust_score 加权排序测试
# ═══════════════════════════════════════════════════════════
print("\n[P3] trust_score 加权排序测试...")

r = mcp_call("store_memory", {"content": "排序关键词 alice 高信任", "scope": "collective", "title": "Alice高质量"}, alice_token)
log(r.get("success"), "存储 alice collective 1")
time.sleep(0.3)

r = mcp_call("store_memory", {"content": "排序关键词 alice 第二条", "scope": "collective", "title": "Alice第二条"}, alice_token)
log(r.get("success"), "存储 alice collective 2")
time.sleep(0.3)

r = mcp_call("store_memory", {"content": "排序关键词 bob 低信任", "scope": "collective", "title": "Bob低质量"}, bob_token)
log(r.get("success"), "存储 bob collective")
time.sleep(0.3)

r = mcp_call("store_memory", {"content": "排序关键词 charlie 中信任", "scope": "collective", "title": "Charlie中等"}, charlie_token)
log(r.get("success"), "存储 charlie collective")

time.sleep(1)

r = mcp_call("recall_memory", {"query": "排序关键词", "scope": "collective", "limit": 10}, admin_token)
ok_p3 = False
if r.get("results") and len(r["results"]) >= 4:
    scores = [res.get("source_trust_score", 0) for res in r["results"]]
    is_descending = all(scores[i] >= scores[i+1] for i in range(len(scores)-1))
    ok_p3 = is_descending
    log(ok_p3, f"P3 排序正确（递减）", f"scores={scores[:5]}")
else:
    log(False, "P3 排序测试", f"结果不足: {len(r.get('results', []))}")

time.sleep(0.5)

# ═══════════════════════════════════════════════════════════
# R 组：回归测试
# ═══════════════════════════════════════════════════════════
print("\n[R 组] 回归测试...")

r = mcp_call("store_memory", {"content": "回归测试 alpha", "scope": "private", "title": "回归标题"}, alice_token)
log(r.get("success"), "R1a store 成功")
time.sleep(0.3)

r = mcp_call("recall_memory", {"query": "回归标题", "scope": "private"}, alice_token)
log(r.get("results") and len(r["results"]) > 0, "R1b recall 成功", f"found={len(r.get('results', []))}")

r = mcp_call("list_memories", {"scope": "private", "limit": 5}, alice_token)
log(r.get("memories") is not None, "R2 list_memories", f"count={len(r.get('memories', []))}")

# R3: delete
r = mcp_call("store_memory", {"content": "待删除", "scope": "private"}, alice_token)
del_id = r.get("memory_id")
time.sleep(0.3)
r = mcp_call("delete_memory", {"memory_id": del_id}, alice_token)
log(r.get("success"), "R3 delete_memory", f"deleted={str(del_id)[:12]}...")

# R4: scope 隔离
r = mcp_call("recall_memory", {"query": "私有记忆无溯源", "scope": "private"}, bob_token)
log(not r.get("results") or len(r["results"]) == 0, "R4 scope 隔离")

# R5: group scope 记录溯源
r = mcp_call("store_memory", {"content": "组内共享带溯源", "scope": "group"}, alice_token)
ok_r5 = r.get("success") and r.get("source_agent_id") == alice_id
log(ok_r5, "R5 group 也记录 source_agent_id", f"source={str(r.get('source_agent_id', ''))[:20]}...")

time.sleep(0.5)

# R6: 信任分边界
r = mcp_call("set_trust_score", {"agent_id": alice_id, "delta": 30}, admin_token)
log(r.get("success") and r.get("new_score") == 100, "R6a 上限 100", f"score={r.get('new_score')}")

time.sleep(1)  # 等待速率限制窗口重置

# R6b: 下限测试 — alice 当前 100, delta=-100 应该到 0
time.sleep(1)
r = mcp_call("set_trust_score", {"agent_id": alice_id, "delta": -100}, admin_token)
ok_r6b = r.get("success") and r.get("new_score") == 0
log(ok_r6b, "R6b 下限 0", f"score={r.get('new_score')} db={get_db_trust_score(alice_id)} err={str(r.get('error',''))[:60]}")

# ═══════════════════════════════════════════════════════════
# DB 直查验证
# ═══════════════════════════════════════════════════════════
print("\n[DB 直查验证]")
try:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(memories)")
    mem_cols = [r[1] for r in cur.fetchall()]
    log("source_agent_id" in mem_cols and "source_task_id" in mem_cols, "memories 含溯源列")
    cur.execute("PRAGMA table_info(agents)")
    agent_cols = [r[1] for r in cur.fetchall()]
    log("trust_score" in agent_cols, "agents 含 trust_score 列")
    cur.execute("SELECT id, source_agent_id FROM memories WHERE source_agent_id IS NOT NULL LIMIT 3")
    src_rows = cur.fetchall()
    log(len(src_rows) >= 2, f"DB 中 {len(src_rows)} 条有溯源", f"first={src_rows[0] if src_rows else 'N/A'}")
    conn.close()
except Exception as e:
    log(False, "DB 直查", str(e))

# ═══════════════════════════════════════════════════════════
print(f"\n{'=' * 60}")
print(f"Phase 2 Week 2 Day 4 验收结果: {passed}✅ / {failed}❌ / {passed + failed} 总计")
print(f"{'=' * 60}")
sys.exit(0 if failed == 0 else 1)
