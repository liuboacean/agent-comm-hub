#!/usr/bin/env python3
"""
Phase 3 Day 4 — 全量回归测试
覆盖 26 个 MCP 工具 + Python SDK Evolution 方法 + Phase 1/2 零回归

测试组：
  1. 工具注册（26 个）
  2. Phase 1 基础工具（register/heartbeat/query/revoke/trust/online）
  3. Phase 1 消息工具（send/broadcast/acknowledge）
  4. Phase 1 任务工具（assign/update_status/get_status）
  5. Phase 1 记忆工具（store/recall/list/delete）
  6. Phase 2 消费追踪（mark_consumed/check_consumed）
  7. Evolution 工具（share/propose/list/search/apply/feedback/approve/status）
  8. Python SDK Evolution 方法（通过 SDK 类调用验证）
  9. 权限隔离（admin-only 工具 member 不可调用）
  10. 端到端全链路（经验→策略→审批→采纳→反馈→统计）
"""

import http.client
import json
import hashlib
import time
import sqlite3
import sys
import os

# ─── 配置 ────────────────────────────────────────────────────

HUB_PORT = 3100
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'comm_hub.db')

if not os.path.exists(DB_PATH):
    print(f"[FATAL] DB not found: {DB_PATH}")
    sys.exit(1)

# ─── 计数器 ──────────────────────────────────────────────────

_pass = 0
_fail = 0

def log_pass(msg):
    global _pass
    _pass += 1
    print(f"  ✅ {msg}")

def log_fail(msg):
    global _fail
    _fail += 1
    print(f"  ❌ {msg}")

def parse_ok(data):
    """检查业务操作是否成功"""
    if "success" in data:
        return data["success"] is True
    if data.get("isError", False):
        return False
    return not data.get("error")

# ─── DB 辅助 ─────────────────────────────────────────────────

def get_db():
    return sqlite3.connect(DB_PATH)

# ─── MCP 协议 ────────────────────────────────────────────────

def mcp_req(method, params, token=None):
    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
    try:
        conn = http.client.HTTPConnection('localhost', HUB_PORT, timeout=15)
        conn.request('POST', '/mcp', body.encode(), headers)
        raw = conn.getresponse().read().decode()
        conn.close()
        for line in raw.split('\n'):
            if line.strip().startswith('data: '):
                return json.loads(line.strip()[6:])
    except Exception as e:
        return {'error': str(e)}
    return {}

def call_tool(name, args, token=None):
    r = mcp_req('tools/call', {'name': name, 'arguments': args}, token)
    if 'result' in r and 'content' in r['result']:
        # MCP isError 标志（权限拒绝等）
        if r['result'].get('isError', False):
            try:
                inner = json.loads(r['result']['content'][0]['text'])
                return {**inner, 'isError': True}
            except (json.JSONDecodeError, IndexError, TypeError):
                return {'error': r['result']['content'][0].get('text', ''), 'isError': True}
        try:
            return json.loads(r['result']['content'][0]['text'])
        except (json.JSONDecodeError, IndexError, TypeError):
            return {'raw': r}
    if 'error' in r:
        return {'error': r['error'].get('message', str(r['error'])), 'isError': True}
    return {'raw': r}

# ─── Setup：创建测试 token ──────────────────────────────────

db = get_db()

# 清理之前的测试数据（Evolution 表）
db.execute("DELETE FROM strategy_applications")
db.execute("DELETE FROM strategy_feedback")
db.execute("DELETE FROM strategies")
db.execute("DELETE FROM strategies_fts")
db.commit()

# 获取 admin 和 member agent
admin_row = db.execute("SELECT agent_id FROM agents WHERE role='admin' LIMIT 1").fetchone()
member_row = db.execute("SELECT agent_id FROM agents WHERE role='member' LIMIT 1").fetchone()

if not admin_row or not member_row:
    print("[FATAL] 需要 admin 和 member agent")
    sys.exit(1)

admin_id = admin_row[0]
member_id = member_row[0]

# 创建 token
now_ms = int(time.time() * 1000)
admin_plain = f"p3d4_admin_{now_ms}"
member_plain = f"p3d4_member_{now_ms}"
admin_hash = hashlib.sha256(admin_plain.encode()).hexdigest()
member_hash = hashlib.sha256(member_plain.encode()).hexdigest()

db.execute("INSERT OR REPLACE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    (f"at_d4_{now_ms}", "api_token", admin_hash, admin_id, "admin", now_ms))
db.execute("INSERT OR REPLACE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    (f"mt_d4_{now_ms}", "api_token", member_hash, member_id, "member", now_ms))
db.commit()
db.close()

print(f"Admin: {admin_id} | Member: {member_id}")
time.sleep(1.5)

# ═════════════════════════════════════════════════════════════
print("\n" + "="*60)
print("  Phase 3 Day 4 — 全量回归测试")
print("="*60)

# ─── 1. 工具注册（26 个）────────────────────────────────────
print("\n── 1. 工具注册验证 ──")

r = mcp_req('tools/list', {})
tools = r.get('result', {}).get('tools', [])
expected_count = 26
expected_names = [
    "register_agent", "heartbeat", "query_agents", "revoke_token", "set_trust_score",
    "send_message", "assign_task", "update_task_status", "get_task_status", "broadcast_message",
    "store_memory", "recall_memory", "list_memories", "delete_memory", "get_online_agents",
    "acknowledge_message", "mark_consumed", "check_consumed",
    "share_experience", "propose_strategy", "list_strategies", "search_strategies",
    "apply_strategy", "feedback_strategy", "approve_strategy", "get_evolution_status",
]

if len(tools) == expected_count:
    log_pass(f"26/26 工具注册成功")
else:
    log_fail(f"工具数量不匹配: {len(tools)} vs {expected_count}")

registered_names = [t["name"] for t in tools]
missing = [n for n in expected_names if n not in registered_names]
extra = [n for n in registered_names if n not in expected_names]

if not missing:
    log_pass("所有预期工具均已注册")
else:
    log_fail(f"缺少工具: {missing}")

if not extra:
    log_pass("无多余工具")
else:
    log_fail(f"多余工具: {extra}")

# ─── 2. Phase 1 基础工具 ──────────────────────────────────
print("\n── 2. Phase 1 基础工具 ──")

# heartbeat
r = call_tool("heartbeat", {"agent_id": member_id}, member_plain)
if parse_ok(r):
    log_pass("heartbeat 成功")
else:
    log_fail(f"heartbeat 失败: {r}")

time.sleep(1.5)

# query_agents
r = call_tool("query_agents", {"role": "admin"}, member_plain)
if r.get("agents") is not None or r.get("count") is not None:
    log_pass("query_agents 成功")
else:
    log_fail(f"query_agents 失败: {r}")

time.sleep(1.5)

# get_online_agents
r = call_tool("get_online_agents", {}, member_plain)
if "online_agents" in r:
    log_pass("get_online_agents 成功")
else:
    log_fail(f"get_online_agents 失败: {r}")

time.sleep(1.5)

# set_trust_score (admin)
r = call_tool("set_trust_score", {"agent_id": member_id, "delta": 5}, admin_plain)
if parse_ok(r):
    log_pass("set_trust_score (admin) 成功")
else:
    log_fail(f"set_trust_score 失败: {r}")

time.sleep(1.5)

# ─── 3. Phase 1 消息工具 ──────────────────────────────────
print("\n── 3. Phase 1 消息工具 ──")

# send_message（用时间戳确保唯一内容，避免去重）
r = call_tool("send_message", {
    "from": member_id, "to": admin_id,
    "content": f"Day4 回归测试消息 #{now_ms}", "type": "message"
}, member_plain)
if parse_ok(r):
    log_pass("send_message 成功")
    msg_id = r.get("message_id", "")
else:
    log_fail(f"send_message 失败: {r}")
    msg_id = ""

time.sleep(1.5)

# broadcast_message
r = call_tool("broadcast_message", {
    "from": member_id, "agent_ids": [admin_id],
    "content": "Day4 广播测试"
}, member_plain)
if parse_ok(r):
    log_pass("broadcast_message 成功")
else:
    log_fail(f"broadcast_message 失败: {r}")

time.sleep(1.5)

# acknowledge_message
if msg_id:
    r = call_tool("acknowledge_message", {"message_id": msg_id}, member_plain)
    if parse_ok(r):
        log_pass("acknowledge_message 成功")
    else:
        log_fail(f"acknowledge_message 失败: {r}")
    time.sleep(1.5)

# ─── 4. Phase 1 任务工具 ──────────────────────────────────
print("\n── 4. Phase 1 任务工具 ──")

# assign_task
r = call_tool("assign_task", {
    "from": admin_id, "to": member_id,
    "description": "Day4 回归测试任务",
    "priority": "normal"
}, admin_plain)
if parse_ok(r):
    log_pass("assign_task 成功")
    task_id = r.get("task_id", "")
else:
    log_fail(f"assign_task 失败: {r}")
    task_id = ""

time.sleep(1.5)

# update_task_status
if task_id:
    r = call_tool("update_task_status", {
        "task_id": task_id, "agent_id": member_id,
        "status": "in_progress", "progress": 50
    }, member_plain)
    if parse_ok(r):
        log_pass("update_task_status 成功")
    else:
        log_fail(f"update_task_status 失败: {r}")
    time.sleep(1.5)

    # get_task_status
    r = call_tool("get_task_status", {"task_id": task_id}, member_plain)
    if "task" in r or "status" in r:
        log_pass("get_task_status 成功")
    else:
        log_fail(f"get_task_status 失败: {r}")
    time.sleep(1.5)

# ─── 5. Phase 1 记忆工具 ──────────────────────────────────
print("\n── 5. Phase 1 记忆工具 ──")

# store_memory
r = call_tool("store_memory", {
    "content": "Day4 回归测试记忆内容，用于验证记忆功能零回归。",
    "scope": "private"
}, member_plain)
if parse_ok(r):
    log_pass("store_memory 成功")
    mem_id = r.get("memory_id", "")
else:
    log_fail(f"store_memory 失败: {r}")
    mem_id = ""

time.sleep(1.5)

# recall_memory
r = call_tool("recall_memory", {"query": "回归测试", "scope": "all"}, member_plain)
if "results" in r or "count" in r:
    log_pass("recall_memory 成功")
else:
    log_fail(f"recall_memory 失败: {r}")

time.sleep(1.5)

# list_memories
r = call_tool("list_memories", {"scope": "private", "limit": 5}, member_plain)
if "memories" in r or "count" in r:
    log_pass("list_memories 成功")
else:
    log_fail(f"list_memories 失败: {r}")

time.sleep(1.5)

# delete_memory
if mem_id:
    r = call_tool("delete_memory", {"memory_id": mem_id}, member_plain)
    if parse_ok(r):
        log_pass("delete_memory 成功")
    else:
        log_fail(f"delete_memory 失败: {r}")
    time.sleep(1.5)

# ─── 6. Phase 2 消费追踪 ──────────────────────────────────
print("\n── 6. Phase 2 消费追踪 ──")

# mark_consumed
r = call_tool("mark_consumed", {
    "agent_id": member_id, "resource": "day4_test_resource_001",
    "resource_type": "file", "action": "processed"
}, member_plain)
if parse_ok(r):
    log_pass("mark_consumed 成功")
else:
    log_fail(f"mark_consumed 失败: {r}")

time.sleep(1.5)

# check_consumed
r = call_tool("check_consumed", {
    "agent_id": member_id, "resource": "day4_test_resource_001"
}, member_plain)
if r.get("consumed") is not None:
    log_pass("check_consumed 成功")
else:
    log_fail(f"check_consumed 失败: {r}")

time.sleep(1.5)

# ─── 7. Evolution 工具 ────────────────────────────────────
print("\n── 7. Evolution 工具 ──")

# share_experience
r = call_tool("share_experience", {
    "title": "Day4 经验分享测试",
    "content": "这是一个回归测试经验分享，验证 share_experience 功能零回归。内容需要超过十个字符。"
}, member_plain)
if parse_ok(r):
    log_pass("share_experience 成功")
    exp_sid = r.get("strategy_id", 0)
else:
    log_fail(f"share_experience 失败: {r}")
    exp_sid = 0

time.sleep(1.5)

# propose_strategy
r = call_tool("propose_strategy", {
    "title": "Day4 策略提议测试",
    "content": "这是一个回归测试策略提议，验证 propose_strategy 功能零回归。内容需要超过十个字符。",
    "category": "workflow"
}, member_plain)
if parse_ok(r) and r.get("status") == "pending":
    log_pass("propose_strategy 成功（status=pending）")
    prop_sid = r.get("strategy_id", 0)
else:
    log_fail(f"propose_strategy 失败: {r}")
    prop_sid = 0

time.sleep(1.5)

# list_strategies
r = call_tool("list_strategies", {"status": "all", "limit": 10}, member_plain)
if "strategies" in r and len(r["strategies"]) >= 2:
    log_pass(f"list_strategies 成功（{len(r['strategies'])} 条）")
else:
    log_fail(f"list_strategies 失败: {r}")

time.sleep(1.5)

# search_strategies (英文搜索)
r = call_tool("search_strategies", {"query": "Day4 experience"}, member_plain)
if "results" in r:
    log_pass(f"search_strategies 成功（{len(r.get('results', []))} 条）")
else:
    log_fail(f"search_strategies 失败: {r}")

time.sleep(1.5)

# apply_strategy (对已 approved 的经验)
if exp_sid:
    r = call_tool("apply_strategy", {"strategy_id": exp_sid}, member_plain)
    if parse_ok(r):
        log_pass("apply_strategy（经验）成功")
    else:
        log_fail(f"apply_strategy 失败: {r}")
    time.sleep(1.5)

# feedback_strategy
if exp_sid:
    r = call_tool("feedback_strategy", {
        "strategy_id": exp_sid, "feedback": "positive"
    }, member_plain)
    if parse_ok(r):
        log_pass("feedback_strategy 成功")
    else:
        log_fail(f"feedback_strategy 失败: {r}")
    time.sleep(1.5)

# approve_strategy (admin)
if prop_sid:
    r = call_tool("approve_strategy", {
        "strategy_id": prop_sid, "action": "approve",
        "reason": "Day4 回归测试审批通过"
    }, admin_plain)
    if parse_ok(r) and r.get("new_status") == "approved":
        log_pass("approve_strategy 成功（approved）")
    else:
        log_fail(f"approve_strategy 失败: {r}")
    time.sleep(1.5)

# get_evolution_status
r = call_tool("get_evolution_status", {}, member_plain)
if all(k in r for k in ["total_experiences", "total_strategies", "pending_approval"]):
    log_pass(f"get_evolution_status 成功（经验={r['total_experiences']}，策略={r['total_strategies']}）")
else:
    log_fail(f"get_evolution_status 缺少字段: {r}")

time.sleep(1.5)

# ─── 8. Python SDK Evolution 方法 ─────────────────────────
print("\n── 8. Python SDK Evolution 方法 ──")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'client-sdk'))
from hub_client import SynergyHubClient

client = SynergyHubClient(
    hub_url=f"http://localhost:{HUB_PORT}",
    agent_id=member_id,
    token=member_plain,
)

# 验证 SDK 方法存在
sdk_methods = [
    "share_experience", "propose_strategy", "list_strategies",
    "search_strategies", "apply_strategy", "feedback_strategy",
    "approve_strategy", "get_evolution_status",
]

for method in sdk_methods:
    if hasattr(client, method):
        log_pass(f"SDK.{method} 方法存在")
    else:
        log_fail(f"SDK.{method} 方法缺失")

# 通过 SDK 调用 share_experience
try:
    r = client.share_experience(
        title="SDK 经验分享测试",
        content="通过 Python SDK 调用 share_experience，验证 SDK 方法端到端可用。"
    )
    if parse_ok(r):
        log_pass("SDK.share_experience 端到端成功")
    else:
        log_fail(f"SDK.share_experience 调用失败: {r}")
except Exception as e:
    log_fail(f"SDK.share_experience 异常: {e}")

time.sleep(1.5)

# 通过 SDK 调用 get_evolution_status
try:
    r = client.get_evolution_status()
    if "total_experiences" in r:
        log_pass("SDK.get_evolution_status 端到端成功")
    else:
        log_fail(f"SDK.get_evolution_status 返回异常: {r}")
except Exception as e:
    log_fail(f"SDK.get_evolution_status 异常: {e}")

time.sleep(1.5)

# ─── 9. 权限隔离 ──────────────────────────────────────────
print("\n── 9. 权限隔离 ──")
# 等速率窗口恢复（前面大量调用可能触发速率限制）
time.sleep(3)

# member 调用 approve_strategy（应失败）
if prop_sid:
    r = call_tool("approve_strategy", {
        "strategy_id": prop_sid, "action": "approve",
        "reason": "member 不应该能审批"
    }, member_plain)
    if not parse_ok(r):
        log_pass("member 调用 approve_strategy 被拒（正确）")
    else:
        log_fail("member 调用 approve_strategy 未被拒绝！")
    time.sleep(1.5)

# member 调用 set_trust_score（应失败）
r = call_tool("set_trust_score", {
    "agent_id": admin_id, "delta": -100
}, member_plain)
if not parse_ok(r):
    log_pass("member 调用 set_trust_score 被拒（正确）")
else:
    log_fail("member 调用 set_trust_score 未被拒绝！")

time.sleep(1.5)

# ─── 10. 端到端全链路 ─────────────────────────────────────
print("\n── 10. 端到端全链路 ──")

# Step 1: share 经验
r = call_tool("share_experience", {
    "title": "E2E 经验：API 限流最佳实践",
    "content": "在高并发场景下，建议使用滑动窗口限流算法。每分钟最多 60 次请求，超出后返回 429。"
}, member_plain)
e2e_exp_id = r.get("strategy_id", 0)
if parse_ok(r):
    log_pass("E2E Step 1: 经验分享成功")
else:
    log_fail(f"E2E Step 1 失败: {r}")
time.sleep(1.5)

# Step 2: propose 策略
r = call_tool("propose_strategy", {
    "title": "E2E 策略：统一错误处理规范",
    "content": "所有 Agent 返回错误时应包含 error_code、message、trace_id 三个字段。",
    "category": "workflow"
}, member_plain)
e2e_prop_id = r.get("strategy_id", 0)
if parse_ok(r) and r.get("status") == "pending":
    log_pass("E2E Step 2: 策略提议成功（pending）")
else:
    log_fail(f"E2E Step 2 失败: {r}")
time.sleep(1.5)

# Step 3: admin 审批
r = call_tool("approve_strategy", {
    "strategy_id": e2e_prop_id, "action": "approve",
    "reason": "规范合理，批准实施"
}, admin_plain)
if parse_ok(r) and r.get("new_status") == "approved":
    log_pass("E2E Step 3: admin 审批通过")
else:
    log_fail(f"E2E Step 3 失败: {r}")
time.sleep(1.5)

# Step 4: 采纳策略
r = call_tool("apply_strategy", {
    "strategy_id": e2e_prop_id, "context": "E2E 全链路测试采纳场景"
}, member_plain)
if parse_ok(r):
    log_pass("E2E Step 4: 策略采纳成功")
else:
    log_fail(f"E2E Step 4 失败: {r}")
time.sleep(1.5)

# Step 5: 反馈
r = call_tool("feedback_strategy", {
    "strategy_id": e2e_prop_id, "feedback": "positive",
    "comment": "规范实用，建议推广"
}, member_plain)
if parse_ok(r):
    log_pass("E2E Step 5: 反馈成功")
else:
    log_fail(f"E2E Step 5 失败: {r}")
time.sleep(1.5)

# Step 6: 验证统计
r = call_tool("get_evolution_status", {}, member_plain)
exp_count = r.get("total_experiences", 0)
strat_count = r.get("total_strategies", 0)
if exp_count >= 3 and strat_count >= 2:
    log_pass(f"E2E Step 6: 统计正确（经验={exp_count}，策略={strat_count}）")
else:
    log_fail(f"E2E Step 6: 统计不正确（经验={exp_count}，策略={strat_count}）")

# ═════════════════════════════════════════════════════════════
print("\n" + "="*60)
total = _pass + _fail
print(f"  结果: {_pass}/{total} 通过", end="")
if _fail > 0:
    print(f"  ❌ {_fail} 失败")
else:
    print("  ✅ 全部通过")
print("="*60)

sys.exit(0 if _fail == 0 else 1)
