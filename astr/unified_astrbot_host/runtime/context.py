"""runtime.context —— 统一宿主的运行时。

一个进程、一份 Context、三个插件。这个类负责把它们装起来、连上 Provider、
并在关闭时按逆序拆掉。

## 装配顺序（不可随意调整）

    1. GatewayClient          出站 HTTP 连接池（三个插件共用一个）
    2. Provider 注册           LLM / Embedding / Rerank 进同一份 Context
    3. persona_manager        人格（GCP 与 SelfLearning 都读它）
    4. 插件挂载                 见 plugins_mount.loader.MOUNT_ORDER
    5. 委托对齐                 打开 SelfLearning 的 delegate_memory_to_livingmemory
    6. initialize()           按挂载顺序调，LivingMemory 在这一步建 FAISS 索引

第 5 步必须在第 4 步之后、第 6 步之前：委托开关要在 SelfLearning 的
initialize() 读它之前写进 config，否则那一轮读到的还是默认值 false。

## 关闭

逆序 terminate()。逆序是因为 SelfLearning 可能正在往 LivingMemory 的图谱里写，
先关 LivingMemory 会让那些写操作打到已关闭的 SQLite 连接上。
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any

from astrbot.core import logger, rebind_data_root
from astrbot.core.provider.provider import (
    GatewayChatProvider,
    GatewayEmbeddingProvider,
    GatewayRerankProvider,
)
from astrbot.core.star.context import Context
from astrbot.core.star.star import star_registry
from astrbot.core.star.star_handler import EventType
from astrbot.core.star.star_tools import StarTools
from hermes_layer.dispatch import (
    dispatch_lifecycle_event,
    scan_and_warn_unsupported_handlers,
)
from hermes_layer.gateway_client import GatewayClient, build_from_config
from plugins_mount.loader import MountSpec, PluginMount, mount_all

#: SelfLearning 里存放功能融合开关的配置分组（_conf_schema.json 的真实位置）。
DELEGATION_GROUP = "Integration_Settings"

#: 两个都要为 true 才会真委托 —— 见 core/feature_delegation.py:68-73，
#: 它对两个开关做的是"任一为 false 就不委托"。只开第一个，本地记忆照旧写。
DELEGATION_KEYS = ("delegate_memory_to_livingmemory", "disable_local_memory_when_delegated")


@dataclass
class PluginHealth:
    key: str
    name: str
    mounted: bool = False
    initialized: bool = False
    error: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def status(self) -> str:
        if self.error:
            return "unhealthy"
        if not self.mounted:
            return "absent"
        return "healthy" if self.initialized else "starting"


class UnifiedContext:
    """宿主的全部可变状态都在这里。"""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.started_at = time.time()
        self.ready = False

        data_root = os.path.abspath(
            str(config.get("host", {}).get("data_dir") or os.path.join(os.getcwd(), "data"))
        )
        os.makedirs(data_root, exist_ok=True)
        rebind_data_root(data_root)
        self.data_root = data_root

        self.gateway: GatewayClient = build_from_config(config)
        self.context = Context(config=config, data_dir=data_root)
        StarTools.initialize(self.context)

        self.mounts: dict[str, PluginMount] = {}
        self.health: dict[str, PluginHealth] = {}
        self.delegation_active = False
        self._closed = False

    # ------------------------------------------------------------------
    # 启动
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._register_providers()
        self._install_persona()
        await dispatch_lifecycle_event(EventType.OnPlatformLoadedEvent, {"platform": "aiocqhttp"})
        self._mount_plugins()
        self._align_delegation()
        await self._initialize_plugins()
        self.ready = all(h.status in ("healthy", "absent") for h in self.health.values())
        await dispatch_lifecycle_event(EventType.OnAstrBotLoadedEvent, {"plugins": list(self.mounts.keys())})
        scan_and_warn_unsupported_handlers()
        logger.info(
            "统一宿主装配完成 | 插件 %d 个 | 委托=%s | ready=%s",
            len(self.mounts),
            self.delegation_active,
            self.ready,
        )

    def _register_providers(self) -> None:
        """三种 Provider 注册进同一份 Context。

        `embedding_dim` 必须与 FAISS 索引维度一致。写错的后果是启动时
        GatewayEmbeddingProvider 拿到真实维度后打一条 warning 并自动纠正 ——
        但已经建好的旧索引不会跟着变，检索会直接报维度不匹配。
        """
        providers = self.config.get("providers") or {}
        dim = int(providers.get("embedding", {}).get("dim", 1024))

        chat_gemini = GatewayChatProvider(self.gateway, provider_id="gemini-CPA", model=self.gateway.llm.model)
        embedding = GatewayEmbeddingProvider(self.gateway, provider_id="hermes-embedding", dim=dim)
        rerank = GatewayRerankProvider(self.gateway, provider_id="hermes-rerank")

        # 注册主 Provider (gemini-CPA / gemini-proxy: :8868)
        self.context.register_provider(chat_gemini, "default", "gemini-CPA", self.gateway.llm.model)
        self.context.register_provider(chat_gemini, "gemini-proxy", "gemini-CPA", self.gateway.llm.model)
        self.context.register_provider(chat_gemini, "hermes", "gemini-CPA", self.gateway.llm.model)
        self.context.register_provider(embedding, "default-embedding", self.gateway.embedding.model)
        self.context.register_provider(rerank, "default-rerank", self.gateway.rerank.model)
        self.context.set_default_provider(chat_gemini)

        # 注册 CPA 全部可用模型到 Provider 池供 WebUI 下拉选择
        cpa_models = [
            'gemini-3.7-flash-nv', 'gemini-3.7-flash', 'gpt-5.6-sol', 'gpt-5.6-luna',
            'gpt-5.6-terra', 'glm-5.2', 'deepseek-v4-flash-stfree', 'gemini-2.5-flash',
            'gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro',
            'agy-claude-opus-4-6-thinking', 'deepseek-v4-flash-0731', 'gemini-3.6-flash'
        ]
        for m in cpa_models:
            prov = GatewayChatProvider(self.gateway, provider_id=f"CPA/{m}", model=m)
            self.context.register_provider(prov, f"CPA/{m}", f"CPA ({m})", m)
            self.context.register_provider(prov, m, f"CPA ({m})", m)

        logger.info(
            "Provider 就绪 | 模式=%s | LLM=%s@%s | Embedding=%s(dim=%d) | Rerank=%s",
            "离线(合成响应，不出网)" if self.gateway.offline else "在线",
            self.gateway.llm.model or "?",
            self.gateway.llm.base_url or "(未配置)",
            self.gateway.embedding.model or "?",
            dim,
            self.gateway.rerank.model or "(未配置，退化为纯 RRF)",
        )

    def _install_persona(self) -> None:
        """装人格。

        GCP 与 SelfLearning 都从 `context.persona_manager` 取当前人格；
        SelfLearning 的人格审阅还会往回写 system_prompt。所以这个对象要可写，
        且写入必须落盘 —— 否则宿主一重启，学到的语气就没了。
        """
        from runtime.persona import PersonaManager

        persona_cfg = self.config.get("persona") or {}
        local_app_data = os.getenv("LOCALAPPDATA", "")
        soul_candidates = [
            persona_cfg.get("soul_path"),
            os.path.join(local_app_data, "hermes", "SOUL.md") if local_app_data else None,
            os.path.expanduser("~/AppData/Local/hermes/SOUL.md"),
            "F:/hermescache/hermes/SOUL.md",
            os.path.join(self.data_root, "persona_soul.md"),
            os.path.join(self.data_root, "persona.json"),
        ]
        chosen_soul_path = next((p for p in soul_candidates if p and os.path.isfile(p)), os.path.join(self.data_root, "persona.json"))

        self.context.persona_manager = PersonaManager(
            persona_id=str(persona_cfg.get("id") or "ruaji"),
            system_prompt=str(persona_cfg.get("system_prompt") or ""),
            store_path=chosen_soul_path,
        )

    def _mount_plugins(self) -> None:
        specs = self._build_specs()
        for key, spec in specs.items():
            self.health[key] = PluginHealth(key=key, name=spec.package)
        self.mounts = mount_all(self.context, specs)
        for key, mount in self.mounts.items():
            health = self.health.setdefault(key, PluginHealth(key=key, name=mount.name))
            health.name = mount.name
            health.mounted = True
            health.detail["version"] = mount.metadata.version
            # 派发插件加载事件
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    asyncio.create_task(dispatch_lifecycle_event(EventType.OnPluginLoadedEvent, {"plugin": key, "mount": mount}))
            except Exception:
                pass

    def _build_specs(self) -> dict[str, MountSpec]:
        out: dict[str, MountSpec] = {}
        for key, raw in (self.config.get("plugins") or {}).items():
            raw = raw or {}
            out[key] = MountSpec(
                key=key,
                package=str(raw.get("package") or key),
                path=os.path.abspath(str(raw.get("path") or "")),
                entry=str(raw.get("entry") or "main"),
                config_overrides=dict(raw.get("config") or {}),
                enabled=raw.get("enabled", True) is not False,
            )
        return out

    def _align_delegation(self) -> None:
        """把"记忆委托给 LivingMemory"这件事在配置层面落实。

        `FeatureDelegation.should_delegate_memory()` 要求三件事同时成立：两个
        开关都为 true，且 `_find_active_star(LIVING_MEMORY_ALIASES)` 能在
        star_registry 里找到激活的 LivingMemory。第三件由挂载顺序保证。

        开关的真实位置是 `Integration_Settings` 分组（config.py:493 从那里读，
        不读顶层），schema 默认已是 true —— 所以这个方法的价值不在"打开"，
        而在 **LivingMemory 缺席时把它关掉**：不关的话，SelfLearning 会走进
        `_probe_remote_star()`，对 127.0.0.1:8878 发一次 0.5s 超时的 HTTP 探测。
        统一宿主里那个端口已经没人监听了，于是每次都是一次白等。
        """
        sl = self.mounts.get("self_learning")
        if sl is None:
            return

        found = self.context.get_registered_star("LivingMemory")
        active = found is not None and found.star_cls is not None
        group = sl.config.setdefault(DELEGATION_GROUP, {})
        for flag in DELEGATION_KEYS:
            group[flag] = active
            # 顶层也写一份：config.py:_read_config_value 先看顶层再看分组，
            # 两处一致才不会出现"读哪份得到不同答案"。
            sl.config[flag] = active

        self.delegation_active = active
        if not active:
            logger.warning(
                "[功能融合] 未找到已激活的 LivingMemory，SelfLearning 保持本地记忆模式"
            )

    async def _initialize_plugins(self) -> None:
        """按挂载顺序调 initialize()，并等 LivingMemory 真正就绪。"""
        for key, mount in self.mounts.items():
            health = self.health[key]
            init = getattr(mount.instance, "initialize", None)
            try:
                if callable(init):
                    result = init()
                    if asyncio.iscoroutine(result):
                        await result
            except Exception as exc:  # noqa: BLE001 —— 记下来并继续，见下
                health.error = f"{type(exc).__name__}: {exc}"
                logger.exception("插件 %s 的 initialize() 失败", mount.name)
                continue
            health.initialized = mount.initialized

        # LivingMemory 在 __init__ 里 create_task 自己异步初始化，
        # initialize() 返回时索引可能还没建完。等它，但要有上限 ——
        # 无限等会让 /health 永远停在 starting，运维看不出是慢还是死。
        await self._await_lazy_init("living_memory")

    async def _await_lazy_init(self, key: str, timeout_s: float = 60.0) -> None:
        mount = self.mounts.get(key)
        if mount is None:
            return
        health = self.health[key]
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if mount.initialized:
                health.initialized = True
                logger.info("插件 %s 异步初始化完成", mount.name)
                return
            await asyncio.sleep(0.25)
        health.initialized = False
        health.detail["note"] = f"异步初始化超过 {timeout_s:.0f}s 仍未完成"
        logger.warning("插件 %s 在 %.0fs 内未完成异步初始化", mount.name, timeout_s)

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    def plugin(self, key: str) -> Any | None:
        mount = self.mounts.get(key)
        return mount.instance if mount else None

    def memory_engine(self) -> Any | None:
        """拿到 LivingMemory 的记忆引擎。

        路径与 SelfLearning 的 graph_service 一致（webui/services/graph_service.py:289）：
        star.star_cls → initializer.memory_engine → 或退回 plugin.memory_engine。
        两条都试，因为 LivingMemory 两个版本的字段位置不同。
        """
        plugin = self.plugin("living_memory")
        if plugin is None:
            return None
        initializer = getattr(plugin, "initializer", None)
        engine = getattr(initializer, "memory_engine", None) if initializer else None
        return engine or getattr(plugin, "memory_engine", None)

    def graph_store(self) -> Any | None:
        """同进程直取图谱存储 —— 这是本次统一宿主最直接的收益。

        旧实现要 HTTP 打到 :8878 再把图序列化过来（self_learning 的 REMOTE_PROBES）；
        现在是一次属性访问。
        """
        engine = self.memory_engine()
        return getattr(engine, "graph_store", None) if engine else None

    def health_snapshot(self) -> dict[str, Any]:
        plugins = {
            key: {
                "name": h.name,
                "status": h.status,
                "mounted": h.mounted,
                "initialized": h.initialized,
                "error": h.error,
                **h.detail,
            }
            for key, h in self.health.items()
        }
        overall = "healthy"
        if any(v["status"] == "unhealthy" for v in plugins.values()):
            overall = "unhealthy"
        elif any(v["status"] == "starting" for v in plugins.values()):
            overall = "starting"
        return {
            "status": overall,
            "ready": self.ready and overall == "healthy",
            "uptimeMs": int((time.time() - self.started_at) * 1000),
            "pid": os.getpid(),
            "singleProcess": True,
            "starCount": len(star_registry),
            "delegation": {
                "memoryDelegatedToLivingMemory": self.delegation_active,
                "graphStoreShared": self.graph_store() is not None,
            },
            "providers": {
                "mode": "offline" if self.gateway.offline else "live",
                "llm": self.gateway.llm.base_url or None,
                "embedding": self.gateway.embedding.base_url or None,
                "rerank": self.gateway.rerank.base_url or None,
                "stats": self.gateway.stats,
            },
            "plugins": plugins,
        }

    # ------------------------------------------------------------------
    # 关闭
    # ------------------------------------------------------------------

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.ready = False
        for key in reversed(list(self.mounts)):
            mount = self.mounts[key]
            await dispatch_lifecycle_event(EventType.OnPluginUnloadedEvent, {"plugin": key})
            terminate = getattr(mount.instance, "terminate", None)
            if not callable(terminate):
                continue
            try:
                result = terminate()
                if asyncio.iscoroutine(result):
                    await asyncio.wait_for(result, timeout=15)
            except (Exception, asyncio.TimeoutError):  # noqa: BLE001
                logger.exception("插件 %s 的 terminate() 失败", mount.name)
        await self.gateway.aclose()
        logger.info("统一宿主已关闭")


__all__ = ["DELEGATION_GROUP", "DELEGATION_KEYS", "PluginHealth", "UnifiedContext"]
