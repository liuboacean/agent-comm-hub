#!/usr/bin/env python3
"""
Week 3 Day 1 验收测试 — Python SDK (hub_client.py)

测试覆盖：
  1. SynergyHubClient 创建 + 健康检查
  2. Bootstrap admin via DB
  3. generate_invite() — 邀请码生成
  4. register() — Agent 注册 + Token 自动设置
  5. heartbeat() — 心跳上报
  6. query_agents() — Agent 列表查询
  7. get_online_agents() — 在线 Agent 列表
  8. send_message() — 消息发送
  9. broadcast_message() — 消息广播
  10. store_memory() — 记忆存储（3 种 scope）
  11. recall_memory() — 记忆搜索
  12. list_memories() — 记忆列表
  13. delete_memory() — 记忆删除
  14. assign_task() + update_task_status() — 任务管理
  15. mark_consumed() + check_consumed() — 消费追踪
  16. 权限矩阵验证（member 不能调 admin 工具）
  17. SSE 连接 + 事件接收 + 客户端去重
"""

import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import uuid

# SDK 路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "client-sdk"))
from hub_client import SynergyHubClient, HubError, AuthError, ToolError

HUB_URL = "http://127.0.0.1:3100"
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "comm_hub.db")

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

def bootstrap_admin():
    """通过 DB 直接创建 admin 账户"""
    admin_id = f"admin_w3d1_{uuid.uuid4().hex[:8]}"
    admin_token = f"tk_admin_w3d1_{uuid.uuid4().hex[:16]}"
    admin_token_hash = hashlib.sha256(admin_token.encode()).hexdigest()
    now = int(time.time() * 1000)
    token_id = f"tok_w3d1_{uuid.uuid4().hex[:8]}"

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM agents WHERE agent_id=?", (admin_id,))
    c.execute("DELETE FROM auth_tokens WHERE agent_id=?", (admin_id,))
    c.execute("INSERT OR IGNORE INTO agents VALUES (?,?,?,?,?,?,?)",
              (admin_id, "admin_w3d1", "admin", None, "online", now, now))
    c.execute("INSERT OR IGNORE INTO auth_tokens VALUES (?,?,?,?,?,?,?,?,?)",
              (token_id, "api_token", admin_token_hash, admin_id, "admin", 1, now, now + 86400000, None))
    conn.commit()
    conn.close()
    return admin_id, admin_token

# ═══════════════════════════════════════════════════════════════
# 开始测试
# ═══════════════════════════════════════════════════════════════

print("=" * 60)
print("Week 3 Day 1 验收测试 — Python SDK")
print("=" * 60)

# ─── 1. 创建客户端 + 健康检查 ─────────────────────────
print("\n[1] 创建客户端 + 健康检查")
client = SynergyHubClient(hub_url=HUB_URL)
test("SynergyHubClient 创建成功", client.hub_url == HUB_URL)
test("默认 agent_id 为 None", client.agent_id is None)
test("默认 token 为 None", client.token is None)
test("默认未连接", not client.is_connected)

health = client.health_check()
test("health_check 返回 ok", health.get("status") == "ok", str(health))

# ─── 2. Bootstrap admin ────────────────────────────────
print("\n[2] Bootstrap admin")
admin_id, admin_token = bootstrap_admin()
admin_client = SynergyHubClient(hub_url=HUB_URL, agent_id=admin_id, token=admin_token)
test("admin 客户端创建", admin_client.agent_id == admin_id)

# ─── 3. generate_invite ───────────────────────────────
print("\n[3] 邀请码生成")
r1 = admin_client.generate_invite("admin")
admin_invite = r1.get("invite_code")
test("生成 admin 邀请码", bool(admin_invite), str(r1))

r2 = admin_client.generate_invite("member")
member_invite = r2.get("invite_code")
test("生成 member 邀请码", bool(member_invite), str(r2))

r3 = admin_client.generate_invite()
default_invite = r3.get("invite_code")
test("默认生成 member 邀请码", bool(default_invite) and r3.get("role") == "member", str(r3))

# ─── 4. register ──────────────────────────────────────
print("\n[4] Agent 注册")
sdk_agent = SynergyHubClient(hub_url=HUB_URL)
reg = sdk_agent.register(invite_code=admin_invite, name="sdk_admin")
test("注册 sdk_admin 成功", reg.get("success"), str(reg))
test("Token 自动设置", bool(sdk_agent.token), "token 未设置")
test("agent_id 自动设置", bool(sdk_agent.agent_id), "agent_id 未设置")
test("role 为 admin", sdk_agent.role == "admin", f"role={sdk_agent.role}")

sdk_member = SynergyHubClient(hub_url=HUB_URL)
reg2 = sdk_member.register(invite_code=member_invite, name="sdk_member_a")
test("注册 sdk_member_a 成功", reg2.get("success"), str(reg2))
test("member role 正确", sdk_member.role == "member", f"role={sdk_member.role}")

sdk_member_b = SynergyHubClient(hub_url=HUB_URL)
reg3 = sdk_member_b.register(invite_code=default_invite, name="sdk_member_b")
test("注册 sdk_member_b 成功", reg3.get("success"), str(reg3))

# 无效邀请码
bad_client = SynergyHubClient(hub_url=HUB_URL)
bad_reg = bad_client.register(invite_code="invalid_code", name="bad_agent")
test("无效邀请码被拒绝", bad_reg.get("success") == False, str(bad_reg))

# ─── 5. heartbeat ─────────────────────────────────────
print("\n[5] 心跳上报")
hb = sdk_member.heartbeat()
test("心跳成功", hb.get("success"), str(hb))

# ─── 6. query_agents ──────────────────────────────────
print("\n[6] Agent 列表查询")
agents = sdk_member.query_agents()
test("query_agents 返回列表", agents.get("count", 0) >= 1, f"count={agents.get('count', 0)}")

# ─── 7. get_online_agents ─────────────────────────────
print("\n[7] 在线 Agent 列表")
online = sdk_member.get_online_agents()
test("get_online_agents 返回列表", isinstance(online, list) and len(online) >= 1, str(online))

# ─── 8. send_message ──────────────────────────────────
print("\n[8] 消息发送")
msg_result = sdk_member.send_message(
    to=admin_id,
    content="Hello from Python SDK!",
    metadata={"source": "test"},
)
test("send_message 成功", msg_result.get("success"), str(msg_result))
# Hub 返回 messageId (camelCase)
msg_id = msg_result.get("message_id") or msg_result.get("messageId")
test("返回 message_id", bool(msg_id), str(msg_result))

# ─── 9. broadcast_message ─────────────────────────────
print("\n[9] 消息广播")
bc_result = sdk_member.broadcast_message(
    agent_ids=[admin_id, sdk_member_b.agent_id],
    content="Broadcast from Python SDK",
)
# broadcast 返回 broadcast:true 而非 success:true
test("broadcast_message 成功", bc_result.get("broadcast") == True or bc_result.get("success") == True, str(bc_result))

# ─── 10. store_memory ─────────────────────────────────
print("\n[10] 记忆存储")
mem1 = sdk_member.store_memory(
    content="Python SDK 测试记忆 — private",
    title="SDK Test Private",
    scope="private",
    tags=["test", "sdk"],
)
test("private 记忆存储成功", mem1.get("success"), str(mem1))

mem2 = sdk_member.store_memory(
    content="Python SDK 测试记忆 — collective，所有Agent可见",
    title="SDK Test Collective",
    scope="collective",
    tags=["test", "shared"],
)
test("collective 记忆存储成功", mem2.get("success"), str(mem2))

mem3 = sdk_member.store_memory(
    content="Python SDK 测试记忆 — group 组内可见",
    scope="group",
    tags=["test"],
)
test("group 记忆存储成功", mem3.get("success"), str(mem3))

# ─── 11. recall_memory ────────────────────────────────
print("\n[11] 记忆搜索")
recall = sdk_member.recall_memory(query="Python SDK 测试记忆", scope="all")
results = recall.get("results", [])
test("recall 返回结果", len(results) >= 1, f"found {len(results)}")

recall2 = sdk_member.recall_memory(query="collective", scope="collective")
results2 = recall2.get("results", [])
test("collective 范围搜索", len(results2) >= 1, f"found {len(results2)}")

# ─── 12. list_memories ────────────────────────────────
print("\n[12] 记忆列表")
mem_list = sdk_member.list_memories(scope="all", limit=10)
test("list_memories 返回列表", mem_list.get("count", 0) >= 3, f"count={mem_list.get('count', 0)}")

mem_list_private = sdk_member.list_memories(scope="private")
test("private 范围筛选", mem_list_private.get("count", 0) >= 1, f"count={mem_list_private.get('count', 0)}")

# 分页
mem_page2 = sdk_member.list_memories(limit=1, offset=0)
test("分页 limit=1", mem_page2.get("count", 0) <= 1, f"count={mem_page2.get('count', 0)}")

# ─── 13. delete_memory ────────────────────────────────
print("\n[13] 记忆删除")
del_mem_id = mem3.get("memory_id")
del_result = sdk_member.delete_memory(del_mem_id)
test("删除自己的记忆成功", del_result.get("success"), str(del_result))

# admin 删除他人记忆
admin_del = sdk_agent.delete_memory(mem1.get("memory_id"))
test("admin 可删除他人记忆", admin_del.get("success"), str(admin_del))

# member 删除他人记忆失败
del_other = sdk_member_b.delete_memory(mem2.get("memory_id"))
test("member 不能删除他人记忆", del_other.get("success") == False, str(del_other))

# ─── 14. 任务管理 ─────────────────────────────────────
print("\n[14] 任务管理")
task = sdk_member.assign_task(
    to=admin_id,
    description="Python SDK 测试任务",
    context="这是一条来自 Python SDK 的测试任务",
    priority="high",
)
test("assign_task 成功", task.get("success"), str(task))
task_id = task.get("task_id")

if task_id:
    update = sdk_member.update_task_status(
        task_id=task_id,
        status="in_progress",
        progress=50,
    )
    test("update_task_status 成功", update.get("success"), str(update))

    complete = sdk_member.update_task_status(
        task_id=task_id,
        status="completed",
        result="测试完成",
        progress=100,
    )
    test("complete task 成功", complete.get("success"), str(complete))

    status = sdk_member.get_task_status(task_id)
    test("get_task_status 返回状态", status.get("status") == "completed", str(status))

# ─── 15. 消费追踪 ─────────────────────────────────────
print("\n[15] 消费追踪")
mark = sdk_member.mark_consumed(resource="test_resource_001")
test("mark_consumed 成功", mark.get("success"), str(mark))

check = sdk_member.check_consumed(resource="test_resource_001")
test("check_consumed 返回已消费", check.get("consumed") == True, str(check))

check2 = sdk_member.check_consumed(resource="nonexistent_resource")
test("check_consumed 返回未消费", check2.get("consumed") == False, str(check2))

# ─── 16. 权限矩阵验证 ─────────────────────────────────
print("\n[16] 权限矩阵验证")
try:
    sdk_member.revoke_token(token_id="any_token")
    test("member 不能调 revoke_token", False, "应该抛出 ToolError")
except (HubError, ToolError) as e:
    test("member 不能调 revoke_token", True, str(e))

# 无 Token 的 client 不能调需要认证的工具
no_auth = SynergyHubClient(hub_url=HUB_URL)
no_auth.agent_id = "ghost"
try:
    no_auth.send_message(to="anyone", content="test")
    test("无 Token 调 send_message 被拒绝", False, "应该抛出异常")
except (AuthError, HubError, ToolError) as e:
    test("无 Token 调 send_message 被拒绝", True, str(e))

# ─── 17. SSE 连接 + 客户端去重 ────────────────────────
print("\n[17] SSE 连接 + 客户端去重")
received_events = []
sse_ready = threading.Event()

def on_msg(msg):
    received_events.append(("message", msg))

sdk_member.on_message = on_msg

# 非阻塞启动 SSE
sdk_member.connect_sse(blocking=False)

# 等待 SSE 连接建立（SSE 连接可能需要 2-3 秒）
time.sleep(3)
test("SSE 连接建立", sdk_member.is_connected, "未连接")

if sdk_member.is_connected:
    # 发送测试消息触发 SSE 事件
    sdk_agent.send_message(to=sdk_member.agent_id, content="SSE 测试消息 1")
    time.sleep(3)  # 等待 SSE 推送
else:
    print("    ⚠️ SSE 未连接，跳过消息接收测试")

# 检查是否收到消息（SSE 可能延迟）
found_msg = any("SSE 测试消息" in str(e[1].get("content", "")) for e in received_events)
test("SSE 收到消息推送", found_msg, f"received {len(received_events)} events: {[e[0] for e in received_events]}")

# 客户端去重验证
test("去重集合存在", len(sdk_member._seen_event_ids) > 0, "seen_event_ids 为空")

# 断开 SSE
sdk_member.disconnect_sse()
time.sleep(1)
test("SSE 断开成功", not sdk_member.is_connected, "仍在连接")

# ─── 18. REST API 补充 ────────────────────────────────
print("\n[18] REST API")
tasks = sdk_member.get_tasks(status="pending")
test("REST get_tasks 成功", isinstance(tasks.get("tasks"), list), str(tasks))

# ─── 19. 工厂方法 ─────────────────────────────────────
print("\n[19. 工厂方法")
from hub_client import create_client
factory_client = create_client(hub_url=HUB_URL)
test("create_client 无注册", factory_client.agent_id is None)
test("create_client 返回正确类型", isinstance(factory_client, SynergyHubClient))

# ─── 20. repr ─────────────────────────────────────────
print("\n[20. repr")
r = repr(sdk_member)
test("repr 包含 agent_id", sdk_member.agent_id in r, r)
test("repr 包含 hub_url", HUB_URL in r, r)

# ═══════════════════════════════════════════════════════════════
# 结果汇总
# ═══════════════════════════════════════════════════════════════

print("\n" + "=" * 60)
print(f"结果: {passed}/{passed + failed} 通过")
if failed > 0:
    print(f"失败: {failed} 项")
print("=" * 60)

sys.exit(0 if failed == 0 else 1)
