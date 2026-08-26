"""astrbot.core.platform.astr_message_event —— 消息事件。

插件看到的每一条消息都是一个 `AstrMessageEvent`。上游它是抽象类，由各平台
适配器实现 `send()`；垫片这里做成可直接实例化的具体类，`send()` 走一个
可注入的回调。

为什么 send 要可注入而不是直接抛 NotImplementedError：GCP 的状态机在某些
分支会主动调 `event.send(...)`。宿主当前跑在影子模式下，需要把这些调用**记录
下来但不真发**；将来接生产时，把回调换成"转交 Bridge v2 投递"即可，
插件源码一行不动。
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from astrbot.core import logger
from astrbot.core.message.components import BaseMessageComponent, Image, Plain
from astrbot.core.message.message_event_result import (
    MessageChain,
    MessageEventResult,
    ResultContentType,
)

from .astrbot_message import AstrBotMessage, MessageSession, PlatformMetadata
from .message_type import MessageType

#: 外部注入的投递回调。签名 (event, chain) -> Awaitable。默认只记日志。
SendHook = Callable[["AstrMessageEvent", MessageChain], Awaitable[None]]


async def _default_send_hook(event: "AstrMessageEvent", chain: MessageChain) -> None:
    logger.info(
        "[垫片] 插件请求发送消息，但宿主未接投递通道，已丢弃 | umo=%s text=%r",
        event.unified_msg_origin,
        chain.get_plain_text()[:120],
    )


class AstrMessageEvent:
    def __init__(
        self,
        message_str: str,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        session_id: str,
        send_hook: SendHook | None = None,
    ) -> None:
        self.message_str = message_str
        self.message_obj = message_obj
        self.platform_meta = platform_meta
        self.platform = platform_meta  # 上游的向后兼容别名
        self.role = "member"
        self.is_wake = False
        self.is_at_or_wake_command = False
        self.call_llm = False
        self.created_at = time.time()

        self._extras: dict[str, Any] = {}
        self._result: MessageEventResult | None = None
        self._force_stopped = False
        self._has_send_oper = False
        self._temporary_local_files: list[str] = []
        self._send_hook: SendHook = send_hook or _default_send_hook
        #: 宿主用它做审计：本次事件里插件试图发出去的所有内容
        self.sent_chains: list[MessageChain] = []

        message_type = getattr(message_obj, "type", None)
        if not isinstance(message_type, MessageType):
            try:
                message_type = MessageType(str(message_type))
            except (ValueError, TypeError, AttributeError):
                message_type = MessageType.FRIEND_MESSAGE
        self.session = MessageSession(
            platform_name=platform_meta.id,
            message_type=message_type,
            session_id=session_id,
        )

    # ---------- 身份与来源 ----------

    @property
    def unified_msg_origin(self) -> str:
        return str(self.session)

    @unified_msg_origin.setter
    def unified_msg_origin(self, value: str) -> None:
        self.session = MessageSession.from_str(value)

    @property
    def session_id(self) -> str:
        return self.session.session_id

    @session_id.setter
    def session_id(self, value: str) -> None:
        self.session.session_id = value

    def get_platform_name(self) -> str:
        return self.platform_meta.name

    def get_platform_id(self) -> str:
        return self.platform_meta.id

    def get_session_id(self) -> str:
        return self.session.session_id

    def get_message_type(self) -> MessageType:
        return self.session.message_type

    def get_group_id(self) -> str:
        return getattr(self.message_obj, "group_id", "") or ""

    def get_self_id(self) -> str:
        return str(getattr(self.message_obj, "self_id", ""))

    def get_sender_id(self) -> str:
        return str(self.message_obj.sender.user_id)

    def get_sender_name(self) -> str:
        return self.message_obj.sender.nickname or ""

    def is_private_chat(self) -> bool:
        return self.session.message_type == MessageType.FRIEND_MESSAGE

    def is_group_chat(self) -> bool:
        return self.session.message_type == MessageType.GROUP_MESSAGE

    def is_admin(self) -> bool:
        return self.role == "admin"

    def is_wake_up(self) -> bool:
        return self.is_wake

    # ---------- 消息内容 ----------

    def get_message_str(self) -> str:
        return self.message_str

    def get_plain_text(self) -> str:
        return self.message_str

    def get_messages(self) -> list[BaseMessageComponent]:
        return self.message_obj.message

    def get_message_outline(self) -> str:
        """带非文本段标记的摘要，日志与审查用。"""
        parts: list[str] = []
        for comp in self.message_obj.message or []:
            if isinstance(comp, Plain):
                parts.append(comp.text)
            else:
                parts.append(f"[{comp.type.value}]")
        return "".join(parts) or self.message_str

    # ---------- 附加数据 ----------

    def set_extra(self, key: str, value: Any) -> None:
        self._extras[key] = value

    def get_extra(self, key: str | None = None, default: Any = None) -> Any:
        if key is None:
            return self._extras
        return self._extras.get(key, default)

    def clear_extra(self) -> None:
        self._extras.clear()

    def track_temporary_local_file(self, path: str) -> None:
        self._temporary_local_files.append(str(path))

    def cleanup_temporary_local_files(self) -> None:
        self._temporary_local_files.clear()

    # ---------- 结果 ----------

    def set_result(self, result: MessageEventResult | str) -> None:
        self._result = MessageEventResult().message(result) if isinstance(result, str) else result

    def get_result(self) -> MessageEventResult | None:
        return self._result

    def clear_result(self) -> None:
        self._result = None

    def make_result(self) -> MessageEventResult:
        return MessageEventResult()

    def plain_result(self, text: str) -> MessageEventResult:
        return MessageEventResult().message(text)

    def image_result(self, url_or_path: str) -> MessageEventResult:
        result = MessageEventResult()
        if str(url_or_path).startswith(("http://", "https://")):
            return result.url_image(url_or_path)
        return result.file_image(url_or_path)

    def chain_result(self, chain: list[BaseMessageComponent]) -> MessageEventResult:
        return MessageEventResult(chain=list(chain))

    def llm_result(self, text: str) -> MessageEventResult:
        return MessageEventResult().message(text).set_result_content_type(ResultContentType.LLM_RESULT)

    def stop_event(self) -> None:
        self._force_stopped = True
        if self._result:
            self._result.stop_event()

    def continue_event(self) -> None:
        self._force_stopped = False
        if self._result:
            self._result.continue_event()

    def is_stopped(self) -> bool:
        return self._force_stopped or bool(self._result and self._result.is_stopped())

    def should_call_llm(self, call_llm: bool) -> None:
        self.call_llm = call_llm

    # ---------- 发送 ----------

    async def send(self, message: MessageChain | str) -> None:
        chain = MessageChain().message(message) if isinstance(message, str) else message
        self._has_send_oper = True
        self.sent_chains.append(chain)
        await self._send_hook(self, chain)

    async def send_streaming(self, generator: Any, use_fallback: bool = False) -> None:
        buffer: list[str] = []
        async for piece in generator:
            buffer.append(piece if isinstance(piece, str) else str(piece))
        if buffer:
            await self.send(MessageChain().message("".join(buffer)))

    async def send_typing(self) -> None:
        return None

    async def stop_typing(self) -> None:
        return None

    async def react(self, emoji: str) -> None:
        return None

    async def get_group(self, group_id: str | None = None, **kwargs: Any) -> Any:
        return getattr(self.message_obj, "group", None)

    def request_llm(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError(
            "统一垫片不代理 LLM 请求：模型调用一律由 Bridge v2 的 ModelAdapter 统一出口负责"
        )

    def __repr__(self) -> str:
        return f"AstrMessageEvent(umo={self.unified_msg_origin!r}, text={self.message_str[:40]!r})"


__all__ = ["AstrMessageEvent", "SendHook"]
