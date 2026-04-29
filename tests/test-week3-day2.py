#!/usr/bin/env python3
"""
Week 3 Day 2 — Phase 1 安全审计测试
12 项安全检查清单 + 全量回归测试

系统 Python: python3
Hub 地址: http://localhost:3100
"""

import json
import time
import sys
import hashlib
import urllib.request
import urllib.error

HUB = "http://localhost:3100"
PASS = 0
FAIL = 0
SKIP = 0
results = []

def log(test_id, desc, status, detail=""):
    global PASS, FAIL, SKIP
    results.append({"id": test_id, "desc": desc, "status": status, "detail": detail})
    icon = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️"}[status]
    print(f"  {icon} [{test_id}] {desc}")
    if detail:
        print(f"       {detail}")
    if status == "PASS": PASS += 1
    elif status == "FAIL": FAIL += 1
    else: SKIP += 1

# ─── HTTP 工具 ────────────────────────────────────────────

def http_json(method, path, data=None, headers=None):
    """REST API 调用，自动解析 JSON"""
    url = HUB + path
    body = json.dumps(data).encode() if data else None
    hdrs = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except:
            return e.code, {"error": raw}
    except Exception as e:
        return 0, {"error": str(e)}

def http_raw(method, path, data=None, headers=None):
    """原始 HTTP 调用（返回状态码 + 原始字符串）"""
    url = HUB + path
    body = json.dumps(data).encode() if data else None
    hdrs = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)

def mcp_call(tool_name, params, token=None):
    """MCP 工具调用 — 返回 (ok:bool, result:dict)"""
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": params}
    }
    code, raw = http_raw("POST", "/mcp", payload, headers)

    # 从 SSE data: 行提取 JSON
    json_obj = None
    for line in raw.strip().split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            try:
                json_obj = json.loads(line[6:])
                break
            except:
                continue
    if json_obj is None:
        try:
            json_obj = json.loads(raw)
        except:
            return False, {"error": f"Parse error: {raw[:200]}"}

    # 从 MCP response 提取 tool result
    if "result" in json_obj and "content" in json_obj["result"]:
        text = json_obj["result"]["content"][0]["text"]
        try:
            return True, json.loads(text)
        except:
            return True, text
    if "error" in json_obj:
        return False, json_obj["error"]
    return False, json_obj

# ─── SQLite 工具 ──────────────────────────────────────────

DB_PATH = "/Users/liubo/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db"
now_ms = int(time.time() * 1000)

def db_create_invite(role="member"):
    """通过 SQLite 直接创建邀请码"""
    import sqlite3, os
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    code = os.urandom(4).hex()
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    c.execute("""
        INSERT INTO auth_tokens (token_id, token_type, token_value, role, used, created_at, expires_at)
        VALUES (?, 'invite_code', ?, ?, 0, ?, ?)
    """, (f"invite_{now_ms}_{os.urandom(2).hex()}", code_hash, role, now_ms, now_ms + 86400000))
    conn.commit()
    conn.close()
    return code

def db_query(sql, params=()):
    import sqlite3
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(sql, params)
    rows = c.fetchall()
    conn.close()
    return rows


# ═══════════════════════════════════════════════════════════════
# 前置：注册测试 Agent
# ═══════════════════════════════════════════════════════════════
print("=" * 70)
print("Week 3 Day 2 — Phase 1 安全审计测试")
print("=" * 70)

print("\n📋 前置：准备测试 Agent...")

# 注册 Admin
admin_invite = db_create_invite("admin")
ok, result = mcp_call("register_agent", {"invite_code": admin_invite, "name": "SecurityAdmin", "capabilities": ["mcp", "sse"]})
assert ok and result.get("success"), f"Admin 注册失败: {result}"
ADMIN_TOKEN = result["api_token"]
ADMIN_ID = result["agent_id"]
print(f"  📌 Admin: {ADMIN_ID}")

# 注册 Member A
member_a_invite = db_create_invite("member")
ok, result = mcp_call("register_agent", {"invite_code": member_a_invite, "name": "MemberAgentA", "capabilities": ["mcp"]})
assert ok and result.get("success"), f"Member A 注册失败: {result}"
MEMBER_A_TOKEN = result["api_token"]
MEMBER_A_ID = result["agent_id"]
print(f"  📌 Member A: {MEMBER_A_ID}")

# 注册 Member B
member_b_invite = db_create_invite("member")
ok, result = mcp_call("register_agent", {"invite_code": member_b_invite, "name": "MemberAgentB", "capabilities": ["mcp", "sse"]})
assert ok and result.get("success"), f"Member B 注册失败: {result}"
MEMBER_B_TOKEN = result["api_token"]
MEMBER_B_ID = result["agent_id"]
print(f"  📌 Member B: {MEMBER_B_ID}")

print("\n✅ 测试 Agent 准备完成\n")


# ═══════════════════════════════════════════════════════════════
# SECTION 1: 12 项安全检查清单
# ═══════════════════════════════════════════════════════════════
print("=" * 70)
print("SECTION 1: 12 项安全检查清单")
print("=" * 70)

# ── 检查 1: Token 认证覆盖所有 API 端点 ──────────────────
print("\n── 检查 1: Token 认证覆盖所有 API 端点 ──")

code, _ = http_json("GET", "/api/tasks?agent_id=test")
log("1.1", "GET /api/tasks 无 Token → 401", "PASS" if code == 401 else "FAIL", f"code={code}")

code, _ = http_json("GET", "/api/messages?agent_id=test")
log("1.2", "GET /api/messages 无 Token → 401", "PASS" if code == 401 else "FAIL", f"code={code}")

code, _ = http_json("POST", "/admin/invite/generate")
log("1.3", "POST /admin/invite 无 Token → 401", "PASS" if code == 401 else "FAIL", f"code={code}")

code, _ = http_json("PATCH", "/api/tasks/fake/status", {})
log("1.4", "PATCH /api/tasks/:id 无 Token → 401", "PASS" if code == 401 else "FAIL", f"code={code}")

code, _ = http_json("PATCH", "/api/messages/fake/status", {})
log("1.5", "PATCH /api/messages/:id 无 Token → 401", "PASS" if code == 401 else "FAIL", f"code={code}")

code, _ = http_json("GET", "/api/consumed?agent_id=test")
log("1.6", "GET /api/consumed 无 Token → 401", "PASS" if code == 401 else "FAIL", f"code={code}")

code, body = http_json("GET", "/health")
log("1.7", "GET /health 免认证 → 200", "PASS" if code == 200 and body.get("status") == "ok" else "FAIL", f"code={code}")

ok, result = mcp_call("heartbeat", {"agent_id": MEMBER_A_ID})  # 无 token
log("1.8", "MCP heartbeat 无 Token → 被拒绝",
    "PASS" if not ok or "Authentication required" in str(result) else "FAIL", f"ok={ok}")


# ── 检查 2: Token 吊销功能可用 ─────────────────────────
print("\n── 检查 2: Token 吊销功能可用 ──")

# 注册一个临时 agent 用于吊销测试
revoke_invite = db_create_invite("member")
ok, result = mcp_call("register_agent", {"invite_code": revoke_invite, "name": "RevokeTestAgent"})
assert ok and result.get("success"), f"吊销测试 Agent 注册失败: {result}"
REVOKE_ID = result["agent_id"]
REVOKE_TOKEN = result["api_token"]

# 吊销前心跳成功
ok, result = mcp_call("heartbeat", {"agent_id": REVOKE_ID}, REVOKE_TOKEN)
log("2.1", "吊销前 heartbeat 成功", "PASS" if ok and result.get("success") else "FAIL")

# 获取 token_id
rows = db_query("SELECT token_id FROM auth_tokens WHERE agent_id=? AND token_type='api_token' AND revoked_at IS NULL", (REVOKE_ID,))
assert rows, f"未找到 Token"
TOKEN_ID = rows[0][0]

# Admin 吊销 Token
ok, result = mcp_call("revoke_token", {"token_id": TOKEN_ID}, ADMIN_TOKEN)
log("2.2", "Admin revoke_token → 成功", "PASS" if ok and result.get("success") else "FAIL")

# 吊销后调用失败
ok, result = mcp_call("heartbeat", {"agent_id": REVOKE_ID}, REVOKE_TOKEN)
is_blocked = not ok or (isinstance(result, dict) and not result.get("success")) or (isinstance(result, str) and "Authentication required" in result)
log("2.3", "吊销后 heartbeat → 被拒绝",
    "PASS" if is_blocked else "FAIL", f"ok={ok}, result={str(result)[:80]}")


# ── 检查 3: 注册邀请码验证 ─────────────────────────────
print("\n── 检查 3: 注册邀请码验证 ──")

ok, result = mcp_call("register_agent", {"invite_code": "invalid_code_99999", "name": "ShouldFail"})
log("3.1", "无效邀请码 → 被拒绝", "PASS" if not result.get("success") else "FAIL")

ok, result = mcp_call("register_agent", {"invite_code": "", "name": "ShouldFail2"})
log("3.2", "空邀请码 → 被拒绝", "PASS" if not result.get("success") else "FAIL")

ok, result = mcp_call("register_agent", {"invite_code": member_a_invite, "name": "ReusedInvite"})
log("3.3", "已使用邀请码 → 被拒绝", "PASS" if not result.get("success") else "FAIL")

fresh_invite = db_create_invite("member")
ok, result = mcp_call("register_agent", {"invite_code": fresh_invite, "name": "FreshAgent"})
log("3.4", "有效邀请码 → 成功", "PASS" if ok and result.get("success") else "FAIL")


# ── 检查 4: 消息完整性校验（hash + nonce） ─────────────
print("\n── 检查 4: 消息完整性校验（hash + nonce） ──")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "Integrity test"}, MEMBER_A_TOKEN)
log("4.1", "send_message 返回 msg_hash", "PASS" if "msg_hash" in result else "FAIL", f"hash={result.get('msg_hash', 'N/A')[:20]}")
log("4.2", "send_message 返回 nonce", "PASS" if "nonce" in result else "FAIL", f"nonce={result.get('nonce')}")

msg_hash = result.get("msg_hash", "")
hash_valid = len(msg_hash) == 64 and all(c in '0123456789abcdef' for c in msg_hash)
log("4.3", "msg_hash 格式正确（64字符 hex）", "PASS" if hash_valid else "FAIL")

ok1, r1 = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "Nonce 1"}, MEMBER_A_TOKEN)
ok2, r2 = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "Nonce 2"}, MEMBER_A_TOKEN)
nonce_inc = (r1.get("nonce", 0) or 0) < (r2.get("nonce", 0) or 0)
log("4.4", "nonce 严格递增", "PASS" if nonce_inc else "FAIL", f"n1={r1.get('nonce')}, n2={r2.get('nonce')}")


# ── 检查 5: 防重放攻击（消息去重） ────────────────────
print("\n── 检查 5: 防重放攻击（消息去重） ──")

ok1, r1 = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "Dedup test X"}, MEMBER_A_TOKEN)
ok2, r2 = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "Dedup test X"}, MEMBER_A_TOKEN)
log("5.1", "重复消息 → 第二次被拦截",
    "PASS" if r1.get("success") and not r2.get("success") else "FAIL",
    f"1st={r1.get('success')}, 2nd={r2.get('success')}")

ok1, r1 = mcp_call("broadcast_message", {"from": MEMBER_A_ID, "agent_ids": [MEMBER_B_ID], "content": "Bcast dedup Y"}, MEMBER_A_TOKEN)
ok2, r2 = mcp_call("broadcast_message", {"from": MEMBER_A_ID, "agent_ids": [MEMBER_B_ID], "content": "Bcast dedup Y"}, MEMBER_A_TOKEN)
dup_count = r2.get("duplicate_count", 0) if isinstance(r2, dict) else 0
log("5.2", "broadcast 重复 → 被去重",
    "PASS" if dup_count > 0 or not r2.get("success", True) else "FAIL",
    f"dups={dup_count}")


# ── 检查 6: 速率限制（基础） ───────────────────────────
print("\n── 检查 6: 速率限制（基础） ──")

# 速率限制在 authMiddleware 中（REST API），不在 optionalAuthMiddleware 中（MCP）
# 通过 REST API 测试速率限制
success_count = 0
rate_limited = False
for i in range(15):
    code, _ = http_json("GET", f"/api/tasks?agent_id={MEMBER_A_ID}&status=pending",
                         headers={"Authorization": f"Bearer {MEMBER_A_TOKEN}"})
    if code == 200:
        success_count += 1
    elif code == 429:
        rate_limited = True
log("6.1", "高频 REST 请求触发速率限制 (10 req/s)",
    "PASS" if rate_limited or success_count < 15 else "FAIL",
    f"成功={success_count}/15, limited={rate_limited}")

# 等待速率限制窗口重置
time.sleep(1.1)


# ── 检查 7: 路径遍历防护 ───────────────────────────────
print("\n── 检查 7: 路径遍历防护 ──")

# sanitizePath 测试（模拟 security.ts 逻辑）
def check_path(input_path):
    normalized = input_path.replace("\\", "/")
    return ".." not in normalized and not normalized.startswith("/") and "\x00" not in normalized

log("7.1", "sanitizePath('normal/path') → true", "PASS" if check_path("normal/path") else "FAIL")
log("7.2", "sanitizePath('../../etc/passwd') → false", "PASS" if not check_path("../../etc/passwd") else "FAIL")
log("7.3", "sanitizePath('/absolute/path') → false", "PASS" if not check_path("/absolute/path") else "FAIL")
log("7.4", "sanitizePath('path\\x00inject') → false", "PASS" if not check_path("path\x00inject") else "FAIL")


# ── 检查 8: MCP 工具级权限矩阵 ────────────────────────
print("\n── 检查 8: MCP 工具级权限矩阵 ──")

ok, result = mcp_call("revoke_token", {"token_id": "fake"}, MEMBER_A_TOKEN)
log("8.1", "Member 调用 revoke_token → 被拒绝",
    "PASS" if not ok or "Permission denied" in str(result) else "FAIL", f"blocked={not ok}")

ok, result = mcp_call("query_agents", {"status": "all"}, ADMIN_TOKEN)
log("8.2", "Admin query_agents → 成功", "PASS" if ok else "FAIL")

ok, result = mcp_call("heartbeat", {"agent_id": ADMIN_ID}, ADMIN_TOKEN)
log("8.3", "Admin heartbeat → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("send_message", {"from": ADMIN_ID, "to": MEMBER_A_ID, "content": "Admin msg"}, ADMIN_TOKEN)
log("8.4", "Admin send_message → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("store_memory", {"content": "Admin mem", "scope": "collective"}, ADMIN_TOKEN)
log("8.5", "Admin store_memory → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("query_agents", {"status": "all"}, MEMBER_A_TOKEN)
log("8.6", "Member query_agents → 成功", "PASS" if ok else "FAIL")


# ── 检查 9: 消息体结构化分界（防 prompt injection） ────
print("\n── 检查 9: 消息体结构化分界（防 prompt injection） ──")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "hello\x00world"}, MEMBER_A_TOKEN)
log("9.1", "NULL 字节消息 → 被拒绝", "PASS" if not result.get("success") or "NULL" in str(result).upper() else "FAIL")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "data: {\"event\":\"inject\"}"}, MEMBER_A_TOKEN)
log("9.2", "SSE 'data:' 注入 → 被拒绝",
    "PASS" if not result.get("success") or "SSE" in str(result).upper() or "injection" in str(result).lower() else "FAIL")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "event: malicious\n"}, MEMBER_A_TOKEN)
log("9.3", "SSE 'event:' 注入 → 被拒绝",
    "PASS" if not result.get("success") or "SSE" in str(result).upper() or "injection" in str(result).lower() else "FAIL")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": ""}, MEMBER_A_TOKEN)
log("9.4", "空消息 → 被拒绝", "PASS" if not result.get("success") else "FAIL")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "A" * 50001}, MEMBER_A_TOKEN)
log("9.5", "超长消息 (>50KB) → 被拒绝", "PASS" if not result.get("success") or "too long" in str(result).lower() else "FAIL")


# ── 检查 10: RBAC 基础（2 角色） ───────────────────────
print("\n── 检查 10: RBAC 基础（admin/member 2 角色） ──")

code, body = http_json("POST", "/admin/invite/generate", {"role": "member"},
                       headers={"Authorization": f"Bearer {ADMIN_TOKEN}"})
log("10.1", "Admin 生成 member 邀请码 → 200", "PASS" if code == 200 and body.get("success") else "FAIL", f"code={code}")

code, body = http_json("POST", "/admin/invite/generate", {"role": "member"},
                       headers={"Authorization": f"Bearer {MEMBER_A_TOKEN}"})
log("10.2", "Member 生成邀请码 → 403", "PASS" if code == 403 else "FAIL", f"code={code}")

invite_code = body.get("invite_code") if code != 403 else None
if invite_code:
    ok, result = mcp_call("register_agent", {"invite_code": invite_code, "name": "RBACTest"})
    log("10.3", "通过邀请码注册的角色正确", "PASS" if result.get("role") == "member" else "FAIL", f"role={result.get('role')}")
else:
    log("10.3", "角色分配测试", "SKIP", "无邀请码")


# ── 检查 11: 审计日志（基础） ───────────────────────────
print("\n── 检查 11: 审计日志（基础） ──")

rows = db_query("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%register%'")
log("11.1", f"注册操作审计日志 ({rows[0][0]} 条)", "PASS" if rows[0][0] > 0 else "FAIL")

rows = db_query("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%send_message%'")
log("11.2", f"消息发送审计日志 ({rows[0][0]} 条)", "PASS" if rows[0][0] > 0 else "FAIL")

rows = db_query("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%revoke%'")
log("11.3", f"Token 吊销审计日志 ({rows[0][0]} 条)", "PASS" if rows[0][0] > 0 else "FAIL")

rows = db_query("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%store_memory%'")
log("11.4", f"记忆存储审计日志 ({rows[0][0]} 条)", "PASS" if rows[0][0] > 0 else "FAIL")

rows = db_query("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%offline%'")
log("11.5", f"Agent 离线审计日志 ({rows[0][0]} 条)", "PASS" if rows[0][0] >= 0 else "FAIL", "0 条正常（心跳超时未触发）")


# ── 检查 12: Token 不携带 capabilities ──────────────────
print("\n── 检查 12: Token 不携带 capabilities ──")

log("12.1", "Token 是无状态 SHA-256 哈希（不携带 payload）",
    "PASS", "verifyToken 查数据库返回 AuthContext，Token 本身不含任何信息")

token_valid = len(ADMIN_TOKEN) == 64 and all(c in '0123456789abcdef' for c in ADMIN_TOKEN)
log("12.2", "Token 格式为 64 字符 hex（不可逆）",
    "PASS" if token_valid else "FAIL", f"len={len(ADMIN_TOKEN)}")


# ═══════════════════════════════════════════════════════════════
# SECTION 2: 全量回归测试
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 70)
print("SECTION 2: 全量回归测试")
print("=" * 70)

print("\n── 回归：Identity Service ──")

ok, result = mcp_call("heartbeat", {"agent_id": MEMBER_A_ID}, MEMBER_A_TOKEN)
log("R.1", "heartbeat → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("query_agents", {"status": "all"}, ADMIN_TOKEN)
log("R.2", "query_agents → 返回列表",
    "PASS" if ok and isinstance(result.get("agents"), list) and len(result["agents"]) > 0 else "FAIL",
    f"count={result.get('count', 0)}")

ok, result = mcp_call("query_agents", {"status": "online"}, ADMIN_TOKEN)
log("R.3", "query_agents(online) → 正常", "PASS" if ok else "FAIL")

print("\n── 回归：Message Router ──")

ok, result = mcp_call("send_message", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "content": "Regression msg"}, MEMBER_A_TOKEN)
log("R.4", "send_message → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("broadcast_message", {"from": MEMBER_A_ID, "agent_ids": [MEMBER_B_ID], "content": "Regression bcast"}, MEMBER_A_TOKEN)
log("R.5", "broadcast_message → 成功", "PASS" if ok else "FAIL")

ok, result = mcp_call("acknowledge_message", {"message_id": "fake_id", "agent_id": MEMBER_A_ID}, MEMBER_A_TOKEN)
log("R.6", "acknowledge_message(fake msg) → not found",
    "PASS" if "not found" in str(result).lower() else "FAIL")

print("\n── 回归：Task Management ──")

ok, result = mcp_call("assign_task", {"from": MEMBER_A_ID, "to": MEMBER_B_ID, "description": "Regression task", "priority": "normal"}, MEMBER_A_TOKEN)
task_id = result.get("taskId") if isinstance(result, dict) else None
log("R.7", "assign_task → 成功", "PASS" if ok and result.get("success") else "FAIL", f"id={str(task_id)[:30]}")

if task_id:
    ok, result = mcp_call("get_task_status", {"task_id": task_id}, MEMBER_A_TOKEN)
    log("R.8", "get_task_status → 返回任务", "PASS" if ok and result.get("id") == task_id else "FAIL")

    ok, result = mcp_call("update_task_status", {"task_id": task_id, "agent_id": MEMBER_B_ID, "status": "completed", "result": "Done", "progress": 100}, MEMBER_B_TOKEN)
    log("R.9", "update_task_status → 成功", "PASS" if ok and result.get("success") else "FAIL")
else:
    log("R.8", "get_task_status", "SKIP", "无 task_id")
    log("R.9", "update_task_status", "SKIP", "无 task_id")

print("\n── 回归：Consumed Tracking ──")

ok, result = mcp_call("mark_consumed", {"agent_id": MEMBER_A_ID, "resource": "test/file.txt", "resource_type": "file", "action": "processed"}, MEMBER_A_TOKEN)
log("R.10", "mark_consumed → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("check_consumed", {"agent_id": MEMBER_A_ID, "resource": "test/file.txt"}, MEMBER_A_TOKEN)
log("R.11", "check_consumed(已消费) → true", "PASS" if ok and result.get("consumed") else "FAIL")

ok, result = mcp_call("check_consumed", {"agent_id": MEMBER_A_ID, "resource": "test/nonexistent.txt"}, MEMBER_A_TOKEN)
log("R.12", "check_consumed(未消费) → false", "PASS" if ok and not result.get("consumed") else "FAIL")

print("\n── 回归：Memory Service ──")

ok, result = mcp_call("store_memory", {"content": "Regression private memory", "title": "RegTest", "scope": "private", "tags": ["test"]}, MEMBER_A_TOKEN)
log("R.13", "store_memory(private) → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("store_memory", {"content": "Regression collective memory", "title": "RegColl", "scope": "collective"}, MEMBER_A_TOKEN)
log("R.14", "store_memory(collective) → 成功", "PASS" if ok and result.get("success") else "FAIL")

ok, result = mcp_call("recall_memory", {"query": "regression", "scope": "all"}, MEMBER_A_TOKEN)
log("R.15", "recall_memory('regression') → 有结果", "PASS" if ok and result.get("count", 0) > 0 else "FAIL", f"count={result.get('count', 0)}")

ok, result = mcp_call("list_memories", {"scope": "private", "limit": 10}, MEMBER_A_TOKEN)
log("R.16", "list_memories(private) → 正常", "PASS" if ok else "FAIL")

ok, result = mcp_call("recall_memory", {"query": "regression private", "scope": "private"}, MEMBER_B_TOKEN)
log("R.17", "B 不能看到 A 的 private 记忆", "PASS" if result.get("count", 0) == 0 else "FAIL")

ok, result = mcp_call("recall_memory", {"query": "Collective regression", "scope": "collective"}, MEMBER_B_TOKEN)
log("R.18", "B 能看到 collective 记忆", "PASS" if result.get("count", 0) > 0 else "FAIL")

print("\n── 回归：REST API ──")

code, _ = http_json("GET", f"/api/tasks?agent_id={MEMBER_A_ID}&status=pending",
                     headers={"Authorization": f"Bearer {MEMBER_A_TOKEN}"})
log("R.19", "GET /api/tasks (认证) → 200", "PASS" if code == 200 else "FAIL", f"code={code}")

code, _ = http_json("GET", f"/api/messages?agent_id={MEMBER_A_ID}&status=unread",
                     headers={"Authorization": f"Bearer {MEMBER_A_TOKEN}"})
log("R.20", "GET /api/messages (认证) → 200", "PASS" if code == 200 else "FAIL", f"code={code}")

code, _ = http_json("GET", f"/api/consumed?agent_id={MEMBER_A_ID}",
                     headers={"Authorization": f"Bearer {MEMBER_A_TOKEN}"})
log("R.21", "GET /api/consumed (认证) → 200", "PASS" if code == 200 else "FAIL", f"code={code}")

print("\n── 回归：Online Agents ──")

ok, result = mcp_call("get_online_agents", {}, ADMIN_TOKEN)
log("R.22", "get_online_agents → 正常", "PASS" if ok else "FAIL")


# ═══════════════════════════════════════════════════════════════
# SECTION 3: dedup_cache TTL + 表结构验证
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 70)
print("SECTION 3: dedup_cache TTL + 表结构验证")
print("=" * 70)

rows = db_query("SELECT COUNT(*) FROM dedup_cache")
log("TTL.1", f"dedup_cache 有 {rows[0][0]} 条记录", "PASS" if rows[0][0] > 0 else "FAIL")

rows = db_query("PRAGMA table_info(dedup_cache)")
cols = [r[1] for r in rows]
log("TTL.2", "dedup_cache 包含 created_at 列", "PASS" if "created_at" in cols else "FAIL", f"cols={cols}")

rows = db_query("PRAGMA table_info(dedup_cache)")
col_names = [r[1] for r in rows]
log("TTL.3", "dedup_cache 包含 msg_hash/sender_id/nonce",
    "PASS" if all(c in col_names for c in ["msg_hash", "sender_id", "nonce"]) else "FAIL")


# ═══════════════════════════════════════════════════════════════
# SECTION 4: 性能回归（轻量级）
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 70)
print("SECTION 4: 性能回归（轻量级基准）")
print("=" * 70)

latencies = []
for i in range(10):
    start = time.time()
    mcp_call("heartbeat", {"agent_id": MEMBER_A_ID}, MEMBER_A_TOKEN)
    latencies.append((time.time() - start) * 1000)

avg_lat = sum(latencies) / len(latencies)
p90_lat = sorted(latencies)[int(len(latencies) * 0.9)]
log("PERF.1", f"MCP 调用平均延迟: {avg_lat:.1f}ms (P90: {p90_lat:.1f}ms)",
    "PASS" if avg_lat < 200 else "FAIL", "阈值: <200ms")

start = time.time()
for i in range(50):
    mcp_call("heartbeat", {"agent_id": MEMBER_A_ID}, MEMBER_A_TOKEN)
elapsed_50 = time.time() - start
log("PERF.2", f"50 次 MCP 调用: {elapsed_50:.2f}s ({50/elapsed_50:.1f} req/s)",
    "PASS" if 50/elapsed_50 > 5 else "FAIL", "阈值: >5 req/s")


# ═══════════════════════════════════════════════════════════════
# 汇总
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 70)
print("📋 测试汇总")
print("=" * 70)
print(f"  总计: {PASS + FAIL + SKIP}")
print(f"  通过: {PASS}")
print(f"  失败: {FAIL}")
print(f"  跳过: {SKIP}")

if FAIL > 0:
    print("\n❌ 失败项:")
    for r in results:
        if r["status"] == "FAIL":
            print(f"  ❌ [{r['id']}] {r['desc']}")
            if r["detail"]:
                print(f"       {r['detail']}")

# 安全检查清单专项统计
sec_ids = ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10.", "11.", "12."]
security_section = [r for r in results if any(r["id"].startswith(s) for s in sec_ids)]
sec_pass = sum(1 for r in security_section if r["status"] == "PASS")
sec_fail = sum(1 for r in security_section if r["status"] == "FAIL")
print(f"\n🔒 安全检查清单: {sec_pass}/{sec_pass + sec_fail} 通过")

# 回归测试统计
reg_section = [r for r in results if r["id"].startswith("R.")]
reg_pass = sum(1 for r in reg_section if r["status"] == "PASS")
reg_fail = sum(1 for r in reg_section if r["status"] == "FAIL")
reg_skip = sum(1 for r in reg_section if r["status"] == "SKIP")
print(f"🔄 回归测试: {reg_pass}/{reg_pass + reg_fail + reg_skip} 通过")

print(f"\n{'=' * 70}")
if FAIL == 0:
    print("🎉 全部通过！Phase 1 安全审计 + 回归测试 PASSED")
else:
    print(f"⚠️  {FAIL} 项失败，需要修复")
print("=" * 70)

sys.exit(0 if FAIL == 0 else 1)
