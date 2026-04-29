#!/usr/bin/env python3
"""
Phase 5a Day 1 测试 — RBAC 细化 + Audit 防篡改
测试内容：
  Section 1: Schema 验证（managed_group_id + audit_log 哈希链列 + 触发器）
  Section 2: set_agent_role 功能（任命/撤销/权限检查）
  Section 3: group_admin 权限隔离
  Section 4: 哈希链（INSERT 后 prev_hash/record_hash / UPDATE ABORT / DELETE ABORT）
  Section 5: 链完整性（verifyAuditChain 验证）
  Section 6: 回归（tsc + MCP 工具数）
"""

import sqlite3
import subprocess
import sys
import os
import time
import hashlib
import json

DB_PATH = "/Users/liubo/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db"
HUB_DIR = "/Users/liubo/WorkBuddy/20260416213415/agent-comm-hub"

passed = 0
failed = 0
results = {}
current_section = []


def check(condition, description):
    global passed, failed
    if condition:
        passed += 1
        current_section.append(f"  ✅ {description}")
    else:
        failed += 1
        current_section.append(f"  ❌ {description}")


def run_section(name, func):
    global current_section, results
    current_section = []
    func()
    results[name] = list(current_section)
    section_passed = sum(1 for r in results[name] if "✅" in r)
    section_total = len(results[name])
    results[name].append(f"  📊 {section_passed}/{section_total}")
    print(f"\n{'='*60}")
    print(f"  {name}")
    print(f"{'='*60}")
    for r in results[name]:
        print(r)


def seed_admin():
    """确保测试用的 admin 和 member 存在"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    now = int(time.time() * 1000)
    test_agents = [
        ("test_admin", "Test Admin", "admin", 100),
        ("test_member", "Test Member", "member", 50),
        ("test_agent_ga", "Test GroupAdmin", "member", 50),
        ("test_agent_other", "Test Other", "member", 50),
    ]
    for aid, name, role, trust in test_agents:
        c.execute("SELECT agent_id FROM agents WHERE agent_id = ?", (aid,))
        if not c.fetchone():
            c.execute("INSERT OR IGNORE INTO agents (agent_id, name, role, status, trust_score, created_at) VALUES (?, ?, ?, 'offline', ?, ?)",
                      (aid, name, role, trust, now))
            c.execute("INSERT OR IGNORE INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used, created_at) VALUES (?, 'api_token', ?, ?, ?, 1, ?)",
                  (f"token_{aid}_phase5a", f"hash_{aid}_phase5a", aid, role, now))
    conn.commit()
    conn.close()


def cleanup():
    """清理测试数据"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    for aid in ["test_admin", "test_member", "test_agent_ga", "test_agent_other"]:
        c.execute("DELETE FROM auth_tokens WHERE agent_id = ?", (aid,))
        c.execute("DELETE FROM agents WHERE agent_id = ?", (aid,))
    c.execute("DELETE FROM tasks WHERE description LIKE 'phase5a_test%'")
    # 注意：audit_log 受写保护触发器保护，不可删除
    # phase5a_test_* 审计记录会保留（影响可忽略）
    conn.commit()
    conn.close()


def run_tsx(script_content):
    """通过 tsx 运行 TypeScript 代码片段，返回 (proc, filtered_stdout)"""
    tmp_file = os.path.join(HUB_DIR, "_tmp_test.ts")
    with open(tmp_file, "w") as f:
        f.write(script_content)
    proc = subprocess.run(
        ["npx", "tsx", "_tmp_test.ts"],
        cwd=HUB_DIR,
        capture_output=True, text=True, timeout=30
    )
    try:
        os.unlink(tmp_file)
    except:
        pass
    # 过滤 npm warn 和 [DB] 行，只保留实际输出
    lines = [l for l in proc.stdout.strip().split("\n")
             if l.strip() and not l.startswith("npm warn") and not l.startswith("[DB]")]
    filtered_stdout = "\n".join(lines) if lines else ""
    return proc, filtered_stdout


def audit_log_via_tsx(action, agent_id, target="", details=""):
    """通过 tsx 调用 auditLog 写入审计记录"""
    script = f"""
import {{ auditLog }} from "./src/security.js";
auditLog("{action}", "{agent_id}", "{target}", "{details}");
console.log("OK");
"""
    proc, filtered = run_tsx(script)
    return proc.returncode == 0 and "OK" in filtered


# ═══════════════════════════════════════════════════════
# Section 1: Schema 验证
# ═══════════════════════════════════════════════════════

def test_schema():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 1.1 agents.managed_group_id 列存在
    c.execute("PRAGMA table_info(agents)")
    cols = [row[1] for row in c.fetchall()]
    check("managed_group_id" in cols, "agents.managed_group_id 列存在")

    # 1.2 audit_log.prev_hash 列存在
    c.execute("PRAGMA table_info(audit_log)")
    audit_cols = [row[1] for row in c.fetchall()]
    check("prev_hash" in audit_cols, "audit_log.prev_hash 列存在")

    # 1.3 audit_log.record_hash 列存在
    check("record_hash" in audit_cols, "audit_log.record_hash 列存在")

    # 1.4 audit_log 写保护触发器存在
    c.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name='audit_log_no_modify'")
    check(c.fetchone() is not None, "audit_log_no_modify 触发器存在")

    # 1.5 audit_log_no_delete 触发器存在
    c.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name='audit_log_no_delete'")
    check(c.fetchone() is not None, "audit_log_no_delete 触发器存在")

    # 1.6 audit_log 总列数 = 9
    check(len(audit_cols) == 9, f"audit_log 列数 = {len(audit_cols)} (预期 9)")

    conn.close()


# ═══════════════════════════════════════════════════════
# Section 2: set_agent_role 功能
# ═══════════════════════════════════════════════════════

def test_set_agent_role():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 2.1 任命 test_agent_ga 为 group_admin
    script = """
import { setAgentRole } from "./src/identity.js";
const r1 = setAgentRole("test_agent_ga", "group_admin", "test_admin", "test_group_1");
console.log(JSON.stringify(r1));
"""
    proc, filtered = run_tsx(script)
    try:
        result = json.loads(filtered.split("\n")[-1]) if filtered.strip() else {}
        check(result.get("ok") == True, f"任命 group_admin: ok={result.get('ok')}")
        check(result.get("new_role") == "group_admin", f"新角色 = group_admin")
        check(result.get("managed_group_id") == "test_group_1", f"managed_group_id = test_group_1")
    except:
        check(False, f"任命 group_admin 失败: stdout={filtered[:100]}, stderr={proc.stderr[:100]}")

    # 2.2 验证 DB 中角色已更新
    c.execute("SELECT role, managed_group_id FROM agents WHERE agent_id = 'test_agent_ga'")
    row = c.fetchone()
    check(row[0] == "group_admin", f"DB role = group_admin (实际 {row[0]})")
    check(row[1] == "test_group_1", f"DB managed_group_id = test_group_1 (实际 {row[1]})")

    # 2.3 验证 auth_tokens 角色也同步更新
    c.execute("SELECT role FROM auth_tokens WHERE agent_id = 'test_agent_ga' AND token_type = 'api_token' AND revoked_at IS NULL")
    row = c.fetchone()
    check(row is not None and row[0] == "group_admin", f"auth_tokens role 同步为 group_admin (实际 {row[0] if row else 'None'})")

    # 2.4 不能修改自己的角色
    script = """
import { setAgentRole } from "./src/identity.js";
const r = setAgentRole("test_admin", "member", "test_admin");
console.log(JSON.stringify(r));
"""
    proc, filtered = run_tsx(script)
    try:
        result = json.loads(filtered.split("\n")[-1])
        check(result.get("ok") == False, f"不能修改自己: ok=False (实际 {result.get('ok')})")
    except:
        check(False, "自修改检查失败")

    # 2.5 非 admin 不能被设为 admin
    script = """
import { setAgentRole } from "./src/identity.js";
const r = setAgentRole("test_member", "admin", "test_admin");
console.log(JSON.stringify(r));
"""
    proc, filtered = run_tsx(script)
    try:
        result = json.loads(filtered.split("\n")[-1])
        check(result.get("ok") == False, f"非 admin 不能被设为 admin (实际 {result.get('ok')})")
    except:
        check(False, "admin 提权检查失败")

    # 2.6 撤销 group_admin（降为 member）
    script = """
import { setAgentRole } from "./src/identity.js";
const r = setAgentRole("test_agent_ga", "member", "test_admin");
console.log(JSON.stringify(r));
"""
    proc, filtered = run_tsx(script)
    try:
        result = json.loads(filtered.split("\n")[-1])
        check(result.get("ok") == True, f"撤销 group_admin: ok=True")
        check(result.get("new_role") == "member", f"新角色 = member")
    except:
        check(False, "撤销 group_admin 失败")

    c.execute("SELECT managed_group_id FROM agents WHERE agent_id = 'test_agent_ga'")
    row = c.fetchone()
    check(row[0] is None, f"managed_group_id 清空 (实际 {row[0]})")

    # 2.7 目标不存在
    script = """
import { setAgentRole } from "./src/identity.js";
const r = setAgentRole("nonexistent_p5a", "member", "test_admin");
console.log(JSON.stringify(r));
"""
    proc, filtered = run_tsx(script)
    try:
        result = json.loads(filtered.split("\n")[-1])
        check(result.get("ok") == False, f"不存在的 Agent: ok=False")
    except:
        check(False, "不存在的 Agent 检查失败")

    # 2.8 审计日志有 role_changed 记录
    c.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'role_changed' AND target = 'test_agent_ga'")
    count = c.fetchone()[0]
    check(count >= 2, f"role_changed 审计记录数 >= 2 (实际 {count})")

    conn.close()


# ═══════════════════════════════════════════════════════
# Section 3: group_admin 权限隔离（通过 tsx 调用 checkPermission）
# ═══════════════════════════════════════════════════════

def test_group_admin_permissions():
    script = """
import { checkPermission } from "./src/security.js";
const tools = {
  member_ok: ["send_message", "store_memory", "recall_memory", "heartbeat",
              "create_task", "assign_task", "propose_strategy", "add_dependency"],
  admin_only: ["revoke_token", "set_trust_score", "set_agent_role", "approve_strategy", "veto_strategy"],
};
const results: Record<string, boolean> = {};
for (const t of tools.member_ok) results["ga_" + t] = checkPermission(t, "group_admin");
for (const t of tools.admin_only) results["ga_no_" + t] = !checkPermission(t, "group_admin");
for (const t of tools.admin_only) results["admin_" + t] = checkPermission(t, "admin");
results["member_send"] = checkPermission("send_message", "member");
results["member_no_admin"] = !checkPermission("set_agent_role", "member");
results["public_member"] = checkPermission("register_agent", "member");
results["public_ga"] = checkPermission("register_agent", "group_admin");
results["public_admin"] = checkPermission("register_agent", "admin");
results["tool_count"] = true; // will check separately
console.log(JSON.stringify(results));
"""
    proc, filtered = run_tsx(script)
    try:
        r = json.loads(filtered.split("\n")[-1])
        # 3.1 group_admin 可以使用 member 级工具
        for t in ["send_message", "store_memory", "recall_memory", "heartbeat",
                   "create_task", "assign_task", "propose_strategy", "add_dependency"]:
            check(r.get(f"ga_{t}") == True, f"group_admin 可用 {t}")
        # 3.2 group_admin 不能使用 admin 级工具
        for t in ["revoke_token", "set_trust_score", "set_agent_role", "approve_strategy", "veto_strategy"]:
            check(r.get(f"ga_no_{t}") == True, f"group_admin 不可用 {t}")
        # 3.3 admin 权限不受影响
        for t in ["revoke_token", "set_trust_score", "set_agent_role", "approve_strategy", "veto_strategy"]:
            check(r.get(f"admin_{t}") == True, f"admin 可用 {t}")
        # 3.4 member 权限不受影响
        check(r.get("member_send") == True, "member 可用 send_message")
        check(r.get("member_no_admin") == True, "member 不可用 set_agent_role")
        # 3.5 public 工具所有角色都可用
        check(r.get("public_member") == True, "member 可用 register_agent")
        check(r.get("public_ga") == True, "group_admin 可用 register_agent")
        check(r.get("public_admin") == True, "admin 可用 register_agent")
    except Exception as e:
        check(False, f"权限测试失败: {e}")


# ═══════════════════════════════════════════════════════
# Section 4: 哈希链基本功能
# ═══════════════════════════════════════════════════════

def test_hash_chain():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 4.1 写入 3 条审计日志（通过 tsx 调用 auditLog）
    ok1 = audit_log_via_tsx("phase5a_test_action1", "test_admin", "target1", "detail1")
    check(ok1, "auditLog(action1) 成功")
    ok2 = audit_log_via_tsx("phase5a_test_action2", "test_member", "target2", "detail2")
    check(ok2, "auditLog(action2) 成功")
    ok3 = audit_log_via_tsx("phase5a_test_action3", "test_agent_ga", "target3", "detail3")
    check(ok3, "auditLog(action3) 成功")

    # 4.2 验证有 prev_hash 和 record_hash
    c.execute("SELECT id, prev_hash, record_hash FROM audit_log WHERE action LIKE 'phase5a_test%' ORDER BY created_at ASC")
    rows = c.fetchall()
    check(len(rows) >= 3, f"写入 >= 3 条审计记录 (实际 {len(rows)})")

    if len(rows) >= 3:
        # 4.3 第一条（phase5a 记录）的 prev_hash 应该是链中上一条的 record_hash
        check(rows[0][2] is not None and len(rows[0][2]) == 64, f"第一条 record_hash 为 64 字符 SHA256")

        # 4.4 第二条 prev_hash = 第一条的 record_hash
        check(rows[1][1] == rows[0][2], f"第二条 prev_hash = 第一条 record_hash")

        # 4.5 第三条 prev_hash = 第二条的 record_hash
        check(rows[2][1] == rows[1][2], f"第三条 prev_hash = 第二条 record_hash")

        # 4.6 手动验证 hash 计算
        r0 = c.execute("SELECT action, agent_id, target, details, created_at FROM audit_log WHERE id=?", (rows[0][0],)).fetchone()
        hash_input = f"GENESIS|{r0[0]}|{r0[1]}|{r0[2]}|{r0[3]}|{r0[4]}"
        computed = hashlib.sha256(hash_input.encode()).hexdigest()
        check(computed == rows[0][2], f"手动计算 hash 与 record_hash 一致")

    # 4.7 UPDATE 触发器生效
    try:
        c.execute("UPDATE audit_log SET details = 'tampered' WHERE action = 'phase5a_test_action1'")
        conn.commit()
        check(False, "UPDATE 应该被触发器 ABORT")
    except sqlite3.IntegrityError as e:
        check("immutable" in str(e).lower() or "abort" in str(e).lower(), f"UPDATE 被 ABORT")
        conn.rollback()

    # 4.8 DELETE 触发器生效
    try:
        c.execute("DELETE FROM audit_log WHERE action = 'phase5a_test_action1'")
        conn.commit()
        check(False, "DELETE 应该被触发器 ABORT")
    except sqlite3.IntegrityError as e:
        check("immutable" in str(e).lower() or "abort" in str(e).lower(), f"DELETE 被 ABORT")
        conn.rollback()

    conn.close()


# ═══════════════════════════════════════════════════════
# Section 5: 链完整性验证
# ═══════════════════════════════════════════════════════

def test_chain_integrity():
    script = """
import { verifyAuditChain } from "./src/security.js";
const result = verifyAuditChain();
console.log(JSON.stringify(result));
"""
    proc, filtered = run_tsx(script)
    try:
        result = json.loads(filtered.split("\n")[-1])
        check(result.get("valid") == True, f"哈希链完整: valid=True (break={result.get('firstBreak')})")
        check(result.get("total", 0) > 0, f"总记录数 > 0 (实际 {result.get('total')})")
        # checked 可能 < total（旧数据跳过 hash 验证）
        check(result.get("checked", 0) > 0, f"验证了 {result.get('checked')} 条记录")
        check(result.get("firstBreak") is None, "无断裂点")
    except Exception as e:
        check(False, f"链完整性验证失败: {e}, filtered={filtered[:100]}")


# ═══════════════════════════════════════════════════════
# Section 6: 回归测试
# ═══════════════════════════════════════════════════════

def test_regression():
    # 6.1-6.3: 通过 tsx 测试权限
    script = """
import { checkPermission, TOOL_PERMISSIONS } from "./src/security.js";
const tests: Record<string, boolean> = {};
// Phase 1
tests["p1_register"] = checkPermission("register_agent", "member");
tests["p1_heartbeat"] = checkPermission("heartbeat", "member");
tests["p1_revoke"] = !checkPermission("revoke_token", "member");
// Phase 3
tests["p3_share"] = checkPermission("share_experience", "member");
tests["p3_approve"] = !checkPermission("approve_strategy", "member");
// Phase 4b
tests["p4b_dep"] = checkPermission("add_dependency", "member");
tests["p4b_handoff"] = checkPermission("request_handoff", "member");
tests["p4b_veto"] = !checkPermission("veto_strategy", "member");
tests["tool_count"] = Object.keys(TOOL_PERMISSIONS).length === 39;
console.log(JSON.stringify(tests));
"""
    proc, filtered = run_tsx(script)
    try:
        r = json.loads(filtered.split("\n")[-1])
        check(r.get("p1_register") == True, "register_agent 仍为 public")
        check(r.get("p1_heartbeat") == True, "heartbeat 仍为 member")
        check(r.get("p1_revoke") == True, "revoke_token 仍为 admin-only")
        check(r.get("p3_share") == True, "share_experience 仍为 member")
        check(r.get("p3_approve") == True, "approve_strategy 仍为 admin-only")
        check(r.get("p4b_dep") == True, "add_dependency 仍为 member")
        check(r.get("p4b_handoff") == True, "request_handoff 仍为 member")
        check(r.get("p4b_veto") == True, "veto_strategy 仍为 admin-only")
        check(r.get("tool_count") == True, f"MCP 工具总数 = 39")
    except Exception as e:
        check(False, f"回归测试失败: {e}")

    # 6.5 tsc --noEmit 零错误
    proc = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        cwd=HUB_DIR,
        capture_output=True, text=True, timeout=60
    )
    has_errors = "error TS" in proc.stdout
    check(not has_errors, f"tsc --noEmit 零错误")


# ═══════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 60)
    print("  Phase 5a Day 1 测试 — RBAC 细化 + Audit 防篡改")
    print("=" * 60)

    os.chdir(HUB_DIR)
    seed_admin()

    try:
        run_section("Section 1: Schema 验证", test_schema)
        run_section("Section 2: set_agent_role 功能", test_set_agent_role)
        run_section("Section 3: group_admin 权限隔离", test_group_admin_permissions)
        run_section("Section 4: 哈希链基本功能", test_hash_chain)
        run_section("Section 5: 链完整性验证", test_chain_integrity)
        run_section("Section 6: 回归测试", test_regression)
    finally:
        cleanup()

    print(f"\n{'='*60}")
    print(f"  总计: {passed} 通过 / {failed} 失败 / {passed + failed} 总计")
    print(f"{'='*60}")

    sys.exit(1 if failed > 0 else 0)
