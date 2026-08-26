"""astrbot.core.platform.astrbot_message —— 平台无关的消息对象。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from astrbot.core.message.components import BaseMessageComponent

from .message_type import MessageType


@dataclass
class MessageMember:
    user_id: str
    nickname: str | None = None

    def __str__(self) -> str:
        return f"User ID: {self.user_id},Nickname: {self.nickname if self.nickname else 'N/A'}"


@dataclass
class Group:
    group_id: str
    group_name: str | None = None
    group_avatar: str | None = None
    group_owner: str | None = None
    group_admins: list[str] | None = None
    members: list[MessageMember] | None = None


@dataclass
class PlatformMetadata:
    name: str = "aiocqhttp"
    description: str = ""
    id: str = "aiocqhttp"
    default_config_tmpl: dict | None = None
    adapter_display_name: str | None = None


class AstrBotMessage:
    """一条平台消息。字段与上游同名同义，供插件直接读取。"""

    type: MessageType
    self_id: str
    session_id: str
    message_id: str
    group_id: str
    group: Group | None
    sender: MessageMember
    message: list[BaseMessageComponent]
    message_str: str
    raw_message: Any
    timestamp: int

    def __init__(self) -> None:
        self.timestamp = int(time.time())
        self.type = MessageType.FRIEND_MESSAGE
        self.self_id = ""
        self.session_id = ""
        self.message_id = ""
        self.group_id = ""
        self.group = None
        self.sender = MessageMember(user_id="", nickname="")
        self.message = []
        self.message_str = ""
        self.raw_message = None

    def __str__(self) -> str:
        return str(self.__dict__)


@dataclass
class MessageSession:
    """unified_msg_origin 的结构化形式：platform_name:message_type:session_id"""

    platform_name: str
    message_type: MessageType
    session_id: str

    def __str__(self) -> str:
        return f"{self.platform_name}:{self.message_type.value}:{self.session_id}"

    @staticmethod
    def from_str(origin: str) -> "MessageSession":
        parts = str(origin).split(":", 2)
        if len(parts) != 3:
            raise ValueError(f"非法的 unified_msg_origin: {origin!r}")
        return MessageSession(
            platform_name=parts[0],
            message_type=MessageType(parts[1]),
            session_id=parts[2],
        )


@dataclass
class Platform:
    """平台适配器的最小占位。宿主不接平台，消息一律由 Bridge v2 送进来。"""

    metadata: PlatformMetadata = field(default_factory=PlatformMetadata)

    def meta(self) -> PlatformMetadata:
        return self.metadata


__all__ = [
    "AstrBotMessage",
    "Group",
    "MessageMember",
    "MessageSession",
    "Platform",
    "PlatformMetadata",
]
