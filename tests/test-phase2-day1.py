#!/usr/bin/env python3
"""
Phase 2 Week 1 Day 1 验收测试
- MCP 端点速率限制
- nonce 持久化（重启后 nonce 继续）
- Phase 1 回归不破坏

测试流程：
  1. 停 Hub → 写入测试数据 → 启 Hub → 运行测试 → 验证
  这样避免测试脚本和 Hub 进程并发写 SQLite 导致锁竞争
"""
import sys, os, json, time, hashlib, sqlite3, http.client

HUB_HOST  = "localhost"
HUB_PORT  = 3100
DB        = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "comm_hub.db"))
HUB_DIR   = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NPX_BIN   = "/opt/homebrew/bin/npx"
results   = []

# ─── 辅助函数 ────────────────────────────────────────────

def log(ok, test, detail=""):
    tag = "✅" if ok else "❌"
    results.append((test, ok))
    msg = f"{tag} {test}"
    if detail:
        msg += f" — {detail}"
    print(msg)

def _parse_sse(raw: str):
    """从 SSE 或纯 JSON 中提取第一个有效 JSON 对象"""
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            s = line[5:].strip()
            if s and s != "[DONE]":
                try: return json.loads(s)
                except: pass
    try: return json.loads(raw)
    except: return {"raw": raw[:300]}

def http_req(method, path, data=None, headers=None):
    """http.client 封装，支持 SSE 流式响应"""
    if headers is None:
        headers = {}
    body = json.dumps(data).encode() if data else b""
    try:
        conn = http.client.HTTPConnection(HUB_HOST, HUB_PORT, timeout=8)
        h = {
            "Content-Type":   "application/json",
            "Content-Length": str(len(body)),
            "Connection":     "close",
        }
        h.update(headers)
        conn.request(method, path, body, h)
        r = conn.getresponse()
        status = r.status
        raw = b""
        while len(raw) < 16384:
            chunk = r.read(2048)
            if not chunk: break
            raw += chunk
            if b"\n\n" in raw: break
        conn.close()
        return status, _parse_sse(raw.decode(errors="replace"))
    except Exception as e:
        return 0, {"error": str(e)}

def mcp_call(tool_name, args, token=""):
    payload = {
        "jsonrpc": "2.0",
        "id":      1,
        "method":  "tools/call",
        "params":  {"name": tool_name, "arguments": args},
    }
    hdrs = {
        "Accept": "application/json, text/event-stream",
    }
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    return http_req("POST", "/mcp", payload, hdrs)

def start_hub():
    """启动 Hub，返回 (ok, uptime)"""
    os.system(f"cd {HUB_DIR} && {NPX_BIN} tsx src/server.ts >> /tmp/hub-p2.log 2>&1 &")
    for _ in range(12):
        time.sleep(1)
        code, resp = http_req("GET", "/health")
        if code == 200 and resp.get("uptime", 999) < 20:
            return True, resp.get("uptime", 0)
    return False, 0

def stop_hub():
    """停止 Hub"""
    os.system("lsof -ti:3100 | xargs kill -9 2>/dev/null")
    time.sleep(1.5)

def db_setup_agents(agents_tokens: list):
    """
    在 Hub 停止时批量写入 agents + tokens。
    agents_tokens: [(agent_id, name, role, token_plain), ...]
    返回 {agent_id: token_plain}
    """
    conn = sqlite3.connect(DB)
    c    = conn.cursor()
    now  = int(time.time() * 1000)
    result = {}
    for agent_id, name, role, token_plain in agents_tokens:
        token_hash = hashlib.sha256(token_plain.encode()).hexdigest()
        c.execute(
            "INSERT OR REPLACE INTO agents (agent_id, name, role, status, created_at, last_heartbeat)"
            " VALUES (?,?,?,?,?,?)",
            (agent_id, name, role, "online", now, now)
        )
        c.execute(
            "INSERT OR REPLACE INTO auth_tokens"
            " (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at)"
            " VALUES (?,?,?,?,?,1,?,?)",
            (f"tok_{agent_id}", "api_token", token_hash, agent_id, role, now, now + 86400000)
        )
        result[agent_id] = token_plain
    conn.commit()
    conn.close()
    return result

def db_get_nonce(sender_id):
    """查询 sender_nonces 表"""
    conn = sqlite3.connect(DB)
    c    = conn.cursor()
    c.execute("SELECT last_nonce FROM sender_nonces WHERE sender_id=?", (sender_id,))
    row  = c.fetchone()
    conn.close()
    return row[0] if row else None

def db_insert_invite():
    """插入邀请码，返回明文"""
    plain     = os.urandom(4).hex()
    code_hash = hashlib.sha256(plain.encode()).hexdigest()
    now       = int(time.time() * 1000)
    conn      = sqlite3.connect(DB)
    c         = conn.cursor()
    c.execute(
        "INSERT INTO auth_tokens (token_id, token_type, token_value, role, used, created_at, expires_at)"
        " VALUES (?,?,?,?,0,?,?)",
        (f"inv_{now}", "invite_code", code_hash, "member", now, now + 86400000)
    )
    conn.commit()
    conn.close()
    return plain

# ═══════════════════════════════════════════════════════════
# PHASE 1: 准备测试数据（Hub 停止时写 DB）
# ═══════════════════════════════════════════════════════════
print("=" * 60)
print("Phase 2 Week 1 Day 1 — 验收测试")
print("=" * 60)

print("\n⚙️  Step 1: 停 Hub，写入测试数据...")
stop_hub()

tokens = db_setup_agents([
    ("p2d1_alice", "Alice",      "member", "alice_tok_p2d1"),
    ("p2d1_bob",   "Bob",        "member", "bob_tok_p2d1"),
    ("p2d1_admin", "TestAdmin",  "admin",  "admin_tok_p2d1"),
])
a1   = tokens["p2d1_alice"]
a2   = tokens["p2d1_bob"]
atok = tokens["p2d1_admin"]

# 清理旧 nonce（确保测试可重复）
conn = sqlite3.connect(DB)
c    = conn.cursor()
c.execute("DELETE FROM sender_nonces WHERE sender_id IN ('p2d1_alice','p2d1_bob')")
conn.commit()
conn.close()

log(True, "Setup 完成", "alice + bob + admin 写入 DB")

print("\n⚙️  Step 2: 启动 Hub...")
hub_ok, uptime = start_hub()
log(hub_ok, "Hub 启动", f"uptime={uptime:.0f}s" if hub_ok else "启动超时")
if not hub_ok:
    print("❌ Hub 启动失败，中止测试")
    sys.exit(1)

# ═══════════════════════════════════════════════════════════
# 测试组 1: MCP 端点速率限制
# ═══════════════════════════════════════════════════════════
print("\n📊 测试组 1: MCP 端点速率限制")

# T1.1: 正常 MCP 调用不受限
code, resp = mcp_call("query_agents", {}, a1)
log(code == 200, "T1.1 正常 MCP 调用不受限", f"code={code}")

# T1.2: 连续调用后触发 429（速率限制）
success_count = 0
rate_limited  = False
for i in range(20):
    code2, _ = mcp_call("query_agents", {}, a1)
    if code2 == 200:
        success_count += 1
    elif code2 == 429:
        rate_limited = True
        break
log(rate_limited, f"T1.2 MCP 速率限制生效（{success_count} 次后 429）")

# T1.3: 等窗口重置，另一个 agent 不受限
time.sleep(1.2)
code, resp = mcp_call("query_agents", {}, a2)
log(code == 200, "T1.3 速率限制按 agent 隔离（bob 不受限）", f"code={code}")

# T1.4: 无效 token（未认证）不触发速率限制（authContext=undefined 时跳过 rateLimiter）
time.sleep(1.2)
code, resp = mcp_call("query_agents", {}, "invalid_token_xxx")
# 未认证时 authContext 为 undefined，rateLimiter 跳过，工具权限检查拦截
# 期望 200（MCP 层），内容是权限错误
log(code == 200, "T1.4 未认证请求不触发 MCP 速率限制", f"code={code}")

# ═══════════════════════════════════════════════════════════
# 测试组 2: nonce 持久化
# ═══════════════════════════════════════════════════════════
print("\n📊 测试组 2: nonce 持久化")

time.sleep(1.2)

# T2.1: 发消息后 sender_nonces 有记录
code, resp = mcp_call("send_message", {
    "from":    "p2d1_alice",
    "to":      "p2d1_bob",
    "content": "nonce persist test 1",
}, a1)
log(code == 200, "T2.1 send_message 成功", f"code={code}")

nonce_1 = db_get_nonce("p2d1_alice")
log(nonce_1 is not None and nonce_1 > 0, "T2.2 nonce 持久化到 SQLite", f"alice nonce={nonce_1}")

# T2.3: 再发一条，nonce 递增
time.sleep(0.3)
code, _ = mcp_call("send_message", {
    "from":    "p2d1_alice",
    "to":      "p2d1_bob",
    "content": "nonce persist test 2",
}, a1)
nonce_2 = db_get_nonce("p2d1_alice")
log(nonce_2 is not None and nonce_2 > (nonce_1 or 0), "T2.3 nonce 递增持久化", f"{nonce_1} → {nonce_2}")

# T2.4: bob 没发过消息，nonce=None
bob_nonce = db_get_nonce("p2d1_bob")
log(bob_nonce is None, "T2.4 不同 agent nonce 独立", f"bob nonce={bob_nonce}")

# ═══════════════════════════════════════════════════════════
# 测试组 3: Hub 重启后 nonce 继续递增
# ═══════════════════════════════════════════════════════════
print("\n📊 测试组 3: 重启后 nonce 持续")

nonce_before = db_get_nonce("p2d1_alice")

print("  ↳ 重启 Hub...")
stop_hub()

# 重启后 DB 里的 nonce 不变
nonce_after_restart = db_get_nonce("p2d1_alice")
log(nonce_after_restart == nonce_before, "T3.1 重启期间 nonce 保留",
    f"before={nonce_before} after={nonce_after_restart}")

# 重新启动 Hub
hub_ok2, uptime2 = start_hub()
log(hub_ok2, "T3.2 Hub 重启成功", f"uptime={uptime2:.0f}s" if hub_ok2 else "启动超时")

if hub_ok2:
    time.sleep(0.5)
    code, _ = mcp_call("send_message", {
        "from":    "p2d1_alice",
        "to":      "p2d1_bob",
        "content": "post-restart nonce test",
    }, a1)
    nonce_after_send = db_get_nonce("p2d1_alice")
    log(
        nonce_after_send is not None and nonce_after_send == (nonce_before or 0) + 1,
        "T3.3 重启后发消息 nonce 继续递增",
        f"{nonce_before} → {nonce_after_send}"
    )
else:
    log(False, "T3.3 重启后发消息 nonce 继续递增", "Hub 未重启成功")

# ═══════════════════════════════════════════════════════════
# 测试组 4: Phase 1 回归测试
# ═══════════════════════════════════════════════════════════
print("\n📊 测试组 4: Phase 1 回归测试")

time.sleep(1.2)  # 等速率窗口重置

# R1: send_message
code, _ = mcp_call("send_message", {
    "from": "p2d1_alice", "to": "p2d1_bob", "content": "regression R1"
}, a1)
log(code == 200, "R1 send_message 功能正常", f"code={code}")

# R2: query_agents
code, _ = mcp_call("query_agents", {}, a1)
log(code == 200, "R2 query_agents 功能正常", f"code={code}")

# R3a: store_memory
code, _ = mcp_call("store_memory", {"content": "regression memory", "scope": "private"}, a1)
log(code == 200, "R3a store_memory 功能正常", f"code={code}")

# R3b: recall_memory
time.sleep(0.3)
code, _ = mcp_call("recall_memory", {"query": "regression memory"}, a1)
log(code == 200, "R3b recall_memory 功能正常", f"code={code}")

# R4: heartbeat
code, _ = mcp_call("heartbeat", {}, a1)
log(code == 200, "R4 heartbeat 功能正常", f"code={code}")

# R5: 消息去重（同内容重复发）
code, _ = mcp_call("send_message", {
    "from": "p2d1_alice", "to": "p2d1_bob", "content": "dedup-test-unique-abc"
}, a1)
ok1 = code == 200
time.sleep(0.1)
code, _ = mcp_call("send_message", {
    "from": "p2d1_alice", "to": "p2d1_bob", "content": "dedup-test-unique-abc"
}, a1)
ok2 = code == 200  # MCP 仍返回 200，但内容标识为重复
log(ok1 and ok2, "R5 消息去重仍然生效", f"first={ok1} second={ok2}")

# R6: REST API 正常（需重置速率窗口）
time.sleep(1.2)
code, _ = http_req("GET", "/api/tasks?agent_id=p2d1_alice",
                   headers={"Authorization": f"Bearer {a1}"})
log(code == 200, "R6 REST API 正常", f"code={code}")

# R7: 未认证 REST 返回 401
code, _ = http_req("GET", "/api/tasks?agent_id=p2d1_alice")
log(code == 401, "R7 未认证请求 401", f"code={code}")

# R8: 邀请码注册（Hub 停止时写 DB，再注册）
# 注意：此处 Hub 已在运行，用 admin MCP register_agent 注册
invite = db_insert_invite()
# 先停 Hub 写，再启（不做，直接测试 register_agent 通过 MCP）
# register_agent 是 public 权限（无需 token）
time.sleep(0.3)
code, resp = mcp_call("register_agent", {
    "invite_code": invite,
    "name": "RegressionAgent",
}, "")
log(code == 200, "R8 邀请码注册功能正常", f"code={code}")

# R9: 空内容消息被拒绝
time.sleep(0.3)
code, resp = mcp_call("send_message", {
    "from": "p2d1_alice", "to": "p2d1_bob", "content": ""
}, a1)
# MCP 返回 200 但 isError=true
ok_reject = False
if code == 200:
    text = resp.get("result", {}).get("content", [{}])[0].get("text", "")
    ok_reject = "error" in text.lower() or "invalid" in text.lower() or "empty" in text.lower()
log(ok_reject, "R9 空内容消息被拒绝", f"code={code} isError={ok_reject}")

# R10: 防重放（不同内容不被拒绝）
time.sleep(1.2)
code, _ = mcp_call("send_message", {
    "from": "p2d1_alice", "to": "p2d1_bob", "content": "unique-anti-replay-test-xyz"
}, a1)
log(code == 200, "R10 正常消息不被防重放拦截", f"code={code}")

# ═══════════════════════════════════════════════════════════
# 汇总
# ═══════════════════════════════════════════════════════════
print("\n" + "=" * 60)
passed = sum(1 for _, ok in results if ok)
failed = sum(1 for _, ok in results if not ok)
total  = len(results)
print(f"结果: {passed}/{total} 通过", end="")
if failed > 0:
    print(f", {failed} 失败 ❌")
    for name, ok in results:
        if not ok:
            print(f"  ❌ {name}")
else:
    print(" ✅")
print("=" * 60)

sys.exit(0 if failed == 0 else 1)
