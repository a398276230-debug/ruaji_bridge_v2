"""astrbot.core.provider.provider —— Provider 抽象与网关实现。

上游把 Provider 定义成抽象基类，由各家 SDK 实现。垫片这里给出：
    AbstractProvider / Provider / EmbeddingProvider / RerankProvider / STTProvider / TTSProvider
        —— 抽象层，供插件做 isinstance 与类型标注
    GatewayChatProvider / GatewayEmbeddingProvider / GatewayRerankProvider
        —— 唯一实现，全部走 hermes_layer.gateway_client 的共享连接池

插件不认识 Gateway*，它们只看到 `Provider`。谁在背后发 HTTP、
用哪个 key、超时多久，是宿主的事，不是插件的事。
"""

from __future__ import annotations

import abc
import logging
from typing import Any

from .entities import LLMResponse, ProviderMeta, ProviderType, RerankResult

logger = logging.getLogger("astrbot.provider")


class AbstractProvider(abc.ABC):
    def __init__(self, provider_config: dict | None = None) -> None:
        self.provider_config: dict[str, Any] = provider_config or {}
        self.model_name: str = str(self.provider_config.get("model") or "")

    def set_model(self, model_name: str) -> None:
        self.model_name = model_name

    def get_model(self) -> str:
        return self.model_name

    def meta(self) -> ProviderMeta:
        return ProviderMeta(
            id=str(self.provider_config.get("id") or "unknown"),
            model=self.model_name,
            type=str(self.provider_config.get("type") or ""),
            provider_type=ProviderType.CHAT_COMPLETION,
        )

    async def test(self) -> None:
        return None


class Provider(AbstractProvider):
    """对话 Provider。"""

    def __init__(self, provider_config: dict | None = None, provider_settings: dict | None = None) -> None:
        super().__init__(provider_config)
        self.provider_settings: dict[str, Any] = provider_settings or {}

    def get_current_key(self) -> str:
        return ""

    def get_keys(self) -> list[str]:
        return []

    def set_key(self, key: str) -> None:  # noqa: ARG002
        return None

    async def get_models(self) -> list[str]:
        return [self.model_name] if self.model_name else []

    async def text_chat(
        self,
        prompt: str = "",
        session_id: str | None = None,
        image_urls: list[str] | None = None,
        func_tool: Any = None,
        contexts: list[dict] | None = None,
        system_prompt: str | None = None,
        tool_calls_result: Any = None,
        model: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        raise NotImplementedError

    async def text_chat_stream(self, *args: Any, **kwargs: Any):
        """默认把非流式结果包成单块，插件里只有可选路径用到。"""
        response = await self.text_chat(*args, **kwargs)
        response.is_chunk = False
        yield response


class EmbeddingProvider(AbstractProvider):
    def __init__(self, provider_config: dict | None = None, provider_settings: dict | None = None) -> None:
        super().__init__(provider_config)
        self.provider_settings: dict[str, Any] = provider_settings or {}

    def meta(self) -> ProviderMeta:
        meta = super().meta()
        meta.provider_type = ProviderType.EMBEDDING
        return meta

    @abc.abstractmethod
    async def get_embedding(self, text: str) -> list[float]: ...

    @abc.abstractmethod
    async def get_embeddings(self, text: list[str]) -> list[list[float]]: ...

    @abc.abstractmethod
    def get_dim(self) -> int: ...

    async def get_embeddings_batch(
        self,
        texts: list[str],
        batch_size: int = 32,
        **kwargs: Any,
    ) -> list[list[float]]:
        out: list[list[float]] = []
        for start in range(0, len(texts), max(1, batch_size)):
            out.extend(await self.get_embeddings(texts[start : start + batch_size]))
        return out


class RerankProvider(AbstractProvider):
    def __init__(self, provider_config: dict | None = None, provider_settings: dict | None = None) -> None:
        super().__init__(provider_config)
        self.provider_settings: dict[str, Any] = provider_settings or {}

    def meta(self) -> ProviderMeta:
        meta = super().meta()
        meta.provider_type = ProviderType.RERANK
        return meta

    @abc.abstractmethod
    async def rerank(
        self,
        query: str,
        documents: list[str],
        top_n: int | None = None,
    ) -> list[RerankResult]: ...


class STTProvider(AbstractProvider):
    async def get_text(self, audio_url: str) -> str:  # noqa: ARG002
        raise NotImplementedError("统一垫片不提供语音转文字")


class TTSProvider(AbstractProvider):
    async def get_audio(self, text: str) -> str:  # noqa: ARG002
        raise NotImplementedError("统一垫片不提供文字转语音")


# ======================================================================
# 网关实现：唯一真正发 HTTP 的三个类
# ======================================================================


class GatewayChatProvider(Provider):
    def __init__(self, gateway: Any, provider_id: str = "hermes", model: str = "") -> None:
        super().__init__(
            provider_config={"id": provider_id, "model": model or gateway.llm.model, "type": "openai_chat_completion"},
            provider_settings={},
        )
        self.gateway = gateway
        self.provider_id = provider_id
        self.model_name = model or gateway.llm.model

    @property
    def base_url(self) -> str:
        return self.gateway.llm.base_url

    async def text_chat(
        self,
        prompt: str = "",
        session_id: str | None = None,
        image_urls: list[str] | None = None,
        func_tool: Any = None,
        contexts: list[dict] | None = None,
        system_prompt: str | None = None,
        tool_calls_result: Any = None,
        model: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        messages: list[dict[str, Any]] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        for item in contexts or []:
            if isinstance(item, dict) and item.get("role"):
                messages.append(item)
        if prompt:
            messages.append({"role": "user", "content": prompt})

        text = await self.gateway.chat(
            messages,
            model=model or self.model_name,
            temperature=float(kwargs.get("temperature", 0.6)),
            max_tokens=int(kwargs.get("max_tokens", 2000)),
        )
        return LLMResponse(role="assistant", completion_text=text)


class GatewayEmbeddingProvider(EmbeddingProvider):
    def __init__(self, gateway: Any, provider_id: str = "hermes-embedding", dim: int = 1024) -> None:
        super().__init__(
            provider_config={"id": provider_id, "model": gateway.embedding.model, "type": "openai_embedding"},
            provider_settings={},
        )
        self.gateway = gateway
        self.provider_id = provider_id
        self.model_name = gateway.embedding.model
        self._dim = int(dim)

    def get_dim(self) -> int:
        return self._dim

    async def get_embedding(self, text: str) -> list[float]:
        vectors = await self.get_embeddings([text])
        return vectors[0] if vectors else []

    async def get_embeddings(self, text: list[str]) -> list[list[float]]:
        vectors = await self.gateway.embed(list(text), model=self.model_name)
        if vectors and len(vectors[0]) != self._dim:
            # 维度对不上是致命的：FAISS 索引一旦按错误维度建起来，
            # 之后每次检索都是静默的错误结果。这里在第一次就纠正并大声说出来。
            logger.warning(
                "向量维度与配置不符，已按实际维度 %d 修正（配置写的是 %d）",
                len(vectors[0]),
                self._dim,
            )
            self._dim = len(vectors[0])
        return vectors

    async def get_embedding_with_retry(self, text: str) -> list[float]:
        """上游别名。重试已经在 GatewayClient 里做了，这里直接转发。"""
        return await self.get_embedding(text)


class GatewayRerankProvider(RerankProvider):
    def __init__(self, gateway: Any, provider_id: str = "hermes-rerank") -> None:
        super().__init__(
            provider_config={"id": provider_id, "model": gateway.rerank.model, "type": "openai_rerank"},
            provider_settings={},
        )
        self.gateway = gateway
        self.provider_id = provider_id
        self.model_name = gateway.rerank.model

    async def rerank(
        self,
        query: str,
        documents: list[str],
        top_n: int | None = None,
    ) -> list[RerankResult]:
        """重排不可用时返回空列表 —— 调用方据此保留 RRF 的原始顺序。"""
        raw = await self.gateway.rerank_or_none(query, documents, top_n=top_n, model=self.model_name)
        if raw is None:
            return []
        return [RerankResult(index=item["index"], relevance_score=item["relevance_score"]) for item in raw]


__all__ = [
    "AbstractProvider",
    "EmbeddingProvider",
    "GatewayChatProvider",
    "GatewayEmbeddingProvider",
    "GatewayRerankProvider",
    "Provider",
    "RerankProvider",
    "STTProvider",
    "TTSProvider",
]
