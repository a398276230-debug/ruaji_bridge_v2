"""Resolve access control, user aliases, and memory isolation scopes."""

from __future__ import annotations

import os
import re
from typing import Any

GLOBAL_MEMORY_SCOPE = "livingmemory:global"

#: 主人 QQ 号。主人私聊由桥接的 Mem0 专属沉淀（src/orchestration/mem0-ingestor.js），
#: LivingMemory 一律不捕获、不反思、不入图谱，保证两套记忆 0 重叠。
#: 解析优先级：插件配置 access_control.owner_ids > 环境变量 > 这里。
DEFAULT_OWNER_ID = "3054039169"

#: 环境变量兜底名。宿主会把 identity.owner_id 注入插件配置，独立部署时可用这里。
OWNER_ID_ENV_VARS = ("LIVINGMEMORY_OWNER_ID", "RUAJI_V2_OWNER_ID")


def _config_get(config: Any, key: str, default: Any = None) -> Any:
    if isinstance(config, dict):
        current: Any = config
        for part in key.split("."):
            if not isinstance(current, dict) or part not in current:
                return default
            current = current[part]
        return current

    getter = getattr(config, "get", None)
    if callable(getter):
        try:
            return getter(key, default)
        except TypeError:
            pass
    return default


def parse_value_list(value: Any) -> list[str]:
    """Parse comma, semicolon, or newline separated configuration values."""
    if isinstance(value, list):
        items = value
    else:
        items = re.split(r"[,;\n]", str(value or ""))
    return list(dict.fromkeys(str(item).strip() for item in items if str(item).strip()))


def parse_identity_aliases(value: Any) -> dict[str, str]:
    """Parse one ``source=canonical name`` mapping per line."""
    aliases: dict[str, str] = {}
    for line in str(value or "").splitlines():
        source, separator, target = line.partition("=")
        if not separator:
            continue
        source = source.strip()
        target = target.strip()
        if source and target:
            aliases[source.casefold()] = target
    return aliases


def _event_value(event: Any, method_name: str, attribute_name: str = "") -> str:
    method = getattr(event, method_name, None)
    if callable(method):
        try:
            value = method()
            return str(value).strip() if value is not None else ""
        except Exception:
            return ""
    value = getattr(event, attribute_name or method_name, "")
    return str(value).strip() if value is not None else ""


def resolve_event_identity(config: Any, event: Any) -> str:
    """Return the configured canonical identity for the event sender."""
    sender_id = _event_value(event, "get_sender_id", "sender_id")
    sender_name = _event_value(event, "get_sender_name", "sender_name")
    platform = _event_value(event, "get_platform_name", "platform").casefold()
    aliases = parse_identity_aliases(
        _config_get(config, "access_control.identity_aliases", "")
    )
    candidates = (
        f"{platform}:{sender_id}" if platform and sender_id else "",
        sender_id,
        sender_name,
    )
    for candidate in candidates:
        if candidate and candidate.casefold() in aliases:
            return aliases[candidate.casefold()]
    return sender_id or sender_name or _event_value(
        event, "unified_msg_origin", "unified_msg_origin"
    )


def resolve_sender_alias(
    aliases_value: Any,
    platform: str,
    sender_id: str,
    sender_name: str | None,
) -> str | None:
    aliases = parse_identity_aliases(aliases_value)
    for candidate in (f"{platform}:{sender_id}", sender_id, sender_name or ""):
        if candidate and candidate.casefold() in aliases:
            return aliases[candidate.casefold()]
    return sender_name


def resolve_owner_ids(config: Any) -> set[str]:
    """主人标识集合。配置 > 环境变量 > 默认值。

    每次调用现读配置/环境变量，不做构造期快照 —— 面板改了
    ``access_control.owner_ids`` 必须立刻生效。
    """
    configured = parse_value_list(
        _config_get(config, "access_control.owner_ids", "")
    )
    values = configured
    if not values:
        for name in OWNER_ID_ENV_VARS:
            raw = os.environ.get(name, "")
            values = parse_value_list(raw)
            if values:
                break
    if not values:
        values = [DEFAULT_OWNER_ID]
    return {value.casefold() for value in values}


def is_owner_sender(config: Any, event: Any) -> bool:
    """事件发送者是否为主人（按 identity_aliases 归一化后的标识匹配）。"""
    sender_id = _event_value(event, "get_sender_id", "sender_id")
    if not sender_id:
        return False
    identity = resolve_event_identity(config, event)
    owners = resolve_owner_ids(config)
    return sender_id.casefold() in owners or (
        bool(identity) and identity.casefold() in owners
    )


def is_owner_private_event(config: Any, event: Any) -> bool:
    """主人私聊事件：由桥接 Mem0 负责，LivingMemory 的所有捕获入口都应跳过。"""
    try:
        from astrbot.api.platform import MessageType

        if event.get_message_type() != MessageType.FRIEND_MESSAGE:
            return False
    except Exception:
        return False
    return is_owner_sender(config, event)


def is_event_memory_allowed(config: Any, event: Any) -> bool:
    """Apply the plugin-level allowlist consistently to every entry point."""
    if not _config_get(config, "access_control.whitelist_enabled", False):
        return True
    allowed = {
        value.casefold()
        for value in parse_value_list(
            _config_get(config, "access_control.allowed_ids", "")
        )
    }
    if not allowed:
        return False

    sender_id = _event_value(event, "get_sender_id", "sender_id")
    platform = _event_value(event, "get_platform_name", "platform")
    session_id = _event_value(event, "unified_msg_origin", "unified_msg_origin")
    group_id = _event_value(event, "get_group_id", "group_id")
    identity = resolve_event_identity(config, event)
    candidates = {
        sender_id,
        identity,
        session_id,
        group_id,
        f"{platform}:{sender_id}" if platform and sender_id else "",
    }
    return any(
        candidate and candidate.casefold() in allowed for candidate in candidates
    )


def resolve_memory_scope(config: Any, event: Any) -> str | None:
    """Resolve the retrieval/storage scope while preserving legacy defaults."""
    session_id = _event_value(event, "unified_msg_origin", "unified_msg_origin")
    isolated_sessions = set(
        parse_value_list(
            _config_get(config, "filtering_settings.isolated_sessions", "")
        )
    )
    if session_id in isolated_sessions:
        return session_id

    mode = str(
        _config_get(config, "filtering_settings.memory_scope_mode", "legacy")
    ).casefold()
    if mode == "session":
        return session_id
    if mode == "global":
        return GLOBAL_MEMORY_SCOPE
    if mode == "user":
        platform = _event_value(event, "get_platform_name", "platform").casefold()
        identity = resolve_event_identity(config, event).casefold()
        return f"livingmemory:user:{platform or 'unknown'}:{identity}"

    use_session = bool(
        _config_get(config, "filtering_settings.use_session_filtering", True)
    )
    if use_session:
        return session_id
    return GLOBAL_MEMORY_SCOPE if isolated_sessions else None


__all__ = [
    "DEFAULT_OWNER_ID",
    "GLOBAL_MEMORY_SCOPE",
    "OWNER_ID_ENV_VARS",
    "is_event_memory_allowed",
    "is_owner_private_event",
    "is_owner_sender",
    "parse_identity_aliases",
    "parse_value_list",
    "resolve_event_identity",
    "resolve_memory_scope",
    "resolve_owner_ids",
    "resolve_sender_alias",
]
