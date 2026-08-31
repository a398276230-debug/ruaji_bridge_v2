"""host_server.py —— 统一宿主的 HTTP 面（默认 127.0.0.1:8870）。

## 端点

    POST /api/v1/events          转发一条群消息或生命周期事件，让学习与记忆插件摄取
    POST /api/v1/decision        问 GCP：这条要不要回（direct/auto/ignore）
    POST /api/v1/context/enrich  取三个插件的上下文块
    POST /api/v1/result/decorate 装饰模型生成的最终文本（OnDecoratingResultEvent 能力）
    GET  /health                 分层就绪
    GET  /api/v1/tools           Hermes 工具清单
    POST /api/v1/tools/call      调用一件工具
    GET  /api/v1/introspect      宿主 Handler 派发状态与缺口自省

## 只监听 127.0.0.1

不是为了"更安全一点"，而是因为这些端点没有任何鉴权：谁能连上就能读全部
长期记忆、能往里写记忆。它的调用方（Bridge v2、Hermes Agent）都在本机，
所以绑回环是正确的部署形态而不是保守选择。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import signal
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import bootstrap  # noqa: F401 —— 必须先摆好 sys.path

from aiohttp import web

# 确保日志落地到 data/unified_host.log
_log_dir = Path(__file__).resolve().parent / "data"
_log_dir.mkdir(parents=True, exist_ok=True)
_file_handler = RotatingFileHandler(
    _log_dir / "unified_host.log",
    maxBytes=10 * 1024 * 1024,
    backupCount=5,
    encoding="utf-8",
)
_file_handler.setFormatter(
    logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(), _file_handler],
)
from astrbot.core import logger
from astrbot.core.message.components import Plain
from astrbot.core.message.message_event_result import MessageEventResult, ResultContentType
from astrbot.core.star.star_handler import EventType, star_handlers_registry
from hermes_layer.context_builder import ContextBuilder, build_event
from hermes_layer.contracts import InboundMessage
from hermes_layer.decision import DecisionEngine
from hermes_layer.dispatch import (
    DISPATCH_TABLE,
    SupportLevel,
    extract_command_args_and_bind,
    resolve_owner,
    run_handlers,
)
from hermes_layer.gateway_client import EndpointConfig
from hermes_layer.tool_registry import ToolRegistry
from hermes_layer.web_services import PluginWebManager
from runtime.config import DEFAULT_CONFIG_PATH, load_config
from runtime.context import UnifiedContext

#: `/api/v1/events` 默认分发给谁（仅记忆插件，GCP 由 /api/v1/decision 统一负责裁决与滑窗缓存）
DEFAULT_EVENT_TARGETS = ("living_memory",)

#: gateway 上可热更新的出站端点。属性名与 providers 通道 id 一一对应。
#: 必须是白名单：channel_id 来自请求体，裸 getattr 会摸到 gateway.client
#: （httpx.AsyncClient，同样有 base_url）这类内部对象。
GATEWAY_ENDPOINTS = ("llm", "embedding", "rerank")

#: 单个插件摄取一条消息的预算
EVENT_TIMEOUT_S = 20.0


def _json(payload: Any, status: int = 200) -> web.Response:
    """统一的 JSON 响应。"""
    return web.json_response(
        payload,
        status=status,
        dumps=lambda obj: json.dumps(obj, ensure_ascii=False, default=str),
    )


async def _read_json(request: web.Request) -> dict[str, Any]:
    """读请求体。"""
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise web.HTTPBadRequest(
            text=json.dumps({"ok": False, "error": "bad_json", "message": str(exc)}, ensure_ascii=False),
            content_type="application/json",
        ) from exc
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(
            text=json.dumps({"ok": False, "error": "bad_json", "message": "请求体必须是 JSON 对象"}, ensure_ascii=False),
            content_type="application/json",
        )
    return body


class HostServer:
    """把 UnifiedContext 暴露成 HTTP。"""

    def __init__(self, unified: UnifiedContext) -> None:
        self.unified = unified
        server = dict(unified.config.get("server") or {})
        self.host = str(server.get("host") or "127.0.0.1")
        self.port = int(server.get("port") or 8870)

        self.context_builder = ContextBuilder(
            unified,
            timeout_ms=int(server.get("enrich_timeout_ms") or 2500),
        )
        self.decision = DecisionEngine(unified)
        self.tools = ToolRegistry(unified)

        events_cfg = dict(unified.config.get("events") or {})
        targets = events_cfg.get("dispatch_to") or list(DEFAULT_EVENT_TARGETS)
        self.event_targets = tuple(str(t) for t in targets)

        self.app = self._build_app()
        self._runner: web.AppRunner | None = None
        self.web_manager = PluginWebManager(unified)

    # ------------------------------------------------------------------
    # 路由
    # ------------------------------------------------------------------

    def _build_app(self) -> web.Application:
        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.add_routes(
            [
                web.get("/", self.handle_index),
                web.get("/health", self.handle_health),
                web.post("/api/v1/events", self.handle_events),
                web.post("/api/v1/decision", self.handle_decision),
                web.post("/api/v1/context/enrich", self.handle_enrich),
                web.post("/api/v1/result/decorate", self.handle_decorate),
                web.get("/api/v1/tools", self.handle_tools),
                web.post("/api/v1/tools/call", self.handle_tool_call),
                web.get("/api/v1/introspect", self.handle_introspect),
                web.get("/api/v1/plugins/pages", self.handle_plugins_pages),
                web.get("/api/v1/overview", self.handle_overview),
                web.get("/api/v1/providers", self.handle_providers),
                web.post("/api/v1/providers/update", self.handle_providers_update),
                web.get("/api/v1/memes", self.handle_memes_list),
                web.post("/api/v1/memes/upsert", self.handle_memes_upsert),
                web.post("/api/v1/memes/delete", self.handle_memes_delete),
                web.get("/api/v1/memes/settings", self.handle_memes_settings),
                web.post("/api/v1/memes/settings", self.handle_memes_settings_update),
            ]
        )
        return app

    async def handle_index(self, request: web.Request) -> web.Response:  # noqa: ARG002
        return _json(
            {
                "name": str((self.unified.config.get("host") or {}).get("name") or "统一 AstrBot 宿主"),
                "shadowMode": bool((self.unified.config.get("host") or {}).get("shadow_mode", True)),
                "endpoints": [
                    "GET  /health",
                    "POST /api/v1/events",
                    "POST /api/v1/decision",
                    "POST /api/v1/context/enrich",
                    "POST /api/v1/result/decorate",
                    "GET  /api/v1/tools",
                    "POST /api/v1/tools/call",
                    "GET  /api/v1/introspect",
                ],
            }
        )

    async def handle_health(self, request: web.Request) -> web.Response:
        snapshot = self.unified.health_snapshot()
        if request.query.get("probe") in ("1", "true", "yes"):
            snapshot["probe"] = await self.unified.gateway.probe()
        status = 200 if snapshot.get("status") != "unhealthy" else 503
        return _json(snapshot, status=status)

    # ---------- events ----------

    async def handle_events(self, request: web.Request) -> web.Response:
        body = await _read_json(request)
        event_type = str(body.get("event") or body.get("type") or "message.received")

        # 1. 助手回复事件 (llm.response) —— 触发 LivingMemory 记忆反思与轮次统计
        if event_type == "llm.response" or body.get("role") == "assistant":
            results = await self._dispatch_llm_response(body)
            return _json({"ok": True, "event": "llm.response", "dispatched": results})

        # 2. 消息已送达事件 (message.sent) —— 触发 OnAfterMessageSentEvent
        if event_type == "message.sent":
            results = await self._dispatch_message_sent(body)
            return _json({"ok": True, "event": "message.sent", "dispatched": results})

        # 3. 正常用户消息事件 (message.received)
        message = InboundMessage.from_payload(body)
        if not message.text and not message.raw:
            return _json({"ok": False, "error": "empty_message"}, status=400)

        dispatched_reports, cmd_results = await self._dispatch_event(message)
        reply_texts = []
        for cr in cmd_results:
            if hasattr(cr, "get_plain_text"):
                t = cr.get_plain_text().strip()
                if t:
                    reply_texts.append(t)
            elif getattr(cr, "chain", None):
                t = "".join(getattr(c, "text", "") for c in cr.chain).strip()
                if t:
                    reply_texts.append(t)

        return _json(
            {
                "ok": True,
                "sessionId": message.session_id,
                "messageId": message.message_id,
                "dispatched": dispatched_reports,
                "commandResults": len(cmd_results),
                "reply": "\n".join(reply_texts) if reply_texts else None,
            }
        )

    async def _dispatch_llm_response(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        from astrbot.core.provider.entities import LLMResponse

        inner_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        completion_text = str(
            payload.get("completion_text")
            or payload.get("completionText")
            or payload.get("text")
            or payload.get("reply")
            or inner_payload.get("completion_text")
            or inner_payload.get("completionText")
            or inner_payload.get("text")
            or ""
        ).strip()

        message = InboundMessage.from_payload({**inner_payload, **payload})
        event = build_event(message, self_id=str((self.unified.config.get("identity") or {}).get("robot_id") or ""))
        resp = LLMResponse(completion_text=completion_text, role="assistant")

        out: list[dict[str, Any]] = []
        handlers = star_handlers_registry.get_handlers_by_event_type(EventType.OnLLMResponseEvent)

        # 默认只派发给 living_memory 等支持的目标插件
        spec = DISPATCH_TABLE.get(EventType.OnLLMResponseEvent)
        allowed_targets = spec.default_targets if spec else ("all",)

        for h in handlers:
            key = resolve_owner(h, self.unified.mounts)
            if allowed_targets and "all" not in allowed_targets and key not in allowed_targets:
                continue
            entry: dict[str, Any] = {"plugin": key, "handler": getattr(h, "handler_name", "unknown")}
            started = time.perf_counter()
            try:
                fn = getattr(h, "handler", None)
                if fn:
                    res = fn(event, resp)
                    if hasattr(res, "__aiter__"):
                        async for _ in res:
                            pass
                    elif asyncio.iscoroutine(res):
                        await asyncio.wait_for(res, timeout=EVENT_TIMEOUT_S)
                entry["ok"] = True
            except Exception as exc:
                entry["error"] = f"{type(exc).__name__}: {exc}"
                logger.exception("插件 %s 执行 OnLLMResponse 失败", key)
            entry["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
            out.append(entry)

        # 消费清理：机器人回复产生后，将对应群聊在 GCP 中已消费的 pending 消息缓存清空
        try:
            gcp_mount = self.unified.mounts.get("group_chat_plus")
            gcp_inst = getattr(gcp_mount, "instance", None) or gcp_mount
            if gcp_inst and hasattr(gcp_inst, "cache_manager"):
                cm = gcp_inst.cache_manager
                for k in [
                    f"aiocqhttp_group_{message.group_id}",
                    str(message.group_id),
                    f"aiocqhttp_friend_{message.user_id}",
                    str(message.user_id),
                ]:
                    if k and hasattr(cm, "pending_messages_cache") and k in cm.pending_messages_cache:
                        cm.pending_messages_cache[k] = []
        except Exception as e:
            logger.debug("GCP 缓存消费清理跳过: %s", e)

        return out

    async def _dispatch_message_sent(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        inner_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
        combined = {**inner_payload, **payload}
        message = InboundMessage.from_payload(combined)
        self_id = str((self.unified.config.get("identity") or {}).get("robot_id") or "")
        event = build_event(message, self_id=self_id)

        handlers = star_handlers_registry.get_handlers_by_event_type(EventType.OnAfterMessageSentEvent)
        reports, _ = await run_handlers(event, handlers, mounts=self.unified.mounts, timeout_s=EVENT_TIMEOUT_S)
        return reports

    async def _dispatch_event(self, message: InboundMessage) -> tuple[list[dict[str, Any]], list[MessageEventResult]]:
        """把消息交给记忆/学习插件的消息处理器，并收集命令结果。"""
        self_id = str((self.unified.config.get("identity") or {}).get("robot_id") or "")
        out_reports: list[dict[str, Any]] = []
        all_cmd_results: list[MessageEventResult] = []

        for key in self.event_targets:
            if key not in self.unified.mounts:
                continue
            handlers = [
                h
                for h in star_handlers_registry.get_handlers_by_event_type(EventType.AdapterMessageEvent)
                if resolve_owner(h, self.unified.mounts) == key
            ]
            entry: dict[str, Any] = {"plugin": key, "handlers": len(handlers)}
            if not handlers:
                entry["note"] = "该插件没有注册消息处理器"
                out_reports.append(entry)
                continue

            event = build_event(message, self_id=self_id)
            started = time.perf_counter()
            try:
                reports, cmd_res = await run_handlers(
                    event, handlers, mounts=self.unified.mounts, timeout_s=EVENT_TIMEOUT_S
                )
                all_cmd_results.extend(cmd_res)
                entry["reports"] = reports
                entry["ok"] = True
            except asyncio.TimeoutError:
                entry["error"] = f"timeout>{EVENT_TIMEOUT_S:.0f}s"
                logger.warning("插件 %s 摄取消息超过 %.0fs", key, EVENT_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                entry["error"] = f"{type(exc).__name__}: {exc}"
                logger.exception("插件 %s 摄取消息失败", key)
            entry["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
            entry["stopped"] = bool(event.is_stopped())
            out_reports.append(entry)

        return out_reports, all_cmd_results

    # ---------- result.decorate ----------

    async def handle_decorate(self, request: web.Request) -> web.Response:
        body = await _read_json(request)
        raw_text = str(body.get("text") or body.get("rawText") or body.get("content") or "")
        if not raw_text:
            return _json({"ok": True, "text": ""})

        inbound_data = body.get("inbound") if isinstance(body.get("inbound"), dict) else body
        message = InboundMessage.from_payload(inbound_data)
        self_id = str((self.unified.config.get("identity") or {}).get("robot_id") or "")
        event = build_event(message, self_id=self_id)

        # 构造 LLM 最终结果
        result_obj = MessageEventResult()
        result_obj.result_content_type = ResultContentType.LLM_RESULT
        result_obj.chain = [Plain(text=raw_text)]
        event.set_result(result_obj)

        handlers = star_handlers_registry.get_handlers_by_event_type(EventType.OnDecoratingResultEvent)
        reports, _ = await run_handlers(event, handlers, mounts=self.unified.mounts, timeout_s=5.0)

        final_res = event.get_result()
        if final_res and getattr(final_res, "chain", None):
            final_text = "".join(getattr(c, "text", "") for c in final_res.chain)
        else:
            final_text = raw_text

        return _json(
            {
                "ok": True,
                "text": final_text,
                "originalText": raw_text,
                "reports": reports,
            }
        )

    # ---------- decision ----------

    async def handle_decision(self, request: web.Request) -> web.Response:
        body = await _read_json(request)
        message = InboundMessage.from_payload(body)
        history = body.get("history") or body.get("contexts") or []
        decision = await self.decision.decide(message, history if isinstance(history, list) else [])
        payload = decision.to_payload()
        payload["ok"] = True
        payload["sessionId"] = message.session_id
        payload["route"] = decision.verdict
        return _json(payload)

    # ---------- enrich ----------

    async def handle_enrich(self, request: web.Request) -> web.Response:
        body = await _read_json(request)
        message = InboundMessage.from_payload(body)
        history = body.get("history") or body.get("contexts") or []
        result = await self.context_builder.enrich(message, history if isinstance(history, list) else [])
        result["ok"] = True
        return _json(result)

    # ---------- tools ----------

    async def handle_tools(self, request: web.Request) -> web.Response:  # noqa: ARG002
        return _json(self.tools.manifest())

    async def handle_tool_call(self, request: web.Request) -> web.Response:
        body = await _read_json(request)
        name = str(body.get("name") or body.get("tool") or "")
        arguments = body.get("arguments") or body.get("args") or {}
        if not isinstance(arguments, dict):
            return _json({"ok": False, "error": "bad_arguments", "message": "arguments 必须是对象"}, status=400)

        # 触发 OnCallingFuncToolEvent 与 OnUsingLLMToolEvent 钩子
        self_id = str((self.unified.config.get("identity") or {}).get("robot_id") or "")
        event = build_event(InboundMessage.from_payload(body), self_id=self_id)

        pre_handlers = star_handlers_registry.get_handlers_by_event_type(EventType.OnCallingFuncToolEvent)
        pre_handlers.extend(star_handlers_registry.get_handlers_by_event_type(EventType.OnUsingLLMToolEvent))
        if pre_handlers:
            await run_handlers(event, pre_handlers, mounts=self.unified.mounts, timeout_s=5.0)

        result = await self.tools.call(name, arguments)

        # 触发 OnLLMToolRespondEvent 钩子
        post_handlers = star_handlers_registry.get_handlers_by_event_type(EventType.OnLLMToolRespondEvent)
        if post_handlers:
            await run_handlers(event, post_handlers, mounts=self.unified.mounts, timeout_s=5.0)

        return _json(result)

    # ---------- introspect ----------

    async def handle_introspect(self, request: web.Request) -> web.Response:  # noqa: ARG002
        handler_items: list[dict[str, Any]] = []
        for h in star_handlers_registry._handlers:
            spec = DISPATCH_TABLE.get(h.event_type)
            ev_name = getattr(h.event_type, "name", str(h.event_type))
            owner = resolve_owner(h, self.unified.mounts)
            handler_items.append(
                {
                    "handlerFullName": getattr(h, "handler_full_name", ""),
                    "handlerName": getattr(h, "handler_name", ""),
                    "module": getattr(h, "handler_module_path", ""),
                    "plugin": owner,
                    "eventType": ev_name,
                    "source": spec.source if spec else "unknown",
                    "level": spec.level.value if spec else "unknown",
                    "willBeCalled": spec is not None and spec.level != SupportLevel.UNSUPPORTED,
                    "priority": getattr(h, "extras_configs", {}).get("priority", 0),
                    "desc": getattr(h, "desc", ""),
                }
            )

        table_data = {
            ev.name: {
                "source": spec.source,
                "level": spec.level.value,
                "defaultTargets": list(spec.default_targets),
                "description": spec.description,
            }
            for ev, spec in DISPATCH_TABLE.items()
        }

        return _json(
            {
                "ok": True,
                "totalHandlers": len(handler_items),
                "handlers": handler_items,
                "dispatchTable": table_data,
            }
        )

    async def handle_plugins_pages(self, request: web.Request) -> web.Response:  # noqa: ARG002
        """返回所有插件的 Web 前端页面导航清单（支持通用新插件自动发现）"""
        pages = [
            {
                "id": "group_chat_plus",
                "title": "群聊增强 (GCP)",
                "category": "chat",
                "icon": "comments",
                "port": 1451,
                "url": "http://127.0.0.1:1451",
                "description": "拟人化回复、注意力热力图与读空气概率控制",
                "enabled": "group_chat_plus" in self.unified.mounts,
            },
            {
                "id": "living_memory",
                "title": "生动记忆 (LivingMemory)",
                "category": "memory",
                "icon": "brain",
                "port": 8878,
                "url": "http://127.0.0.1:8878/dashboard/",
                "description": "原子记忆图谱、记忆整合与多路 RAG 检索大盘",
                "enabled": "living_memory" in self.unified.mounts,
            },
        ]
        
        # 动态扫描未来新插件注册的页面
        registered_custom = getattr(self.unified.context, "registered_web_pages", [])
        for p in registered_custom:
            if isinstance(p, dict) and p.get("name") not in [item["id"] for item in pages]:
                pages.append({
                    "id": p.get("name", "custom_plugin"),
                    "title": p.get("title", p.get("name", "新插件")),
                    "category": "plugin",
                    "icon": p.get("icon", "puzzle-piece"),
                    "port": p.get("port", self.port),
                    "url": p.get("url", f"http://127.0.0.1:{self.port}/{p.get('route', '')}"),
                    "description": p.get("description", "第三方扩展插件页面"),
                    "enabled": True,
                })

        return _json({"ok": True, "pages": pages})

    def _default_llm_model(self) -> str:
        """当前生效的全局默认 LLM 模型。

        以运行时 gateway 为准而不是配置文件：模型可以被 /providers/update 热切换，
        这时 config.yaml 已经写回但进程内的 EndpointConfig 才是实际发出去的那个。
        """
        endpoint = getattr(getattr(self.unified, "gateway", None), "llm", None)
        providers = self.unified.config.get("providers") or {}
        return str(
            getattr(endpoint, "model", "")
            or (providers.get("llm") or {}).get("model", "")
        )

    async def handle_overview(self, request: web.Request) -> web.Response:  # noqa: ARG002
        """返回统一宿主全局总览信息"""
        data_dir = Path(self.unified.data_root)
        storage_stats = {}
        if data_dir.is_dir():
            for p in (data_dir / "plugin_data").glob("*"):
                if p.is_dir():
                    size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                    storage_stats[p.name] = {
                        "sizeBytes": size,
                        "sizeReadable": f"{size / (1024*1024):.2f} MB" if size > 1024*1024 else f"{size / 1024:.2f} KB",
                    }

        health = self.unified.health_snapshot()
        persona_info = {
            "default": self.unified.context.persona_manager.default_persona_id,
            "soulPath": getattr(self.unified.context.persona_manager, "store_path", ""),
            "totalPersonas": len(self.unified.context.persona_manager.personas),
        }

        return _json({
            "ok": True,
            "host": {
                "name": str((self.unified.config.get("host") or {}).get("name") or "统一 AstrBot 宿主"),
                "status": health.get("status", "healthy"),
                "shadowMode": bool((self.unified.config.get("host") or {}).get("shadow_mode", True)),
                "port": self.port,
                "defaultModel": self._default_llm_model(),
            },
            "plugins": {
                "mounted": len(self.unified.mounts),
                "details": {k: {"version": getattr(v.metadata, "version", "?"), "handlers": len(getattr(v, "handlers", []))} for k, v in self.unified.mounts.items()},
            },
            "persona": persona_info,
            "storage": storage_stats,
        })

    async def handle_providers(self, request: web.Request) -> web.Response:  # noqa: ARG002
        """返回接口供应商池 (Providers Channel Pool) 列表与状态"""
        raw_providers = self.unified.config.get("providers") or {}
        providers_list = []
        for pid, pcfg in raw_providers.items():
            if isinstance(pcfg, dict):
                raw_key = str(pcfg.get("api_key") or os.getenv(str(pcfg.get("api_key_env") or ""), ""))
                masked_key = (raw_key[:3] + "..." + raw_key[-4:]) if len(raw_key) > 8 else ("已设置" if raw_key else "未设置")
                providers_list.append({
                    "id": pid,
                    "type": pcfg.get("type") or ("chat_completion" if pid == "llm" else pid),
                    "baseUrl": pcfg.get("base_url", "-"),
                    "model": pcfg.get("model", ""),
                    "apiKeyEnv": pcfg.get("api_key_env", ""),
                    "apiKeyMasked": masked_key,
                    "hasKey": bool(raw_key),
                    "timeoutS": pcfg.get("timeout_s", 60),
                    "active": True,
                })

        # 可选模型清单由已注册的聊天 Provider 推出，避免前端再硬编码一份
        available_models: list[str] = []
        for prov in self.unified.context.get_all_providers():
            name = str(getattr(prov, "model_name", "") or "")
            if name and name not in available_models:
                available_models.append(name)

        return _json({
            "ok": True,
            "total": len(providers_list),
            "providers": providers_list,
            "availableModels": available_models,
            "defaults": {
                "chat": self.unified.config.get("default_provider", "llm"),
                "defaultModel": self._default_llm_model(),
                "embedding": (self.unified.config.get("livingmemory") or {}).get("embedding_provider", "embedding"),
                "rerank": (self.unified.config.get("livingmemory") or {}).get("rerank_provider", "rerank"),
            }
        })

    def _config_path(self) -> str:
        """回写 YAML 时用的真实路径。

        load_config 会把解析到的绝对路径写进 config["host"]["config_path"]
        （runtime/config.py），所以 `-c 自定义配置` 启动时也对得上。直接取
        DEFAULT_CONFIG_PATH 会把改动写进另一个文件，重启就没了。
        """
        return str((self.unified.config.get("host") or {}).get("config_path") or DEFAULT_CONFIG_PATH)

    async def handle_providers_update(self, request: web.Request) -> web.Response:
        """在线更新指定供应商接口通道的 Base URL、Model 或 Key"""
        body = await _read_json(request)
        channel_id = str(body.get("id") or "").strip()
        if not channel_id:
            raise web.HTTPBadRequest(text=json.dumps({"ok": False, "error": "missing_id"}, ensure_ascii=False))

        new_base_url = str(body.get("baseUrl") or "").strip()
        new_model = str(body.get("model") or "").strip()
        new_api_key = str(body.get("apiKey") or "").strip()

        import yaml
        cfg_path = self._config_path()
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg_data = yaml.safe_load(f) or {}

        providers_dict = cfg_data.setdefault("providers", {})
        target = providers_dict.setdefault(channel_id, {})
        if new_base_url:
            target["base_url"] = new_base_url
        if new_model:
            target["model"] = new_model
        if new_api_key:
            target["api_key"] = new_api_key

        with open(cfg_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg_data, f, allow_unicode=True, sort_keys=False)

        # 内存配置同步
        mem_target = self.unified.config.setdefault("providers", {}).setdefault(channel_id, {})
        if new_base_url:
            mem_target["base_url"] = new_base_url
        if new_model:
            mem_target["model"] = new_model
        if new_api_key:
            mem_target["api_key"] = new_api_key

        # 热同步到出站网关。GatewayClient 每次请求都重读 EndpointConfig 的字段，
        # 所以原地改就能立刻生效，不用重建连接池。三个通道一视同仁——之前只同步
        # llm，改 embedding/rerank 会写进 yaml 但进程内仍走旧值，直到重启才对上。
        if channel_id in GATEWAY_ENDPOINTS:
            endpoint = getattr(self.unified.gateway, channel_id, None)
            if isinstance(endpoint, EndpointConfig):
                if new_base_url:
                    endpoint.base_url = new_base_url
                if new_model:
                    endpoint.model = new_model
                if new_api_key:
                    endpoint.api_key = new_api_key

        # 默认 LLM 模型换了，还要连带刷新 Provider 实例上的 model_name
        if new_model and channel_id == "llm":
            self.unified.set_default_llm_model(new_model)

        warning = ""
        if new_model and channel_id == "embedding":
            # 换 embedding 模型而不重建索引，检索不会报错，只会静默地返回错误结果。
            warning = "embedding 模型已切换，但现有 FAISS 索引是旧模型建的；重建索引前检索结果不可信。"
            logger.warning("[接口池更新] %s", warning)

        effective_model = new_model or mem_target.get("model") or ""
        logger.info(
            "[接口池更新] 供应商通道 %s 接口配置已成功更新并写回 config.yaml (model=%s)",
            channel_id,
            effective_model or "-",
        )
        return _json({
            "ok": True,
            "msg": f"通道 {channel_id} 配置已更新并持久化",
            "id": channel_id,
            "model": effective_model,
            "warning": warning,
        })

    # ------------------------------------------------------------------
    # 社区梗库（面板 CRUD + 梗雷达开关）
    # ------------------------------------------------------------------

    def _meme_store(self) -> Any:
        store = getattr(self.unified, "meme_store", None)
        if store is None:
            raise web.HTTPServiceUnavailable(
                text=json.dumps({"ok": False, "error": "meme_store_unavailable"}, ensure_ascii=False)
            )
        return store

    async def handle_memes_list(self, request: web.Request) -> web.Response:
        """列出梗库全部条目，供面板渲染。"""
        limit = int(request.query.get("limit") or 200)
        return _json(await self._meme_store().list_all_memes(limit=limit))

    async def handle_memes_upsert(self, request: web.Request) -> web.Response:
        """面板新增/编辑一条梗。

        面板传 merge=False（默认）整条覆盖 —— 用户在输入框里删掉一个别名就该
        真的删掉；模型侧的 record_community_meme 走 merge=True 只做补充。
        """
        body = await _read_json(request)
        result = await self._meme_store().record_meme(
            term=str(body.get("term") or ""),
            meaning=str(body.get("meaning") or ""),
            origin=str(body.get("origin") or ""),
            examples=list(body.get("examples") or []),
            aliases=list(body.get("aliases") or []),
            tags=list(body.get("tags") or []),
            meme_id=body.get("id"),
            merge=bool(body.get("merge", False)),
        )
        return _json(result)

    async def handle_memes_delete(self, request: web.Request) -> web.Response:
        body = await _read_json(request)
        result = await self._meme_store().delete_meme(
            term=str(body.get("term") or ""), meme_id=body.get("id")
        )
        return _json(result)

    async def handle_memes_settings(self, request: web.Request) -> web.Response:  # noqa: ARG002
        cfg = self.unified.config.get("community_memes") or {}
        return _json({
            "ok": True,
            "settings": {
                "enabled": cfg.get("enabled", True) is not False,
                "injectLimit": int(cfg.get("inject_limit", 2)),
                "minScore": float(cfg.get("min_score", 0.45)),
            },
        })

    async def handle_memes_settings_update(self, request: web.Request) -> web.Response:
        """改梗雷达开关/条数/阈值，写回 config.yaml 并即刻生效。"""
        body = await _read_json(request)
        patch: dict[str, Any] = {}
        if "enabled" in body:
            patch["enabled"] = bool(body["enabled"])
        if "injectLimit" in body:
            patch["inject_limit"] = max(1, min(int(body["injectLimit"]), 10))
        if "minScore" in body:
            patch["min_score"] = max(0.0, min(float(body["minScore"]), 1.0))

        import yaml
        cfg_path = self._config_path()
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg_data = yaml.safe_load(f) or {}
        cfg_data.setdefault("community_memes", {}).update(patch)
        with open(cfg_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg_data, f, allow_unicode=True, sort_keys=False)

        # 内存配置同步：ContextBuilder 每轮现读 config，改完立刻生效，不用重启
        self.unified.config.setdefault("community_memes", {}).update(patch)
        logger.info("[社区梗库] 梗雷达设置已更新: %s", patch)
        return await self.handle_memes_settings(request)

    async def start(self) -> None:
        self._runner = web.AppRunner(self.app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        logger.info(
            "统一宿主已监听 http://%s:%d | 影子模式=%s",
            self.host,
            self.port,
            bool((self.unified.config.get("host") or {}).get("shadow_mode", True)),
        )
        # 同时拉起三个插件的原生 Web 面板 (:1451, :7833, :8878)
        await self.web_manager.start()

    async def stop(self) -> None:
        await self.web_manager.stop()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None


# ======================================================================
# 入口
# ======================================================================


def _install_stop_signal(stop: asyncio.Event) -> None:
    """Ctrl-C / SIGTERM 转成一个 Event。"""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, AttributeError, ValueError):
            with contextlib.suppress(ValueError, OSError, AttributeError):
                signal.signal(sig, lambda *_: stop.set())


async def run(config_path: str | None = None, self_check: bool = False) -> int:
    config = load_config(config_path)
    unified = UnifiedContext(config)

    try:
        await unified.start()
    except Exception:
        logger.exception("宿主装配失败")
        await unified.close()
        return 1

    server = HostServer(unified)
    server.tools.export()

    if self_check:
        snapshot = unified.health_snapshot()
        print(json.dumps(snapshot, ensure_ascii=False, indent=2, default=str))
        print(json.dumps(server.tools.manifest(), ensure_ascii=False, indent=2, default=str))
        ok = snapshot.get("status") != "unhealthy" and len(server.tools.names) == 6
        await unified.close()
        return 0 if ok else 1

    stop = asyncio.Event()
    _install_stop_signal(stop)
    await server.start()
    try:
        await stop.wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        logger.info("收到停止信号，开始关闭")
        await server.stop()
        await unified.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="统一 AstrBot 宿主")
    parser.add_argument("-c", "--config", default=None, help=f"配置文件路径（默认 {DEFAULT_CONFIG_PATH}）")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="只装配并打印健康快照与工具清单，不监听端口",
    )
    args = parser.parse_args(argv)

    try:
        return asyncio.run(run(args.config, self_check=args.self_check))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
