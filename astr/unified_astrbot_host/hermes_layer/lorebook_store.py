"""Synchronous SQLite lorebook store, suitable for asyncio.to_thread.

LorebookStore(data_root) always uses data_root/lorebooks.db; no seed/network IO.
Books: {id, name, enabled, raw, entry_count}. raw is top-level native ST metadata
without entries; local display name/enabled do not change imported JSON.
Entries: {book_id, world, uid, raw}; world is local book name. raw is lossless JSON
without engine defaults. Export preserves original entry map keys and ordering,
including missing uid/flags. All outputs are detached, all inputs left untouched.

API:
 list_books(), get_book(book_id), create_book(name, payload=None, enabled=True)
 update_book(book_id, patch=None, *, name=None, enabled=None), delete_book(book_id)
 import_book(payload, name=None, enabled=True), export_book(book_id)
 list_entries(book_id), upsert_entry(book_id, entry, uid=None), delete_entry(book_id, uid)
 set_entries_enabled(book_id, uids, enabled) -> count (uids=None means all)
 get_active_entries() -> entry records from enabled books, excluding disable=true
 get_settings(), update_settings(patch) -> effective global configuration
 record_message(session_id, role, content, message_id=None, metadata=None) -> bool
 record_inbound(session_id, content, message_id=None, metadata=None) -> bool
 record_assistant(session_id, content, message_id=None, metadata=None) -> bool
 history(session_id) -> oldest-first records, at most 1000 per session
 message_count(session_id) -> monotonic accepted-message count
 migrate_community_memes(source, book_name='Community memes') -> report

Partial updates deep-merge objects, including unknown extensions; arrays/scalars
replace. Missing uid on upsert allocates max(uid)+1. Invalid data raises ValueError;
missing books raise KeyError (delete_book returns False if absent). Write methods
use BEGIN IMMEDIATE and foreign keys. Connections always close after each call.
History keeps 1000 bodies, with a permanent session-scoped ID-only dedup ledger
so pruning/restarts never count replay twice. None ID disables dedup; empty IDs
are invalid. Migration ledger persists after target deletion and reads mode=ro.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import sqlite3
import time
from typing import Any, Iterator

DEFAULT_SETTINGS = dict(enabled=True, scanDepth=2, recursive=True, maxRecursionSteps=8,
                        budgetTokens=2048, caseSensitive=False, matchWholeWords=False,
                        useGroupScoring=False, authorNote='', authorNoteDepth=4, authorNoteRole=0)
_MAX_INT = 2**63 - 1


def _json(value: Any) -> str:
    def check(item: Any) -> None:
        if item is None or type(item) in (str, bool, int):
            return
        if type(item) is float and math.isfinite(item):
            return
        if type(item) is list:
            for child in item:
                check(child)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values():
                check(child)
            return
        raise ValueError('payload requires finite JSON values and string object keys')
    try:
        check(value)
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, OverflowError, RecursionError) as exc:
        raise ValueError('invalid JSON payload') from exc


def _object(value: Any, label: str) -> dict:
    if type(value) is not dict:
        raise ValueError(f'{label} must be an object')
    return json.loads(_json(value))


def _integer(value: Any, label: str, minimum: int = 0, maximum: int = _MAX_INT) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{label} must be an integer in [{minimum}, {maximum}]')
    return value


def _boolean(value: Any, label: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f'{label} must be boolean')
    return value


def _text(value: Any, label: str, nonempty: bool = False) -> str:
    if type(value) is not str or (nonempty and not value.strip()):
        raise ValueError(f'{label} must be text' + (' (nonempty)' if nonempty else ''))
    return value


def _merge(original: dict, patch: dict) -> dict:
    result = dict(original)
    for key, value in patch.items():
        result[key] = (_merge(result[key], value)
                       if type(value) is dict and type(result.get(key)) is dict else value)
    return result


def _validate_entry(entry: dict) -> None:
    if 'uid' in entry:
        _integer(entry['uid'], 'uid')
    for key in ('key', 'keysecondary', 'triggers'):
        if key in entry and (type(entry[key]) is not list or any(type(x) is not str for x in entry[key])):
            raise ValueError(f'{key} must be an array of strings')
    for key in ('content', 'comment', 'group', 'outletName', 'automationId'):
        if key in entry:
            _text(entry[key], key)
    for key in ('disable', 'constant', 'selective', 'useProbability', 'excludeRecursion',
                'preventRecursion', 'groupOverride', 'vectorized', 'addMemo', 'ignoreBudget',
                'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
                'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes'):
        if key in entry:
            _boolean(entry[key], key)
    for key in ('caseSensitive', 'matchWholeWords', 'useGroupScoring'):
        if key in entry and entry[key] is not None:
            _boolean(entry[key], key)
    for key in ('depth', 'sticky', 'cooldown', 'delay', 'scanDepth'):
        if key in entry and entry[key] is not None:
            _integer(entry[key], key)
    if 'delayUntilRecursion' in entry and type(entry['delayUntilRecursion']) is not bool:
        _integer(entry['delayUntilRecursion'], 'delayUntilRecursion')
    if 'order' in entry:
        _integer(entry['order'], 'order', -_MAX_INT)
    for key, maximum in (('selectiveLogic', 3), ('role', 2), ('position', 7)):
        # Native Eldoria.json explicitly stores role:null outside depth entries.
        if key in entry and not (key == 'role' and entry[key] is None):
            _integer(entry[key], key, maximum=maximum)
    for key, maximum in (('probability', 100), ('groupWeight', _MAX_INT)):
        if key in entry and (type(entry[key]) not in (int, float) or not 0 <= entry[key] <= maximum):
            raise ValueError(f'{key} must be a number in [0, {maximum}]')
    if 'extensions' in entry and type(entry['extensions']) is not dict:
        raise ValueError('extensions must be an object')


class LorebookStore:
    def __init__(self, data_root: str | os.PathLike[str]) -> None:
        root = Path(data_root).resolve()
        root.mkdir(parents=True, exist_ok=True)
        self.db_path = str(root / 'lorebooks.db')
        self._init_db()

    @contextmanager
    def _connection(self, write: bool = False) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA foreign_keys=ON')
            conn.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self) -> None:
        statements = [
            '''CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), raw TEXT NOT NULL)''',
            '''CREATE TABLE IF NOT EXISTS entries (
               book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
               uid INTEGER NOT NULL CHECK(uid>=0), entry_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
               raw TEXT NOT NULL, PRIMARY KEY(book_id,uid), UNIQUE(book_id,entry_key))''',
            '''CREATE TABLE IF NOT EXISTS settings (
               singleton INTEGER PRIMARY KEY CHECK(singleton=1), raw TEXT NOT NULL)''',
            '''CREATE TABLE IF NOT EXISTS session_state (
               session_id TEXT PRIMARY KEY, raw TEXT NOT NULL)''',
            '''CREATE TABLE IF NOT EXISTS sessions (
               session_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0)''',
            '''CREATE TABLE IF NOT EXISTS history (
               session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
               sequence INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
               message_id TEXT, metadata TEXT NOT NULL, created_at REAL NOT NULL,
               PRIMARY KEY(session_id,sequence))''',
            '''CREATE TABLE IF NOT EXISTS message_ids (
               session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
               message_id TEXT NOT NULL, PRIMARY KEY(session_id,message_id))''',
            '''CREATE TABLE IF NOT EXISTS migration_sources (
               source_path TEXT PRIMARY KEY, book_id INTEGER REFERENCES books(id) ON DELETE SET NULL)''',
            '''CREATE TABLE IF NOT EXISTS migration_ledger (
               source_path TEXT NOT NULL REFERENCES migration_sources(source_path), source_id INTEGER NOT NULL,
               book_id INTEGER REFERENCES books(id) ON DELETE SET NULL, uid INTEGER,
               PRIMARY KEY(source_path,source_id))''',
        ]
        with self._connection(True) as conn:
            for statement in statements:
                conn.execute(statement)

    @staticmethod
    def _book(conn: sqlite3.Connection, book_id: int) -> sqlite3.Row:
        _integer(book_id, 'book_id', 1)
        row = conn.execute('SELECT * FROM books WHERE id=?', (book_id,)).fetchone()
        if row is None:
            raise KeyError(f'book {book_id} does not exist')
        return row

    @staticmethod
    def _book_record(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
        count = conn.execute('SELECT COUNT(*) FROM entries WHERE book_id=?', (row['id'],)).fetchone()[0]
        return dict(id=row['id'], name=row['name'], enabled=bool(row['enabled']),
                    raw=json.loads(row['raw']), entry_count=count)

    @staticmethod
    def _entry_record(row: sqlite3.Row, world: str) -> dict:
        return dict(book_id=row['book_id'], world=world, uid=row['uid'], raw=json.loads(row['raw']))

    def list_books(self) -> list[dict]:
        with self._connection() as conn:
            return [self._book_record(conn, row) for row in conn.execute('SELECT * FROM books ORDER BY id')]

    def get_book(self, book_id: int) -> dict:
        with self._connection() as conn:
            return self._book_record(conn, self._book(conn, book_id))

    def create_book(self, name: str, payload: dict | None = None, enabled: bool = True) -> dict:
        return self.import_book({'entries': {}} if payload is None else payload, name, enabled)

    def import_book(self, payload: dict, name: str | None = None, enabled: bool = True) -> dict:
        raw = _object(payload, 'book')
        entries = raw.pop('entries', None)
        if type(entries) is not dict:
            raise ValueError('book.entries must be a native ST object keyed by integer uid')
        name = name if name is not None else raw.get('name', 'Untitled')
        _text(name, 'name', True)
        _boolean(enabled, 'enabled')
        prepared, seen = [], set()
        for entry_key, entry in entries.items():
            if not entry_key.isascii() or not entry_key.isdecimal():
                raise ValueError('entry map keys must be nonnegative integer strings')
            try:
                uid = _integer(int(entry_key), 'uid')
            except ValueError as exc:
                raise ValueError('entry map uid is out of range') from exc
            entry = _object(entry, 'entry')
            _validate_entry(entry)
            if uid in seen or ('uid' in entry and entry['uid'] != uid):
                raise ValueError('duplicate uid or entry uid does not match map key')
            seen.add(uid)
            prepared.append((uid, entry_key, len(prepared), _json(entry)))
        with self._connection(True) as conn:
            book_id = conn.execute('INSERT INTO books(name,enabled,raw) VALUES (?,?,?)',
                                   (name, int(enabled), _json(raw))).lastrowid
            conn.executemany('INSERT INTO entries(book_id,uid,entry_key,ordinal,raw) VALUES (?,?,?,?,?)',
                             [(book_id, *entry) for entry in prepared])
            return self._book_record(conn, self._book(conn, book_id))

    def export_book(self, book_id: int) -> dict:
        with self._connection() as conn:
            raw = json.loads(self._book(conn, book_id)['raw'])
            raw['entries'] = {row['entry_key']: json.loads(row['raw']) for row in conn.execute(
                'SELECT * FROM entries WHERE book_id=? ORDER BY ordinal,uid', (book_id,))}
            return raw

    def update_book(self, book_id: int, patch: dict | None = None, *,
                    name: str | None = None, enabled: bool | None = None) -> dict:
        patch = {} if patch is None else _object(patch, 'book patch')
        if 'entries' in patch:
            raise ValueError('use entry methods to update entries')
        if name is not None:
            _text(name, 'name', True)
        if enabled is not None:
            _boolean(enabled, 'enabled')
        with self._connection(True) as conn:
            row = self._book(conn, book_id)
            conn.execute('UPDATE books SET name=?,enabled=?,raw=? WHERE id=?',
                         (row['name'] if name is None else name,
                          row['enabled'] if enabled is None else int(enabled),
                          _json(_merge(json.loads(row['raw']), patch)), book_id))
            return self._book_record(conn, self._book(conn, book_id))

    def delete_book(self, book_id: int) -> bool:
        _integer(book_id, 'book_id', 1)
        with self._connection(True) as conn:
            return conn.execute('DELETE FROM books WHERE id=?', (book_id,)).rowcount > 0

    def list_entries(self, book_id: int) -> list[dict]:
        with self._connection() as conn:
            book = self._book(conn, book_id)
            return [self._entry_record(row, book['name']) for row in conn.execute(
                'SELECT * FROM entries WHERE book_id=? ORDER BY ordinal,uid', (book_id,))]

    def upsert_entry(self, book_id: int, entry: dict, uid: int | None = None) -> dict:
        patch = _object(entry, 'entry')
        _validate_entry(patch)
        if uid is not None:
            _integer(uid, 'uid')
            if 'uid' in patch and patch['uid'] != uid:
                raise ValueError('entry uid does not match requested uid')
        else:
            uid = patch.get('uid')
        with self._connection(True) as conn:
            book = self._book(conn, book_id)
            if uid is None:
                uid = conn.execute('SELECT COALESCE(MAX(uid),-1)+1 FROM entries WHERE book_id=?',
                                   (book_id,)).fetchone()[0]
                _integer(uid, 'uid')
                patch['uid'] = uid
            row = conn.execute('SELECT * FROM entries WHERE book_id=? AND uid=?', (book_id, uid)).fetchone()
            raw = _merge(json.loads(row['raw']), patch) if row else patch
            _validate_entry(raw)
            if row:
                conn.execute('UPDATE entries SET raw=? WHERE book_id=? AND uid=?', (_json(raw), book_id, uid))
            else:
                ordinal = conn.execute('SELECT COALESCE(MAX(ordinal),-1)+1 FROM entries WHERE book_id=?',
                                       (book_id,)).fetchone()[0]
                conn.execute('INSERT INTO entries(book_id,uid,entry_key,ordinal,raw) VALUES (?,?,?,?,?)',
                             (book_id, uid, str(uid), ordinal, _json(raw)))
            return dict(book_id=book_id, world=book['name'], uid=uid, raw=raw)

    def delete_entry(self, book_id: int, uid: int) -> bool:
        _integer(uid, 'uid')
        with self._connection(True) as conn:
            self._book(conn, book_id)
            return conn.execute('DELETE FROM entries WHERE book_id=? AND uid=?', (book_id, uid)).rowcount > 0

    def set_entries_enabled(self, book_id: int, uids: list[int] | None, enabled: bool) -> int:
        _boolean(enabled, 'enabled')
        selected = None
        if uids is not None:
            if type(uids) is not list:
                raise ValueError('uids must be an array or None')
            selected = {_integer(uid, 'uid') for uid in uids}
        with self._connection(True) as conn:
            self._book(conn, book_id)
            updates = []
            for row in conn.execute('SELECT uid,raw FROM entries WHERE book_id=?', (book_id,)):
                if selected is None or row['uid'] in selected:
                    raw = json.loads(row['raw'])
                    raw['disable'] = not enabled
                    updates.append((_json(raw), book_id, row['uid']))
            conn.executemany('UPDATE entries SET raw=? WHERE book_id=? AND uid=?', updates)
            return len(updates)

    def get_active_entries(self) -> list[dict]:
        with self._connection() as conn:
            rows = conn.execute('''SELECT e.*,b.name AS world FROM entries e JOIN books b ON b.id=e.book_id
                                   WHERE b.enabled=1 ORDER BY b.id,e.ordinal,e.uid''')
            records = [self._entry_record(row, row['world']) for row in rows]
            return [record for record in records if not record['raw'].get('disable', False)]

    def get_settings(self) -> dict:
        with self._connection() as conn:
            row = conn.execute('SELECT raw FROM settings WHERE singleton=1').fetchone()
            return _merge(DEFAULT_SETTINGS, json.loads(row[0]) if row else {})

    def update_settings(self, patch: dict) -> dict:
        patch = _object(patch, 'settings')
        for key, default in DEFAULT_SETTINGS.items():
            if key in patch:
                if type(default) is bool:
                    _boolean(patch[key], key)
                elif type(default) is str:
                    _text(patch[key], key)
                else:
                    _integer(patch[key], key)
        if 'authorNoteRole' in patch:
            _integer(patch['authorNoteRole'], 'authorNoteRole', maximum=2)
        with self._connection(True) as conn:
            row = conn.execute('SELECT raw FROM settings WHERE singleton=1').fetchone()
            raw = _merge(json.loads(row[0]) if row else {}, patch)
            conn.execute('INSERT OR REPLACE INTO settings(singleton,raw) VALUES (1,?)', (_json(raw),))
            return _merge(DEFAULT_SETTINGS, raw)

    def record_message(self, session_id: str, role: str, content: str,
                       message_id: str | None = None, metadata: dict | None = None) -> bool:
        _text(session_id, 'session_id', True)
        if role not in ('user', 'assistant'):
            raise ValueError('role must be user or assistant')
        _text(content, 'content')
        if message_id is not None:
            _text(message_id, 'message_id', True)
        metadata = {} if metadata is None else _object(metadata, 'metadata')
        with self._connection(True) as conn:
            conn.execute('INSERT OR IGNORE INTO sessions(session_id) VALUES (?)', (session_id,))
            if message_id is not None:
                inserted = conn.execute('INSERT OR IGNORE INTO message_ids(session_id,message_id) VALUES (?,?)',
                                        (session_id, message_id)).rowcount
                if not inserted:
                    return False
            conn.execute('UPDATE sessions SET message_count=message_count+1 WHERE session_id=?', (session_id,))
            sequence = conn.execute('SELECT message_count FROM sessions WHERE session_id=?', (session_id,)).fetchone()[0]
            conn.execute('''INSERT INTO history(session_id,sequence,role,content,message_id,metadata,created_at)
                            VALUES (?,?,?,?,?,?,?)''',
                         (session_id, sequence, role, content, message_id, _json(metadata), time.time()))
            conn.execute('DELETE FROM history WHERE session_id=? AND sequence<=?', (session_id, sequence - 1000))
            return True

    def record_inbound(self, session_id: str, content: str, message_id: str | None = None,
                       metadata: dict | None = None) -> bool:
        return self.record_message(session_id, 'user', content, message_id, metadata)

    def record_assistant(self, session_id: str, content: str, message_id: str | None = None,
                         metadata: dict | None = None) -> bool:
        return self.record_message(session_id, 'assistant', content, message_id, metadata)

    def history(self, session_id: str) -> list[dict]:
        _text(session_id, 'session_id', True)
        with self._connection() as conn:
            records = [dict(row) for row in conn.execute(
                'SELECT * FROM history WHERE session_id=? ORDER BY sequence', (session_id,))]
            for record in records:
                record['metadata'] = json.loads(record['metadata'])
            return records

    def message_count(self, session_id: str) -> int:
        _text(session_id, 'session_id', True)
        with self._connection() as conn:
            row = conn.execute('SELECT message_count FROM sessions WHERE session_id=?', (session_id,)).fetchone()
            return row[0] if row else 0

    def get_session_state(self, session_id: str) -> dict:
        """Selection/effects cache, separate from immutable conversational history."""
        _text(session_id, 'session_id', True)
        with self._connection() as conn:
            row = conn.execute('SELECT raw FROM session_state WHERE session_id=?', (session_id,)).fetchone()
            return json.loads(row[0]) if row else {}

    def save_session_state(self, session_id: str, state: dict) -> None:
        _text(session_id, 'session_id', True)
        raw = _object(state, 'session state')
        with self._connection(True) as conn:
            conn.execute('INSERT OR REPLACE INTO session_state(session_id,raw) VALUES (?,?)',
                         (session_id, _json(raw)))

    def migrate_community_memes(self, source: str | os.PathLike[str], book_name: str = 'Community memes') -> dict:
        """Read mode=ro; convert unseen path+ID atomically without changing old entries.

        extensions.bridgeLegacy retains original non-vector SQLite values, including
        raw JSON column text. Binary non-vector columns use {'$bytes_hex': '...'}.
        The content format is meaning + optional 'Origin: ' and 'Examples:' sections.
        """
        _text(book_name, 'book_name', True)
        source_path = Path(source).resolve(strict=True)
        if source_path == Path(self.db_path).resolve():
            raise ValueError('source cannot be the target lorebooks database')
        source_key = os.path.normcase(str(source_path))
        legacy = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True, timeout=30.0)
        legacy.row_factory = sqlite3.Row
        try:
            legacy.execute('PRAGMA query_only=ON')
            rows = legacy.execute('SELECT * FROM community_memes ORDER BY id').fetchall()
        finally:
            legacy.close()
        prepared = []
        for row in rows:
            item = dict(row)
            source_id = _integer(item.get('id'), 'legacy id')
            term = _text(item.get('term'), 'legacy term', True)
            def array(key: str) -> list[str]:
                value = item.get(key)
                if value is None or value == '':
                    return []
                try:
                    value = json.loads(value) if isinstance(value, str) else value
                except (ValueError, TypeError) as exc:
                    raise ValueError(f'legacy {key} must contain a JSON array') from exc
                if type(value) is not list or any(type(part) is not str for part in value):
                    raise ValueError(f'legacy {key} must contain an array of strings')
                return value
            aliases, examples, tags = array('aliases'), array('examples'), array('tags')
            meaning = _text(item.get('meaning', ''), 'legacy meaning')
            origin = _text(item.get('origin') or '', 'legacy origin')
            parts = [meaning] if meaning else []
            if origin:
                parts.append('Origin: ' + origin)
            if examples:
                parts.append('Examples:\n' + '\n'.join(examples))
            category = item.get('category')
            group = category if category is not None else (tags[0] if tags else '')
            _text(group, 'legacy category')
            nonvector = {}
            for key, value in item.items():
                # Only vector payload columns are omitted; metadata such as
                # embedding_model/vector_notes is still non-vector legacy data.
                if key.lower() in {'embedding', 'embeddings', 'vector', 'vectors'}:
                    continue
                nonvector[key] = {'$bytes_hex': bytes(value).hex()} if isinstance(value, bytes) else value
            entry = dict(key=[term, *aliases], content='\n\n'.join(parts), group=group,
                         extensions={'bridgeLegacy': nonvector})
            _validate_entry(entry)
            prepared.append((source_id, entry))
        with self._connection(True) as conn:
            prior = conn.execute('SELECT book_id FROM migration_sources WHERE source_path=?', (source_key,)).fetchone()
            book_id = prior[0] if prior else None
            seen = {row[0] for row in conn.execute('SELECT source_id FROM migration_ledger WHERE source_path=?', (source_key,))}
            pending = [(source_id, entry) for source_id, entry in prepared if source_id not in seen]
            if pending and book_id is None:
                book_id = conn.execute("INSERT INTO books(name,enabled,raw) VALUES (?,1,'{}')", (book_name,)).lastrowid
            conn.execute('INSERT OR IGNORE INTO migration_sources(source_path,book_id) VALUES (?,?)', (source_key, book_id))
            if book_id is not None:
                conn.execute('UPDATE migration_sources SET book_id=? WHERE source_path=?', (book_id, source_key))
            next_uid, ordinal = conn.execute('''SELECT COALESCE(MAX(uid),-1)+1,COALESCE(MAX(ordinal),-1)+1
                                               FROM entries WHERE book_id=?''', (book_id,)).fetchone()
            for source_id, entry in pending:
                _integer(next_uid, 'uid')
                entry['uid'] = next_uid
                conn.execute('INSERT INTO entries(book_id,uid,entry_key,ordinal,raw) VALUES (?,?,?,?,?)',
                             (book_id, next_uid, str(next_uid), ordinal, _json(entry)))
                conn.execute('INSERT INTO migration_ledger(source_path,source_id,book_id,uid) VALUES (?,?,?,?)',
                             (source_key, source_id, book_id, next_uid))
                next_uid += 1
                ordinal += 1
            return dict(source=str(source_path), target=self.db_path, book_id=book_id,
                        imported=len(pending), skipped=len(prepared) - len(pending))
