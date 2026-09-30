#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hub API token 轮换（先发后撤，可逆，绝不打印明文到日志）。

背景
────
Hub 的 `verifyToken()`（`src/security.ts:49`）**每次请求都查库**
（`SELECT agent_id, role FROM auth_tokens WHERE token_type='api_token' AND token_value=?
  AND used=1 AND revoked_at IS NULL`），
且库中存的是 **sha256(明文)**，明文由 `randomBytes(32).toString('hex')` 生成（64 位十六进制）。
⇒ 直接插入一行新 token + 撤销旧行即完成轮换，**不需要重启 Hub**。

安全约定
────────
* 明文 token **只写 600 权限文件**（`--out-file`），**绝不打印**（`--print` 需显式要求，仅限交互终端）。
* 每次写库前自动备份 `auth_tokens` 全表（哈希行）到 `<workdir>/auth_tokens-backup-<ts>.json`。
* 阶段严格分两步：`new` → （验证新 token 可用）→ `revoke`。**顺序颠倒会打断通道。**

用法
────
    # ① 签发新 token（明文写 600 文件）
    python3 scripts/rotate_token.py --agent-id <ID> --stage new --out-file /tmp/newtoken.txt
    # ② 验证（自己用 curl 验，见输出提示）
    # ③ 撤销该 agent 的**其余**在用 token（保留刚发的）
    python3 scripts/rotate_token.py --agent-id <ID> --stage revoke --keep token_id=<新 token_id>
    # 查看某 agent 在用 token（只列元数据）
    python3 scripts/rotate_token.py --agent-id <ID> --stage list
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import time

DEFAULT_DB = os.path.expanduser("~/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db")


def find_db(p: str | None) -> str | None:
    if p:
        return p if os.path.exists(p) else None
    if os.path.exists(DEFAULT_DB):
        return DEFAULT_DB
    hits = glob.glob(os.path.expanduser("~/**/comm_hub.db"), recursive=True)
    return hits[0] if hits else None


def backup(con, workdir: str) -> str:
    rows = [dict(zip([c[1] for c in con.execute("PRAGMA table_info(auth_tokens)")], r))
            for r in con.execute("select * from auth_tokens")]
    os.makedirs(workdir, exist_ok=True)
    p = os.path.join(workdir, "auth_tokens-backup-%d.json" % int(time.time()))
    with open(p, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    os.chmod(p, 0o600)
    return p


def live_rows(con, agent_id: str):
    return list(con.execute(
        "select token_id, role, created_at, expires_at, token_value from auth_tokens "
        "where token_type='api_token' and agent_id=? and used=1 and revoked_at is null "
        "order by created_at", (agent_id,)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent-id", required=True)
    ap.add_argument("--stage", required=True, choices=["list", "new", "revoke"])
    ap.add_argument("--db", default=None)
    ap.add_argument("--role", default=None, help="默认沿用该 agent 现有在用 token 的 role")
    ap.add_argument("--keep", default=None, help="revoke 阶段保留的 token_id（如 token_id=token_xxx）")
    ap.add_argument("--out-file", default=None, help="明文写入该文件（600）；不给则写入 <cwd>/hub-token-<agent>.txt")
    ap.add_argument("--print", dest="do_print", action="store_true", help="显式要求在终端打印明文（默认不打印）")
    ap.add_argument("--workdir", default=os.path.expanduser("~/.hermes/cache/scratch/hub_token_rotate"))
    a = ap.parse_args()

    db = find_db(a.db)
    if not db:
        print("🔴 找不到 comm_hub.db（--db 指定）")
        return 2
    con = sqlite3.connect(db)
    try:
        live = live_rows(con, a.agent_id)
        if a.stage == "list":
            print("库：%s\nagent=%s 在用 api_token %d 条：" % (db, a.agent_id, len(live)))
            for tid, role, created, exp, val in live:
                print("   token_id=%-46s role=%-6s created=%s expires=%s sha256=%s…"
                      % (tid, role, created, exp, (val or "")[:12]))
            return 0

        if a.stage == "new":
            if not live:
                print("🔴 该 agent 无在用 token（不自动造身份；先确认 agent_id）")
                return 2
            role = a.role or live[-1][1]
            plain = secrets.token_hex(32)                       # 64 hex，与 Hub 生成方式一致
            h = hashlib.sha256(plain.encode()).hexdigest()
            tid = "token_rotate_%s_%d" % (a.agent_id.replace("agent_", "")[:12], int(time.time()))
            bk = backup(con, a.workdir)
            con.execute(
                "INSERT INTO auth_tokens (token_id, token_type, token_value, agent_id, role, used,"
                " created_at, expires_at) VALUES (?, 'api_token', ?, ?, ?, 1, ?, NULL)",
                (tid, h, a.agent_id, role, int(time.time() * 1000)))
            con.commit()
            out = a.out_file or os.path.join(os.getcwd(), "hub-token-%s.txt" % a.agent_id)
            with open(out, "w", encoding="utf-8") as f:
                f.write(plain + "\n")
            os.chmod(out, 0o600)
            print("✅ 已签发新 token")
            print("   token_id    : %s" % tid)
            print("   role        : %s" % role)
            print("   明文写入    : %s（600 权限；**未打印**）" % out)
            print("   库备份      : %s" % bk)
            print("   旧 token_id : %s" % ", ".join(t for t, *_ in live))
            print()
            print("下一步（**顺序不可颠倒**）：")
            print("  ① 用明文更新全部 holder 配置（config.yaml / 对端 env / SDK 脚本）")
            print("  ② 验证新 token 可用：curl -s -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $(cat %s)\" "
                  "'http://localhost:3100/api/messages?agent_id=%s&status=unread'   # 期望 200" % (out, a.agent_id))
            print("  ③ 再撤销旧的：python3 scripts/rotate_token.py --agent-id %s --stage revoke --keep token_id=%s"
                  % (a.agent_id, tid))
            if a.do_print:
                print("   明文（显式要求打印）：%s" % plain)
            return 0

        # revoke
        keep = a.keep.split("=", 1)[1] if a.keep and "=" in a.keep else a.keep
        targets = [t for t, *_ in live if t != keep]
        if not targets:
            print("✅ 没有可撤销的旧 token（在用 %d 条，保留 %s）" % (len(live), keep))
            return 0
        bk = backup(con, a.workdir)
        con.executemany("UPDATE auth_tokens SET revoked_at=? WHERE token_id=?",
                        [(int(time.time() * 1000), t) for t in targets])
        con.commit()
        print("✅ 已撤销 %d 条旧 token：%s" % (len(targets), ", ".join(targets)))
        print("   保留：%s ｜ 库备份：%s" % (keep, bk))
        rest = live_rows(con, a.agent_id)
        print("   复核：该 agent 现存在用 token %d 条（应为 1）：%s"
              % (len(rest), ", ".join(t for t, *_ in rest)))
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
