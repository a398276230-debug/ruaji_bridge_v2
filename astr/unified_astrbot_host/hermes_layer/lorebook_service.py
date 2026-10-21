"""Session-scoped World Info selection, replacing the embedding meme radar.

Only raw conversational bodies are retained. The current selection is sent as
user-side context blocks; historical messages are never retroactively changed.
"""
import asyncio
import hashlib
import json
from .lorebook_engine import evaluate

LOREBOOK_MAINTENANCE_NOTICE = (
    "[世界书维护: 聊天中遇到不认识的梗、黑话、群内定型文或新冒出的梗时，先调用 search_lorebook_entries 查重；"
    "确认未收录且查证清楚含义后，再用 lorebook_add_entry 记入（key 填梗名与别名，content 写含义、来历与典型例句，group 归入合适分类）。"
    "已有条目过时或不准确时用 lorebook_update_entry 更新而勿重复新建，明显写错或重复的条目用 lorebook_delete_entry 删除；"
    "不确定含义时严禁凭猜测入库，切勿为了写而写，仅在确实遇到新内容时动手。]"
)


def resolve_maintenance_hint(config: dict | None = None) -> str:
    """Return the active lorebook maintenance hint for system prompt tail, or '' when disabled."""
    cfg = (config or {}).get("lorebook") if isinstance(config, dict) else None
    if not isinstance(cfg, dict):
        cfg = {}
    raw_toggle = cfg.get("maintenanceHint", cfg.get("maintenance_hint", True))
    if raw_toggle is False:
        return ""
    if isinstance(raw_toggle, str):
        custom = raw_toggle.strip()
        if custom.lower() in ("false", "0", "off", "no"):
            return ""
        if custom and custom.lower() not in ("true", "1", "on", "yes"):
            return custom
    prompt = cfg.get("maintenancePrompt", cfg.get("maintenance_prompt"))
    if isinstance(prompt, str) and prompt.strip():
        return prompt.strip()
    return LOREBOOK_MAINTENANCE_NOTICE



class LorebookService:
    def __init__(self, store):
        self.store = store
        self._lock = asyncio.Lock()

    @staticmethod
    def session_key(message):
        # AstrBot's bare session_id intentionally has no type; our persistence
        # must isolate a private QQ from a numerically identical group ID.
        kind = 'private' if message.is_private else 'group'
        return f'{kind}:{message.session_id}'

    async def record_inbound(self, message):
        async with self._lock:
            await asyncio.to_thread(self._record_inbound, message)

    def _record_inbound(self, message):
        self.store.record_inbound(self.session_key(message), message.content or message.text,
                                  'user:' + message.message_id if message.message_id else None)

    async def context(self, message, history=None):
        async with self._lock:
            return await asyncio.to_thread(self._context, message, history)

    def _context(self, message, history):
        settings = self.store.get_settings()
        session = self.store.get_session_state(self.session_key(message))
        mid = str(message.message_id or '')
        records = self.store.get_active_entries()
        # Invalidate persisted selections from the removed depth-view renderer.
        revision = hashlib.sha256(json.dumps(['user-prefix-v2', settings, records], sort_keys=True,
            ensure_ascii=False).encode('utf-8')).hexdigest()
        if mid and mid == session.get('lastMessageId') and revision == session.get('revision') and 'selection' in session:
            return session['selection']
        self._record_inbound(message)
        stored = self.store.history(self.session_key(message))
        # Bridge history includes non-dialogue records on some routes. The host's
        # immutable user/assistant log is the default scanning source.
        messages = stored
        if history and all(isinstance(m, dict) and m.get('role') in ('user', 'assistant')
                           and isinstance(m.get('content'), str) for m in history):
            messages = [*history, {'role': 'user', 'content': message.content or message.text}]
        entries = [{**record['raw'], 'uid': record['uid'], 'world': record['book_id'],
                    'hash': hashlib.sha256(json.dumps(record['raw'], sort_keys=True,
                        ensure_ascii=False).encode('utf-8')).hexdigest()} for record in records]
        # Bridge replies are normal generations (QQ at/keyword/auto are not ST
        # generation types). Future regenerate/continue callers can pass a type.
        generation = message.raw.get('generationType', 'normal')
        generation = generation if generation in ('normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet') else 'normal'
        result = evaluate(entries, messages, {**settings, 'trigger': generation}, effects=session.get('effects'),
                          message_count=self.store.message_count(self.session_key(message)))
        blocks = []
        # History is a scan source only, never copied into injection metadata.
        # Native placement fields remain available for lossless interoperability,
        # but only order controls the single current-user prefix.
        for entry in result['entries']:
            if not entry.get('content'):
                continue
            blocks.append(dict(source='lorebook', kind='user_context', content=entry['content'],
                priority=90, tokensEstimate=len(entry['content'].encode('utf-8')),
                metadata={'slot': 'lorebook', 'lorebook': {
                    k: entry.get(k) for k in ('world', 'uid', 'position', 'order', 'depth', 'role', 'outletName')
                }, 'renderBudgetBytes': settings['budgetTokens']},
                detail={'slot': 'lorebook', 'dedupeKey': f"lorebook:{entry['world']}:{entry['uid']}"}))
        selection = dict(blocks=blocks, diagnostics={k: result[k] for k in ('tokensEstimate', 'iterations')})
        selection['diagnostics']['dropped'] = [dict(world=d['entry'].get('world'),
            uid=d['entry'].get('uid'), reason=d['reason']) for d in result['dropped']]
        selection['diagnostics']['regex'] = list(result.get('diagnostics', []))
        self.store.save_session_state(self.session_key(message), dict(effects=result['effects'],
            lastMessageId=mid, revision=revision, selection=selection))
        return selection

    async def record_assistant(self, message, content, message_id=None):
        if content:
            async with self._lock:
                await asyncio.to_thread(self.store.record_assistant, self.session_key(message), content,
                                        'assistant:' + message_id if message_id else None)
