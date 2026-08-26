"""astrbot.core.star.context —— 插件看到的框架句柄。

一个进程只有一份。三个插件拿到的是同一个对象，这正是"统一宿主"的全部价值：
SelfLearning 的 `context.get_registered_star("LivingMemory")` 会在内存里
直接拿到 LivingMemory 的实例，从而走进程内委托，不再需要
`urllib.request.urlopen("http://127.0.0.1:8878/api/status")` 这种跨进程探测
（旧实现见 self_learning/core/feature_delegation.py 的 REMOTE_PROBES）。

Provider 侧同样收口：所有插件共用同一组 Gateway Provider，也就共用同一个
HTTP 连接池和同一份密钥来源。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from astrbot.core.provider.provider import (
    EmbeddingProvider,
    Provider,
    RerankProvider,
)

from .star import StarMetadata, star_map, star_registry
from .star_handler import star_handlers_registry

logger = logging.getLogger("astrbot.context")


class FunctionToolManager:
    """LLM 工具表。真框架里它还管激活/停用，这里只保留登记与查询。"""

    def __init__(self) -> None:
        self._tools: dict[str, Any] = {}

    def add_tool(self, tool: Any) -> None:
        name = getattr(tool, "name", None) or getattr(tool, "__name__", None)
        if not name:
            logger.warning("忽略一个没有 name 的 LLM 工具: %r", tool)
            return
        self._tools[str(name)] = tool

    def remove_tool(self, name: str) -> None:
        self._tools.pop(name, None)

    def get_tool(self, name: str) -> Any:
        return self._tools.get(name)

    def get_tools(self, *args: Any, **kwargs: Any) -> list[Any]:  # noqa: ARG002
        return list(self._tools.values())

    def get_func_desc_openai_style(self, *args: Any, **kwargs: Any) -> list[dict]:  # noqa: ARG002
        out = []
        for tool in self._tools.values():
            schema = getattr(tool, "parameters", None) or {"type": "object", "properties": {}}
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": getattr(tool, "name", ""),
                        "description": getattr(tool, "description", ""),
                        "parameters": schema,
                    },
                }
            )
        return out

    # 上游别名
    get_tool_schemas = get_func_desc_openai_style

    def __len__(self) -> int:
        return len(self._tools)

    def __iter__(self):
        return iter(self._tools.values())


from collections import OrderedDict
from datetime import datetime

class _HistoryItem:
    def __init__(self, content: Any, sender_id: str = "", message_id: str = "", created_at: Any = None):
        self.content = content
        self.sender_id = str(sender_id)
        self.message_id = str(message_id)
        self.created_at = created_at or datetime.now()


class _InMemoryHistoryManager:
    """会话历史管理器（运行时内存滑动窗口）。
    
    【架构权威与存储边界决策】
    1. 定位：本管理器是 AstrBot 统一宿主为生态插件（如 group_chat_plus / LivingMemory 等）
       提供的 AstrBot 原生 `Context.message_history_manager` / `platform_message_history` 接口替身。
    2. 权威分工：
       - 消息权威持久化与全量回溯由协议底座（NapCat / SQLite / 插件自有持久化）负责；
       - 本管理器仅作为内存热数据滑动窗口，负责支撑运行时读空气判定与上下文拼装，不保证跨进程持久化。
    3. 翻页与排序语义契约：
       - 1-based 分页：page=1 永远表示时间线上「最新的一页」，page=2 为「次新的一页」；
       - 返回列表始终保持【时间正序（旧 -> 新）】，调用方直接消费时时间线天然单调递增，
         与 AstrBot 官方 MessageHistoryManager 表现严格一致。
    """

    def __init__(self, max_sessions: int = 1000, max_items_per_session: int = 200) -> None:
        self._store: OrderedDict[str, list[_HistoryItem]] = OrderedDict()
        self._max_sessions = max_sessions
        self._max_items_per_session = max_items_per_session

    async def insert(self, item: Any = None, *args: Any, **kwargs: Any) -> None:
        if item is None:
            return
        chat_id = str(getattr(item, "session_id", "") or kwargs.get("user_id") or kwargs.get("chat_id") or "")
        if not chat_id and hasattr(item, "chat_id"):
            chat_id = str(item.chat_id)
        if not chat_id:
            chat_id = "default"
        if chat_id in self._store:
            self._store.move_to_end(chat_id)
        else:
            if len(self._store) >= self._max_sessions:
                self._store.popitem(last=False)
            self._store[chat_id] = []

        content = getattr(item, "content", item)
        sender_id = getattr(item, "sender_id", "")
        msg_id = getattr(item, "message_id", "")
        created_at = getattr(item, "created_at", None)
        self._store[chat_id].append(_HistoryItem(content, sender_id, msg_id, created_at))
        if len(self._store[chat_id]) > self._max_items_per_session:
            self._store[chat_id] = self._store[chat_id][-self._max_items_per_session:]

    async def get(self, platform_id: str = "", user_id: str = "", page: int = 1, page_size: int = 20, *args: Any, **kwargs: Any) -> list:
        cid = str(user_id or kwargs.get("chat_id") or "")
        if not cid:
            return []
        items = self._store.get(cid, [])
        if cid in self._store:
            self._store.move_to_end(cid)
        # 1-based 保护与 None 容错：page/page_size 为 None 或 < 1 时一律归一化
        page = max(1, int(page or 1))
        page_size = max(1, int(page_size or 20))
        total = len(items)
        start_idx = max(0, total - page * page_size)
        end_idx = max(0, total - (page - 1) * page_size)
        if start_idx >= end_idx:
            return []
        # 返回切片始终保持从旧到新的时间正序（窗口相对当前末尾计算，并发写入时非稳定，契约与 AstrBot 保持一致）
        return items[start_idx:end_idx]

    async def get_history(self, chat_id: str = "", user_id: str = "", limit: int = 20, page: int = 1, *args: Any, **kwargs: Any) -> list:
        cid = str(chat_id or user_id or kwargs.get("session_id") or "")
        return await self.get(user_id=cid, page=page, page_size=limit, *args, **kwargs)

    async def append_conversation_history(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def save_history(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def add(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def record(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def get_conversations(self, *args: Any, **kwargs: Any) -> list:
        return []

    async def get_conversation(self, *args: Any, **kwargs: Any) -> Any:
        return None

    async def new_conversation(self, *args: Any, **kwargs: Any) -> str:
        return ""

    async def get_curr_conversation_id(self, *args: Any, **kwargs: Any) -> str:
        return ""


class _StarManager:
    """插件管理器占位。GCP 的配置热重载会调 reload()。"""

    def __init__(self, context: "Context") -> None:
        self._context = context

    async def reload(self, name: str | None = None) -> tuple[bool, str]:
        pkg = (name or "").strip()
        logger.info("[热重载] 正在执行插件 %s 真实配置重载...", pkg)
        try:
            import json, os
            from astrbot.core.utils.astrbot_path import get_astrbot_config_path, get_astrbot_plugin_data_path
            
            # 1. 扫描磁盘配置（优先精确读取 data/plugin_data/{pkg}/config.json）
            candidates_dirs = [
                pkg,
                f"astrbot_plugin_{pkg}" if not pkg.startswith("astrbot_plugin_") else pkg,
                pkg.replace("astrbot_plugin_", ""),
            ]
            new_cfg = {}
            target_file = None
            for d in candidates_dirs:
                if not d:
                    continue
                p = os.path.join(get_astrbot_plugin_data_path(), d, "config.json")
                if os.path.isfile(p):
                    target_file = p
                    break

            if target_file and os.path.isfile(target_file):
                try:
                    with open(target_file, "r", encoding="utf-8-sig") as fh:
                        new_cfg = json.load(fh)
                    logger.info("[热重载] 成功从 %s 加载最新配置", target_file)
                except Exception as e:
                    logger.warning("[热重载] 读取配置文件 %s 失败: %s", target_file, e)

            # 2. 匹配并刷新插件实例
            from .star import star_map
            reloaded_count = 0

            def _apply_config_to_instance(inst_obj: Any, cfg_data: dict) -> None:
                if not inst_obj or not cfg_data:
                    return
                # 更新 config 字典
                if hasattr(inst_obj, "config") and isinstance(inst_obj.config, dict):
                    inst_obj.config.update(cfg_data)
                elif hasattr(inst_obj, "config") and hasattr(inst_obj.config, "update"):
                    inst_obj.config.update(cfg_data)
                else:
                    inst_obj.config = cfg_data

                # 显式覆盖关键属性
                for k, v in cfg_data.items():
                    if hasattr(inst_obj, k):
                        try:
                            setattr(inst_obj, k, v)
                        except Exception:
                            pass

                # 重新调用 __init__
                try:
                    type(inst_obj).__init__(inst_obj, self._context, cfg_data)
                except Exception:
                    try:
                        inst_obj.__init__(self._context, cfg_data)
                    except Exception:
                        pass
            
            # 刷新 star_map 中的实例与绑定的 Handlers
            from plugins_mount.loader import bind_handlers
            for key, meta in star_map.items():
                if pkg in key or (meta.name and pkg in meta.name) or (meta.root_dir_name and pkg in meta.root_dir_name):
                    star_inst = getattr(meta, "star_cls_instance", None) or getattr(meta, "star_cls_type", None)
                    if star_inst:
                        if isinstance(star_inst, type):
                            new_inst = star_inst(self._context, new_cfg)
                            meta.star_cls_instance = new_inst
                            target_inst = new_inst
                        else:
                            _apply_config_to_instance(star_inst, new_cfg)
                            target_inst = star_inst
                        
                        # 核心关键：重新绑定该插件的所有 handler 到最新实例，杜绝旧实例闭包滞留
                        if getattr(meta, "module_path", None):
                            bind_handlers(meta.module_path, target_inst)
                        reloaded_count += 1

            # 刷新 UnifiedContext 挂载点实例
            unified = getattr(self._context, "unified", None) or getattr(self._context, "_unified", None)
            if not unified and hasattr(self, "_unified"):
                unified = self._unified
            if unified and hasattr(unified, "mounts"):
                for m_key, mount in unified.mounts.items():
                    if pkg in m_key or (mount.spec and (pkg in mount.spec.name or pkg in mount.spec.package)):
                        inst = getattr(mount, "instance", None)
                        if inst and new_cfg:
                            _apply_config_to_instance(inst, new_cfg)
                            if mount.spec and mount.spec.entry_module:
                                bind_handlers(mount.spec.entry_module, inst)
                            reloaded_count += 1

            # 清理 GCP 历史会话的临时概率状态覆盖，使新的 initial_probability 立即生效
            try:
                from astrbot_plugin_group_chat_plus.utils.probability_manager import ProbabilityManager
                ProbabilityManager._probability_status.clear()
            except Exception:
                pass

            prob_info = f", initial_probability={new_cfg.get('initial_probability')}" if "initial_probability" in new_cfg else ""
            logger.info("[热重载] 插件 %s 内存与类状态已成功热更新！(生效配置项: %d 个%s)", pkg, len(new_cfg), prob_info)
            return True, f"插件 {pkg} 重载成功"
        except Exception as e:
            logger.error("[热重载] 插件 %s 重载异常: %s", pkg, e, exc_info=True)
            return False, str(e)

    def get_all_stars(self) -> list[StarMetadata]:
        return self._context.get_all_stars()


class Context:
    """插件与框架之间的唯一接口面。"""

    def __init__(self, config: dict[str, Any] | None = None, data_dir: str = "") -> None:
        self._config: dict[str, Any] = config or {}
        self.data_dir = data_dir

        # Provider 注册表：id -> Provider（同一个实例可能有多个别名）
        self.providers: dict[str, Provider] = {}
        self._provider_list: list[Provider] = []
        self._embedding_providers: list[EmbeddingProvider] = []
        self._rerank_providers: list[RerankProvider] = []
        self._default_provider: Provider | None = None

        self.llm_tools = FunctionToolManager()
        self.registered_web_apis: dict[str, Any] = {}
        self.registered_web_pages: list[dict[str, Any]] = []

        self.message_history_manager = _InMemoryHistoryManager()
        self.platform_message_history = _InMemoryHistoryManager()
        self.conversation_manager = _InMemoryHistoryManager()
        self.persona_manager: Any = None  # 由 UnifiedContext 装配
        self.platform: Any = None
        self.platform_manager: Any = None
        self._star_manager = _StarManager(self)
        self.star_manager = self._star_manager

    # ---------- 插件注册表 ----------

    def get_registered_star(self, star_name: str) -> StarMetadata | None:
        """按名字找插件。

        SelfLearning 的 FeatureDelegation 用别名列表逐个来问，所以匹配要宽：
        name / display_name / root_dir_name / module_path 任一命中即可，且忽略大小写。
        匹配太严的后果很具体 —— 委托检测失败，SelfLearning 会退回本地记忆，
        于是同一批事实在两个库里各写一份。
        """
        if not star_name:
            return None
        wanted = str(star_name).strip().lower()
        for metadata in star_registry:
            candidates = {
                metadata.name,
                metadata.display_name,
                metadata.root_dir_name,
                metadata.module_path,
            }
            if metadata.module_path:
                candidates.update(part for part in metadata.module_path.split(".") if part)
            if any(str(c).strip().lower() == wanted for c in candidates if c):
                return metadata
        return None

    def get_all_stars(self) -> list[StarMetadata]:
        return list(star_registry)

    @property
    def stars(self) -> list[StarMetadata]:
        return list(star_registry)

    @property
    def _stars(self) -> list[StarMetadata]:
        return list(star_registry)

    # ---------- Provider ----------

    def register_provider(self, provider: Provider, *aliases: str) -> None:
        meta = provider.meta()
        primary = str(getattr(provider, "provider_id", None) or meta.id or "")
        for key in {primary, *aliases}:
            if key:
                self.providers[key] = provider
                self.providers[key.lower()] = provider

        if isinstance(provider, EmbeddingProvider):
            if provider not in self._embedding_providers:
                self._embedding_providers.append(provider)
        elif isinstance(provider, RerankProvider):
            if provider not in self._rerank_providers:
                self._rerank_providers.append(provider)
        else:
            if provider not in self._provider_list:
                self._provider_list.append(provider)
            if self._default_provider is None:
                self._default_provider = provider

    def set_default_provider(self, provider: Provider) -> None:
        self._default_provider = provider

    def get_provider_by_id(self, provider_id: str | None = None) -> Provider | None:
        if not provider_id:
            return self._default_provider
        key = str(provider_id).strip()
        found = self.providers.get(key) or self.providers.get(key.lower())
        if found is not None:
            return found
        # `provider:model` 形式：退回同名 provider，模型名交给调用方
        if ":" in key:
            head = key.split(":", 1)[0]
            return self.providers.get(head) or self.providers.get(head.lower())
        return None

    def get_provider(self, provider_id: str | None = None, *args: Any, **kwargs: Any) -> Provider | None:  # noqa: ARG002
        """旧垫片里 GCP 用的名字，保留以免改动插件源码。"""
        return self.get_provider_by_id(provider_id) or self._default_provider

    def get_all_providers(self) -> list[Provider]:
        return list(self._provider_list)

    def get_using_provider(self, umo: str | None = None) -> Provider | None:  # noqa: ARG002
        return self._default_provider

    async def get_using_provider_async(self, umo: str | None = None) -> Provider | None:
        return self.get_using_provider(umo)

    def get_all_embedding_providers(self) -> list[EmbeddingProvider]:
        return list(self._embedding_providers)

    def get_all_rerank_providers(self) -> list[RerankProvider]:
        return list(self._rerank_providers)

    def get_all_tts_providers(self) -> list[Any]:
        return []

    def get_all_stt_providers(self) -> list[Any]:
        return []

    async def get_current_chat_provider_id(self, umo: str) -> str:  # noqa: ARG002
        provider = self._default_provider
        return str(getattr(provider, "provider_id", "")) if provider else ""

    # ---------- LLM 工具 ----------

    def add_llm_tools(self, *tools: Any) -> None:
        for tool in tools:
            self.llm_tools.add_tool(tool)

    def get_llm_tool_manager(self) -> FunctionToolManager:
        return self.llm_tools

    def activate_llm_tool(self, name: str) -> bool:
        return self.llm_tools.get_tool(name) is not None

    async def activate_llm_tool_async(self, name: str) -> bool:
        return self.activate_llm_tool(name)

    def deactivate_llm_tool(self, name: str) -> bool:
        self.llm_tools.remove_tool(name)
        return True

    async def deactivate_llm_tool_async(self, name: str) -> bool:
        return self.deactivate_llm_tool(name)

    def register_llm_tool(self, name: str, func_args: Any, desc: str, func_obj: Any) -> None:
        self.llm_tools.add_tool(
            type(
                "_InlineTool",
                (),
                {"name": name, "description": desc, "parameters": func_args, "run": func_obj},
            )()
        )

    def unregister_llm_tool(self, name: str) -> None:
        self.llm_tools.remove_tool(name)

    # ---------- Web ----------

    def register_web_api(
        self,
        route: str,
        view_handler: Callable,
        methods: list[str] | None = None,
        desc: str = "",
        **kwargs: Any,
    ) -> None:
        """插件注册自己的 HTTP 路由。

        宿主把它们挂到 /api/v1/plugin/<route> 下统一对外，
        插件自身不再各起一个 web 服务（旧实现里 GCP 起 :1451、
        SelfLearning 起 :8876、LivingMemory 起 :8878，三份 uvicorn）。
        """
        self.registered_web_apis[route] = {
            "route": route,
            "handler": view_handler,
            "methods": [m.upper() for m in (methods or ["GET"])],
            "desc": desc,
            "extras": kwargs,
        }
        logger.info("插件注册了 Web API: %s %s", ",".join(methods or ["GET"]), route)

    def register_web_page(self, name: str, route: str, path: str | None = None, **kwargs: Any) -> None:
        self.registered_web_pages.append({"name": name, "route": route, "path": path, **kwargs})

    # ---------- 其他 ----------

    def get_config(self, umo: str | None = None) -> dict[str, Any]:  # noqa: ARG002
        return self._config

    def get_db(self) -> Any:
        return None

    def get_event_queue(self) -> Any:
        return None

    def get_platform(self, platform_type: Any = None) -> Any:  # noqa: ARG002
        return self.platform

    def get_platform_inst(self, platform_id: str) -> Any:  # noqa: ARG002
        return self.platform

    def get_platform_id(self) -> str:
        return "aiocqhttp"

    def get_self_id(self) -> str:
        return str(self._config.get("identity", {}).get("robot_id", ""))

    async def send_message(self, session: Any, message_chain: Any) -> bool:
        """宿主不持有投递通道 —— 发消息是 Bridge v2 的职责，这里如实拒绝。

        返回 False 而不是抛异常：插件里这类调用大多在 fire-and-forget 分支，
        抛异常会把它们的主流程打断，而这些调用本来就是可有可无的。
        """
        logger.info(
            "[垫片] 插件尝试主动发消息，宿主无投递通道，已丢弃 | session=%s",
            session,
        )
        return False

    def register_commands(self, *args: Any, **kwargs: Any) -> None:  # noqa: ARG002
        return None

    def register_task(self, task: Any, desc: str = "") -> None:  # noqa: ARG002
        return None

    @property
    def star_handlers(self) -> Any:
        return star_handlers_registry

    def __repr__(self) -> str:
        return f"Context(stars={len(star_registry)}, providers={len(self._provider_list)})"


__all__ = ["Context", "FunctionToolManager"]
