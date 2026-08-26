"""hermes_layer.decision —— /api/v1/decision 的纯中转实现。

只做一件事：把 InboundMessage 转换成 AstrMessageEvent 递给 GCP 插件原生方法，
将 GCP 的判定结果原样封装为 Decision 回传给 Bridge v2。
宿主不施加任何自定义过滤或策略干预，100% 遵从插件行为。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from astrbot.core import logger
from astrbot.core.platform.astrbot_message import AstrBotMessage
from astrbot.core.platform.message_type import MessageType

from .context_builder import build_event
from .contracts import Decision, InboundMessage

DEFAULT_TIMEOUT_MS = 15000


class DecisionEngine:
    """纯中转裁决引擎：完全委托 GCP 原生逻辑。"""

    def __init__(self, unified: Any, timeout_ms: int | None = None) -> None:
        self._unified = unified
        cfg = dict(unified.config.get("decision") or {})
        self.timeout_s = max(0.5, int(timeout_ms or cfg.get("timeout_ms") or DEFAULT_TIMEOUT_MS) / 1000.0)

    async def decide(
        self,
        message: InboundMessage,
        history: list[dict] | None = None,
    ) -> Decision:
        started = time.perf_counter()

        def elapsed() -> float:
            return round((time.perf_counter() - started) * 1000, 2)

        plugin = self._unified.plugin("group_chat_plus")
        if plugin is None:
            verdict = "direct" if message.at_bot else "ignore"
            return Decision(
                verdict=verdict,
                reason="Group Chat Plus 未挂载，降级处理",
                elapsed_ms=elapsed(),
            )

        self_id = str((self._unified.config.get("identity") or {}).get("robot_id") or "")
        event = build_event(message, self_id=self_id)

        try:
            return await asyncio.wait_for(
                self._run_gcp_pipeline(plugin, event, message, history, started),
                timeout=self.timeout_s,
            )
        except asyncio.TimeoutError:
            logger.warning("GCP 裁决超时（>%.0fms），本次按不回复处理", self.timeout_s * 1000)
            return Decision(
                verdict="ignore",
                reason=f"GCP 决策超时（>{self.timeout_s * 1000:.0f}ms）",
                elapsed_ms=elapsed(),
                detail={"degraded": True, "reason": "timeout"},
            )
        except Exception as exc:
            logger.exception("GCP 裁决异常")
            return Decision(
                verdict="ignore",
                reason=f"GCP 裁决异常: {type(exc).__name__}: {exc}",
                elapsed_ms=elapsed(),
                detail={"degraded": True, "error": str(exc)},
            )

    async def _run_gcp_pipeline(
        self,
        plugin: Any,
        event: Any,
        message: InboundMessage,
        history: list[dict] | None,
        started: float,
    ) -> Decision:
        def elapsed() -> float:
            return round((time.perf_counter() - started) * 1000, 2)

        # 1. GCP 步骤1与步骤2初始检查（群白名单、总开关、黑名单关键词）
        if hasattr(plugin, "_perform_initial_checks"):
            res = await plugin._perform_initial_checks(event)
            should_continue = res[0]
            if not should_continue:
                return Decision(
                    verdict="ignore",
                    reason="GCP 初始检查未通过（群未启用/黑名单词/非群聊）",
                    elapsed_ms=elapsed(),
                    detail={"stage": "initial_checks", "enabled": False}
                )
            _, platform_name, is_private, chat_id = res
        else:
            is_private = message.is_private
            chat_id = message.user_id if is_private else (message.group_id or message.user_id)
            platform_name = event.get_platform_name()

        # 2. 检查触发器（@ 消息与触发关键词）
        is_at_message = False
        has_trigger_keyword = False
        matched_trigger_keyword = ""
        if hasattr(plugin, "_check_message_triggers"):
            res = await plugin._check_message_triggers(event)
            if len(res) >= 3:
                is_at_message, has_trigger_keyword, matched_trigger_keyword = res[:3]
            elif len(res) >= 2:
                is_at_message, has_trigger_keyword = res[:2]
        else:
            is_at_message = message.at_bot

        # 3. 概率筛选（@ 消息或命中关键词时跳过）
        skipped_prob = is_at_message or has_trigger_keyword
        if not skipped_prob:
            passed = await plugin._check_probability(
                platform_name,
                is_private,
                chat_id,
                event,
            )
            if not passed:
                return Decision(
                    verdict="ignore",
                    reason="未通过 GCP 读空气概率筛选",
                    elapsed_ms=elapsed(),
                )

        # 4. 读空气 AI 判定
        formatted_context = await self._format_context(plugin, event, message, history)
        should_reply = await plugin._check_ai_decision(
            event,
            formatted_context,
            is_at_message,
            has_trigger_keyword,
            None,
            matched_trigger_keyword=matched_trigger_keyword,
            original_message_text=message.text,
        )

        if not should_reply:
            return Decision(
                verdict="ignore",
                reason="GCP 决策 AI 判定本次不回复",
                elapsed_ms=elapsed(),
            )

        # 判定通过：有 @ 或关键词则 direct，否则 auto（主动接话）
        if is_at_message or has_trigger_keyword:
            reason = "@ 机器人直接回复" if is_at_message else f"命中关键词「{matched_trigger_keyword}」直接回复"
            return Decision(
                verdict="direct",
                reason=reason,
                elapsed_ms=elapsed(),
            )

        return Decision(
            verdict="auto",
            reason="GCP 读空气判定主动接话",
            elapsed_ms=elapsed(),
        )

    async def _format_context(
        self,
        plugin: Any,
        event: Any,
        message: InboundMessage,
        history: list[dict] | None,
    ) -> str:
        try:
            from astrbot_plugin_group_chat_plus.utils import ContextManager
            return await ContextManager.format_context_for_ai(
                build_history(history, is_private=message.is_private),
                message.text,
                event.get_self_id(),
                include_timestamp=bool(getattr(plugin, "include_timestamp", True)),
                include_sender_info=bool(getattr(plugin, "include_sender_info", True)),
            )
        except Exception:
            return message.text


def build_history(
    history: list[dict] | None,
    *,
    is_private: bool = False,
) -> list[AstrBotMessage]:
    out: list[AstrBotMessage] = []
    for raw in history or []:
        if not isinstance(raw, dict):
            continue
        msg = AstrBotMessage()
        msg.type = MessageType.FRIEND_MESSAGE if is_private else MessageType.GROUP_MESSAGE
        msg.self_id = str(raw.get("selfId") or raw.get("self_id") or "")
        msg.message_id = str(raw.get("messageId") or raw.get("message_id") or "")
        msg.group_id = str(raw.get("groupId") or raw.get("group_id") or "")
        msg.message_str = str(raw.get("text") or raw.get("content") or raw.get("message") or "")
        msg.session_id = str(raw.get("sessionId") or raw.get("session_id") or msg.group_id)
        try:
            msg.timestamp = int(raw.get("timestamp") or 0)
        except (TypeError, ValueError):
            msg.timestamp = 0
        msg.sender.user_id = str(raw.get("userId") or raw.get("user_id") or "")
        msg.sender.nickname = str(raw.get("userName") or raw.get("user_name") or raw.get("nickname") or "")
        out.append(msg)
    return out


__all__ = ["DEFAULT_TIMEOUT_MS", "DecisionEngine", "build_history"]
