"""astrbot.core.db.vec_db.faiss_impl.vec_db —— FAISS 向量库。

这是垫片里唯一"有真实算法"的模块 —— 其余全是接口转发，这里是真的建索引、
真的算相似度。LivingMemory 的向量召回完全压在它上面。

与真实 AstrBot 的语义严格对齐的三处（对不齐就会静默地给出错误召回）：

1. **索引类型是 IndexFlatL2 + IndexIDMap**，不是内积。
2. **相似度换算是 `1.0 - L2/2.0`**。这个公式只在向量已归一化时成立
   （此时 ‖a-b‖² = 2 - 2·cos）。LivingMemory 的
   `min_similarity_for_retrieval` 阈值就是按这个刻度调出来的，
   换成余弦或内积会让阈值整体失准。
3. **metadata 过滤发生在 FAISS 检索之后**：先取 fetch_k 条，再按 metadata 筛，
   最后截 top_k。顺序反过来会漏召回。

与旧垫片（三个插件各自 astrbot/ 下那份）的差别：旧的完全没用 FAISS，
是���所有向量读进内存做全表余弦扫描。几百条时看不出问题，
上万条原子之后每次召回都要扫全库。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger("astrbot.vecdb")

try:  # pragma: no cover - 环境相关
    import faiss

    FAISS_AVAILABLE = True
except Exception as _exc:  # noqa: BLE001
    faiss = None  # type: ignore[assignment]
    FAISS_AVAILABLE = False
    logger.warning("未能加载 faiss，向量检索将退回全表扫描: %s", _exc)


@dataclass
class Result:
    similarity: float
    data: dict


class KnowledgeBaseUploadError(RuntimeError):
    def __init__(self, stage: str = "", user_message: str = "", details: dict | None = None) -> None:
        super().__init__(user_message or stage)
        self.stage = stage
        self.user_message = user_message
        self.details = details or {}


# ======================================================================
# 文档存储（SQLite）
# ======================================================================

_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id    TEXT    NOT NULL UNIQUE,
    text      TEXT    NOT NULL,
    metadata  TEXT    NOT NULL DEFAULT '{}',
    created_at REAL   NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_doc_id ON documents(doc_id);
"""


class DocumentStorage:
    """文档正文与元数据。

    用同步 sqlite3 + 到线程池，而不是 aiosqlite：这里的调用都是短事务，
    aiosqlite 每个连接一个后台线程的模型在"多个插件共享一个库"时反而更难关干净。
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        # WAL：读写并发。反思 Worker 在后台写，前台还在召回。
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _run(self, fn, *args):
        with self._lock, self._connect() as conn:
            return fn(conn, *args)

    async def initialize(self) -> None:
        def work(conn: sqlite3.Connection) -> None:
            conn.executescript(_SCHEMA)

        await asyncio.to_thread(self._run, work)

    async def connect(self) -> None:
        await self.initialize()

    async def insert_document(self, doc_id: str, text: str, metadata: dict, vector: Any = None) -> int:
        import time as _time

        def work(conn: sqlite3.Connection) -> int:
            cols = [c[1] for c in conn.execute("PRAGMA table_info(documents)").fetchall()]
            data_map = {
                "doc_id": doc_id,
                "text": text,
                "metadata": json.dumps(metadata or {}, ensure_ascii=False),
            }
            if "vector" in cols:
                vec_str = json.dumps(vector.tolist()) if (vector is not None and hasattr(vector, "tolist")) else (json.dumps(vector) if vector is not None else "[]")
                data_map["vector"] = vec_str
            if "created_at" in cols:
                data_map["created_at"] = _time.time()
            if "updated_at" in cols:
                data_map["updated_at"] = _time.time()

            insert_cols = [k for k in data_map if k in cols]
            placeholders = ",".join("?" for _ in insert_cols)
            sql = f"INSERT INTO documents({','.join(insert_cols)}) VALUES({placeholders})"
            cursor = conn.execute(sql, [data_map[k] for k in insert_cols])
            return int(cursor.lastrowid)

        return await asyncio.to_thread(self._run, work)

    async def insert_documents_batch(
        self,
        doc_ids: list[str],
        texts: list[str],
        metadatas: list[dict],
        vectors: Any = None,
    ) -> list[int]:
        import time as _time

        now = _time.time()

        def work(conn: sqlite3.Connection) -> list[int]:
            cols = [c[1] for c in conn.execute("PRAGMA table_info(documents)").fetchall()]
            ids: list[int] = []
            for idx, (doc_id, text, metadata) in enumerate(zip(doc_ids, texts, metadatas, strict=True)):
                data_map = {
                    "doc_id": doc_id,
                    "text": text,
                    "metadata": json.dumps(metadata or {}, ensure_ascii=False),
                }
                if "vector" in cols:
                    v = vectors[idx] if vectors is not None and idx < len(vectors) else None
                    vec_str = json.dumps(v.tolist()) if (v is not None and hasattr(v, "tolist")) else (json.dumps(v) if v is not None else "[]")
                    data_map["vector"] = vec_str
                if "created_at" in cols:
                    data_map["created_at"] = now
                if "updated_at" in cols:
                    data_map["updated_at"] = now

                insert_cols = [k for k in data_map if k in cols]
                placeholders = ",".join("?" for _ in insert_cols)
                sql = f"INSERT INTO documents({','.join(insert_cols)}) VALUES({placeholders})"
                cursor = conn.execute(sql, [data_map[k] for k in insert_cols])
                ids.append(int(cursor.lastrowid))
            return ids

        return await asyncio.to_thread(self._run, work)

    async def get_documents(
        self,
        metadata_filters: dict | None = None,
        ids: Any = None,
        limit: int = 10000,
        offset: int = 0,
    ) -> list[dict]:
        id_list = _as_int_list(ids)

        def work(conn: sqlite3.Connection) -> list[dict]:
            if id_list is not None:
                if not id_list:
                    return []
                placeholders = ",".join("?" for _ in id_list)
                rows = conn.execute(
                    f"SELECT * FROM documents WHERE id IN ({placeholders})",
                    id_list,
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM documents ORDER BY id DESC LIMIT ? OFFSET ?",
                    (int(limit), int(offset)),
                ).fetchall()
            return [_row_to_dict(row) for row in rows]

        documents = await asyncio.to_thread(self._run, work)
        return _apply_metadata_filters(documents, metadata_filters)

    async def get_document_by_doc_id(self, doc_id: str) -> dict | None:
        def work(conn: sqlite3.Connection) -> dict | None:
            row = conn.execute(
                "SELECT * FROM documents WHERE doc_id=?",
                (doc_id,),
            ).fetchone()
            return _row_to_dict(row) if row else None

        return await asyncio.to_thread(self._run, work)

    async def update_document_by_doc_id(self, doc_id: str, new_text: str) -> None:
        def work(conn: sqlite3.Connection) -> None:
            conn.execute("UPDATE documents SET text=? WHERE doc_id=?", (new_text, doc_id))

        await asyncio.to_thread(self._run, work)

    async def delete_document_by_doc_id(self, doc_id: str) -> int | None:
        def work(conn: sqlite3.Connection) -> int | None:
            row = conn.execute("SELECT id FROM documents WHERE doc_id=?", (doc_id,)).fetchone()
            if row is None:
                return None
            conn.execute("DELETE FROM documents WHERE doc_id=?", (doc_id,))
            return int(row["id"])

        return await asyncio.to_thread(self._run, work)

    async def delete_documents(self, metadata_filters: dict) -> list[int]:
        matched = await self.get_documents(metadata_filters=metadata_filters, limit=1_000_000)
        ids = [doc["id"] for doc in matched]
        if not ids:
            return []

        def work(conn: sqlite3.Connection) -> None:
            placeholders = ",".join("?" for _ in ids)
            conn.execute(f"DELETE FROM documents WHERE id IN ({placeholders})", ids)

        await asyncio.to_thread(self._run, work)
        return ids

    async def count_documents(self, metadata_filters: dict | None = None) -> int:
        if not metadata_filters:

            def work(conn: sqlite3.Connection) -> int:
                return int(conn.execute("SELECT COUNT(*) AS n FROM documents").fetchone()["n"])

            return await asyncio.to_thread(self._run, work)
        return len(await self.get_documents(metadata_filters=metadata_filters, limit=1_000_000))

    async def get_user_ids(self) -> list[str]:
        documents = await self.get_documents(limit=1_000_000)
        return sorted({str(d["metadata"].get("user_id", "")) for d in documents if d["metadata"].get("user_id")})

    async def search_sparse(self, query: str, k: int = 10, **kwargs: Any) -> list[dict]:  # noqa: ARG002
        """稀疏检索。

        真框架用 SQLite FTS5。垫片不建 FTS 表 —— LivingMemory 自带
        `core/retrieval/bm25_retriever.py`（jieba 分词 + 自实现 BM25），
        稀疏这一路本来就走它自己的实现，这里再建一套只会有两个真相。
        """
        return []

    async def ensure_fts_index(self) -> bool:
        return False

    async def rebuild_fts_index(self) -> None:
        return None

    @property
    def stopwords(self) -> set[str]:
        return set()

    async def close(self) -> None:
        return None


# ======================================================================
# 向量存储（FAISS）
# ======================================================================


class EmbeddingStorage:
    def __init__(self, dimension: int, path: str | None = None) -> None:
        self.dimension = int(dimension)
        self.path = str(path) if path else None
        self._lock = threading.RLock()
        self.index = None
        #: faiss 缺失时的纯 numpy 退路：id -> vector
        self._fallback: dict[int, np.ndarray] = {}
        self._load()

    # ---------- 索引生命周期 ----------

    def _load(self) -> None:
        if not FAISS_AVAILABLE:
            self._load_fallback()
            return
        if self.path and os.path.exists(self.path):
            try:
                self.index = faiss.read_index(self.path)
                if self.index.d != self.dimension:
                    logger.warning(
                        "索引维度 %d 与 Embedding 维度 %d 不符，重建空索引",
                        self.index.d,
                        self.dimension,
                    )
                    self.index = self._new_index()
                return
            except Exception as exc:  # noqa: BLE001
                logger.error("索引读取失败，重建空索引: %s", exc)
        self.index = self._new_index()

    def _new_index(self):
        # 与上游一致：L2 距离 + IDMap。相似度换算依赖这个选择。
        return faiss.IndexIDMap(faiss.IndexFlatL2(self.dimension))

    def _load_fallback(self) -> None:
        if not self.path:
            return
        npz = f"{self.path}.npz"
        if os.path.exists(npz):
            try:
                data = np.load(npz)
                ids, vectors = data["ids"], data["vectors"]
                self._fallback = {int(i): v for i, v in zip(ids, vectors, strict=True)}
            except Exception as exc:  # noqa: BLE001
                logger.error("退路索引读取失败，从空开始: %s", exc)

    # ---------- 读写 ----------

    async def insert(self, vector: np.ndarray, id: int) -> None:  # noqa: A002
        await self.insert_batch(np.asarray([vector], dtype=np.float32), [int(id)])

    async def insert_batch(self, vectors: np.ndarray, ids: list[int]) -> None:
        array = np.ascontiguousarray(np.asarray(vectors, dtype=np.float32))
        if array.ndim == 1:
            array = array.reshape(1, -1)

        def work() -> None:
            with self._lock:
                if FAISS_AVAILABLE and self.index is not None:
                    self.index.add_with_ids(array, np.asarray(ids, dtype=np.int64))
                else:
                    for row, doc_id in zip(array, ids, strict=True):
                        self._fallback[int(doc_id)] = row

        await asyncio.to_thread(work)

    async def search(self, vector: np.ndarray, k: int) -> tuple:
        query = np.ascontiguousarray(np.asarray(vector, dtype=np.float32).reshape(1, -1))
        k = max(1, int(k))

        def work() -> tuple:
            with self._lock:
                if FAISS_AVAILABLE and self.index is not None:
                    if self.index.ntotal == 0:
                        return np.zeros((1, 0), dtype="float32"), np.full((1, 0), -1, dtype="int64")
                    return self.index.search(query, min(k, self.index.ntotal))

                if not self._fallback:
                    return np.zeros((1, 0), dtype="float32"), np.full((1, 0), -1, dtype="int64")
                ids = np.asarray(list(self._fallback.keys()), dtype="int64")
                matrix = np.asarray(list(self._fallback.values()), dtype="float32")
                distances = np.sum((matrix - query) ** 2, axis=1)
                order = np.argsort(distances)[:k]
                return distances[order].reshape(1, -1), ids[order].reshape(1, -1)

        return await asyncio.to_thread(work)

    async def delete(self, ids: list[int]) -> None:
        if not ids:
            return

        def work() -> None:
            with self._lock:
                if FAISS_AVAILABLE and self.index is not None:
                    selector = faiss.IDSelectorBatch(np.asarray(ids, dtype=np.int64))
                    self.index.remove_ids(selector)
                else:
                    for doc_id in ids:
                        self._fallback.pop(int(doc_id), None)

        await asyncio.to_thread(work)

    async def save_index(self) -> None:
        if not self.path:
            return

        def work() -> None:
            with self._lock:
                Path(self.path).parent.mkdir(parents=True, exist_ok=True)
                if FAISS_AVAILABLE and self.index is not None:
                    # 先写 tmp 再原子替换：崩在写一半会留下一个读不出来的索引，
                    # 而索引读不出来意味着全部长期记忆的向量路召回归零
                    tmp = f"{self.path}.tmp"
                    faiss.write_index(self.index, tmp)
                    os.replace(tmp, self.path)
                elif self._fallback:
                    np.savez(
                        f"{self.path}.npz",
                        ids=np.asarray(list(self._fallback.keys()), dtype="int64"),
                        vectors=np.asarray(list(self._fallback.values()), dtype="float32"),
                    )

        await asyncio.to_thread(work)

    @property
    def ntotal(self) -> int:
        with self._lock:
            if FAISS_AVAILABLE and self.index is not None:
                return int(self.index.ntotal)
            return len(self._fallback)


# ======================================================================
# 组合体
# ======================================================================


class BaseVecDB:
    async def initialize(self) -> None: ...


class FaissVecDB(BaseVecDB):
    def __init__(
        self,
        doc_store_path: str,
        index_store_path: str,
        embedding_provider: Any,
        rerank_provider: Any = None,
    ) -> None:
        self.doc_store_path = str(doc_store_path)
        self.index_store_path = str(index_store_path)
        self.embedding_provider = embedding_provider
        self.rerank_provider = rerank_provider
        self.document_storage = DocumentStorage(doc_store_path)
        self.embedding_storage = EmbeddingStorage(
            int(embedding_provider.get_dim()),
            index_store_path,
        )

    async def initialize(self) -> None:
        await self.document_storage.initialize()

    async def insert(self, content: str, metadata: dict | None = None, id: str | None = None) -> int:  # noqa: A002
        doc_id = id or str(uuid.uuid4())
        vector = np.asarray(await self.embedding_provider.get_embedding(content), dtype=np.float32)
        int_id = await self.document_storage.insert_document(doc_id, content, metadata or {}, vector=vector)
        await self.embedding_storage.insert(vector, int_id)
        await self.embedding_storage.save_index()
        return int_id

    async def insert_batch(
        self,
        contents: list[str],
        metadatas: list[dict] | None = None,
        ids: list[str] | None = None,
        batch_size: int = 32,
        embedding_contents: list[str] | None = None,
        **kwargs: Any,
    ) -> list[int]:
        if not contents:
            return []
        metadatas = metadatas or [{} for _ in contents]
        ids = ids or [str(uuid.uuid4()) for _ in contents]
        embedding_contents = embedding_contents or contents

        if not (len(metadatas) == len(ids) == len(embedding_contents) == len(contents)):
            raise KnowledgeBaseUploadError(
                stage="storage",
                user_message="存储失败：文本、元数据、ID、向量化文本四者数量不一致",
                details={
                    "contents": len(contents),
                    "metadatas": len(metadatas),
                    "ids": len(ids),
                    "embedding_contents": len(embedding_contents),
                },
            )

        vectors = await self.embedding_provider.get_embeddings_batch(
            embedding_contents, batch_size=batch_size
        )
        if len(vectors) != len(contents):
            raise KnowledgeBaseUploadError(
                stage="embedding",
                user_message=(
                    f"向量化失败：返回 {len(vectors)} 条向量，与 {len(contents)} 条文本不符"
                ),
            )

        matrix = np.asarray(vectors, dtype=np.float32)
        if matrix.ndim != 2 or matrix.shape[1] != self.embedding_storage.dimension:
            raise KnowledgeBaseUploadError(
                stage="embedding",
                user_message=(
                    f"向量化失败：维度 {matrix.shape} 与索引维度 "
                    f"{self.embedding_storage.dimension} 不符"
                ),
            )

        int_ids = await self.document_storage.insert_documents_batch(ids, contents, metadatas, vectors=matrix)
        await self.embedding_storage.insert_batch(matrix, int_ids)
        await self.embedding_storage.save_index()
        return int_ids

    async def retrieve(
        self,
        query: str,
        k: int = 5,
        fetch_k: int = 20,
        rerank: bool = False,
        metadata_filters: dict | None = None,
    ) -> list[Result]:
        embedding = await self.embedding_provider.get_embedding(query)
        scores, indices = await self.embedding_storage.search(
            vector=np.asarray(embedding, dtype="float32"),
            k=fetch_k if metadata_filters else k,
        )
        if indices.size == 0 or int(indices[0][0]) == -1:
            return []

        # 与上游一致：L2 距离折算成 [0,1] 的相似度。仅在向量已归一化时成立。
        similarities = 1.0 - (np.asarray(scores[0], dtype="float64") / 2.0)

        fetched = await self.document_storage.get_documents(
            metadata_filters=metadata_filters or {},
            ids=[int(i) for i in indices[0] if int(i) >= 0],
        )
        if not fetched:
            return []

        by_id = {doc["id"]: doc for doc in fetched}
        results: list[Result] = []
        for position, raw_id in enumerate(indices[0]):
            doc = by_id.get(int(raw_id))
            if doc is None:
                continue
            results.append(Result(similarity=float(similarities[position]), data=doc))

        top = results[:k]

        if rerank and self.rerank_provider and top:
            reranked = await self.rerank_provider.rerank(query, [r.data["text"] for r in top])
            if reranked:  # 空列表 = 重排不可用，保留原顺序
                reranked = sorted(reranked, key=lambda x: x.relevance_score, reverse=True)
                top = [top[item.index] for item in reranked if 0 <= item.index < len(top)]

        return top

    async def delete(self, doc_id: str) -> None:
        int_id = await self.document_storage.delete_document_by_doc_id(doc_id)
        if int_id is not None:
            await self.embedding_storage.delete([int_id])
            await self.embedding_storage.save_index()

    async def delete_documents(self, metadata_filters: dict) -> None:
        int_ids = await self.document_storage.delete_documents(metadata_filters)
        if int_ids:
            await self.embedding_storage.delete(int_ids)
            await self.embedding_storage.save_index()

    async def count_documents(self, metadata_filters: dict | None = None) -> int:
        return await self.document_storage.count_documents(metadata_filters)

    async def close(self) -> None:
        await self.embedding_storage.save_index()
        await self.document_storage.close()


# ======================================================================
# 工具函数
# ======================================================================


def _row_to_dict(row: sqlite3.Row) -> dict:
    try:
        metadata = json.loads(row["metadata"] or "{}")
    except (TypeError, json.JSONDecodeError):
        metadata = {}
    row_keys = row.keys() if hasattr(row, "keys") else []
    created_at = row["created_at"] if "created_at" in row_keys else 0.0
    return {
        "id": int(row["id"]),
        "doc_id": row["doc_id"],
        "text": row["text"],
        "metadata": metadata,
        "created_at": created_at,
    }


def _as_int_list(ids: Any) -> list[int] | None:
    if ids is None:
        return None
    if isinstance(ids, np.ndarray):
        ids = ids.tolist()
    out: list[int] = []
    for value in ids:
        try:
            as_int = int(value)
        except (TypeError, ValueError):
            continue
        if as_int >= 0:
            out.append(as_int)
    return out


def _apply_metadata_filters(documents: list[dict], filters: dict | None) -> list[dict]:
    """元数据过滤。

    值是列表时按"包含"匹配（`{"user_id": ["a", "b"]}` 表示 a 或 b），
    否则严格相等。比较前统一转成字符串 —— user_id 在 SQLite 里可能是 int，
    在传参里是 str，不归一就会全部匹配不上。
    """
    if not filters:
        return documents
    out: list[dict] = []
    for doc in documents:
        metadata = doc.get("metadata") or {}
        if all(_match_one(metadata.get(key), expected) for key, expected in filters.items()):
            out.append(doc)
    return out


def _match_one(actual: Any, expected: Any) -> bool:
    if isinstance(expected, (list, tuple, set)):
        return str(actual) in {str(x) for x in expected}
    return str(actual) == str(expected)


__all__ = [
    "FAISS_AVAILABLE",
    "BaseVecDB",
    "DocumentStorage",
    "EmbeddingStorage",
    "FaissVecDB",
    "KnowledgeBaseUploadError",
    "Result",
]
