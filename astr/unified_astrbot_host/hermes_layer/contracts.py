"""hermes_layer.contracts —— 宿主对外的数据契约。

Bridge v2 与宿主之间只认这几个形状。它们同时被 `/api/v1/events`、
`/api/v1/decision`、`/api/v1/context/enrich` 三个端点使用 —— 一个定义，
三处复用，免得"同一条消息在三个端点里字段名不一样"。

字段命名用 camelCase 是因为对面是 Node.js（ruaji_bridge_v2）。
Python 侧属性仍是 snake_case，转换在 `from_payload` / `to_payload` 里做。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

#: GCP 只允许这三种裁决。多一种都不行 —— Bridge v2 的 DecisionRouter
#: 是穷举匹配的，出现第四种值会走进 default 分支被当成 ignore，
#: 于是"该回的没回"，而且日志里看不出是裁决越界导致的。
Verdict = Literal["direct", "auto", "ignore"]

VERDICTS: tuple[str, ...] = ("direct", "auto", "ignore")


@dataclass
class InboundMessage:
    """一条从 Bridge v2 送进来的群消息。"""

    message_id: str = ""
    group_id: str = ""
    user_id: str = ""
    user_name: str = ""
    text: str = ""
    self_id: str = ""
    is_private: bool = False
    at_bot: bool = False
    #: 被回复的消息 id（QQ 的引用回复），没有就是空串
    reply_to: str = ""
    role: str = "member"
    timestamp: float = field(default_factory=time.time)
    #: 原始 OneBot 事件，插件里少数分支会读它
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "InboundMessage":
        """从 HTTP body 构造。

        对缺字段宽容（补空串），对类型不宽容里的例外是 id 类字段 ——
        QQ 号在 JSON 里既可能是数字也可能是字符串，一律 str() 归一。
        不归一的后果是 group_id 在字典里同时以 123 和 "123" 存在两份。
        """
        if not isinstance(payload, dict):
            raise TypeError(f"消息体必须是对象，实际是 {type(payload).__name__}")

        def sid(*keys: str) -> str:
            for key in keys:
                value = payload.get(key)
                if value not in (None, ""):
                    return str(value)
            return ""

        def sbool(*keys: str) -> bool:
            for key in keys:
                value = payload.get(key)
                if value is not None:
                    return bool(value)
            return False

        text = payload.get("text")
        if text is None:
            text = payload.get("message") or payload.get("raw_message") or ""

        return cls(
            message_id=sid("messageId", "message_id"),
            group_id=sid("groupId", "group_id"),
            user_id=sid("userId", "user_id", "senderId", "sender_id"),
            user_name=str(
                payload.get("userName")
                or payload.get("user_name")
                or payload.get("displayName")
                or payload.get("display_name")
                or payload.get("nickname")
                or ""
            ),
            text=str(text),
            self_id=sid("selfId", "self_id", "robotId", "robot_id"),
            is_private=sbool("isPrivate", "is_private", "private"),
            at_bot=sbool("isAtBot", "is_at_bot", "atBot", "at_bot"),
            reply_to=sid("replyTo", "reply_to"),
            role=str(payload.get("role") or "member"),
            timestamp=float(payload.get("timestamp") or time.time()),
            raw=dict(payload.get("raw") or payload.get("rawMessage") or payload.get("raw_message") or {} if isinstance(payload.get("raw") or payload.get("rawMessage") or payload.get("raw_message"), dict) else {}),
        )

    @property
    def session_id(self) -> str:
        """会话标识。群聊用群号，私聊用 QQ 号 —— 与 AstrBot 的语义一致。"""
        return self.user_id if self.is_private else (self.group_id or self.user_id)


@dataclass
class ContextBlock:
    """一块上下文。

    Bridge v2 的 ContextAggregator 收到的是这些块的数组，由它决定拼装顺序与
    预算裁剪。宿主只负责"谁贡献了什么、多长"，不做拼装 ——
    拼装策略属于桥接的职责，两边都做就会重复注入。
    """

    source: str
    """贡献者，取插件的短名（living_memory / self_learning / group_chat_plus）"""
    kind: str
    """内容类别：system_prompt / contexts / tools / extra_parts"""
    content: str = ""
    tokens_estimate: int = 0
    elapsed_ms: float = 0.0
    truncated: bool = False
    error: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "kind": self.kind,
            "content": self.content,
            "tokensEstimate": self.tokens_estimate,
            "elapsedMs": round(self.elapsed_ms, 2),
            "truncated": self.truncated,
            "error": self.error,
            "detail": self.detail,
        }


@dataclass
class Decision:
    """GCP 的回复裁决。"""

    verdict: Verdict = "ignore"
    reason: str = ""
    probability: float | None = None
    elapsed_ms: float = 0.0
    detail: dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "route": self.verdict,
            "reason": self.reason,
            "probability": self.probability,
            "elapsedMs": round(self.elapsed_ms, 2),
            "detail": self.detail,
        }


def estimate_tokens(text: str) -> int:
    """粗估 token 数。

    中文按 1 字≈1 token、其余按 4 字符≈1 token。这个估算只用于
    面板展示与预算告警，不参与真实截断 —— 真截断由 Bridge v2 按模型
    的真实分词器做。放在这里做精确分词等于把 tokenizer 依赖引进宿主，
    换来的精度对"这块上下文是不是太胖了"这个问题没有意义。
    """
    if not text:
        return 0
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    return cjk + max(0, (len(text) - cjk)) // 4


__all__ = [
    "VERDICTS",
    "ContextBlock",
    "Decision",
    "InboundMessage",
    "Verdict",
    "estimate_tokens",
]
