"""GroupChatPlus 插件适配器。

将 GCP 的两类能力（回复裁决 / 群聊滑窗上下文注入）收敛至
``UnifiedPluginContract`` 标准接口。

**裁决流程**仍然委托 GCP 原生私有方法执行，但在适配器内部做
防御性 ``hasattr`` 检查与版本兼容 fallback，使得 GCP 内部重构
不会导致宿主裁决链路立刻瘫痪。
"""

from __future__ import annotations

import asyncio
import copy
import datetime
import time
from typing import Any

from astrbot.core import logger
from astrbot.core.platform.astrbot_message import AstrBotMessage
from astrbot.core.platform.message_type import MessageType
from astrbot.core.star.star_handler import EventType, star_handlers_registry

from hermes_layer.contracts import ContextBlock, Decision, InboundMessage, estimate_tokens
from hermes_layer.context_builder import build_event, build_request, _diff
from hermes_layer.dispatch import resolve_owner
from hermes_layer.plugin_contract import HermesTool, UnifiedPluginContract

DEFAULT_TIMEOUT_MS = 15000


class GroupChatPlusAdapter(UnifiedPluginContract):
    """GroupChatPlus 适配器——读空气裁决 + 群聊滑窗上下文。"""

    def __init__(self, unified: Any) -> None:
        self._unified = unified

    # ---- 标识与排序 ----

    @property
    def plugin_key(self) -> str:
        return "group_chat_plus"

    @property
    def execution_order(self) -> int:
        return 20  # 晚于 LivingMemory（10）

    @property
    def decision_priority(self) -> int:
        return 10  # GCP 是主裁决者

    # ---- 生命周期 ----

    async def initialize(self, context: Any, config: dict[str, Any]) -> None:
        pass

    async def terminate(self) -> None:
        pass

    # ---- 回复裁决 ----

    async def decide_reply(
        self,
        message: InboundMessage,
        history: list[dict[str, Any]] | None = None,
    ) -> Decision | None:
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

        cfg = dict(self._unified.config.get("decision") or {})
        timeout_s = max(0.5, int(cfg.get("timeout_ms") or DEFAULT_TIMEOUT_MS) / 1000.0)

        try:
            return await asyncio.wait_for(
                self._run_gcp_pipeline(plugin, event, message, history, started),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            logger.warning("GCP 裁决超时（>%.0fms）", timeout_s * 1000)
            return Decision(
                verdict="ignore",
                reason=f"GCP 决策超时（>{timeout_s * 1000:.0f}ms）",
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
        history: list[dict[str, Any]] | None,
        started: float,
    ) -> Decision:
        def elapsed() -> float:
            return round((time.perf_counter() - started) * 1000, 2)

        # 1. 初始检查（群白名单、总开关、黑名单关键词）
        if hasattr(plugin, "_perform_initial_checks"):
            res = await plugin._perform_initial_checks(event)
            should_continue = res[0]
            if not should_continue:
                return Decision(
                    verdict="ignore",
                    reason="GCP 初始检查未通过（群未启用/黑名单词/非群聊）",
                    elapsed_ms=elapsed(),
                    detail={"stage": "initial_checks", "enabled": False},
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

        # 3. 概率筛选
        def _cache_ignored_message(source: str = "probability_filter") -> None:
            try:
                cm = getattr(plugin, "cache_manager", None)
                if cm and hasattr(cm, "add_to_cache") and message.text:
                    cm.add_to_cache(
                        chat_id,
                        {
                            "role": "user",
                            "content": message.text,
                            "timestamp": time.time(),
                            "message_id": message.message_id,
                            "sender_id": message.user_id,
                            "sender_name": message.user_name,
                            "message_timestamp": int(message.timestamp),
                            "is_at_message": is_at_message,
                            "has_trigger_keyword": has_trigger_keyword,
                            "probability_filtered": True,
                        },
                        source=source,
                    )
            except Exception as e:
                logger.debug("GCP 未回复消息缓存跳过: %s", e)

        skipped_prob = is_at_message or has_trigger_keyword
        if not skipped_prob:
            if hasattr(plugin, "_check_probability"):
                passed = await plugin._check_probability(
                    platform_name, is_private, chat_id, event,
                )
                if not passed:
                    _cache_ignored_message("probability_filter")
                    return Decision(
                        verdict="ignore",
                        reason="未通过 GCP 读空气概率筛选",
                        elapsed_ms=elapsed(),
                    )
            # 缺少 _check_probability 方法则跳过概率检查

        # 4. 读空气 AI 判定
        if hasattr(plugin, "_check_ai_decision"):
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
                _cache_ignored_message("decision_ai_no_reply")
                return Decision(
                    verdict="ignore",
                    reason="GCP 决策 AI 判定本次不回复",
                    elapsed_ms=elapsed(),
                )
        # 缺少 _check_ai_decision 方法则直接通过

        # 判定通过
        if is_at_message or has_trigger_keyword:
            reason = "@ 机器人直接回复" if is_at_message else f"命中关键词「{matched_trigger_keyword}」直接回复"
            return Decision(verdict="direct", reason=reason, elapsed_ms=elapsed())

        return Decision(verdict="auto", reason="GCP 读空气判定主动接话", elapsed_ms=elapsed())

    async def _format_context(
        self, plugin: Any, event: Any, message: InboundMessage, history: list[dict[str, Any]] | None,
    ) -> str:
        try:
            from astrbot_plugin_group_chat_plus.utils import ContextManager
            return await ContextManager.format_context_for_ai(
                _build_history(history, is_private=message.is_private),
                message.text,
                event.get_self_id(),
                include_timestamp=bool(getattr(plugin, "include_timestamp", True)),
                include_sender_info=bool(getattr(plugin, "include_sender_info", True)),
            )
        except Exception:
            return message.text

    # ---- 上下文注入 ----

    async def provide_context(
        self,
        message: InboundMessage,
        history: list[dict[str, Any]] | None = None,
        *,
        prior_blocks: list[ContextBlock] | None = None,
    ) -> list[ContextBlock]:
        """注入群聊滑窗上下文。

        GCP 需要看到 LivingMemory 的完整产出（prior_blocks），以便做
        "差分保留第三方提示词"操作。
        """
        started = time.perf_counter()
        self_id = str(self._unified.config.get("identity", {}).get("robot_id", ""))

        # 直接提取 GCP 的群聊滑窗消息缓存
        cache_blocks = self._extract_cache_context(message, started)
        if cache_blocks:
            return cache_blocks

        # fallback: 运行 GCP 的 on_llm_request 钩子
        event = build_event(message, self_id=self_id)
        req = build_request(message, history)

        # 把前序阶段的 system_prompt 合进去，GCP 才能看到"别人已经写完"
        if prior_blocks:
            prior = "\n\n".join(b.content for b in prior_blocks if b.kind == "system_prompt" and b.content)
            if prior:
                req.system_prompt = prior

        baseline = copy.deepcopy(req)
        handlers = self._handlers_for()
        if not handlers:
            return []

        timeout_s = getattr(self._unified, "_context_timeout_s", 2.5)
        try:
            await asyncio.wait_for(self._invoke(event, req, handlers), timeout=timeout_s)
        except asyncio.TimeoutError:
            elapsed = (time.perf_counter() - started) * 1000
            logger.warning("GCP 上下文注入超时（>%.0fms）", timeout_s * 1000)
            return [
                ContextBlock(
                    source=self.plugin_key, kind="system_prompt",
                    elapsed_ms=elapsed, error=f"timeout>{timeout_s * 1000:.0f}ms",
                )
            ]
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            logger.exception("GCP 上下文注入异常")
            return [
                ContextBlock(
                    source=self.plugin_key, kind="system_prompt",
                    elapsed_ms=elapsed, error=f"{type(exc).__name__}: {exc}",
                )
            ]

        elapsed = (time.perf_counter() - started) * 1000
        produced = _diff(baseline, req, self.plugin_key, elapsed)
        if produced:
            return produced

        return [
            ContextBlock(
                source=self.plugin_key, kind="system_prompt",
                elapsed_ms=elapsed,
                detail={"ran": True, "contributed": False, "handlers": len(handlers)},
            )
        ]

    def _extract_cache_context(self, message: InboundMessage, started: float) -> list[ContextBlock]:
        """直接从 GCP 的 cache_manager 提取群聊滑窗消息。"""
        gcp_mount = self._unified.mounts.get("group_chat_plus")
        inst = getattr(gcp_mount, "instance", None) or gcp_mount
        if not inst or not hasattr(inst, "cache_manager"):
            return []

        possible_keys = [
            f"aiocqhttp_group_{message.group_id}",
            str(message.group_id),
            f"aiocqhttp_friend_{message.user_id}",
            str(message.user_id),
        ]
        cached: list[dict] = []
        for k in possible_keys:
            if k and k in getattr(inst.cache_manager, "pending_messages_cache", {}):
                cached = inst.cache_manager.get_cached_messages(k)
                if cached:
                    break

        if not cached:
            return []

        lines = []
        curr_mid = str(message.message_id or "")
        curr_uid = str(message.user_id or "")
        curr_text = str(message.text or "").strip()

        for msg_item in cached[-10:]:
            m_id = str(msg_item.get("message_id") or "")
            s_id = str(msg_item.get("sender_id") or "")
            content = str(
                msg_item.get("content") or msg_item.get("message_str") or msg_item.get("text") or ""
            ).strip()

            if m_id and curr_mid and m_id == curr_mid:
                continue
            if s_id == curr_uid and content and curr_text and content == curr_text:
                continue
            if content == "@某人":
                continue

            s_name = (
                msg_item.get("sender_name") or msg_item.get("sender_nickname")
                or msg_item.get("sender_display") or "群友"
            )
            ts_val = msg_item.get("message_timestamp") or msg_item.get("timestamp") or msg_item.get("time")
            time_prefix = ""
            if ts_val:
                try:
                    t_float = float(ts_val)
                    if t_float > 1e12:
                        t_float /= 1000.0
                    dt = datetime.datetime.fromtimestamp(t_float)
                    weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
                    weekday = weekday_names[dt.weekday()]
                    time_prefix = dt.strftime(f"[时间:%Y-%m-%d {weekday} %H:%M:%S] ")
                except Exception:
                    time_prefix = f"[时间:{ts_val}] "

            if content:
                lines.append(f"{time_prefix}{s_name}(ID:{s_id}): {content}")

        if not lines:
            return []

        rendered = "\n".join(lines)
        elapsed = (time.perf_counter() - started) * 1000
        return [
            ContextBlock(
                source="group_chat_plus",
                kind="contexts",
                content=rendered,
                tokens_estimate=estimate_tokens(rendered),
                elapsed_ms=elapsed,
                detail={"count": len(lines), "slot": "recent", "dedupeKey": "recent-group-context"},
            )
        ]

    def _handlers_for(self) -> list[Any]:
        return [
            h
            for h in star_handlers_registry.get_handlers_by_event_type(EventType.OnLLMRequestEvent)
            if resolve_owner(h, self._unified.mounts) == self.plugin_key
        ]

    async def _invoke(self, event: Any, req: Any, handlers: list[Any]) -> None:
        for handler in handlers:
            fn = getattr(handler, "handler", None)
            if fn is None:
                continue
            result = fn(event, req)
            if asyncio.iscoroutine(result):
                await result
            elif hasattr(result, "__aiter__"):
                async for _ in result:
                    pass


def _build_history(
    history: list[dict] | None, *, is_private: bool = False,
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


__all__ = ["GroupChatPlusAdapter"]
