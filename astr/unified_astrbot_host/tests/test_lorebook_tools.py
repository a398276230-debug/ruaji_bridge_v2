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
from hermes_layer.lorebook_tools import build_lorebook_tools  # noqa: E402
from hermes_layer.plugin_contract import HermesTool as AdapterTool  # noqa: E402
from hermes_layer.tool_registry import HermesTool, ToolRegistry  # noqa: E402


NATIVE_NAMES = {"search_lorebook_entries", "upsert_lorebook_entry"}
LEGACY_NAMES = {"search_community_meme", "record_community_meme"}


class DummyStore:
    """Synchronous store contract, deliberately without meme or vector methods."""

    def __init__(self):
        self.books = [{"id": 1, "name": "First", "enabled": True},
                      {"id": 2, "name": "Disabled", "enabled": False}]
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

    def upsert_entry(self, book_id, entry):
        if book_id not in self.records:
            raise KeyError(book_id)
        uid = entry.get("uid")
        if uid is None:
            uid = max((record["uid"] for record in self.records[book_id]), default=-1) + 1
        entry["uid"] = uid
        for record in self.records[book_id]:
            if record["uid"] == uid:
                record["raw"].update(entry)
                return copy.deepcopy(record)
        record = {"uid": uid, "raw": entry}
        self.records[book_id].append(record)
        return copy.deepcopy(record)


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
    assert len(registry.names) == 5
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
    assert set(search["properties"]) == {"query", "limit", "book_id"}
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


def test_search_casefold_filter_limit_and_native_results():
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
    result = call(registry, "search_lorebook_entries", {"query": "unmatched"})
    assert result["ok"] is True and result["count"] == 0 and result["found"] is False
    assert call(registry, "search_lorebook_entries", {"query": "cat", "book_id": 999})["error"] == "lorebook_not_found"


@pytest.mark.parametrize("name,arguments,error", [
    ("search_lorebook_entries", {"query": " "}, "empty_query"),
    ("search_lorebook_entries", {"query": 1}, "bad_arguments"),
    ("search_lorebook_entries", {}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "limit": 0}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "limit": 101}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "limit": True}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book_id": False}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "book_id": "1"}, "bad_arguments"),
    ("search_lorebook_entries", {"query": "cat", "unknown": 1}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": 1, "entry": []}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": 0, "entry": {}}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": True, "entry": {}}, "bad_arguments"),
    ("upsert_lorebook_entry", {"entry": {}}, "bad_arguments"),
    ("upsert_lorebook_entry", {"book_id": 999, "entry": {}}, "lorebook_not_found"),
])
def test_invalid_arguments_are_explicit(name, arguments, error):
    result = call(ToolRegistry(unified(DummyStore())), name, arguments)
    assert result["ok"] is False and result["error"] == error


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

    # Native updates use the uid inside the entry, not a legacy term identity.
    changed = call(registry, "upsert_lorebook_entry", {
        "book_id": book["id"], "entry": {"uid": uid, "content": "revised dragon", "extensions": {"vendor": {"added": 1}}},
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
    assert store.delete_entry(book["id"], uid) is True
    assert call(registry, "search_lorebook_entries", {"query": "dragon", "book_id": book["id"]})["count"] == 0


@pytest.mark.parametrize("patch", [{"key": "not array"}, {"probability": 101}, {"depth": -1}, {"disable": "false"}])
def test_real_store_validation_error_is_not_internal_error(store, patch):
    book_id = store.create_book("Validation")["id"]
    registry = ToolRegistry(unified(store))
    result = call(registry, "upsert_lorebook_entry", {"book_id": book_id, "entry": patch})
    assert result["ok"] is False and result["error"] == "bad_arguments"
    assert store.list_entries(book_id) == []
