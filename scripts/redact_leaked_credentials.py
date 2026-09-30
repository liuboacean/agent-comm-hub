#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把**仍然有效**的 Hub token 明文从落盘文件里抹掉（默认 dry-run）。

与 `scan_leaked_credentials.py` 的分工
─────────────────────────────────────
扫描器只**报告**；本件在**轮换尚未完成**的窗口里做**减害**（把明文替换成占位符）。
判定口径完全一致：**只有 `sha256(候选) == 库中某行`** 的串才动，绝不按"看起来像 token"乱改。

🔴 两类文件**默认跳过**（否则不是减害而是自伤）
──────────────────────────────────────────
1. **二进制文件**（前 8 KiB 含 NUL，或扩展名属归档/库）—— 文本替换会把 SQLite 库 / 归档**写坏**。
   典型：`~/.workbuddy/workbuddy.db`、`*.db-wal`、`*.db-shm`、`*.zip`、`*.gz`。
2. **正在使用该 token 的活配置**（`mcp.json` / `settings.json` / `config.json|yaml|yml` /
   `*.env` / `*.plist` / `*.pem|key`）—— 抹掉它**当场打断该 Agent 的 Hub 通道**。
   活配置的正确处置是**轮换**（换新值），不是 redact。
   确需一并处理时显式加 `--include-live-config`，且**必须先完成轮换**。

用法
────
    python3 scripts/redact_leaked_credentials.py --scan /tmp/hub_cred_scan.json            # 只报告
    python3 scripts/redact_leaked_credentials.py --scan /tmp/hub_cred_scan.json --apply    # 真改（留 .bak）

安全约定
────────
* 默认 **dry-run**；`--apply` 前每个文件先写 `<file>.bak_redact_<ts>` 副本。
* 只替换命中的**明文本身**，其余字节不动（保持 JSON/日志可解析）。
* 输出**永不打印明文**，只报「文件 + 替换条数」。
* `--skip-recent-sec N`：跳过**最近 N 秒内被修改过**的文件（避免与正在写的日志进程相冲），默认 300。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CAND = re.compile(r"""(?:Bearer\s+|HUB_AUTH_TOKEN\s*[=:]\s*"?|(?:api[_-]?token|access[_-]?token|token)
                      ["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-\.]{20,})""", re.VERBOSE | re.IGNORECASE)
BINARY_EXT = {".db", ".sqlite", ".sqlite3", ".zip", ".gz", ".tar", ".tgz", ".bin", ".pyc",
              ".so", ".dylib", ".png", ".jpg", ".jpeg", ".pdf", ".ico", ".p12", ".pfx"}
LIVE_CFG_NAMES = {"mcp.json", "settings.json", "config.json", "config.yaml", "config.yml",
                  "credentials.json", "secrets.json", "auth.json"}
LIVE_CFG_EXT = {".env", ".plist", ".pem", ".key"}


def load_scanner():
    spec = importlib.util.spec_from_file_location("_scan_leaked", os.path.join(HERE, "scan_leaked_credentials.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def is_binary(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return b"\x00" in f.read(8192)
    except Exception:                                                 # noqa: BLE001
        return True


def skip_reason(path: str) -> str | None:
    base = os.path.basename(path).lower()
    ext = os.path.splitext(base)[1]
    if ext in BINARY_EXT or base.endswith(".db-wal") or base.endswith(".db-shm"):
        return "二进制/归档（改了会写坏）"
    if base in LIVE_CFG_NAMES or ext in LIVE_CFG_EXT:
        return "活配置（改了会打断通道 ⇒ 应走轮换）"
    if is_binary(path):
        return "二进制（含 NUL）"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", required=True, help="scan_leaked_credentials.py --json 的输出")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--db", default=None)
    ap.add_argument("--include-live-config", action="store_true",
                    help="连活配置一起改（**危险**：先轮换再改）")
    ap.add_argument("--skip-recent-sec", type=int, default=300,
                    help="跳过最近 N 秒内被修改过的文件（默认 300，防与在写日志相冲；0=不跳）")
    a = ap.parse_args()

    sc = load_scanner()
    db = sc.find_db(a.db)
    if not db:
        print("🔴 找不到 comm_hub.db")
        return 2
    idx = sc.token_index(db)
    data = json.load(open(a.scan, encoding="utf-8"))
    files = [h["file"] for h in data.get("hits", [])]
    print("待处理文件 %d 个（来自 %s）｜库中 token 哈希 %d 条｜模式：%s"
          % (len(files), a.scan, len(idx), "APPLY（真改，留 .bak）" if a.apply else "DRY-RUN（只报告）"))
    now = time.time()
    ts = int(now)
    total_files = total_repl = 0
    skipped: dict[str, list] = {"binary_or_archive": [], "live_config": [], "recent": [], "unreadable": []}
    for p in files:
        if not a.include_live_config:
            r = skip_reason(p)
            if r:
                skipped["live_config" if "活配置" in r else "binary_or_archive"].append((p, r))
                continue
        try:
            st = os.stat(p)
        except Exception:                                             # noqa: BLE001
            skipped["unreadable"].append((p, "stat 失败"))
            continue
        if a.skip_recent_sec and (now - st.st_mtime) < a.skip_recent_sec:
            skipped["recent"].append((p, "%.0fs 前修改过" % (now - st.st_mtime)))
            continue
        try:
            txt = open(p, encoding="utf-8").read()
        except Exception as e:                                        # noqa: BLE001
            skipped["unreadable"].append((p, str(e)[:60]))
            continue
        hits = [c for c in {m for m in CAND.findall(txt)}
                if idx.get(hashlib.sha256(c.encode()).hexdigest())]
        if not hits:
            continue
        n = 0
        out = txt
        for c in hits:
            meta = idx[hashlib.sha256(c.encode()).hexdigest()]
            tag = "<REDACTED-HUB-TOKEN:%s:%s>" % (hashlib.sha256(c.encode()).hexdigest()[:12],
                                                 (meta.get("agent_id") or "?").split("_")[1][:12])
            n += out.count(c)
            out = out.replace(c, tag)
        total_files += 1
        total_repl += n
        print("   %-96s 替换 %d 处" % (p.replace(os.path.expanduser("~"), "~"), n))
        if a.apply and out != txt:
            bak = "%s.bak_redact_%d" % (p, ts)
            if not os.path.exists(bak):
                shutil.copy2(p, bak)
            with open(p, "w", encoding="utf-8") as f:
                f.write(out)
    print()
    print("%s：命中文件 %d 个，共替换 %d 处" % ("已替换" if a.apply else "DRY-RUN", total_files, total_repl))
    for k, label in (("binary_or_archive", "跳过（二进制/归档 —— 改了会写坏）"),
                     ("live_config", "跳过（活配置 —— 改了会打断通道，应走轮换）"),
                     ("recent", "跳过（最近 %ds 内被改过 —— 防与在写进程相冲）" % a.skip_recent_sec),
                     ("unreadable", "跳过（读失败）")):
        if skipped[k]:
            print("   %s：%d 个" % (label, len(skipped[k])))
            for p, why in skipped[k][:8]:
                print("      %s  [%s]" % (p.replace(os.path.expanduser("~"), "~"), why))
            if len(skipped[k]) > 8:
                print("      … 另 %d 个" % (len(skipped[k]) - 8))
    print()
    if a.apply:
        print("👉 改后必做两件：① 复扫 `scan_leaked_credentials.py` ⇒ 期望「有效凭据 0 条」；"
              "② **阳性对照** `_verify_ledger_chain.py --gate` ⇒ 期望**仍 rc=2**（判据未被扰动）")
    else:
        print("👉 确认无误后加 --apply 执行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
