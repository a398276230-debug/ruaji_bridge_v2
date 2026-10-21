"""World Info CRUD endpoints mounted by the unified host, no plugin required."""
import asyncio
import json
import sqlite3
from aiohttp import web


def routes(unified):
    async def handle(request):
        store = getattr(unified, 'lorebook_store', None)
        if store is None:
            return web.json_response({'ok': False, 'error': 'lorebook_store_unavailable'}, status=503)
        try:
            body = await request.json() if request.method == 'POST' else {}
            if not isinstance(body, dict):
                raise ValueError('body must be object')
            action = request.match_info['action']
            book_id = body.get('bookId', request.query.get('bookId'))
            if book_id is not None:
                if isinstance(book_id, bool) or not str(book_id).isdecimal():
                    raise ValueError('bookId must be positive integer')
                book_id = int(book_id)
            # Native JSON crosses JavaScript as text, never as IEEE-754 numbers.
            # Keep the original object fields for older clients; text wins if both
            # are supplied so a rounded compatibility object cannot overwrite it.
            def native_value(text_key, object_key):
                if text_key not in body:
                    return body[object_key]
                if not isinstance(body[text_key], str):
                    raise ValueError(f'{text_key} must be a JSON string')
                return json.loads(body[text_key])

            def entry_wire(entry):
                return {**entry, 'entryText': json.dumps(entry['raw'], ensure_ascii=False, allow_nan=False)}

            def execute():
                if action == 'list':
                    return {'books': store.list_books()}
                if action == 'get':
                    return {'book': store.get_book(book_id),
                            'entries': [entry_wire(entry) for entry in store.list_entries(book_id)]}
                if action == 'create':
                    return {'book': store.create_book(body['name'], enabled=body.get('enabled', True))}
                if action == 'update':
                    return {'book': store.update_book(book_id, name=body.get('name'), enabled=body.get('enabled'))}
                if action == 'delete':
                    return {'deleted': store.delete_book(book_id)}
                if action == 'entry':
                    return {'entry': entry_wire(store.upsert_entry(book_id, native_value('entryText', 'entry')))}
                if action == 'entry-delete':
                    return {'deleted': store.delete_entry(book_id, body['uid'])}
                if action == 'selection':
                    return {'updated': store.set_entries_enabled(book_id, body['uids'], body['enabled'])}
                if action == 'import':
                    return {'book': store.import_book(native_value('dataText', 'data'), name=body.get('name'), enabled=body.get('enabled', True))}
                if action == 'export':
                    data = store.export_book(book_id)
                    return {'data': data, 'dataText': json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2)}
                if action == 'settings':
                    return {'settings': store.update_settings(body) if request.method == 'POST' else store.get_settings()}
                raise ValueError('unknown action')
            return web.json_response({'ok': True, **await asyncio.to_thread(execute)})
        except KeyError as exc:
            return web.json_response({'ok': False, 'error': str(exc)}, status=404)
        except (ValueError, TypeError, sqlite3.IntegrityError) as exc:
            return web.json_response({'ok': False, 'error': str(exc)}, status=400)

    return [web.get('/api/v1/lorebooks/{action:list|get|export|settings}', handle),
            web.post('/api/v1/lorebooks/{action:create|update|delete|entry|entry-delete|selection|import|settings}', handle)]
