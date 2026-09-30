#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**凭据泄露扫描器**（只读）：找出仓/日志/轨迹里**仍然有效**的 Hub 凭据。

为什么需要它
────────────
Agent 的日志/轨迹（`~/.workbuddy/logs/**`、`~/.workbuddy/traces/**`、`projects/**/*.jsonl`）
会把整条命令原样落盘 —— **一次 `env` / `env | grep` / `curl -H "Authorization: Bearer …"`
就足以把明文 token 写进历史**。事后「我以为没泄露」不成立，必须**机械判定**。

判定口径（关键）
────────────────
Hub 的 `auth_tokens.token_value` 存的是 **sha256(明文 token)**（见 `src/security.ts` 生成/哈希）。
⇒ 从文件里抓到的候选串，**只要 sha256 命中库中某行，它就是一条仍然有效的 Hub 凭据**（而非误报）。
本件因此**不靠正则猜**：命中 = 证据。

用法
────
    python3 scripts/scan_leaked_credentials.py                 # 默认扫 ~/.workbuddy + ~/.hermes/logs
    python3 scripts/scan_leaked_credentials.py --roots A B     # 指定根
    python3 scripts/scan_leaked_credentials.py --mask-plan     # 额外输出**脱敏清单**（不改文件）
    python3 scripts/scan_leaked_credentials.py --json out.json

安全约定
────────
* **只读**：不修改任何被扫文件；默认输出**不打印任何明文**（只给「文件 + 条数 + 归属 agent + 掩码前缀」）。
* 掩码前缀只取前 6 字符（凭据不可由此重建）。
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys

DEFAULT_ROOTS = [
    os.path.expanduser("~/.workbuddy"),
    os.path.expanduser("~/WorkBuddy"),
    os.path.expanduser("~/.hermes/logs"),
    os.path.expanduser("~/.hermes/cache"),
    os.path.expanduser("~/Library/Application Support/QClaw"),
    os.path.expanduser("~/Library/Application Support/WorkBuddy"),
]
# 候选串：出现在 Bearer / token= / HUB_AUTH_TOKEN= / Authorization 语境里的长串
CAND = re.compile(r"""(?:Bearer\s+|HUB_AUTH_TOKEN\s*[=:]\s*"?|(?:api[_-]?token|access[_-]?token|token)
                      ["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-\.]{20,})""", re.VERBOSE | re.IGNORECASE)
SKIP_DIRS = {".git", "node_modules", "__pycache__", "dist", "build", ".venv", "venv"}
MAX_FILE = 32 * 1024 * 1024


def find_db(explicit: str | None) -> str | None:
    if explicit:
        return explicit if os.path.exists(explicit) else None
    for p in [os.path.expanduser("~/WorkBuddy/20260416213415/agent-comm-hub/comm_hub.db"),
              os.path.expanduser("~/.workbuddy/agent-comm-hub/comm_hub.db")]:
        if os.path.exists(p):
            return p
    hits = glob.glob(os.path.expanduser("~/**/comm_hub.db"), recursive=True)
    return hits[0] if hits else None


def token_index(db: str) -> dict:
    """sha256(明文) → 元数据。**只读**；库损坏时尽力而为。"""
    idx: dict[str, dict] = {}
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    try:
        for val, aid, role, used, rev, tid in con.execute(
                "select token_value, agent_id, role, used, revoked_at, token_id from auth_tokens"):
            if not val:
                continue
            idx[val] = {"agent_id": aid, "role": role, "used": used,
                        "revoked": rev is not None, "token_id": tid}
    except sqlite3.Error as e:
        print("🔴 读 auth_tokens 失败：%s" % e, file=sys.stderr)
    finally:
        con.close()
    return idx


def scan(roots, idx):
    hits = []            # (path, 命中数, [归属...], [掩码...])
    scanned = 0
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if d not in SKIP_DIRS]
            for f in fn:
                p = os.path.join(dp, f)
                try:
                    if os.path.getsize(p) > MAX_FILE:
                        continue
                    txt = open(p, encoding="utf-8", errors="ignore").read()
                except Exception:                                    # noqa: BLE001
                    continue
                scanned += 1
                cands = {m for m in CAND.findall(txt)}
                if not cands:
                    continue
                live = []
                for c in cands:
                    h = hashlib.sha256(c.encode()).hexdigest()
                    meta = idx.get(h)
                    if meta:
                        live.append((c[:6] + "…", meta))
                if live:
                    hits.append({"file": p, "n_live": len(live),
                                 "owners": sorted({(m["agent_id"] or "?") +
                                                   ("(已撤销)" if m["revoked"] else "(有效)")
                                                   for _, m in live}),
                                 "masked": sorted({mk for mk, _ in live}),
                                 "n_candidates": len(cands)})
    return hits, scanned


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roots", nargs="*", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--mask-plan", action="store_true",
                    help="额外输出脱敏建议（**不改文件**）")
    a = ap.parse_args()

    db = find_db(a.db)
    if not db:
        print("🔴 找不到 comm_hub.db（用 --db 指定）")
        return 2
    idx = token_index(db)
    print("库：%s\n已登记 token 哈希 %d 条（含已撤销）" % (db, len(idx)))
    roots = [os.path.expanduser(r) for r in (a.roots or DEFAULT_ROOTS)]
    hits, scanned = scan(roots, idx)
    print("扫描文件 %d 个（根：%s）" % (scanned, ", ".join(r.replace(os.path.expanduser("~"), "~") for r in roots)))
    print()
    if not hits:
        print("✅ 未发现**仍然有效**的 Hub 凭据落盘（候选串经 sha256 比对均不命中库）")
        return 0
    print("🔴 发现 %d 个文件含**仍然有效**的 Hub 凭据：" % len(hits))
    by_owner: dict[str, int] = {}
    for h in sorted(hits, key=lambda x: -x["n_live"]):
        print("   %-96s 有效凭据 %d 条 ｜ 归属：%s"
              % (h["file"].replace(os.path.expanduser("~"), "~"), h["n_live"], "、".join(h["owners"])))
        for o in h["owners"]:
            by_owner[o] = by_owner.get(o, 0) + 1
    print()
    print("按归属汇总：")
    for o, n in sorted(by_owner.items(), key=lambda x: -x[1]):
        print("   %-60s 出现在 %d 个文件" % (o, n))
    print()
    print("处置建议（顺序不可颠倒）：① 先**签发新 token** 并更新各 holder 配置 → ② 验证新 token 可用 → "
          "③ 再 `revoke_token` 旧 token → ④ 用本件复扫，确认「有效凭据 0 条」。")
    if a.mask_plan:
        print()
        print("脱敏清单（掩码前缀，不打印明文）：")
        for h in sorted(hits, key=lambda x: -x["n_live"]):
            print("   %s → %s" % (h["file"].replace(os.path.expanduser("~"), "~"), ", ".join(h["masked"])))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"db": db, "scanned": scanned, "hits": hits}, f, ensure_ascii=False, indent=2)
        print("\n明细已写：%s" % a.json)
    return 1


if __name__ == "__main__":
    sys.exit(main())
