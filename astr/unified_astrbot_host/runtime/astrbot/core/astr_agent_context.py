"""astrbot.core.astr_agent_context —— 工具执行时能看到的一切。

LivingMemory 的工具从这里取 `context.context.event`，再由 event 推出
`unified_msg_origin` / 发送者 / 群号，最后决定这次回忆的 memory scope
（见 core/memory_scope.py 的 resolve_memory_scope）。所以 `event` 必须是
真的 AstrMessageEvent，不能是占位对象。
"""

from __future__ import annotations

from typing import Any

from pydantic import Field
from pydantic.dataclasses import dataclass

from astrbot.core.agent.run_context import ContextWrapper


@dataclass
class AstrAgentContext:
    __pydantic_config__ = {"arbitrary_types_allowed": True}

    context: Any = None
    """Star Context 实例（宿主里就是那唯一一份）"""
    event: Any = None
    """触发本次工具调用的消息事件"""
    extra: dict[str, str] = Field(default_factory=dict)


AgentContextWrapper = ContextWrapper[AstrAgentContext]

__all__ = ["AgentContextWrapper", "AstrAgentContext"]
