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
