"""astrbot.core.star.filter —— 事件过滤器。

三个插件用到的四种：
    EventMessageType    群聊 / 私聊 / 全部
    PermissionType      admin / member
    PlatformAdapterType 平台类型（宿主里恒为 aiocqhttp）
    CommandFilter       /xxx 指令

真框架里这些 filter 参与 WakingStage 的多级判定；垫片只保留
"这个 handler 该不该处理这条事件" 这一个语义。
"""

from __future__ import annotations

import enum
import re
from typing import Any

from astrbot.core.platform.message_type import MessageType

from ..star_handler import HandlerFilter


class EventMessageType(enum.Flag):
    GROUP_MESSAGE = enum.auto()
    PRIVATE_MESSAGE = enum.auto()
    ALL = GROUP_MESSAGE | PRIVATE_MESSAGE


class EventMessageTypeFilter(HandlerFilter):
    def __init__(self, event_message_type: EventMessageType) -> None:
        self.event_message_type = event_message_type

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        if self.event_message_type == EventMessageType.ALL:
            return True
        message_type = event.get_message_type()
        if message_type == MessageType.GROUP_MESSAGE:
            return bool(self.event_message_type & EventMessageType.GROUP_MESSAGE)
        return bool(self.event_message_type & EventMessageType.PRIVATE_MESSAGE)


class PermissionType(enum.Enum):
    ADMIN = "admin"
    MEMBER = "member"
    # 旧垫片里出现过的别名，保留以免插件里某条分支拿不到
    USER = "member"
    ALL = "all"


class PermissionTypeFilter(HandlerFilter):
    def __init__(self, permission_type: PermissionType, raise_error: bool = True) -> None:
        self.permission_type = permission_type
        self.raise_error = raise_error

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        if self.permission_type in (PermissionType.MEMBER, PermissionType.ALL):
            return True
        return bool(getattr(event, "role", "member") == "admin")


class PlatformAdapterType(enum.Flag):
    AIOCQHTTP = enum.auto()
    QQOFFICIAL = enum.auto()
    GEWECHAT = enum.auto()
    ALL = AIOCQHTTP | QQOFFICIAL | GEWECHAT


class PlatformAdapterTypeFilter(HandlerFilter):
    def __init__(self, platform_adapter_type: PlatformAdapterType) -> None:
        self.platform_adapter_type = platform_adapter_type

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        # 宿主只接 Bridge v2 送来的 QQ 消息，平台恒为 aiocqhttp
        return True


class CommandFilter(HandlerFilter):
    def __init__(
        self,
        command_name: str,
        alias: set[str] | None = None,
        handler_md: Any = None,
        parent_command_names: list[str] | None = None,
    ) -> None:
        self.command_name = command_name
        self.alias = alias or set()
        self.handler_md = handler_md
        self.parent_command_names = parent_command_names or [""]

    def init_handler_md(self, handler_md: Any) -> None:
        self.handler_md = handler_md

    def get_complete_command_names(self) -> list[str]:
        return [f"{parent} {self.command_name}".strip() for parent in self.parent_command_names]

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        text = (event.get_message_str() or "").strip()
        if not text:
            return False
        for name in [self.command_name, *self.alias]:
            for full in [f"{parent} {name}".strip() for parent in self.parent_command_names]:
                if re.match(rf"^/?{re.escape(full)}(\s|$)", text):
                    return True
        return False


class RegexFilter(HandlerFilter):
    def __init__(self, pattern: str | re.Pattern) -> None:
        self.pattern = re.compile(pattern) if isinstance(pattern, str) else pattern

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        return bool(self.pattern.search(event.get_message_str() or ""))


class CustomFilter(HandlerFilter):
    """插件自定义 filter 的基类。LivingMemory 用它做群聊被动采集的开关。

    构造签名要收 `raise_error` 与任意 kwargs —— LivingMemory 的
    PassiveGroupCaptureFilter 会 `super().__init__(raise_error=..., **kwargs)`，
    基类不收就直接落到 object.__init__ 上 TypeError，插件在导入期就挂。
    """

    def __init__(self, raise_error: bool = True, **kwargs: Any) -> None:
        self.raise_error = raise_error
        self.extras = kwargs

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        return True


class CustomFilterWrapper(HandlerFilter):
    def __init__(self, custom_filter: Any) -> None:
        self.custom_filter = custom_filter() if isinstance(custom_filter, type) else custom_filter

    def filter(self, event: Any, cfg: Any = None) -> bool:
        return bool(self.custom_filter.filter(event, cfg))


class CommandGroupFilter(HandlerFilter):
    """指令组，例如 `/lmem search xxx` 里的 `lmem`。

    组可以嵌套，所以 `get_complete_command_names()` 要把父组的名字拼上去 ——
    LivingMemory 的 `/lmem graph rebuild` 就是两层。
    """

    def __init__(
        self,
        group_name: str,
        alias: set[str] | None = None,
        parent_group: "CommandGroupFilter | None" = None,
    ) -> None:
        self.group_name = group_name
        self.alias = alias or set()
        self.parent_group = parent_group
        self.sub_command_filters: list[HandlerFilter] = []

    def add_sub_command_filter(self, command_filter: HandlerFilter) -> None:
        self.sub_command_filters.append(command_filter)

    def get_complete_command_names(self) -> list[str]:
        own = [self.group_name, *sorted(self.alias)]
        if self.parent_group is None:
            return own
        return [
            f"{parent} {name}".strip()
            for parent in self.parent_group.get_complete_command_names()
            for name in own
        ]

    def filter(self, event: Any, cfg: Any = None) -> bool:  # noqa: ARG002
        text = (event.get_message_str() or "").strip()
        if not text:
            return False
        return any(
            re.match(rf"^/?{re.escape(full)}(\s|$)", text)
            for full in self.get_complete_command_names()
        )


class RegisteringCommandable:
    """`@filter.command_group("x")` 装饰后留在类属性上的那个对象。

    上游的 command_group 装饰器**会把被装饰的方法替换掉**，换成这个对象，
    于是插件才能接着写 `@lmem.command("search")` 挂子指令。所以它必须
    自身可调用地暴露 command / group 两个方法，而不是把原函数还回去。
    """

    def __init__(self, parent_group: Any = None) -> None:
        self.parent_group = parent_group

    def command(self, sub_command: str, alias: set[str] | None = None, **kwargs: Any):
        from astrbot.core.star.register import register_command

        return register_command(self, sub_command=sub_command, alias=alias, **kwargs)

    def group(self, sub_group: str, alias: set[str] | None = None, **kwargs: Any):
        from astrbot.core.star.register import register_command_group

        return register_command_group(self, sub_command=sub_group, alias=alias, **kwargs)

    # 上游别名
    command_group = group


__all__ = [
    "CommandFilter",
    "CommandGroupFilter",
    "CustomFilter",
    "CustomFilterWrapper",
    "EventMessageType",
    "EventMessageTypeFilter",
    "HandlerFilter",
    "PermissionType",
    "PermissionTypeFilter",
    "PlatformAdapterType",
    "PlatformAdapterTypeFilter",
    "RegexFilter",
    "RegisteringCommandable",
]
