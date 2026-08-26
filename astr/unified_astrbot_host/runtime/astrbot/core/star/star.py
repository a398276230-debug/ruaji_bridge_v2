"""astrbot.core.star.star —— 插件元数据与全局注册表。

`star_map` 的 key 是**模块路径**（`cls.__module__`），不是插件名。这一点要照抄，
因为 SelfLearning 的 FeatureDelegation 会用 `module_path` 去匹配插件；
用插件名做 key 会让它的 `module_path.split(".")` 匹配分支失效。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

#: 模块路径 -> StarMetadata
star_map: dict[str, "StarMetadata"] = {}
#: 按注册顺序排列的全部插件
star_registry: list["StarMetadata"] = []


@dataclass
class StarMetadata:
    name: str | None = None
    author: str | None = None
    desc: str | None = None
    short_desc: str | None = None
    version: str | None = None
    repo: str | None = None

    star_cls_type: type | None = None
    module_path: str | None = None
    star_cls: Any = None
    module: ModuleType | None = None
    root_dir_name: str | None = None
    reserved: bool = False
    activated: bool = True
    config: Any = None
    star_handler_full_names: list[str] = field(default_factory=list)
    display_name: str | None = None
    logo_path: str | None = None
    support_platforms: list[str] = field(default_factory=list)
    astrbot_version: str | None = None
    i18n: dict[str, dict] = field(default_factory=dict)
    pages: list[dict] = field(default_factory=list)

    @property
    def plugin_id(self) -> str:
        return (self.name or "unknown").lower().replace("/", "_")

    def __str__(self) -> str:
        return f"StarMetadata(name={self.name!r}, module_path={self.module_path!r}, activated={self.activated})"


class Star:
    """插件基类。三个插件都继承它。"""

    def __init__(self, context: Any = None) -> None:
        self.context = context

    async def initialize(self) -> None:
        """插件异步初始化。宿主在注册完所有插件后统一调用。"""
        return None

    async def terminate(self) -> None:
        """插件卸载。宿主关闭时统一调用。"""
        return None


def clear_registry() -> None:
    """测试用：把全局注册表清空，避免用例之间互相污染。"""
    star_map.clear()
    star_registry.clear()


__all__ = ["Star", "StarMetadata", "clear_registry", "star_map", "star_registry"]
