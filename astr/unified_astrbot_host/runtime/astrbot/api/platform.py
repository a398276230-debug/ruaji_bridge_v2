"""astrbot.api.platform —— 平台侧类型。"""

from astrbot.core.platform import (
    AstrBotMessage,
    AstrMessageEvent,
    Group,
    MessageMember,
    MessageSession,
    MessageType,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)

__all__ = [
    "AstrBotMessage",
    "AstrMessageEvent",
    "Group",
    "MessageMember",
    "MessageSession",
    "MessageType",
    "Platform",
    "PlatformMetadata",
    "register_platform_adapter",
]
