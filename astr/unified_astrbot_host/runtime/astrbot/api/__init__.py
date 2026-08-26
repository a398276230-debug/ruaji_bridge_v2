"""astrbot.api —— 插件应当使用的稳定接口面。

插件里 242 处 `from astrbot.api import ...`，实际只取三样：logger / sp / AstrBotConfig。
其余按上游把常用类型也暴露出来。
"""

from astrbot.core import astrbot_config, html_renderer, logger, sp
from astrbot.core.star.config import AstrBotConfig

__all__ = [
    "AstrBotConfig",
    "astrbot_config",
    "html_renderer",
    "logger",
    "sp",
]
