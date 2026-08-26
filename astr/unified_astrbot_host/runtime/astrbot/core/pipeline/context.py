"""astrbot.core.pipeline.context —— 管线上下文。

GCP 里有 `import astrbot.core.pipeline.context`（main.py 顶部），历史上是
为了 monkey-patch `call_event_hook`；现在它自己注释掉了那条路（main.py:113
"保留占位，已不再使用 monkey-patch"），但 import 语句还在，模块必须存在。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from astrbot.core.pipeline.context_utils import call_event_hook, call_handler


@dataclass
class PipelineContext:
    """一条消息在管线里流动时携带的东西。"""

    astrbot_config: dict[str, Any] = field(default_factory=dict)
    plugin_manager: Any = None
    call_event_hook: Any = staticmethod(call_event_hook)


__all__ = ["PipelineContext", "call_event_hook", "call_handler"]
