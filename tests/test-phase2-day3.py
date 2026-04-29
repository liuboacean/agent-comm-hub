#!/usr/bin/env python3
"""
Phase 2 Day 3 验收测试 — FTS5 N-gram 中文分词 + 安全审计 + P2 清零
"""
import sys, os, json, time, hashlib, sqlite3, subprocess, http.client as httplib, re

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
    if "headers" in kwargs:
        headers.update(kwargs["headers"])
    body = json.dumps(data).encode() if data else b""
    try:
        conn = httplib.HTTPConnection(HUB_HOST, HUB_PORT, timeout=8)
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Connection": "close",
        }
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
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": args}
    })
    try:
        conn = httplib.HTTPConnection(HUB_HOST, HUB_PORT, timeout=8)
        h = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
            "Connection": "close",
            "Content-Length": str(len(payload)),
        }
        conn.request("POST", "/mcp", payload.encode(), h)
        resp = conn.getresponse()
        raw = b""
        while len(raw) < 131072:
            chunk = resp.read(4096)
            if not chunk:
                break
            raw += chunk
            if b"\n\n" in raw:
                break
        conn.close()
        decoded = raw.decode(errors="replace")
        # 尝试 JSON 解析
        try:
            return resp.status, json.loads(decoded)
        except:
            # SSE 格式
            for line in decoded.split("\n"):
                if line.startswith("data: "):
                    try:
                        return resp.status, json.loads(line[6:])
                    except:
                        continue
            return resp.status, {"raw": decoded[:200]}
    except Exception as e:
        return 0, {"error": str(e)}

def mcp_result(resp):
    try:
        if "result" in resp:
            content = resp["result"].get("content", [])
            for item in content:
                if item.get("type") == "text":
                    text = item["text"]
                    if text:
                        return json.loads(text)
    except (json.JSONDecodeError, TypeError, KeyError):
        pass
    return {}

def setup_tokens():
    """创建测试 agent tokens"""
    now = int(time.time() * 1000)
    agents = {
        "d3_admin": ("D3Admin", "admin"),
        "d3_alice": ("D3Alice", "member"),
        "d3_bob":   ("D3Bob",   "member"),
    }
    tokens = {}
    conn = sqlite3.connect(DB)
    c = conn.cursor()
    for agent_id, (name, role) in agents.items():
        token_plain = f"d3tok_{agent_id}_{now}"
        token_hash = hashlib.sha256(token_plain.encode()).hexdigest()
        c.execute(
            "INSERT OR IGNORE INTO agents (agent_id, name, role, status, created_at, last_heartbeat)"
            " VALUES (?,?,?,?,?,?)",
            (agent_id, name, role, "online", now, now)
        )
        c.execute(
            "INSERT OR IGNORE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at, expires_at)"
            " VALUES (?,?,?,?,?,1,?,?)",
            (f"tok_{agent_id}_{now}", "api_token", token_hash, agent_id, role, now, now + 86400000)
        )
        tokens[agent_id] = token_plain
    conn.commit()
    conn.close()
    return tokens

# ─────────────────────────────────────────────────────────────
# F 组：中文分词验证
# ─────────────────────────────────────────────────────────────

def test_f_chinese_fts(tokens):
    print("\n=== F组：中文分词验证 ===")
    admin = tokens["d3_admin"]
    alice = tokens["d3_alice"]
    bob = tokens["d3_bob"]

    # 存储中文测试记忆
    test_memories = [
        ("机器学习入门", "机器学习是人工智能的重要分支，涵盖监督学习和无监督学习"),
        ("深度学习应用", "深度学习在自然语言处理和计算机视觉中应用广泛"),
        ("算法基础", "学习机器可以帮助理解排序算法和搜索算法原理"),
        ("数据结构笔记", "链表和树是基本的数据结构，图论也很重要"),
    ]

    for title, content in test_memories:
        code, resp = mcp_call("store_memory", {
            "agent_id": "d3_alice",
            "content": content,
            "title": title,
            "scope": "collective",
        }, alice)
        res = mcp_result(resp)
        ok = code == 200 and res.get("success")
        log(ok, f"store_memory '{title}'", f"code={code}")

    time.sleep(0.5)

    # 搜索测试（前半段）
    search_tests_1 = [
        ("机器学习", 2, "应匹配 '机器学习入门' + '算法基础'(含'学习机器')"),
        ("人工智能", 1, "仅匹配 '机器学习入门'"),
        ("自然语言", 1, "仅匹配 '深度学习应用'"),
        ("算法原理", 1, "仅匹配 '算法基础'"),
    ]

    for query, min_expected, desc in search_tests_1:
        code, resp = mcp_call("recall_memory", {
            "agent_id": "d3_alice",
            "query": query,
            "scope": "collective",
        }, alice)
        res = mcp_result(resp)
        count = res.get("count", 0) if isinstance(res, dict) else 0
        titles = res.get("memories", []) if isinstance(res, dict) else []
        if isinstance(titles, list) and len(titles) > 0 and isinstance(titles[0], dict):
            title_str = ", ".join([t.get("title", "?")[:10] for t in titles[:3]])
        elif isinstance(titles, list):
            title_str = str(titles[:3])
        else:
            title_str = str(titles)[:60]
        ok = code == 200 and count >= min_expected
        log(ok, f'recall "{query}" >= {min_expected}', f"got {count}: {title_str} ({desc})")

    # 速率重置
    time.sleep(1.5)

    # 搜索测试（后半段，用 bob 避免 alice 速率耗尽）
    search_tests_2 = [
        ("数据结构", 1, "仅匹配 '数据结构笔记'"),
        ("深度学习", 2, "匹配 '深度学习应用' + '机器学习入门'(含'学习')"),
        ("图论", 1, "匹配 '数据结构笔记'(含'图论')"),
    ]

    for query, min_expected, desc in search_tests_2:
        code, resp = mcp_call("recall_memory", {
            "agent_id": "d3_bob",
            "query": query,
            "scope": "collective",
        }, bob)
        res = mcp_result(resp)
        count = res.get("count", 0) if isinstance(res, dict) else 0
        titles = res.get("memories", []) if isinstance(res, dict) else []
        if isinstance(titles, list) and len(titles) > 0 and isinstance(titles[0], dict):
            title_str = ", ".join([t.get("title", "?")[:10] for t in titles[:3]])
        elif isinstance(titles, list):
            title_str = str(titles[:3])
        else:
            title_str = str(titles)[:60]
        ok = code == 200 and count >= min_expected
        log(ok, f'recall "{query}" >= {min_expected}', f"got {count}: {title_str} ({desc})")

    # F8-F9: 英文和 learning 搜索
    time.sleep(1.2)
    code, resp = mcp_call("recall_memory", {
        "agent_id": "d3_bob",
        "query": "learning",
        "scope": "collective",
    }, bob)
    res = mcp_result(resp)
    count = res.get("count", 0)
    log(code == 200, f'recall "learning" (英文)', f"got {count} code={code}")

# ─────────────────────────────────────────────────────────────
# S 组：安全审计（12 项清单）
# ─────────────────────────────────────────────────────────────

def test_s_security_audit(tokens):
    print("\n=== S组：安全审计（12 项） ===")
    admin = tokens["d3_admin"]
    alice = tokens["d3_alice"]
    bob = tokens["d3_bob"]

    # 等 F 组的速率限制重置
    time.sleep(2.0)

    # S1: 未认证请求 → 401
    code, _ = http("GET", "/api/tasks?agent_id=d3_alice")
    log(code == 401, "S1 未认证 REST → 401", f"code={code}")

    # S2: 无效 token → 401
    code, _ = http("GET", "/api/tasks?agent_id=d3_alice",
                   headers={"Authorization": "Bearer invalid_token_xxx"})
    log(code == 401, "S2 无效 token → 401", f"code={code}")

    # S3: 有效 token → 200（用 bob，避免 alice 速率耗尽）
    code, _ = http("GET", "/api/tasks?agent_id=d3_bob",
                   headers={"Authorization": f"Bearer {bob}"})
    log(code == 200, "S3 有效 token → 200", f"code={code}")

    # S4: hash+nonce 完整性（dedup）
    time.sleep(1.2)
    code1, resp1 = mcp_call("send_message", {
        "from": "d3_alice", "to": "d3_bob", "content": f"security_test_{int(time.time()*1000)}"
    }, alice)
    res1 = mcp_result(resp1)
    ok = code1 == 200 and res1.get("success")
    log(ok, "S4 hash+nonce 消息发送成功", f"code={code1}")

    # S5: 防重放（相同内容再次发送应被 dedup）
    # 第一次发送的内容需要在 nonce 以外完全相同
    sent_content = f"security_test_{int(time.time()*1000)}"
    code_a, resp_a = mcp_call("send_message", {
        "from": "d3_alice", "to": "d3_bob", "content": sent_content
    }, alice)
    res_a = mcp_result(resp_a)
    # 用相同 content + 相同 from/to 重发（dedup 基于 dedupHash = hash(from+to+content+metadata)，不含 nonce）
    code2, resp2 = mcp_call("send_message", {
        "from": "d3_alice", "to": "d3_bob", "content": sent_content
    }, alice)
    res2 = mcp_result(resp2)
    ok_dup = not res2.get("success") or res2.get("deduplicated") or res2.get("error")
    log(ok_dup, "S5 防重放 dedup 拒绝", f"code={code2} dup={ok_dup}")

    # S6: MCP 工具权限矩阵（member 不能调用 admin 工具）
    time.sleep(1.2)
    code, resp = mcp_call("revoke_token", {"token_id": "nonexistent_token"}, alice)
    res = mcp_result(resp)
    # 权限拒绝会在参数验证之前触发，或者返回 permission error
    is_error = "isError" in resp.get("result", {}) or res.get("error") or not res.get("success", True)
    ok = code == 200 and is_error
    log(ok, "S6 member 不能调用 admin 工具", f"code={code} error={is_error}")

    # S7: 速率限制（MCP 10 req/s）
    time.sleep(1.5)
    codes_429 = 0
    for i in range(12):
        code, _ = mcp_call("heartbeat", {"agent_id": "d3_bob"}, bob)
        if code == 429:
            codes_429 += 1
    log(codes_429 > 0, f"S7 MCP 速率限制触发 429", f"hits={codes_429}/12")

    # S8: 邀请码保护 register_agent
    time.sleep(1.5)
    code, resp = mcp_call("register_agent", {
        "agent_id": "noinvite_agent",
        "name": "NoInvite"
    }, bob)
    res = mcp_result(resp)
    ok = code == 200 and (res.get("error") or not res.get("success"))
    log(ok, "S8 无邀请码注册失败", f"code={code}")

    # S9: 消息体分界（防 SSE 注入）
    time.sleep(1.2)
    code, resp = mcp_call("send_message", {
        "from": "d3_alice", "to": "d3_bob",
        "content": f"injection_test\ndata: evil\n{int(time.time()*1000)}"
    }, alice)
    res = mcp_result(resp)
    # 应被拒绝（SSE 注入检测）
    ok = code == 200 and not res.get("success")
    log(ok, "S9 消息体分界防注入", f"code={code} rejected={not res.get('success')}")

    # S10: /health 免认证
    code, _ = http("GET", "/health")
    log(code == 200, "S10 /health 免认证", f"code={code}")

    # S11: nonce 持久化
    conn = sqlite3.connect(DB)
    c = conn.cursor()
    c.execute("SELECT last_nonce FROM sender_nonces WHERE sender_id='d3_alice'")
    row = c.fetchone()
    conn.close()
    ok = row is not None and row[0] > 0
    log(ok, "S11 nonce 持久化到 SQLite", f"last_nonce={row[0] if row else 'N/A'}")

    # S12: 审计日志记录
    conn = sqlite3.connect(DB)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'tool_%'")
    row = c.fetchone()
    conn.close()
    ok = row is not None and row[0] > 0
    log(ok, "S12 审计日志有记录", f"count={row[0] if row else 0}")

# ─────────────────────────────────────────────────────────────
# P 组：Phase 1 P2 清零确认
# ─────────────────────────────────────────────────────────────

def test_p_p2_clear(tokens):
    print("\n=== P组：Phase 1 P2 清零确认 ===")
    admin = tokens["d3_admin"]
    alice = tokens["d3_alice"]
    bob = tokens["d3_bob"]

    time.sleep(2.0)

    # P2-1: MCP 速率限制 ✅（Day 1 已完成，S7 已验证）

    # P2-2: nonce 持久化 ✅（Day 1 已完成，S11 已验证）

    # P2-3: repo 接口统一 ✅（Day 2 已完成，验证 tools.ts/server.ts 无直接 SQL）
    tools_path = os.path.join(HUB_DIR, "src", "tools.ts")
    server_path = os.path.join(HUB_DIR, "src", "server.ts")
    with open(tools_path, "r") as f:
        tools_content = f.read()
    with open(server_path, "r") as f:
        server_content = f.read()

    no_direct_sql = (
        "msgStmt" not in tools_content and "taskStmt" not in tools_content and
        "consumedStmt" not in tools_content and
        "msgStmt" not in server_content and "taskStmt" not in server_content and
        "consumedStmt" not in server_content
    )
    log(no_direct_sql, "P2-3 repo 接口统一（零直接 SQL）",
        f"tools.ts clean={no_direct_sql}")

    # P2-4: FTS5 中文分词 ✅（Day 3，F 组已验证）
    # 已在 F 组测试中验证

    # P2-5: 确认 tsc --noEmit 零错误
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        cwd=HUB_DIR,
        capture_output=True, text=True, timeout=30
    )
    log(result.returncode == 0, "P2-5 tsc --noEmit 零错误",
        f"exit={result.returncode}" + (f" err={result.stderr[:60]}" if result.stderr else ""))

    # P2-6: Memory CRUD + FTS 搜索完整流程
    time.sleep(1.2)
    # Store
    code, resp = mcp_call("store_memory", {
        "agent_id": "d3_bob",
        "content": f"P2验证记忆 {int(time.time()*1000)}",
        "title": "P2验证标题",
        "scope": "private",
    }, bob)
    res = mcp_result(resp)
    mem_id = res.get("memory_id", "")
    ok = code == 200 and res.get("success")
    log(ok, "P2-6a store_memory 成功", f"id={mem_id[:12]}")

    # Recall
    time.sleep(0.3)
    code, resp = mcp_call("recall_memory", {
        "agent_id": "d3_bob",
        "query": "P2验证",
        "scope": "private",
    }, bob)
    res = mcp_result(resp)
    count = res.get("count", 0)
    ok = code == 200 and count >= 1
    log(ok, "P2-6b recall_memory 命中", f"count={count}")

    # List
    code, resp = mcp_call("list_memories", {
        "agent_id": "d3_bob",
        "scope": "private",
    }, bob)
    res = mcp_result(resp)
    count = res.get("count", 0)
    ok = code == 200 and count >= 1
    log(ok, "P2-6c list_memories 正常", f"count={count}")

    # Delete
    if mem_id:
        code, resp = mcp_call("delete_memory", {
            "memory_id": mem_id,
        }, bob)
        res = mcp_result(resp)
        ok = code == 200 and res.get("success")
        log(ok, "P2-6d delete_memory 成功", f"id={mem_id[:12]}")

# ═════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 60)
    print("Phase 2 Day 3 — FTS5 中文分词 + 安全审计 + P2 清零")
    print("=" * 60)

    # 确认 Hub 运行
    code, _ = http("GET", "/health")
    if code != 200:
        print("❌ Hub 未运行，请先启动 Hub")
        sys.exit(1)
    print(f"\n  ✓ Hub 已运行")

    tokens = setup_tokens()
    print(f"  ✓ 测试 tokens 创建完成 ({len(tokens)} agents)")

    test_f_chinese_fts(tokens)
    test_s_security_audit(tokens)
    test_p_p2_clear(tokens)

    print("\n" + "=" * 60)
    total = passed + failed
    print(f"验收结果：{passed}/{total} 通过")
    print("=" * 60)
    sys.exit(0 if failed == 0 else 1)
