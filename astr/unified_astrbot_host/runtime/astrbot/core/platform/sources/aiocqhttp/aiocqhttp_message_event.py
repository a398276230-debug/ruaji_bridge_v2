"""aiocqhttp 平台的消息事件。

GCP 会 `isinstance(event, AiocqhttpMessageEvent)` 来判断"能不能调 OneBot 原生
API"（发合并转发、拿群成员列表等）。宿主里这类调用没有真实通道，所以这里
让它继承垫片的 AstrMessageEvent，并把 bot 属性留空 —— GCP 侧对 bot 为空
都有 try/except 兜底，取不到就走降级路径。
"""

from __future__ import annotations

from typing import Any

from astrbot.core.platform.astr_message_event import AstrMessageEvent


class AiocqhttpMessageEvent(AstrMessageEvent):
    def __init__(self, *args: Any, bot: Any = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.bot = bot


__all__ = ["AiocqhttpMessageEvent"]
