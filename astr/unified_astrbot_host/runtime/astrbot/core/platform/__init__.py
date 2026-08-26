"""astrbot.core.platform —— 平台层再导出。"""

from .astr_message_event import AstrMessageEvent, SendHook
from .astrbot_message import (
    AstrBotMessage,
    Group,
    MessageMember,
    MessageSession,
    Platform,
    PlatformMetadata,
)
from .message_type import MessageType


def register_platform_adapter(*args, **kwargs):
    """宿主不接平台适配器：消息一律由 Bridge v2 经 /api/v1/events 送进来。"""

    def decorator(cls):
        return cls

    return decorator


__all__ = [
    "AstrBotMessage",
    "AstrMessageEvent",
    "Group",
    "MessageMember",
    "MessageSession",
    "MessageType",
    "Platform",
    "PlatformMetadata",
    "SendHook",
    "register_platform_adapter",
]
