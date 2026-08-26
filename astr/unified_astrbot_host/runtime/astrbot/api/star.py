"""astrbot.api.star —— 插件基类与注册装饰器。"""

from astrbot.core.star.base import Star
from astrbot.core.star.config import AstrBotConfig
from astrbot.core.star.context import Context
from astrbot.core.star.register import register_star as register
from astrbot.core.star.star import StarMetadata
from astrbot.core.star.star_tools import StarTools

__all__ = [
    "AstrBotConfig",
    "Context",
    "Star",
    "StarMetadata",
    "StarTools",
    "register",
]
