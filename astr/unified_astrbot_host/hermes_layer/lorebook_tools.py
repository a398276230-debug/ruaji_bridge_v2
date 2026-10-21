"""Host-native World Info tools, independent of LivingMemory and embeddings.

The factory accepts the host's tool descriptor to avoid a registry import cycle.
Entry dictionaries remain native World Info JSON, including extension fields.
"""
from __future__ import annotations

import copy
import json
from typing import Any, Callable


# Describe native fields without flattening an entry into the former meme model.
# Unknown fields are intentionally allowed for lossless native JSON round-trips.
ENTRY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "原生 World Info 条目字典。省略 uid 时分配新编号；提供 uid 时合并更新该条目，"
        "未提供的字段保持原样。支持完整原生字段及未知扩展字段。"
    ),
    "properties": {
        "uid": {"type": "integer", "minimum": 0},
        "key": {"type": "array", "items": {"type": "string"}},
        "keysecondary": {"type": "array", "items": {"type": "string"}},
        "triggers": {"type": "array", "items": {"type": "string"}},
        **{name: {"type": "string"} for name in (
            "comment", "content", "group", "outletName", "automationId",
        )},
        **{name: {"type": "boolean"} for name in (
            "constant", "vectorized", "selective", "addMemo", "disable",
            "ignoreBudget", "excludeRecursion", "preventRecursion",
            "matchPersonaDescription", "matchCharacterDescription",
            "matchCharacterPersonality", "matchCharacterDepthPrompt",
            "matchScenario", "matchCreatorNotes", "useProbability", "groupOverride",
        )},
        **{name: {"type": ["boolean", "null"]} for name in (
            "caseSensitive", "matchWholeWords", "useGroupScoring",
        )},
        "displayIndex": {"type": "integer", "minimum": 0},
        "delayUntilRecursion": {"type": ["integer", "boolean"], "minimum": 0},
        **{name: {"type": ["integer", "null"], "minimum": 0} for name in (
            "depth", "scanDepth", "sticky", "cooldown", "delay",
        )},
        "order": {"type": "integer"},
        "extensions": {"type": "object", "additionalProperties": True},
        "selectiveLogic": {"type": "integer", "enum": [0, 1, 2, 3]},
        "position": {"type": "integer", "minimum": 0, "maximum": 7},
        "role": {"type": "integer", "enum": [0, 1, 2]},
        "probability": {"type": "number", "minimum": 0, "maximum": 100},
        "groupWeight": {"type": "number", "minimum": 0},
    },
    "additionalProperties": True,
}

SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "检索关键词，匹配条目原生 JSON。"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10},
        "book_id": {"type": "integer", "minimum": 1, "description": "可选；省略时搜索所有世界书。"},
    },
    "required": ["query"],
    "additionalProperties": False,
}

UPSERT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "book_id": {"type": "integer", "minimum": 1, "description": "已有世界书的编号。"},
        "entry": ENTRY_SCHEMA,
    },
    "required": ["book_id", "entry"],
    "additionalProperties": False,
}


def _bad_arguments(message: str) -> dict[str, Any]:
    return {"ok": False, "error": "bad_arguments", "message": message}


def _valid_book_id(book_id: Any) -> bool:
    return type(book_id) is int and book_id > 0


def build_lorebook_tools(unified: Any, tool_type: Callable[..., Any]) -> list[Any]:
    """Build both native tools once; resolve the synchronous store at call time."""

    async def search_lorebook_entries(
        query: str, limit: int = 10, book_id: int | None = None,
    ) -> dict[str, Any]:
        if not isinstance(query, str):
            return _bad_arguments("query must be a string")
        query = query.strip()
        if not query:
            return {"ok": False, "error": "empty_query", "results": [], "count": 0, "found": False}
        if type(limit) is not int or not 1 <= limit <= 100:
            return _bad_arguments("limit must be an integer from 1 to 100")
        if book_id is not None and not _valid_book_id(book_id):
            return _bad_arguments("book_id must be a positive integer")
        store = getattr(unified, "lorebook_store", None)
        if store is None:
            return {
                "ok": False, "error": "lorebook_store_unavailable",
                "message": "世界书数据库尚未初始化", "results": [], "count": 0, "found": False,
            }
        try:
            books = store.list_books()
            if book_id is not None:
                books = [book for book in books if book["id"] == book_id]
                if not books:
                    return {"ok": False, "error": "lorebook_not_found", "message": f"book {book_id} not found"}
            results = []
            needle = query.casefold()
            for book in books:
                for record in store.list_entries(book["id"]):
                    native = record["raw"]
                    if needle not in json.dumps(native, ensure_ascii=False).casefold():
                        continue
                    results.append({
                        "book_id": book["id"], "book_name": book["name"],
                        "uid": record["uid"], "entry": copy.deepcopy(native),
                    })
                    if len(results) >= limit:
                        break
                if len(results) >= limit:
                    break
        except (ValueError, TypeError) as exc:
            return _bad_arguments(str(exc))
        except KeyError as exc:
            return {"ok": False, "error": "lorebook_not_found", "message": str(exc)}
        return {
            "ok": True, "query": query, "book_id": book_id,
            "results": results, "count": len(results), "found": bool(results),
        }

    async def upsert_lorebook_entry(book_id: int, entry: dict[str, Any]) -> dict[str, Any]:
        if not _valid_book_id(book_id):
            return _bad_arguments("book_id must be a positive integer")
        if not isinstance(entry, dict):
            return _bad_arguments("entry must be a native World Info object")
        store = getattr(unified, "lorebook_store", None)
        if store is None:
            return {"ok": False, "error": "lorebook_store_unavailable", "message": "世界书数据库尚未初始化"}
        try:
            saved = store.upsert_entry(book_id, copy.deepcopy(entry))
        except (ValueError, TypeError) as exc:
            return _bad_arguments(str(exc))
        except KeyError as exc:
            return {"ok": False, "error": "lorebook_not_found", "message": str(exc)}
        return {"ok": True, "book_id": book_id, "uid": saved["uid"], "entry": saved["raw"]}

    return [
        tool_type(
            name="search_lorebook_entries",
            description=(
                "检索宿主世界书（World Info）条目，返回书名、编号和完整原生条目。"
                "可按 book_id 限定；包含禁用的世界书和条目以便管理。"
                "这是本地文本检索，不使用向量或 LivingMemory。"
            ),
            parameters=copy.deepcopy(SEARCH_SCHEMA),
            handler=search_lorebook_entries,
        ),
        tool_type(
            name="upsert_lorebook_entry",
            description=(
                "向指定世界书新增或更新一条原生 World Info 条目。entry 保留 key、"
                "content、position、depth、概率、递归、分组、时效及扩展字段。"
                "省略 uid 新建；提供 uid 按编号合并更新，未提供的字段保持原样。"
                "不依赖 LivingMemory，不写入旧社区梗库。"
            ),
            parameters=copy.deepcopy(UPSERT_SCHEMA),
            handler=upsert_lorebook_entry,
        ),
    ]


__all__ = ["build_lorebook_tools", "ENTRY_SCHEMA", "SEARCH_SCHEMA", "UPSERT_SCHEMA"]
