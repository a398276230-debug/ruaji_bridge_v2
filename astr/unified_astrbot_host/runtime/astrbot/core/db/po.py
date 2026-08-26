"""astrbot.core.db.po —— 持久化对象。

上游这两个类分别是 TypedDict 和 SQLModel table。垫片里降成 TypedDict +
普通 dataclass：宿主不接 AstrBot 的主数据库（历史的权威副本在 Bridge v2
的 SessionStore 与 GCP 的缓冲池里），这两个类型在插件里的用途也只有两处，
且都是"把官方对象转成 AstrBotMessage"的适配入口：

    group_chat_plus/utils/context_manager.py:882
        def _history_to_astrbot_message(self, history_item: "PlatformMessageHistory", ...)

而且它是 `if TYPE_CHECKING:` 里导入的类型注解，运行期不需要真 ORM。
保留字段名是为了那个转换函数照样能取到属性。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict


class Personality(TypedDict, total=False):
    """LLM 人格。

    宿主里这份数据由 config.yaml 的 persona 段落提供，UnifiedContext
    在启动时装进 persona_manager。
    """

    prompt: str
    name: str
    begin_dialogs: list[str]
    mood_imitation_dialogs: list[str]
    tools: list[str] | None
    skills: list[str] | None
    custom_error_message: str | None


@dataclass
class PlatformMessageHistory:
    """平台侧消息历史的一行。"""

    id: int | None = None
    platform_id: str = ""
    user_id: str = ""
    sender_id: str | None = None
    sender_name: str | None = None
    content: dict | list = field(default_factory=dict)
    created_at: Any = None
    updated_at: Any = None


@dataclass
class Persona:
    """v4 之后推荐的人格类。"""

    persona_id: str = "default"
    system_prompt: str = ""
    begin_dialogs: list[str] = field(default_factory=list)
    tools: list[str] | None = None
    skills: list[str] | None = None


@dataclass
class Conversation:
    """会话检查点。宿主不落这份，留类型位。"""

    cid: str = ""
    user_id: str = ""
    history: str = "[]"
    title: str | None = None
    persona_id: str | None = None
    created_at: Any = None
    updated_at: Any = None


__all__ = ["Conversation", "Persona", "Personality", "PlatformMessageHistory"]
