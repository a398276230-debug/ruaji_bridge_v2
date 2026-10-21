"""Lossless native JSON wire contracts; all temporary databases live in roming."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HOST = Path(__file__).resolve().parents[1]
ROOT = HOST.parents[1]
sys.path.insert(0, str(HOST))
from hermes_layer.lorebook_api import routes
from hermes_layer.lorebook_store import LorebookStore


def test_native_text_import_export_and_editor_preserve_large_unknown_integers():
    native = {'futureRoot': {'id': 9007199254740993, 'negative': -9007199254740993},
              'entries': {'7': {'uid': 7, 'content': 'Native',
                                'extension': {'id': 9007199254740993, 'text': '9007199254740993'}}}}

    async def scenario(store):
        app = web.Application()
        app.add_routes(routes(SimpleNamespace(lorebook_store=store)))
        async with TestClient(TestServer(app)) as client:
            async def post(action, payload, status=200):
                response = await client.post('/api/v1/lorebooks/' + action, json=payload)
                result = await response.json()
                assert response.status == status, result
                return result

            result = await post('import', {'name': 'Lossless', 'dataText': json.dumps(native),
                                           'data': {'entries': {}}})
            bid = result['book']['id']
            assert store.export_book(bid) == native, 'text takes precedence over compatibility object'
            loaded = await (await client.get('/api/v1/lorebooks/get', params={'bookId': bid})).json()
            assert json.loads(loaded['entries'][0]['entryText']) == native['entries']['7']
            patch = {'uid': 7, 'extension': {'id': 9007199254740995, 'future': [9007199254740993]}}
            edited = await post('entry', {'bookId': bid, 'entryText': json.dumps(patch),
                                          'entry': {'uid': 7, 'extension': {'id': 0}}})
            assert json.loads(edited['entry']['entryText'])['extension']['id'] == 9007199254740995
            # A friendly control sends only the changed field; unknown extensions remain untouched.
            await post('entry', {'bookId': bid, 'entry': {'uid': 7, 'comment': 'Friendly edit'}})
            exported = await (await client.get('/api/v1/lorebooks/export', params={'bookId': bid})).json()
            expected = json.loads(json.dumps(native))
            expected['entries']['7']['extension'].update(patch['extension'])
            expected['entries']['7']['comment'] = 'Friendly edit'
            assert exported['data'] == expected, 'legacy object export remains supported'
            assert json.loads(exported['dataText']) == expected
            assert '9007199254740993' in exported['dataText']
            second = await post('import', {'dataText': exported['dataText'], 'name': 'Reimport'})
            assert store.export_book(second['book']['id']) == expected
            legacy = await post('import', {'data': native, 'name': 'Legacy'})
            assert store.export_book(legacy['book']['id']) == native
            for key, invalid in [('dataText', None), ('dataText', {}), ('dataText', '{'),
                                 ('dataText', '[]'), ('entryText', 123), ('entryText', '{'),
                                 ('entryText', 'null')]:
                await post('import' if key == 'dataText' else 'entry',
                           {'bookId': bid, key: invalid}, 400)
            assert store.export_book(bid) == expected, 'invalid text cannot mutate stored values'

    with tempfile.TemporaryDirectory(prefix='lorebook-wire-', dir=ROOT / 'roming') as directory:
        asyncio.run(scenario(LorebookStore(directory)))
