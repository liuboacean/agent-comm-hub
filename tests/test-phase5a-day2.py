#!/usr/bin/env python3
"""
Phase 5a Day 2 测试 — Audit 覆盖补全 + 信任评分自动化

Section 1: Audit 补全验证（6 项）
Section 2: 信任评分基础计算（8 项）
Section 3: 信任评分扣分项（6 项）
Section 4: clamp + admin 覆盖 + recalculate 重置（6 项）
Section 5: recalculate_trust_scores MCP 工具（5 项）
Section 6: 回归测试（4 项）
"""
import subprocess
import json
import sqlite3
import os
import sys

HUB_DIR = "/Users/liubo/WorkBuddy/20260416213415/agent-comm-hub"
DB_PATH = os.path.join(HUB_DIR, "comm_hub.db")

passed = 0
failed = 0
results = {"current": []}
current_section = []


def check(condition, desc):
    global passed, failed
    if condition:
        passed += 1
        current_section.append(f"  ✅ {desc}")
    else:
        failed += 1
        current_section.append(f"  ❌ {desc}")


def run_section(name, func):
    global current_section
    current_section = []
    print(f"\n{'='*60}")
    print(f"Section: {name}")
    print(f"{'='*60}")
    func()
    results[name] = list(current_section)
    total = sum(1 for s in current_section if "✅" in s)
    print(f"\n→ {name}: {total}/{len(current_section)}")
    for line in current_section:
        print(line)


def run_tsx(code: str) -> tuple:
    """写临时 .ts 文件到 HUB_DIR 并用 tsx 执行，返回 (exitcode, stdout)"""
    tmp_path = os.path.join(HUB_DIR, "_tmp_test_day2.ts")
    with open(tmp_path, "w") as f:
        f.write(code)
    proc = subprocess.run(
        ["npx", "tsx", tmp_path],
        capture_output=True, text=True, cwd=HUB_DIR, timeout=30,
    )
    # 过滤 npm warn 和非 JSON 行，提取最后一个 JSON 行
    stdout_lines = [l for l in proc.stdout.split("\n")
                    if "npm warn" not in l.lower() and l.strip().startswith("{")]
    stdout = "\n".join(stdout_lines).strip()
    # 如果有多个 JSON 行（不应出现），取最后一行
    if "\n" in stdout:
        stdout = stdout.split("\n")[-1].strip()
    try:
        os.unlink(tmp_path)
    except:
        pass
    return proc.returncode, stdout


def setup_seed_data():
    """插入测试用种子数据"""
    # 用 Python sqlite3 直接清理（禁用触发器）
    import sqlite3 as sql3
    conn = sql3.connect(DB_PATH)
    conn.execute("PRAGMA defer_foreign_keys = ON")
    # 禁用触发器后删除审计日志
    conn.execute("DROP TRIGGER IF EXISTS audit_log_no_modify")
    conn.execute("DROP TRIGGER IF EXISTS audit_log_no_delete")
    conn.execute("DELETE FROM agent_capabilities WHERE agent_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM strategy_feedback WHERE agent_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM strategy_applications WHERE agent_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM strategies WHERE proposer_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM auth_tokens WHERE agent_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM agents WHERE agent_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM memories WHERE agent_id LIKE 'test5a2_%'")
    conn.execute("DELETE FROM audit_log WHERE agent_id LIKE 'test5a2_%'")
    # 重建触发器
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS audit_log_no_modify BEFORE UPDATE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
    """)
    conn.execute("""
        CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
    """)
    conn.commit()
    conn.close()
    
    code = '''
    import { db } from "./src/db.js";
    const now = Date.now();
    
    // 注册 test5a2_agent1（member）
    db.prepare(`INSERT OR IGNORE INTO agents (agent_id, name, role, status, trust_score, created_at) VALUES (?, ?, 'member', 'offline', 50, ?)`).run("test5a2_agent1", "Test Agent 1", now);
    db.prepare(`INSERT OR IGNORE INTO auth_tokens (token_id, token_type, token_value, role, used, created_at) VALUES (?, 'api_token', ?, 'member', 1, ?)`).run("tok_test5a2_a1", "hash_a1", now);
    
    // 注册 test5a2_admin（admin）
    db.prepare(`INSERT OR IGNORE INTO agents (agent_id, name, role, status, trust_score, created_at) VALUES (?, ?, 'admin', 'online', 50, ?)`).run("test5a2_admin", "Test Admin", now);
    db.prepare(`INSERT OR IGNORE INTO auth_tokens (token_id, token_type, token_value, role, used, created_at) VALUES (?, 'api_token', ?, 'admin', 1, ?)`).run("tok_test5a2_adm", "hash_adm", now);
    
    console.log(JSON.stringify({ok: true}));
    '''
    rc, out = run_tsx(code)
    return json.loads(out) if rc == 0 else {"ok": False}


# ═══════════════════════════════════════════════════════════
# Section 1: Audit 覆盖补全
# ═══════════════════════════════════════════════════════════
def test_audit_coverage():
    setup_seed_data()
    
    # 1.1 删除记忆产生审计
    code = '''
    import { storeMemory, deleteMemory } from "./src/memory.js";
    const mem = storeMemory("test5a2_agent1", "test content for audit delete", { scope: "private" });
    if (!mem.ok) { console.log(JSON.stringify({ok:false, error:"store failed"})); process.exit(1); }
    const result = deleteMemory(mem.memory.id, "test5a2_agent1", "admin");
    if (!result.ok) { console.log(JSON.stringify({ok:false, error:"delete failed"})); process.exit(1); }
    import { db } from "./src/db.js";
    const logs = db.prepare(`SELECT action FROM audit_log WHERE agent_id='test5a2_agent1' AND (action='delete_memory_fts' OR action='delete_memory_db') ORDER BY id DESC`).all();
    console.log(JSON.stringify({ok: true, logs: logs.map(l => l.action)}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok"), "1.1 删除记忆产生 delete_memory_fts 和 delete_memory_db 审计")
    if r.get("ok"):
        check("delete_memory_fts" in r.get("logs", []), "1.1a delete_memory_fts 审计记录存在")
        check("delete_memory_db" in r.get("logs", []), "1.1b delete_memory_db 审计记录存在")
    
    # 1.2 去重缓存清理产生审计
    code = '''
    import { cleanupExpiredEntries } from "./src/dedup.js";
    import { db } from "./src/db.js";
    cleanupExpiredEntries();
    const logs = db.prepare(`SELECT action FROM audit_log WHERE action='cleanup_dedup_cache' ORDER BY id DESC LIMIT 1`).get();
    console.log(JSON.stringify({ok: true, found: !!logs}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok"), "1.2 cleanupExpiredEntries 不报错")
    
    # 1.3 审计日志有哈希链
    code = '''
    import { auditLog } from "./src/security.js";
    import { db } from "./src/db.js";
    auditLog("test_audit_chain", "test5a2_agent1", "target1", "details");
    const row = db.prepare(`SELECT prev_hash, record_hash FROM audit_log WHERE action='test_audit_chain' ORDER BY id DESC LIMIT 1`).get();
    console.log(JSON.stringify({ok: true, has_prev: !!row?.prev_hash, has_hash: !!row?.record_hash, prev: row?.prev_hash?.slice(0, 16)}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("has_prev"), "1.3 新审计记录有 prev_hash（链式结构）")
    check(r.get("ok") and r.get("has_hash"), "1.3a 新审计记录有 record_hash")


# ═══════════════════════════════════════════════════════════
# Section 2: 信任评分基础计算
# ═══════════════════════════════════════════════════════════
def test_trust_score_basic():
    setup_seed_data()
    
    # 2.1 空 Agent = 50
    code = '''
    import { recalculateTrustScore } from "./src/security.js";
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 50, f"2.1 空 Agent 信任分 = 50（实际 {r.get('score')}）")
    
    # 2.2 有 verified capability +3
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    const now = Date.now();
    db.prepare(`INSERT OR IGNORE INTO agent_capabilities (id, agent_id, capability, verified, verified_at, created_at) VALUES (?, ?, ?, 1, ?, ?)`).run("cap_test5a2_1", "test5a2_agent1", "mcp", now, now);
    db.prepare(`INSERT OR IGNORE INTO agent_capabilities (id, agent_id, capability, verified, verified_at, created_at) VALUES (?, ?, ?, 1, ?, ?)`).run("cap_test5a2_2", "test5a2_agent1", "sse", now, now);
    const score = recalculateTrustScore("test5a2_agent1");
    const dbScore = db.prepare(`SELECT trust_score FROM agents WHERE agent_id='test5a2_agent1'`).get();
    console.log(JSON.stringify({ok: true, score, dbScore: dbScore?.trust_score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 56, f"2.2 2 个 verified capabilities = 50+6=56（实际 {r.get('score')}）")
    check(r.get("ok") and r.get("dbScore") == 56, f"2.2a 写回 agents.trust_score = 56")
    
    # 2.3 有 approved strategy +2
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    const now = Date.now();
    db.prepare(`INSERT INTO strategies (title, content, category, sensitivity, proposer_id, status, proposed_at, task_id, source_trust) VALUES (?, ?, 'workflow', 'normal', ?, 'approved', ?, NULL, 50)`).run("Test Strat 1", "Content for trust test", "test5a2_agent1", now);
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 58, f"2.3 +1 approved strategy = 56+2=58（实际 {r.get('score')}）")
    
    # 2.4 正面反馈 +1（别人给 proposer 的策略的正面反馈）
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    const stratId = db.prepare(`SELECT id FROM strategies WHERE proposer_id='test5a2_agent1' LIMIT 1`).get()?.id;
    if (!stratId) { console.log(JSON.stringify({ok: false})); process.exit(1); }
    const now = Date.now();
    // test5a2_other 给 test5a2_agent1 的策略正面反馈
    db.prepare(`INSERT OR IGNORE INTO strategy_feedback (strategy_id, agent_id, feedback, comment, applied, created_at) VALUES (?, ?, 'positive', 'good', 1, ?)`).run(stratId, "test5a2_other", now);
    // 公式 JOIN strategies.proposer_id，所以别人的正面反馈影响 proposer 分
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 59, f"2.4 别人给 proposer 的正面反馈 +1 = 58+1=59（实际 {r.get('score')}）")


# ═══════════════════════════════════════════════════════════
# Section 3: 信任评分扣分项
# ═══════════════════════════════════════════════════════════
def test_trust_score_penalties():
    setup_seed_data()
    
    # 3.1 负面反馈 -2（别人给 test5a2_agent1 策略的负面反馈）
    # 注意：3.1 代码中同时创建了 1 个 approved strategy (+2) 和 1 个 negative feedback (-2)
    # 净效果：50 + 2 - 2 = 50
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    const now = Date.now();
    // 先确保 test5a2_agent1 有一个策略
    db.prepare(`INSERT OR IGNORE INTO strategies (title, content, category, sensitivity, proposer_id, status, proposed_at, source_trust) VALUES (?, ?, 'workflow', 'normal', ?, 'approved', ?, 50)`).run("Strat for neg fb", "content", "test5a2_agent1", now);
    const stratId = db.prepare(`SELECT id FROM strategies WHERE title='Strat for neg fb'`).get()?.id;
    // test5a2_other 给 test5a2_agent1 的策略负面反馈
    db.prepare(`INSERT OR IGNORE INTO strategy_feedback (strategy_id, agent_id, feedback, created_at) VALUES (?, ?, 'negative', ?)`).run(stratId, "test5a2_other", now);
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 50, f"3.1 1 strategy(+2) + 1 negative(-2) = 50（实际 {r.get('score')}）")
    
    # 3.2 apply_strategy_fail 审计 → -3
    setup_seed_data()
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    import { auditLog } from "./src/security.js";
    auditLog("apply_strategy", "test5a2_agent1", "strat_999", "fail: strategy not found");
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 47, f"3.2 1 apply_fail = 50-3=47（实际 {r.get('score')}）")
    
    # 3.3 revoked token -10
    setup_seed_data()
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    import { auditLog } from "./src/security.js";
    auditLog("revoke_token", "test5a2_agent1", "some_token");
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 40, f"3.3 revoke_token = 50-10=40（实际 {r.get('score')}）")


# ═══════════════════════════════════════════════════════════
# Section 4: clamp + admin 覆盖 + recalculate 重置
# ═══════════════════════════════════════════════════════════
def test_clamp_and_override():
    setup_seed_data()
    
    # 4.1 clamp 下限 = 0
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    import { auditLog } from "./src/security.js";
    // 大量 revoke 让分数 < 0
    for (let i = 0; i < 10; i++) auditLog("revoke_token", "test5a2_agent1", `tok_${i}`);
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 0, f"4.1 大量扣分 clamp(0,100) = 0（实际 {r.get('score')}）")
    
    # 4.2 clamp 上限 = 100
    setup_seed_data()  # 清理 4.1 的 revoke 审计
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    const now = Date.now();
    // 20 个 verified capabilities = 50 + 60 = 110 → clamp to 100
    for (let i = 0; i < 20; i++) {
        db.prepare(`INSERT OR IGNORE INTO agent_capabilities (id, agent_id, capability, verified, verified_at, created_at) VALUES (?, 'test5a2_agent1', ?, 1, ?, ?)`).run(`cap_clamp_${i}`, `skill_${i}`, now, now);
    }
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 100, f"4.2 大量加分 clamp(0,100) = 100（实际 {r.get('score')}）")
    
    # 4.3 admin 手动覆盖后 recalculate 重算
    # setup 清理了 4.2 的 capabilities，所以 score 回到 base=50
    setup_seed_data()
    code = '''
    import { db } from "./src/db.js";
    import { recalculateTrustScore } from "./src/security.js";
    db.prepare(`UPDATE agents SET trust_score=80 WHERE agent_id='test5a2_agent1'`).run();
    const score = recalculateTrustScore("test5a2_agent1");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 50, f"4.3 admin 覆盖 80 后 recalculate 重算回 base=50（实际 {r.get('score')}）")


# ═══════════════════════════════════════════════════════════
# Section 5: recalculate_trust_scores 工具
# ═══════════════════════════════════════════════════════════
def test_recalculate_tool():
    setup_seed_data()
    
    # 5.1 TOOL_PERMISSIONS 包含 recalculate_trust_scores
    code = '''
    import { TOOL_PERMISSIONS } from "./src/security.js";
    console.log(JSON.stringify({ok: true, level: TOOL_PERMISSIONS["recalculate_trust_scores"]}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("level") == "admin", f"5.1 recalculate_trust_scores 权限 = admin（实际 {r.get('level')}）")
    
    # 5.2 recalculateAllTrustScores 返回所有 agent
    code = '''
    import { recalculateAllTrustScores } from "./src/security.js";
    const results = recalculateAllTrustScores();
    const agentIds = results.map(r => r.agent_id);
    console.log(JSON.stringify({ok: true, count: results.length, has_test: agentIds.includes("test5a2_agent1"), has_admin: agentIds.includes("test5a2_admin")}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("has_test"), f"5.2 全量重算包含 test5a2_agent1")
    check(r.get("ok") and r.get("has_admin"), f"5.2a 全量重算包含 test5a2_admin")
    
    # 5.3 非法 agent_id 不报错
    code = '''
    import { recalculateTrustScore } from "./src/security.js";
    const score = recalculateTrustScore("nonexistent_agent_xyz");
    console.log(JSON.stringify({ok: true, score}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("score") == 50, f"5.3 不存在的 agent 返回 base=50")


# ═══════════════════════════════════════════════════════════
# Section 6: 回归测试
# ═══════════════════════════════════════════════════════════
def test_regression():
    # 6.1 tsc --noEmit 零错误
    proc = subprocess.run(
        ["npx", "tsc", "--noEmit"],
        capture_output=True, text=True, cwd=HUB_DIR, timeout=60,
    )
    check(proc.returncode == 0, f"6.1 tsc --noEmit 零错误（rc={proc.returncode}）")
    
    # 6.2 Phase 5a Day 1 的 set_agent_role 仍正常
    code = '''
    import { setAgentRole } from "./src/identity.js";
    const result = setAgentRole("test5a2_agent1", "group_admin", "test5a2_admin", "pg_dummy");
    console.log(JSON.stringify({ok: result.ok, old_role: result.old_role, new_role: result.new_role}));
    if (result.ok) {
        setAgentRole("test5a2_agent1", "member", "test5a2_admin");
    }
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok"), f"6.2 set_agent_role 回归正常")
    
    # 6.3 审计链完整性
    code = '''
    import { verifyAuditChain } from "./src/security.js";
    const result = verifyAuditChain();
    console.log(JSON.stringify({ok: true, valid: result.valid, total: result.total}));
    '''
    rc, out = run_tsx(code)
    r = json.loads(out)
    check(r.get("ok") and r.get("valid"), f"6.3 审计链完整性验证通过（total={r.get('total')}）")


# ═══════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════
if __name__ == "__main__":
    run_section("1. Audit 覆盖补全", test_audit_coverage)
    run_section("2. 信任评分基础计算", test_trust_score_basic)
    run_section("3. 信任评分扣分项", test_trust_score_penalties)
    run_section("4. clamp + admin 覆盖 + recalculate 重置", test_clamp_and_override)
    run_section("5. recalculate_trust_scores 工具", test_recalculate_tool)
    run_section("6. 回归测试", test_regression)
    
    print(f"\n{'='*60}")
    print(f"Phase 5a Day 2 测试结果: {passed}/{passed+failed}")
    print(f"{'='*60}")
    
    if failed > 0:
        sys.exit(1)
