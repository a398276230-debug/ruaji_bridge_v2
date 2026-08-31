"""LivingMemory 插件适配器。

将 LivingMemory 的三类能力（记忆工具导出 / 上下文注入 / 消息摄取）
收敛至 ``UnifiedPluginContract`` 标准接口，宿主核心不再直接穿透
LivingMemory 的内部实现。
"""

from __future__ import annotations

import asyncio
import copy
import json
import time
from typing import Any

from astrbot.core import logger
from astrbot.core.provider.entities import ProviderRequest
from astrbot.core.star.star_handler import EventType, star_handlers_registry

from hermes_layer.contracts import ContextBlock, Decision, InboundMessage, estimate_tokens
from hermes_layer.context_builder import build_event, build_request, _diff
from hermes_layer.dispatch import resolve_owner
from hermes_layer.plugin_contract import HermesTool, UnifiedPluginContract

#: 与 astrbot_plugin_livingmemory/core/memory_scope.py:8 同值。
GLOBAL_MEMORY_SCOPE_FALLBACK = "livingmemory:global"

#: memorize 的 category 白名单。
MEMORY_CATEGORIES = ("factual", "event", "preference", "relationship", "skill")

#: 图查询上限。
GRAPH_SEED_LIMIT = 8
GRAPH_ENTRY_LIMIT = 40
GRAPH_NEIGHBOR_LIMIT = 60
GRAPH_MEMORY_LIMIT = 24
GRAPH_MAX_HOPS = 3


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_raw_contexts(raw: Any, limit: int = 5) -> list[str]:
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            items = json.loads(raw)
        except json.JSONDecodeError:
            return [raw.strip()[:200]]
        if not isinstance(items, list):
            return [str(items)[:200]]
    else:
        return []
    return [str(item)[:200] for item in items[:limit] if str(item).strip()]


class LivingMemoryAdapter(UnifiedPluginContract):
    """LivingMemory 适配器——记忆检索/写入、图谱、黑话、上下文注入。"""

    def __init__(self, unified: Any) -> None:
        self._unified = unified

    # ---- 标识与排序 ----

    @property
    def plugin_key(self) -> str:
        return "living_memory"

    @property
    def execution_order(self) -> int:
        return 10  # 先于 GCP 执行

    # ---- 生命周期 ----

    async def initialize(self, context: Any, config: dict[str, Any]) -> None:
        # LivingMemory 的初始化由 loader 完成，此处无额外工作
        pass

    async def terminate(self) -> None:
        pass

    # ---- 上下文注入 ----

    async def provide_context(
        self,
        message: InboundMessage,
        history: list[dict[str, Any]] | None = None,
    ) -> list[ContextBlock]:
        """运行 LivingMemory 的 on_llm_request 钩子，diff 出上下文块。"""
        self_id = str(self._unified.config.get("identity", {}).get("robot_id", ""))
        event = build_event(message, self_id=self_id)
        req = build_request(message, history)
        baseline = copy.deepcopy(req)

        handlers = self._handlers_for()
        if not handlers:
            return []

        started = time.perf_counter()
        timeout_s = getattr(self._unified, "_context_timeout_s", 2.5)

        try:
            await asyncio.wait_for(self._invoke(event, req, handlers), timeout=timeout_s)
        except asyncio.TimeoutError:
            elapsed = (time.perf_counter() - started) * 1000
            logger.warning("LivingMemory 上下文注入超时（>%.0fms）", timeout_s * 1000)
            return [
                ContextBlock(
                    source=self.plugin_key,
                    kind="system_prompt",
                    elapsed_ms=elapsed,
                    error=f"timeout>{timeout_s * 1000:.0f}ms",
                )
            ]
        except Exception as exc:
            elapsed = (time.perf_counter() - started) * 1000
            logger.exception("LivingMemory 上下文注入异常")
            return [
                ContextBlock(
                    source=self.plugin_key,
                    kind="system_prompt",
                    elapsed_ms=elapsed,
                    error=f"{type(exc).__name__}: {exc}",
                )
            ]

        elapsed = (time.perf_counter() - started) * 1000
        produced = _diff(baseline, req, self.plugin_key, elapsed)
        if produced:
            return produced

        return [
            ContextBlock(
                source=self.plugin_key,
                kind="system_prompt",
                elapsed_ms=elapsed,
                detail={"ran": True, "contributed": False, "handlers": len(handlers)},
            )
        ]

    # ---- 消息摄取 ----

    async def on_message_received(self, message: InboundMessage) -> None:
        """消息摄取由宿主 dispatch 层的 /api/v1/events 驱动，此处无额外动作。"""
        pass

    # ---- 工具导出 ----

    def export_tools(self) -> list[HermesTool]:
        return [
            HermesTool(
                name="recall_long_term_memory",
                description=(
                    "检索瑞姬的长期记忆。当前上下文不足、需要回忆此前的事实/偏好/"
                    "约定，或消歧代词指向时调用。query 用简短的关键词而不是整句原文。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "召回关键词。优先用实体、话题、偏好、承诺、过往事件，不要复制整段用户输入。",
                        },
                        "target_user_id": {
                            "type": "string",
                            "description": "可选。想回忆的对象 QQ 号。",
                            "default": "",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "返回条数上限，1-20，默认 5。",
                            "default": 5,
                        },
                    },
                    "required": ["query"],
                },
                handler=self._recall_long_term_memory,
            ),
            HermesTool(
                name="memorize_long_term_memory",
                description=(
                    "写入一条长期记忆。用户明确要求记住，或出现了稳定的偏好、身份信息、"
                    "约定、项目背景时调用。写精炼的事实，不要把整段对话塞进来。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "要记住的事实，精炼成一句话。",
                        },
                        "category": {
                            "type": "string",
                            "description": "记忆类别。",
                            "enum": list(MEMORY_CATEGORIES),
                            "default": "factual",
                        },
                        "target_user_id": {
                            "type": "string",
                            "description": "可选。这条记忆关于谁（QQ 号）。",
                            "default": "",
                        },
                    },
                    "required": ["content"],
                },
                handler=self._memorize_long_term_memory,
            ),
            HermesTool(
                name="query_knowledge_graph",
                description=(
                    "查知识图谱：给一个实体（人、物、话题），返回它在群聊记忆里的关系网络"
                    "与相关事实陈述。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "entity": {
                            "type": "string",
                            "description": "实体名。人名、昵称、物品、话题都可以。",
                        },
                        "depth": {
                            "type": "integer",
                            "description": f"扩展跳数，1-{GRAPH_MAX_HOPS}，默认 2。",
                            "default": 2,
                        },
                    },
                    "required": ["entity"],
                },
                handler=self._query_knowledge_graph,
            ),
            HermesTool(
                name="query_community_jargon",
                description=(
                    "查群黑话。遇到看不懂的群内梗、缩写、自造词时调用，返回推断出的含义、"
                    "出现次数与真实使用语境。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "word": {
                            "type": "string",
                            "description": "要查的词。",
                        },
                    },
                    "required": ["word"],
                },
                handler=self._query_community_jargon,
            ),
            HermesTool(
                name="search_community_meme",
                description=(
                    "按梗名查一个梗的详情：来历、含义、经典例句。系统提示里的「梗雷达」会给出梗名，"
                    "照抄进来即可。查空说明库里真没有，去联网查证后用 record_community_meme 收录，别瞎编。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "梗名或它的别名，如「坐好喽」。只填梗名本身，不要把群友整句原话丢进来——本工具是精确直查，传原话必然查空。",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "返回条数上限，默认 3。",
                            "default": 3,
                        },
                    },
                    "required": ["query"],
                },
                handler=self._search_community_meme,
            ),
            HermesTool(
                name="record_community_meme",
                description=(
                    "向梗数据库录入或更新一条梗/黑话知识。在通过互联网查证确认了新梗含义，"
                    "或群友教了新梗时调用。会自动进行向量化索引持久化入库。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "term": {
                            "type": "string",
                            "description": "梗名称/核心词（如「真拿你没办法，坐好喽」或「牢师」）。",
                        },
                        "meaning": {
                            "type": "string",
                            "description": "梗的含义解释与背景要点。",
                        },
                        "origin": {
                            "type": "string",
                            "description": "可选。出处渊源（如《咒术回战》、CS2、B站等）。",
                            "default": "",
                        },
                        "examples": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "可选。经典例句、定型文或使用场景列表。",
                        },
                        "aliases": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "可选。别名、变体、衍生词、缩写列表。",
                        },
                        "tags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "可选。标签分类（如 [二次元, 咒术回战, 定型文]）。",
                        },
                    },
                    "required": ["term", "meaning"],
                },
                handler=self._record_community_meme,
            ),
        ]

    # ==================================================================
    # 内部：依赖解析
    # ==================================================================

    def _memory_engine(self) -> Any | None:
        return self._unified.memory_engine()

    def _graph_store(self) -> Any | None:
        return self._unified.graph_store()

    def _meme_store(self) -> Any | None:
        store = getattr(self._unified, "meme_store", None)
        if store is None and hasattr(self._unified, "get_meme_store"):
            store = self._unified.get_meme_store()
        return store

    def _memory_processor(self) -> Any | None:
        plugin = self._unified.plugin("living_memory")
        if plugin is None:
            return None
        initializer = getattr(plugin, "initializer", None)
        processor = getattr(initializer, "memory_processor", None) if initializer else None
        return processor or getattr(plugin, "memory_processor", None)

    def _filtering(self) -> dict[str, Any]:
        mount = self._unified.mounts.get("living_memory")
        if mount is None:
            return {}
        return dict(mount.config.get("filtering_settings") or {})

    @staticmethod
    def _global_scope() -> str:
        try:
            from astrbot_plugin_livingmemory.core.memory_scope import GLOBAL_MEMORY_SCOPE
            return str(GLOBAL_MEMORY_SCOPE)
        except Exception:
            return GLOBAL_MEMORY_SCOPE_FALLBACK

    def _scope(self) -> str | None:
        mode = str(self._filtering().get("memory_scope_mode") or "legacy").strip().lower()
        return self._global_scope() if mode == "global" else None

    async def _persona(self) -> str | None:
        if not self._filtering().get("use_persona_filtering", True):
            return None
        pm = getattr(self._unified.context, "persona_manager", None)
        if pm is None:
            return None
        try:
            persona = await pm.get_default_persona_v3()
        except Exception as exc:
            logger.debug("取默认人格失败: %s", exc)
            return None
        if not persona:
            return None
        return str(persona.get("name") or "") or None

    def _handlers_for(self) -> list[Any]:
        return [
            h
            for h in star_handlers_registry.get_handlers_by_event_type(EventType.OnLLMRequestEvent)
            if resolve_owner(h, self._unified.mounts) == self.plugin_key
        ]

    async def _invoke(self, event: Any, req: ProviderRequest, handlers: list[Any]) -> None:
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

    # ==================================================================
    # 工具实现
    # ==================================================================

    async def _recall_long_term_memory(
        self, query: str, target_user_id: str = "", limit: int = 5,
    ) -> dict[str, Any]:
        cleaned = str(query or "").strip()
        if not cleaned:
            return {"ok": False, "error": "empty_query", "results": [], "count": 0}

        engine = self._memory_engine()
        if engine is None:
            return {
                "ok": False, "error": "living_memory_unavailable",
                "message": "LivingMemory 未挂载或尚未完成异步初始化",
                "results": [], "count": 0,
            }

        k = max(1, min(_as_int(limit, 5), 20))
        target = str(target_user_id or "").strip()
        search_query = f"{cleaned} {target}".strip() if target else cleaned
        scope = self._scope()
        persona = await self._persona()

        results = await engine.search_memories(
            query=search_query, k=k, session_id=scope, persona_id=persona,
        )

        items: list[dict[str, Any]] = []
        for result in results or []:
            content = str(getattr(result, "content", "") or "")
            metadata = dict(getattr(result, "metadata", None) or {})
            haystack = content + json.dumps(metadata, ensure_ascii=False, default=str)
            items.append({
                "id": _as_int(getattr(result, "doc_id", 0), 0),
                "content": content,
                "score": round(_as_float(getattr(result, "final_score", 0.0), 0.0), 4),
                "importance": metadata.get("importance"),
                "createTime": metadata.get("create_time"),
                "topics": metadata.get("topics") or [],
                "mentionsTarget": bool(target) and target in haystack,
            })

        return {
            "ok": True, "query": cleaned, "count": len(items), "results": items,
            "scope": scope, "personaId": persona,
            "targetUserId": target, "targetIsHint": bool(target),
        }

    async def _memorize_long_term_memory(
        self, content: str, category: str = "factual", target_user_id: str = "",
    ) -> dict[str, Any]:
        text = str(content or "").strip()
        if not text:
            return {"ok": False, "error": "empty_content", "memorized": False}

        engine = self._memory_engine()
        if engine is None:
            return {
                "ok": False, "error": "living_memory_unavailable",
                "message": "LivingMemory 未挂载或尚未完成异步初始化",
                "memorized": False,
            }

        raw_category = str(category or "").strip().lower()
        cat = raw_category if raw_category in MEMORY_CATEGORIES else "factual"
        target = str(target_user_id or "").strip()

        key_facts = [f"关联用户: {target}"] if target else []
        structured = {
            "summary": text, "topics": [cat], "key_facts": key_facts,
            "sentiment": "neutral", "importance": 0.7,
        }

        processor = self._memory_processor()
        if processor is not None and hasattr(processor, "build_memory_from_structured_data"):
            stored, metadata, importance = processor.build_memory_from_structured_data(
                structured_data=structured, is_group_chat=False, fallback_excerpt=text,
            )
        else:
            stored = " | ".join([text, "；".join(key_facts)]) if key_facts else text
            metadata = {
                "topics": [cat], "key_facts": key_facts, "sentiment": "neutral",
                "interaction_type": "private_chat", "canonical_summary": stored,
                "persona_summary": text, "summary_schema_version": "v2",
            }
            importance = 0.7
            logger.warning("拿不到 MemoryProcessor，本次用兜底 metadata 写入记忆")

        scope = self._scope()
        metadata["memory_origin"] = "hermes_tool"
        metadata["memory_category"] = cat
        metadata["source_session_id"] = scope or ""
        metadata["source_window"] = {
            "session_id": scope or "", "triggered_by": "hermes_agent",
            "tool_name": "memorize_long_term_memory",
        }
        if target:
            metadata["target_user_id"] = target

        persona = await self._persona()
        memory_id = await engine.add_memory(
            content=stored, session_id=scope, persona_id=persona,
            importance=importance, metadata=metadata,
        )

        payload: dict[str, Any] = {
            "ok": True, "memorized": True,
            "id": _as_int(memory_id, 0), "content": stored,
            "category": cat, "importance": round(_as_float(importance, 0.7), 3),
            "scope": scope, "personaId": persona,
        }
        if raw_category and raw_category != cat:
            payload["categoryFallback"] = {"requested": raw_category, "used": cat}
        return payload

    async def _query_knowledge_graph(self, entity: str, depth: int = 2) -> dict[str, Any]:
        name = str(entity or "").strip()
        if not name:
            return {"ok": False, "error": "empty_entity", "found": False}

        store = self._graph_store()
        if store is None:
            return {
                "ok": False, "error": "graph_store_unavailable",
                "message": "graph_memory.enabled 为 false，或 LivingMemory 尚未就绪",
                "found": False,
            }

        hops = max(1, min(_as_int(depth, 2), GRAPH_MAX_HOPS))
        tokens = [name] if name.lower() == name else [name, name.lower()]

        seeds = await store.search_nodes_by_tokens(tokens, limit=GRAPH_SEED_LIMIT)
        if not seeds:
            return {
                "ok": True, "entity": name, "found": False, "hopsWalked": 0,
                "seeds": [], "relations": [], "statements": [],
            }

        frontier = [_as_int(node.get("id"), 0) for node in seeds]
        frontier = [i for i in frontier if i]
        visited = set(frontier)
        entries: dict[int, dict[str, Any]] = {}
        hops_walked = 0

        for _ in range(hops):
            batch = await store.get_entries_for_node_ids(frontier, limit=GRAPH_ENTRY_LIMIT)
            for entry in batch or []:
                entries.setdefault(_as_int(entry.get("entry_id"), 0), entry)
            hops_walked += 1

            neighbors = await store.get_neighbor_node_ids(frontier, limit=GRAPH_NEIGHBOR_LIMIT)
            frontier = [i for i in (neighbors or []) if i not in visited]
            if not frontier:
                break
            visited.update(frontier)

        memory_ids = sorted({_as_int(e.get("source_memory_id"), 0) for e in entries.values()} - {0})
        memory_ids = memory_ids[:GRAPH_MEMORY_LIMIT]
        subgraph: dict[str, Any] = {"nodes": [], "edges": []}
        if memory_ids:
            subgraph = await store.get_subgraph_for_memories(memory_ids)

        labels = {
            _as_int(node.get("id"), 0): str(node.get("label") or node.get("canonical_value") or "")
            for node in subgraph.get("nodes") or []
        }
        relations = []
        for edge in subgraph.get("edges") or []:
            if str(edge.get("status") or "active") != "active":
                continue
            source = labels.get(_as_int(edge.get("source"), 0))
            target = labels.get(_as_int(edge.get("target"), 0))
            if not source or not target:
                continue
            relations.append({
                "source": source, "relation": str(edge.get("relation_type") or ""),
                "target": target, "weight": round(_as_float(edge.get("weight"), 0.0), 3),
                "confidence": round(_as_float(edge.get("confidence"), 0.0), 3),
            })
        relations.sort(key=lambda r: (-r["weight"], r["source"], r["target"]))

        statements = [
            {
                "content": str(e.get("content") or ""),
                "type": str(e.get("entry_type") or ""),
                "relation": str(e.get("relation_type") or ""),
                "score": round(_as_float(e.get("score"), 0.0), 3),
                "memoryId": _as_int(e.get("source_memory_id"), 0),
            }
            for e in sorted(entries.values(), key=lambda e: -_as_float(e.get("score"), 0.0))
        ]

        return {
            "ok": True, "entity": name, "found": True, "hopsWalked": hops_walked,
            "seeds": [
                {"id": _as_int(node.get("id"), 0), "value": str(node.get("node_value") or ""), "type": str(node.get("node_type") or "")}
                for node in seeds
            ],
            "nodesVisited": len(visited), "relations": relations, "statements": statements,
        }

    async def _query_community_jargon(self, word: str) -> dict[str, Any]:
        term = str(word or "").strip()
        if not term:
            return {"ok": False, "error": "empty_word", "found": False}

        # 黑话功能原依赖 self_learning 的 db_manager，现改为直接从 graph_store 查
        store = self._graph_store()
        if store is None:
            return {
                "ok": True, "word": term, "found": False, "count": 0,
                "entries": [], "message": "未记录该黑话",
            }

        payload: dict[str, Any] = {
            "ok": True, "word": term, "found": False, "count": 0, "entries": [],
        }
        graph = await self._graph_context_for(term)
        if graph is not None:
            payload["graph"] = graph
            payload["found"] = bool(graph.get("nodes") or graph.get("statements"))

        # 如果图谱中未找到，联动查一下梗库作为补全
        if not payload["found"]:
            meme_store = self._meme_store()
            if meme_store is not None:
                try:
                    meme_res = await meme_store.search_meme(term, limit=3)
                    if meme_res.get("found"):
                        payload["memeMatch"] = meme_res.get("results")
                        payload["found"] = True
                        payload["message"] = "在社区梗库中找到匹配条目"
                except Exception as exc:
                    logger.debug("黑话联动梗库查询失败: %s", exc)

        return payload

    async def _search_community_meme(self, query: str, limit: int = 3) -> dict[str, Any]:
        """语义检索社区梗库。"""
        store = self._meme_store()
        if store is None:
            return {
                "ok": False,
                "error": "meme_store_unavailable",
                "message": "社区梗数据库尚未初始化",
                "results": [],
                "found": False,
            }
        return await store.search_meme(query=query, limit=limit)

    async def _record_community_meme(
        self,
        term: str,
        meaning: str,
        origin: str = "",
        examples: list[str] | None = None,
        aliases: list[str] | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """录入或更新社区梗。"""
        store = self._meme_store()
        if store is None:
            return {
                "ok": False,
                "error": "meme_store_unavailable",
                "message": "社区梗数据库尚未初始化",
            }
        return await store.record_meme(
            term=term,
            meaning=meaning,
            origin=origin,
            examples=examples,
            aliases=aliases,
            tags=tags,
        )

    async def _graph_context_for(self, term: str) -> dict[str, Any] | None:
        store = self._graph_store()
        if store is None:
            return None
        try:
            nodes = await store.search_nodes_by_tokens([term], limit=5)
            if not nodes:
                return {"nodes": [], "statements": []}
            node_ids = [_as_int(n.get("id"), 0) for n in nodes]
            node_ids = [i for i in node_ids if i]
            hits = await store.get_entries_for_node_ids(node_ids, limit=10)
        except Exception as exc:
            logger.debug("黑话查询的图谱对齐失败: %s", exc)
            return None
        return {
            "nodes": [str(n.get("node_value") or "") for n in nodes],
            "statements": [str(h.get("content") or "") for h in hits or []],
        }


__all__ = ["LivingMemoryAdapter"]
