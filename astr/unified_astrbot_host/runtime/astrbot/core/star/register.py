"""astrbot.core.star.register —— 插件装饰器。

这些装饰器在**导入期**执行：`import astrbot_plugin_livingmemory.main` 的那一刻，
类上所有 `@filter.xxx` 就已经把 handler 登记进 star_handlers_registry 了。
宿主随后只需按事件类型取出来调。

所有装饰器都返回原函数（而不是包装后的函数）——插件里存在
`self.on_message` 这样的直接调用，包一层会让 self 绑定错乱。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from astrbot.core import logger

from .filter import (
    CommandFilter,
    CommandGroupFilter,
    CustomFilterWrapper,
    EventMessageType,
    EventMessageTypeFilter,
    PermissionType,
    PermissionTypeFilter,
    PlatformAdapterType,
    PlatformAdapterTypeFilter,
    RegexFilter,
    RegisteringCommandable,
)
from .star import StarMetadata, star_map, star_registry
from .star_handler import EventType, get_handler_or_create

_PY_TO_JSON_TYPE = {
    "str": "string",
    "string": "string",
    "int": "number",
    "float": "number",
    "number": "number",
    "bool": "boolean",
    "boolean": "boolean",
    "list": "array",
    "array": "array",
    "dict": "object",
    "object": "object",
}

#: 全局 LLM 工具表：工具名 -> {handler, schema}
llm_tools: dict[str, dict[str, Any]] = {}


# ======================================================================
# 插件注册
# ======================================================================


def register_star(
    name: str,
    author: str,
    desc: str,
    version: str,
    repo: str | None = None,
):
    def decorator(cls):
        module_path = cls.__module__
        metadata = star_map.get(module_path)
        if metadata is None:
            metadata = StarMetadata(module_path=module_path)
            star_map[module_path] = metadata
            star_registry.append(metadata)
        metadata.name = name
        metadata.author = author
        metadata.desc = desc
        metadata.short_desc = (desc or "").split("\n")[0][:80]
        metadata.version = version
        metadata.repo = repo
        metadata.display_name = metadata.display_name or name
        metadata.star_cls_type = cls
        metadata.module_path = module_path
        # root_dir_name 是 FeatureDelegation 匹配插件时看的字段之一，
        # 取模块路径的第一段（astrbot_plugin_livingmemory.main → astrbot_plugin_livingmemory）
        metadata.root_dir_name = metadata.root_dir_name or module_path.split(".")[0]
        return cls

    return decorator


# ======================================================================
# 事件钩子
# ======================================================================


def _event_decorator(event_type: EventType):
    def outer(**kwargs: Any):
        def decorator(awaitable):
            get_handler_or_create(awaitable, event_type, **kwargs)
            return awaitable

        return decorator

    return outer


register_on_astrbot_loaded = _event_decorator(EventType.OnAstrBotLoadedEvent)
register_on_platform_loaded = _event_decorator(EventType.OnPlatformLoadedEvent)
register_on_plugin_error = _event_decorator(EventType.OnPluginErrorEvent)
register_on_plugin_loaded = _event_decorator(EventType.OnPluginLoadedEvent)
register_on_plugin_unloaded = _event_decorator(EventType.OnPluginUnloadedEvent)
register_on_waiting_llm_request = _event_decorator(EventType.OnWaitingLLMRequestEvent)
register_on_llm_request = _event_decorator(EventType.OnLLMRequestEvent)
register_on_llm_response = _event_decorator(EventType.OnLLMResponseEvent)
register_on_agent_begin = _event_decorator(EventType.OnAgentBeginEvent)
register_on_agent_done = _event_decorator(EventType.OnAgentDoneEvent)
register_on_using_llm_tool = _event_decorator(EventType.OnUsingLLMToolEvent)
register_on_llm_tool_respond = _event_decorator(EventType.OnLLMToolRespondEvent)
register_on_decorating_result = _event_decorator(EventType.OnDecoratingResultEvent)
register_after_message_sent = _event_decorator(EventType.OnAfterMessageSentEvent)


# ======================================================================
# 消息过滤器
# ======================================================================


def register_event_message_type(event_message_type: EventMessageType, **kwargs: Any):
    def decorator(awaitable):
        handler_md = get_handler_or_create(awaitable, EventType.AdapterMessageEvent, **kwargs)
        handler_md.event_filters.append(EventMessageTypeFilter(event_message_type))
        return awaitable

    return decorator


def register_platform_adapter_type(platform_adapter_type: PlatformAdapterType, **kwargs: Any):
    def decorator(awaitable):
        handler_md = get_handler_or_create(awaitable, EventType.AdapterMessageEvent, **kwargs)
        handler_md.event_filters.append(PlatformAdapterTypeFilter(platform_adapter_type))
        return awaitable

    return decorator


def register_permission_type(permission_type: PermissionType, raise_error: bool = True, **kwargs: Any):
    def decorator(awaitable):
        handler_md = get_handler_or_create(awaitable, EventType.AdapterMessageEvent, **kwargs)
        handler_md.event_filters.append(PermissionTypeFilter(permission_type, raise_error))
        return awaitable

    return decorator


def register_regex(regex: str | re.Pattern, **kwargs: Any):
    def decorator(awaitable):
        handler_md = get_handler_or_create(awaitable, EventType.AdapterMessageEvent, **kwargs)
        handler_md.event_filters.append(RegexFilter(regex))
        return awaitable

    return decorator


def register_custom_filter(custom_type_filter: Any, *args: Any, **kwargs: Any):
    def decorator(awaitable):
        handler_md = get_handler_or_create(awaitable, EventType.AdapterMessageEvent, **kwargs)
        handler_md.event_filters.append(CustomFilterWrapper(custom_type_filter))
        return awaitable

    return decorator


def register_command(
    command_name: Any = None,
    sub_command: str | None = None,
    alias: set | None = None,
    **kwargs: Any,
):
    new_command = None
    add_to_event_filters = False

    if isinstance(command_name, RegisteringCommandable):
        if sub_command is not None:
            parents = command_name.parent_group.get_complete_command_names()
            new_command = CommandFilter(sub_command, alias, None, parent_command_names=parents)
            command_name.parent_group.add_sub_command_filter(new_command)
    elif command_name is None:
        logger.warning("注册裸指令时没有给 command_name，已忽略")
    else:
        new_command = CommandFilter(str(command_name), alias, None)
        add_to_event_filters = True

    def decorator(awaitable):
        if not add_to_event_filters:
            kwargs["sub_command"] = True
        handler_md = get_handler_or_create(awaitable, EventType.AdapterMessageEvent, **kwargs)
        if new_command is not None:
            new_command.init_handler_md(handler_md)
            handler_md.event_filters.append(new_command)
        return awaitable

    return decorator


class _Unused:
    """占位，保留旧名字不再使用。"""


def register_command_group(
    command_group_name: Any = None,
    sub_command: str | None = None,
    alias: set | None = None,
    **kwargs: Any,
):
    """注册一个指令组。

    与其他装饰器不同，这个装饰器**不返回原函数** —— 它返回一个
    RegisteringCommandable，替换掉被装饰的方法。插件正是靠这个返回值继续挂
    子指令（`@lmem.command("search")`）。照上游实现，返回原函数会让
    `/lmem search` 整条指令树失效。
    """
    new_group: CommandGroupFilter | None = None

    if isinstance(command_group_name, RegisteringCommandable):
        # 子指令组
        if sub_command is None:
            logger.warning("为 %s 的子指令组注册时没给 sub_command", command_group_name)
        else:
            new_group = CommandGroupFilter(
                sub_command, alias, parent_group=command_group_name.parent_group
            )
            command_group_name.parent_group.add_sub_command_filter(new_group)
    elif command_group_name is None:
        logger.warning("注册根指令组时没有给名字，已忽略")
    else:
        new_group = CommandGroupFilter(str(command_group_name), alias)

    def decorator(obj):
        if new_group is None:
            raise ValueError("注册指令组失败：没有拿到组名")
        handler_md = get_handler_or_create(obj, EventType.AdapterMessageEvent, **kwargs)
        handler_md.event_filters.append(new_group)
        return RegisteringCommandable(new_group)

    return decorator


# ======================================================================
# LLM 工具
# ======================================================================

_ARG_LINE = re.compile(r"^\s*(\w+)\s*\(([^)]+)\)\s*:\s*(.*)$")


def parse_google_docstring(doc: str) -> tuple[str, list[dict[str, Any]]]:
    """从 Google 风格 docstring 里提取描述与参数表。

    真 AstrBot 用 `docstring_parser` 这个第三方库。垫片不引依赖，
    自己解析 `Args:` 段 —— 只支持 `name(type): desc` 这一种写法，
    这也是 AstrBot 文档里唯一给出的写法。

    返回 (描述, [{name, type, description, required}])
    """
    lines = (doc or "").strip().split("\n")
    description_lines: list[str] = []
    args: list[dict[str, Any]] = []
    in_args = False

    for raw in lines:
        line = raw.strip()
        if line.lower() in ("args:", "arguments:", "parameters:"):
            in_args = True
            continue
        if in_args and line.lower() in ("returns:", "return:", "raises:", "yields:"):
            in_args = False
            continue
        if not in_args:
            description_lines.append(line)
            continue

        match = _ARG_LINE.match(raw)
        if not match:
            continue
        name, type_name, desc = match.groups()
        base = type_name.strip().lower()
        sub = None
        bracket = re.match(r"(\w+)\[(\w+)\]", base)
        if bracket:
            base, sub = bracket.group(1), bracket.group(2)
        json_type = _PY_TO_JSON_TYPE.get(base, "string")
        entry: dict[str, Any] = {
            "name": name,
            "type": json_type,
            "description": desc.strip(),
            "required": "optional" not in desc.lower() and "可选" not in desc,
        }
        if sub:
            entry["items_type"] = _PY_TO_JSON_TYPE.get(sub, "string")
        args.append(entry)

    return "\n".join(description_lines).strip(), args


def register_llm_tool(name: str | None = None, **kwargs: Any):
    """注册一个函数调用工具。

    与上游的差别：不依赖 docstring_parser，参数缺类型注解时降级为 string
    并打一条 warning，而不是像上游那样直接抛 ValueError。
    抛异常会让整个插件在导入期就挂掉 —— 一个工具的注释写得不规范，
    不该让长期记忆整体不可用。
    """

    def decorator(awaitable):
        tool_name = name or awaitable.__name__
        description, args = parse_google_docstring(awaitable.__doc__ or "")

        properties: dict[str, Any] = {}
        required: list[str] = []
        for arg in args:
            schema: dict[str, Any] = {"type": arg["type"], "description": arg["description"]}
            if arg.get("items_type"):
                schema["items"] = {"type": arg["items_type"]}
            properties[arg["name"]] = schema
            if arg["required"]:
                required.append(arg["name"])

        if not description:
            logger.warning("LLM 工具 %s 缺少描述，模型可能不知道何时该调用它", tool_name)

        llm_tools[tool_name] = {
            "name": tool_name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
            "handler": awaitable,
            "handler_module_path": getattr(awaitable, "__module__", ""),
            "extras": kwargs,
        }
        get_handler_or_create(awaitable, EventType.OnCallingFuncToolEvent, **kwargs)
        return awaitable

    return decorator


def register_agent(*args: Any, **kwargs: Any):  # noqa: ARG001
    def decorator(cls):
        return cls

    return decorator


__all__ = [
    "llm_tools",
    "parse_google_docstring",
    "register_after_message_sent",
    "register_agent",
    "register_command",
    "register_command_group",
    "register_custom_filter",
    "register_event_message_type",
    "register_llm_tool",
    "register_on_agent_begin",
    "register_on_agent_done",
    "register_on_astrbot_loaded",
    "register_on_decorating_result",
    "register_on_llm_request",
    "register_on_llm_response",
    "register_on_llm_tool_respond",
    "register_on_platform_loaded",
    "register_on_plugin_error",
    "register_on_plugin_loaded",
    "register_on_plugin_unloaded",
    "register_on_using_llm_tool",
    "register_on_waiting_llm_request",
    "register_permission_type",
    "register_platform_adapter_type",
    "register_regex",
    "register_star",
]
