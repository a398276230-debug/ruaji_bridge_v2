"""Isolated lorebook persistence tests; all transient files live under repo/roming.

No fixture touches the host's configured data root or legacy production database.
Run from host: .venv/Scripts/python.exe -m pytest tests/test_lorebook_store.py -q -p no:cacheprovider
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

import pytest

from hermes_layer.lorebook_store import DEFAULT_SETTINGS, LorebookStore


REPO_ROOT = Path(__file__).resolve().parents[3]
ROMING = REPO_ROOT / "roming"
CLI = REPO_ROOT / "scripts" / "migrate-community-memes.py"


@contextmanager
def db_connection(path):
    """SQLite's own context manager commits but does not close the handle."""
    conn = sqlite3.connect(path)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


@pytest.fixture
def sandbox():
    ROMING.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="lorebook-tests-", dir=ROMING))
    try:
        yield root
    finally:
        shutil.rmtree(root)


@pytest.fixture
def store(sandbox):
    return LorebookStore(sandbox / "host-data")


def native_book():
    return {
        "name": "世界书 🌍",
        "description": "exact whitespace\n\t",
        "extensions": {"vendor": {"null": None, "empty": [], "false": False}},
        "futureTop": [1, {"opaque": "值"}],
        "entries": {
            "007": {
                "uid": 7, "key": ["龙", "Dragon"], "keysecondary": [],
                "content": "  正文\n末尾  ", "disable": False,
                "constant": False, "selective": True, "order": -3,
                "probability": 12.5, "useProbability": True,
                "delayUntilRecursion": 2, "caseSensitive": None,
                "extensions": {"x": {"a": 1, "b": [None, {"deep": "value"}]}},
                "futureEntry": {"null": None, "boolean": False},
            },
            # No uid/content/key/flags: importing must not populate defaults.
            "2": {"comment": "metadata only", "unknown": [0, False, None]},
            "20": {"uid": 20, "key": [], "content": "disabled", "disable": True},
        },
    }


def test_empty_store_and_single_database(store, sandbox):
    assert Path(store.db_path) == sandbox / "host-data" / "lorebooks.db"
    assert list((sandbox / "host-data").iterdir()) == [Path(store.db_path)]
    assert store.list_books() == []
    assert store.get_active_entries() == []
    assert store.get_settings() == DEFAULT_SETTINGS
    assert store.history("empty") == []
    assert store.message_count("empty") == 0
    assert store.delete_book(999) is False
    with pytest.raises(KeyError):
        store.get_book(999)


def test_lossless_import_export_and_detached_inputs(store):
    payload = native_book()
    original = copy.deepcopy(payload)
    book = store.import_book(payload)
    assert payload == original
    assert book["name"] == payload["name"]
    assert book["entry_count"] == 3
    assert book["enabled"] is True
    assert book["raw"] == {key: value for key, value in payload.items() if key != "entries"}
    assert store.export_book(book["id"]) == original
    assert list(store.export_book(book["id"])["entries"]) == ["007", "2", "20"]
    records = store.list_entries(book["id"])
    assert [entry["uid"] for entry in records] == [7, 2, 20]
    assert all(entry["book_id"] == book["id"] and entry["world"] == payload["name"] for entry in records)
    assert records[1]["raw"] == original["entries"]["2"]
    # Neither caller input nor return values alias persisted objects.
    payload["entries"]["007"]["extensions"]["x"]["a"] = "changed input"
    book["raw"]["extensions"]["vendor"]["false"] = True
    records[0]["raw"]["extensions"]["x"]["a"] = "changed output"
    exported = store.export_book(book["id"])
    assert exported == original
    assert LorebookStore(Path(store.db_path).parent).export_book(book["id"]) == original


def test_book_crud_keeps_local_metadata_separate(store):
    first = store.create_book("Local", native_book())
    second = store.create_book("Second", enabled=False)
    assert [book["id"] for book in store.list_books()] == [first["id"], second["id"]]
    patch = {"extensions": {"vendor": {"new": "preserved"}}, "future": 3}
    before = copy.deepcopy(patch)
    updated = store.update_book(first["id"], patch, name="Renamed", enabled=False)
    assert patch == before
    assert updated["name"] == "Renamed" and updated["enabled"] is False
    assert updated["raw"]["name"] == "世界书 🌍"
    assert updated["raw"]["extensions"]["vendor"]["null"] is None
    assert updated["raw"]["extensions"]["vendor"]["new"] == "preserved"
    assert store.get_active_entries() == []
    assert store.delete_book(first["id"]) is True
    assert store.delete_book(first["id"]) is False
    with db_connection(store.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM entries WHERE book_id=?", (first["id"],)).fetchone()[0] == 0
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_partial_entry_upsert_preserves_unknown_fields_and_absences(store):
    book_id = store.import_book(native_book())["id"]
    patch = {"content": "new", "extensions": {"x": {"a": 42}}, "key": ["new key"]}
    original_patch = copy.deepcopy(patch)
    updated = store.upsert_entry(book_id, patch, uid=7)
    assert patch == original_patch
    expected = native_book()["entries"]["007"]
    expected["content"] = "new"
    expected["key"] = ["new key"]
    expected["extensions"]["x"]["a"] = 42
    assert updated["raw"] == expected
    assert store.export_book(book_id)["entries"]["007"] == expected
    store.upsert_entry(book_id, {"content": "now has content"}, uid=2)
    assert store.export_book(book_id)["entries"]["2"] == {
        "comment": "metadata only", "unknown": [0, False, None], "content": "now has content"}
    created = store.upsert_entry(book_id, {"key": [], "content": "allocated"})
    assert created["uid"] == 21 and created["raw"]["uid"] == 21
    # Same uid in a different book is valid; no global uid uniqueness.
    another = store.create_book("Other")["id"]
    assert store.upsert_entry(another, {"uid": 7, "content": "other"})["uid"] == 7
    assert store.delete_entry(book_id, 7) is True
    assert store.delete_entry(book_id, 7) is False
    assert store.list_entries(another)[0]["raw"]["content"] == "other"


def test_active_entries_and_atomic_bulk_toggle(store):
    first = store.import_book(native_book(), name="World one")["id"]
    second = store.import_book({"entries": {"7": {"uid": 7, "content": "two"}}}, name="World two")["id"]
    active = store.get_active_entries()
    assert [(item["book_id"], item["uid"], item["world"]) for item in active] == [
        (first, 7, "World one"), (first, 2, "World one"), (second, 7, "World two")]
    assert "disable" not in active[1]["raw"]
    assert store.set_entries_enabled(first, [7, 7, 999], False) == 1
    assert [item["uid"] for item in store.get_active_entries()] == [2, 7]
    assert store.set_entries_enabled(first, None, False) == 3
    assert [item["book_id"] for item in store.get_active_entries()] == [second]
    assert store.set_entries_enabled(first, [], True) == 0
    assert store.set_entries_enabled(first, [20], True) == 1
    store.update_book(first, enabled=False)
    assert [item["book_id"] for item in store.get_active_entries()] == [second]
    store.update_book(first, enabled=True)
    assert [item["uid"] for item in store.get_active_entries()] == [20, 7]
    assert store.export_book(first)["entries"]["007"]["futureEntry"] == native_book()["entries"]["007"]["futureEntry"]


@pytest.mark.parametrize("patch", [
    {"uid": True}, {"uid": "1"}, {"uid": -1}, {"uid": 2**63},
    {"key": "word"}, {"key": [1]}, {"keysecondary": None},
    {"content": 4}, {"content": None}, {"disable": 1}, {"constant": "false"},
    {"selective": []}, {"useProbability": 1}, {"excludeRecursion": None},
    {"caseSensitive": "false"}, {"matchWholeWords": 0},
    {"order": 1.5}, {"depth": -1}, {"role": 3}, {"position": 8},
    {"selectiveLogic": -1}, {"probability": 101}, {"probability": True},
    {"groupWeight": -1}, {"delayUntilRecursion": -1}, {"extensions": []},
    {"unknown": {1: "nonstring key"}}, {"unknown": (1, 2)},
    {"unknown": float("nan")}, {"unknown": float("inf")},
])
def test_invalid_entry_patch_is_rejected_without_writes(store, patch):
    book_id = store.import_book(native_book())["id"]
    before = store.export_book(book_id)
    with pytest.raises(ValueError):
        store.upsert_entry(book_id, patch, uid=7)
    assert store.export_book(book_id) == before


@pytest.mark.parametrize("payload", [
    [], {}, {"entries": []}, {"entries": {"x": {}}},
    {"entries": {"-1": {}}}, {"entries": {"1.5": {}}}, {"entries": {"١": {}}},
    {"entries": {"1": {"uid": 2}}}, {"entries": {"1": {}, "01": {}}},
    {"entries": {"1": [], "2": {}}},
    {"entries": {"1": {"content": "valid"}, "2": {"disable": "bad"}}},
])
def test_invalid_import_is_atomic(store, payload):
    with pytest.raises(ValueError):
        store.import_book(payload)
    assert store.list_books() == []


def test_invalid_mutation_and_missing_book_errors(store):
    book_id = store.create_book("Test")["id"]
    for call in (
        lambda: store.create_book(" "),
        lambda: store.create_book("Test", enabled=1),
        lambda: store.update_book(book_id, {"entries": {}}),
        lambda: store.update_book(book_id, enabled="false"),
        lambda: store.update_book(book_id, name=""),
        lambda: store.set_entries_enabled(book_id, [1, "2"], False),
        lambda: store.set_entries_enabled(book_id, [], 1),
        lambda: store.upsert_entry(book_id, {"uid": 2}, uid=1),
        lambda: store.delete_entry(book_id, False),
    ):
        with pytest.raises(ValueError):
            call()
    for call in (
        lambda: store.list_entries(999),
        lambda: store.upsert_entry(999, {"content": "missing"}),
        lambda: store.delete_entry(999, 1),
        lambda: store.set_entries_enabled(999, None, True),
        lambda: store.export_book(999),
        lambda: store.update_book(999),
    ):
        with pytest.raises(KeyError):
            call()
    assert store.export_book(book_id) == {"entries": {}}


def test_settings_defaults_persist_and_unknowns_merge(store):
    defaults = store.get_settings()
    defaults["enabled"] = False
    assert store.get_settings()["enabled"] is True
    patch = {"enabled": False, "scanDepth": 0, "recursive": False, "maxRecursionSteps": 0,
             "budgetTokens": 123, "caseSensitive": True, "matchWholeWords": True,
             "useGroupScoring": True, "future": {"a": [None], "b": 2}}
    before = copy.deepcopy(patch)
    assert store.update_settings(patch) == {**DEFAULT_SETTINGS, **patch}
    assert patch == before
    changed = store.update_settings({"future": {"b": 3}})
    assert changed["future"] == {"a": [None], "b": 3}
    assert LorebookStore(Path(store.db_path).parent).get_settings() == changed
    assert DEFAULT_SETTINGS["enabled"] is True
    assert DEFAULT_SETTINGS["scanDepth"] == 2


@pytest.mark.parametrize("patch", [
    {"enabled": 0}, {"recursive": "true"}, {"scanDepth": True}, {"scanDepth": -1},
    {"budgetTokens": 1.5}, {"maxRecursionSteps": None}, {"caseSensitive": None},
    {"matchWholeWords": []}, {"useGroupScoring": 1},
])
def test_invalid_settings_do_not_change_store(store, patch):
    with pytest.raises(ValueError):
        store.update_settings(patch)
    assert store.get_settings() == DEFAULT_SETTINGS


def test_session_history_dedup_order_and_restart(store):
    metadata = {"sender": "alice", "unknown": {"x": [1, None]}}
    before = copy.deepcopy(metadata)
    assert store.record_inbound("group:a", "one", "m1", metadata)
    assert store.record_assistant("group:a", "reply", "m2")
    assert not store.record_inbound("group:a", "edited duplicate", "m1")
    # Same ID in same session across roles dedups; another session is independent.
    assert not store.record_assistant("group:a", "role duplicate", "m1")
    assert store.record_inbound("group:b", "other session", "m1")
    assert store.record_inbound("group:a", "no ID")
    assert store.record_inbound("group:a", "no ID")
    assert metadata == before
    history = store.history("group:a")
    assert [record["role"] for record in history] == ["user", "assistant", "user", "user"]
    assert [record["sequence"] for record in history] == [1, 2, 3, 4]
    assert [record["content"] for record in history] == ["one", "reply", "no ID", "no ID"]
    assert history[0]["metadata"] == before
    history[0]["metadata"]["sender"] = "mutated"
    metadata["unknown"]["x"].append("mutated")
    assert store.history("group:a")[0]["metadata"] == before
    reopened = LorebookStore(Path(store.db_path).parent)
    assert reopened.message_count("group:a") == 4
    assert reopened.message_count("group:b") == 1
    assert not reopened.record_inbound("group:a", "again", "m1")
    assert reopened.history("group:a") == store.history("group:a")


def test_history_bounded_but_counter_and_dedup_survive_pruning(store):
    for index in range(1007):
        assert store.record_message("bounded", "assistant" if index % 2 else "user", str(index), f"id-{index}")
    history = store.history("bounded")
    assert len(history) == 1000
    assert [record["content"] for record in history] == [str(index) for index in range(7, 1007)]
    assert history[0]["sequence"] == 8 and history[-1]["sequence"] == 1007
    assert store.message_count("bounded") == 1007
    assert not store.record_inbound("bounded", "old ID replay", "id-0")
    assert store.message_count("bounded") == 1007
    assert len(store.history("bounded")) == 1000
    assert store.record_assistant("bounded", "next", "id-next")
    assert store.history("bounded")[-1]["sequence"] == 1008


@pytest.mark.parametrize("args", [
    ("", "user", "ok", None), ("s", "system", "ok", None),
    ("s", "inbound", "ok", None), ("s", "user", None, None),
    ("s", "user", "ok", ""), ("s", "user", "ok", 1),
])
def test_invalid_history_record_is_atomic(store, args):
    with pytest.raises(ValueError):
        store.record_message(*args)
    assert store.message_count("s") == 0
    assert store.history("s") == []


def test_to_thread_style_concurrent_updates_and_message_dedup(store):
    book_id = store.create_book("Concurrent")["id"]
    def work(index):
        store.upsert_entry(book_id, {"extensions": {f"key{index}": index}}, uid=0)
        return store.record_inbound("shared", str(index), "same-message-id")
    with ThreadPoolExecutor(max_workers=8) as pool:
        accepted = list(pool.map(work, range(40)))
    assert sum(accepted) == 1
    assert store.message_count("shared") == 1
    assert len(store.history("shared")) == 1
    assert store.list_entries(book_id)[0]["raw"]["extensions"] == {f"key{index}": index for index in range(40)}
    with ThreadPoolExecutor(max_workers=8) as pool:
        entries = list(pool.map(lambda index: store.upsert_entry(book_id, {"content": str(index)}), range(20)))
    assert len({entry["uid"] for entry in entries}) == 20
    assert len(store.list_entries(book_id)) == 21


def make_legacy(path, category=False, rows=2):
    with db_connection(path) as conn:
        category_column = ", category TEXT" if category else ""
        conn.execute(f"""CREATE TABLE community_memes (
            id INTEGER PRIMARY KEY, term TEXT NOT NULL, aliases TEXT, meaning TEXT,
            origin TEXT, examples TEXT, tags TEXT, embedding BLOB,
            created_at REAL, updated_at REAL, custom_data TEXT, opaque BLOB{category_column})""")
        for index in range(1, rows + 1):
            values = [index, f"term{index}", json.dumps(["alias", "别名"]), "meaning", "origin",
                      json.dumps(["example 1", "example 2"]), json.dumps(["tag1", "tag2"]),
                      b"vector must not migrate", 10.5, 11.5, '{"unknown":true}', b"\x00\xff"]
            if category:
                values.append("explicit-category")
            conn.execute(f"INSERT INTO community_memes VALUES ({','.join('?' for _ in values)})", values)


def test_migration_maps_legacy_and_preserves_nonvector_data_readonly(store, sandbox):
    source = sandbox / "legacy # community.db"
    make_legacy(source)
    with db_connection(source) as conn:
        conn.execute("ALTER TABLE community_memes ADD COLUMN vector_notes TEXT")
        conn.execute("UPDATE community_memes SET vector_notes='metadata, not a vector'")
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    report = store.migrate_community_memes(source)
    assert report["imported"] == 2 and report["skipped"] == 0
    assert report["source"] == str(source.resolve())
    assert report["target"] == store.db_path
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    entries = store.list_entries(report["book_id"])
    raw = entries[0]["raw"]
    assert raw["key"] == ["term1", "alias", "别名"]
    assert raw["content"] == "meaning\n\nOrigin: origin\n\nExamples:\nexample 1\nexample 2"
    assert raw["group"] == "tag1"
    assert "disable" not in raw
    legacy = raw["extensions"]["bridgeLegacy"]
    assert legacy["id"] == 1 and legacy["term"] == "term1"
    assert legacy["aliases"] == json.dumps(["alias", "别名"])
    assert legacy["tags"] == json.dumps(["tag1", "tag2"])
    assert legacy["created_at"] == 10.5 and legacy["updated_at"] == 11.5
    assert legacy["custom_data"] == '{"unknown":true}'
    assert legacy["opaque"] == {"$bytes_hex": "00ff"}
    assert "embedding" not in legacy
    assert legacy["vector_notes"] == "metadata, not a vector"
    with db_connection(store.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM migration_ledger").fetchone()[0] == 2
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_migration_idempotent_no_overwrite_no_resurrection_and_incremental(store, sandbox):
    source = sandbox / "legacy.db"
    make_legacy(source, category=True)
    report = store.migrate_community_memes(source, book_name="Legacy")
    book_id = report["book_id"]
    entries = store.list_entries(book_id)
    assert entries[0]["raw"]["group"] == "explicit-category"
    store.upsert_entry(book_id, {"content": "user edited", "extensions": {"custom": 1}}, entries[0]["uid"])
    store.delete_entry(book_id, entries[1]["uid"])
    expected = store.export_book(book_id)
    # Different spelling resolves to the same source ledger key.
    rerun = store.migrate_community_memes(source.parent / "." / source.name)
    assert rerun["imported"] == 0 and rerun["skipped"] == 2
    assert rerun["book_id"] == book_id
    assert store.export_book(book_id) == expected
    with db_connection(source) as conn:
        conn.execute("INSERT INTO community_memes(id,term,aliases,meaning,tags,category) VALUES (3,'new','[]','new meaning','[]','new group')")
    new_report = store.migrate_community_memes(source)
    assert new_report["imported"] == 1 and new_report["skipped"] == 2
    assert len(store.list_entries(book_id)) == 2
    assert store.list_entries(book_id)[0]["raw"]["content"] == "user edited"
    # Ledger survives book deletion: old IDs cannot reappear on rerun.
    store.delete_book(book_id)
    after_delete = store.migrate_community_memes(source)
    assert after_delete["imported"] == 0 and after_delete["skipped"] == 3
    assert after_delete["book_id"] is None
    assert store.list_books() == []


def test_concurrent_migration_ledger_serializes(store, sandbox):
    source = sandbox / "concurrent legacy.db"
    make_legacy(source)
    with ThreadPoolExecutor(max_workers=4) as pool:
        reports = list(pool.map(lambda _: store.migrate_community_memes(source), range(4)))
    assert sum(report["imported"] for report in reports) == 2
    assert len({report["book_id"] for report in reports}) == 1
    assert len(store.list_books()) == 1
    assert store.list_books()[0]["entry_count"] == 2


def test_migration_source_path_participates_in_identity(store, sandbox):
    first = sandbox / "first.db"
    second = sandbox / "second.db"
    make_legacy(first, rows=1)
    shutil.copyfile(first, second)
    a = store.migrate_community_memes(first)
    b = store.migrate_community_memes(second)
    assert a["book_id"] != b["book_id"]
    assert a["imported"] == b["imported"] == 1
    assert len(store.list_books()) == 2


def test_migration_readonly_uri_and_missing_source(store, sandbox, monkeypatch):
    source = sandbox / "read only.db"
    make_legacy(source, rows=0)
    original_connect = sqlite3.connect
    calls = []
    def connect(database, *args, **kwargs):
        calls.append((str(database), kwargs))
        return original_connect(database, *args, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", connect)
    report = store.migrate_community_memes(source)
    assert report["imported"] == 0 and report["book_id"] is None
    assert any(database == source.resolve().as_uri() + "?mode=ro" and options.get("uri") is True
               for database, options in calls)
    missing = sandbox / "missing.db"
    with pytest.raises(FileNotFoundError):
        store.migrate_community_memes(missing)
    assert not missing.exists()
    with pytest.raises(ValueError):
        store.migrate_community_memes(store.db_path)


def test_migration_validation_failure_has_no_partial_import(store, sandbox):
    source = sandbox / "bad.db"
    make_legacy(source)
    with db_connection(source) as conn:
        conn.execute("UPDATE community_memes SET aliases='not-json' WHERE id=2")
    with pytest.raises(ValueError, match="aliases"):
        store.migrate_community_memes(source)
    assert store.list_books() == []
    with db_connection(store.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM migration_ledger").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM migration_sources").fetchone()[0] == 0


def test_migration_database_failure_rolls_back_book_entries_and_ledger(store, sandbox):
    source = sandbox / "transaction.db"
    make_legacy(source)
    with db_connection(store.db_path) as conn:
        conn.execute("""CREATE TRIGGER reject_second BEFORE INSERT ON entries
                        WHEN NEW.uid=1 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="simulated failure"):
        store.migrate_community_memes(source)
    assert store.list_books() == []
    with db_connection(store.db_path) as conn:
        for table in ("entries", "migration_sources", "migration_ledger"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
        conn.execute("DROP TRIGGER reject_second")
    assert store.migrate_community_memes(source)["imported"] == 2


def test_import_and_history_database_failure_are_atomic(store):
    with db_connection(store.db_path) as conn:
        conn.execute("""CREATE TRIGGER reject_import BEFORE INSERT ON entries
                        WHEN NEW.uid=20 BEGIN SELECT RAISE(ABORT, 'import failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="import failure"):
        store.import_book(native_book())
    assert store.list_books() == []
    with db_connection(store.db_path) as conn:
        conn.execute("""CREATE TRIGGER reject_history BEFORE INSERT ON history
                        BEGIN SELECT RAISE(ABORT, 'history failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="history failure"):
        store.record_inbound("rollback", "body", "id")
    assert store.message_count("rollback") == 0
    assert store.history("rollback") == []
    with db_connection(store.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM message_ids").fetchone()[0] == 0
        conn.execute("DROP TRIGGER reject_history")
    assert store.record_inbound("rollback", "body", "id")


def test_formal_cli_runs_only_on_isolated_sources_and_handles_errors(sandbox):
    source = sandbox / "cli source.db"
    target = sandbox / "cli host"
    make_legacy(source, rows=1)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "TEMP": str(sandbox), "TMP": str(sandbox), "TMPDIR": str(sandbox)}
    def run(*args):
        return subprocess.run([sys.executable, str(CLI), *args], cwd=sandbox,
                              capture_output=True, text=True, encoding="utf-8", env=env, timeout=30)
    help_result = run("--help")
    assert help_result.returncode == 0
    assert "--data-root" in help_result.stdout
    args = ("--source", str(source), "--data-root", str(target), "--book-name", "CLI book")
    first = run(*args)
    assert first.returncode == 0, first.stderr
    report = json.loads(first.stdout)
    assert report["ok"] is True and report["imported"] == 1
    assert LorebookStore(target).list_books()[0]["name"] == "CLI book"
    second = run(*args)
    assert second.returncode == 0, second.stderr
    assert json.loads(second.stdout)["skipped"] == 1
    assert json.loads(second.stdout)["imported"] == 0
    missing_target = sandbox / "must-not-create"
    missing = run("--source", str(sandbox / "does-not-exist.db"), "--data-root", str(missing_target))
    assert missing.returncode == 1
    assert json.loads(missing.stderr)["ok"] is False
    assert not missing_target.exists()
    same = run("--source", str(target / "lorebooks.db"), "--data-root", str(target))
    assert same.returncode == 1 and "source cannot" in same.stderr
