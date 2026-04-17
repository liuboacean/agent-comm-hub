#!/usr/bin/env python3
"""
hub_client.py — Agent Communication Hub Python 客户端

为 Hermes 提供 Hub 接入能力：
  1. SSE 长连接（自动重连，零轮询接收任务/消息）
  2. MCP HTTP POST 封装（发送消息、汇报进度、查询在线 Agent）

使用方法：
  from hub_client import HubClient

  client = HubClient(agent_id="hermes", hub_url="http://localhost:3100")
  await client.start()
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Callable, Dict, Optional
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger("hub_client")


# ─── 类型定义 ────────────────────────────────────────────
@dataclass
class TaskEvent:
    id: str
    assigned_by: str
    assigned_to: str
    description: str
    context: Optional[str]
    priority: str
    status: str
    instruction: str


@dataclass
class MessageEvent:
    id: str
    from_agent: str
    to_agent: str
    content: str
    type: str
    created_at: int
    metadata: Optional[Dict] = None


@dataclass
class TaskUpdateEvent:
    task_id: str
    status: str
    result: Optional[str]
    progress: int
    updated_by: str
    timestamp: int


# ─── HubClient ──────────────────────────────────────────
class HubClient:
    """
    Agent Communication Hub 的 Python 客户端。
    
    用 asyncio 运行 SSE 长连接 + httpx 做 MCP 调用。
    """

    def __init__(
        self,
        agent_id: str = "hermes",
        hub_url: str = "http://localhost:3100",
        on_task_assigned: Optional[Callable] = None,
        on_message: Optional[Callable] = None,
        on_task_updated: Optional[Callable] = None,
        reconnect_delay: float = 3.0,
        mcp_timeout: float = 15.0,
    ):
        self.agent_id = agent_id
        self.hub_url = hub_url.rstrip("/")
        self.on_task_assigned = on_task_assigned
        self.on_message = on_message
        self.on_task_updated = on_task_updated
        self.reconnect_delay = reconnect_delay
        self.mcp_timeout = mcp_timeout

        self._session_id: Optional[str] = None
        self._initialized: bool = False
        self._init_lock = asyncio.Lock()
        self._stopping: bool = False
        self._sse_task: Optional[asyncio.Task] = None

    # ── 启动 / 停止 ────────────────────────────────────

    async def start(self):
        """启动：MCP 握手 + SSE 长连接"""
        self._stopping = False
        await self._ensure_initialized()
        self._sse_task = asyncio.create_task(self._sse_loop())
        logger.info(f"[{self.agent_id}] 已启动，连接 Hub: {self.hub_url}")

    async def stop(self):
        """停止客户端"""
        self._stopping = True
        self._initialized = False
        self._session_id = None
        if self._sse_task:
            self._sse_task.cancel()
            try:
                await self._sse_task
            except asyncio.CancelledError:
                pass
        logger.info(f"[{self.agent_id}] 已停止")

    # ── MCP Initialize 握手 ─────────────────────────────

    async def _ensure_initialized(self):
        """确保 MCP 握手完成（幂等）"""
        if self._initialized and self._session_id:
            return
        async with self._init_lock:
            if self._initialized and self._session_id:
                return
            await self._do_initialize()

    async def _do_initialize(self):
        """执行 MCP initialize 握手"""
        # Step 1: initialize（stateless 模式：每次都成功，无 session）
        init_res = await self._post_mcp({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {
                    "name": f"hub-client-{self.agent_id}",
                    "version": "1.0.0",
                },
            },
        })

        if init_res.get("error"):
            raise RuntimeError(f"MCP initialize failed: {json.dumps(init_res['error'])}")

        logger.info(f"[{self.agent_id}] MCP initialized (stateless)")

        # Step 2: notifications/initialized
        await self._post_mcp({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })

        self._initialized = True

    # ── MCP POST 封装 ───────────────────────────────────

    async def _post_mcp(self, payload: dict, timeout: Optional[float] = None) -> dict:
        """
        发送 MCP 请求，解析 SSE 格式响应。
        
        Hub 返回的是 SSE 格式：
          event: message
          data: {"result":..., "jsonrpc":"2.0", "id":1}
        """
        url = f"{self.hub_url}/mcp"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id

        async with httpx.AsyncClient(timeout=timeout or self.mcp_timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)

        # 更新 session ID
        new_sid = resp.headers.get("mcp-session-id")
        if new_sid and new_sid != self._session_id:
            self._session_id = new_sid

        # 解析响应
        ct = resp.headers.get("content-type", "")
        raw = resp.text

        if "text/event-stream" in ct:
            # SSE 格式：提取 "data: " 行
            for line in raw.split("\n"):
                line = line.strip()
                if line.startswith("data: "):
                    return json.loads(line[6:])
            return {}
        else:
            return json.loads(raw) if raw else {}

    async def _call_tool(self, tool_name: str, args: dict) -> Any:
        """调用 MCP 工具（stateless 模式：每次独立请求）"""
        return await self._do_call_tool(tool_name, args)

    async def _do_call_tool(self, tool_name: str, args: dict) -> Any:
        body = await self._post_mcp({
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000),
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": args},
        })

        if body.get("error"):
            err_info = body["error"]
            raise RuntimeError(f"MCP tool error [{tool_name}]: {err_info.get('message', json.dumps(err_info))}")

        # 提取结果
        result = body.get("result", {})
        text = result.get("content", [{}])[0].get("text", "") if result.get("content") else result
        if isinstance(text, str):
            try:
                return json.loads(text)
            except (json.JSONDecodeError, TypeError):
                return text
        return body

    # ── SSE 长连接 ─────────────────────────────────────

    async def _sse_loop(self):
        """SSE 连接循环（含自动重连）"""
        while not self._stopping:
            try:
                await self._connect_sse()
            except asyncio.CancelledError:
                break
            except Exception as e:
                if self._stopping:
                    break
                logger.warning(f"[{self.agent_id}] SSE 断线: {e}, {self.reconnect_delay}s 后重连...")
                await asyncio.sleep(self.reconnect_delay)

    async def _connect_sse(self):
        """建立 SSE 连接，实时接收事件"""
        url = f"{self.hub_url}/events/{self.agent_id}"

        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                buffer = ""
                async for chunk in resp.aiter_text():
                    if self._stopping:
                        break
                    buffer += chunk
                    # SSE 消息以双换行分隔
                    while "\n\n" in buffer:
                        message, buffer = buffer.split("\n\n", 1)
                        await self._process_sse_message(message)

    async def _process_sse_message(self, message: str):
        """处理一条 SSE 消息"""
        # 提取 data 行
        data_json = None
        for line in message.split("\n"):
            line = line.strip()
            if line.startswith("data: "):
                try:
                    data_json = json.loads(line[6:])
                except json.JSONDecodeError:
                    logger.error(f"[{self.agent_id}] SSE JSON 解析失败: {line[6:][:100]}")
                break

        if not data_json:
            return

        event_type = data_json.get("event")

        if event_type == "task_assigned":
            task = data_json.get("task", {})
            logger.info(f"[{self.agent_id}] 收到任务: {task.get('description', '')[:60]}")
            if self.on_task_assigned:
                await self._safe_call(self.on_task_assigned, task)

        elif event_type == "new_message":
            msg = data_json.get("message", {})
            logger.info(f"[{self.agent_id}] 收到消息 from {msg.get('from_agent')}: {msg.get('content', '')[:60]}")
            if self.on_message:
                await self._safe_call(self.on_message, msg)

        elif event_type == "task_updated":
            upd = data_json.get("update", {})
            logger.info(f"[{self.agent_id}] 任务进度更新: {upd.get('task_id')} → {upd.get('status')}")
            if self.on_task_updated:
                await self._safe_call(self.on_task_updated, upd)

        elif event_type == "pending_messages":
            for msg in data_json.get("messages", []):
                logger.info(f"[{self.agent_id}] 补发积压消息 from {msg.get('from_agent')}: {msg.get('content', '')[:60]}")
                if self.on_message:
                    await self._safe_call(self.on_message, msg)

    @staticmethod
    async def _safe_call(func, *args):
        """安全调用回调，捕获异常不影响主循环"""
        try:
            if asyncio.iscoroutinefunction(func):
                await func(*args)
            else:
                func(*args)
        except Exception as e:
            logger.error(f"回调执行失败: {e}")

    # ── 对外 API ───────────────────────────────────────

    async def send_message(self, to: str, content: str, metadata: Optional[dict] = None):
        """发送消息给另一个 Agent"""
        return await self._call_tool("send_message", {
            "from": self.agent_id, "to": to,
            "content": content, "type": "message", "metadata": metadata,
        })

    async def assign_task(self, to: str, description: str, context: Optional[str] = None, priority: str = "normal"):
        """分配任务给另一个 Agent"""
        return await self._call_tool("assign_task", {
            "from": self.agent_id, "to": to,
            "description": description, "context": context, "priority": priority,
        })

    async def update_task_status(
        self, task_id: str, status: str, result: Optional[str] = None, progress: int = 0
    ):
        """汇报任务进度"""
        return await self._call_tool("update_task_status", {
            "task_id": task_id, "agent_id": self.agent_id,
            "status": status, "result": result, "progress": progress,
        })

    async def get_task_status(self, task_id: str):
        """查询任务状态"""
        return await self._call_tool("get_task_status", {"task_id": task_id})

    async def get_online_agents(self) -> list:
        """查询在线 Agent 列表"""
        result = await self._call_tool("get_online_agents", {})
        if isinstance(result, dict):
            return result.get("online_agents", [])
        return result if isinstance(result, list) else []

    async def broadcast(self, agent_ids: list, content: str, metadata: Optional[dict] = None):
        """广播消息"""
        return await self._call_tool("broadcast_message", {
            "from": self.agent_id, "agent_ids": agent_ids,
            "content": content, "metadata": metadata,
        })
