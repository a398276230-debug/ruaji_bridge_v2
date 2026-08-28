"""hermes_layer.context_builder —— /api/v1/context/enrich 的实现。

## 它做什么

Bridge v2 送来一条消息，宿主把三个插件的 `@filter.on_llm_request` 钩子跑一遍，
把每个插件往 `ProviderRequest` 上写的东西拆成独立的 ContextBlock 交回去。
Bridge v2 的 ContextAggregator 拿到块数组后自己决定拼装顺序与预算裁剪。

## 为什么不是简单的"并发跑三个"

三个钩子改的是**同一个** ProviderRequest 对象，而且都是 `+=` 到
`system_prompt` 上。直接并发跑同一个 req 有两个问题：

1. **归属丢失。** 跑完只剩一坨拼好的字符串，看不出哪段是谁写的 ——
   Trace Explorer 的 "Context 分配明细" 就没法做。
2. **GCP 会读到不完整的上下文。** GCP 的 on_llm_request（main.py:10674，
   priority=-1）会做"差分保留第三方提示词"：它比较自己写之前和之后的
   system_prompt，把别人加的段落识别出来并保留。它必须看到别人写完的结果。

所以分两阶段：

    阶段 A（并发）  LivingMemory / SelfLearning 各拿一份 req 的独立副本，
                   互不可见，跑完各自 diff 出自己的块。
    阶段 B（串行）  把 A 的块合并进一份 req，再让 GCP 在这份 req 上跑 ——
                   它看到的正是"别人都写完了"的状态。

阶段 A 里两个插件互相看不到对方，这是**符合**语义的：LivingMemory 注入记忆、
SelfLearning 注入语气/黑话，两者不读对方的输出（读了才需要串行）。

## 超时

每个插件有独立预算，超时的插件产出一个带 error 的块而不是拖垮整次聚合 ——
上下文少一块，回复会平淡一点；整次聚合超时，Bridge v2 就只能裸奔。
前者明显更好。
"""

from __future__ import annotations

import asyncio
import copy
import datetime
import time
from typing import Any

from astrbot.core import logger
from astrbot.core.pipeline.context_utils import call_event_hook
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.astrbot_message import AstrBotMessage, PlatformMetadata
from astrbot.core.platform.message_type import MessageType
from astrbot.core.provider.entities import ProviderRequest
from astrbot.core.star.star_handler import EventType, star_handlers_registry

from .contracts import ContextBlock, InboundMessage, estimate_tokens
from .dispatch import resolve_owner

#: 阶段 A 的成员：彼此不读对方输出，可以并发。
CONCURRENT_STAGE = ("living_memory",)

#: 阶段 B 的成员：必须看到别人写完的 system_prompt。
SERIAL_STAGE = ("group_chat_plus",)

#: 插件短名 → 它的模块前缀。用来把 handler 归属到插件。
MODULE_PREFIX = {
    "living_memory": "astrbot_plugin_livingmemory",
    "group_chat_plus": "astrbot_plugin_group_chat_plus",
}

_PLATFORM = PlatformMetadata(
    name="aiocqhttp",
    description="统一宿主接入的 QQ 平台（消息由 Bridge v2 转发）",
    id="aiocqhttp",
)


def build_event(message: InboundMessage, self_id: str = "") -> AstrMessageEvent:
    """从 InboundMessage 造一个插件能用的 AstrMessageEvent。

    这是"影子模式"的关键面：事件的 send_hook 默认只打日志不投递
    （见 astr_message_event._default_send_hook），所以就算某个插件在钩子里
    调了 `event.send(...)`，也不会有任何东西真的发到 QQ ——
    用户离线、NapCat 未扫码期间必须如此。
    """
    from astrbot.api.message_components import At, Plain

    msg = AstrBotMessage()
    msg.type = MessageType.FRIEND_MESSAGE if message.is_private else MessageType.GROUP_MESSAGE
    msg.self_id = message.self_id or self_id
    msg.session_id = message.session_id
    msg.message_id = message.message_id
    msg.group_id = "" if message.is_private else message.group_id
    msg.message_str = message.text
    msg.timestamp = int(message.timestamp)
    msg.raw_message = message.raw or None
    msg.sender.user_id = message.user_id
    msg.sender.nickname = message.user_name

    effective_self_id = message.self_id or self_id or msg.self_id
    chain: list[Any] = []
    if message.at_bot:
        chain.append(At(qq=effective_self_id, name=""))
    # 模型正文（content）优先：CQ 码已由桥接转成 "@昵称"，插件钩子（含 GCP
    # 的 MessageCleaner/GCP 提取链）看到的是可读正文。text 只是它的去 @ 兜底。
    body = message.content or message.text
    if body:
        chain.append(Plain(text=body))
    msg.message = chain

    event = AstrMessageEvent(
        message_str=message.text,
        message_obj=msg,
        platform_meta=_PLATFORM,
        session_id=message.session_id,
    )
    event.role = "admin" if message.role == "admin" else "member"
    # at_bot 就是唤醒。GCP 的多数分支读 is_at_or_wake_command 而不是自己解析消息链。
    event.is_at_or_wake_command = message.at_bot
    event.is_wake = message.at_bot
    return event


def build_request(message: InboundMessage, history: list[dict] | None = None) -> ProviderRequest:
    return ProviderRequest(
        prompt=message.text,
        session_id=message.session_id,
        system_prompt="",
        contexts=list(history or []),
    )


def _owner_of(handler: Any, mounts: dict[str, Any] | None = None) -> str | None:
    """这个 handler 属于哪个插件。动态从 mounts 推导。"""
    return resolve_owner(handler, mounts)


def _diff(baseline: ProviderRequest, after: ProviderRequest, source: str, elapsed_ms: float) -> list[ContextBlock]:
    """比出这个插件到底往 req 上加了什么。

    只看**增量**，不看最终值 —— 插件也可能改写而不是追加（GCP 的第三方提示词
    保留就会重排 system_prompt）。改写的情况下增量取"新值里 baseline 之外的
    部分"，取不出来就整段上报并标 detail.rewritten，宁可多报也不漏报。
    """
    blocks: list[ContextBlock] = []

    old, new = baseline.system_prompt or "", after.system_prompt or ""
    if new != old:
        if new.startswith(old):
            added, rewritten = new[len(old) :], False
        elif old and old in new:
            head, _, tail = new.partition(old)
            added, rewritten = (head + tail), True
        else:
            added, rewritten = new, bool(old)
        added = added.strip()
        if added:
            blocks.append(
                ContextBlock(
                    source=source,
                    kind="system_prompt",
                    content=added,
                    tokens_estimate=estimate_tokens(added),
                    elapsed_ms=elapsed_ms,
                    detail={"rewritten": rewritten} if rewritten else {},
                )
            )

    if len(after.contexts) > len(baseline.contexts):
        extra = after.contexts[len(baseline.contexts) :]
        rendered = "\n".join(str(item.get("content", "")) for item in extra if isinstance(item, dict))
        blocks.append(
            ContextBlock(
                source=source,
                kind="contexts",
                content=rendered,
                tokens_estimate=estimate_tokens(rendered),
                elapsed_ms=elapsed_ms,
                detail={"count": len(extra)},
            )
        )

    if len(after.extra_user_content_parts) > len(baseline.extra_user_content_parts):
        extra_parts = after.extra_user_content_parts[len(baseline.extra_user_content_parts) :]
        rendered = "\n".join(
            str(getattr(part, "text", "") or getattr(part, "content", "")) for part in extra_parts
        )
        slot = "extra"
        blocks.append(
            ContextBlock(
                source=source,
                kind="extra_parts",
                content=rendered,
                tokens_estimate=estimate_tokens(rendered),
                elapsed_ms=elapsed_ms,
                detail={"count": len(extra_parts), "slot": slot},
            )
        )

    return blocks


class ContextBuilder:
    """收集上下文 ContextBlock 数组——委托给已注册的适配器。

    适配器按 ``execution_order`` 分组：同一 order 并发执行，不同 order 串行。
    高 order 的适配器（如 GCP）可以看到低 order（如 LivingMemory）的产出。
    """

    def __init__(self, unified: Any, timeout_ms: int = 2500) -> None:
        self._unified = unified
        self.timeout_s = max(0.2, timeout_ms / 1000.0)
        # 缓存超时供 adapters 读取
        unified._context_timeout_s = self.timeout_s

    # ------------------------------------------------------------------

    async def enrich(
        self,
        message: InboundMessage,
        history: list[dict] | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        self_id = str(self._unified.config.get("identity", {}).get("robot_id", ""))

        # 派发 OnWaitingLLMRequestEvent
        waiting_event = build_event(message, self_id=self_id)
        waiting_req = build_request(message, history)
        waiting_handlers = star_handlers_registry.get_handlers_by_event_type(EventType.OnWaitingLLMRequestEvent)
        for wh in waiting_handlers:
            try:
                fn = getattr(wh, "handler", None)
                if fn:
                    res = fn(waiting_event, waiting_req)
                    if asyncio.iscoroutine(res):
                        await asyncio.wait_for(res, timeout=1.0)
            except Exception as exc:
                logger.warning("OnWaitingLLMRequestEvent handler 执行异常: %s", exc)

        # 面向适配器的分组执行
        adapters = getattr(self._unified, "adapters", None) or []
        blocks: list[ContextBlock] = []

        if adapters:
            # 按 execution_order 分组
            from itertools import groupby
            sorted_adapters = sorted(adapters, key=lambda a: a.execution_order)
            for _order, group in groupby(sorted_adapters, key=lambda a: a.execution_order):
                group_list = list(group)
                if len(group_list) == 1:
                    adapter = group_list[0]
                    if adapter.plugin_key not in self._unified.mounts:
                        continue
                    if hasattr(adapter, 'provide_context'):
                        import inspect
                        sig = inspect.signature(adapter.provide_context)
                        if 'prior_blocks' in sig.parameters:
                            produced = await adapter.provide_context(message, history, prior_blocks=blocks)
                        else:
                            produced = await adapter.provide_context(message, history)
                        blocks.extend(produced)
                else:
                    # 同 order 并发
                    present = [a for a in group_list if a.plugin_key in self._unified.mounts]
                    results = await asyncio.gather(
                        *(a.provide_context(message, history) for a in present)
                    )
                    for produced in results:
                        blocks.extend(produced)
        else:
            # 向后兼容：无适配器时走旧路径
            stage_a = await asyncio.gather(
                *(self._run_plugin(key, message, history, self_id, base_blocks=None) for key in self._present(CONCURRENT_STAGE))
            )
            for produced in stage_a:
                blocks.extend(produced)
            for key in self._present(SERIAL_STAGE):
                blocks.extend(await self._run_plugin(key, message, history, self_id, base_blocks=blocks))

        merged = "\n\n".join(b.content for b in blocks if b.kind == "system_prompt" and b.content)
        context_text = "\n\n".join(b.content for b in blocks if b.content)
        return {
            "sessionId": message.session_id,
            "blocks": [b.to_payload() for b in blocks],
            "systemPrompt": merged,
            "contextText": context_text,
            "tokensEstimate": sum(b.tokens_estimate for b in blocks),
            "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            "degraded": [b.source for b in blocks if b.error],
        }

    def _present(self, keys: tuple[str, ...]) -> list[str]:
        return [k for k in keys if k in self._unified.mounts]

    async def _run_plugin(
        self,
        key: str,
        message: InboundMessage,
        history: list[dict] | None,
        self_id: str,
        base_blocks: list[ContextBlock] | None,
    ) -> list[ContextBlock]:
        """只跑这一个插件的 on_llm_request，然后 diff 出它的贡献。

        每个插件拿自己的 event 与 req 副本。共用一个 event 不行：插件会往
        `event._extras` 里塞中间状态（GCP 尤其多），共用会让 A 的中间状态
        被 B 读到，产生一种只在并发下出现、无法复现的串味。
        """
        event = build_event(message, self_id=self_id)
        req = build_request(message, history)
        baseline = copy.deepcopy(req)

        # 阶段 B：把阶段 A 写的东西先合进去，GCP 才能看到"别人已经写完"。
        if base_blocks:
            prior = "\n\n".join(b.content for b in base_blocks if b.kind == "system_prompt" and b.content)
            if prior:
                req.system_prompt = prior
                baseline = copy.deepcopy(req)

        started = time.perf_counter()

        # GCP 专用：直接提取群滑窗消息缓存
        if key == "group_chat_plus":
            gcp_mount = self._unified.mounts.get("group_chat_plus")
            inst = getattr(gcp_mount, "instance", None) or gcp_mount
            if inst and hasattr(inst, "cache_manager"):
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
                if cached:
                    lines = []
                    curr_mid = str(message.message_id or "")
                    curr_uid = str(message.user_id or "")
                    curr_text = str(message.text or "").strip()

                    for msg_item in cached[-10:]:
                        m_id = str(msg_item.get("message_id") or "")
                        s_id = str(msg_item.get("sender_id") or "")
                        content = str(
                            msg_item.get("content")
                            or msg_item.get("message_str")
                            or msg_item.get("text")
                            or ""
                        ).strip()

                        # 过滤 1：排除当前正在触发回复的这条消息本身（当前消息属于 Prompt，不是历史上下文）
                        if m_id and curr_mid and m_id == curr_mid:
                            continue
                        if s_id == curr_uid and content and curr_text and content == curr_text:
                            continue

                        # 过滤 2：排除纯 @某人 的畸变消息
                        if content == "@某人":
                            continue

                        s_name = (
                            msg_item.get("sender_name")
                            or msg_item.get("sender_nickname")
                            or msg_item.get("sender_display")
                            or "群友"
                        )
                        ts_val = (
                            msg_item.get("message_timestamp")
                            or msg_item.get("timestamp")
                            or msg_item.get("time")
                        )
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
                    if lines:
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

        handlers = self._handlers_for(key)
        if not handlers:
            return []

        try:
            await asyncio.wait_for(self._invoke(event, req, handlers), timeout=self.timeout_s)
        except asyncio.TimeoutError:
            elapsed = (time.perf_counter() - started) * 1000
            logger.warning("插件 %s 的上下文注入超过 %.0fms，本次跳过", key, self.timeout_s * 1000)
            return [
                ContextBlock(
                    source=key,
                    kind="system_prompt",
                    elapsed_ms=elapsed,
                    error=f"timeout>{self.timeout_s * 1000:.0f}ms",
                )
            ]
        except Exception as exc:  # noqa: BLE001 —— 一个插件炸了不该让整次聚合失败
            elapsed = (time.perf_counter() - started) * 1000
            logger.exception("插件 %s 的上下文注入抛异常", key)
            return [
                ContextBlock(
                    source=key,
                    kind="system_prompt",
                    elapsed_ms=elapsed,
                    error=f"{type(exc).__name__}: {exc}",
                )
            ]

        elapsed = (time.perf_counter() - started) * 1000
        produced = _diff(baseline, req, key, elapsed)
        if produced:
            return produced

        # 跑了但什么都没加。必须如实上报一个空块，不能返回空数组 ——
        # 面板上"跑了没贡献"和"根本没跑"是两个完全不同的故障，前者可能是
        # 冷启动（还没记忆可召回），后者是钩子没绑上。两者都显示为"缺这一块"
        # 的话，排查时只能靠猜。
        return [
            ContextBlock(
                source=key,
                kind="system_prompt",
                elapsed_ms=elapsed,
                detail={"ran": True, "contributed": False, "handlers": len(handlers)},
            )
        ]

    def _handlers_for(self, key: str) -> list[Any]:
        return [
            h
            for h in star_handlers_registry.get_handlers_by_event_type(EventType.OnLLMRequestEvent)
            if _owner_of(h, self._unified.mounts) == key
        ]

    async def _invoke(self, event: AstrMessageEvent, req: ProviderRequest, handlers: list[Any]) -> None:
        """按登记顺序调这些 handler。

        不用 `call_event_hook`，因为那个函数按事件类型取**全部**插件的 handler，
        而这里要的是"只跑一个插件的"。`call_event_hook` 仍用在 /api/v1/events
        那条路径上 —— 那里要的正是全量。
        """
        for handler in handlers:
            fn = getattr(handler, "handler", None)
            if fn is None:
                continue
            result = fn(event, req)
            if asyncio.iscoroutine(result):
                await result
            elif hasattr(result, "__aiter__"):
                async for _ in result:  # 异步生成器钩子必须迭代才会执行函数体
                    pass


__all__ = [
    "CONCURRENT_STAGE",
    "SERIAL_STAGE",
    "ContextBuilder",
    "build_event",
    "build_request",
    "call_event_hook",
]
