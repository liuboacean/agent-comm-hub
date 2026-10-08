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


