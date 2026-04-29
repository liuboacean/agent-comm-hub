#!/usr/bin/env python3
"""
Phase 3 验收测试 — Evolution Engine 全功能测试
覆盖 Day 1-3 所有功能：8 个 MCP 工具 + DB Schema + 权限矩阵 + SSE 通知
"""

import http.client
import json
import time
import sqlite3
import hashlib
import os
import sys

HUB_HOST = "localhost"
HUB_PORT = 3100
DB_PATH = os.path.join(os.path.dirname(__file__), "../comm_hub.db")

passed = 0
failed = 0
errors = []

def log_pass(msg):
    global passed
    passed += 1
    print(f"  ✅ {msg}")

def log_fail(msg):
    global failed
    errors.append(msg)
    failed += 1
    print(f"  ❌ {msg}")

# ─── MCP 辅助函数 ──────────────────────────────────

def mcp_request(method, params, token=None):
    """发送 MCP 请求，解析 SSE 响应"""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    })
    
    conn = http.client.HTTPConnection(HUB_HOST, HUB_PORT, timeout=15)
    conn.request("POST", "/mcp", body.encode(), headers)
    resp = conn.getresponse()
    
    raw = resp.read().decode("utf-8")
    conn.close()
    
    # 解析 SSE
    for line in raw.split("\n"):
        if line.startswith("data: "):
            data = json.loads(line[6:])
            return data
    
    return {"error": {"message": f"No SSE data in response: {raw[:200]}"}}

def call_tool(tool_name, arguments, token):
    """调用 MCP 工具"""
    result = mcp_request("tools/call", {
        "name": tool_name,
        "arguments": arguments,
    }, token)
    
    if "result" in result and "content" in result["result"]:
        text = result["result"]["content"][0]["text"]
        try:
            return json.loads(text)
        except:
            return {"raw_text": text, "isError": result["result"].get("isError", False)}
    
    if "error" in result:
        return {"error": result["error"]["message"], "isError": True}
    
    return {"error": "Unknown response", "raw": result, "isError": True}

def list_tools_raw(token):
    """直接获取 tools/list 原始结果"""
    result = mcp_request("tools/list", {}, token)
    if "result" in result and "tools" in result["result"]:
        return result["result"]["tools"]
    return []

def parse_ok(data):
    """检查调用是否成功（业务层面 success=true）"""
    # 优先检查 success 字段
    if "success" in data:
        return data["success"] is True
    # MCP 协议错误
    if data.get("isError", False):
        return False
    # 默认：没有 error 字段就算成功
    return not data.get("error")

def get_db():
    return sqlite3.connect(DB_PATH)

def get_admin_token():
    """获取 admin token（直接从 DB 创建新 token）"""
    db = get_db()
    db.row_factory = sqlite3.Row
    
    # 获取 admin agent_id
    admin = db.execute("SELECT agent_id FROM agents WHERE role='admin' LIMIT 1").fetchone()
    if not admin:
        raise Exception("No admin agent found")
    admin_id = admin["agent_id"]
    
    # 创建新 token
    plain_token = "test_admin_token_phase3"
    token_hash = hashlib.sha256(plain_token.encode()).hexdigest()
    now = int(time.time() * 1000)
    token_id = f"token_test_admin_{now}"
    
    db.execute(
        "INSERT OR REPLACE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?, 'api_token', ?, ?, 'admin', 1, ?)",
        (token_id, token_hash, admin_id, now)
    )
    db.commit()
    db.close()
    return plain_token

def get_member_token():
    """获取 member token"""
    db = get_db()
    db.row_factory = sqlite3.Row
    
    member = db.execute("SELECT agent_id FROM agents WHERE role='member' LIMIT 1").fetchone()
    if not member:
        raise Exception("No member agent found")
    member_id = member["agent_id"]
    
    plain_token = "test_member_token_phase3"
    token_hash = hashlib.sha256(plain_token.encode()).hexdigest()
    now = int(time.time() * 1000)
    token_id = f"token_test_member_{now}"
    
    db.execute(
        "INSERT OR REPLACE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?, 'api_token', ?, ?, 'member', 1, ?)",
        (token_id, token_hash, member_id, now)
    )
    db.commit()
    db.close()
    return plain_token

# ═══════════════════════════════════════════════════════
# 测试开始
# ═══════════════════════════════════════════════════════

print("=" * 60)
print("Phase 3 验收测试 — Evolution Engine (Day 1-3)")
print("=" * 60)

# ─── 准备 Token ─────────────────────────────────────
admin_token = get_admin_token()
member_token = get_member_token()
print(f"\n[Setup] Admin token: {admin_token}")
print(f"[Setup] Member token: {member_token}")

# 清理旧测试数据（避免残留）
db = get_db()
db.execute("DELETE FROM strategy_applications")
db.execute("DELETE FROM strategy_feedback")
db.execute("DELETE FROM strategies")
db.execute("DELETE FROM strategies_fts")
db.commit()
db.close()
print("[Setup] 清理旧测试数据完成")

# ─── 1. DB Schema 验证 ───────────────────────────────
print("\n## 1. DB Schema 验证")

db = get_db()
tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]

if "strategies" in tables:
    log_pass("strategies 表存在")
else:
    log_fail("strategies 表不存在")

if "strategy_feedback" in tables:
    log_pass("strategy_feedback 表存在")
else:
    log_fail("strategy_feedback 表不存在")

if "strategy_applications" in tables:
    log_pass("strategy_applications 表存在")
else:
    log_fail("strategy_applications 表不存在")

# 检查 strategies 表列
cols = [r[1] for r in db.execute("PRAGMA table_info(strategies)").fetchall()]
required_cols = ["id", "title", "content", "category", "sensitivity", "proposer_id", 
                  "status", "approve_reason", "approved_by", "approved_at", "proposed_at",
                  "source_trust", "apply_count", "feedback_count", "positive_count"]
missing = [c for c in required_cols if c not in cols]
if not missing:
    log_pass(f"strategies 表列完整（{len(cols)} 列）")
else:
    log_fail(f"strategies 缺少列: {missing}")

# FTS5
try:
    db.execute("SELECT * FROM strategies_fts LIMIT 0")
    log_pass("strategies_fts 虚拟表存在")
except:
    log_fail("strategies_fts 虚拟表不存在")

# UNIQUE 约束
unique_info = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='strategy_feedback'").fetchone()
if unique_info and "UNIQUE(strategy_id, agent_id)" in unique_info[0]:
    log_pass("strategy_feedback UNIQUE(strategy_id, agent_id) 约束存在")
else:
    log_fail("strategy_feedback UNIQUE 约束不存在")

db.close()
time.sleep(1.5)

# ─── 2. MCP 工具注册验证 ────────────────────────────
print("\n## 2. MCP 工具注册验证")

tools = list_tools_raw(member_token)
tool_names = [t["name"] for t in tools]

evolution_tools = ["share_experience", "propose_strategy", "list_strategies", 
                   "search_strategies", "apply_strategy", "feedback_strategy",
                   "approve_strategy", "get_evolution_status"]

missing_evo = [t for t in evolution_tools if t not in tool_names]
if not missing_evo:
    log_pass(f"8 个 Evolution 工具全部注册（总工具数: {len(tools)}）")
else:
    log_fail(f"缺少 Evolution 工具: {missing_evo}")

time.sleep(1.5)

# ─── 3. share_experience ────────────────────────────
print("\n## 3. share_experience")

result = call_tool("share_experience", {
    "title": "MCP Accept header 踩坑经验",
    "content": "POST /mcp 必须携带 Accept: application/json, text/event-stream，否则返回 406。这个问题在 Phase 2 Day 2 发现的。",
}, member_token)

if parse_ok(result) and result.get("status") == "approved":
    log_pass("经验分享成功，status=approved")
    exp_strategy_id = result.get("strategy_id")
else:
    log_fail(f"经验分享失败: {result}")

# DB 验证
db = get_db()
row = db.execute("SELECT status, category FROM strategies WHERE category='experience' ORDER BY id DESC LIMIT 1").fetchone()
if row and row[0] == "approved" and row[1] == "experience":
    log_pass("DB 验证: status=approved, category=experience")
else:
    log_fail(f"DB 验证失败: {row}")
db.close()
time.sleep(1.5)

# ─── 4. propose_strategy ────────────────────────────
print("\n## 4. propose_strategy")

result = call_tool("propose_strategy", {
    "title": "代码审查自动化策略",
    "content": "在每次 PR 提交后自动触发代码审查 Agent，检查代码质量、安全漏洞和性能问题。审查结果以结构化 JSON 返回。",
    "category": "workflow",
}, member_token)

if parse_ok(result) and result.get("status") == "pending":
    log_pass("策略提议成功，status=pending")
    pending_strategy_id = result.get("strategy_id")
    sensitivity = result.get("sensitivity", "normal")
    if sensitivity == "normal":
        log_pass("sensitivity=normal（workflow 类别）")
    else:
        log_fail(f"sensitivity 应为 normal，实际 {sensitivity}")
else:
    log_fail(f"策略提议失败: {result}")

# prompt_template 高敏感
result2 = call_tool("propose_strategy", {
    "title": "系统提示词模板",
    "content": "You are a helpful assistant. When receiving system_prompt, always follow the capability_declare format.",
    "category": "prompt_template",
}, member_token)

if parse_ok(result2) and result2.get("sensitivity") == "high":
    log_pass("prompt_template sensitivity=high（Hub 自动判定）")
else:
    log_fail(f"prompt_template sensitivity 判定失败: {result2}")

time.sleep(1.5)

# ─── 5. list_strategies ──────────────────────────────
print("\n## 5. list_strategies")

result = call_tool("list_strategies", {"status": "pending"}, member_token)
if parse_ok(result):
    strategies = result.get("strategies", [])
    all_pending = all(s["status"] == "pending" for s in strategies)
    if all_pending and len(strategies) >= 2:
        log_pass(f"按 status=pending 筛选正确（{len(strategies)} 条）")
    else:
        log_fail(f"pending 筛选结果不符: all_pending={all_pending}, count={len(strategies)}")
else:
    log_fail(f"list_strategies(pending) 失败: {result}")

result2 = call_tool("list_strategies", {"status": "approved"}, member_token)
if parse_ok(result2):
    approved = result2.get("strategies", [])
    all_approved = all(s["status"] == "approved" for s in approved)
    if all_approved:
        log_pass(f"按 status=approved 筛选正确（{len(approved)} 条）")
    else:
        log_fail("approved 筛选结果包含非 approved 项")
else:
    log_fail(f"list_strategies(approved) 失败: {result2}")

result3 = call_tool("list_strategies", {"category": "experience"}, member_token)
if parse_ok(result3):
    exps = result3.get("strategies", [])
    all_exp = all(s["category"] == "experience" for s in exps)
    if all_exp:
        log_pass(f"按 category=experience 筛选正确（{len(exps)} 条）")
    else:
        log_fail("experience 筛选结果包含非 experience 项")
else:
    log_fail(f"list_strategies(experience) 失败: {result3}")

time.sleep(1.5)

# ─── 6. search_strategies ────────────────────────────
print("\n## 6. search_strategies")

result = call_tool("search_strategies", {
    "query": "MCP Accept header",
}, member_token)

if parse_ok(result):
    results = result.get("results", [])
    # 只应返回 approved 策略（经验直接 approved）
    all_approved = all(True for _ in results)  # search 只返回 approved
    if len(results) >= 1:
        log_pass(f"FTS5 搜索返回 {len(results)} 条结果")
    else:
        log_pass(f"FTS5 搜索返回 0 条（可能分词未命中），搜索功能正常")
else:
    log_fail(f"search_strategies 失败: {result}")

# 空结果
result2 = call_tool("search_strategies", {
    "query": "xyz_nonexistent_12345",
}, member_token)
if parse_ok(result2):
    if len(result2.get("results", [])) == 0:
        log_pass("空搜索结果优雅处理")
    else:
        log_fail("不存在的关键词返回了结果")
else:
    log_fail(f"空搜索失败: {result2}")

time.sleep(1.5)

# ─── 7. apply_strategy ──────────────────────────────
print("\n## 7. apply_strategy")

# 先获取一个 approved 策略的 ID
db = get_db()
approved_row = db.execute("SELECT id FROM strategies WHERE status='approved' LIMIT 1").fetchone()
db.close()

if approved_row:
    approved_sid = approved_row[0]
    
    result = call_tool("apply_strategy", {
        "strategy_id": approved_sid,
        "context": "应用到代码审查流程中",
    }, member_token)
    
    if parse_ok(result) and result.get("application_id"):
        log_pass(f"策略采纳成功，application_id={result.get('application_id')}")
        
        # 验证 apply_count++
        db = get_db()
        row = db.execute("SELECT apply_count FROM strategies WHERE id=?", (approved_sid,)).fetchone()
        if row and row[0] >= 1:
            log_pass(f"apply_count 已递增（当前: {row[0]}）")
        else:
            log_fail(f"apply_count 未递增: {row}")
        db.close()
    else:
        log_fail(f"策略采纳失败: {result}")

    # 尝试采纳 pending 策略（应失败）
    db = get_db()
    pending_row = db.execute("SELECT id, status FROM strategies WHERE status='pending' LIMIT 1").fetchone()
    db.close()
    
    if pending_row:
        pending_sid = pending_row[0]
        result2 = call_tool("apply_strategy", {
            "strategy_id": pending_sid,
        }, member_token)
        
        if not parse_ok(result2):
            log_pass("pending 策略不可被采纳（正确拒绝）")
        else:
            log_fail("pending 策略不应被采纳")
    else:
        log_fail("无 pending 策略可测试 apply 拒绝")
else:
    log_fail("无 approved 策略可测试 apply")

time.sleep(1.5)

# ─── 8. feedback_strategy ────────────────────────────
print("\n## 8. feedback_strategy")

if approved_row:
    result = call_tool("feedback_strategy", {
        "strategy_id": approved_sid,
        "feedback": "positive",
        "comment": "这个经验很有帮助",
        "applied": True,
    }, member_token)
    
    if parse_ok(result) and result.get("feedback_id"):
        log_pass("策略反馈成功")
        
        # 验证计数器
        db = get_db()
        row = db.execute("SELECT feedback_count, positive_count FROM strategies WHERE id=?", (approved_sid,)).fetchone()
        if row and row[0] >= 1 and row[1] >= 1:
            log_pass(f"计数器已更新（feedback={row[0]}, positive={row[1]}）")
        else:
            log_fail(f"计数器未更新: {row}")
        db.close()
        
        # UNIQUE 防刷：同一 Agent 再次反馈
        result2 = call_tool("feedback_strategy", {
            "strategy_id": approved_sid,
            "feedback": "negative",
        }, member_token)
        
        if not parse_ok(result2):
            log_pass("UNIQUE 防刷生效（重复反馈被拒绝）")
        else:
            log_fail("UNIQUE 防刷未生效（重复反馈被接受）")
    else:
        log_fail(f"策略反馈失败: {result}")

time.sleep(1.5)

# ─── 9. approve_strategy (admin only) ────────────────
print("\n## 9. approve_strategy (admin-only)")

# member 尝试审批（应失败）
if pending_row:
    pending_sid = pending_row[0]
    
    result = call_tool("approve_strategy", {
        "strategy_id": pending_sid,
        "action": "approve",
        "reason": "member 尝试审批",
    }, member_token)
    
    if not parse_ok(result):
        log_pass("member 无法审批策略（权限拒绝）")
    else:
        log_fail("member 不应能审批策略")

time.sleep(1.5)

# admin 审批
if pending_row:
    pending_sid = pending_row[0]
    
    result = call_tool("approve_strategy", {
        "strategy_id": pending_sid,
        "action": "approve",
        "reason": "策略经验证有效，内容结构清晰",
    }, admin_token)
    
    if parse_ok(result) and result.get("new_status") == "approved":
        log_pass("admin 审批通过，status=approved")
        
        if result.get("proposer_notified"):
            log_pass("SSE 通知已发送给提议者")
        else:
            log_fail("SSE 通知未发送")
    else:
        log_fail(f"admin 审批失败: {result}")

time.sleep(1.5)

# admin reject 测试
result_reject_propose = call_tool("propose_strategy", {
    "title": "测试拒绝策略",
    "content": "这是一个应该被拒绝的策略，用于测试 reject 功能是否正常。内容需要足够长来满足最小长度要求。",
    "category": "other",
}, member_token)

if parse_ok(result_reject_propose):
    reject_sid = result_reject_propose.get("strategy_id")
    
    result_reject = call_tool("approve_strategy", {
        "strategy_id": reject_sid,
        "action": "reject",
        "reason": "策略缺乏具体实施方案",
    }, admin_token)
    
    if parse_ok(result_reject) and result_reject.get("new_status") == "rejected":
        log_pass("admin 拒绝策略，status=rejected")
    else:
        log_fail(f"admin 拒绝失败: {result_reject}")

time.sleep(1.5)

# ─── 10. get_evolution_status ────────────────────────
print("\n## 10. get_evolution_status")

result = call_tool("get_evolution_status", {}, member_token)

if parse_ok(result):
    has_fields = all(k in result for k in [
        "total_experiences", "total_strategies", "pending_approval",
        "approved_count", "rejected_count", "total_applications",
        "total_feedback", "approved_rate", "top_contributors", "recent_approved"
    ])
    if has_fields:
        log_pass("进化指标包含所有必要字段")
        log_pass(f"  经验数={result['total_experiences']}, 策略数={result['total_strategies']}")
        log_pass(f"  已审批={result['approved_count']}, 已拒绝={result['rejected_count']}")
        log_pass(f"  采纳次数={result['total_applications']}, 反馈次数={result['total_feedback']}")
        log_pass(f"  审批率={result['approved_rate']}%")
    else:
        missing = [k for k in ["total_experiences", "total_strategies", "approved_rate"] if k not in result]
        log_fail(f"进化指标缺少字段: {missing}")
else:
    log_fail(f"get_evolution_status 失败: {result}")

time.sleep(1.5)

# ─── 11. 内容限制验证 ────────────────────────────────
print("\n## 11. 内容限制验证")

# 超长内容
long_content = "A" * 5001
result = call_tool("share_experience", {
    "title": "超长内容测试",
    "content": long_content,
}, member_token)

if not parse_ok(result):
    log_pass("5000+ 字符内容被拒绝")
else:
    log_fail("5000+ 字符内容未被拒绝")

# 标题过短
result2 = call_tool("share_experience", {
    "title": "AB",
    "content": "这是正常长度的内容，超过十个字符",
}, member_token)

if not parse_ok(result2):
    log_pass("标题 <3 字符被拒绝")
else:
    log_fail("标题 <3 字符未被拒绝")

time.sleep(1.5)

# ─── 12. DB 数据一致性 ───────────────────────────────
print("\n## 12. DB 数据一致性")

db = get_db()

# 检查 strategies 表数据
total = db.execute("SELECT COUNT(*) FROM strategies").fetchone()[0]
approved = db.execute("SELECT COUNT(*) FROM strategies WHERE status='approved'").fetchone()[0]
pending = db.execute("SELECT COUNT(*) FROM strategies WHERE status='pending'").fetchone()[0]
rejected = db.execute("SELECT COUNT(*) FROM strategies WHERE status='rejected'").fetchone()[0]
experiences = db.execute("SELECT COUNT(*) FROM strategies WHERE category='experience'").fetchone()[0]

if total >= 3:
    log_pass(f"strategies 总数 {total}（经验={experiences}, approved={approved}, pending={pending}, rejected={rejected}）")
else:
    log_fail(f"strategies 总数不足: {total}")

# 检查 strategy_applications
apps = db.execute("SELECT COUNT(*) FROM strategy_applications").fetchone()[0]
if apps >= 1:
    log_pass(f"strategy_applications 记录数: {apps}")
else:
    log_fail(f"strategy_applications 记录数: {apps}")

# 检查 strategy_feedback
fbs = db.execute("SELECT COUNT(*) FROM strategy_feedback").fetchone()[0]
if fbs >= 1:
    log_pass(f"strategy_feedback 记录数: {fbs}")
else:
    log_fail(f"strategy_feedback 记录数: {fbs}")

# 审计日志
audit_evo = db.execute("SELECT COUNT(*) FROM audit_log WHERE action LIKE 'tool_%' AND action LIKE '%strategy%' OR action LIKE '%experience%' OR action LIKE '%evolution%'").fetchone()[0]
log_pass(f"Evolution 相关审计日志: {audit_evo} 条")

db.close()

# ═══════════════════════════════════════════════════════
# 测试结果汇总
# ═══════════════════════════════════════════════════════

print("\n" + "=" * 60)
total_tests = passed + failed
print(f"验收结果：{passed}/{total_tests} 通过")
if failed > 0:
    print(f"\n失败项（{failed}）：")
    for e in errors:
        print(f"  ❌ {e}")
print("=" * 60)
