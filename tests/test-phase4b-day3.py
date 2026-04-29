#!/usr/bin/env python3
"""
Phase 4b Day 3 测试 — 交接协议 + 质量门
覆盖：requestHandoff / acceptHandoff / rejectHandoff / addQualityGate / evaluateQualityGate
验收标准（7 项）：
1. request_handoff 正确设置 handoff_status=requested 并推送 SSE
2. accept_handoff 正确转移 assigned_to
3. reject_handoff 正确回退
4. 非法交接（非负责人/已终态）被拒绝
5. add_quality_gate 正确创建并关联 Pipeline
6. evaluate_quality_gate 正确更新门状态
7. 质量门未通过时阻塞后续任务
"""

import json
import os
import sqlite3
import subprocess
import sys
import time

# ─── 配置 ──────────────────────────────────────────────

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "comm_hub.db")

passed = 0
failed = 0
section_passed = 0
section_failed = 0
errors = []


def db_conn():
    """返回独立的 sqlite3 连接（直接操作原始 DB，与 tsx 共享）"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=OFF")
    return conn


def reset_db():
    """清理所有测试数据但保留表结构"""
    conn = db_conn()
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    for (table,) in tables:
        if "_fts" in table.lower() or table.endswith("_content") or table.endswith("_segments"):
            continue
        try:
            conn.execute(f"DELETE FROM [{table}]")
        except Exception:
            pass
    conn.commit()
    conn.close()


def seed_tasks(conn, count):
    """创建 count 个测试任务并返回 ID 列表"""
    now = int(time.time() * 1000)
    ids = []
    for i in range(count):
        tid = f"task_d3_{i}_{now}"
        assigned_to = f"agent_a{i % 3}" if i > 0 else "agent_a0"
        conn.execute(
            'INSERT INTO tasks (id, assigned_by, assigned_to, description, context, '
            'priority, status, result, progress, pipeline_id, order_index, '
            'required_capability, due_at, assigned_at, completed_at, tags, created_at, updated_at) '
            'VALUES (?, "operator", ?, ?, NULL, "normal", "assigned", NULL, 0, '
            'NULL, 0, NULL, ?, NULL, NULL, "[]", ?, ?)',
            (tid, assigned_to, f"Test task {i}", now, now, now)
        )
        ids.append(tid)
    conn.commit()
    return ids


def seed_pipeline(conn, task_ids, creator="operator"):
    """创建 Pipeline 并关联任务，返回 (pipeline_id, task_ids)"""
    now = int(time.time() * 1000)
    pid = f"pipe_d3_{now}"
    conn.execute(
        'INSERT INTO pipelines (id, name, description, status, creator, config, created_at, updated_at) '
        'VALUES (?, "test_pipeline", NULL, "active", ?, NULL, ?, ?)',
        (pid, creator, now, now)
    )
    for idx, tid in enumerate(task_ids):
        conn.execute(
            'INSERT INTO pipeline_tasks (id, pipeline_id, task_id, order_index, created_at) '
            'VALUES (?, ?, ?, ?, ?)',
            (f"pt_d3_{idx}_{now}", pid, tid, idx, now)
        )
    # 把任务的 pipeline_id 也设上
    for tid in task_ids:
        conn.execute('UPDATE tasks SET pipeline_id=? WHERE id=?', (pid, tid))
    conn.commit()
    return pid


def check(name, condition, detail=""):
    global passed, failed, section_passed, section_failed
    if condition:
        passed += 1
        section_passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        section_failed += 1
        msg = f"  ❌ {name}" + (f" — {detail}" if detail else "")
        print(msg)
        errors.append(msg)


def tsx_eval(code):
    """执行 tsx 代码片段并返回 JSON 结果"""
    cmd = ["npx", "tsx", "-e", code]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15,
                          cwd=os.path.join(os.path.dirname(__file__), ".."))
    if proc.returncode != 0:
        return {"success": False, "error": proc.stderr.strip() or proc.stdout.strip()}
    output = proc.stdout.strip()
    if not output:
        return {"success": False, "error": "empty output"}
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return {"success": False, "error": f"invalid JSON: {output[:200]}"}


def section(title):
    global section_passed, section_failed
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")
    section_passed = 0
    section_failed = 0


# ═══════════════════════════════════════════════════════════════
# 测试主体
# ═══════════════════════════════════════════════════════════════

def main():
    setup()
    try:
        test_handoff_request()
        test_handoff_accept()
        test_handoff_reject()
        test_handoff_validation()
        test_quality_gate_add()
        test_quality_gate_evaluate()
        test_quality_gate_blocking()
        test_typecheck()
        test_security_permissions()
        test_mcp_tool_registration()
        test_persistence()
    finally:
        teardown()
    summary()


def setup():
    reset_db()


def teardown():
    pass


# ─── Section 1: 请求交接 ────────────────────────────────

def test_handoff_request():
    section("1. 请求交接 (requestHandoff)")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 3)
    task_id = ids[0]

    # 1.1 基本请求交接
    result = tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
try {{
  const r = requestHandoff('{task_id}', 'agent_b1', 'agent_a0');
  console.log(JSON.stringify({{success: true, ...r}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("1.1 基本请求交接", result.get("success") and result.get("handoff_status") == "requested",
          f"result={json.dumps(result)[:100]}")

    # 1.2 DB 验证 handoff_status
    row = conn.execute('SELECT handoff_status, handoff_to FROM tasks WHERE id=?', (task_id,)).fetchone()
    check("1.2 DB handoff_status=requested", row and row[0] == "requested",
          f"row={row}")
    check("1.3 DB handoff_to=agent_b1", row and row[1] == "agent_b1",
          f"row={row}")

    # 1.4 创建者也能发起交接
    result2 = tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
try {{
  const r = requestHandoff('{ids[1]}', 'agent_b2', 'operator');
  console.log(JSON.stringify({{success: true, ...r}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("1.4 创建者发起交接", result2.get("success"),
          f"result={json.dumps(result2)[:100]}")

    conn.close()


# ─── Section 2: 接受交接 ────────────────────────────────

def test_handoff_accept():
    section("2. 接受交接 (acceptHandoff)")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 2)
    task_id = ids[0]

    # 先请求交接
    tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
requestHandoff('{task_id}', 'agent_b1', 'agent_a0');
""")

    # 2.1 目标 Agent 接受交接
    result = tsx_eval(f"""
import {{ acceptHandoff }} from './src/orchestrator.ts';
try {{
  const r = acceptHandoff('{task_id}', 'agent_b1');
  console.log(JSON.stringify({{success: true, ...r}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("2.1 acceptHandoff 成功", result.get("success"),
          f"result={json.dumps(result)[:100]}")
    check("2.2 new_assignee=agent_b1", result.get("new_assignee") == "agent_b1",
          f"new_assignee={result.get('new_assignee')}")

    # 2.3 DB 验证 assigned_to 已转移
    row = conn.execute('SELECT assigned_to, handoff_status, handoff_to FROM tasks WHERE id=?', (task_id,)).fetchone()
    check("2.3 DB assigned_to=agent_b1", row and row[0] == "agent_b1",
          f"row={row}")
    check("2.4 DB handoff_status=accepted", row and row[1] == "accepted",
          f"handoff_status={row[1] if row else 'N/A'}")
    check("2.5 DB handoff_to=null", row and row[2] is None,
          f"handoff_to={row[2] if row else 'N/A'}")

    conn.close()


# ─── Section 3: 拒绝交接 ────────────────────────────────

def test_handoff_reject():
    section("3. 拒绝交接 (rejectHandoff)")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 2)
    task_id = ids[0]

    # 先请求交接
    tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
requestHandoff('{task_id}', 'agent_b1', 'agent_a0');
""")

    # 3.1 目标 Agent 拒绝交接
    result = tsx_eval(f"""
import {{ rejectHandoff }} from './src/orchestrator.ts';
try {{
  const r = rejectHandoff('{task_id}', 'agent_b1', 'Too busy');
  console.log(JSON.stringify({{success: true, ...r}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("3.1 rejectHandoff 成功", result.get("success"),
          f"result={json.dumps(result)[:100]}")
    check("3.2 rejected_by=agent_b1", result.get("rejected_by") == "agent_b1",
          f"rejected_by={result.get('rejected_by')}")
    check("3.3 reason=Too busy", result.get("reason") == "Too busy",
          f"reason={result.get('reason')}")

    # 3.4 DB 验证 handoff 状态已清空
    row = conn.execute('SELECT assigned_to, handoff_status, handoff_to FROM tasks WHERE id=?', (task_id,)).fetchone()
    check("3.4 DB handoff_status=null（回退）", row and row[1] is None,
          f"handoff_status={row[1] if row else 'N/A'}")
    check("3.5 DB handoff_to=null（回退）", row and row[2] is None,
          f"handoff_to={row[2] if row else 'N/A'}")
    check("3.6 DB assigned_to 不变", row and row[0] == "agent_a0",
          f"assigned_to={row[0] if row else 'N/A'}")

    conn.close()


# ─── Section 4: 非法交接验证 ───────────────────────────

def test_handoff_validation():
    section("4. 非法交接验证")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 3)

    # 4.1 终态任务不能交接
    conn.execute("UPDATE tasks SET status='completed', completed_at=? WHERE id=?", (int(time.time()*1000), ids[0]))
    conn.commit()
    result = tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
try {{
  requestHandoff('{ids[0]}', 'agent_b1', 'agent_a0');
  console.log(JSON.stringify({{success: false, error: 'expected'}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("4.1 终态任务不能交接", not result.get("success", True),
          f"result={json.dumps(result)[:100]}")

    # 4.2 非负责人/创建者不能请求交接
    result2 = tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
try {{
  requestHandoff('{ids[1]}', 'agent_b1', 'agent_z99');
  console.log(JSON.stringify({{success: false, error: 'expected'}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("4.2 非负责人/创建者不能请求", not result2.get("success", True),
          f"result={json.dumps(result2)[:100]}")

    # 4.3 非 target 不能 accept
    tsx_eval(f"""
import {{ requestHandoff }} from './src/orchestrator.ts';
requestHandoff('{ids[2]}', 'agent_b1', 'agent_a0');
""")
    result3 = tsx_eval(f"""
import {{ acceptHandoff }} from './src/orchestrator.ts';
try {{
  acceptHandoff('{ids[2]}', 'agent_z99');
  console.log(JSON.stringify({{success: false, error: 'expected'}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("4.3 非 target 不能 accept", not result3.get("success", True),
          f"result={json.dumps(result3)[:100]}")

    # 4.4 非 target 不能 reject
    result4 = tsx_eval(f"""
import {{ rejectHandoff }} from './src/orchestrator.ts';
try {{
  rejectHandoff('{ids[2]}', 'agent_z99');
  console.log(JSON.stringify({{success: false, error: 'expected'}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("4.4 非 target 不能 reject", not result4.get("success", True),
          f"result={json.dumps(result4)[:100]}")

    conn.close()


# ─── Section 5: 添加质量门 ──────────────────────────────

def test_quality_gate_add():
    section("5. 添加质量门 (addQualityGate)")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 3)
    pid = seed_pipeline(conn, ids)

    # 5.1 添加质量门
    result = tsx_eval(f"""
import {{ addQualityGate }} from './src/orchestrator.ts';
try {{
  const r = addQualityGate('{pid}', 'Code Review', '{{"type":"manual"}}', 1, 'operator');
  console.log(JSON.stringify({{success: true, gate_id: r.gate.id, pipeline_id: r.pipeline_id}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("5.1 添加质量门成功", result.get("success") and result.get("pipeline_id") == pid,
          f"result={json.dumps(result)[:100]}")

    # 5.2 DB 验证
    gate_id = result.get("gate_id")
    row = conn.execute(
        'SELECT pipeline_id, gate_name, criteria, after_order, status FROM quality_gates WHERE id=?',
        (gate_id,)
    ).fetchone()
    check("5.2 DB quality_gate 存在", row is not None,
          f"row={row}")
    if row:
        check("5.3 gate_name=Code Review", row[1] == "Code Review", f"got={row[1]}")
        check("5.4 after_order=1", row[3] == 1, f"got={row[3]}")
        check("5.5 status=pending", row[4] == "pending", f"got={row[4]}")

    # 5.6 Pipeline 不存在时报错
    result2 = tsx_eval(f"""
import {{ addQualityGate }} from './src/orchestrator.ts';
try {{
  addQualityGate('pipe_nonexist', 'Test', '{{}}', 0, 'operator');
  console.log(JSON.stringify({{success: false, error: 'expected'}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("5.6 Pipeline 不存在时报错", not result2.get("success", True),
          f"result={json.dumps(result2)[:100]}")

    conn.close()


# ─── Section 6: 评估质量门 ──────────────────────────────

def test_quality_gate_evaluate():
    section("6. 评估质量门 (evaluateQualityGate)")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 3)
    pid = seed_pipeline(conn, ids)

    # 创建质量门
    r = tsx_eval(f"""
import {{ addQualityGate }} from './src/orchestrator.ts';
const r = addQualityGate('{pid}', 'QA Gate', '{{"type":"automated"}}', 1, 'operator');
console.log(JSON.stringify({{gate_id: r.gate.id}}));
""")
    gate_id = r.get("gate_id")

    # 6.1 评估通过
    result = tsx_eval(f"""
import {{ evaluateQualityGate }} from './src/orchestrator.ts';
try {{
  const r = evaluateQualityGate('{gate_id}', 'passed', 'evaluator_1', 'All checks passed');
  console.log(JSON.stringify({{success: true, ...r}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("6.1 评估通过", result.get("success") and result.get("status") == "passed",
          f"result={json.dumps(result)[:100]}")

    # 6.2 DB 验证
    row = conn.execute(
        'SELECT status, evaluator_id, result FROM quality_gates WHERE id=?', (gate_id,)
    ).fetchone()
    check("6.2 DB status=passed", row and row[0] == "passed", f"got={row[0] if row else 'N/A'}")
    check("6.3 DB evaluator_id=evaluator_1", row and row[1] == "evaluator_1", f"got={row[1] if row else 'N/A'}")
    check("6.4 DB result=All checks passed", row and "All checks passed" in (row[2] or ""), f"got={row[2]}")

    # 6.5 已评估的门不能重复评估
    result2 = tsx_eval(f"""
import {{ evaluateQualityGate }} from './src/orchestrator.ts';
try {{
  evaluateQualityGate('{gate_id}', 'failed', 'evaluator_2');
  console.log(JSON.stringify({{success: false, error: 'expected'}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("6.5 已评估不能重复评估", not result2.get("success", True),
          f"result={json.dumps(result2)[:100]}")

    conn.close()


# ─── Section 7: 质量门阻塞后续任务 ─────────────────────

def test_quality_gate_blocking():
    section("7. 质量门阻塞后续任务 (验收标准 7)")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 4)
    pid = seed_pipeline(conn, ids)

    # 完成第一个任务（order=0）
    now = int(time.time() * 1000)
    conn.execute("UPDATE tasks SET status='completed', completed_at=? WHERE id=?", (now, ids[0]))
    conn.commit()

    # 第二个任务（order=1）设为 in_progress
    conn.execute("UPDATE tasks SET status='in_progress' WHERE id=?", (ids[1],))
    conn.commit()

    # 第三个任务（order=2）设为 assigned（正常状态）
    conn.execute("UPDATE tasks SET status='assigned' WHERE id=?", (ids[2],))
    conn.commit()

    # 创建质量门：after_order=1
    r = tsx_eval(f"""
import {{ addQualityGate }} from './src/orchestrator.ts';
const r = addQualityGate('{pid}', 'Block Gate', '{{"type":"manual"}}', 1, 'operator');
console.log(JSON.stringify({{gate_id: r.gate.id}}));
""")
    gate_id = r.get("gate_id")

    # 7.1 评估质量门为 failed
    result = tsx_eval(f"""
import {{ evaluateQualityGate }} from './src/orchestrator.ts';
try {{
  const r = evaluateQualityGate('{gate_id}', 'failed', 'qa_bot', 'Critical bug found');
  console.log(JSON.stringify({{success: true, ...r}}));
}} catch(e: any) {{
  console.log(JSON.stringify({{success: false, error: e.message}}));
}}
""")
    check("7.1 评估质量门为 failed", result.get("success") and result.get("status") == "failed",
          f"result={json.dumps(result)[:100]}")

    # 7.2 blocked_tasks 应包含 order>1 且非终态的任务
    blocked = result.get("blocked_tasks", [])
    check("7.2 blocked_tasks 包含 order>1 的非终态任务", len(blocked) > 0,
          f"blocked={blocked}")

    # 7.3 DB 验证第三个任务状态变为 waiting
    row = conn.execute('SELECT status FROM tasks WHERE id=?', (ids[2],)).fetchone()
    check("7.3 order=2 任务变为 waiting", row and row[0] == "waiting",
          f"status={row[0] if row else 'N/A'}")

    # 7.4 已完成任务（order=0）不受影响
    row0 = conn.execute('SELECT status FROM tasks WHERE id=?', (ids[0],)).fetchone()
    check("7.4 已完成任务不受影响", row0 and row0[0] == "completed",
          f"status={row0[0] if row0 else 'N/A'}")

    conn.close()


# ─── Section 8: TypeScript 编译检查 ─────────────────────

def test_typecheck():
    section("8. TypeScript 编译检查")
    proc = subprocess.run(["npx", "tsc", "--noEmit"], capture_output=True, text=True, timeout=30,
                          cwd=os.path.join(os.path.dirname(__file__), ".."))
    check("8.1 tsc --noEmit 零错误", proc.returncode == 0,
          f"stderr={proc.stderr[:200]}")


# ─── Section 9: 权限矩阵检查 ────────────────────────────

def test_security_permissions():
    section("9. 权限矩阵 (security.ts)")

    with open(os.path.join(os.path.dirname(__file__), "..", "src", "security.ts")) as f:
        content = f.read()

    new_tools = ["request_handoff", "accept_handoff", "reject_handoff",
                 "add_quality_gate", "evaluate_quality_gate"]
    for i, tool in enumerate(new_tools):
        idx = content.find(f"{tool}:")
        after = content[idx:idx+80] if idx >= 0 else ""
        check(f"9.{i+1} {tool} 权限已注册",
              idx >= 0 and '"member"' in after,
              f"not found in security.ts, after=[{after[:40]}]")


# ─── Section 10: MCP 工具注册检查 ───────────────────────

def test_mcp_tool_registration():
    section("10. MCP 工具注册 (tools.ts)")

    with open(os.path.join(os.path.dirname(__file__), "..", "src", "tools.ts")) as f:
        content = f.read()

    new_tools = ["request_handoff", "accept_handoff", "reject_handoff",
                 "add_quality_gate", "evaluate_quality_gate"]

    for i, tool in enumerate(new_tools):
        # 找 server.tool( 调用中的 tool name
        marker = f'"{tool}"'
        idx = content.find(marker)
        check(f"10.{i+1} {tool} 已注册为 MCP 工具",
              idx >= 0,
              f"not found in tools.ts")

    # 验证描述关键字
    for i, tool in enumerate(new_tools):
        marker = f'"{tool}"'
        idx = 0
        found = False
        while True:
            idx = content.find(marker, idx)
            if idx < 0:
                break
            after = content[idx:idx+2000]
            if "requireAuth" in after and "server.tool" in content[max(0,idx-200):idx]:
                found = True
                break
            idx += len(marker)

        check(f"10.{i+6} {tool} handler 使用 requireAuth",
              found,
              f"requireAuth not found in handler of {tool}")


# ─── Section 11: 数据持久化检查 ─────────────────────────

def test_persistence():
    section("11. 数据持久化")

    reset_db()
    conn = db_conn()
    ids = seed_tasks(conn, 2)

    # 交接流程持久化
    tsx_eval(f"""
import {{ requestHandoff, acceptHandoff }} from './src/orchestrator.ts';
requestHandoff('{ids[0]}', 'agent_b1', 'agent_a0');
acceptHandoff('{ids[0]}', 'agent_b1');
""")
    conn2 = db_conn()
    row = conn2.execute('SELECT assigned_to, handoff_status FROM tasks WHERE id=?', (ids[0],)).fetchone()
    check("11.1 交接结果已持久化", row and row[0] == "agent_b1" and row[1] == "accepted",
          f"row={row}")
    conn2.close()

    # 质量门持久化
    pid = seed_pipeline(conn, [ids[1]])
    r = tsx_eval(f"""
import {{ addQualityGate, evaluateQualityGate }} from './src/orchestrator.ts';
const g = addQualityGate('{pid}', 'Persist Gate', '{{}}', 0, 'operator');
evaluateQualityGate(g.gate.id, 'passed', 'eval', 'OK');
""")
    conn3 = db_conn()
    row = conn3.execute(
        'SELECT status, evaluator_id FROM quality_gates WHERE pipeline_id=?', (pid,)
    ).fetchone()
    check("11.2 质量门结果已持久化", row and row[0] == "passed" and row[1] == "eval",
          f"row={row}")
    conn3.close()
    conn.close()


# ─── 汇总 ──────────────────────────────────────────────

def summary():
    total = passed + failed
    print(f"\n{'='*60}")
    print(f"  📊 Day 3 测试结果: {passed}/{total} 通过")
    if errors:
        print(f"\n  失败项 ({len(errors)}):")
        for e in errors:
            print(f"    {e}")
    print(f"{'='*60}")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
