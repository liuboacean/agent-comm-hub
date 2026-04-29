#!/usr/bin/env python3
"""
test-phase4b-day4.py — Phase 4b Day 4 全功能测试

覆盖：
1. judgeTier 分级判定（4 级 tier）
2. autoApprove 自动通过 + 观察窗口
3. startObservation 观察窗口启动
4. checkVetoWindow 否决窗口检查
5. propose_strategy_tiered 统一入口
6. vetoStrategy 策略撤回
7. tsc --noEmit
8. security.ts 权限注册
9. MCP 工具注册
10. Python SDK 方法存在性
11. 数据持久化
"""

import json
import os
import subprocess
import sqlite3
import sys
import time

# ─── 配置 ──────────────────────────────────────────────────────

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'comm_hub.db')
HUB_ROOT = os.path.join(os.path.dirname(__file__), '..')
SDK_PATH = os.path.join(HUB_ROOT, 'client-sdk', 'hub_client.py')

passed = 0
failed = 0
section_passed = 0
section_failed = 0


def check(name, condition, detail=""):
    global passed, failed, section_passed, section_failed
    if condition:
        passed += 1
        section_passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        section_failed += 1
        print(f"  ❌ {name} — {detail}")


def section(title):
    global section_passed, section_failed
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")
    section_passed = 0
    section_failed = 0


def section_summary():
    global section_passed, section_failed
    status = "PASS" if section_failed == 0 else "FAIL"
    print(f"\n  [{status}] {section_passed} passed, {section_failed} failed")
    return section_failed == 0


def run_tsx(script_content):
    """通过 tsx 运行 TypeScript 代码片段"""
    tmpfile = os.path.join(HUB_ROOT, 'tests', '_tmp_day4.ts')
    with open(tmpfile, 'w') as f:
        f.write(script_content)
    try:
        result = subprocess.run(
            ['npx', 'tsx', tmpfile],
            capture_output=True, text=True, timeout=30, cwd=HUB_ROOT
        )
        stdout = result.stdout.strip()
        if result.returncode != 0:
            print(f"    ⚠️ tsx stderr: {result.stderr[:200]}")
        return stdout
    except subprocess.TimeoutExpired:
        return ""
    finally:
        if os.path.exists(tmpfile):
            os.unlink(tmpfile)


def get_db():
    """获取数据库连接"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def seed_agent(conn, agent_id, trust_score=50):
    """确保 agent 存在且 trust_score 正确"""
    now = int(time.time() * 1000)
    conn.execute('DELETE FROM agents WHERE agent_id = ?', (agent_id,))
    conn.execute(
        'INSERT INTO agents (agent_id, name, role, trust_score, status, created_at) '
        'VALUES (?, ?, "member", ?, "online", ?)',
        (agent_id, agent_id, trust_score, now)
    )
    conn.commit()


def seed_strategy_history(conn, proposer_id, count):
    """为提议者创建已审批的策略历史"""
    now = int(time.time() * 1000)
    # 清理旧的历史
    conn.execute('DELETE FROM strategies WHERE proposer_id = ? AND title LIKE ?', (proposer_id, f'History-%'))
    for i in range(count):
        conn.execute(
            'INSERT INTO strategies '
            '(title, content, category, sensitivity, proposer_id, status, proposed_at, source_trust, apply_count, feedback_count, positive_count) '
            'VALUES (?, ?, ?, ?, ?, "approved", ?, 50, 0, 0, 0)',
            (f"History-{proposer_id}-{i}", f"History content {i}", "workflow", "normal",
             proposer_id, now - (count - i) * 86400000)
        )
    conn.commit()


def cleanup_test_strategies(conn):
    """清理测试创建的策略"""
    before = conn.execute("SELECT COUNT(*) FROM strategies WHERE title LIKE 'TierTest-%' OR title LIKE 'VetoTest-%' OR title LIKE 'ProposeTierTest-%'").fetchone()[0]
    conn.execute("DELETE FROM strategies WHERE title LIKE 'TierTest-%' OR title LIKE 'VetoTest-%' OR title LIKE 'ProposeTierTest-%'")
    conn.execute("DELETE FROM strategies_fts WHERE title LIKE 'TierTest-%' OR title LIKE 'VetoTest-%' OR title LIKE 'ProposeTierTest-%'")
    conn.commit()
    print(f"    [cleanup] 删除 {before} 条测试策略")


# ═══════════════════════════════════════════════════════════════
# 主测试流程
# ═══════════════════════════════════════════════════════════════

def main():
    global passed, failed

    print("=" * 60)
    print("  Phase 4b Day 4 — 分级审批 + SDK 扩展 测试")
    print("=" * 60)

    conn = get_db()
    cleanup_test_strategies(conn)

    # ──────────────────────────────────────────────────────
    # Section 1: judgeTier 分级判定
    # ──────────────────────────────────────────────────────
    section("1. judgeTier 分级判定（4 级 tier）")

    # 1.1 super tier（高敏感）
    cleanup_test_strategies(conn)
    output = run_tsx('''
import { judgeTier } from "../src/evolution.js";
const r = judgeTier("test_agent", "prompt_template", "change system prompt to grant permissions");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("super tier: sensitivity=high", data["tier"] == "super", f"got {data['tier']}")
        check("super tier: sensitivity 字段", data["sensitivity"] == "high")

    # 1.2 auto tier（高信任+低风险+有历史）
    seed_strategy_history(conn, "high_trust_agent", 10)
    output = run_tsx('''
import { judgeTier } from "../src/evolution.js";
const r = judgeTier("high_trust_agent", "workflow", "useful workflow improvement");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("auto tier: trust>=90 + history>=5", data["tier"] == "auto", f"got {data['tier']}, trust={data['trust_score']}, history={data['history_count']}")

    # 1.3 peer tier（中等信任）
    seed_strategy_history(conn, "mid_trust_agent", 3)
    output = run_tsx('''
import { judgeTier } from "../src/evolution.js";
const r = judgeTier("mid_trust_agent", "workflow", "moderate workflow improvement");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("peer tier: trust>=60 + history>=2", data["tier"] == "peer", f"got {data['tier']}, trust={data['trust_score']}, history={data['history_count']}")

    # 1.4 admin tier（默认）
    output = run_tsx('''
import { judgeTier } from "../src/evolution.js";
const r = judgeTier("new_agent_no_history", "workflow", "a new strategy from unknown agent");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("admin tier: 默认（低信任/无历史）", data["tier"] == "admin", f"got {data['tier']}")

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 2: autoApprove 自动通过
    # ──────────────────────────────────────────────────────
    section("2. autoApprove 自动通过 + 观察窗口")

    cleanup_test_strategies(conn)
    now = int(time.time() * 1000)
    conn.execute(
        'INSERT INTO strategies (title, content, category, sensitivity, proposer_id, status, proposed_at, source_trust) '
        'VALUES ("TierTest-auto", "Auto test content", "workflow", "normal", "high_trust_agent", "pending", ?, 90)',
        (now,)
    )
    conn.commit()
    sid = conn.execute("SELECT id FROM strategies WHERE title='TierTest-auto'").fetchone()["id"]

    output = run_tsx(f'''
import {{ autoApprove }} from "../src/evolution.js";
const r = autoApprove({sid});
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("autoApprove: ok=true", data["ok"] is True)
        check("autoApprove: status=approved", data["strategy"]["status"] == "approved")
        check("autoApprove: tier=auto", data["strategy"]["approval_tier"] == "auto")
        check("autoApprove: observation_start 非空", data["strategy"]["observation_start"] is not None)
        check("autoApprove: veto_deadline 非空", data["strategy"]["veto_deadline"] is not None)
        # veto_deadline 应该在 ~48h 后
        veto_dl = data["strategy"]["veto_deadline"]
        check("autoApprove: veto_deadline ≈ now+48h", abs(veto_dl - (now + 48 * 3600000)) < 5000,
              f"diff={abs(veto_dl - (now + 48 * 3600000))}")

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 3: startObservation 观察窗口
    # ──────────────────────────────────────────────────────
    section("3. startObservation 观察窗口启动")

    cleanup_test_strategies(conn)
    conn.execute(
        'INSERT INTO strategies (title, content, category, sensitivity, proposer_id, status, '
        'proposed_at, source_trust, approved_at, approved_by) '
        'VALUES ("TierTest-obs", "Observation test", "workflow", "normal", "mid_trust_agent", '
        '"approved", ?, 70, ?, "admin_user")',
        (now, now,)
    )
    conn.commit()
    sid2 = conn.execute("SELECT id FROM strategies WHERE title='TierTest-obs'").fetchone()["id"]

    output = run_tsx(f'''
import {{ startObservation }} from "../src/evolution.js";
const r = startObservation({sid2}, "admin_user");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("startObservation: ok=true", data["ok"] is True)
        check("startObservation: tier=peer", data["strategy"]["approval_tier"] == "peer")
        check("startObservation: veto_deadline 非空", data["veto_deadline"] is not None)
        check("startObservation: observation_start 非空", data["strategy"]["observation_start"] is not None)

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 4: checkVetoWindow 否决窗口
    # ──────────────────────────────────────────────────────
    section("4. checkVetoWindow 否决窗口检查")

    # 4.1 窗口内的策略
    output = run_tsx(f'''
import {{ checkVetoWindow }} from "../src/evolution.js";
const r = checkVetoWindow({sid2});
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("checkVetoWindow: in_window=true", data["in_window"] is True, f"got {data['in_window']}")
        check("checkVetoWindow: veto_deadline 非空", data["veto_deadline"] is not None)
        check("checkVetoWindow: 0 负面反馈 → can_veto=false", data["can_veto"] is False, f"ratio={data['veto_ratio']}")

    # 4.2 窗口外的策略（修改 veto_deadline 为过去）
    conn.execute(
        f"UPDATE strategies SET veto_deadline={now - 100000}, observation_start={now - 200000} WHERE id={sid2}"
    )
    conn.commit()
    output = run_tsx(f'''
import {{ checkVetoWindow }} from "../src/evolution.js";
const r = checkVetoWindow({sid2});
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("checkVetoWindow: 窗口已过 in_window=false", data["in_window"] is False)
        check("checkVetoWindow: 窗口已过 can_veto=false", data["can_veto"] is False)

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 5: propose_strategy_tiered 统一入口
    # ──────────────────────────────────────────────────────
    section("5. propose_strategy_tiered 统一入口")

    cleanup_test_strategies(conn)

    # 5.1 高信任 agent → auto tier
    output = run_tsx('''
import { proposeStrategyTiered } from "../src/evolution.js";
const r = proposeStrategyTiered(
    "ProposeTierTest-auto",
    "This is a test strategy for auto tier approval with enough content to pass validation",
    "workflow",
    "high_trust_agent"
);
console.log(JSON.stringify({
    ok: r.ok,
    error: r.ok ? undefined : (r as any).error,
    tier: r.ok ? r.tier : undefined,
    status: r.ok ? r.strategy.status : undefined,
    auto_approved: r.ok ? r.auto_approved : undefined,
    veto_deadline: r.ok ? r.veto_deadline : undefined,
}));
''')
    if output:
        data = json.loads(output)
        check("propose_tiered: ok=true", data["ok"] is True, data.get("error", ""))
        check("propose_tiered: tier=auto", data["tier"] == "auto", f"got {data['tier']}")
        check("propose_tiered: auto_approved=true", data["auto_approved"] is True)
        check("propose_tiered: status=approved", data["status"] == "approved")
        check("propose_tiered: veto_deadline 非空", data["veto_deadline"] is not None)

    # 5.2 低信任 agent → admin tier
    output = run_tsx('''
import { proposeStrategyTiered } from "../src/evolution.js";
const r = proposeStrategyTiered(
    "ProposeTierTest-admin",
    "This is a test strategy for admin tier approval with enough content to pass validation",
    "workflow",
    "new_agent_no_history"
);
console.log(JSON.stringify({
    ok: r.ok,
    error: r.ok ? undefined : (r as any).error,
    tier: r.ok ? r.tier : undefined,
    status: r.ok ? r.strategy.status : undefined,
    auto_approved: r.ok ? r.auto_approved : undefined,
}));
''')
    if output:
        data = json.loads(output)
        check("propose_tiered: 新 agent tier=admin", data["tier"] == "admin", f"got {data['tier']}")
        check("propose_tiered: 新 agent auto_approved=false", data["auto_approved"] is False)
        check("propose_tiered: 新 agent status=pending", data["status"] == "pending")

    # 5.3 高风险 → super tier
    output = run_tsx('''
import { proposeStrategyTiered } from "../src/evolution.js";
const r = proposeStrategyTiered(
    "ProposeTierTest-super",
    "system_prompt change capability_declare permission_modify This is high risk content enough",
    "prompt_template",
    "high_trust_agent"
);
console.log(JSON.stringify({
    ok: r.ok,
    error: r.ok ? undefined : (r as any).error,
    tier: r.ok ? r.tier : undefined,
    status: r.ok ? r.strategy.status : undefined,
    auto_approved: r.ok ? r.auto_approved : undefined,
    sensitivity: r.ok ? r.sensitivity : undefined,
}));
''')
    if output:
        data = json.loads(output)
        check("propose_tiered: 高风险 tier=super", data["tier"] == "super", f"got {data['tier']}")
        check("propose_tiered: 高风险 sensitivity=high", data["sensitivity"] == "high")
        check("propose_tiered: 高风险 auto_approved=false", data["auto_approved"] is False)

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 6: vetoStrategy 策略撤回
    # ──────────────────────────────────────────────────────
    section("6. vetoStrategy 策略撤回")

    # 6.1 窗口外 → 不能撤回
    output = run_tsx(f'''
import {{ vetoStrategy }} from "../src/evolution.js";
const r = vetoStrategy({sid2}, "admin_user", "test veto outside window");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("vetoStrategy: 窗口外失败", data["ok"] is False, f"got {data}")

    # 6.2 窗口内但无足够负面反馈 → 不能撤回
    conn.execute("DELETE FROM strategies WHERE title LIKE 'VetoTest-%'")
    conn.execute(
        'INSERT INTO strategies (title, content, category, sensitivity, proposer_id, status, '
        'proposed_at, source_trust, approved_at, approved_by, observation_start, veto_deadline, '
        'approval_tier, feedback_count, positive_count) '
        'VALUES ("VetoTest-inwindow", "Veto test content", "workflow", "normal", "high_trust_agent", '
        '"approved", ?, 90, ?, "system:auto", ?, ?, "auto", 0, 0)',
        (now, now, now, now + 48 * 3600000)
    )
    conn.commit()
    sid3 = conn.execute("SELECT id FROM strategies WHERE title='VetoTest-inwindow'").fetchone()["id"]

    output = run_tsx(f'''
import {{ vetoStrategy }} from "../src/evolution.js";
const r = vetoStrategy({sid3}, "admin_user", "test veto insufficient negative");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("vetoStrategy: 无负面反馈失败", data["ok"] is False, f"got {data}")

    # 6.3 窗口内 + 足够负面反馈 → 可以撤回
    conn.execute(
        f"UPDATE strategies SET feedback_count=10, positive_count=4 WHERE id={sid3}"
    )
    conn.commit()
    # 6 negative / 4 positive = 1.5 ratio > 0.5 → can_veto
    output = run_tsx(f'''
import {{ vetoStrategy }} from "../src/evolution.js";
const r = vetoStrategy({sid3}, "admin_user", "too many negative feedbacks");
console.log(JSON.stringify(r));
''')
    if output:
        data = json.loads(output)
        check("vetoStrategy: 足够负面反馈成功", data["ok"] is True, f"got {data}")
        if data["ok"]:
            check("vetoStrategy: status=rejected", data["strategy"]["status"] == "rejected")
            check("vetoStrategy: tier=vetoed", data["strategy"]["approval_tier"] == "vetoed")

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 7: tsc 编译
    # ──────────────────────────────────────────────────────
    section("7. tsc --noEmit 零错误")
    result = subprocess.run(
        ['npx', 'tsc', '--noEmit'],
        capture_output=True, text=True, timeout=60, cwd=HUB_ROOT
    )
    check("tsc --noEmit exit code 0", result.returncode == 0, f"exit={result.returncode}, stderr={result.stderr[:200]}")

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 8: security.ts 权限
    # ──────────────────────────────────────────────────────
    section("8. security.ts 权限注册")

    security_content = open(os.path.join(HUB_ROOT, 'src', 'security.ts')).read()
    check("propose_strategy_tiered 权限注册", "propose_strategy_tiered:" in security_content)
    check("check_veto_window 权限注册", "check_veto_window:" in security_content)
    check("veto_strategy 权限=admin", '"admin"' in security_content.split("veto_strategy")[1][:30] if "veto_strategy" in security_content else False)

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 9: MCP 工具注册
    # ──────────────────────────────────────────────────────
    section("9. MCP 工具注册检查")

    tools_content = open(os.path.join(HUB_ROOT, 'src', 'tools.ts')).read()
    check("propose_strategy_tiered 工具注册", '"propose_strategy_tiered"' in tools_content)
    check("check_veto_window 工具注册", '"check_veto_window"' in tools_content)
    check("veto_strategy 工具注册", '"veto_strategy"' in tools_content)
    check("propose_strategy_tiered import", "proposeStrategyTiered" in tools_content)
    check("checkVetoWindow import", "checkVetoWindow" in tools_content)
    check("vetoStrategy import", "vetoStrategy" in tools_content)

    # 计算总工具数
    tool_count = tools_content.count('server.tool(')
    check(f"MCP 工具总数 = {tool_count}（应为 ≥35）", tool_count >= 35, f"got {tool_count}")

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 10: Python SDK 方法
    # ──────────────────────────────────────────────────────
    section("10. Python SDK 方法存在性")

    sdk_content = open(SDK_PATH).read()
    check("add_dependency 方法", "def add_dependency(" in sdk_content)
    check("remove_dependency 方法", "def remove_dependency(" in sdk_content)
    check("get_task_dependencies 方法", "def get_task_dependencies(" in sdk_content)
    check("check_dependencies_satisfied 方法", "def check_dependencies_satisfied(" in sdk_content)
    check("create_parallel_group 方法", "def create_parallel_group(" in sdk_content)
    check("request_handoff 方法", "def request_handoff(" in sdk_content)
    check("accept_handoff 方法", "def accept_handoff(" in sdk_content)
    check("reject_handoff 方法", "def reject_handoff(" in sdk_content)
    check("add_quality_gate 方法", "def add_quality_gate(" in sdk_content)
    check("evaluate_quality_gate 方法", "def evaluate_quality_gate(" in sdk_content)
    check("propose_strategy_tiered 方法", "def propose_strategy_tiered(" in sdk_content)
    check("check_veto_window 方法", "def check_veto_window(" in sdk_content)
    check("veto_strategy 方法", "def veto_strategy(" in sdk_content)

    section_summary()

    # ──────────────────────────────────────────────────────
    # Section 11: 数据持久化
    # ──────────────────────────────────────────────────────
    section("11. 数据持久化验证")

    # 关闭旧连接，重新打开以读到 tsx 写入的数据
    conn.close()
    conn = get_db()

    # 验证 auto tier 策略的数据已持久化
    row = conn.execute(
        "SELECT * FROM strategies WHERE title='ProposeTierTest-auto' AND status='approved'"
    ).fetchone()
    check("auto tier 策略持久化", row is not None)
    if row:
        check("approval_tier=auto", row["approval_tier"] == "auto")
        check("veto_deadline 非空", row["veto_deadline"] is not None)

    # 验证 vetoed 策略的数据已持久化
    row = conn.execute(
        "SELECT * FROM strategies WHERE title='VetoTest-inwindow'"
    ).fetchone()
    check("vetoed 策略持久化", row is not None)
    if row:
        check("vetoed status=rejected", row["status"] == "rejected")
        check("vetoed tier=vetoed", row["approval_tier"] == "vetoed")
        check("vetoed veto_deadline=null", row["veto_deadline"] is None)

    section_summary()

    # ──────────────────────────────────────────────────────
    # 汇总
    # ──────────────────────────────────────────────────────
    cleanup_test_strategies(conn)
    conn.close()

    print(f"\n{'='*60}")
    print(f"  总计: {passed} passed, {failed} failed")
    if failed == 0:
        print(f"  ✅ Phase 4b Day 4 全部通过！")
    else:
        print(f"  ❌ 有 {failed} 个测试失败")
    print(f"{'='*60}")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
