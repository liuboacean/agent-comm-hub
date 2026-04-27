#!/usr/bin/env python3
"""
Agent ↔ Hub 通信桥示例

演示如何用 Python SDK 实现：
  - 发送消息给指定 Agent
  - 查询消息历史
  - 查看在线 Agent 列表
  - 查看 Hub 健康状态

用法：
  python3 agent_bridge.py send <agent> <message>
  python3 agent_bridge.py messages [--to agent] [--limit N]
  python3 agent_bridge.py agents
  python3 agent_bridge.py status
  python3 agent_bridge.py memory <content> [--scope private|team|global]
"""

import json
import os
import sys
import argparse

# SDK 路径（安装 Hub 后调整）
SDK_PATH = os.path.expanduser("~/agent-comm-hub/client-sdk")
# 或者使用 Skill 目录中的 SDK
if not os.path.exists(SDK_PATH):
    SDK_PATH = os.path.expanduser("~/.workbuddy/skills/agent-comm-hub/client-sdk")

if SDK_PATH not in sys.path:
    sys.path.insert(0, SDK_PATH)

from hub_client import SynergyHubClient

# ── 配置（替换为你自己的 Agent 信息）─────────────────────────────────────

HUB_URL = os.environ.get("HUB_URL", "http://localhost:3100")
AGENT_TOKEN = os.environ.get("HUB_API_TOKEN", "your-api-token-here")
AGENT_ID = os.environ.get("HUB_AGENT_ID", "my-agent")

# ── 单例 Hub Client ─────────────────────────────────────────────────────

_hub = None

def get_hub():
    global _hub
    if _hub is None:
        _hub = SynergyHubClient(hub_url=HUB_URL, agent_id=AGENT_ID)
        _hub.set_token(AGENT_TOKEN)
        _hub.heartbeat()
    return _hub

# ── 命令实现 ─────────────────────────────────────────────────────────────

def cmd_send(args):
    """发送消息给指定 Agent"""
    hub = get_hub()
    result = hub.send_message(to=args.agent, content=args.message)
    print(f"✅ 消息已发送到 {args.agent}")
    print(f"   Message ID: {result.get('message_id', 'N/A')}")

def cmd_messages(args):
    """查询消息历史"""
    hub = get_hub()
    params = {"limit": args.limit or 20}
    if args.to:
        params["agent_id"] = args.to
    result = hub._call_tool("search_messages", params)
    messages = result.get("messages", [])
    if not messages:
        print("📭 没有消息")
        return
    for msg in messages:
        direction = "→" if msg.get("from") == AGENT_ID else "←"
        sender = msg.get("from", "?")[:16]
        content = msg.get("content", "")[:80]
        print(f"  {direction} [{sender}] {content}")

def cmd_agents(args):
    """查看在线 Agent 列表"""
    hub = get_hub()
    agents = hub.get_online_agents()
    if not agents:
        print("📭 没有在线 Agent")
        return
    print(f"🟢 在线 Agent ({len(agents)}):")
    for agent_id in agents:
        print(f"  • {agent_id}")

def cmd_status(args):
    """查看 Hub 健康状态"""
    import urllib.request
    try:
        resp = urllib.request.urlopen(f"{HUB_URL}/health")
        data = json.loads(resp.read())
        print(f"🟢 Hub 状态: {data.get('status')}")
        print(f"   版本: {data.get('version')}")
        print(f"   运行时间: {data.get('uptime', 0):.0f}s")
        print(f"   DB 表数: {data.get('db', {}).get('tables', '?')}")
        print(f"   SSE 连接: {data.get('sse', {}).get('active_connections', 0)}")
    except Exception as e:
        print(f"🔴 Hub 不可达: {e}")

def cmd_memory(args):
    """存储记忆"""
    hub = get_hub()
    scope = args.scope or "private"
    hub.store_memory(content=args.content, scope=scope)
    print(f"✅ 记忆已存储 (scope={scope})")

# ── CLI ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Agent ↔ Hub 通信桥")
    sub = parser.add_subparsers(dest="command")

    # send
    p_send = sub.add_parser("send", help="发送消息")
    p_send.add_argument("agent", help="目标 Agent ID")
    p_send.add_argument("message", help="消息内容")

    # messages
    p_msg = sub.add_parser("messages", help="查询消息")
    p_msg.add_argument("--to", help="筛选发送方/接收方")
    p_msg.add_argument("--limit", type=int, help="返回数量")

    # agents
    sub.add_parser("agents", help="在线 Agent 列表")

    # status
    sub.add_parser("status", help="Hub 健康状态")

    # memory
    p_mem = sub.add_parser("memory", help="存储记忆")
    p_mem.add_argument("content", help="记忆内容")
    p_mem.add_argument("--scope", choices=["private", "team", "global"])

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    {
        "send": cmd_send,
        "messages": cmd_messages,
        "agents": cmd_agents,
        "status": cmd_status,
        "memory": cmd_memory,
    }[args.command](args)

if __name__ == "__main__":
    main()
