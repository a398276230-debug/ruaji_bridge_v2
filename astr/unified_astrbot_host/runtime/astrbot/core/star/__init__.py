"""astrbot.core.star —— 插件层再导出。"""

from astrbot.core.provider import Provider

from .base import Star
from .config import AstrBotConfig
from .context import Context, FunctionToolManager
from .star import StarMetadata, clear_registry, star_map, star_registry
from .star_handler import EventType, StarHandlerMetadata, star_handlers_registry
from .star_tools import StarTools


class PluginManager:
    """上游的插件加载器。宿主自己装配插件，这里只留个可导入的名字。"""

    def __init__(self, context: Context | None = None) -> None:
        self.context = context

    def get_all_stars(self) -> list[StarMetadata]:
        return list(star_registry)


__all__ = [
    "AstrBotConfig",
    "Context",
    "EventType",
    "FunctionToolManager",
    "PluginManager",
    "Provider",
    "Star",
    "StarHandlerMetadata",
    "StarMetadata",
    "StarTools",
    "clear_registry",
    "star_handlers_registry",
    "star_map",
    "star_registry",
]
