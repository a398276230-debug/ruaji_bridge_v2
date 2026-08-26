"""aiocqhttp 适配器占位。

GCP 只在两处用到它：类型标注，以及从 `platform.bot` 取 OneBot 客户端。
宿主不接协议端，所以 bot 恒为 None，GCP 的调用点会走它自己的降级分支。
"""

from __future__ import annotations

from typing import Any

from astrbot.core.platform.astrbot_message import Platform, PlatformMetadata


class AiocqhttpAdapter(Platform):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(metadata=PlatformMetadata(name="aiocqhttp", id="aiocqhttp"))
        self.bot = None


#: 上游的另一个导出名
AiocqhttpPlatformAdapter = AiocqhttpAdapter

__all__ = ["AiocqhttpAdapter", "AiocqhttpPlatformAdapter"]
