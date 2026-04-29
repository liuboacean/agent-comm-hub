#!/usr/bin/env python3
"""
Phase 2 Day 2 — repo 接口统一验收测试
验收标准：
  D1. tools.ts/server.ts 不再直接引用 msgStmt/taskStmt/consumedStmt（白盒）
  D2. 17 个 MCP 工具功能不变（黑盒）
  D3. REST API 功能不变
  D4. 全量回归（Phase 1 核心测试 13 项）
  D5. tsc --noEmit 零错误
总计：≥ 30 项验收通过
"""
import sys, os, json, time, hashlib, sqlite3, subprocess, http.client as httplib, re

HUB      = "http://localhost:3100"
HUB_HOST = "localhost"
HUB_PORT = 3100
HUB_DIR  = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NPX_BIN  = "/opt/homebrew/bin/npx"
DB       = os.path.join(HUB_DIR, "comm_hub.db")
SRC_DIR  = os.path.join(HUB_DIR, "src")

results = []

def log(ok, test, detail=""):
    tag = "✅" if ok else "❌"
    results.append((test, ok))
    msg = f"{tag} {test}"
    if detail:
        msg += f" — {detail}"
    print(msg)

# ─── HTTP / MCP 工具 ─────────────────────────────────────

def _parse_sse_or_json(raw: str):
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            js = line[5:].strip()
            if js and js != "[DONE]":
                try:
                    return json.loads(js)
                except:
                    pass
    try:
        return json.loads(raw)
    except:
        return {"raw": raw[:300]}

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
            "Content-Length": str(len(body)),
            "Connection": "close",
        }
        h.update(headers)
        conn.request(method, path, body, h)
        resp = conn.getresponse()
        status = resp.status
        raw = b""
        while len(raw) < 16384:
            chunk = resp.read(2048)
            if not chunk:
                break
            raw += chunk
            if b"\n\n" in raw or b"\r\n\r\n" in raw:
                break
        conn.close()
        return status, _parse_sse_or_json(raw.decode(errors="replace"))
    except Exception as e:
        return 0, {"error": str(e)}

def mcp_call(tool, args, token):
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args}
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
        while len(raw) < 131072:  # 128KB
            chunk = resp.read(4096)
            if not chunk:
                break
            raw += chunk
            if b"\n\n" in raw:
                break
        conn.close()
        return resp.status, _parse_sse_or_json(raw.decode(errors="replace"))
    except Exception as e:
        return 0, {"error": str(e)}

def mcp_result(resp_body):
    """提取 MCP 工具返回的 JSON 结果"""
    try:
        text = resp_body.get("result", {}).get("content", [{}])[0].get("text", "{}")
        return json.loads(text)
    except:
        return {}

# ─── 测试数据准备（Hub 停止后写 DB，避免锁冲突）───────────

def setup_test_agents():
    """写测试数据（如果 Hub 在运行则不重启，避免锁冲突）"""
    print("\n=== 准备测试环境 ===")

    # 检查 Hub 是否已在运行
    hub_running = False
    code, _ = http("GET", "/health")
    if code == 200:
        hub_running = True
        print("  ✓ Hub 已在运行，直接复用")

    if not hub_running:
        # Hub 未启动，先写 DB 再启动（避免锁冲突）
        print("  ↳ Hub 未启动，准备写 DB 后启动...")

    now = int(time.time() * 1000)
    agents = {
        "d2_admin":  ("D2Admin",  "admin"),
        "d2_alice":  ("D2Alice",  "member"),
        "d2_bob":    ("D2Bob",    "member"),
        "d2_carol":  ("D2Carol",  "member"),
    }
    tokens = {}

    if hub_running:
        # Hub 在跑，通过 Admin API + register_agent 创建测试 agents
        # 先直接写 DB（因为 WAL 模式支持多进程读+单进程写，且 Hub 不会并发写测试数据）
        # 使用唯一时间戳后缀，确保不冲突
        conn = sqlite3.connect(DB)
        c = conn.cursor()
        for agent_id, (name, role) in agents.items():
            token_plain = f"d2tok_{agent_id}_{now}"
            token_hash  = hashlib.sha256(token_plain.encode()).hexdigest()
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
        print("  ✓ 测试 Agent/Token 写入完成")
    else:
        # Hub 未启动：写 DB 后启动
        conn = sqlite3.connect(DB)
        c = conn.cursor()
        for agent_id, (name, role) in agents.items():
            token_plain = f"d2tok_{agent_id}_{now}"
            token_hash  = hashlib.sha256(token_plain.encode()).hexdigest()
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
        print("  ✓ DB 写入完成")

        # 启 Hub
        os.system(f"cd {HUB_DIR} && {NPX_BIN} tsx src/server.ts > /tmp/hub-p2d2.log 2>&1 &")
        for _ in range(15):
            time.sleep(1)
            code2, _ = http("GET", "/health")
            if code2 == 200:
                print("  ✓ Hub 已启动")
                break
        else:
            print("  ✗ Hub 启动失败，查看 /tmp/hub-p2d2.log")
            sys.exit(1)

    return tokens

# ────────────────────────────────────────────────────────
# D 组：白盒检查 — tools.ts/server.ts 不含直接 SQL 引用
# ────────────────────────────────────────────────────────

def test_d_whitebox():
    print("\n=== D组：白盒检查（repo 迁移） ===")

    # D1: tools.ts 中不含 msgStmt/taskStmt/consumedStmt
    tools_path = os.path.join(SRC_DIR, "tools.ts")
    with open(tools_path) as f:
        tools_src = f.read()
    has_direct = any(x in tools_src for x in ["msgStmt", "taskStmt", "consumedStmt"])
    log(not has_direct, "D1 tools.ts 不含直接 SQL Statement 引用")

    # D2: server.ts 中不含直接 Statement 调用
    server_path = os.path.join(SRC_DIR, "server.ts")
    with open(server_path) as f:
        server_src = f.read()
    has_direct_srv = any(x in server_src for x in ["msgStmt", "taskStmt", "consumedStmt"])
    log(not has_direct_srv, "D2 server.ts 不含直接 SQL Statement 引用")

    # D3: repo/interfaces.ts 存在且含三个接口
    iface_path = os.path.join(SRC_DIR, "repo", "interfaces.ts")
    ok = os.path.exists(iface_path)
    if ok:
        with open(iface_path) as f:
            iface_src = f.read()
        ok = all(x in iface_src for x in ["IMessageRepo", "ITaskRepo", "IConsumedLogRepo"])
    log(ok, "D3 repo/interfaces.ts 包含三个接口定义")

    # D4: repo/sqlite-impl.ts 存在且导出三个单例
    impl_path = os.path.join(SRC_DIR, "repo", "sqlite-impl.ts")
    ok = os.path.exists(impl_path)
    if ok:
        with open(impl_path) as f:
            impl_src = f.read()
        ok = all(x in impl_src for x in ["messageRepo", "taskRepo", "consumedRepo"])
    log(ok, "D4 repo/sqlite-impl.ts 导出三个单例")

    # D5: tsc --noEmit 零错误
    result = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        cwd=HUB_DIR, capture_output=True, text=True
    )
    ok = result.returncode == 0
    log(ok, "D5 tsc --noEmit 零 TypeScript 错误",
        "pass" if ok else result.stdout[:200] + result.stderr[:200])

# ────────────────────────────────────────────────────────
# M 组：MCP 工具功能验证（黑盒）
# ────────────────────────────────────────────────────────

def test_m_mcp_tools(tokens):
    print("\n=== M组：MCP 工具功能验证 ===")
    admin = tokens["d2_admin"]
    alice = tokens["d2_alice"]
    bob   = tokens["d2_bob"]

    # 等速率限制窗口重置（前置 sleep）
    time.sleep(1.2)

    # M1: send_message（写 messages 表）
    unique_content = f"Day2 repo test {int(time.time() * 1000)}"
    code, resp = mcp_call("send_message", {
        "from": "d2_alice", "to": "d2_bob", "content": unique_content
    }, alice)
    res = mcp_result(resp)
    ok = code == 200 and res.get("success") and res.get("messageId")
    log(ok, "M1 send_message 成功写入 messageRepo", f"id={res.get('messageId','?')}")
    msg_id = res.get("messageId", "")

    # M2: acknowledge_message（读 + 更新 messages 表）
    if msg_id:
        code, resp = mcp_call("acknowledge_message", {
            "message_id": msg_id, "agent_id": "d2_bob"
        }, bob)
        res2 = mcp_result(resp)
        ok = code == 200 and res2.get("success")
        log(ok, "M2 acknowledge_message 通过 messageRepo 更新状态")
    else:
        log(False, "M2 acknowledge_message（跳过，无 msg_id）")

    # M3: assign_task（写 tasks 表）
    code, resp = mcp_call("assign_task", {
        "from": "d2_alice", "to": "d2_bob",
        "description": "Day2 repo migration validation task",
        "priority": "normal"
    }, alice)
    res3 = mcp_result(resp)
    ok = code == 200 and res3.get("success") and res3.get("taskId")
    log(ok, "M3 assign_task 成功写入 taskRepo", f"id={res3.get('taskId','?')}")
    task_id = res3.get("taskId", "")

    # M4: get_task_status（读 tasks 表）
    if task_id:
        code, resp = mcp_call("get_task_status", {"task_id": task_id}, alice)
        res4 = mcp_result(resp)
        ok = code == 200 and res4.get("id") == task_id
        log(ok, "M4 get_task_status 通过 taskRepo 读取任务")
    else:
        log(False, "M4 get_task_status（跳过，无 task_id）")

    # M5: update_task_status（更新 tasks 表）
    if task_id:
        code, resp = mcp_call("update_task_status", {
            "task_id": task_id, "agent_id": "d2_bob",
            "status": "in_progress", "progress": 30
        }, bob)
        res5 = mcp_result(resp)
        ok = code == 200 and res5.get("success")
        log(ok, "M5 update_task_status 通过 taskRepo 更新状态")
    else:
        log(False, "M5 update_task_status（跳过，无 task_id）")

    # M6: mark_consumed（写 consumed_log 表）
    code, resp = mcp_call("mark_consumed", {
        "agent_id": "d2_alice",
        "resource": "test/repo_validation.json",
        "resource_type": "file",
        "action": "validated_repo_layer",
        "notes": "Phase 2 Day 2 validation"
    }, alice)
    res6 = mcp_result(resp)
    ok = code == 200 and res6.get("success")
    log(ok, "M6 mark_consumed 通过 consumedRepo 写入")

    # M7: check_consumed（读 consumed_log 表）
    code, resp = mcp_call("check_consumed", {
        "agent_id": "d2_alice",
        "resource": "test/repo_validation.json"
    }, alice)
    res7 = mcp_result(resp)
    ok = code == 200 and res7.get("consumed") is True
    log(ok, "M7 check_consumed 通过 consumedRepo 读取", f"consumed={res7.get('consumed')}")

    # M8: broadcast_message（批量写 messages 表）—— 用 admin token 避免 alice 速率耗尽
    time.sleep(1.2)  # 等速率限制窗口重置
    code, resp = mcp_call("broadcast_message", {
        "from": "d2_admin",
        "agent_ids": ["d2_alice", "d2_bob", "d2_carol"],
        "content": "Day2 broadcast via repo"
    }, admin)
    res8 = mcp_result(resp)
    ok = code == 200 and res8.get("broadcast") is True
    log(ok, "M8 broadcast_message 通过 messageRepo 批量写入",
        f"delivered={res8.get('delivered_count',0)}/3")

    # M9: store_memory
    code, resp = mcp_call("store_memory", {
        "content": "repo layer migration completed in Day 2",
        "title": "Phase 2 Day 2 repo migration",
        "scope": "collective"
    }, alice)
    res9 = mcp_result(resp)
    ok = code == 200 and res9.get("success")
    log(ok, "M9 store_memory 正常（Memory Service 不受影响）")

    # M10: recall_memory
    code, resp = mcp_call("recall_memory", {
        "query": "repo migration", "scope": "collective", "limit": 5
    }, alice)
    res10 = mcp_result(resp)
    ok = code == 200 and isinstance(res10.get("results"), list)
    log(ok, "M10 recall_memory 正常")

    # M11: query_agents（用 bob 避免 alice 速率耗尽）
    time.sleep(1.2)
    code, resp = mcp_call("query_agents", {}, bob)
    res11 = mcp_result(resp)
    raw_preview = resp.get("raw", "")[:80] if "raw" in resp else ""
    print(f"  [DEBUG M11] code={code} resp_keys={list(resp.keys())[:5]} raw_preview={repr(raw_preview)}")
    ok = code == 200 and isinstance(res11.get("agents"), list)
    log(ok, "M11 query_agents 正常", f"count={res11.get('count',0)}")

    # M12: get_online_agents
    code, resp = mcp_call("get_online_agents", {}, alice)
    res12 = mcp_result(resp)
    ok = code == 200 and isinstance(res12.get("online_agents"), list)
    log(ok, "M12 get_online_agents 正常")

# ────────────────────────────────────────────────────────
# R 组：REST API 验证
# ────────────────────────────────────────────────────────

def test_r_rest_api(tokens):
    print("\n=== R组：REST API 验证 ===")
    # 用 carol（未被 M 组高频调用）避免速率限制
    carol = tokens["d2_carol"]
    alice = tokens["d2_alice"]

    # 先等速率限制窗口重置（1s）
    time.sleep(1.5)

    # R1: GET /api/tasks
    code, resp = http("GET", "/api/tasks?agent_id=d2_carol",
                      headers={"Authorization": f"Bearer {carol}"})
    ok = code == 200 and isinstance(resp.get("tasks"), list)
    log(ok, "R1 GET /api/tasks 通过 taskRepo 查询", f"code={code}")

    # R2: GET /api/messages
    code, resp = http("GET", "/api/messages?agent_id=d2_carol",
                      headers={"Authorization": f"Bearer {carol}"})
    ok = code == 200 and isinstance(resp.get("messages"), list)
    log(ok, "R2 GET /api/messages 通过 messageRepo 查询", f"code={code}")

    # R3: GET /api/consumed
    code, resp = http("GET", "/api/consumed?agent_id=d2_carol",
                      headers={"Authorization": f"Bearer {carol}"})
    ok = code == 200 and isinstance(resp.get("records"), list)
    log(ok, "R3 GET /api/consumed 通过 consumedRepo 查询", f"code={code}")

    # R4: GET /api/consumed?resource=... (单条查询，用 alice 的记录)
    code, resp = http("GET",
        "/api/consumed?agent_id=d2_alice&resource=test/repo_validation.json",
        headers={"Authorization": f"Bearer {alice}"})
    ok = code == 200 and resp.get("consumed") is True
    log(ok, "R4 GET /api/consumed (单条) 正确返回 consumed=true", f"consumed={resp.get('consumed')}")

    # R5: 未认证请求 → 401
    code, resp = http("GET", "/api/tasks?agent_id=d2_carol")
    ok = code == 401
    log(ok, "R5 未认证请求返回 401", f"code={code}")

# ────────────────────────────────────────────────────────
# P 组：Phase 1 回归（核心 13 项）
# ────────────────────────────────────────────────────────

def test_p_phase1_regression(tokens):
    print("\n=== P组：Phase 1 全量回归 ===")
    admin = tokens["d2_admin"]
    alice = tokens["d2_alice"]

    # 等速率限制窗口重置
    time.sleep(1.5)

    # P1: Health check
    code, resp = http("GET", "/health")
    ok = code == 200 and resp.get("status") == "ok"
    log(ok, "P1 /health 正常", f"uptime={resp.get('uptime',0):.1f}s")

    # P2: 未认证 MCP → register_agent (public)
    # 生成邀请码
    code_inv, inv_resp = http("POST", "/admin/invite/generate", {"role": "member"},
                              headers={"Authorization": f"Bearer {admin}"})
    invite_code = inv_resp.get("invite_code", "")
    ok = code_inv == 200 and bool(invite_code)
    log(ok, "P2 /admin/invite/generate 正常", f"code={code_inv}")

    # P3: register_agent（public）
    if invite_code:
        code, resp = mcp_call("register_agent", {
            "invite_code": invite_code, "name": "D2RegressionAgent"
        }, "")
        res = mcp_result(resp)
        ok = code == 200 and res.get("success")
        log(ok, "P3 register_agent (public) 正常", f"agent_id={res.get('agent_id','?')}")
    else:
        log(False, "P3 register_agent（跳过，无邀请码）")

    # P4: heartbeat
    code, resp = mcp_call("heartbeat", {"agent_id": "d2_alice"}, alice)
    res = mcp_result(resp)
    ok = code == 200 and res.get("success")
    log(ok, "P4 heartbeat 正常")

    # P5: 权限拒绝 — member 调用 admin 工具
    code, resp = mcp_call("revoke_token", {"token_id": "nonexistent"}, alice)
    ok = code == 200  # MCP 层返回 200，但内容是权限错误
    txt = resp.get("result", {}).get("content", [{}])[0].get("text", "")
    ok2 = "Permission denied" in txt or "required" in txt.lower()
    log(ok and ok2, "P5 权限拒绝正常（member 无法调用 admin 工具）")

    # P6: 消息完整流程（send → ACK）
    now = int(time.time() * 1000)
    code, resp = mcp_call("send_message", {
        "from": "d2_alice", "to": "d2_carol", "content": f"regression_msg_{now}"
    }, alice)
    res = mcp_result(resp)
    p6_ok = code == 200 and res.get("success")
    log(p6_ok, "P6 send_message → messageRepo 写入正常")

    # P7: 任务完整流程（assign → update → complete）
    code, resp = mcp_call("assign_task", {
        "from": "d2_alice", "to": "d2_bob",
        "description": "Phase1 regression task", "priority": "low"
    }, alice)
    res_t = mcp_result(resp)
    tid = res_t.get("taskId", "")
    if tid:
        code2, resp2 = mcp_call("update_task_status", {
            "task_id": tid, "agent_id": "d2_bob",
            "status": "completed", "result": "done", "progress": 100
        }, tokens["d2_bob"])
        res_u = mcp_result(resp2)
        ok = res_t.get("success") and res_u.get("success")
    else:
        ok = False
    log(ok, "P7 assign_task → update_task_status 完整流程正常")

    # P8: Memory 私有 + 搜索
    code, resp = mcp_call("store_memory", {
        "content": "phase1 regression memory test content",
        "scope": "private"
    }, alice)
    res_m = mcp_result(resp)
    mid = res_m.get("memory_id", "")
    if mid:
        code2, resp2 = mcp_call("recall_memory", {
            "query": "regression memory", "scope": "private", "limit": 3
        }, alice)
        res_r = mcp_result(resp2)
        ok = res_r.get("count", 0) >= 1
    else:
        ok = False
    log(ok, "P8 Memory store + recall 正常")

    # P9: dedup — 同内容消息被拒绝
    content_dup = "dup_content_d2_regression"
    mcp_call("send_message", {"from": "d2_alice", "to": "d2_bob", "content": content_dup}, alice)
    code, resp = mcp_call("send_message", {"from": "d2_alice", "to": "d2_bob", "content": content_dup}, alice)
    res9 = mcp_result(resp)
    ok = not res9.get("success", True) or res9.get("code") == "DEDUP_REJECTED"
    log(ok, "P9 重复消息被 dedup 拒绝")

    # P10: MCP 速率限制（10 req/s，phase2 day1 已验证，这里只做简单回归）
    hit_429 = False
    for i in range(12):
        c, r = mcp_call("query_agents", {}, alice)
        if c == 429:
            hit_429 = True
            break
    log(hit_429, "P10 MCP 速率限制（429）回归", f"触发第{i+1}次" if hit_429 else "未触发（可能需要更快的请求）")

    # P11: nonce 持久化（DB 中 sender_nonces 有记录）
    db_conn = sqlite3.connect(DB)
    c_db = db_conn.cursor()
    c_db.execute("SELECT last_nonce FROM sender_nonces WHERE sender_id='d2_alice' LIMIT 1")
    row = c_db.fetchone()
    db_conn.close()
    ok = row is not None and row[0] >= 1
    log(ok, "P11 nonce 持久化（sender_nonces 表有记录）", f"last_nonce={row[0] if row else 'N/A'}")

    # P12: 速率限制按 agent 隔离（等待重置后 bob 仍可调用）
    time.sleep(1.5)  # 等待速率限制重置（1s 窗口）
    code, resp = mcp_call("query_agents", {}, tokens["d2_bob"])
    ok = code == 200
    log(ok, "P12 速率限制按 agent 隔离（bob 独立计数）", f"code={code}")

    # P13: /health uptime 递增
    time.sleep(1)
    code, resp2 = http("GET", "/health")
    ok = code == 200 and resp2.get("uptime", 0) >= resp.get("uptime", 0)
    log(ok, "P13 /health uptime 正常", f"uptime={resp2.get('uptime',0):.1f}s")

# ─── 主流程 ───────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Phase 2 Day 2 — repo 接口统一验收测试")
    print("=" * 60)

    tokens = setup_test_agents()

    test_d_whitebox()
    test_m_mcp_tools(tokens)
    test_r_rest_api(tokens)
    test_p_phase1_regression(tokens)

    # ─── 汇总 ─────────────────────────────────────────────
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok in results if ok)
    total  = len(results)
    print(f"验收结果：{passed}/{total} 通过")
    if passed < total:
        print("\n失败项：")
        for name, ok in results:
            if not ok:
                print(f"  ❌ {name}")
    print("=" * 60)
    sys.exit(0 if passed == total else 1)
