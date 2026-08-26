"""hermes_layer.tool_registry —— 导出给 Hermes Agent 的核心记忆与知识图谱工具集。

专注于 LivingMemory 的记忆检索/写入、知识图谱与黑话查询。
OneBot 协议端工具链（群文件、历史消息、戳一戳等）已收敛至 Bridge 网关层直连执行。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from astrbot.core import logger

#: 清单协议版本。Hermes 侧按这个值判断拿到的 manifest 能不能直接用。
MANIFEST_VERSION = 1

#: 与 astrbot_plugin_livingmemory/core/memory_scope.py:8 同值。
GLOBAL_MEMORY_SCOPE_FALLBACK = "livingmemory:global"

#: memorize 的 category 白名单。越界不报错，退回 factual 并在返回里说明。
MEMORY_CATEGORIES = ("factual", "event", "preference", "relationship", "skill")

#: 图查询上限。
GRAPH_SEED_LIMIT = 8
GRAPH_ENTRY_LIMIT = 40
GRAPH_NEIGHBOR_LIMIT = 60
GRAPH_MEMORY_LIMIT = 24
GRAPH_MAX_HOPS = 3


@dataclass
class HermesTool:
    """一件可被 Hermes Agent 调用的工具。"""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Awaitable[dict[str, Any]]]
    requires: tuple[str, ...] = ()

    def to_manifest(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "requires": list(self.requires),
        }


class ToolRegistry:
    """工具注册表。宿主启动时建一个，`/api/v1/tools/*` 用它。"""

    def __init__(self, unified: Any) -> None:
        self._unified = unified
        self._tools: dict[str, HermesTool] = {}
        self._rebuild()

    def _rebuild(self) -> None:
        """重建工具清单：优先从适配器收集，余下走旧 _build() 兜底。"""
        tools: dict[str, HermesTool] = {}
        adapters = getattr(self._unified, "adapters", None) or []
        adapter_contributed = False
        for adapter in adapters:
            if adapter.plugin_key not in self._unified.mounts:
                continue
            for t in adapter.export_tools():
                tools[t.name] = t
                adapter_contributed = True
        if not adapter_contributed:
            # 向后兼容：无适配器贡献时走旧路径
            for t in self._build():
                tools[t.name] = t
        self._tools = tools

    # ------------------------------------------------------------------
    # 对外
    # ------------------------------------------------------------------

    @property
    def names(self) -> list[str]:
        return list(self._tools)

    def tools(self) -> list[HermesTool]:
        return list(self._tools.values())

    def manifest(self) -> dict[str, Any]:
        server = self._unified.config.get("server") or {}
        host = str(server.get("host") or "127.0.0.1")
        port = int(server.get("port") or 8870)
        return {
            "version": MANIFEST_VERSION,
            "source": "unified_astrbot_host",
            "endpoint": f"http://{host}:{port}/api/v1/tools/call",
            "shadowMode": bool((self._unified.config.get("host") or {}).get("shadow_mode", True)),
            "memoryScope": self._scope() or "(不过滤 session)",
            "tools": [t.to_manifest() for t in self._tools.values()],
        }

    def export(self, directory: str | None = None, filename: str | None = None) -> str | None:
        """把清单写到 Hermes Agent 目录。"""
        cfg = self._unified.config.get("hermes") or {}
        if not cfg.get("export_enabled", False) and directory is None:
            logger.info("hermes.export_enabled 为 false，跳过工具清单导出")
            return None

        target_dir = os.path.abspath(str(directory or cfg.get("export_dir") or ""))
        if not target_dir:
            logger.warning("未配置 hermes.export_dir，跳过工具清单导出")
            return None
        if not os.path.isdir(target_dir):
            logger.warning("Hermes 目录不存在，跳过导出: %s", target_dir)
            return None

        path = os.path.join(target_dir, str(filename or cfg.get("tools_manifest") or "unified_host_tools.json"))
        payload = json.dumps(self.manifest(), ensure_ascii=False, indent=2)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
        logger.info("已导出 %d 件工具到 %s", len(self._tools), path)
        return path

    async def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """按名字调用。异常一律转成 error 字段，不向外抛。"""
        tool = self._tools.get(name)
        if tool is None:
            return {
                "ok": False,
                "error": "unknown_tool",
                "message": f"没有名为 {name} 的工具",
                "available": self.names,
            }

        started = time.perf_counter()
        try:
            result = await tool.handler(**(arguments or {}))
        except TypeError as exc:
            return {
                "ok": False,
                "error": "bad_arguments",
                "message": str(exc),
                "parameters": tool.parameters,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("Hermes 工具 %s 执行失败", name)
            return {
                "ok": False,
                "error": "internal_error",
                "message": f"{type(exc).__name__}: {exc}",
                "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            }

        result.setdefault("ok", True)
        result["tool"] = name
        result["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
        return result

    # ------------------------------------------------------------------
    # 依赖解析
    # ------------------------------------------------------------------

    def _memory_engine(self) -> Any | None:
        return self._unified.memory_engine()

    def _graph_store(self) -> Any | None:
        return self._unified.graph_store()

    def _memory_processor(self) -> Any | None:
        plugin = self._unified.plugin("living_memory")
        if plugin is None:
            return None
        initializer = getattr(plugin, "initializer", None)
        processor = getattr(initializer, "memory_processor", None) if initializer else None
        return processor or getattr(plugin, "memory_processor", None)

    def _db_manager(self) -> Any | None:
        plugin = self._unified.plugin("self_learning")
        return getattr(plugin, "db_manager", None) if plugin else None

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
        except Exception:  # noqa: BLE001
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
        except Exception as exc:  # noqa: BLE001
            logger.debug("取默认人格失败，本次不按人格过滤: %s", exc)
            return None
        if not persona:
            return None
        return str(persona.get("name") or "") or None

    # ------------------------------------------------------------------
    # 工具定义
    # ------------------------------------------------------------------

    def _build(self) -> list[HermesTool]:
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
                            "description": "可选。想回忆的对象 QQ 号。这是检索提示（会偏向提到此人的记忆），不是硬过滤。",
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
                requires=("living_memory",),
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
                            "description": "可选。这条记忆关于谁（QQ 号）。会写进 metadata 并作为可检索的 key_fact。",
                            "default": "",
                        },
                    },
                    "required": ["content"],
                },
                handler=self._memorize_long_term_memory,
                requires=("living_memory",),
            ),
            HermesTool(
                name="query_knowledge_graph",
                description=(
                    "查知识图谱：给一个实体（人、物、话题），返回它在群聊记忆里的关系网络"
                    "与相关事实陈述。适合回答「A 和 B 是什么关系」、「关于 X 我们都知道什么」。"
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
                            "description": f"扩展跳数，1-{GRAPH_MAX_HOPS}，默认 2。跳数越大越发散。",
                            "default": 2,
                        },
                    },
                    "required": ["entity"],
                },
                handler=self._query_knowledge_graph,
                requires=("living_memory",),
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
        ]

    # ---------- 1. 召回 ----------

    async def _recall_long_term_memory(
        self,
        query: str,
        target_user_id: str = "",
        limit: int = 5,
    ) -> dict[str, Any]:
        cleaned = str(query or "").strip()
        if not cleaned:
            return {"ok": False, "error": "empty_query", "results": [], "count": 0}

        engine = self._memory_engine()
        if engine is None:
            return {
                "ok": False,
                "error": "living_memory_unavailable",
                "message": "LivingMemory 未挂载或尚未完成异步初始化",
                "results": [],
                "count": 0,
            }

        k = max(1, min(_as_int(limit, 5), 20))
        target = str(target_user_id or "").strip()
        search_query = f"{cleaned} {target}".strip() if target else cleaned
        scope = self._scope()
        persona = await self._persona()

        results = await engine.search_memories(
            query=search_query,
            k=k,
            session_id=scope,
            persona_id=persona,
        )

        items: list[dict[str, Any]] = []
        for result in results or []:
            content = str(getattr(result, "content", "") or "")
            metadata = dict(getattr(result, "metadata", None) or {})
            haystack = content + json.dumps(metadata, ensure_ascii=False, default=str)
            items.append(
                {
                    "id": _as_int(getattr(result, "doc_id", 0), 0),
                    "content": content,
                    "score": round(_as_float(getattr(result, "final_score", 0.0), 0.0), 4),
                    "importance": metadata.get("importance"),
                    "createTime": metadata.get("create_time"),
                    "topics": metadata.get("topics") or [],
                    "mentionsTarget": bool(target) and target in haystack,
                }
            )

        return {
            "ok": True,
            "query": cleaned,
            "count": len(items),
            "results": items,
            "scope": scope,
            "personaId": persona,
            "targetUserId": target,
            "targetIsHint": bool(target),
        }

    # ---------- 2. 写入 ----------

    async def _memorize_long_term_memory(
        self,
        content: str,
        category: str = "factual",
        target_user_id: str = "",
    ) -> dict[str, Any]:
        text = str(content or "").strip()
        if not text:
            return {"ok": False, "error": "empty_content", "memorized": False}

        engine = self._memory_engine()
        if engine is None:
            return {
                "ok": False,
                "error": "living_memory_unavailable",
                "message": "LivingMemory 未挂载或尚未完成异步初始化",
                "memorized": False,
            }

        raw_category = str(category or "").strip().lower()
        cat = raw_category if raw_category in MEMORY_CATEGORIES else "factual"
        target = str(target_user_id or "").strip()

        key_facts = [f"关联用户: {target}"] if target else []
        structured = {
            "summary": text,
            "topics": [cat],
            "key_facts": key_facts,
            "sentiment": "neutral",
            "importance": 0.7,
        }

        processor = self._memory_processor()
        if processor is not None and hasattr(processor, "build_memory_from_structured_data"):
            stored, metadata, importance = processor.build_memory_from_structured_data(
                structured_data=structured,
                is_group_chat=False,
                fallback_excerpt=text,
            )
        else:
            stored = " | ".join([text, "；".join(key_facts)]) if key_facts else text
            metadata = {
                "topics": [cat],
                "key_facts": key_facts,
                "sentiment": "neutral",
                "interaction_type": "private_chat",
                "canonical_summary": stored,
                "persona_summary": text,
                "summary_schema_version": "v2",
            }
            importance = 0.7
            logger.warning("拿不到 MemoryProcessor，本次用兜底 metadata 写入记忆")

        scope = self._scope()
        metadata["memory_origin"] = "hermes_tool"
        metadata["memory_category"] = cat
        metadata["source_session_id"] = scope or ""
        metadata["source_window"] = {
            "session_id": scope or "",
            "triggered_by": "hermes_agent",
            "tool_name": "memorize_long_term_memory",
        }
        if target:
            metadata["target_user_id"] = target

        persona = await self._persona()
        memory_id = await engine.add_memory(
            content=stored,
            session_id=scope,
            persona_id=persona,
            importance=importance,
            metadata=metadata,
        )

        payload: dict[str, Any] = {
            "ok": True,
            "memorized": True,
            "id": _as_int(memory_id, 0),
            "content": stored,
            "category": cat,
            "importance": round(_as_float(importance, 0.7), 3),
            "scope": scope,
            "personaId": persona,
        }
        if raw_category and raw_category != cat:
            payload["categoryFallback"] = {"requested": raw_category, "used": cat}
        return payload

    # ---------- 3. 图谱 ----------

    async def _query_knowledge_graph(self, entity: str, depth: int = 2) -> dict[str, Any]:
        name = str(entity or "").strip()
        if not name:
            return {"ok": False, "error": "empty_entity", "found": False}

        store = self._graph_store()
        if store is None:
            return {
                "ok": False,
                "error": "graph_store_unavailable",
                "message": "graph_memory.enabled 为 false，或 LivingMemory 尚未就绪",
                "found": False,
            }

        hops = max(1, min(_as_int(depth, 2), GRAPH_MAX_HOPS))
        tokens = [name] if name.lower() == name else [name, name.lower()]

        seeds = await store.search_nodes_by_tokens(tokens, limit=GRAPH_SEED_LIMIT)
        if not seeds:
            return {
                "ok": True,
                "entity": name,
                "found": False,
                "hopsWalked": 0,
                "seeds": [],
                "relations": [],
                "statements": [],
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
            relations.append(
                {
                    "source": source,
                    "relation": str(edge.get("relation_type") or ""),
                    "target": target,
                    "weight": round(_as_float(edge.get("weight"), 0.0), 3),
                    "confidence": round(_as_float(edge.get("confidence"), 0.0), 3),
                }
            )
        relations.sort(key=lambda r: (-r["weight"], r["source"], r["target"]))

        statements = [
            {
                "content": str(e.get("content") or ""),
                "type": str(e.get("entry_type") or ""),
                "relation": str(e.get("relation_type") or ""),
                "score": round(_as_float(e.get("score"), 0.0), 3),
                "memoryId": _as_int(e.get("source_memory_id"), 0),
            }
            for e in sorted(
                entries.values(),
                key=lambda e: -_as_float(e.get("score"), 0.0),
            )
        ]

        return {
            "ok": True,
            "entity": name,
            "found": True,
            "hopsWalked": hops_walked,
            "seeds": [
                {
                    "id": _as_int(node.get("id"), 0),
                    "value": str(node.get("node_value") or ""),
                    "type": str(node.get("node_type") or ""),
                }
                for node in seeds
            ],
            "nodesVisited": len(visited),
            "relations": relations,
            "statements": statements,
        }

    # ---------- 4. 黑话 ----------

    async def _query_community_jargon(self, word: str) -> dict[str, Any]:
        term = str(word or "").strip()
        if not term:
            return {"ok": False, "error": "empty_word", "found": False}

        db = self._db_manager()
        if db is None or not hasattr(db, "search_jargon"):
            return {
                "ok": True,
                "word": term,
                "found": False,
                "count": 0,
                "entries": [],
                "message": "未记录该黑话",
            }

        rows = await db.search_jargon(keyword=term, limit=10) or []
        entries = []
        for row in rows:
            entries.append(
                {
                    "word": str(row.get("content") or ""),
                    "meaning": row.get("meaning"),
                    "confirmed": row.get("is_jargon"),
                    "count": _as_int(row.get("count"), 0),
                    "inferenceComplete": bool(row.get("is_complete")),
                    "global": bool(row.get("is_global")),
                    "chatId": str(row.get("chat_id") or ""),
                    "contexts": _parse_raw_contexts(row.get("raw_content")),
                    "updatedAt": row.get("updated_at"),
                }
            )

        payload: dict[str, Any] = {
            "ok": True,
            "word": term,
            "found": bool(entries),
            "count": len(entries),
            "entries": entries,
        }

        graph = await self._graph_context_for(term)
        if graph is not None:
            payload["graph"] = graph
        return payload

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
        except Exception as exc:  # noqa: BLE001
            logger.debug("黑话查询的图谱对齐失败: %s", exc)
            return None
        return {
            "nodes": [str(n.get("node_value") or "") for n in nodes],
            "statements": [str(h.get("content") or "") for h in hits or []],
        }


# ======================================================================
# 小工具
# ======================================================================


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


__all__ = [
    "MANIFEST_VERSION",
    "MEMORY_CATEGORIES",
    "HermesTool",
    "ToolRegistry",
]
