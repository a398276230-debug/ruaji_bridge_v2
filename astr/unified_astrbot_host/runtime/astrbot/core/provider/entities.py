"""astrbot.core.provider.entities —— Provider 相关的数据模型。

签名照真实 AstrBot 抄，字段取三个插件真正读到的那些。

`LLMResponse` 特别处理了一件事：上游用 `_completion_text` 私有字段加
`completion_text` property，而插件里三种写法都有（`.result` / `.completion_text`
/ `.text`）。这里让三个名字指向同一份内容并双向同步，
免得出现"某条路径读出空字符串"这类只在特定分���复现的问题。
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class ProviderType(enum.Enum):
    CHAT_COMPLETION = "chat_completion"
    SPEECH_TO_TEXT = "speech_to_text"
    TEXT_TO_SPEECH = "text_to_speech"
    EMBEDDING = "embedding"
    RERANK = "rerank"
    # 上游别名，插件里两种写法都出现过
    RERANKER = "rerank"


@dataclass
class ProviderMeta:
    id: str = ""
    model: str | None = None
    type: str = ""
    provider_type: ProviderType = ProviderType.CHAT_COMPLETION


@dataclass
class ProviderMetaData(ProviderMeta):
    desc: str = ""
    cls_type: Any = None
    default_config_tmpl: dict | None = None
    provider_display_name: str | None = None


@dataclass
class TokenUsage:
    input_other: int = 0
    input_cached: int = 0
    output: int = 0

    @property
    def total(self) -> int:
        return self.input_other + self.input_cached + self.output


@dataclass
class ProviderRequest:
    """一次 LLM 请求。

    插件通过 `@filter.on_llm_request` 拿到它并就地修改 —— SelfLearning 往
    `system_prompt` 里塞语气画像与黑话，LivingMemory 往里塞召回的记忆。
    这是"上下文注入"的正式入口，宿主的 /api/v1/context/enrich 就是把这些
    修改收集起来交给 Bridge v2。
    """

    prompt: str | None = None
    session_id: str | None = ""
    image_urls: list[str] = field(default_factory=list)
    audio_urls: list[str] = field(default_factory=list)
    extra_user_content_parts: list[Any] = field(default_factory=list)
    func_tool: Any = None
    contexts: list[dict] = field(default_factory=list)
    system_prompt: str = ""
    conversation: Any = None
    tool_calls_result: Any = None
    model: str | None = None

    def __str__(self) -> str:
        return (
            f"ProviderRequest(prompt={self.prompt!r}, "
            f"system_prompt_len={len(self.system_prompt)}, contexts={len(self.contexts)})"
        )


@dataclass
class LLMResponse:
    role: str = "assistant"
    result_chain: Any = None
    tools_call_args: list[dict[str, Any]] = field(default_factory=list)
    tools_call_name: list[str] = field(default_factory=list)
    tools_call_ids: list[str] = field(default_factory=list)
    tools_call_extra_content: dict[str, dict[str, Any]] = field(default_factory=dict)
    reasoning_content: str | None = None
    reasoning_signature: str | None = None
    raw_completion: Any = None
    is_chunk: bool = False
    id: str | None = None
    usage: TokenUsage | None = None
    _completion_text: str = ""

    def __init__(  # noqa: PLR0913 —— 字段多是为了兼容三种构造写法
        self,
        role: str = "assistant",
        completion_text: str = "",
        result: str = "",
        text: str = "",
        raw_completion: Any = None,
        result_chain: Any = None,
        **kwargs: Any,
    ) -> None:
        self.role = role
        self.result_chain = result_chain
        self.raw_completion = raw_completion
        self.tools_call_args = kwargs.pop("tools_call_args", []) or []
        self.tools_call_name = kwargs.pop("tools_call_name", []) or []
        self.tools_call_ids = kwargs.pop("tools_call_ids", []) or []
        self.tools_call_extra_content = kwargs.pop("tools_call_extra_content", {}) or {}
        self.reasoning_content = kwargs.pop("reasoning_content", None)
        self.reasoning_signature = kwargs.pop("reasoning_signature", None)
        self.is_chunk = kwargs.pop("is_chunk", False)
        self.id = kwargs.pop("id", None)
        self.usage = kwargs.pop("usage", None)
        # 三个别名取第一个非空的，之后全部指向它
        self._completion_text = completion_text or result or text or ""
        for key, value in kwargs.items():
            setattr(self, key, value)

    @property
    def completion_text(self) -> str:
        return self._completion_text

    @completion_text.setter
    def completion_text(self, value: str) -> None:
        self._completion_text = value or ""

    # `.result` 与 `.text` 是上游遗留别名，插件两种都在用
    @property
    def result(self) -> str:
        return self._completion_text

    @result.setter
    def result(self, value: str) -> None:
        self._completion_text = value or ""

    @property
    def text(self) -> str:
        return self._completion_text

    @text.setter
    def text(self, value: str) -> None:
        self._completion_text = value or ""

    def __repr__(self) -> str:
        return f"LLMResponse(role={self.role!r}, completion_text={self._completion_text[:60]!r})"


@dataclass
class RerankResult:
    index: int
    relevance_score: float


@dataclass
class ToolCallsResult:
    tool_calls_info: Any = None
    tool_calls_result: list[Any] = field(default_factory=list)


__all__ = [
    "LLMResponse",
    "ProviderMeta",
    "ProviderMetaData",
    "ProviderRequest",
    "ProviderType",
    "RerankResult",
    "TokenUsage",
    "ToolCallsResult",
]
