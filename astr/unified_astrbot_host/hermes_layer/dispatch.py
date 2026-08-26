"""hermes_layer.dispatch —— 统一事件派发层与声明式派发表。

本模块是垫片 ↔ Hermes 行为对齐的核心：
1. 声明式定义 16 种 EventType 的数据源、派发模式、默认目标与支持级别。
2. 消除硬编码归属（_owner_of 动态从 mounts 的 spec.package 推导）。
3. 解决命令参数绑定（签名检查 + 参数类型转换 + 缺少必填参数回传用法而非 TypeError）。
4. 收集 yield 产出的 MessageEventResult 以及 event.get_result()，作为命令响应。
5. 统一异常处理与 OnPluginErrorEvent 合成，元数据提取置于 try 内部。
"""

from __future__ import annotations

import asyncio
import inspect
import re
import shlex
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncGenerator, Generator, Optional, get_args, get_origin

from astrbot.core import logger
from astrbot.core.message.components import Plain
from astrbot.core.message.message_event_result import MessageEventResult, ResultContentType
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.star.filter import CommandFilter, CommandGroupFilter
from astrbot.core.star.star_handler import EventType, StarHandlerMetadata, star_handlers_registry
from hermes_layer.contracts import InboundMessage


class SupportLevel(str, Enum):
    SUPPORTED = "supported"       # 核心做实，由真实 Hermes / Bridge 数据源触发
    SYNTHETIC = "synthetic"       # 宿主自身生命周期或运行时合成，无需外部桥接
    CAPABILITY = "capability"     # 需要结果，通过 CapabilityBus / HTTP 能力端点调用
    UNSUPPORTED = "unsupported"   # Hermes 无此概念（如 agent begin/done），显式报错/警告


@dataclass(frozen=True)
class EventDispatchSpec:
    event_type: EventType
    source: str
    level: SupportLevel
    default_targets: tuple[str, ...]
    description: str


#: 16 种 EventType 的全局声明式映射表
DISPATCH_TABLE: dict[EventType, EventDispatchSpec] = {
    EventType.AdapterMessageEvent: EventDispatchSpec(
        event_type=EventType.AdapterMessageEvent,
        source="message.received",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory", "self_learning", "group_chat_plus"),
        description="收到的群聊/私聊消息事件",
    ),
    EventType.OnWaitingLLMRequestEvent: EventDispatchSpec(
        event_type=EventType.OnWaitingLLMRequestEvent,
        source="/api/v1/context/enrich (pre-enrich)",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory", "self_learning", "group_chat_plus"),
        description="LLM 请求准备阶段（在上下文组装前触发）",
    ),
    EventType.OnLLMRequestEvent: EventDispatchSpec(
        event_type=EventType.OnLLMRequestEvent,
        source="/api/v1/context/enrich (stages)",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory", "self_learning", "group_chat_plus"),
        description="LLM 请求阶段，用于注入提示词与上下文块",
    ),
    EventType.OnLLMResponseEvent: EventDispatchSpec(
        event_type=EventType.OnLLMResponseEvent,
        source="llm.response",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory",),
        description="LLM 回复生成完成事件，用于记忆提取与反思",
    ),
    EventType.OnDecoratingResultEvent: EventDispatchSpec(
        event_type=EventType.OnDecoratingResultEvent,
        source="/api/v1/result/decorate (capability: result.decorate)",
        level=SupportLevel.CAPABILITY,
        default_targets=("group_chat_plus", "living_memory", "self_learning"),
        description="回复修饰能力，用于在发送前过滤/变换文本与表情",
    ),
    EventType.OnCallingFuncToolEvent: EventDispatchSpec(
        event_type=EventType.OnCallingFuncToolEvent,
        source="/api/v1/tools/call (pre)",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory", "self_learning", "group_chat_plus"),
        description="函数工具调用前置钩子",
    ),
    EventType.OnUsingLLMToolEvent: EventDispatchSpec(
        event_type=EventType.OnUsingLLMToolEvent,
        source="/api/v1/tools/call (invoking)",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory", "self_learning", "group_chat_plus"),
        description="LLM 工具使用中钩子",
    ),
    EventType.OnLLMToolRespondEvent: EventDispatchSpec(
        event_type=EventType.OnLLMToolRespondEvent,
        source="/api/v1/tools/call (post)",
        level=SupportLevel.SUPPORTED,
        default_targets=("living_memory", "self_learning", "group_chat_plus"),
        description="LLM 工具响应后置钩子",
    ),
    EventType.OnAfterMessageSentEvent: EventDispatchSpec(
        event_type=EventType.OnAfterMessageSentEvent,
        source="message.sent",
        level=SupportLevel.SUPPORTED,
        default_targets=("group_chat_plus", "living_memory", "self_learning"),
        description="消息已实际投递事件",
    ),
    EventType.OnAstrBotLoadedEvent: EventDispatchSpec(
        event_type=EventType.OnAstrBotLoadedEvent,
        source="runtime.context (post_initialize)",
        level=SupportLevel.SYNTHETIC,
        default_targets=("all",),
        description="宿主所有插件初始化完成",
    ),
    EventType.OnPlatformLoadedEvent: EventDispatchSpec(
        event_type=EventType.OnPlatformLoadedEvent,
        source="runtime.context (platform_loaded)",
        level=SupportLevel.SYNTHETIC,
        default_targets=("all",),
        description="平台适配器装配完成（aiocqhttp 恒定）",
    ),
    EventType.OnPluginLoadedEvent: EventDispatchSpec(
        event_type=EventType.OnPluginLoadedEvent,
        source="runtime.context (plugin_mounted)",
        level=SupportLevel.SYNTHETIC,
        default_targets=("all",),
        description="单插件挂载完成",
    ),
    EventType.OnPluginUnloadedEvent: EventDispatchSpec(
        event_type=EventType.OnPluginUnloadedEvent,
        source="runtime.context (plugin_unloading)",
        level=SupportLevel.SYNTHETIC,
        default_targets=("all",),
        description="单插件卸载开始",
    ),
    EventType.OnPluginErrorEvent: EventDispatchSpec(
        event_type=EventType.OnPluginErrorEvent,
        source="dispatch (_run_handlers error)",
        level=SupportLevel.SYNTHETIC,
        default_targets=("all",),
        description="插件处理器执行异常事件",
    ),
    EventType.OnAgentBeginEvent: EventDispatchSpec(
        event_type=EventType.OnAgentBeginEvent,
        source="none",
        level=SupportLevel.UNSUPPORTED,
        default_targets=(),
        description="Agent 轮次开始（Hermes 跨进程独立架构不支持）",
    ),
    EventType.OnAgentDoneEvent: EventDispatchSpec(
        event_type=EventType.OnAgentDoneEvent,
        source="none",
        level=SupportLevel.UNSUPPORTED,
        default_targets=(),
        description="Agent 轮次结束（Hermes 跨进程独立架构不支持）",
    ),
}

#: 兜底模块前缀映射（当 mounts 实例不可用时）
_FALLBACK_MODULE_PREFIX = {
    "living_memory": "astrbot_plugin_livingmemory",
    "self_learning": "astrbot_plugin_self_learning",
    "group_chat_plus": "astrbot_plugin_group_chat_plus",
}


def resolve_owner(handler: StarHandlerMetadata, mounts: dict[str, Any] | None = None) -> str | None:
    """动态推导 handler 归属于哪个插件 key。

    彻底去除硬编码字典，优先扫描 mounts 中每个插件的 spec.package。
    """
    mod = getattr(handler, "handler_module_path", "") or ""
    if not mod and getattr(handler, "handler", None):
        mod = getattr(handler.handler, "__module__", "") or ""

    if mounts:
        for key, mount in mounts.items():
            pkg = getattr(getattr(mount, "spec", None), "package", "")
            if pkg and (mod == pkg or mod.startswith(f"{pkg}.")):
                return key
            if mod == key or mod.startswith(f"{key}."):
                return key

    for key, prefix in _FALLBACK_MODULE_PREFIX.items():
        if mod == prefix or mod.startswith(f"{prefix}."):
            return key
        if mod == key or mod.startswith(f"{key}."):
            return key

    return None


def _parse_type_val(val_str: str, target_type: Any) -> Any:
    """根据类型注解转换参数字符串。"""
    if target_type is inspect.Parameter.empty or target_type is Any:
        return val_str

    origin = get_origin(target_type)
    if origin is Optional:
        args = get_args(target_type)
        target_type = next((a for a in args if a is not type(None)), str)
    elif origin is not None:
        args = get_args(target_type)
        if type(None) in args:
            target_type = next((a for a in args if a is not type(None)), str)

    if target_type is int:
        return int(val_str)
    if target_type is float:
        return float(val_str)
    if target_type is bool:
        return val_str.lower() in ("true", "1", "yes", "y", "t", "on")
    if target_type is str:
        return str(val_str)

    try:
        return target_type(val_str)
    except Exception:
        return val_str


def extract_command_args_and_bind(
    handler: StarHandlerMetadata,
    event: AstrMessageEvent,
) -> tuple[list[Any], dict[str, Any], Optional[MessageEventResult], bool]:
    """从消息文本中解析命令参数并完成参数绑定。

    返回 (bound_args, bound_kwargs, usage_or_error_result, needs_event)
    若缺少必填参数或类型转换失败，返回友好的 MessageEventResult 提示，避免 TypeError。
    """
    fn = getattr(handler, "handler", None)
    if fn is None:
        return [], {}, None, True

    try:
        sig = inspect.signature(fn)
    except Exception:
        return [], {}, None, True

    # 1. 寻找匹配的命令前缀
    msg_str = (event.get_message_str() or "").strip()
    cmd_names: list[str] = []
    for f in handler.event_filters:
        if isinstance(f, (CommandFilter, CommandGroupFilter)):
            cmd_names.extend(f.get_complete_command_names())

    matched_prefix = ""
    for name in cmd_names:
        for prefix in (f"/{name}", name):
            if msg_str == prefix or msg_str.startswith(f"{prefix} "):
                if len(prefix) > len(matched_prefix):
                    matched_prefix = prefix

    arg_str = msg_str[len(matched_prefix):].strip() if matched_prefix else ""

    # 2. 切分命令行 token
    tokens: list[str] = []
    if arg_str:
        try:
            tokens = shlex.split(arg_str)
        except Exception:
            tokens = arg_str.split()

    # 3. 分析函数签名中的参数
    params = list(sig.parameters.values())
    pos_params: list[inspect.Parameter] = []
    has_event_param = False

    for p in params:
        if p.name in ("self", "cls"):
            continue
        if not has_event_param and (p.name == "event" or p.annotation is AstrMessageEvent):
            has_event_param = True
            continue
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD):
            pos_params.append(p)

    # 若函数不接受 event 且没有额外位置参数（如 @filter.command_group 的占位函数），无需传 event
    if not has_event_param and not pos_params:
        return [], {}, None, False

    if not pos_params:
        return [], {}, None, has_event_param

    # 4. 检查必填参数与类型转换
    bound_args: list[Any] = []
    for i, p in enumerate(pos_params):
        if i < len(tokens):
            raw_val = tokens[i]
            try:
                converted = _parse_type_val(raw_val, p.annotation)
                bound_args.append(converted)
            except Exception as e:
                err_msg = f"命令参数错误: 参数 [{p.name}] 期望类型 {getattr(p.annotation, '__name__', str(p.annotation))}，输入为 '{raw_val}'"
                res = MessageEventResult()
                res.chain = [Plain(text=err_msg)]
                return [], {}, res, has_event_param
        else:
            if p.default is inspect.Parameter.empty:
                # 缺少必填参数
                usage_parts = []
                for param in pos_params:
                    if param.default is inspect.Parameter.empty:
                        usage_parts.append(f"<{param.name}>")
                    else:
                        usage_parts.append(f"[{param.name}={param.default}]")
                cmd_display = matched_prefix or handler.handler_name
                usage_msg = f"参数不足。\n用法: {cmd_display} {' '.join(usage_parts)}"
                res = MessageEventResult()
                res.chain = [Plain(text=usage_msg)]
                return [], {}, res, has_event_param
            else:
                bound_args.append(p.default)

    return bound_args, {}, None, has_event_param


async def run_handlers(
    event: Any,
    handlers: list[StarHandlerMetadata],
    mounts: dict[str, Any] | None = None,
    timeout_s: float = 20.0,
) -> tuple[list[dict[str, Any]], list[MessageEventResult]]:
    """统一执行一组 Handler。

    特性：
    - 安全元数据读取（handler_name 提取放入 try 块）
    - 命令参数解析与缺少参数友好提示
    - 支持普通函数、协程、异步生成器与同步生成器
    - 收集 yield 的 MessageEventResult 与 event.get_result()
    - 捕获异常记录日志，避免单 handler 崩溃中断整批
    """
    exec_reports: list[dict[str, Any]] = []
    collected_results: list[MessageEventResult] = []

    for h in handlers:
        started = time.perf_counter()
        entry: dict[str, Any] = {}
        try:
            h_name = getattr(h, "handler_name", "unknown")
            owner = resolve_owner(h, mounts)
            entry["handler"] = h_name
            entry["plugin"] = owner

            if not h.filter_event(event):
                continue

            fn = getattr(h, "handler", None)
            if fn is None:
                continue

            # 命令参数解析
            args, kwargs, err_res, needs_event = extract_command_args_and_bind(h, event)
            if err_res:
                collected_results.append(err_res)
                entry["ok"] = True
                entry["note"] = "usage_returned"
                entry["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
                exec_reports.append(entry)
                continue

            # 调用
            if needs_event:
                res = fn(event, *args, **kwargs)
            else:
                res = fn(*args, **kwargs)

            # 处理异步生成器 / 同步生成器 / 协程
            if hasattr(res, "__aiter__"):
                async for item in res:
                    if isinstance(item, MessageEventResult):
                        collected_results.append(item)
            elif hasattr(res, "__iter__") and not isinstance(res, (str, bytes, dict, list, tuple)):
                for item in res:
                    if isinstance(item, MessageEventResult):
                        collected_results.append(item)
            elif asyncio.iscoroutine(res):
                coro_res = await asyncio.wait_for(res, timeout=timeout_s)
                if isinstance(coro_res, MessageEventResult):
                    collected_results.append(coro_res)
            elif isinstance(res, MessageEventResult):
                collected_results.append(res)

            # 获取 event 内部被设置的结果
            if hasattr(event, "get_result"):
                ev_res = event.get_result()
                if ev_res and isinstance(ev_res, MessageEventResult) and ev_res not in collected_results:
                    collected_results.append(ev_res)

            entry["ok"] = True
        except asyncio.TimeoutError:
            entry["error"] = f"timeout>{timeout_s:.0f}s"
            logger.warning("Handler %s 执行超时 (%.1fs)", entry.get("handler"), timeout_s)
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            logger.exception("Handler %s 执行异常", entry.get("handler"))
            # 触发异常事件派发（异步无阻塞尝试）
            try:
                await dispatch_lifecycle_event(EventType.OnPluginErrorEvent, {"error": str(exc), "handler": entry.get("handler")})
            except Exception:
                pass
        finally:
            entry["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
            exec_reports.append(entry)

    return exec_reports, collected_results


async def dispatch_lifecycle_event(event_type: EventType, detail: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """派发 B 类宿主生命周期事件。"""
    handlers = star_handlers_registry.get_handlers_by_event_type(event_type)
    if not handlers:
        return []

    reports: list[dict[str, Any]] = []
    for h in handlers:
        started = time.perf_counter()
        entry: dict[str, Any] = {"event": event_type.name}
        try:
            entry["handler"] = getattr(h, "handler_name", "unknown")
            fn = getattr(h, "handler", None)
            if fn:
                # 生命周期事件一般接收无参或 (detail/event)
                try:
                    sig = inspect.signature(fn)
                    param_count = len([p for p in sig.parameters.values() if p.name not in ("self", "cls")])
                except Exception:
                    param_count = 0

                if param_count == 0:
                    res = fn()
                else:
                    res = fn(detail or {})

                if asyncio.iscoroutine(res):
                    await asyncio.wait_for(res, timeout=5.0)
            entry["ok"] = True
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            logger.warning("生命周期事件 %s 派发到 %s 异常: %s", event_type.name, entry.get("handler"), exc)
        finally:
            entry["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
            reports.append(entry)
    return reports


def scan_and_warn_unsupported_handlers() -> list[dict[str, Any]]:
    """装载完成后扫描 registry，对挂载在 unsupported 或缺失派发点上的 handler 发出告警。"""
    warnings: list[dict[str, Any]] = []
    for h in star_handlers_registry._handlers:
        spec = DISPATCH_TABLE.get(h.event_type)
        if not spec or spec.level == SupportLevel.UNSUPPORTED:
            owner = resolve_owner(h)
            h_name = getattr(h, "handler_name", "unknown")
            mod_path = getattr(h, "handler_module_path", "")
            logger.warning(
                "[垫片兼容性警告] 插件 %s 的 handler %s 挂载在不支持的事件类型 %s 上 (模块: %s)",
                owner,
                h_name,
                getattr(h.event_type, "name", str(h.event_type)),
                mod_path,
            )
            warnings.append({
                "plugin": owner,
                "handler": h_name,
                "eventType": getattr(h.event_type, "name", str(h.event_type)),
                "level": spec.level.value if spec else "unknown",
            })
    return warnings
