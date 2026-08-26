"""hermes_layer.plugin_contract —— 统一插件契约。

所有装载入统一宿主的插件适配器 **必须** 继承 ``UnifiedPluginContract``
并按需实现对应方法。

宿主核心（HostServer / ContextBuilder / DecisionEngine / ToolHub）只
面向此抽象基类编程，不再直接穿透访问任何插件内部实现。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from hermes_layer.contracts import ContextBlock, Decision, InboundMessage

if TYPE_CHECKING:
    from hermes_layer.contracts import Verdict  # noqa: F401


class HermesTool:
    """描述一条可暴露给 Hermes Agent 的 Function Tool。"""

    __slots__ = ("name", "description", "parameters", "handler")

    def __init__(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        handler: Any,
    ) -> None:
        self.name = name
        self.description = description
        self.parameters = parameters
        self.handler = handler

    def to_manifest(self) -> dict[str, Any]:
        """转为 MCP 工具清单中需要的 JSON 形状。"""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.parameters,
        }


class UnifiedPluginContract(ABC):
    """所有装载入统一宿主的插件适配器必须实现的唯一标准接口。

    *   ``plugin_key`` 和生命周期方法 (``initialize`` / ``terminate``) 是强制的。
    *   能力方法 (``on_message_received`` / ``provide_context`` /
        ``decide_reply`` / ``export_tools``) 有默认空实现，适配器按需覆盖。
    *   ``execution_order`` 控制并发分组：同 order 的适配器并发执行，
        不同 order 按升序串行——这保证了 GCP 可以看到 LM 的完整产出。
    """

    # ---- 标识与排序 ----

    @property
    @abstractmethod
    def plugin_key(self) -> str:
        """插件唯一标识，对应 config.yaml 中的 ``plugins.<key>``。"""
        ...

    @property
    def execution_order(self) -> int:
        """执行顺序权重。默认 100，数值小的先执行。

        同 order 的适配器在 ``provide_context`` / ``on_message_received``
        中会被并发调用；不同 order 按升序串行。
        """
        return 100

    @property
    def decision_priority(self) -> int:
        """裁决优先级。数值越小越优先。

        当多个适配器都返回非 None 的 ``Decision`` 时，取优先级最高者。
        默认 100。
        """
        return 100

    # ---- 生命周期 ----

    @abstractmethod
    async def initialize(self, context: Any, config: dict[str, Any]) -> None:
        """插件初始化，在宿主启动时调用一次。

        Parameters
        ----------
        context:
            ``UnifiedContext`` 实例——持有 provider 注册表、人格管理器等。
        config:
            该插件在 ``config.yaml`` 中的配置段。
        """
        ...

    @abstractmethod
    async def terminate(self) -> None:
        """插件卸载与资源释放。"""
        ...

    # ---- 核心能力（按需覆盖） ----

    async def on_message_received(self, message: InboundMessage) -> None:
        """接收到消息时的异步生命周期广播。

        用于记忆摄取、日志记录等被动行为。
        默认不做任何事情。
        """

    async def provide_context(
        self,
        message: InboundMessage,
        history: list[dict[str, Any]] | None = None,
    ) -> list[ContextBlock]:
        """向 LLM 推理上下文注入提示词或参考数据。

        返回一组 ``ContextBlock``，宿主负责汇总与拼装。
        默认返回空列表。
        """
        return []

    async def decide_reply(
        self,
        message: InboundMessage,
        history: list[dict[str, Any]] | None = None,
    ) -> Decision | None:
        """参与回复决策（如 GCP 读空气）。

        返回 ``None`` 表示本插件不参与裁决。
        默认不参与。
        """
        return None

    def export_tools(self) -> list[HermesTool]:
        """向 Hermes Agent 暴露可调用的 Function Tools。

        默认不暴露任何工具。
        """
        return []


__all__ = [
    "HermesTool",
    "UnifiedPluginContract",
]
