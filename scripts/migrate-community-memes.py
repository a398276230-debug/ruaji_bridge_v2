#!/usr/bin/env python3
"""Explicit, idempotent community_memes -> lorebooks.db migration.

Usage:
    python scripts/migrate-community-memes.py --source /path/community_memes.db \
        --data-root /path/host-data [--book-name 'Community memes']

Reads source using SQLite mode=ro. Never modifies/deletes source records or runs
embeddings. Imported entries and path+legacy-id ledger commit atomically. Reruns
skip all migrated IDs, including user-edited/deleted target entries. Prints a JSON
report to stdout, or JSON error to stderr with exit code 1. No import-time action.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

HOST_ROOT = Path(__file__).resolve().parents[1] / 'astr' / 'unified_astrbot_host'
sys.path.insert(0, str(HOST_ROOT))
from hermes_layer.lorebook_store import LorebookStore  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, help='existing legacy SQLite database (read-only)')
    parser.add_argument('--data-root', required=True, help='host data directory; target is lorebooks.db')
    parser.add_argument('--book-name', default='Community memes', help='local migration book display name')
    args = parser.parse_args(argv)
    try:
        source = Path(args.source).resolve(strict=True)
        if not source.is_file():
            raise ValueError('source must be an existing SQLite database file')
        if source == Path(args.data_root).resolve() / 'lorebooks.db':
            raise ValueError('source cannot be the target lorebooks database')
        report = LorebookStore(args.data_root).migrate_community_memes(source, args.book_name)
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({'ok': True, **report}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
