# ops-notes.md —— Hub 运维记账（git 即账）

> **定位（he 2026-10-08 裁定）**：本文件为 **doc-only 账目**，只记「已发生的运维动作」——
> **路径 ＋ 前/后 md5 ＋ 时点 ＋ 留痕名**。**不承载方案/待办**；方案类内容一律按「先件后码」另立件。
> 边界：若某条目实质是「运维动作说明」而非「账目」，仍按先件后码走。

## 一、三笔记账（2026-10-08）

| # | 路径 | 前 md5（.bak 留痕） | 后 md5（现行） | 时点 | 说明 / commit |
|---|---|---|---|---|---|
| 1 | `~/.workbuddy/mcp.json` | `f7cda41d9c70849613af4a965aa9fff9`（708 B） | `7c46d849b4535738e80707ca2a4f3f8d`（455 B） | 2026-10-08 08:0x | 传输形态 `stdio` → `streamableHttp`（消双写）；留痕 `~/.workbuddy/mcp.json.bak_f7cda41d9c70849613af4a965aa9fff9` |
| 2 | `src/stdio.ts` | `1fde85c75ba5e3c4c6650cfd4819bb07`（2379 B / 68 行） | `9e4a8b856a913c11e975e02684ebd764`（6173 B / 144 行） | 2026-10-08 08:1x | 加「单写者护栏」（3100 存活即拒启）；`dist/src/stdio.js` `e5ce4831…` → `f4da30ee…`；commit `a0dd69d`；留痕 `src/stdio.ts.bak_1fde85c75ba5e3c4c6650cfd4819bb07` |
| 3 | `scripts/cron_db_watchdog.sh` | `3ca1ff5161d645ebce097c9c96a5863b`（4792 B / 109 行） | `e3625671316122abe9d0a3b27bc9110d`（9631 B / 202 行） | 2026-10-08 08:0x | 废止两处 `sqlite3` 直开活库（改 `cp` 快照口径）；commit `4ef4709`；留痕 `scripts/cron_db_watchdog.sh.bak_3ca1ff5161d645ebce097c9c96a5863b` |

> 三笔留痕均已**名实相符**现测（文件名内 md5 ≡ 内容 md5），时点 2026-10-08 08:4x。

## 二、语义坑一则（he 指示记入）

**`GET /api/messages` 缺省 `status` ＝ `unread`；而本系统里 `unread` 的真实语义是「尚未经 SSE 投递」，并非「用户未读」。**

- **机制**：`src/db.ts` 的 `pendingFor`（`status='unread'`）供 SSE 待发；`markAllDelivered` 把 `unread → delivered`。消息**一经投递就不再是 `unread`** ⇒ **缺省查询对活跃 agent 几乎恒空**。
- **后果**：任何用「缺省形态」问「对方有没有发消息」的调用，**永远得到「没有」** ⇒ 双方互相误判「对方未回复」。
- **现场证据（2026-10-08 08:4x）**：
  - `GET /api/messages?agent_id=<id>` → `{"messages":[],"count":0}`
  - `GET /api/messages?agent_id=<id>&status=read` → **有数据**
- **规避（修好之前）**：**显式传 `status`**；或改用 **3100 的 MCP 工具 `search_messages`**。
- **相关件**：`src/server.ts:468`（缺省值）／`client-sdk/hub_client.py:1407`（默认值同病）／`docs/API_REFERENCE.md:69`（未写缺省语义）。

## 三、单写者收敛动作（他方执行，记以备查）

- **执行者**：he（刘博放行「执行」）｜**时点**：2026-10-08 08:32
- **动作链**：SIGTERM 停 stdio（PID 38817，未用 `-9`）→ 停 6 个 launchd 任务 → `lsof` 确认无进程持库 → **停机快照查出主库页级损坏** → 修库（`integrity_check=ok`／`foreign_key_check=0`／**仅失 1 条 message**，其余表全等）→ 换库 → 只启 3100
- **单写者判据（我方独立复核，08:3x 现测）**：`lsof` 仅 1 持有者 **PID 65345**；磁盘 `db`/`-wal`/`-shm` inode `405354534`/`405354542`/`405354543` ≡ 该进程 fd；**写入后 inode 仍不变**
- **旧损库留证**：`comm_hub.db.damaged_20261008_0832`（12,718,080 B）＋ `~/.hermes/output/hub-repair2-20261008/`

## 四、观察名单（尚未落码，**仅备查，不含方案**）

| 件 | 位置 | 现状 |
|---|---|---|
| 备份脚本直开 | `/Users/liubo/Scripts/hub-backup.sh:44`（`sqlite3 "$DB" ".backup '…'"`） | launchd `com.liubo.hub-backup` 状态 `-78`（未运行） |
| 启动期 probe | `src/db.ts:23`（`isPopulatedDb` 的 `readonly:true` 打开） | 待先件后码 |
| 另一套备份 | `src/backup.ts`（`copyFileSync` 三件） | hub 内建小时调度 |

## 五、修 A 落码记账（2026-10-08 09:0x，刘博放行）

**性质**：`/api/messages` 缺省语义缺陷修复（走 A）＋ `.gitignore` 补漏。**代码面 7 件，全部「先留痕、后覆写」**（顺序未颠倒）。
**commit**：`83607d732a578b9739a6d8f437aeaf175717d14a`（`d59d09c..83607d7  master -> master`，local ≡ remote HEAD）；版本 `3.0.25` → `3.0.26`。

| # | 路径 | 前 md5（`.bak_` 留痕后缀） | 后 md5（现行） | 时点 | 说明 |
|---|---|---|---|---|---|
| 1 | `.gitignore` | `ed23bba0144499c51ce667c5fc05e889` | `426ab34dc15e5615bd3b6be359eccc72` | 2026-10-08 09:00 | 补 `comm_hub.db.damaged_*`（第 52 行） |
| 2 | `src/repo/interfaces.ts` | `4730d2e8c5c891da6d6ee343a0ab542b` | `f366f270083646e020ee41ab6adbafc2` | 2026-10-08 09:00 | 加 `listForAgent`；**`listByStatus` 一字未动** |
| 3 | `src/repo/sqlite-impl.ts` | `2f6cf753add59d5f43748f3b8f07c8bc` | `a671d1ce03de16865983f8d7730c4b28` | 2026-10-08 09:00 | 实现 `listForAgent`（`rowid DESC LIMIT ?`） |
| 4 | `src/server.ts` | `4cb207cd12e8c946db6d0f84e5fe1511` | `bea60274c649393561a8e7db08a6da82` | 2026-10-08 09:00 | `457-471`：缺省分支走 `listForAgent`；显式 `status` 路径不变 |
| 5 | `client-sdk/hub_client.py` | `1c3d6be30b293bd67704b7b85f5cba14` | `4c08c9dc57ccbe95ba218766b6b7928c` | 2026-10-08 09:00 | `get_messages(status=None, limit=50)` |
| 6 | `docs/API_REFERENCE.md` | `9ca6e48c195eb33270f86028736dcb24` | `3fbe7e1e576ce1f83e3e074a5d226fa4` | 2026-10-08 09:00 | 写死缺省语义 ＋ `unread` 语义坑 |
| 7 | `package.json` | `f6cf23f91f5ed5740b7d4e34ba99d337` | `df0e435ca4b6b62c839ddaf612191b7f` | 2026-10-08 09:00 | `3.0.25` → `3.0.26` |

> 七笔留痕均已**在位**且**名实相符**现测（文件名内 md5 ≡ 内容 md5），时点 2026-10-08 09:0x。
> **回归**（隔离沙箱：活库副本 ＋ 端口 3199，**不扰 3100**）**9/9 通过**：缺省 `count=50` 且首条为最新件（`rowid DESC`）／`status=read`＝130 与改前一致／`delivered`＝8 一致／`limit=3`→3／`limit=0|abc`→回落 50／`limit=9999`→夹紧 500／缺 `agent_id`→400／非法 `status`→400。
> **未同步项**：`src/repo/*.d.ts` 为入库的**陈旧声明镜像**（`tsc` `outDir=dist` 不会再生它们），本次未随 `interfaces.ts` 同步 ⇒ 待另议。

## 六、本文件 md5 沿革（**活件** —— 引用请现测并同屏时点）

> he 2026-10-08 09:0x 指示：把「活库/活件 md5 是**时点值**」这条纪律用在 `ops-notes` 它自己身上。
> 本文件**每次补记都会变 md5** ⇒ 任何引用都必须「现测 ＋ 同屏时点」，不得手抄沿用。

| 时点 | md5 | 行数 | 事由 |
|---|---|---|---|
| 2026-10-08 08:48 | `35ca6a173f3da18c368116657c7e162a` | 42 | 建库（commit `d59d09c`） |
| 2026-10-08 09:03 | `e8a262540930d5fa11d26ec1110a1b72` | 62 | 补记 §五（commit `62218df`） |
| 2026-10-08 09:12 | `5f27a206b10502c219378acc73d4d691` | 73 | 补记 §六沿革 ＋ §五补「时点」列（commit `8df6df7`） |
| 2026-10-08 09:29 | `05e57e720f123bc8ff878ef37ab79ab1` | 101 | 补记 §七 backups A–C 落码台账（commit `6bc6aea`） |

> 说明：上表记的是**历次已提交状态**，故总比现行状态慢一拍（补记本身又会改本文件 md5）。

## 八、backups D（一次性存量清理）执行记账（2026-10-08 09:40，he 放行单（四）§二.2 裁定「走 ②」）

**性质**：把 3576 件存量（孤儿/零长 sidecar ＋ 超期 `.db.gz`）**移入** `_trash_`（**不 `unlink`**，可回滚）。
**唯一来源**：`~/agent-comm-hub/backups/_manifest_20261008_093044.tsv`（md5 `53aac36e1f6179d74781be44ce618982`）的 `DEL_*` 行 —— **不重新 glob、不重算分类**（避免判据漂移）。
**执行**：`/tmp/lnsq_do_trash.py`（**前置 8 断言全过才动手；后置 6 断言全过才报成**；全程无 sqlite 访问、仅 `os.rename`）。

| 项 | 值 |
|---|---|
| D 对象 | **3576 件 / 1,471,872,083 B（1.371 GiB）** ＝ DEL_ZERO 1001 ＋ DEL_ORPHAN 2545 ＋ DEL_GZ 30 |
| 移入 | `~/agent-comm-hub/_trash_20261008_094018/`（🔴 位于 `backups/` **外侧**） |
| 源目录剩余 | **73 件** ＝ 24 宿主 ＋ 48 sidecar ＋ KEEP_GZ 1 |
| `HOST_SET_SHA256` 前后 | `52e191c912b550d711131af5745cc1fb657a40557fc5099737296a78b895ab16` **逐位不变**（判据 6） |
| `backups/` 体积 | 1.7 G → **281 M**（判据 4 可验） |
| 回滚 | `cd ~/agent-comm-hub && for f in _trash_20261008_094018/comm_hub_*; do mv "$f" backups/; done && rmdir _trash_20261008_094018` |

> 🔴 **一处设计纠正（我自纠）**：初版把 `_trash_` 建在 `backups/` **内部** ⇒ `du backups/` 仍 1.7 G ⇒ **判据 4 无法验证**。已移到 `backups/` **同级外侧**（回滚性不变，`_trash_` 另附 `README_ROLLBACK.txt`）。
> 🔴 **观察期 1 天**（he 放行单（四）§二.4）：观察期内**不得真删**。
> 🔴 **未做**：未重启 3100（由 he 执行）；`wal_checkpoint` 立项件／`src/repo/*.d.ts` 小件／队列四项／D 观察期后真删 —— **均挂账**。

## 七、backups A–C 落码记账（2026-10-08 09:29，he 放行单（四））

**性质**：备份目录与保留策略修复 ——
① **两套保留策略互相清理** ⇒ 本模块与仓库外 `hub-backup.sh` 各写各的子目录（`hourly/` 与 `remote/`）；
② **孤儿 sidecar 永不清**（原 `cleanupOldBackups` 只按 `.db` 过滤，宿主被裁到 `MAX_BACKUPS` 后 sidecar 无人清理，实测 `-wal`/`-shm` 各积压 1797 件）⇒ 清理改为**按宿主 stem 成套**。
**代码面 3 件 ＋ dist 运行件 3 件**（dist 为入库运行件，git 历史即留痕）。
**commit**：`d990bf04e223e6c38b9529a9fcc0718359b7dac8`（`8df6df7..d990bf0  master -> master`）；版本 `3.0.26` → `3.0.27`。

| # | 路径 | 前 md5（`.bak_` 留痕后缀） | 后 md5（现行） | 时点 | 说明 |
|---|---|---|---|---|---|
| 1 | `src/backup.ts` | `78464a4d156921579b0e62a66732f7fb` | `c6d8038a3ec5223fb32f00d92af26b40` | 2026-10-08 09:26 | 目录分列 ＋ 按宿主 stem 成套清理 ＋ `host_count`；留痕 `src/backup.ts.bak_78464a4d…` |
| 2 | `/Users/liubo/Scripts/hub-backup.sh`（**仓库外**） | `b9391cb9ecc98b5f24cd9a70ba3f36a1` | `8b28e41f2220a220134a956d5ccb4513` | 2026-10-08 09:27 | `BACKUP_DIR` → `…/backups/remote`（＋同名过期注释同步）；留痕 `/Users/liubo/Scripts/hub-backup.sh.bak_b9391cb9…` |
| 3 | `package.json` | `df0e435ca4b6b62c839ddaf612191b7f` | `f7685f36420e5b5027d48b2dbc450446` | 2026-10-08 09:28 | `3.0.26` → `3.0.27`；留痕 `package.json.bak_df0e435c…` |
| 4 | `dist/src/backup.js` | `a5c6655b23c6699115375115ee657ac7` | `dbc6599d7b1f5100082c730a9aae8aba` | 2026-10-08 09:29 | 运行件；同批 `.d.ts` `c42d30e8…`→`615a1c8f…`；`.js.map` `b2847e01…`→`4be13dd7…`；`dist/package.json` `df0e435c…`→`f7685f36…` |

> 留痕名实相符现测（文件名内 md5 ≡ 内容 md5），时点 2026-10-08 09:29。行 4 的 dist 三件由 **git 历史**承担留痕（该目录 2026-10-08 起按刘博指示纳入版本控制），故不另落 `.bak`。
> 🔴 **顺序瑕疵（如实记录）**：`package.json` 首改时**覆写先于留痕**。因改动恰为版本号一行，已用 `git show HEAD:package.json` **逐字节重建**改前内容，现测 md5 ≡ `df0e435ca4b6b62c839ddaf612191b7f`（＝§五 行 7 的「后 md5」）⇒ 留痕与改前实体**可证等价**；但**顺序仍属违规**，记以备查，下批须先留痕。

> **回归**（隔离沙箱：活库**只读副本** ＋ `NODE_ENV=test` ＋ 显式 `DB_PATH` ＋ `BACKUP_DIR` 指向临时目录；**全程不扰 3100**）：
> - **场景一 9/9 全绿** —— 夹具＝30 宿主（各带 `-wal`/`-shm`，奇数日 `-wal` 非零模拟检查点失败）＋ 3 个孤儿 sidecar ＋ 1 个外来文件。断言全通过：保留宿主恰 24／每宿主三件齐全／**零孤儿 sidecar 残留**／1..7 日宿主删净／`2025120x` 孤儿删净／外来 `README.txt` **未被删**／**保留宿主的「非零 wal」未被误删（n=11，size=500）**／**保留宿主的「零长 wal」同样保留（n=12）**。
> - **阴/阳对照（同一夹具）** —— 阴（`.bak` 改前）：`host=24 sidecar=98 孤儿sidecar=50`（**bug 复现**）；阳（编译产物）：`host=24 sidecar=48 孤儿sidecar=0`（**修复生效**）。两臂「每宿主三件齐全」均 True、外来文件均未动。
> - `getBackupStatus()` 实测 `host_count=24`，大小按成套统计（含 sidecar）。
> **待 he 执行**：重启 3100 后方生效（本批未重启）。
> **未同步项**：`src/repo/*.d.ts` 仍为陈旧声明镜像 ⇒ 按 he 裁定**另立一笔**。

## 九、LNSQ 装置件改动授权（2026-10-08，刘博「选 A」）

**性质**：**授权记录**（按 he 指示记于 hub 侧 `docs/ops-notes.md`）。
**授权链**：**刘博本人 2026-10-08 原话「选 A」**（概括授权）｜载体＝本会话（wb↔he）｜经 he 件 `38ef0c95-5df1-4e61-993c-0dc688ab781e`（12:04:56）转达；he 裁定件 `73e3e487-1b3e-49cd-8049-4c8c9320628d`（11:58:59）。

**放行范围（仅此一项）**：让 LNSQ **评测路径**对齐生产语义 —— **开 `intent`**（装置件改动）。

**依据**：装置级缺口经**双方独立取证一致**（wb 侧现测 ＋ he 直读源码独立验实）；生产侧对照**已办**（确认生产路径无此缺口 ⇒「臂实＝线上实」有据）。

**he 八条条件（逐条生效）**：① 批 1 收跑后才动装置件；装置件属链路件 ⇒ **另立件 ＋ 先留痕 ＋ 入册 ＋ 新内容须含旧内容前缀** ② 四臂同开 `intent` ③ **先跑阳性自证，不成立即停**、不得起 4 臂 ④ 可比性声明写死：与批 1／旧三臂**不再同装置** ⇒ 只能作**量级校验**，跨批差值必带噪声声明 ⑤ **新增成本单列** ⑥ 冻结口径件补写「臂实要求装置开 `intent`」⇒ 出新版 ⑦ 生产侧实证（已办）⑧ 门禁未解释缺口数**不变** ＋ 台账 md5 同屏（机器＋绝对路径）。

**明确未放行**：❌ 口径变更（臂矩阵／轮数／判据不变）｜❌ 受保护件｜❌ 任何与批 1 并行的 GPU 作业｜❌ Hub 队列挂账项。

**顺序（重申）**：批 1 三臂收齐 → 收数件（含**逐臂数字违规题号表** ＋ 胜出臂 ＋ 取数路径）→ he 逐数复核 → 批 1 收跑后落装置件（先留痕＋入册）→ 阳性自证 → 起 4 臂。

**脱敏说明**：本记录**按刘博 2026-10-08 指令脱敏** —— 原稿含**内部件 md5、内部绝对路径、链路技术细节**，均已删除；**完整版留 LNSQ 侧**，不进公开仓库。

**时点**：2026-10-08 12:4x（wb 记，Mac 侧现测）。
