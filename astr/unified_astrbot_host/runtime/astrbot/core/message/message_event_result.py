"""astrbot.core.message.message_event_result —— 事件结果与消息链。

`MessageChain` 是一串消息段加上若干渲染开关；`MessageEventResult` 在它之上
再加"是否中断事件链"与"这条结果是不是 LLM 产出的"两个语义。

方法全部返回 self，插件里大量存在 `event.plain_result("x").stop_event()`
这种链式写法，断了链就会得到 None 然后炸在调用方。
"""

from __future__ import annotations

import enum
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

from .components import At, AtAll, BaseMessageComponent, Image, Plain


@dataclass
class MessageChain:
    chain: list[BaseMessageComponent] = field(default_factory=list)
    use_t2i_: bool | None = None
    use_markdown_: bool | None = None
    type: str | None = None

    def derive(self, chain: list[BaseMessageComponent] | None = None) -> "MessageChain":
        return MessageChain(
            chain=list(chain if chain is not None else self.chain),
            use_t2i_=self.use_t2i_,
            use_markdown_=self.use_markdown_,
            type=self.type,
        )

    def message(self, message: str) -> "MessageChain":
        self.chain.append(Plain(message))
        return self

    def at(self, name: str = "", qq: Any = "") -> "MessageChain":
        self.chain.append(At(qq=qq, name=name))
        return self

    def at_all(self) -> "MessageChain":
        self.chain.append(AtAll())
        return self

    def error(self, message: str) -> "MessageChain":
        self.chain.append(Plain(message))
        return self

    def url_image(self, url: str) -> "MessageChain":
        self.chain.append(Image.fromURL(url))
        return self

    def file_image(self, path: str) -> "MessageChain":
        self.chain.append(Image.fromFileSystem(str(path)))
        return self

    def base64_image(self, base64_str: str) -> "MessageChain":
        payload = base64_str if base64_str.startswith("base64://") else f"base64://{base64_str}"
        self.chain.append(Image(file=payload, url=payload))
        return self

    def use_t2i(self, use_t2i: bool) -> "MessageChain":
        self.use_t2i_ = use_t2i
        return self

    def use_markdown(self, use: bool | None = True) -> "MessageChain":
        self.use_markdown_ = use
        return self

    def get_plain_text(self, with_other_comps_mark: bool = False) -> str:
        parts: list[str] = []
        for comp in self.chain:
            if isinstance(comp, Plain):
                parts.append(comp.text)
            elif with_other_comps_mark:
                parts.append(f"[{comp.type.value}]")
        return "".join(parts)

    def squash_plain(self) -> "MessageChain":
        """把相邻的 Plain 合并成一段。上游用它避免发出一串碎片消息。"""
        squashed: list[BaseMessageComponent] = []
        for comp in self.chain:
            if isinstance(comp, Plain) and squashed and isinstance(squashed[-1], Plain):
                squashed[-1].text += comp.text
            else:
                squashed.append(comp)
        self.chain = squashed
        return self

    def is_empty(self) -> bool:
        return not self.chain

    def __iter__(self):
        return iter(self.chain)

    def __len__(self) -> int:
        return len(self.chain)

    def __str__(self) -> str:
        return self.get_plain_text()


class EventResultType(enum.Enum):
    STOP = enum.auto()
    CONTINUE = enum.auto()


class ResultContentType(enum.Enum):
    LLM_RESULT = enum.auto()
    GENERAL_RESULT = enum.auto()
    STREAMING_RESULT = enum.auto()
    STREAMING_FINISH = enum.auto()


@dataclass
class MessageEventResult(MessageChain):
    result_type: EventResultType | None = field(default=EventResultType.STOP)
    result_content_type: ResultContentType | None = field(default=ResultContentType.GENERAL_RESULT)
    async_stream: AsyncGenerator | None = None

    def stop_event(self) -> "MessageEventResult":
        self.result_type = EventResultType.STOP
        return self

    def continue_event(self) -> "MessageEventResult":
        self.result_type = EventResultType.CONTINUE
        return self

    def is_stopped(self) -> bool:
        return self.result_type == EventResultType.STOP

    def set_async_stream(self, stream: AsyncGenerator) -> "MessageEventResult":
        self.async_stream = stream
        return self

    def set_result_content_type(self, typ: ResultContentType) -> "MessageEventResult":
        self.result_content_type = typ
        return self

    def is_llm_result(self) -> bool:
        return self.result_content_type == ResultContentType.LLM_RESULT

    def is_model_result(self) -> bool:
        return self.is_llm_result()


@dataclass
class CommandResult(MessageEventResult):
    """上游保留的旧别名，插件里偶尔还在用。"""

    def message(self, message: str) -> "CommandResult":
        super().message(message)
        return self


__all__ = [
    "CommandResult",
    "EventResultType",
    "MessageChain",
    "MessageEventResult",
    "ResultContentType",
]
