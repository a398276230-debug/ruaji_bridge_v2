"""astrbot.api.event —— 事件与结果。"""

from astrbot.api.event import filter  # noqa: A004  上游就叫这个名字
from astrbot.core.message.message_event_result import (
    CommandResult,
    EventResultType,
    MessageChain,
    MessageEventResult,
    ResultContentType,
)
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.astrbot_message import MessageSession

# 上游把这个名字拼错成 MessageSesion 且沿用至今，两个名字都给出
MessageSesion = MessageSession

__all__ = [
    "AstrMessageEvent",
    "CommandResult",
    "EventResultType",
    "MessageChain",
    "MessageEventResult",
    "MessageSesion",
    "MessageSession",
    "ResultContentType",
    "filter",
]
