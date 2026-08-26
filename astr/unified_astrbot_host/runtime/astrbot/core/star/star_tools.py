"""astrbot.core.star.star_tools —— 插件工具类（全静态）。

最关键的是 `get_data_dir()`：插件用它决定自己的数据往哪写。
旧垫片把它写死成 `F:/harness/self_learning_data` / `group_chat_plus_data`，
三个插件各写各的。这里统一到宿主 data/ 下按插件名分目录，
既保留隔离，又让"备份 data/ 就是备份全部状态"成立。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path


class StarTools:
    _context: Any = None

    @classmethod
    def initialize(cls, context: Any) -> None:
        cls._context = context

    @classmethod
    def get_data_dir(cls, plugin_name: str | None = None) -> Path:
        root = Path(get_astrbot_plugin_data_path())
        path = root / plugin_name if plugin_name else root
        path.mkdir(parents=True, exist_ok=True)
        return path

    @classmethod
    async def send_message(cls, session: Any, message_chain: Any) -> bool:
        if cls._context is None:
            return False
        return await cls._context.send_message(session, message_chain)

    @classmethod
    async def create_message(cls, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("统一垫片不构造平台消息：投递由 Bridge v2 负责")

    @classmethod
    async def create_event(cls, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("统一垫片不自造事件：事件只能来自 /api/v1/events")

    @classmethod
    def activate_llm_tool(cls, name: str) -> bool:
        return bool(cls._context and cls._context.activate_llm_tool(name))

    @classmethod
    async def activate_llm_tool_async(cls, name: str) -> bool:
        return cls.activate_llm_tool(name)

    @classmethod
    def deactivate_llm_tool(cls, name: str) -> bool:
        return bool(cls._context and cls._context.deactivate_llm_tool(name))

    @classmethod
    async def deactivate_llm_tool_async(cls, name: str) -> bool:
        return cls.deactivate_llm_tool(name)

    @classmethod
    def register_llm_tool(cls, name: str, func_args: Any, desc: str, func_obj: Any) -> None:
        if cls._context:
            cls._context.register_llm_tool(name, func_args, desc, func_obj)

    @classmethod
    def unregister_llm_tool(cls, name: str) -> None:
        if cls._context:
            cls._context.unregister_llm_tool(name)


__all__ = ["StarTools"]
