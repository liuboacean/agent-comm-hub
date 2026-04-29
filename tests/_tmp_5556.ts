import { recalculateTrustScore } from "../src/security.js";
import { auditLog } from "../src/security.js";
import { db } from "../src/db.js";
const now = Date.now();
db.exec("DROP TRIGGER IF EXISTS audit_log_no_delete");
db.prepare("DELETE FROM agent_capabilities WHERE agent_id = '5a3_member'").run();
db.prepare("DELETE FROM strategies WHERE proposer_id = '5a3_member'").run();
try { db.prepare("DELETE FROM strategies_fts").run(); } catch(e) {}
db.prepare("DELETE FROM strategy_feedback WHERE agent_id = '5a3_admin'").run();
db.prepare("DELETE FROM audit_log WHERE agent_id = '5a3_member' AND action = 'revoke_token'").run();
db.prepare("UPDATE agents SET trust_score = 50 WHERE agent_id = '5a3_member'").run();
db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;`);
db.prepare("INSERT INTO agent_capabilities (id, agent_id, capability, verified, created_at) VALUES (?, ?, 'test_cap', 1, ?)").run("5a3_cap_1", "5a3_member", now);
db.prepare("INSERT INTO strategies (title, content, category, sensitivity, proposer_id, status, proposed_at, source_trust, apply_count, feedback_count, positive_count) VALUES (?, ?, 'workflow', 'normal', ?, 'approved', ?, 60, 0, 0, 0)").run("5a3_test_strat", "test content for negative feedback", "5a3_member", now);
const base = recalculateTrustScore("5a3_member");
const strat = db.prepare("SELECT id FROM strategies WHERE proposer_id = '5a3_member' AND title = '5a3_test_strat'").get() as any;
let score55 = -1;
if (strat) {
    db.prepare("INSERT INTO strategy_feedback (id, strategy_id, agent_id, feedback, created_at) VALUES (?, ?, ?, 'negative', ?)").run("5a3_fb_1", strat.id, "5a3_admin", now);
    score55 = recalculateTrustScore("5a3_member");
}
db.exec("DROP TRIGGER IF EXISTS audit_log_no_delete");
db.prepare("DELETE FROM audit_log WHERE agent_id = '5a3_member' AND action = 'revoke_token'").run();
db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;`);
auditLog("revoke_token", "5a3_member", "5a3_token_1", "E2E trust score test");
const score56 = recalculateTrustScore("5a3_member");
console.log(JSON.stringify({ base, score55, score56 }));
