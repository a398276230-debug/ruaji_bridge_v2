"""Native lorebook tool registration and synchronous store integration.

Run from host: .venv/Scripts/python.exe -m pytest tests/test_lorebook_tools.py -q -p no:cacheprovider
All temporary data is isolated under the repository's roming directory.
"""
from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

import pytest

HOST = Path(__file__).resolve().parents[1]
REPO = HOST.parents[1]
sys.path.insert(0, str(HOST))
import bootstrap  # noqa: E402,F401

from hermes_layer.adapters.living_memory_adapter import LivingMemoryAdapter  # noqa: E402
from hermes_layer.lorebook_store import LorebookStore  # noqa: E402
from hermes_layer.lorebook_tools import (  # noqa: E402
    ADD_SCHEMA,
    DELETE_SCHEMA,
    ENTRY_SCHEMA,
    SEARCH_SCHEMA,
    UPDATE_SCHEMA,
    UPSERT_SCHEMA,
    build_lorebook_tools,
)
from hermes_layer.plugin_contract import HermesTool as AdapterTool  # noqa: E402
from hermes_layer.tool_registry import HermesTool, ToolRegistry  # noqa: E402


NATIVE_NAMES = {
    "search_lorebook_entries",
    "lorebook_add_entry",
    "lorebook_update_entry",
    "lorebook_delete_entry",
    "upsert_lorebook_entry",
}
LEGACY_NAMES = {"search_community_meme", "record_community_meme"}


def _deep_merge(original: dict, patch: dict) -> dict:
    result = dict(original)
    for key, value in patch.items():
        result[key] = (
            _deep_merge(result[key], value)
            if type(value) is dict and type(result.get(key)) is dict
            else value
        )
    return result


class DummyStore:
    """Synchronous store contract, deliberately without meme or vector methods."""

    def __init__(self):
        self.books = [
            {"id": 1, "name": "First", "enabled": True},
            {"id": 2, "name": "Disabled", "enabled": False},
        ]
        self.records = {
            1: [{"uid": 0, "raw": {"uid": 0, "key": ["CAT"], "content": "first cat"}}],
            2: [{"uid": 0, "raw": {"uid": 0, "key": ["cat"], "content": "second cat", "disable": True}}],
        }

    def list_books(self):
        return copy.deepcopy(self.books)

    def list_entries(self, book_id):
        if book_id not in self.records:
            raise KeyError(book_id)
        return copy.deepcopy(self.records[book_id])

    def upsert_entry(self, book_id, entry, uid=None):
        if book_id not in self.records:
            raise KeyError(book_id)
        target_uid = uid if uid is not None else entry.get("uid")
        if target_uid is None:
            target_uid = max((record["uid"] for record in self.records[book_id]), default=-1) + 1
        patch = copy.deepcopy(entry)
        patch["uid"] = target_uid
        for record in self.records[book_id]:
            if record["uid"] == target_uid:
                record["raw"] = _deep_merge(record["raw"], patch)
                return copy.deepcopy(record)
        record = {"uid": target_uid, "raw": patch}
        self.records[book_id].append(record)
        return copy.deepcopy(record)

    def delete_entry(self, book_id, uid):
        if book_id not in self.records:
            raise KeyError(book_id)
        before = len(self.records[book_id])
        self.records[book_id] = [r for r in self.records[book_id] if r["uid"] != uid]
        return len(self.records[book_id]) < before


def unified(store=None):
    return SimpleNamespace(config={}, mounts={}, adapters=[], lorebook_store=store)


def call(registry, name, arguments=None):
    return asyncio.run(registry.call(name, arguments))


@pytest.fixture
def store():
    (REPO / "roming").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lorebook-tools-", dir=REPO / "roming") as directory:
        yield LorebookStore(Path(directory) / "data")


def test_native_registration_without_living_memory_or_store():
    host = unified()
    registry = ToolRegistry(host)
    assert NATIVE_NAMES <= set(registry.names)
    assert not LEGACY_NAMES.intersection(registry.names)
    manifest = {tool["name"]: tool for tool in registry.manifest()["tools"]}
    for name in NATIVE_NAMES:
        assert manifest[name]["requires"] == []
    assert call(registry, "search_lorebook_entries", {"query": "cat"})["error"] == "lorebook_store_unavailable"
    assert call(registry, "lorebook_add_entry", {"book": 1, "content": "x", "key": ["k"]})["error"] == "lorebook_store_unavailable"
    assert call(registry, "lorebook_update_entry", {"book": 1, "uid": 0, "content": "x"})["error"] == "lorebook_store_unavailable"
    assert call(registry, "lorebook_delete_entry", {"book": 1, "uid": 0})["error"] == "lorebook_store_unavailable"
    assert call(registry, "upsert_lorebook_entry", {"book_id": 1, "entry": {}})["error"] == "lorebook_store_unavailable"
    for name in LEGACY_NAMES:
        assert call(registry, name)["error"] == "unknown_tool"

    # Store startup can finish after the registry has already been constructed.
    host.lorebook_store = DummyStore()
    result = call(registry, "search_lorebook_entries", {"query": "cat"})
    assert result["ok"] is True and result["count"] == 2


def test_native_registration_when_unrelated_adapter_bypasses_build(monkeypatch):
    async def unrelated_handler():
        return {"ok": True}

    class Adapter:
        plugin_key = "other_plugin"

        def export_tools(self):
            return [AdapterTool("other_tool", "other", {"type": "object"}, unrelated_handler)]

    host = unified(DummyStore())
    host.adapters = [Adapter()]
    host.mounts = {"other_plugin": SimpleNamespace(config={})}

    def must_not_build(_self):
        raise AssertionError("adapter contributed, legacy _build must not run")

    monkeypatch.setattr(ToolRegistry, "_build", must_not_build)
    registry = ToolRegistry(host)
    assert set(registry.names) == NATIVE_NAMES | {"other_tool"}
    assert call(registry, "other_tool")["ok"] is True
    assert call(registry, "search_lorebook_entries", {"query": "CAT"})["count"] == 2
    registry._rebuild()
    assert set(registry.names) == NATIVE_NAMES | {"other_tool"}


def test_living_memory_adapter_exports_only_plugin_tools():
    host = unified(DummyStore())
    adapter = LivingMemoryAdapter(host)
    names = {tool.name for tool in adapter.export_tools()}
    assert names == {"recall_long_term_memory", "memorize_long_term_memory", "query_knowledge_graph"}
    assert not hasattr(adapter, "_meme_store")
    assert not hasattr(adapter, "_search_community_meme")
    assert not hasattr(adapter, "_record_community_meme")
    host.adapters = [adapter]
    host.mounts = {"living_memory": SimpleNamespace(config={})}
    registry = ToolRegistry(host)
    assert set(registry.names) == names | NATIVE_NAMES
    assert len(registry.names) == 8
    assert call(registry, "search_lorebook_entries", {"query": "cat"})["count"] == 2


def test_unmounted_adapter_does_not_hide_native_tools():
    host = unified(DummyStore())
    host.adapters = [LivingMemoryAdapter(host)]
    registry = ToolRegistry(host)
    assert NATIVE_NAMES <= set(registry.names)
    assert not LEGACY_NAMES.intersection(registry.names)


def test_schema_native_fields_extensions_and_factory_isolation():
    first = {tool.name: tool for tool in build_lorebook_tools(unified(), HermesTool)}
    second = {tool.name: tool for tool in build_lorebook_tools(unified(), HermesTool)}
    search = first["search_lorebook_entries"].parameters
    assert search["required"] == ["query"]
    assert set(search["properties"]) == {"query", "limit", "book_id", "book"}

    add_schema = first["lorebook_add_entry"].parameters
    assert set(add_schema["required"]) == {"content"}
    assert "uid" not in add_schema["properties"]
    assert {"book", "book_id", "content", "key", "group", "constant", "order", "disable",
            "probability", "scanDepth", "caseSensitive", "matchWholeWords", "selective",
            "selectiveLogic", "keysecondary", "extensions"} <= set(add_schema["properties"])

    update_schema = first["lorebook_update_entry"].parameters
    assert set(update_schema["required"]) == {"book", "uid"}
    assert {"book", "book_id", "uid", "content", "key", "group", "constant", "order", "disable",
            "probability", "scanDepth", "caseSensitive", "matchWholeWords", "selective",
            "selectiveLogic", "keysecondary", "extensions"} <= set(update_schema["properties"])

    delete_schema = first["lorebook_delete_entry"].parameters
    assert set(delete_schema["required"]) == {"book", "uid"}
    assert set(delete_schema["properties"]) == {"book", "book_id", "uid"}
    assert "search_lorebook_entries" in first["lorebook_delete_entry"].description
    assert "search_lorebook_entries" in first["lorebook_add_entry"].description
    assert "update" in first["lorebook_add_entry"].description
    assert "constant=false" in first["lorebook_add_entry"].description
    assert "autoMaintained" in first["lorebook_add_entry"].description
    assert "defaultTargetBook" in first["lorebook_add_entry"].description
    assert "autoMaintained" in first["lorebook_update_entry"].description

    schema = first["upsert_lorebook_entry"].parameters
    assert set(schema["required"]) == {"book_id", "entry"}
    native = schema["properties"]["entry"]
    assert native["additionalProperties"] is True
    assert {"uid", "key", "keysecondary", "content", "constant", "vectorized", "selective",
            "selectiveLogic", "disable", "order", "position", "depth", "role", "probability",
            "useProbability", "excludeRecursion", "preventRecursion", "delayUntilRecursion",
            "group", "groupOverride", "groupWeight", "useGroupScoring", "scanDepth",
            "caseSensitive", "matchWholeWords", "sticky", "cooldown", "delay", "extensions",
            "matchPersonaDescription", "matchCharacterDescription", "matchCharacterPersonality",
            "matchCharacterDepthPrompt", "matchScenario", "matchCreatorNotes", "triggers"} <= set(native["properties"])
    json.dumps([tool.to_manifest() for tool in first.values()], allow_nan=False)
    native["properties"]["uid"]["minimum"] = 123
    assert second["upsert_lorebook_entry"].parameters["properties"]["entry"]["properties"]["uid"]["minimum"] == 0
    assert ADD_SCHEMA is not first["lorebook_add_entry"].parameters
    assert UPDATE_SCHEMA is not first["lorebook_update_entry"].parameters
    assert DELETE_SCHEMA is not first["lorebook_delete_entry"].parameters
    assert SEARCH_SCHEMA is not first["search_lorebook_entries"].parameters
    assert UPSERT_SCHEMA is not first["upsert_lorebook_entry"].parameters
    assert ENTRY_SCHEMA is not first["upsert_lorebook_entry"].parameters["properties"]["entry"]


def test_search_casefold_filter_limit_book_name_and_native_results():
    registry = ToolRegistry(unified(DummyStore()))
    result = call(registry, "search_lorebook_entries", {"query": "  CAT  ", "limit": 1})
    assert result["ok"] is True and result["count"] == 1 and result["found"] is True
    assert result["query"] == "CAT" and result["tool"] == "search_lorebook_entries"
    assert result["results"][0] == {
        "book_id": 1, "book_name": "First", "uid": 0,
        "entry": {"uid": 0, "key": ["CAT"], "content": "first cat"},
    }
    result = call(registry, "search_lorebook_entries", {"query": "cat", "book_id": 2})
    assert result["count"] == 1 and result["results"][0]["entry"]["disable"] is True
    assert result["results"][0]["book_id"] == 2
    by_name = call(registry, "search_lorebook_entries", {"query": "cat", "book": "disabled"})
    assert by_name["ok"] is True and by_name["count"] == 1 and by_name["book_id"] == 2
    wildcard = call(registry, "search_lorebook_entries", {"query": "*", "book": "First"})
    assert wildcard["ok"] is True and wildcard["count"] == 1 and wildcard["results"][0]["uid"] == 0
    result = call(registry, "search_lorebook_entries", {"query": "unmatched"})
    assert result["ok"] is True and result["count"] == 0 and result["found"] is False
    assert call(registry, "search_lorebook_entries", {"query": "cat", "book_id": 999})["error"] == "lorebook_not_found"
    assert call(registry, "search_lorebook_entries", {"query": "cat", "book": "NoSuchBook"})["error"] == "lorebook_not_found"


@pytest.mark.parametrize("name,arguments,error", [
    ("search_lorebook_entries", {"query": " "}, "empty_query"),
    ("search_lorebook_entries", {"query": 1}, "bad_arguments"),
    ("search_lorebook_entries", {}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "limit": 0}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "limit": 101}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "limit": True}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book_id": False}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book_id": "1"}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book": ""}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book": 0}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book": 1, "book_id": 2}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "unknown": 1}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "", "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "   ", "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "valid"}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "valid", "key": []}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "valid", "key": ["  "]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "valid", "key": [123]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "valid", "key": "not-a-list"}, "bad_arguments"),
    ("lorebook_add_entry", {"content": "valid", "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 0, "content": "valid", "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": True, "content": "valid", "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": "   ", "content": "valid", "key": ["k"]}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 999, "content": "valid", "key": ["k"]}, "lorebook_not_found"),
    ("lorebook_add_entry", {"book": "MissingBook", "content": "valid", "key": ["k"]}, "lorebook_not_found"),
    ("lorebook_add_entry", {"book": 1, "content": "valid", "key": ["k"], "uid": 5}, "bad_arguments"),
    ("lorebook_add_entry", {"book": 1, "content": "valid", "key": ["k"], "unknown_field": 1}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": 0}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": -1, "content": "x"}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": True, "content": "x"}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": "0", "content": "x"}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": 0, "content": ""}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": 0, "content": "   "}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": 0, "key": []}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": 0, "key": [""]}, "bad_arguments"),
    ("lorebook_update_entry", {"book": 1, "uid": 999, "content": "x"}, "entry_not_found"),
    ("lorebook_update_entry", {"book": 999, "uid": 0, "content": "x"}, "lorebook_not_found"),
    ("lorebook_update_entry", {"book": "MissingBook", "uid": 0, "content": "x"}, "lorebook_not_found"),
    ("lorebook_update_entry", {"book": 1, "uid": 0, "unknown_field": 1}, "bad_arguments"),
    ("lorebook_delete_entry", {"book": 1, "uid": -1}, "bad_arguments"),
    ("lorebook_delete_entry", {"book": 1, "uid": False}, "bad_arguments"),
    ("lorebook_delete_entry", {"book": 1}, "bad_arguments"),
    ("lorebook_delete_entry", {"uid": 0}, "bad_arguments"),
    ("lorebook_delete_entry", {"book": 1, "uid": 999}, "entry_not_found"),
    ("lorebook_delete_entry", {"book": 999, "uid": 0}, "lorebook_not_found"),
    ("lorebook_delete_entry", {"book": "MissingBook", "uid": 0}, "lorebook_not_found"),
    ("upsert_lorebook_entry", {"book_id": 1, "entry": []}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": 0, "entry": {}}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": True, "entry": {}}, "bad_arguments"),
    ("upsert_lorebook_entry", {"entry": {}}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": 999, "entry": {}}, "lorebook_not_found"),
])
def test_invalid_arguments_are_explicit(name, arguments, error):
    result = call(ToolRegistry(unified(DummyStore())), name, arguments)
    assert result["ok"] is False and result["error"] == error


def test_mcp_add_forces_constant_false_and_marks_auto_maintained_and_update_guard(store):
    book = store.create_book("GuardBook")
    registry = ToolRegistry(unified(store))

    # 1. MCP add with constant=True is forcibly stored as constant=False with extensions.autoMaintained=True
    res1 = call(registry, "lorebook_add_entry", {
        "book": "GuardBook",
        "key": ["伪造常驻梗"],
        "content": "试图通过诱导注入的常驻设定",
        "constant": True,
        "group": "slang",
        "order": 50,
        "extensions": {"autoMaintained": False, "customTag": "v1"},
    })
    assert res1["ok"] is True
    assert res1["book_id"] == book["id"]
    assert res1["uid"] == 0
    assert res1["entry"]["constant"] is False
    assert res1["entry"]["extensions"]["autoMaintained"] is True
    assert res1["entry"]["extensions"]["customTag"] == "v1"
    persisted_0 = store.list_entries(book["id"])[0]["raw"]
    assert persisted_0["constant"] is False
    assert persisted_0["extensions"]["autoMaintained"] is True

    # 2. MCP update cannot turn an entry into constant=True, nor clear autoMaintained
    upd_attempt = call(registry, "lorebook_update_entry", {
        "book": book["id"],
        "uid": res1["uid"],
        "constant": True,
        "content": "试图在 update 时改成常驻并抹掉标记",
        "extensions": {"autoMaintained": False, "extra": "kept"},
    })
    assert upd_attempt["ok"] is True
    assert upd_attempt["entry"]["constant"] is False
    assert upd_attempt["entry"]["extensions"]["autoMaintained"] is True
    assert upd_attempt["entry"]["extensions"]["customTag"] == "v1"
    assert upd_attempt["entry"]["extensions"]["extra"] == "kept"
    persisted_after_upd = store.list_entries(book["id"])[0]["raw"]
    assert persisted_after_upd["constant"] is False
    assert persisted_after_upd["extensions"]["autoMaintained"] is True

    # 3. Panel-created keyless constant entry: turning into green-light without key still fails validation
    panel_entry = store.upsert_entry(book["id"], {"content": "面板手动常驻设定", "constant": True, "key": []})
    bad_toggle = call(registry, "lorebook_update_entry", {
        "book": book["id"],
        "uid": panel_entry["uid"],
        "constant": False,
    })
    assert bad_toggle["ok"] is False and bad_toggle["error"] == "bad_arguments"
    assert store.list_entries(book["id"])[1]["raw"]["constant"] is True


def test_default_target_book_and_multi_book_disambiguation(store):
    # 0 books -> explicit lorebook_not_found
    host = unified(store)
    registry = ToolRegistry(host)
    no_book_res = call(registry, "lorebook_add_entry", {"key": ["孤立词条"], "content": "无书时报错"})
    assert no_book_res["ok"] is False and no_book_res["error"] == "lorebook_not_found"

    # 1 book, no defaultTargetBook -> automatically selects the single book when book is omitted
    book1 = store.create_book("角色核心设定集")
    single_res = call(registry, "lorebook_add_entry", {
        "key": ["单书自动命中"],
        "content": "只有一本书时可省略 book 直接写入",
    })
    assert single_res["ok"] is True
    assert single_res["book_id"] == book1["id"]
    assert single_res["book_name"] == "角色核心设定集"
    assert single_res["entry"]["constant"] is False
    assert single_res["entry"]["extensions"]["autoMaintained"] is True

    # 2 books, no defaultTargetBook -> omitting book fails and lists all available book names
    book2 = store.create_book("群聊黑话词典")
    ambiguous = call(registry, "lorebook_add_entry", {
        "key": ["新黑话"],
        "content": "多本书且未配默认书时省略 book 必须报错",
    })
    assert ambiguous["ok"] is False
    assert ambiguous["error"] == "bad_arguments"
    assert ambiguous.get("reason") == "default_target_book_required"
    assert "角色核心设定集" in ambiguous["message"]
    assert "群聊黑话词典" in ambiguous["message"]
    assert ambiguous["book_names"] == ["角色核心设定集", "群聊黑话词典"]
    assert len(store.list_entries(book1["id"])) == 1
    assert len(store.list_entries(book2["id"])) == 0

    # Configure defaultTargetBook by name -> omitting book writes into the configured default book
    host.config = {"lorebook": {"defaultTargetBook": "群聊黑话词典"}}
    default_by_name = call(registry, "lorebook_add_entry", {
        "key": ["急急国王"],
        "content": "形容做事非常急躁的人。",
    })
    assert default_by_name["ok"] is True
    assert default_by_name["book_id"] == book2["id"]
    assert default_by_name["book_name"] == "群聊黑话词典"
    assert default_by_name["entry"]["constant"] is False
    assert default_by_name["entry"]["extensions"]["autoMaintained"] is True
    assert len(store.list_entries(book2["id"])) == 1

    # Configure defaultTargetBook by book ID (int or string) -> writes into that book; explicit book still overrides
    host.config = {"lorebook": {"defaultTargetBook": book1["id"]}}
    default_by_id = call(registry, "lorebook_add_entry", {
        "key": ["按ID默认写入"],
        "content": "通过数字 ID 指定默认世界书。",
    })
    assert default_by_id["ok"] is True
    assert default_by_id["book_id"] == book1["id"]

    override_res = call(registry, "lorebook_add_entry", {
        "book": "群聊黑话词典",
        "key": ["显式指定优先"],
        "content": "显式传 book 时覆盖 defaultTargetBook。",
    })
    assert override_res["ok"] is True
    assert override_res["book_id"] == book2["id"]


def test_add_update_patch_semantics_and_delete_lifecycle(store):
    book = store.create_book("艾尔多利亚编年史")
    registry = ToolRegistry(unified(store))

    initial_fields = {
        "book": "艾尔多利亚编年史",
        "content": "初始正文：古龙栖息在北境火山。",
        "key": ["古龙", "北境火山"],
        "keysecondary": ["红龙", "炎息"],
        "comment": "北境古龙设定",
        "group": "dragons",
        "constant": False,
        "order": 120,
        "disable": False,
        "probability": 85.5,
        "useProbability": True,
        "scanDepth": 6,
        "caseSensitive": True,
        "matchWholeWords": False,
        "selective": True,
        "selectiveLogic": 2,
        "position": 4,
        "depth": 3,
        "role": 1,
        "sticky": 4,
        "cooldown": 2,
        "delay": 1,
        "excludeRecursion": True,
        "preventRecursion": False,
        "delayUntilRecursion": 1,
        "ignoreBudget": True,
        "groupOverride": True,
        "groupWeight": 55.0,
        "useGroupScoring": False,
        "extensions": {"author": "ruaji", "nested": {"version": 1, "keep": "yes"}},
    }
    added = call(registry, "lorebook_add_entry", initial_fields)
    assert added["ok"] is True
    assert added["book_id"] == book["id"]
    uid = added["uid"]
    assert uid == 0

    expected = {k: copy.deepcopy(v) for k, v in initial_fields.items() if k != "book"}
    expected["uid"] = uid
    expected["extensions"]["autoMaintained"] = True
    for k, v in expected.items():
        assert added["entry"][k] == v, f"field {k} mismatch after add"

    # Partial update 1: only update content and order; every other field must remain untouched.
    updated_1 = call(registry, "lorebook_update_entry", {
        "book": book["id"],
        "uid": uid,
        "content": "更新后正文：古龙已迁徙至灰烬裂谷。",
        "order": 200,
    })
    assert updated_1["ok"] is True
    assert updated_1["book_id"] == book["id"]
    assert updated_1["uid"] == uid
    expected["content"] = "更新后正文：古龙已迁徙至灰烬裂谷。"
    expected["order"] = 200
    for k, v in expected.items():
        assert updated_1["entry"][k] == v, f"field {k} was unexpectedly altered during partial update 1"

    # Partial update 2: update by book name, only touch probability, scanDepth=None, and nested extensions.
    updated_2 = call(registry, "lorebook_update_entry", {
        "book": "艾尔多利亚编年史",
        "uid": uid,
        "probability": 60,
        "scanDepth": None,
        "extensions": {"nested": {"version": 2, "added_flag": True}},
    })
    assert updated_2["ok"] is True
    expected["probability"] = 60
    expected["scanDepth"] = None
    expected["extensions"]["nested"]["version"] = 2
    expected["extensions"]["nested"]["added_flag"] = True
    # Verify untouched nested key 'keep' and top-level 'author' in extensions survived
    assert updated_2["entry"]["extensions"]["author"] == "ruaji"
    assert updated_2["entry"]["extensions"]["nested"]["keep"] == "yes"
    for k, v in expected.items():
        assert updated_2["entry"][k] == v, f"field {k} was unexpectedly altered during partial update 2"

    # Search back to verify persistence
    searched = call(registry, "search_lorebook_entries", {"query": "灰烬裂谷", "book": "艾尔多利亚编年史"})
    assert searched["ok"] is True and searched["count"] == 1
    assert searched["results"][0]["uid"] == uid
    assert searched["results"][0]["entry"] == expected

    # Delete the entry
    deleted = call(registry, "lorebook_delete_entry", {"book": "艾尔多利亚编年史", "uid": uid})
    assert deleted["ok"] is True
    assert deleted["book_id"] == book["id"]
    assert deleted["uid"] == uid
    assert deleted["deleted"] is True
    assert deleted["entry"] == expected

    # Confirm entry is gone from search and store
    after_search = call(registry, "search_lorebook_entries", {"query": "灰烬裂谷", "book_id": book["id"]})
    assert after_search["ok"] is True and after_search["count"] == 0 and after_search["found"] is False
    assert store.list_entries(book["id"]) == []

    # Deleting the same uid again must fail with entry_not_found
    delete_again = call(registry, "lorebook_delete_entry", {"book": book["id"], "uid": uid})
    assert delete_again["ok"] is False and delete_again["error"] == "entry_not_found"


def test_upsert_passes_native_dictionary_without_mutating_arguments():
    registry = ToolRegistry(unified(DummyStore()))
    entry = {"key": ["new"], "content": "native", "extensions": {"future": [None, False]}}
    before = copy.deepcopy(entry)
    result = call(registry, "upsert_lorebook_entry", {"book_id": 1, "entry": entry})
    assert entry == before and "uid" not in entry
    assert result["ok"] is True and result["uid"] == 1
    assert result["entry"]["extensions"] == before["extensions"]


def test_real_store_crud_preserves_native_fields_and_persistence(store):
    book = store.create_book("Native")
    other = store.create_book("Disabled", enabled=False)
    registry = ToolRegistry(unified(store))
    native = {
        "key": ["世界书", "Dragon"], "keysecondary": ["red", "blue"],
        "comment": "Native field test", "content": "  exact\n\t正文  ",
        "constant": False, "vectorized": False, "selective": True, "selectiveLogic": 2,
        "disable": False, "order": -3, "position": 4, "depth": 6, "role": 2,
        "probability": 42.5, "useProbability": True,
        "excludeRecursion": True, "preventRecursion": False, "delayUntilRecursion": 2,
        "ignoreBudget": True, "group": "g", "groupOverride": True, "groupWeight": 7.5,
        "useGroupScoring": None, "scanDepth": 0, "caseSensitive": None, "matchWholeWords": True,
        "matchPersonaDescription": True, "matchCharacterDescription": False,
        "matchCharacterPersonality": True, "matchCharacterDepthPrompt": False,
        "matchScenario": True, "matchCreatorNotes": True,
        "sticky": 3, "cooldown": 2, "delay": 1, "triggers": ["normal"],
        "extensions": {"vendor": {"x": [None, False, {"unicode": "龙"}]}},
        "futureNativeField": {"raw": [1, None, False]},
    }
    before = copy.deepcopy(native)
    created = call(registry, "upsert_lorebook_entry", {"book_id": book["id"], "entry": native})
    assert created["ok"] is True and type(created["uid"]) is int
    uid = created["uid"]
    assert native == before
    for field, value in native.items():
        assert created["entry"][field] == value
    assert created["entry"]["uid"] == uid

    # Native updates via lorebook_update_entry also preserve unknown futureNativeField!
    changed = call(registry, "lorebook_update_entry", {
        "book_id": book["id"], "uid": uid, "content": "revised dragon", "extensions": {"vendor": {"added": 1}},
    })
    assert changed["ok"] is True and changed["uid"] == uid
    assert changed["entry"]["position"] == 4 and changed["entry"]["futureNativeField"] == native["futureNativeField"]
    assert changed["entry"]["extensions"]["vendor"]["x"] == native["extensions"]["vendor"]["x"]
    assert changed["entry"]["extensions"]["vendor"]["added"] == 1
    assert len(store.list_entries(book["id"])) == 1

    call(registry, "upsert_lorebook_entry", {
        "book_id": other["id"], "entry": {"uid": uid, "key": ["Dragon"], "content": "other", "disable": True},
    })
    found = call(registry, "search_lorebook_entries", {"query": "DRAGON"})
    assert found["count"] == 2
    only = call(registry, "search_lorebook_entries", {"query": "dragon", "book_id": book["id"], "limit": 1})
    assert only["count"] == 1 and only["results"][0]["entry"] == changed["entry"]
    extension = call(registry, "search_lorebook_entries", {"query": "futureNativeField"})
    assert extension["count"] == 1
    reopened = LorebookStore(Path(store.db_path).parent)
    assert reopened.export_book(book["id"]) == store.export_book(book["id"])
    deleted = call(registry, "lorebook_delete_entry", {"book_id": book["id"], "uid": uid})
    assert deleted["ok"] is True and deleted["uid"] == uid
    assert call(registry, "search_lorebook_entries", {"query": "dragon", "book_id": book["id"]})["count"] == 0


@pytest.mark.parametrize("patch", [{"key": "not array"}, {"probability": 101}, {"depth": -1}, {"disable": "false"}])
def test_real_store_validation_error_is_not_internal_error(store, patch):
    book_id = store.create_book("Validation")["id"]
    registry = ToolRegistry(unified(store))
    result = call(registry, "upsert_lorebook_entry", {"book_id": book_id, "entry": patch})
    assert result["ok"] is False and result["error"] == "bad_arguments"
    assert store.list_entries(book_id) == []


@pytest.mark.parametrize("invalid_patch", [
    {"probability": 101},
    {"probability": -1},
    {"scanDepth": -1},
    {"selectiveLogic": 9},
    {"disable": "not_bool"},
    {"order": "not_int"},
    {"extensions": "not_dict"},
])
def test_add_and_update_store_validation_errors_return_bad_arguments(store, invalid_patch):
    book_id = store.create_book("ValidationAddUpdate")["id"]
    registry = ToolRegistry(unified(store))
    add_res = call(registry, "lorebook_add_entry", {
        "book": book_id, "content": "valid content", "key": ["valid"], **invalid_patch,
    })
    assert add_res["ok"] is False and add_res["error"] == "bad_arguments"
    assert store.list_entries(book_id) == []

    created = call(registry, "lorebook_add_entry", {
        "book": book_id, "content": "valid content", "key": ["valid"],
    })
    assert created["ok"] is True
    uid = created["uid"]
    upd_res = call(registry, "lorebook_update_entry", {
        "book": book_id, "uid": uid, **invalid_patch,
    })
    assert upd_res["ok"] is False and upd_res["error"] == "bad_arguments"
    assert store.list_entries(book_id)[0]["raw"] == created["entry"]


def test_add_entry_reports_duplicate_of_without_blocking_write(store):
    book1 = store.create_book("群黑话词典")
    book2 = store.create_book("子词典")
    registry = ToolRegistry(unified(store))

    first = call(registry, "lorebook_add_entry", {
        "book": book1["id"],
        "key": ["鼠蛋", "小鼠幼崽"],
        "content": "指1-3岁的鼠族幼崽。",
        "comment": "鼠蛋词条",
        "group": "slang",
    })
    assert first["ok"] is True
    assert "duplicate_of" not in first

    # Same-book and cross-book case-insensitive key overlap returns duplicate_of without blocking write.
    second = call(registry, "lorebook_add_entry", {
        "book": book2["id"],
        "key": ["  鼠蛋  ", "全新别名"],
        "content": "补充解释。",
        "group": "slang",
    })
    assert second["ok"] is True
    assert second["uid"] == 0
    assert "duplicate_of" in second
    assert len(second["duplicate_of"]) == 1
    dup = second["duplicate_of"][0]
    assert dup["book_id"] == book1["id"]
    assert dup["book_name"] == "群黑话词典"
    assert dup["uid"] == first["uid"]
    assert dup["matched_keys"] == ["鼠蛋"]
    assert len(store.list_entries(book2["id"])) == 1

