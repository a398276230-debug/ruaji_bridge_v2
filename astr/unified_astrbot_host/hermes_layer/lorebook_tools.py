"""Host-native World Info tools, independent of LivingMemory and embeddings.

The factory accepts the host's tool descriptor to avoid a registry import cycle.
Entry dictionaries remain native World Info JSON, including extension fields.
"""
from __future__ import annotations

import copy
import json
from typing import Any, Callable


# Native World Info entry field definitions with clear Chinese descriptions for MCP/LLM callers.
ENTRY_FIELD_PROPERTIES: dict[str, Any] = {
    "uid": {
        "type": "integer",
        "minimum": 0,
        "description": "世界书内的条目唯一编号（非负整数）。新建时自动分配，更新/删除时用于定位目标条目。",
    },
    "key": {
        "type": "array",
        "items": {"type": "string"},
        "description": (
            "主关键词列表（字符串数组，OR 关系，支持普通文本或 /regex/flags 正则）。"
            "绿灯条目（constant=false）必填且至少包含 1 个非空关键词；"
            "蓝灯常驻条目（constant=true）可传空数组 [] 或省略。"
        ),
    },
    "keysecondary": {
        "type": "array",
        "items": {"type": "string"},
        "description": "可选。副关键词列表（字符串数组），受 selective 与 selectiveLogic 控制。",
    },
    "triggers": {
        "type": "array",
        "items": {"type": "string"},
        "description": "可选。允许激活的生成类型列表（如 ['normal']），留空表示不限制。",
    },
    "content": {
        "type": "string",
        "description": "条目正文（非空字符串），条目被激活后将注入当轮对话上下文。",
    },
    "comment": {
        "type": "string",
        "description": "可选。条目标题或备注说明，便于检索与管理，不会注入对话上下文。",
    },
    "group": {
        "type": "string",
        "description": "可选。互斥分组名称（支持英文逗号分隔多组），同组条目同时命中时按优先级/权重择一激活。",
    },
    "outletName": {
        "type": "string",
        "description": "可选。原生 position=7 的 outlet 名称（仅存储兼容，运行时统一注入顶部资料块）。",
    },
    "automationId": {
        "type": "string",
        "description": "可选。原生 Quick Reply 自动化标识（仅存储兼容）。",
    },
    "constant": {
        "type": "boolean",
        "description": "可选。是否蓝灯常驻（默认 false 为绿灯关键词触发；true 为常驻激活，不要求 key 非空）。",
    },
    "vectorized": {
        "type": "boolean",
        "description": "可选。原生向量触发标记（仅存储兼容）。",
    },
    "selective": {
        "type": "boolean",
        "description": "可选。是否启用副关键词（keysecondary）门禁（默认 true）。",
    },
    "addMemo": {
        "type": "boolean",
        "description": "可选。编辑器备注显示开关（仅存储兼容）。",
    },
    "disable": {
        "type": "boolean",
        "description": "可选。是否禁用该条目（默认 false；true 时不参与激活）。",
    },
    "ignoreBudget": {
        "type": "boolean",
        "description": "可选。是否忽略引擎挑选阶段的预算上限（默认 false）。",
    },
    "excludeRecursion": {
        "type": "boolean",
        "description": "可选。递归扫描阶段是否禁止激活本条目（默认 false）。",
    },
    "preventRecursion": {
        "type": "boolean",
        "description": "可选。本条目激活后是否禁止将自身正文反馈进递归扫描池（默认 false）。",
    },
    "matchPersonaDescription": {
        "type": "boolean",
        "description": "可选。原生扫描开关：是否扫描用户人设描述（仅存储兼容）。",
    },
    "matchCharacterDescription": {
        "type": "boolean",
        "description": "可选。原生扫描开关：是否扫描角色描述（仅存储兼容）。",
    },
    "matchCharacterPersonality": {
        "type": "boolean",
        "description": "可选。原生扫描开关：是否扫描角色性格（仅存储兼容）。",
    },
    "matchCharacterDepthPrompt": {
        "type": "boolean",
        "description": "可选。原生扫描开关：是否扫描角色深度提示（仅存储兼容）。",
    },
    "matchScenario": {
        "type": "boolean",
        "description": "可选。原生扫描开关：是否扫描场景设定（仅存储兼容）。",
    },
    "matchCreatorNotes": {
        "type": "boolean",
        "description": "可选。原生扫描开关：是否扫描作者注释（仅存储兼容）。",
    },
    "useProbability": {
        "type": "boolean",
        "description": "可选。是否启用 probability 触发概率门禁（默认 true）。",
    },
    "groupOverride": {
        "type": "boolean",
        "description": "可选。互斥组内是否优先覆盖普通权重条目（默认 false）。",
    },
    "caseSensitive": {
        "type": ["boolean", "null"],
        "description": "可选。关键词匹配是否区分大小写（true/false，传 null 继承全局设置）。",
    },
    "matchWholeWords": {
        "type": ["boolean", "null"],
        "description": "可选。英文关键词是否按整词边界匹配（true/false，传 null 继承全局设置）。",
    },
    "useGroupScoring": {
        "type": ["boolean", "null"],
        "description": "可选。互斥组内是否先按关键词命中数评分筛选（true/false，传 null 继承全局设置）。",
    },
    "displayIndex": {
        "type": "integer",
        "minimum": 0,
        "description": "可选。编辑器显示顺序索引（非负整数，仅存储兼容）。",
    },
    "delayUntilRecursion": {
        "type": ["integer", "boolean"],
        "minimum": 0,
        "description": "可选。延迟到递归扫描阶段才允许激活的等级（非负整数或布尔值，默认 0）。",
    },
    "depth": {
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "可选。原生插入深度（仅存储兼容，运行时统一注入当次用户消息顶部）。",
    },
    "scanDepth": {
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "可选。关键词扫描最近多少条历史消息（非负整数，传 null 继承全局设置，0 表示不扫对话历史）。",
    },
    "sticky": {
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "可选。触发后持续保持激活的消息条数（非负整数，null 或 0 表示不启用）。",
    },
    "cooldown": {
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "可选。触发或 sticky 结束后的冷却消息条数（非负整数，null 或 0 表示不启用）。",
    },
    "delay": {
        "type": ["integer", "null"],
        "minimum": 0,
        "description": "可选。会话累计消息数达到多少条后才允许激活（非负整数，null 或 0 表示不启用）。",
    },
    "order": {
        "type": "integer",
        "description": "可选。预算挑选优先级与排序权重（整数，默认 100；越大越优先准入预算，最终按 order 升序拼接）。",
    },
    "extensions": {
        "type": "object",
        "additionalProperties": True,
        "description": "可选。自定义扩展字段字典（JSON 对象），保存时完整透传，更新时递归合并。",
    },
    "selectiveLogic": {
        "type": "integer",
        "enum": [0, 1, 2, 3],
        "description": "可选。副关键词匹配逻辑：0=AND ANY（任一命中），1=NOT ALL（不全命中），2=NOT ANY（全不命中），3=AND ALL（全部命中）。",
    },
    "position": {
        "type": "integer",
        "minimum": 0,
        "maximum": 7,
        "description": "可选。原生插入位置编号 0-7（仅存储兼容，运行时统一注入当次用户消息顶部）。",
    },
    "role": {
        "type": ["integer", "null"],
        "enum": [0, 1, 2, None],
        "description": "可选。原生角色编号 0=system/1=user/2=assistant（仅存储兼容）。",
    },
    "probability": {
        "type": "number",
        "minimum": 0,
        "maximum": 100,
        "description": "可选。触发概率百分比（0-100 的数字，默认 100）。",
    },
    "groupWeight": {
        "type": "number",
        "minimum": 0,
        "description": "可选。互斥组内随机抽签权重（非负数字，默认 100）。",
    },
}

# Describe native fields without flattening an entry into the former meme model.
# Unknown fields are intentionally allowed for lossless native JSON round-trips.
ENTRY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": (
        "原生 World Info 条目字典。省略 uid 时分配新编号；提供 uid 时合并更新该条目，"
        "未提供的字段保持原样。支持完整原生字段及未知扩展字段。"
    ),
    "properties": copy.deepcopy(ENTRY_FIELD_PROPERTIES),
    "additionalProperties": True,
}

BOOK_SELECTOR_PROPERTIES: dict[str, Any] = {
    "book": {
        "type": ["integer", "string"],
        "description": "目标世界书的 ID（正整数）或书名（非空字符串）。可与 book_id 二选一。",
    },
    "book_id": {
        "type": ["integer", "string"],
        "description": "可选兼容参数（同 book）：目标世界书的 ID（正整数）或书名。",
    },
}

SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "检索关键词，匹配条目原生 JSON（传 '*' 可列出书内全部条目）。",
        },
        "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "default": 10,
            "description": "返回最大条数（1-100，默认 10）。",
        },
        "book_id": {
            "type": "integer",
            "minimum": 1,
            "description": "可选；按世界书数字 ID 筛选，省略时搜索所有世界书。",
        },
        "book": {
            "type": ["integer", "string"],
            "description": "可选；按世界书数字 ID 或书名筛选，省略时搜索所有世界书。",
        },
    },
    "required": ["query"],
    "additionalProperties": False,
}

_MUTABLE_ENTRY_PROPERTIES: dict[str, Any] = {
    k: copy.deepcopy(v) for k, v in ENTRY_FIELD_PROPERTIES.items() if k != "uid"
}

ADD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        **copy.deepcopy(BOOK_SELECTOR_PROPERTIES),
        **copy.deepcopy(_MUTABLE_ENTRY_PROPERTIES),
    },
    "required": ["book", "content"],
    "additionalProperties": False,
}

UPDATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        **copy.deepcopy(BOOK_SELECTOR_PROPERTIES),
        "uid": {
            "type": "integer",
            "minimum": 0,
            "description": "必填。要修改的目标条目 uid（非负整数，可先通过 search_lorebook_entries 查询获取）。",
        },
        **copy.deepcopy(_MUTABLE_ENTRY_PROPERTIES),
    },
    "required": ["book", "uid"],
    "additionalProperties": False,
}

DELETE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        **copy.deepcopy(BOOK_SELECTOR_PROPERTIES),
        "uid": {
            "type": "integer",
            "minimum": 0,
            "description": "必填。要删除的目标条目 uid（非负整数，删除前请先用 search_lorebook_entries 确认）。",
        },
    },
    "required": ["book", "uid"],
    "additionalProperties": False,
}

UPSERT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "book_id": {"type": "integer", "minimum": 1, "description": "已有世界书的编号。"},
        "entry": copy.deepcopy(ENTRY_SCHEMA),
    },
    "required": ["book_id", "entry"],
    "additionalProperties": False,
}


def _bad_arguments(message: str) -> dict[str, Any]:
    return {"ok": False, "error": "bad_arguments", "message": message}


def _valid_book_id(book_id: Any) -> bool:
    return type(book_id) is int and book_id > 0


def _valid_uid(uid: Any) -> bool:
    return type(uid) is int and uid >= 0


def _resolve_single_book_selector(books: list[dict[str, Any]], selector: Any, label: str = "book") -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Resolve a book selector (positive int ID or non-empty book name) against store.list_books()."""
    if type(selector) is int:
        if selector <= 0:
            return None, _bad_arguments(f"{label} must be a positive integer")
        for b in books:
            if b["id"] == selector:
                return b, None
        return None, {"ok": False, "error": "lorebook_not_found", "message": f"book {selector} not found"}

    if isinstance(selector, str):
        name = selector.strip()
        if not name:
            return None, _bad_arguments(f"{label} must not be empty")
        for b in books:
            if b["name"] == name:
                return b, None
        folded = name.casefold()
        for b in books:
            if str(b.get("name") or "").strip().casefold() == folded:
                return b, None
        return None, {"ok": False, "error": "lorebook_not_found", "message": f"book '{name}' not found"}

    return None, _bad_arguments(f"{label} must be a positive integer ID or a non-empty book name string")


def _resolve_book(
    books: list[dict[str, Any]],
    book: Any = None,
    book_id: Any = None,
    *,
    required: bool = True,
    strict_int_book_id: bool = False,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Resolve `book` and/or `book_id` parameters to a single book dict."""
    if book is None and book_id is None:
        if required:
            return None, _bad_arguments("book (or book_id) is required")
        return None, None

    resolved_book = None
    if book is not None:
        resolved_book, err = _resolve_single_book_selector(books, book, "book")
        if err is not None:
            return None, err

    resolved_by_id = None
    if book_id is not None:
        if strict_int_book_id and not _valid_book_id(book_id):
            return None, _bad_arguments("book_id must be a positive integer")
        resolved_by_id, err = _resolve_single_book_selector(books, book_id, "book_id")
        if err is not None:
            return None, err

    if resolved_book is not None and resolved_by_id is not None:
        if resolved_book["id"] != resolved_by_id["id"]:
            return None, _bad_arguments("book and book_id refer to different books")

    return resolved_book or resolved_by_id, None


def _validate_keyword_list(value: Any, label: str = "key", *, allow_empty_list: bool = False) -> str | None:
    """Validate a keyword list; every element must be a non-empty string."""
    if type(value) is not list:
        return f"{label} must be an array of strings"
    for item in value:
        if type(item) is not str:
            return f"{label} must be an array of strings"
        if not item.strip():
            return f"{label} items must be non-empty strings"
    if not allow_empty_list and len(value) == 0:
        return f"{label} must contain at least one non-empty keyword"
    return None


def _find_entry_record(store: Any, book_id: int, uid: int) -> dict[str, Any] | None:
    for record in store.list_entries(book_id):
        if record["uid"] == uid:
            return record
    return None


def build_lorebook_tools(unified: Any, tool_type: Callable[..., Any]) -> list[Any]:
    """Build native World Info CRUD + search tools; resolve the synchronous store at call time."""

    async def search_lorebook_entries(
        query: str,
        limit: int = 10,
        book_id: int | None = None,
        book: int | str | None = None,
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
        if book is not None and type(book) is not int and not isinstance(book, str):
            return _bad_arguments("book must be a positive integer ID or a non-empty book name string")
        if type(book) is int and book <= 0:
            return _bad_arguments("book must be a positive integer")
        if isinstance(book, str) and not book.strip():
            return _bad_arguments("book must not be empty")

        store = getattr(unified, "lorebook_store", None)
        if store is None:
            return {
                "ok": False, "error": "lorebook_store_unavailable",
                "message": "世界书数据库尚未初始化", "results": [], "count": 0, "found": False,
            }
        try:
            all_books = store.list_books()
            target_book, err = _resolve_book(
                all_books, book=book, book_id=book_id, required=False, strict_int_book_id=True,
            )
            if err is not None:
                return err
            books = [target_book] if target_book is not None else all_books
            effective_book_id = target_book["id"] if target_book is not None else book_id

            results = []
            match_all = query == "*"
            needle = query.casefold()
            for b in books:
                for record in store.list_entries(b["id"]):
                    native = record["raw"]
                    if not match_all and needle not in json.dumps(native, ensure_ascii=False).casefold():
                        continue
                    results.append({
                        "book_id": b["id"], "book_name": b["name"],
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
            "ok": True,
            "query": query,
            "book_id": effective_book_id,
            "results": results,
            "count": len(results),
            "found": bool(results),
            "books": [
                {"id": b["id"], "name": b["name"], "enabled": bool(b.get("enabled", True))}
                for b in all_books
            ],
        }

    async def lorebook_add_entry(
        book: int | str | None = None,
        book_id: int | str | None = None,
        content: str | None = None,
        key: list[str] | None = None,
        **optional_fields: Any,
    ) -> dict[str, Any]:
        unknown = set(optional_fields) - set(_MUTABLE_ENTRY_PROPERTIES)
        if unknown:
            return _bad_arguments(f"unexpected argument(s): {', '.join(sorted(unknown))}")

        store = getattr(unified, "lorebook_store", None)
        if store is None:
            return {"ok": False, "error": "lorebook_store_unavailable", "message": "世界书数据库尚未初始化"}

        if type(content) is not str or not content.strip():
            return _bad_arguments("content must be a non-empty string")

        constant = optional_fields.get("constant", False)
        if type(constant) is not bool:
            return _bad_arguments("constant must be boolean")

        if constant:
            if key is None:
                normalized_key: list[str] = []
            else:
                key_err = _validate_keyword_list(key, "key", allow_empty_list=True)
                if key_err is not None:
                    return _bad_arguments(key_err)
                normalized_key = list(key)
        else:
            if key is None:
                return _bad_arguments("key is required for green-light (constant=False) entries")
            key_err = _validate_keyword_list(key, "key", allow_empty_list=False)
            if key_err is not None:
                return _bad_arguments(key_err)
            normalized_key = list(key)

        if "keysecondary" in optional_fields:
            sec_err = _validate_keyword_list(
                optional_fields["keysecondary"], "keysecondary", allow_empty_list=True,
            )
            if sec_err is not None:
                return _bad_arguments(sec_err)

        try:
            books = store.list_books()
            target_book, err = _resolve_book(books, book=book, book_id=book_id, required=True)
            if err is not None:
                return err
            assert target_book is not None

            entry_payload: dict[str, Any] = {
                "key": normalized_key,
                "content": content,
            }
            for field_name, field_value in optional_fields.items():
                entry_payload[field_name] = copy.deepcopy(field_value)

            saved = store.upsert_entry(target_book["id"], entry_payload)
        except (ValueError, TypeError) as exc:
            return _bad_arguments(str(exc))
        except KeyError as exc:
            return {"ok": False, "error": "lorebook_not_found", "message": str(exc)}

        return {
            "ok": True,
            "book_id": target_book["id"],
            "book_name": target_book["name"],
            "uid": saved["uid"],
            "entry": saved["raw"],
        }

    async def lorebook_update_entry(
        book: int | str | None = None,
        book_id: int | str | None = None,
        uid: int | None = None,
        **patch_fields: Any,
    ) -> dict[str, Any]:
        unknown = set(patch_fields) - set(_MUTABLE_ENTRY_PROPERTIES)
        if unknown:
            return _bad_arguments(f"unexpected argument(s): {', '.join(sorted(unknown))}")

        store = getattr(unified, "lorebook_store", None)
        if store is None:
            return {"ok": False, "error": "lorebook_store_unavailable", "message": "世界书数据库尚未初始化"}

        if not _valid_uid(uid):
            return _bad_arguments("uid must be a non-negative integer")
        assert type(uid) is int

        if not patch_fields:
            return _bad_arguments("at least one entry field must be provided to update")

        if "content" in patch_fields:
            if type(patch_fields["content"]) is not str or not patch_fields["content"].strip():
                return _bad_arguments("content must be a non-empty string")

        if "constant" in patch_fields and type(patch_fields["constant"]) is not bool:
            return _bad_arguments("constant must be boolean")

        if "key" in patch_fields:
            key_err = _validate_keyword_list(patch_fields["key"], "key", allow_empty_list=True)
            if key_err is not None:
                return _bad_arguments(key_err)

        if "keysecondary" in patch_fields:
            sec_err = _validate_keyword_list(
                patch_fields["keysecondary"], "keysecondary", allow_empty_list=True,
            )
            if sec_err is not None:
                return _bad_arguments(sec_err)

        try:
            books = store.list_books()
            target_book, err = _resolve_book(books, book=book, book_id=book_id, required=True)
            if err is not None:
                return err
            assert target_book is not None

            existing = _find_entry_record(store, target_book["id"], uid)
            if existing is None:
                return {
                    "ok": False,
                    "error": "entry_not_found",
                    "message": f"entry uid {uid} not found in book {target_book['id']} ({target_book['name']})",
                }

            existing_raw = existing["raw"]
            effective_constant = patch_fields.get("constant", existing_raw.get("constant", False))
            effective_key = patch_fields.get("key", existing_raw.get("key", []))
            if not effective_constant:
                key_err = _validate_keyword_list(effective_key, "key", allow_empty_list=False)
                if key_err is not None:
                    return _bad_arguments(
                        "green-light (constant=False) entry requires at least one non-empty keyword in key"
                    )

            patch_payload = copy.deepcopy(patch_fields)
            patch_payload["uid"] = uid
            saved = store.upsert_entry(target_book["id"], patch_payload)
        except (ValueError, TypeError) as exc:
            return _bad_arguments(str(exc))
        except KeyError as exc:
            return {"ok": False, "error": "lorebook_not_found", "message": str(exc)}

        return {
            "ok": True,
            "book_id": target_book["id"],
            "book_name": target_book["name"],
            "uid": saved["uid"],
            "entry": saved["raw"],
        }

    async def lorebook_delete_entry(
        book: int | str | None = None,
        book_id: int | str | None = None,
        uid: int | None = None,
    ) -> dict[str, Any]:
        store = getattr(unified, "lorebook_store", None)
        if store is None:
            return {"ok": False, "error": "lorebook_store_unavailable", "message": "世界书数据库尚未初始化"}

        if not _valid_uid(uid):
            return _bad_arguments("uid must be a non-negative integer")
        assert type(uid) is int

        try:
            books = store.list_books()
            target_book, err = _resolve_book(books, book=book, book_id=book_id, required=True)
            if err is not None:
                return err
            assert target_book is not None

            existing = _find_entry_record(store, target_book["id"], uid)
            if existing is None:
                return {
                    "ok": False,
                    "error": "entry_not_found",
                    "message": f"entry uid {uid} not found in book {target_book['id']} ({target_book['name']})",
                }

            deleted = store.delete_entry(target_book["id"], uid)
            if not deleted:
                return {
                    "ok": False,
                    "error": "entry_not_found",
                    "message": f"entry uid {uid} not found in book {target_book['id']} ({target_book['name']})",
                }
        except (ValueError, TypeError) as exc:
            return _bad_arguments(str(exc))
        except KeyError as exc:
            return {"ok": False, "error": "lorebook_not_found", "message": str(exc)}

        return {
            "ok": True,
            "book_id": target_book["id"],
            "book_name": target_book["name"],
            "uid": uid,
            "deleted": True,
            "entry": copy.deepcopy(existing["raw"]),
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
                "检索宿主世界书（World Info）条目，返回书名、book_id、uid、完整原生条目及当前世界书列表。"
                "可按 book（书名或 ID）或 book_id 限定范围；query 传 '*' 可列出书内全部条目。"
                "包含禁用的世界书和条目以便管理。编辑或删除条目前请先调用本工具确认 book_id 与 uid。"
            ),
            parameters=copy.deepcopy(SEARCH_SCHEMA),
            handler=search_lorebook_entries,
        ),
        tool_type(
            name="lorebook_add_entry",
            description=(
                "向指定世界书新建一条 World Info 条目，自动分配并返回新条目的 uid。"
                "必填参数：book（世界书 ID 或书名，也可传 book_id）、content（非空正文）；"
                "绿灯条目（默认 constant=false）必须提供至少包含 1 个非空关键词的 key 列表；"
                "蓝灯常驻条目（constant=true）key 可传空列表 [] 或省略。"
                "可选支持 group、constant、order、disable、probability、scanDepth、caseSensitive、"
                "matchWholeWords、selective、selectiveLogic、keysecondary、comment、extensions 等字段。"
                "成功返回 {ok: true, book_id, uid, entry}。"
            ),
            parameters=copy.deepcopy(ADD_SCHEMA),
            handler=lorebook_add_entry,
        ),
        tool_type(
            name="lorebook_update_entry",
            description=(
                "按部分字段更新（patch 语义）指定世界书中已有的单条 World Info 条目。"
                "必填 book（世界书 ID 或书名，也可传 book_id）与 uid（目标条目编号，可先用 search_lorebook_entries 查询）。"
                "只修改本次传入的字段，未传入的字段（包括原生的 position/depth/role 及未触碰的扩展属性）严格保持原值，"
                "绝不会把未传字段重置为默认值；extensions 对象会按字典递归合并。"
                "支持修改 key、content、group、constant、order、disable、probability、scanDepth、"
                "caseSensitive、matchWholeWords、selective、selectiveLogic、keysecondary、comment、extensions 等字段。"
                "成功返回 {ok: true, book_id, uid, entry}。"
            ),
            parameters=copy.deepcopy(UPDATE_SCHEMA),
            handler=lorebook_update_entry,
        ),
        tool_type(
            name="lorebook_delete_entry",
            description=(
                "从指定世界书中删除单条 World Info 条目。必填 book（世界书 ID 或书名，也可传 book_id）与 uid。"
                "【注意】删除操作不可逆，调用本工具前必须先用 search_lorebook_entries 查询确认目标的 book_id 与 uid，避免误删。"
                "成功返回 {ok: true, book_id, uid, entry}（entry 为被删条目的原内容备份）。"
            ),
            parameters=copy.deepcopy(DELETE_SCHEMA),
            handler=lorebook_delete_entry,
        ),
        tool_type(
            name="upsert_lorebook_entry",
            description=(
                "【底层原生 JSON 兼容保留接口】日常新建条目请用 lorebook_add_entry，"
                "部分修改已有条目请用 lorebook_update_entry，删除条目请用 lorebook_delete_entry。"
                "本工具仅供直接导入或整包覆写完整原生 World Info entry 字典（含未知第三方扩展字段）时兼容调用。"
            ),
            parameters=copy.deepcopy(UPSERT_SCHEMA),
            handler=upsert_lorebook_entry,
        ),
    ]


__all__ = [
    "build_lorebook_tools",
    "ENTRY_FIELD_PROPERTIES",
    "ENTRY_SCHEMA",
    "SEARCH_SCHEMA",
    "ADD_SCHEMA",
    "UPDATE_SCHEMA",
    "DELETE_SCHEMA",
    "UPSERT_SCHEMA",
]
