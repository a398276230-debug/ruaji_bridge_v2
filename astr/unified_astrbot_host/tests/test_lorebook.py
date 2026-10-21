"""Offline integration contracts: storage -> selection -> HTTP native JSON.

All database/roundtrip artifacts are confined to roming, not the real host data.
"""
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

import pytest

HOST = Path(__file__).resolve().parents[1]
ROOT = HOST.parents[1]
sys.path.insert(0, str(HOST))
import bootstrap  # noqa: E402,F401
from hermes_layer.contracts import InboundMessage
from hermes_layer.context_builder import ContextBuilder
from hermes_layer.lorebook_store import LorebookStore
from hermes_layer.lorebook_service import LOREBOOK_MAINTENANCE_NOTICE, LorebookService, resolve_maintenance_hint
from hermes_layer.lorebook_api import routes
from runtime.config import load_config


@pytest.fixture
def store():
    with tempfile.TemporaryDirectory(prefix='lorebook-integration-', dir=ROOT / 'roming') as directory:
        yield LorebookStore(directory)


def message(text='cat', mid='1', user='123'):
    return InboundMessage(message_id=mid, user_id=user, is_private=True, content=text, text=text)


def test_real_eldoria_round_trip(store):
    source = Path('F:/SillyTavern/default/content/Eldoria.json')
    if not source.exists():
        source = Path('/mnt/f/SillyTavern/default/content/Eldoria.json')
    if not source.exists():
        pytest.skip('read-only SillyTavern fixture not installed')
    original = json.loads(source.read_text(encoding='utf-8-sig'))
    book = store.import_book(original, name='Eldoria')
    exported = store.export_book(book['id'])
    assert exported == original
    assert len(exported['entries']) > 0
    (ROOT / 'roming/lorebook-Eldoria-roundtrip.json').write_text(
        json.dumps(exported, ensure_ascii=False, indent=2), encoding='utf-8')
    # Second import is another independent book, with exactly the same native JSON.
    second = store.import_book(exported, name='Reimport')
    assert store.export_book(second['id']) == original


def test_service_records_dedup_scans_history_and_isolates_sessions(store):
    book = store.create_book('facts')
    store.upsert_entry(book['id'], {'key': ['cat'], 'content': 'feline', 'sticky': 3})
    service = LorebookService(store)
    async def scenario():
        m = message()
        await service.record_inbound(m)
        first = await service.context(m)
        assert first['blocks'][0]['content'] == 'feline'
        assert first['blocks'][0]['kind'] == 'user_context'
        assert first['blocks'][0]['metadata']['slot'] == 'lorebook'
        assert store.message_count(service.session_key(m)) == 1
        assert await service.context(m) == first  # retry does not reroll probability/effects
        await service.record_assistant(m, 'reply', 'reply-id')
        await service.record_assistant(m, 'reply', 'reply-id')
        assert store.message_count(service.session_key(m)) == 2
        second = await service.context(message('dog', '2'))
        assert second['blocks'][0]['content'] == 'feline'  # persisted sticky
        unrelated = await service.context(message('dog', '1', user='999'))
        assert unrelated['blocks'] == []
        assert [m['role'] for m in store.history(service.session_key(message()))] == ['user', 'assistant', 'user']
        assert all('<lorebook-context>' not in m['content'] for m in store.history(service.session_key(message())))
    asyncio.run(scenario())


def test_service_preserves_native_placement_without_copying_history_or_notes(store):
    native = {'entries': {'7': {'uid': 7, 'constant': True, 'content': 'fact',
                              'position': 4, 'depth': 100000, 'role': 2, 'outletName': 'unused'}}}
    book = store.import_book(native, name='placement metadata')
    store.update_settings({'authorNote': 'DO_NOT_INJECT', 'authorNoteDepth': 100000})
    service = LorebookService(store)
    async def scenario():
        m = message('new')
        store.record_inbound(service.session_key(m), 'old', 'old')
        store.record_assistant(service.session_key(m), 'old reply', 'reply')
        result = await service.context(m)
        block = result['blocks'][0]
        assert block['content'] == 'fact'
        assert block['metadata'] == {
            'slot': 'lorebook', 'lorebook': {'world': book['id'], 'uid': 7,
                'position': 4, 'order': 100, 'depth': 100000, 'role': 2, 'outletName': 'unused'},
            'renderBudgetBytes': store.get_settings()['budgetTokens']}
        assert store.export_book(book['id']) == native
        assert [m['content'] for m in store.history(service.session_key(m))] == ['old', 'old reply', 'new']
    asyncio.run(scenario())


def test_http_native_crud_selection_settings_and_errors(store):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    async def scenario():
        app = web.Application()
        app.add_routes(routes(SimpleNamespace(lorebook_store=store)))
        async with TestClient(TestServer(app)) as client:
            async def post(action, payload, status=200):
                response = await client.post('/api/v1/lorebooks/' + action, json=payload)
                data = await response.json()
                assert response.status == status, data
                assert data['ok'] is (status == 200)
                return data
            native = {'futureRoot': {'kept': [1]}, 'entries': {'9': {
                'uid': 9, 'key': ['cat'], 'content': 'native', 'extensions': {'future': True}}}}
            book = (await post('import', {'data': native, 'name': 'Native'}))['book']
            bid = book['id']
            result = await (await client.get('/api/v1/lorebooks/export', params={'bookId': bid})).json()
            assert result['data'] == native
            await post('entry', {'bookId': bid, 'entry': {'uid': 9, 'constant': True}})
            await post('selection', {'bookId': bid, 'uids': [9], 'enabled': False})
            data = await (await client.get('/api/v1/lorebooks/get', params={'bookId': bid})).json()
            assert data['entries'][0]['raw']['disable'] is True
            assert data['entries'][0]['raw']['extensions'] == {'future': True}
            await post('update', {'bookId': bid, 'enabled': False, 'name': 'Renamed'})
            assert store.get_active_entries() == []
            settings = await post('settings', {'budgetTokens': 500, 'authorNote': 'note'})
            assert settings['settings']['budgetTokens'] == 500
            assert settings['settings']['authorNote'] == 'note'
            await post('entry', {'bookId': bid, 'entry': {'key': 'wrong'}}, 400)
            missing = await post('selection', {'bookId': bid, 'uids': [9999], 'enabled': True})
            assert missing['updated'] == 0  # stale UI selection is an idempotent no-op
            await post('entry', {'bookId': 9999, 'entry': {'content': 'missing book'}}, 404)
            await post('settings', {'scanDepth': -1}, 400)
            bad = await client.post('/api/v1/lorebooks/create', data='{', headers={'Content-Type': 'application/json'})
            assert bad.status == 400
            await post('entry-delete', {'bookId': bid, 'uid': 9})
            await post('delete', {'bookId': bid})
            listing = await (await client.get('/api/v1/lorebooks/list')).json()
            assert listing['books'] == []
    asyncio.run(scenario())


def test_http_unavailable_store_is_503():
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    async def scenario():
        app = web.Application()
        app.add_routes(routes(SimpleNamespace()))
        async with TestClient(TestServer(app)) as client:
            response = await client.get('/api/v1/lorebooks/list')
            assert response.status == 503
            assert (await response.json())['error'] == 'lorebook_store_unavailable'
    asyncio.run(scenario())


def test_service_edit_invalidates_effects_and_same_message_selection_cache(store):
    book = store.create_book('edits')
    store.upsert_entry(book['id'], {'key': ['cat'], 'content': 'first', 'sticky': 10})
    service = LorebookService(store)
    async def scenario():
        first = await service.context(message('cat', '1'))
        assert first['blocks'][0]['content'] == 'first'
        store.upsert_entry(book['id'], {'uid': 0, 'key': ['dog'], 'content': 'edited'})
        # Even same message id must not return stale cache after a panel edit.
        assert (await service.context(message('cat', '1')))['blocks'] == []
        assert (await service.context(message('mouse', '2')))['blocks'] == []
        assert store.message_count(service.session_key(message())) == 2
    asyncio.run(scenario())


def test_service_discards_persisted_depth_view_cache_on_same_message_retry(store):
    book = store.create_book('cached')
    store.upsert_entry(book['id'], {'constant': True, 'content': 'fact', 'position': 4, 'depth': 1})
    service = LorebookService(store)
    m = message()
    old_revision = hashlib.sha256(json.dumps([store.get_settings(), store.get_active_entries()],
        sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    store.save_session_state(service.session_key(m), {
        'lastMessageId': m.message_id, 'revision': old_revision,
        'selection': {'blocks': [{'content': 'STALE', 'metadata': {'anchorHistory': ['OLD_SECRET']}}]},
        'effects': {}})
    result = asyncio.run(service.context(m))
    assert [b['content'] for b in result['blocks']] == ['fact']
    assert 'anchorHistory' not in result['blocks'][0]['metadata']
    assert 'OLD_SECRET' not in json.dumps(result)
    assert store.message_count(service.session_key(m)) == 1
    assert asyncio.run(service.context(m)) == result
    assert store.message_count(service.session_key(m)) == 1


def test_service_normal_generation_trigger_not_qq_trigger_type(store):
    book = store.create_book('triggers')
    store.upsert_entry(book['id'], {'constant': True, 'content': 'normal', 'triggers': ['normal']})
    store.upsert_entry(book['id'], {'constant': True, 'content': 'continue', 'triggers': ['continue']})
    service = LorebookService(store)
    async def scenario():
        m = message()
        m.trigger_type = 'ai_decision'
        assert [b['content'] for b in (await service.context(m))['blocks']] == ['normal']
        m = message(mid='2')
        m.raw = {'generationType': 'continue'}
        assert [b['content'] for b in (await service.context(m))['blocks']] == ['continue']
    asyncio.run(scenario())


def test_equal_private_and_group_ids_cannot_share_history_cache_or_effects(store):
    book = store.create_book('privacy')
    store.upsert_entry(book['id'], {'key': ['PRIVATE_SECRET'], 'content': 'private fact',
                                   'sticky': 10, 'position': 4, 'depth': 2})
    store.upsert_entry(book['id'], {'constant': True, 'content': 'common fact', 'position': 4, 'depth': 2})
    service = LorebookService(store)
    async def scenario():
        private = message('PRIVATE_SECRET', 'same-id', user='123456')
        group = InboundMessage(message_id='same-id', user_id='someone', group_id='123456',
                               is_private=False, content='hello', text='hello')
        assert private.session_id == group.session_id
        assert service.session_key(private) != service.session_key(group)
        first = await service.context(private)
        assert [b['content'] for b in first['blocks']] == ['private fact', 'common fact']
        await service.record_assistant(private, 'PRIVATE_REPLY', 'reply')
        result = await service.context(group)
        assert [b['content'] for b in result['blocks']] == ['common fact']
        assert 'anchorHistory' not in result['blocks'][0]['metadata']
        assert 'PRIVATE' not in json.dumps(result)
        assert store.message_count(service.session_key(group)) == 1
        assert store.message_count(service.session_key(private)) == 2
        assert store.history(service.session_key(group))[0]['content'] == 'hello'
        assert store.get_session_state(service.session_key(group))['effects']['sticky'] == {}
        assert store.get_session_state(service.session_key(private))['effects']['sticky']
        await service.record_assistant(group, 'group reply', 'reply')
        group.message_id = 'next'
        result = await service.context(group)
        assert all('anchorHistory' not in b['metadata'] for b in result['blocks'])
        assert 'PRIVATE' not in json.dumps(result)
        assert await service.context(group) == result
        assert store.message_count(service.session_key(group)) == 3
    asyncio.run(scenario())


def test_maintenance_hint_in_final_prompt_and_not_duplicated(store):
    cfg = load_config(str(HOST / 'config.example.yaml'))
    hint = resolve_maintenance_hint(cfg)
    assert hint == LOREBOOK_MAINTENANCE_NOTICE
    assert 'search_lorebook_entries' in hint
    assert 'lorebook_add_entry' in hint
    assert 'lorebook_update_entry' in hint
    assert 'lorebook_delete_entry' in hint

    book = store.create_book('群聊黑话')
    store.upsert_entry(book['id'], {'key': ['鼠蛋'], 'content': '鼠蛋：指1-3岁的鼠族幼崽。'})
    service = LorebookService(store)

    class PreInjectedAdapter:
        plugin_key = 'living_memory'
        execution_order = 10

        async def provide_context(self, _message, _history=None):
            from hermes_layer.contracts import ContextBlock
            # Even if an upstream block already contains the maintenance hint, enrich must not duplicate it.
            return [ContextBlock(source='living_memory', kind='system_prompt',
                                 content=f'<FavorabilityPlugin>rules</FavorabilityPlugin>\n\n{hint}')]

    async def scenario():
        unified = SimpleNamespace(
            config=cfg,
            mounts={},
            adapters=[],
            lorebook_store=store,
            lorebook_service=service,
        )
        builder = ContextBuilder(unified)
        msg = InboundMessage(message_id='m-maint-1', user_id='3054039169', group_id='1076958977',
                             is_private=False, content='鼠蛋是什么意思', text='鼠蛋是什么意思')
        enriched = await builder.enrich(msg)
        assert enriched['systemPrompt'].endswith(hint)
        assert enriched['systemPrompt'].count(hint) == 1
        assert enriched['systemPrompt'].count('[世界书维护:') == 1
        user_blocks_text = '\n'.join(b['content'] for b in enriched['blocks'])
        assert '[世界书维护:' not in user_blocks_text

        # When upstream already carries the hint, it still appears only once.
        unified.mounts = {'living_memory': SimpleNamespace()}
        unified.adapters = [PreInjectedAdapter()]
        enriched_dedup = await builder.enrich(InboundMessage(
            message_id='m-maint-2', user_id='3054039169', group_id='1076958977',
            is_private=False, content='鼠蛋', text='鼠蛋',
        ))
        assert enriched_dedup['systemPrompt'].count(hint) == 1
        assert enriched_dedup['systemPrompt'].count('[世界书维护:') == 1

        # Toggle off via config.lorebook.maintenanceHint = False
        disabled_cfg = {**cfg, 'lorebook': {'maintenanceHint': False}}
        unified_off = SimpleNamespace(
            config=disabled_cfg,
            mounts={},
            adapters=[],
            lorebook_store=store,
            lorebook_service=service,
        )
        enriched_off = await ContextBuilder(unified_off).enrich(InboundMessage(
            message_id='m-maint-3', user_id='3054039169', group_id='1076958977',
            is_private=False, content='鼠蛋', text='鼠蛋',
        ))
        assert '[世界书维护:' not in enriched_off['systemPrompt']
        assert enriched_off['lorebookMaintenanceHint'] == ''

    asyncio.run(scenario())


def test_service_key_regex_and_diagnostics_roundtrip(store):
    book = store.create_book('regex-book')
    store.upsert_entry(book['id'], {
        'key': ['[broken_regex', r'我已经\s*\d+\s*秒没听到.+的故事了'],
        'keyRegex': True,
        'content': '定型文设定注入',
    })
    service = LorebookService(store)

    async def scenario():
        res = await service.context(message('我已经 30 秒没听到 abc 的故事了', 'm-regex-1'))
        assert [b['content'] for b in res['blocks']] == ['定型文设定注入']
        assert len(res['diagnostics']['regex']) == 1
        assert res['diagnostics']['regex'][0]['reason'] == 'invalid-regex'
        assert res['diagnostics']['regex'][0]['key'] == '[broken_regex'
        assert store.export_book(book['id'])['entries']['0']['keyRegex'] is True

    asyncio.run(scenario())


