"""hermes_layer/gateway_client.py —— 统一出站 HTTP 通道。

宿主里所有对外的模型类调用都从这里出去：
    - Chat / 反思推理   → 本地 gemini-proxy（OpenAI 兼容协议）
    - Embedding 向量化  → youzi.today
    - Rerank 重排       → youzi.today

为什么要收口到一个类：

1. **连接池**。旧实现里每个 provider 每次调用都新建一个 `httpx.AsyncClient`
   （见三份旧垫片的 `async with httpx.AsyncClient(...) as client`）。
   记忆摄取一次要发几十个 embedding 请求，每次都重新 TLS 握手，
   在 youzi.today 这种远端上是纯粹的浪费。这里全局复用一个池。

2. **密钥零硬编码**。旧垫片会去读 `D:/cpa/config.yaml` 拿 key，读不到就退回
   字面量 `"sk-cpa-local"`。这里只认环境变量名：配置里写 `api_key_env`，
   真实密钥永远不进配置文件、不进日志、不进源码。

3. **降级语义显式化**。rerank 是可选增强 —— 挂了应该退回纯 RRF 融合而不是
   让整次召回失败。这个判断必须只有一处，否则迟早会出现"某条路径上
   rerank 失败直接把召回打挂"的情况。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("hermes.gateway")


class GatewayError(RuntimeError):
    """出站调用失败。带上是哪个端点，便于定位。"""

    def __init__(self, endpoint: str, message: str, *, status: int | None = None) -> None:
        super().__init__(f"{endpoint}: {message}")
        self.endpoint = endpoint
        self.status = status


@dataclass
class EndpointConfig:
    base_url: str
    model: str = ""
    api_key_env: str = ""
    api_key: str = ""
    timeout_s: float = 30.0
    max_retries: int = 2
    backoff_s: float = 0.5
    extra_headers: dict[str, str] = field(default_factory=dict)

    def resolve_key(self) -> str:
        if self.api_key:
            return self.api_key
        return os.getenv(self.api_key_env, "") if self.api_key_env else ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url)


def _join(base_url: str, path: str) -> str:
    """拼 URL，但不重复拼路径。

    配置里的 base_url 可能是 OpenAI 风格的根（`https://x/v1`），也可能是别人
    从文档里直接抄来的完整端点（`https://x/v1/embeddings`）。两种都得能用：
    人类抄 URL 的时候不会先想清楚该抄到哪一层，而拼错的表现是
    `POST /v1/embeddings/embeddings` 返回 404 —— 这条报错看起来像服务挂了，
    实际上是配置多了一段。
    """
    base = base_url.rstrip("/")
    if not path:
        return base
    tail = "/" + path.strip("/")
    return base if base.endswith(tail) else base + tail


class GatewayClient:
    """全局共享的出站客户端。宿主启动时建一个，关闭时 aclose()。"""

    def __init__(
        self,
        llm: EndpointConfig,
        embedding: EndpointConfig,
        rerank: EndpointConfig,
        *,
        max_connections: int = 32,
        max_keepalive: int = 16,
        offline: bool = False,
        embedding_dim: int = 1024,
    ) -> None:
        self.llm = llm
        self.embedding = embedding
        self.rerank = rerank
        #: 离线模式：不发任何出站请求，由本进程合成形状正确的响应。
        #: 用户离线、NapCat 未扫码期间的开发与测试全程用它。
        self.offline = offline
        self.embedding_dim = embedding_dim
        self._client: httpx.AsyncClient | None = None
        self._limits = httpx.Limits(
            max_connections=max_connections,
            max_keepalive_connections=max_keepalive,
        )
        #: 运维可见的调用统计，/health 会返回它
        self.stats: dict[str, dict[str, Any]] = {}

    # ---------- 生命周期 ----------

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            # 本地直连 (:8868, :8317)，远端 HTTPS (youzi.today) 走本地代理
            proxy_url = os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or "http://127.0.0.1:10081"
            mounts = {
                "http://127.0.0.1": httpx.AsyncHTTPTransport(),
                "http://localhost": httpx.AsyncHTTPTransport(),
                "all://": httpx.AsyncHTTPTransport(proxy=proxy_url),
            }
            self._client = httpx.AsyncClient(mounts=mounts, limits=self._limits, follow_redirects=False)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---------- 三种调用 ----------

    async def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float = 0.6,
        max_tokens: int = 2000,
        **extra: Any,
    ) -> str:
        """OpenAI 兼容的 chat completion，返回纯文本。"""
        cfg = self.llm
        if not cfg.configured:
            raise GatewayError("chat", "未配置 llm.base_url")

        payload = {
            "model": model or cfg.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            **extra,
        }
        data = await self._post(cfg, "chat", "/chat/completions", payload)

        choices = data.get("choices") or []
        if not choices:
            # 有些兼容实现把内容放顶层，兜一下再放弃
            return str(data.get("content") or "")
        message = choices[0].get("message") or {}
        return str(message.get("content") or message.get("reasoning_content") or "")

    async def embed(self, texts: list[str], *, model: str | None = None) -> list[list[float]]:
        """批量向量化。一次请求打包全部文本 —— 逐条发是旧实现最大的性能坑。"""
        cfg = self.embedding
        if not cfg.configured:
            raise GatewayError("embeddings", "未配置 embedding.base_url")
        if not texts:
            return []

        payload = {"model": model or cfg.model, "input": texts}
        data = await self._post(cfg, "embeddings", "/embeddings", payload)

        items = data.get("data") or []
        if len(items) != len(texts):
            raise GatewayError(
                "embeddings",
                f"返回条数与输入不符: 入参 {len(texts)} 条，返回 {len(items)} 条",
            )
        # 按 index 排序：协议不保证顺序，错位会让向量与文本对不上，
        # 而且这种错误在检索结果里表现为"召回结果莫名其妙"，极难定位
        items.sort(key=lambda x: x.get("index", 0))
        return [list(item["embedding"]) for item in items]

    async def rerank_or_none(
        self,
        query: str,
        documents: list[str],
        *,
        top_n: int | None = None,
        model: str | None = None,
    ) -> list[dict[str, Any]] | None:
        """重排。

        返回 None 表示"这次没排成，请用纯 RRF 的顺序"。刻意不抛异常：
        rerank 是可选增强，调用方本来就该在拿不到时继续走下去，
        用返回值表达比让每个调用点写 try/except 更难写错。
        """
        cfg = self.rerank
        if not cfg.configured:
            return None
        if not documents:
            return []

        payload: dict[str, Any] = {
            "model": model or cfg.model,
            "query": query,
            "documents": documents,
        }
        if top_n:
            payload["top_n"] = top_n

        try:
            data = await self._post(cfg, "rerank", "/rerank", payload)
        except GatewayError as exc:
            logger.warning("重排不可用，本次退回纯 RRF 融合: %s", exc)
            return None

        results = data.get("results") or data.get("data") or []
        out: list[dict[str, Any]] = []
        for item in results:
            index = item.get("index")
            if index is None:
                continue
            out.append(
                {
                    "index": int(index),
                    "relevance_score": float(
                        item.get("relevance_score", item.get("score", 0.0)) or 0.0
                    ),
                }
            )
        return out

    # ---------- 探活 ----------

    async def probe(self) -> dict[str, Any]:
        """三个端点各探一次，供 /health 使用。任何一个挂了不影响其余。"""

        async def one(name: str, cfg: EndpointConfig, coro) -> tuple[str, dict[str, Any]]:
            if not cfg.configured:
                return name, {"configured": False}
            try:
                await coro
                return name, {"configured": True, "ok": True, "model": cfg.model}
            except Exception as exc:
                return name, {"configured": True, "ok": False, "error": str(exc)[:200]}

        results = await asyncio.gather(
            one("llm", self.llm, self.chat([{"role": "user", "content": "ping"}], max_tokens=1)),
            one("embedding", self.embedding, self.embed(["ping"])),
            one("rerank", self.rerank, self._probe_rerank()),
            return_exceptions=True,
        )
        out: dict[str, Any] = {}
        for item in results:
            if isinstance(item, BaseException):
                continue
            name, detail = item
            out[name] = detail
        return out

    async def _probe_rerank(self) -> None:
        result = await self.rerank_or_none("ping", ["pong"])
        if result is None:
            raise GatewayError("rerank", "重排端点不可用（调用方会退回纯 RRF）")

    # ---------- 离线模式 ----------

    def _offline_response(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        """合成一个形状正确的响应，不碰网络。

        三个端点的 mock 质量不一样，这里说清各自的边界：

        * **embeddings —— 有语义。** 用哈希技巧（hashing trick）做词袋向量：
          分词后每个 token 哈希进固定桶再 L2 归一。共享词的文本余弦相似度高。
          这一点很重要：如果返回随机向量，"检索能召回正确记忆"这类测试就只是
          在赌运气，绿了也不说明链路对。
        * **rerank —— 有序但无洞察。** 按 query 与 doc 的字符级 Jaccard 打分。
          够用来验证"重排结果被正确消费"，不足以验证重排质量。
        * **chat —— 只有形状。** 返回的是占位文本；要求 JSON 的场景返回一个
          合法的空 JSON。语义正确的离线 LLM 不存在，需要真实抽取结果的测试
          必须自己注入 stub，别指望这里。
        """
        stat = self.stats.setdefault(endpoint, {"calls": 0, "failures": 0, "total_ms": 0.0})
        stat["calls"] += 1
        stat["offline"] = True

        if endpoint == "embeddings":
            texts = payload.get("input") or []
            return {
                "data": [
                    {"index": i, "embedding": _hashing_embedding(str(t), self.embedding_dim)}
                    for i, t in enumerate(texts)
                ],
                "model": payload.get("model", ""),
            }

        if endpoint == "rerank":
            query = str(payload.get("query") or "")
            docs = payload.get("documents") or []
            scored = [
                {"index": i, "relevance_score": _jaccard(query, str(doc))}
                for i, doc in enumerate(docs)
            ]
            scored.sort(key=lambda item: item["relevance_score"], reverse=True)
            top_n = payload.get("top_n")
            return {"results": scored[: int(top_n)] if top_n else scored}

        messages = payload.get("messages") or []
        last = str(messages[-1].get("content", "")) if messages else ""
        wants_json = "json" in last.lower() or "JSON" in last
        content = "{}" if wants_json else "[离线模式] 本次未调用真实 LLM。"
        return {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
            "model": payload.get("model", ""),
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    # ---------- 内部 ----------

    async def _post(
        self,
        cfg: EndpointConfig,
        endpoint: str,
        path: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if self.offline:
            return self._offline_response(endpoint, payload)

        url = _join(cfg.base_url, path)
        headers = {"Content-Type": "application/json", **cfg.extra_headers}
        key = cfg.resolve_key()
        if key:
            headers["Authorization"] = f"Bearer {key}"

        stat = self.stats.setdefault(endpoint, {"calls": 0, "failures": 0, "total_ms": 0.0})
        last_error: Exception | None = None

        for attempt in range(1, max(1, cfg.max_retries) + 1):
            started = asyncio.get_running_loop().time()
            try:
                response = await self.client.post(
                    url, json=payload, headers=headers, timeout=cfg.timeout_s
                )
                elapsed_ms = (asyncio.get_running_loop().time() - started) * 1000
                stat["calls"] += 1
                stat["total_ms"] += elapsed_ms

                if response.status_code == 429 and attempt < cfg.max_retries:
                    wait = self._retry_after(response, cfg.backoff_s * attempt)
                    logger.info("%s 触发限流(429)，%.1fs 后重试", endpoint, wait)
                    await asyncio.sleep(wait)
                    continue

                if response.status_code >= 400:
                    raise GatewayError(
                        endpoint,
                        f"HTTP {response.status_code}: {response.text[:200]}",
                        status=response.status_code,
                    )
                return response.json()

            except (httpx.TimeoutException, httpx.TransportError) as exc:
                stat["calls"] += 1
                stat["failures"] += 1
                last_error = GatewayError(endpoint, f"{type(exc).__name__}: {exc}")
                if attempt < cfg.max_retries:
                    await asyncio.sleep(cfg.backoff_s * attempt)
                    continue
            except GatewayError as exc:
                stat["failures"] += 1
                # 4xx 是请求本身有问题，重试多少次都一样；5xx 才值得重试
                if exc.status and 400 <= exc.status < 500:
                    raise
                last_error = exc
                if attempt < cfg.max_retries:
                    await asyncio.sleep(cfg.backoff_s * attempt)
                    continue

        raise last_error or GatewayError(endpoint, "未知失败")

    @staticmethod
    def _retry_after(response: httpx.Response, fallback: float) -> float:
        header = response.headers.get("retry-after")
        if header:
            try:
                return min(float(header), 10.0)
            except ValueError:
                pass
        try:
            body = response.json()
            reset = body.get("error", {}).get("reset_seconds")
            if reset is not None:
                return min(float(reset), 10.0)
        except Exception:  # noqa: BLE001 —— 解析失败就用退避默认值
            pass
        return fallback


def build_from_config(config: dict[str, Any]) -> GatewayClient:
    """从 config.yaml 的 `providers` 段构造。"""
    providers = config.get("providers") or {}
    offline = str(providers.get("mode", "live")).strip().lower() in ("offline", "mock")

    def endpoint(name: str, defaults: dict[str, Any]) -> EndpointConfig:
        raw = {**defaults, **(providers.get(name) or {})}
        return EndpointConfig(
            base_url=str(raw.get("base_url") or ""),
            model=str(raw.get("model") or ""),
            api_key_env=str(raw.get("api_key_env") or ""),
            api_key=str(raw.get("api_key") or ""),
            timeout_s=float(raw.get("timeout_s", defaults.get("timeout_s", 30.0))),
            max_retries=int(raw.get("max_retries", defaults.get("max_retries", 2))),
            backoff_s=float(raw.get("backoff_s", defaults.get("backoff_s", 0.5))),
            extra_headers=dict(raw.get("extra_headers") or {}),
        )

    return GatewayClient(
        llm=endpoint("llm", {"timeout_s": 120.0, "max_retries": 2}),
        embedding=endpoint("embedding", {"timeout_s": 30.0, "max_retries": 3}),
        rerank=endpoint("rerank", {"timeout_s": 20.0, "max_retries": 2}),
        max_connections=int(config.get("server", {}).get("max_connections", 32)),
        offline=offline,
        embedding_dim=int((providers.get("embedding") or {}).get("dim", 1024)),
    )


def _tokenize(text: str) -> list[str]:
    """离线向量用的极简分词：ASCII 按词、CJK 按二元组。

    CJK 用 bigram 而不是单字，是因为单字词袋把"记忆"和"记者"算成半相似，
    bigram 不会。这是中文检索里最便宜的一次质量提升。
    """
    lowered = text.lower()
    words = re.findall(r"[a-z0-9]+", lowered)
    cjk = re.findall(r"[一-鿿]+", lowered)
    for run in cjk:
        words.extend(run[i : i + 2] for i in range(max(1, len(run) - 1)))
    return words


def _hashing_embedding(text: str, dim: int) -> list[float]:
    """确定性词袋向量。同样的文本永远得到同样的向量。"""
    vector = [0.0] * max(1, dim)
    for token in _tokenize(text) or [text[:8] or "∅"]:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % len(vector)
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[bucket] += sign
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


def _jaccard(a: str, b: str) -> float:
    left, right = set(_tokenize(a)), set(_tokenize(b))
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


__all__ = ["EndpointConfig", "GatewayClient", "GatewayError", "build_from_config"]
