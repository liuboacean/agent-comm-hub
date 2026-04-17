#!/usr/bin/env python3
"""
hub_integration.py — Hermes ↔ Hub 集成入口

这个文件负责：
  1. 启动 Hub 客户端（SSE 长连接 + MCP）
  2. 接收 WorkBuddy 分配的任务 → 交给 Hermes 执行
  3. 接收消息 → 交给 Hermes 处理
  4. 提供 send_to_workbuddy() 供 Hermes 其他模块调用

使用方式：
  在 Hermes 代码中任意位置 import：
    from hub_integration import hub, send_to_workbuddy, assign_to_workbuddy
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

# 确保可以找到 hub_client
SCRIPTS_DIR = Path(__file__).parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from hub_client import HubClient

logger = logging.getLogger("hermes.hub_integration")

# ─── 配置 ──────────────────────────────────────────────
HERMES_ID = os.environ.get("HERMES_ID", "hermes")
HUB_URL = os.environ.get("HUB_URL", "http://localhost:3100")

# ─── 全局实例 ──────────────────────────────────────────
hub: HubClient = None  # type: ignore


# ─── 任务处理回调 ──────────────────────────────────────

async def _on_task_assigned(task: dict):
    """
    收到 WorkBuddy 分配的任务。
    这里是 Hermes 执行任务的核心入口。
    """
    task_id = task.get("id", "unknown")
    description = task.get("description", "")
    context = task.get("context", "")
    priority = task.get("priority", "normal")

    logger.info(f"收到任务 [{task_id}] (优先级: {priority}): {description[:80]}")
    if context:
        logger.info(f"  上下文: {context[:120]}")

    # ① 立刻回报"已接收，开始执行"
    await hub.update_task_status(task_id, "in_progress", "Hermes 已接收任务", 5)

    try:
        # ② 调用 Hermes 核心逻辑执行任务
        result = await execute_hermes_task(task_id, description, context, priority)

        # ③ 汇报完成
        await hub.update_task_status(task_id, "completed", result, 100)
        logger.info(f"任务 [{task_id}] 已完成")

    except Exception as e:
        await hub.update_task_status(task_id, "failed", f"执行错误: {e}", 0)
        logger.error(f"任务 [{task_id}] 失败: {e}")


async def _on_message(msg: dict):
    """收到消息"""
    from_agent = msg.get("from_agent", "unknown")
    content = msg.get("content", "")
    logger.info(f"收到消息 from {from_agent}: {content[:80]}")

    # 可以在这里触发 Hermes 的对话能力
    # 例如：调用 LLM 处理并回复


async def _on_task_updated(upd: dict):
    """任务进度更新"""
    task_id = upd.get("task_id", "")
    status = upd.get("status", "")
    progress = upd.get("progress", 0)
    result = upd.get("result", "")

    icon = {"completed": "✅", "failed": "❌", "in_progress": "⏳"}.get(status, "❓")
    logger.info(f"{icon} 任务 {task_id}: {status} ({progress}%)")
    if result:
        logger.info(f"  结果: {result[:120]}")


# ─── Hermes 任务执行逻辑 ──────────────────────────────

async def execute_hermes_task(task_id: str, description: str, context: str, priority: str) -> str:
    """
    Hermes 执行任务的核心逻辑。
    
    这里对接 Hermes 的实际能力（LLM 调用、工具调用等）。
    当前版本为演示模式——实际使用时替换为 Hermes 的真实逻辑。
    """
    logger.info(f"开始执行任务 [{task_id}]: {description[:80]}")

    # 中途汇报进度
    await hub.update_task_status(task_id, "in_progress", "正在分析任务需求...", 15)

    # ── TODO: 对接 Hermes 的真实能力 ────────────────────
    # 选项 1: 调用 Hermes 的 AIAgent
    #   from run_agent import AIAgent
    #   agent = AIAgent(...)
    #   result = agent.run_conversation(description)
    #
    # 选项 2: 调用 Hermes CLI
    #   subprocess.run(["hermes", "run", description])
    #
    # 选项 3: 调用 Hermes 的其他 MCP 工具

    # 当前演示：模拟执行
    await hub.update_task_status(task_id, "in_progress", "正在执行...", 50)
    await asyncio.sleep(1)
    await hub.update_task_status(task_id, "in_progress", "正在生成结果...", 80)
    await asyncio.sleep(0.5)

    result = json.dumps({
        "summary": f"Hermes 完成了任务: {description[:80]}",
        "task_id": task_id,
        "status": "success",
        "timestamp": os.environ.get("TIMESTAMP", ""),
    }, ensure_ascii=False, indent=2)

    return result


# ─── 对外接口 ──────────────────────────────────────────

async def send_to_workbuddy(content: str, metadata: dict = None) -> dict:
    """Hermes 主动发送消息给 WorkBuddy"""
    if not hub:
        raise RuntimeError("Hub 客户端未初始化")
    return await hub.send_message("workbuddy", content, metadata)


async def assign_to_workbuddy(description: str, context: str = None, priority: str = "normal") -> dict:
    """Hermes 给 WorkBuddy 分配任务"""
    if not hub:
        raise RuntimeError("Hub 客户端未初始化")
    return await hub.assign_task("workbuddy", description, context, priority)


async def get_online() -> list:
    """查询在线 Agent"""
    if not hub:
        raise RuntimeError("Hub 客户端未初始化")
    return await hub.get_online_agents()


# ─── 启动入口 ──────────────────────────────────────────

async def start_hub():
    """启动 Hub 客户端（在 Hermes 主逻辑中调用）"""
    global hub

    hub = HubClient(
        agent_id=HERMES_ID,
        hub_url=HUB_URL,
        on_task_assigned=_on_task_assigned,
        on_message=_on_message,
        on_task_updated=_on_task_updated,
    )

    await hub.start()
    logger.info(f"Hermes Hub 集成已启动 (ID={HERMES_ID}, Hub={HUB_URL})")
    return hub


async def stop_hub():
    """停止 Hub 客户端"""
    global hub
    if hub:
        await hub.stop()
        hub = None
        logger.info("Hermes Hub 集成已停止")


# ─── 直接运行测试 ──────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    async def main():
        print(f"\n{'='*50}")
        print(f"  Hermes Hub 集成测试")
        print(f"  Agent ID: {HERMES_ID}")
        print(f"  Hub URL:  {HUB_URL}")
        print(f"{'='*50}\n")

        await start_hub()

        # 等待 SSE 连接稳定
        await asyncio.sleep(2)

        # 检查在线 Agent
        online = await get_online()
        print(f"\n当前在线 Agents: {online}")

        # 发送测试消息给 WorkBuddy
        print("\n发送测试消息给 WorkBuddy...")
        result = await send_to_workbuddy("你好 WorkBuddy！Hermes Hub 集成测试成功！")
        print(f"发送结果: {result}")

        # 保持运行，等待接收任务/消息
        print("\nHermes Hub 客户端运行中，等待任务/消息... (Ctrl+C 退出)")
        try:
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            print("\n正在退出...")
            await stop_hub()

    asyncio.run(main())
