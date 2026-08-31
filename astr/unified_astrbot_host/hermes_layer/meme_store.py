"""hermes_layer.meme_store —— 社区梗/黑话/定型文数据库与语义检索引擎。

基于 SQLite 持久化存储 + GatewayClient 的 embedding 做语义检索。
当群友提到未知梗或二次元流行语时，支持语义模糊检索，并支持在互联网查证后动态写入补充。

## 两条路，各自只干一件事

    hint_for(群友原话)     每轮对话都跑。全量向量近邻，**只回梗名**，渲染成一行
                          「梗雷达」注入 slang 槽（约 40 token）。模型看见梗名
                          才知道这里有梗，不必自己想起来查。
    search_meme(梗名)      模型拿雷达给的梗名回头查详情。纯 SQLite 直查梗名/别名，
                          **一次网络请求都不发**。

两条路加起来每轮只有一次 embed 往返。没有 rerank：雷达只需要「哪几个梗名沾边」
这种粗判断，重排换来的精度不值一次额外往返——它在每条消息的关键路径上。
search_meme 也没有向量兜底：语义召回在雷达那步做完了，直查落空就是真没有，
该去 web_search 查证并 record_meme 沉淀，而不是再烧一次 embed 确认「确实没有」。
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import sqlite3
import struct
import time
from typing import Any

logger = logging.getLogger("hermes.meme_store")

# 默认内置种子梗库
DEFAULT_SEED_MEMES: list[dict[str, Any]] = [
    {
        "term": "「真拿你没办法，坐好喽」",
        "aliases": ["坐好喽", "坐好咯", "拿你没办法", "讲故事定型文", "坐好喽定型文"],
        "meaning": "二次元社区与短视频解说高能复盘定型文开场白。通常后接宠溺+中二语速飞快的小作文，声情并茂地复盘一段热血或发癫名场面。",
        "origin": "源于短视频/B站解说博主的戏剧性开场白，后在电竞圈（CS2科隆Major、Danking蛋神残局）、动漫圈（咒术回战）广泛扩散。",
        "examples": [
            "我已经 XX 秒没听到 XXX 的故事了 / 真是拿你没办法，坐好喽（😋），那是……",
            "真拿你没办法，坐好喽！五条悟老师当年在新宿……",
        ],
        "tags": ["定型文", "小作文", "名场面", "解说"],
    },
    {
        "term": "「五条悟 / 牢师 / 2.5条悟」",
        "aliases": ["五条悟", "牢师", "2.5条悟", "会赢的", "空间斩", "斩断世界", "新宿决战", "走马灯", "机场开会"],
        "meaning": "《咒术回战》现代最强咒术师五条悟对战宿傩。在235话被众人宣布获胜（半场开香槟「会赢的」）后，236话毫无过渡直接切到机场走马灯被宿傩腰斩（空间斩），成为经典生草名场面。",
        "origin": "《咒术回战》新宿决战第 235-236 话（2018年12月24日新宿决战）。",
        "examples": [
            "会赢的！",
            "也就是说……没错，是五条悟赢了！",
            "没能让宿傩大人尽兴，真是太抱歉了。",
        ],
        "tags": ["二次元", "咒术回战", "名场面", "动漫"],
    },
    {
        "term": "「鼠蛋」",
        "aliases": ["鼠蛋", "鼠族幼崽", "鼠鼠幼崽", "小鼠蛋"],
        "meaning": "指 1-3 岁的鼠族幼崽。在鼠族设定中，各族幼崽均称作 x 蛋（如鼠蛋、兔蛋、猫蛋等）。",
        "origin": "RimWorld Ratkin 鼠族 Mod 设定与群聊黑话文化。",
        "examples": [
            "这只鼠蛋怎么这么调皮？",
            "保护好我们族里可爱的小鼠蛋！",
        ],
        "tags": ["鼠族", "设定", "群聊黑话", "RimWorld"],
    },
    {
        "term": "「黛比」",
        "aliases": ["呆逼", "黛比瑞姬"],
        "meaning": "群友（如下划线）用来挑衅/调侃瑞姬的谐音外号，谐音「呆逼」。瑞姬对此会不爽、嫌弃并吐槽警告。",
        "origin": "群聊黑话与群友日常互动。",
        "examples": [
            "黛比瑞姬今天摸鱼了吗？",
        ],
        "tags": ["群聊黑话", "瑞姬梗", "外号"],
    },
    {
        "term": "「希德莉亚」",
        "aliases": ["话痨龙娘", "龙娘", "希德莉亚bot"],
        "meaning": "群里的另一个话痨龙娘机器人（QQ号 3168805831），发言极多。瑞姬对她的原则是彻底无视、不接茬。",
        "origin": "群聊机器人生态。",
        "examples": [
            "希德莉亚又在刷屏了……",
        ],
        "tags": ["群聊机器人", "群聊黑话"],
    },
]


def _pack_vector(vec: list[float]) -> bytes:
    """把 float 列表打包为紧凑二进制 bytes。"""
    return struct.pack(f"{len(vec)}f", *vec)


def _unpack_vector(blob: bytes) -> list[float]:
    """把二进制 bytes 解包为 float 列表。"""
    if not blob:
        return []
    count = len(blob) // 4
    return list(struct.unpack(f"{count}f", blob))


def _cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    """计算两组向量的余弦相似度。"""
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    dot = sum(a * b for a, b in zip(vec1, vec2))
    norm1 = math.sqrt(sum(a * a for a in vec1))
    norm2 = math.sqrt(sum(b * b for b in vec2))
    if norm1 <= 1e-9 or norm2 <= 1e-9:
        return 0.0
    return dot / (norm1 * norm2)


_QUOTE_RE = re.compile(r"[「」『』《》\"'\s]+")


def _norm(text: Any) -> str:
    """归一化梗名：剥掉「」『』等引号与空白，转小写。"""
    return _QUOTE_RE.sub("", str(text or "")).lower()


def _decode_row(item: dict[str, Any]) -> dict[str, Any]:
    """把行里 aliases/examples/tags 三个 JSON 列就地解成 list。"""
    for key in ("aliases", "examples", "tags"):
        raw = item.get(key)
        try:
            item[key] = json.loads(raw) if raw else []
        except Exception:
            item[key] = []
    return item


def _format_meme(item: dict[str, Any], score: float) -> dict[str, Any]:
    """把一行梗整理成对外返回的形状。"""
    return {
        "term": item["term"],
        "meaning": item["meaning"],
        "origin": item.get("origin", ""),
        "examples": item.get("examples", []),
        "aliases": item.get("aliases", []),
        "tags": item.get("tags", []),
        "score": round(score, 4),
    }


class CommunityMemeStore:
    """社区梗与黑话存储引擎（SQLite + 梗雷达向量召回 + 梗名/别名直查）。"""

    def __init__(self, db_path: str, gateway: Any | None = None) -> None:
        self.db_path = os.path.abspath(db_path)
        self.gateway = gateway
        self._lock = asyncio.Lock()
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        """初始化表结构并视情况灌入种子数据。"""
        with self._get_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS community_memes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    term TEXT UNIQUE NOT NULL,
                    aliases TEXT NOT NULL DEFAULT '[]',
                    meaning TEXT NOT NULL,
                    origin TEXT NOT NULL DEFAULT '',
                    examples TEXT NOT NULL DEFAULT '[]',
                    tags TEXT NOT NULL DEFAULT '[]',
                    embedding BLOB,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_community_memes_term ON community_memes(term)"
            )
            conn.commit()

            cursor = conn.execute("SELECT COUNT(*) FROM community_memes")
            count = cursor.fetchone()[0]
            if count == 0:
                logger.info("community_memes 数据库为空，准备预置初始种子梗...")
                # 初始同步写入种子数据（无向量，启动后异步补全向量）
                now = time.time()
                for item in DEFAULT_SEED_MEMES:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO community_memes 
                        (term, aliases, meaning, origin, examples, tags, embedding, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
                        """,
                        (
                            item["term"],
                            json.dumps(item.get("aliases", []), ensure_ascii=False),
                            item["meaning"],
                            item.get("origin", ""),
                            json.dumps(item.get("examples", []), ensure_ascii=False),
                            json.dumps(item.get("tags", []), ensure_ascii=False),
                            now,
                            now,
                        ),
                    )
                conn.commit()

    async def warm_up_embeddings(self) -> None:
        """在后台为尚未向量化的梗补齐 embedding。"""
        if self.gateway is None:
            return
        try:
            async with self._lock:
                loop = asyncio.get_running_loop()

                def _get_missing() -> list[dict[str, Any]]:
                    with self._get_conn() as conn:
                        rows = conn.execute(
                            "SELECT id, term, aliases, meaning, origin, examples, tags FROM community_memes WHERE embedding IS NULL"
                        ).fetchall()
                        return [dict(r) for r in rows]

                missing = await loop.run_in_executor(None, _get_missing)
                if not missing:
                    return

                logger.info("正在为 %d 条社区梗生成 Embedding 向量...", len(missing))
                texts = [self._build_embedding_text(m) for m in missing]
                vectors = await self.gateway.embed(texts)

                def _update_embeddings(items_with_vec: list[tuple[int, bytes]]) -> None:
                    with self._get_conn() as conn:
                        conn.executemany(
                            "UPDATE community_memes SET embedding = ? WHERE id = ?",
                            [(vec, doc_id) for doc_id, vec in items_with_vec],
                        )
                        conn.commit()

                packed_items = [
                    (item["id"], _pack_vector(vec))
                    for item, vec in zip(missing, vectors)
                    if vec
                ]
                if packed_items:
                    await loop.run_in_executor(None, _update_embeddings, packed_items)
                    logger.info("已成功为 %d 条梗写入 Embedding 索引", len(packed_items))
        except Exception as exc:
            logger.warning("社区梗向量预热失败: %s", exc)

    @staticmethod
    def _build_embedding_text(item: dict[str, Any]) -> str:
        """组装用于 Embedding 的综合语义文本。"""
        term = str(item.get("term") or "").strip()
        aliases = item.get("aliases") or []
        if isinstance(aliases, str):
            try:
                aliases = json.loads(aliases)
            except Exception:
                aliases = [aliases]
        aliases_str = "、".join(str(a) for a in aliases if a)

        meaning = str(item.get("meaning") or "").strip()
        origin = str(item.get("origin") or "").strip()
        examples = item.get("examples") or []
        if isinstance(examples, str):
            try:
                examples = json.loads(examples)
            except Exception:
                examples = [examples]
        examples_str = "；".join(str(e) for e in examples if e)

        parts = [f"梗名：{term}"]
        if aliases_str:
            parts.append(f"别名/变体：{aliases_str}")
        if meaning:
            parts.append(f"含义解释：{meaning}")
        if origin:
            parts.append(f"出处渊源：{origin}")
        if examples_str:
            parts.append(f"经典例句/场景：{examples_str}")
        return " | ".join(parts)

    async def record_meme(
        self,
        term: str,
        meaning: str,
        origin: str = "",
        examples: list[str] | None = None,
        aliases: list[str] | None = None,
        tags: list[str] | None = None,
        meme_id: int | None = None,
        merge: bool = True,
    ) -> dict[str, Any]:
        """记录或更新一条梗。自动生成向量并入库。

        `merge=True`（模型写入）时 aliases/examples/tags 与旧值取并集，模型每次
        只补一部分也不会把别人写的冲掉；面板编辑传 `merge=False` 整条覆盖，
        否则用户删不掉一个别名。`meme_id` 用于面板改名（term 是唯一键）。
        """
        clean_term = str(term or "").strip()
        clean_meaning = str(meaning or "").strip()
        if not clean_term:
            return {"ok": False, "error": "empty_term", "message": "梗名称不能为空"}
        if not clean_meaning:
            return {"ok": False, "error": "empty_meaning", "message": "梗含义不能为空"}

        clean_examples = [str(e).strip() for e in (examples or []) if str(e).strip()]
        clean_aliases = [str(a).strip() for a in (aliases or []) if str(a).strip()]
        clean_tags = [str(t).strip() for t in (tags or []) if str(t).strip()]

        doc_dict = {
            "term": clean_term,
            "aliases": clean_aliases,
            "meaning": clean_meaning,
            "origin": str(origin or "").strip(),
            "examples": clean_examples,
            "tags": clean_tags,
        }

        # 计算 Embedding
        embedding_bytes: bytes | None = None
        if self.gateway is not None:
            try:
                text = self._build_embedding_text(doc_dict)
                vectors = await self.gateway.embed([text])
                if vectors and vectors[0]:
                    embedding_bytes = _pack_vector(vectors[0])
            except Exception as exc:
                logger.warning("计算梗 %s 的向量失败: %s", clean_term, exc)
        # 有网关却没算出向量 = 这次失败了。gateway 为 None 是离线场景，不算失败。
        embed_failed = self.gateway is not None and embedding_bytes is None

        now = time.time()
        loop = asyncio.get_running_loop()

        def _persist() -> tuple[str, int]:
            with self._get_conn() as conn:
                # 检查是否存在：面板编辑给 id（可能在改名），模型写入只给 term
                if meme_id:
                    row = conn.execute(
                        "SELECT id, aliases, examples, tags FROM community_memes WHERE id = ?",
                        (int(meme_id),),
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT id, aliases, examples, tags FROM community_memes WHERE term = ?",
                        (clean_term,),
                    ).fetchone()

                if row:
                    doc_id = row["id"]
                    # 智能合并已有 aliases, examples, tags
                    try:
                        old_aliases = json.loads(row["aliases"]) if row["aliases"] else []
                    except Exception:
                        old_aliases = []
                    try:
                        old_examples = json.loads(row["examples"]) if row["examples"] else []
                    except Exception:
                        old_examples = []
                    try:
                        old_tags = json.loads(row["tags"]) if row["tags"] else []
                    except Exception:
                        old_tags = []

                    if merge:
                        merged_aliases = list(dict.fromkeys(old_aliases + clean_aliases))
                        merged_examples = list(dict.fromkeys(old_examples + clean_examples))
                        merged_tags = list(dict.fromkeys(old_tags + clean_tags))
                    else:
                        merged_aliases, merged_examples, merged_tags = clean_aliases, clean_examples, clean_tags

                    conn.execute(
                        """
                        UPDATE community_memes
                        SET term = ?, aliases = ?, meaning = ?, origin = ?, examples = ?, tags = ?,
                            embedding = COALESCE(?, embedding), updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            clean_term,
                            json.dumps(merged_aliases, ensure_ascii=False),
                            clean_meaning,
                            str(origin or "").strip(),
                            json.dumps(merged_examples, ensure_ascii=False),
                            json.dumps(merged_tags, ensure_ascii=False),
                            embedding_bytes,
                            now,
                            doc_id,
                        ),
                    )
                    if embed_failed:
                        # 正文已改、向量没算出来：宁可清空也不留旧向量。旧向量对应旧释义，
                        # 留着雷达就会拿过时的语义去匹配这条梗；清空后下次启动
                        # warm_up_embeddings 会补齐，面板上也会显示「未向量化」。
                        conn.execute(
                            "UPDATE community_memes SET embedding = NULL WHERE id = ?", (doc_id,)
                        )
                    conn.commit()
                    return ("updated", doc_id)
                else:
                    cursor = conn.execute(
                        """
                        INSERT INTO community_memes
                        (term, aliases, meaning, origin, examples, tags, embedding, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            clean_term,
                            json.dumps(clean_aliases, ensure_ascii=False),
                            clean_meaning,
                            str(origin or "").strip(),
                            json.dumps(clean_examples, ensure_ascii=False),
                            json.dumps(clean_tags, ensure_ascii=False),
                            embedding_bytes,
                            now,
                            now,
                        ),
                    )
                    conn.commit()
                    return ("created", cursor.lastrowid)

        async with self._lock:
            try:
                action, doc_id = await loop.run_in_executor(None, _persist)
            except sqlite3.IntegrityError:
                return {"ok": False, "error": "duplicate_term", "message": f"梗名「{clean_term}」已被占用"}

        return {
            "ok": True,
            "action": action,
            "id": doc_id,
            "term": clean_term,
            "message": f"梗「{clean_term}」已成功{'更新' if action == 'updated' else '收录'}入库",
        }

    async def _load_all(self) -> list[dict[str, Any]]:
        """全表读出并把三个 JSON 列解开。

        ponytail: 每次检索都全表扫 + 解 BLOB。几百条以内是毫秒级，真到上千条
        再加进程内向量缓存（dict + updated_at 失效）。
        """
        loop = asyncio.get_running_loop()

        def _query() -> list[dict[str, Any]]:
            with self._get_conn() as conn:
                rows = conn.execute(
                    "SELECT id, term, aliases, meaning, origin, examples, tags, embedding, updated_at FROM community_memes"
                ).fetchall()
                return [_decode_row(dict(r)) for r in rows]

        return await loop.run_in_executor(None, _query)

    async def _embed_query(self, text: str) -> list[float] | None:
        """取一条查询文本的向量。网关不通就返回 None，让调用方自己降级。"""
        if self.gateway is None:
            return None
        try:
            vectors = await self.gateway.embed([text])
        except Exception as exc:
            logger.debug("生成 query embedding 失败: %s", exc)
            return None
        return vectors[0] if vectors and vectors[0] else None

    @staticmethod
    def _name_hit(query_norm: str, item: dict[str, Any]) -> float:
        """梗名/别名直查打分：1.0 完全相同，0.9 互为子串。"""
        best = 0.0
        for name in [item.get("term"), *(item.get("aliases") or [])]:
            normalized = _norm(name)
            if not normalized:
                continue
            if normalized == query_norm:
                return 1.0
            if len(normalized) >= 2 and len(query_norm) >= 2:
                if normalized in query_norm or query_norm in normalized:
                    best = 0.9
        return best

    async def hint_for(
        self,
        text: str,
        limit: int = 2,
        min_score: float = 0.45,
    ) -> dict[str, Any]:
        """梗雷达：把整条群友发言与全库比向量，**只回梗名**。

        每轮对话都跑，所以全程只有一次 embed 往返。释义不注入 —— 注入全文是
        40 token 变 400 token，而模型知道梗名之后自己会去查。
        """
        clean = str(text or "").strip()
        if not clean or self.gateway is None:
            return {"found": False, "terms": [], "text": ""}

        query_vector, all_memes = await asyncio.gather(self._embed_query(clean), self._load_all())
        if not query_vector or not all_memes:
            return {"found": False, "terms": [], "text": ""}

        scored: list[tuple[float, str]] = []
        for item in all_memes:
            blob = item.get("embedding")
            if not blob:
                continue
            score = _cosine_similarity(query_vector, _unpack_vector(blob))
            if score >= min_score:
                scored.append((score, str(item["term"]).strip("「」")))

        scored.sort(key=lambda pair: pair[0], reverse=True)
        terms = [term for _, term in scored[: max(1, int(limit or 2))]]
        if not terms:
            return {"found": False, "terms": [], "text": ""}

        joined = "、".join(f"「{t}」" for t in terms)
        return {
            "found": True,
            "terms": terms,
            "text": f"【梗雷达】这条发言可能跟 {joined} 有关。不懂就用 search_community_meme 查，参数只准填上面这几个梗名原文，不要填群友原话。",
        }

    async def search_meme(self, query: str, limit: int = 3) -> dict[str, Any]:
        """按梗名/别名直查详情。**纯 SQLite，不发任何网络请求。**

        入参只接受梗名——梗雷达每轮都把命中的梗名摆在提示词里，模型照抄即可。
        这里没有向量兜底是故意的：语义召回已经在雷达那一步做完了，查空就是真的
        没有，该去 web_search 查证再 record_community_meme 沉淀，而不是再花一次
        embed 往返去确认「确实没有」。
        """
        clean_query = str(query or "").strip()
        if not clean_query:
            return {"ok": False, "error": "empty_query", "found": False, "results": []}

        k = max(1, min(int(limit or 3), 10))
        all_memes = await self._load_all()
        query_norm = _norm(clean_query)
        hits = [(score, item) for item in all_memes if (score := self._name_hit(query_norm, item)) > 0]
        hits.sort(key=lambda pair: pair[0], reverse=True)
        results = [_format_meme(item, score) for score, item in hits[:k]]

        return {
            "ok": True,
            "query": clean_query,
            "found": len(results) > 0,
            "count": len(results),
            "results": results,
            **({} if results else {
                "message": f"梗库里没有「{clean_query}」。若确认要收录，先去互联网查证，再用 record_community_meme 写进来；查不到就照实说不懂，别编。",
            }),
        }

    async def list_all_memes(self, limit: int = 50) -> dict[str, Any]:
        """列出数据库中所有的梗条目。"""
        loop = asyncio.get_running_loop()

        def _query() -> list[dict[str, Any]]:
            with self._get_conn() as conn:
                rows = conn.execute(
                    "SELECT id, term, aliases, meaning, origin, examples, tags, updated_at, "
                    "embedding IS NOT NULL AS has_vector "
                    "FROM community_memes ORDER BY updated_at DESC LIMIT ?",
                    (max(1, min(int(limit), 200)),),
                ).fetchall()
                return [_decode_row(dict(r)) for r in rows]

        results = await loop.run_in_executor(None, _query)
        return {
            "ok": True,
            "count": len(results),
            "memes": results,
        }

    async def delete_meme(self, term: str = "", meme_id: int | None = None) -> dict[str, Any]:
        """删除指定的梗条目。面板按 id 删，模型按梗名删。"""
        clean_term = str(term or "").strip()
        if not clean_term and not meme_id:
            return {"ok": False, "error": "empty_term"}

        loop = asyncio.get_running_loop()

        def _delete() -> int:
            with self._get_conn() as conn:
                if meme_id:
                    cur = conn.execute("DELETE FROM community_memes WHERE id = ?", (int(meme_id),))
                else:
                    cur = conn.execute("DELETE FROM community_memes WHERE term = ?", (clean_term,))
                conn.commit()
                return cur.rowcount

        deleted_rows = await loop.run_in_executor(None, _delete)
        return {
            "ok": True,
            "found": deleted_rows > 0,
            "deleted": deleted_rows,
            "term": clean_term,
        }
