"""astrbot.core.star.star_handler —— Handler 注册表。

插件用 `@filter.on_llm_request()` 这类装饰器声明"我要处理某类事件"。装饰器在
**导入期**就把 handler 登记到这里的全局注册表，宿主随后按事件类型取出来调用。

与真实 AstrBot 的一致点：
    - key 是 `f"{handler.__module__}_{handler.__name__}"`
    - `handler_module_path` 用来把 handler 归属到某个 Star
    - 按 `extras_configs["priority"]` 降序排

不一致的地方（也是刻意的）：真框架的 filter 参与 WakingStage 的复杂判定，
垫片只保留 `filter_event()` 这个最小语义 —— 宿主分发事件时问一句
"这个 handler 要不要处理这条消息"。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any

from .star import star_map


class EventType(enum.Enum):
    OnAstrBotLoadedEvent = enum.auto()
    OnPlatformLoadedEvent = enum.auto()
    AdapterMessageEvent = enum.auto()
    OnWaitingLLMRequestEvent = enum.auto()
    OnLLMRequestEvent = enum.auto()
    OnLLMResponseEvent = enum.auto()
    OnAgentBeginEvent = enum.auto()
    OnAgentDoneEvent = enum.auto()
    OnDecoratingResultEvent = enum.auto()
    OnCallingFuncToolEvent = enum.auto()
    OnUsingLLMToolEvent = enum.auto()
    OnLLMToolRespondEvent = enum.auto()
    OnAfterMessageSentEvent = enum.auto()
    OnPluginErrorEvent = enum.auto()
    OnPluginLoadedEvent = enum.auto()
    OnPluginUnloadedEvent = enum.auto()


class HandlerFilter:
    """事件过滤器基类。默认放行。"""

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        return True


@dataclass
class StarHandlerMetadata:
    event_type: EventType
    handler_full_name: str
    handler_name: str
    handler_module_path: str
    handler: Any
    event_filters: list[HandlerFilter] = field(default_factory=list)
    desc: str = ""
    extras_configs: dict = field(default_factory=dict)
    enabled: bool = True

    def filter_event(self, event: Any) -> bool:
        """所有 filter 都放行才算命中。兼容单参数与双参数 filter。"""
        for handler_filter in self.event_filters:
            try:
                try:
                    res = handler_filter.filter(event)
                except TypeError:
                    res = handler_filter.filter(event, None)
                if not res:
                    return False
            except Exception:  # noqa: BLE001
                return False
        return True

    @property
    def star(self) -> Any:
        return star_map.get(self.handler_module_path)

    def __lt__(self, other: "StarHandlerMetadata") -> bool:
        return self.extras_configs.get("priority", 0) < other.extras_configs.get("priority", 0)


class StarHandlerRegistry:
    def __init__(self) -> None:
        self.star_handlers_map: dict[str, StarHandlerMetadata] = {}
        self._handlers: list[StarHandlerMetadata] = []

    def append(self, handler: StarHandlerMetadata) -> None:
        handler.extras_configs.setdefault("priority", 0)
        if handler.handler_full_name in self.star_handlers_map:
            # 重复注册通常是模块被 import 了两次。覆盖而不是追加，
            # 否则同一个 handler 会对同一条消息跑两遍。
            old = self.star_handlers_map[handler.handler_full_name]
            if old in self._handlers:
                self._handlers.remove(old)
        self.star_handlers_map[handler.handler_full_name] = handler
        self._handlers.append(handler)
        self._handlers.sort(key=lambda h: -h.extras_configs["priority"])

    def get_handlers_by_event_type(
        self,
        event_type: EventType,
        only_activated: bool = True,
        plugins_name: list[str] | None = None,
    ) -> list[StarHandlerMetadata]:
        out: list[StarHandlerMetadata] = []
        for handler in self._handlers:
            if handler.event_type is not event_type:
                continue
            if only_activated and not handler.enabled:
                continue
            star = star_map.get(handler.handler_module_path)
            if only_activated and star is not None and not star.activated:
                continue
            if plugins_name is not None:
                star_name = star.name if star else None
                if star_name not in plugins_name:
                    continue
            out.append(handler)
        return out

    def get_handler_by_full_name(self, full_name: str) -> StarHandlerMetadata | None:
        return self.star_handlers_map.get(full_name)

    def get_handlers_by_module_name(self, module_path: str) -> list[StarHandlerMetadata]:
        return [h for h in self._handlers if h.handler_module_path == module_path]

    def clear(self) -> None:
        self.star_handlers_map.clear()
        self._handlers.clear()

    def __iter__(self):
        return iter(self._handlers)

    def __len__(self) -> int:
        return len(self._handlers)


star_handlers_registry = StarHandlerRegistry()


def get_handler_or_create(
    awaitable: Any,
    event_type: EventType,
    **kwargs: Any,
) -> StarHandlerMetadata:
    """取或建一个 handler 元数据。

    同一个函数常常被多个装饰器叠加（`@filter.command(...)` +
    `@filter.permission_type(...)`），必须复用同一份元数据，
    否则后加的 filter 会挂到一个新对象上，前面那个 handler 就少了限制。
    """
    module_path = getattr(awaitable, "__module__", "")
    full_name = f"{module_path}_{awaitable.__name__}"

    existing = star_handlers_registry.get_handler_by_full_name(full_name)
    if existing is not None:
        existing.extras_configs.update(kwargs)
        return existing

    metadata = StarHandlerMetadata(
        event_type=event_type,
        handler_full_name=full_name,
        handler_name=awaitable.__name__,
        handler_module_path=module_path,
        handler=awaitable,
        event_filters=[],
        desc=(awaitable.__doc__ or "").strip(),
        extras_configs=dict(kwargs),
    )
    star_handlers_registry.append(metadata)
    return metadata


__all__ = [
    "EventType",
    "HandlerFilter",
    "StarHandlerMetadata",
    "StarHandlerRegistry",
    "get_handler_or_create",
    "star_handlers_registry",
]
