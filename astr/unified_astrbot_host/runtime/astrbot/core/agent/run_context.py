"""astrbot.core.agent.run_context —— 工具调用时传给 handler 的上下文包装。

LivingMemory 的两个工具签名都是 `async def call(self, context: ContextWrapper[AstrAgentContext], ...)`，
并且在体内取 `context.context.event`。所以这层必须是真泛型、真持有内层对象。

必须是 pydantic dataclass：`AstrAgentContext` 里放着 `Context` 和 `AstrMessageEvent`
这两个非 pydantic 类型，靠 `__pydantic_config__ = {"arbitrary_types_allowed": True}` 放行，
而那个开关只有 pydantic 认。
"""

from __future__ import annotations

from typing import Any, Generic

from pydantic import Field
from pydantic.dataclasses import dataclass
from typing_extensions import TypeVar  # PEP 696 的 default= 在 3.13 前只有它有

TContext = TypeVar("TContext", default=Any)


@dataclass
class ContextWrapper(Generic[TContext]):
    __pydantic_config__ = {"arbitrary_types_allowed": True}

    context: TContext
    messages: list[Any] = Field(default_factory=list)
    tool_call_timeout: int = 120


NoContext = ContextWrapper[None]

__all__ = ["ContextWrapper", "NoContext", "TContext"]
