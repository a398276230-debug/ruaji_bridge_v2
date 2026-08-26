"""astrbot.core.exceptions —— 框架异常。

LivingMemory 的知识库上传路径会 catch 这个类型。宿主里没有知识库上传，
但 except 子句里的名字得能解析。
"""


class AstrBotError(Exception):
    """所有框架异常的基类。"""


class KnowledgeBaseUploadError(AstrBotError):
    """知识库上传失败。"""


class ProviderError(AstrBotError):
    """Provider 调用失败（LLM / Embedding / Rerank）。"""


class NoProviderError(ProviderError):
    """没有可用的 Provider。"""


__all__ = [
    "AstrBotError",
    "KnowledgeBaseUploadError",
    "NoProviderError",
    "ProviderError",
]
