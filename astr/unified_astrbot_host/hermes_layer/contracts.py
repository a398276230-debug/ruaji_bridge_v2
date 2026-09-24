"""hermes_layer.contracts —— 宿主对外的数据契约。

Bridge v2 与宿主之间只认这几个形状。它们同时被 `/api/v1/events`、
`/api/v1/decision`、`/api/v1/context/enrich` 三个端点使用 —— 一个定义，
三处复用，免得"同一条消息在三个端点里字段名不一样"。

字段命名用 camelCase 是因为对面是 Node.js（ruaji_bridge_v2）。
Python 侧属性仍是 snake_case，转换在 `from_payload` / `to_payload` 里做。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Literal

#: GCP 只允许这三种裁决。多一种都不行 —— Bridge v2 的 DecisionRouter
#: 是穷举匹配的，出现第四种值会走进 default 分支被当成 ignore，
#: 于是"该回的没回"，而且日志里看不出是裁决越界导致的。
Verdict = Literal["direct", "auto", "ignore"]

VERDICTS: tuple[str, ...] = ("direct", "auto", "ignore")


#: 归一化后的私聊 messageType 取值。AstrBot 的 ``FriendMessage``、桥接的
#: ``private``、以及历史写法 ``friend`` / ``private_message`` 都落进这个集合。
_PRIVATE_MESSAGE_TYPE_TOKENS = frozenset(
    {"private", "privatechat", "privatemessage", "friend", "friendmessage"}
)


def is_private_message_type(value: Any) -> bool:
    """messageType 是否表示私聊。

    只保留字母后小写再比对，于是 ``FriendMessage`` / ``friend_message`` /
    ``private`` 都能命中；``GroupMessage`` / ``other`` 一律为 False。
    宿主与桥接必须就"这条是不是私聊"给出一致答案——它决定 unified_msg_origin
    里的 MessageType（记忆按会话隔离，判错就把私聊写进群会话），以及 LivingMemory
    的主人私聊豁免。
    """
    token = re.sub(r"[^a-z]", "", str(value or "").casefold())
    return token in _PRIVATE_MESSAGE_TYPE_TOKENS


def _extract_at_targets(payload: dict[str, Any]) -> list[str]:
    """从 HTTP body 提取被 @ 的用户 QQ 号列表（去重保序）。

    两个来源，显式清单优先：
    1. ``atTargets`` / ``at_targets`` —— 调用方直接给字符串数组
    2. ``segments`` —— OneBot 消息段数组，抽 ``type=at`` 段的 ``data.qq``。
       桥接的命令中继把完整 segments 放在 body 里，这里不认它的话
       @ 的 QQ 号就在 from_payload 处丢失。
    """
    explicit = payload.get("atTargets") or payload.get("at_targets")
    if isinstance(explicit, list) and explicit:
        out = [str(t) for t in explicit if t not in (None, "")]
        return list(dict.fromkeys(out))

    segments = payload.get("segments")
    if not isinstance(segments, list):
        return []
    out: list[str] = []
    for seg in segments:
        if not isinstance(seg, dict) or seg.get("type") != "at":
            continue
        data = seg.get("data") if isinstance(seg.get("data"), dict) else {}
        qq = data.get("qq") or seg.get("qq")
        if qq in (None, ""):
            continue
        qq = str(qq)
        if qq not in out:
            out.append(qq)
    return out


@dataclass
class InboundMessage:
    """一条从 Bridge v2 送进来的群消息。"""

    message_id: str = ""
    group_id: str = ""
    user_id: str = ""
    user_name: str = ""
    text: str = ""
    #: 模型正文：CQ 码已由桥接转成 "@昵称" 的可读文本。语义上与 text 的区别：
    #: text 是去 CQ 纯文本（指令匹配用），content 保留 @ 信息（上下文/滑窗用）。
    #: 桥接未升级只发 text 时，from_payload 会把两者置成同一个值。
    content: str = ""
    self_id: str = ""
    is_private: bool = False
    at_bot: bool = False
    #: 被回复的消息 id（QQ 的引用回复），没有就是空串
    reply_to: str = ""
    role: str = "member"
    #: 触发类型（桥接侧裁决）：at / keyword / ai_decision。
    #:
    #: 宿主与插件靠它区分"被动回复"与"主动插话"——桥接的主动插话不构成
    #: 与群友的互动，不注入也不结算好感度。以前只在桥接侧判断，Favour
    #: Ultra 把注入搬到宿主后，这个字段不过来豁免就丢了（enrich 的 body
    #: 一直带着它，只是 from_payload 不认）。
    trigger_type: str = ""
    timestamp: float = field(default_factory=time.time)
    #: 被 @ 的用户 QQ 号（不含 bot 自身，去重保序）。
    #:
    #: 插件命令（如 Favour Ultra 的 /冷暴力 @某人）从消息链的 At 组件里取
    #: 目标 QQ 号（main.py _get_target_uid），昵称文本无法反查。桥接命令中继
    #: 把 OneBot segments 原样放在 body 里，@ 的 QQ 号只存在于 at 段 ——
    #: from_payload 必须把它捞出来，build_event 才能重建成 At 组件。
    at_targets: list[str] = field(default_factory=list)
    #: 原始 OneBot 事件，插件里少数分支会读它
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def message_type(self) -> str:
        """归一化后的消息类型：``"private"`` / ``"group"``。"""
        return "private" if self.is_private else "group"

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

        text = payload.get("content") or payload.get("text")
        if text is None:
            text = payload.get("message") or payload.get("raw_message") or ""

        # content 缺失（旧版桥接只发 text）时与 text 同值，保底不丢 @ 信息。
        content = str(payload.get("content") or text or "")

        # 私聊判定：显式标志优先，缺失时从 messageType 推导。
        # 桥接的 message.received / context.enrich 载荷一直只带 messageType
        # （没有 isPrivate），推导缺失就会把主人私聊误判成群聊写进
        # aiocqhttp:GroupMessage:<qq> 会话，LivingMemory 的主人私聊豁免也随之失效。
        explicit_private = None
        for key in ("isPrivate", "is_private", "private"):
            value = payload.get(key)
            if value is not None:
                explicit_private = bool(value)
                break
        if explicit_private is None:
            explicit_private = is_private_message_type(
                payload.get("messageType") or payload.get("message_type")
            )

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
            content=content,
            self_id=sid("selfId", "self_id", "robotId", "robot_id"),
            is_private=explicit_private,
            at_bot=sbool("isAtBot", "is_at_bot", "atBot", "at_bot"),
            reply_to=sid("replyTo", "reply_to"),
            role=str(payload.get("role") or "member"),
            trigger_type=sid("triggerType", "trigger_type"),
            timestamp=float(payload.get("timestamp") or time.time()),
            at_targets=_extract_at_targets(payload),
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
    "is_private_message_type",
]
