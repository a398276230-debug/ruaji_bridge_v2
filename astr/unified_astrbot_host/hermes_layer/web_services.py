"""hermes_layer.web_services —— 在统一宿主启动时，顺带拉起插件的原生 Web 面板。

端口映射：
  * :1451 —— Group Chat Plus 管理面板 (aiohttp)
  * :8878 —— LivingMemory 记忆与知识图谱仪表盘 (FastAPI / Uvicorn + QuartBridge)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from urllib.parse import parse_qsl
from typing import Any

from aiohttp import web
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from quart import Quart
import uvicorn

from astrbot.core import logger


class PluginWebManager:
    """管理三个插件的 Web 服务生命周期。"""

    def __init__(self, unified_context: Any) -> None:
        self.unified = unified_context
        self._tasks: list[asyncio.Task] = []
        self._gcp_web: Any = None
        self._lm_server: uvicorn.Server | None = None

    async def start(self) -> None:
        mounts = getattr(self.unified, "mounts", {})
        data_root = Path(getattr(self.unified, "data_root", Path(__file__).resolve().parents[2] / "data"))

        # 1. 启动 Group Chat Plus Web 面板 (:1451)
        if "group_chat_plus" in mounts:
            try:
                from astrbot_plugin_group_chat_plus.web.server import WebPanelServer
                gcp_inst = mounts["group_chat_plus"].instance
                gcp_data_dir = str(data_root / "plugin_data" / "astrbot_plugin_group_chat_plus")
                self._gcp_web = WebPanelServer(gcp_inst, host="0.0.0.0", port=1451, data_dir=gcp_data_dir)
                await self._gcp_web.start()
                logger.info("🌐 [Web面板] Group Chat Plus 面板已启动: http://127.0.0.1:1451/")
            except Exception as e:
                logger.warning("🌐 [Web面板] Group Chat Plus 面板启动失败: %s", e)

        # 2. 启动 LivingMemory 仪表盘与 API (:8878)
        if "living_memory" in mounts:
            try:
                lm_inst = mounts["living_memory"].instance
                lm_spec_path = getattr(mounts["living_memory"].spec, "path", None)
                lm_dir = Path(lm_spec_path) if lm_spec_path and os.path.isdir(lm_spec_path) else Path(__file__).resolve().parents[2] / "astrbot_plugin_livingmemory"
                lm_app = self._build_livingmemory_app(lm_inst, lm_dir)

                config = uvicorn.Config(lm_app, host="127.0.0.1", port=8878, log_level="warning")
                self._lm_server = uvicorn.Server(config)
                task = asyncio.create_task(self._lm_server.serve())
                self._tasks.append(task)
                logger.info("🌐 [Web面板] LivingMemory 记忆图谱面板已启动: http://127.0.0.1:8878/dashboard/")
            except Exception as e:
                logger.warning("🌐 [Web面板] LivingMemory 面板启动失败: %s", e)

    def _build_livingmemory_app(self, lm_inst: Any, lm_dir: Path) -> FastAPI:
        from starlette.middleware.base import BaseHTTPMiddleware

        app = FastAPI(title="LivingMemory Dashboard")
        quart_bridge = Quart("livingmemory_page_bridge")

        class FrameSecurityMiddleware(BaseHTTPMiddleware):
            async def dispatch(self, request, call_next):
                response = await call_next(request)
                response.headers["Content-Security-Policy"] = "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*;"
                response.headers["Access-Control-Allow-Origin"] = "*"
                if "X-Frame-Options" in response.headers:
                    del response.headers["X-Frame-Options"]
                return response

        app.add_middleware(FrameSecurityMiddleware)
        
        dashboard_assets = lm_dir / "pages" / "dashboard"
        if dashboard_assets.exists():
            app.mount("/dashboard/assets", StaticFiles(directory=dashboard_assets), name="livingmemory-dashboard")

        bridge_script = """<script>
window.AstrBotPluginPage = {
  ready: async () => ({plugin_name: 'astrbot_plugin_livingmemory'}),
  getContext: () => ({plugin_name: 'astrbot_plugin_livingmemory'}),
  apiGet: async (path, params={}) => {
    const q = new URLSearchParams(params).toString();
    const r = await fetch('/api/plug/astrbot_plugin_livingmemory/' + path + (q ? '?' + q : ''));
    if (!r.ok) throw new Error(await r.text()); return await r.json();
  },
  apiPost: async (path, body={}) => {
    const r = await fetch('/api/plug/astrbot_plugin_livingmemory/' + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!r.ok) throw new Error(await r.text()); return await r.json();
  }
};
</script>"""

        @app.get("/")
        async def root():
            return RedirectResponse("/dashboard/")

        @app.get("/dashboard/")
        async def dashboard():
            html_file = lm_dir / "pages" / "dashboard" / "index.html"
            if not html_file.exists():
                return HTMLResponse("<h3>Dashboard files not found</h3>")
            html = html_file.read_text(encoding="utf-8")
            html = html.replace('<script type="module" src="./app.js"></script>', bridge_script + '<script type="module" src="/dashboard/assets/app.js"></script>')
            html = html.replace('href="./', 'href="/dashboard/assets/').replace('src="./', 'src="/dashboard/assets/')
            return HTMLResponse(html)

        @app.get("/dashboard/graph-layout-worker.js")
        async def graph_worker():
            from fastapi.responses import FileResponse
            return FileResponse(lm_dir / "pages" / "dashboard" / "graph-layout-worker.js", media_type="application/javascript")

        @app.get("/health/live")
        async def live():
            return {"ok": True, "status": "alive"}

        @app.get("/api/status")
        async def status():
            initialized = bool(getattr(getattr(lm_inst, "initializer", None), "is_initialized", False))
            engine = getattr(getattr(lm_inst, "initializer", None), "memory_engine", None)
            graph = getattr(engine, "graph_store", None) if engine else None
            return {
                "ok": initialized,
                "service": "astrbot_plugin_livingmemory",
                "engine": {"ready": engine is not None},
                "graph": {"ready": graph is not None},
                "initializer": {"initialized": initialized, "failed": False, "error": None}
            }

        @app.api_route("/api/plug/astrbot_plugin_livingmemory/{path:path}", methods=["GET", "POST"])
        async def page_api(path: str, request: Request):
            # 处理 Hermes 专属配置保存 / 查询
            if path.strip("/") in ("page/hermes/config", "hermes/config"):
                from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path
                conf_file = Path(get_astrbot_plugin_data_path()) / "astrbot_plugin_livingmemory" / "config.json"
                if request.method == "POST":
                    incoming = await request.json()
                    saved = json.loads(conf_file.read_text(encoding="utf-8-sig")) if conf_file.is_file() else {}
                    saved.update(incoming)
                    conf_file.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    return {"ok": True, "data": saved, "restart_required": True}
                else:
                    saved = json.loads(conf_file.read_text(encoding="utf-8-sig")) if conf_file.is_file() else {}
                    return {"ok": True, "data": saved, "restart_required": False}

            context = getattr(lm_inst, "context", None)
            if not context:
                raise HTTPException(503, "LivingMemory is not ready")
            
            cleaned = path.strip("/")
            candidates = [
                f"/astrbot_plugin_livingmemory/page/{cleaned}",
                f"/astrbot_plugin_livingmemory/{cleaned}",
                f"/{cleaned}",
                f"astrbot_plugin_livingmemory/page/{cleaned}",
                f"astrbot_plugin_livingmemory/{cleaned}",
                cleaned,
            ]
            registered = None
            for cand in candidates:
                if cand in context.registered_web_apis:
                    registered = context.registered_web_apis[cand]
                    break
            
            if not registered:
                for k, v in context.registered_web_apis.items():
                    if k.strip("/").endswith(cleaned) or cleaned.endswith(k.strip("/")):
                        registered = v
                        break

            if not registered:
                raise HTTPException(404, f"unknown LivingMemory page route: {path}")
            
            # 手动反思总结与记忆整合联动
            if cleaned in ("consolidation/run", "page/consolidation/run"):
                try:
                    init_obj = getattr(lm_inst, "initializer", None)
                    cm = getattr(init_obj, "conversation_manager", None) or getattr(lm_inst, "conversation_manager", None)
                    eh = getattr(lm_inst, "event_handler", None)
                    rf = getattr(eh, "_memory_reflection", None) or getattr(eh, "memory_reflection", None)
                    if cm and rf and getattr(cm.store, "connection", None):
                        cursor = await cm.store.connection.execute("SELECT session_id FROM sessions")
                        rows = await cursor.fetchall()
                        sessions = [r["session_id"] for r in rows] if rows else ["aiocqhttp:GroupMessage:1076958977"]
                        for sid in sessions:
                            cnt = await cm.store.get_message_count(sid)
                            last_idx = await cm.get_session_metadata(sid, "last_summarized_index", 0)
                            try:
                                last_idx = int(last_idx)
                            except Exception:
                                last_idx = 0
                            if cnt > last_idx:
                                msgs = await cm.get_messages_range(sid, last_idx, cnt)
                                if msgs and len(msgs) >= 2:
                                    logger.info("[手动反思总结] 正在处理会话 %s 的未总结消息 (%d~%d, 共 %d 条)...", sid, last_idx, cnt, len(msgs))
                                    await rf._storage_task(
                                        session_id=sid,
                                        history_messages=msgs,
                                        persona_id="ruaji",
                                        start_index=last_idx,
                                        end_index=cnt,
                                        retry_count=0,
                                        memory_scope="livingmemory:global",
                                    )
                                else:
                                    await cm.update_session_metadata(sid, "last_summarized_index", cnt)
                except Exception as exc:
                    logger.warning("[手动反思总结] 执行异常: %s", exc)

            body = await request.json() if request.method == "POST" else None
            query_params = dict(parse_qsl(request.url.query, keep_blank_values=True))
            async with quart_bridge.test_request_context(
                request.url.path,
                method=request.method,
                query_string=query_params,
                json=body
            ):
                return await registered["handler"]()

        return app

    async def stop(self) -> None:
        if self._gcp_web is not None:
            try:
                await self._gcp_web.stop()
            except Exception:
                pass
        if self._lm_server is not None:
            self._lm_server.should_exit = True
        for t in self._tasks:
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
