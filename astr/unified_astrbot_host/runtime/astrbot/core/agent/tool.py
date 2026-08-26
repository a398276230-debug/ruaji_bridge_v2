"""astrbot.core.agent.tool —— 函数调用工具。

这是本次垫片里唯一"形状必须一模一样"的模块，因为 LivingMemory 是**继承**它的：

    @dataclass
    class MemorySearchTool(FunctionTool[AstrAgentContext]):
        __pydantic_config__ = {"arbitrary_types_allowed": True}
        context: Context
        config_manager: ConfigManager
        memory_engine: MemoryEngine
        name: str = "recall_long_term_memory"
        ...

三个硬约束由此而来：
  1. 必须是 `pydantic.dataclasses.dataclass` —— 子类用 `__pydantic_config__`，普通
     dataclass 不认这个属性；
  2. 必须是 `Generic[TContext]` —— 子类写了 `FunctionTool[AstrAgentContext]`；
  3. 基类的**所有字段都得有默认值** —— 子类在它们之后声明了无默认值的
     `context: Context`。dataclass 的字段顺序是"基类先、子类后"，基类若有
     无默认值字段排在后面就会 TypeError。上游正是这么排的，照抄。

与上游的两处刻意差异（都是为了不引入没装的依赖）：
  * `ToolExecResult` 上游是 `str | mcp.types.CallToolResult`。宿主不接 MCP，
    收敛成 `str`；工具返回值最终要塞进 system prompt，本来也只能是文本。
  * 上游 `ToolSchema` 有个 model_validator 用 `jsonschema.validate` 校验
    parameters 是不是合法 JSON Schema。这里去掉 —— 那个校验的价值是在
    开发期抓错手写 schema，而这三个插件的 schema 是既有的、跑过的。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Generic

from pydantic import Field
from pydantic.dataclasses import dataclass
from typing_extensions import TypeVar

from astrbot.core import logger

from .run_context import ContextWrapper

TContext = TypeVar("TContext", default=Any)

#: 工具执行结果。上游还允许 mcp.types.CallToolResult，宿主不接 MCP。
ToolExecResult = str

ParametersType = dict[str, Any]


@dataclass
class ToolSchema:
    """工具对模型暴露的那一面。"""

    name: str = ""
    description: str = ""
    parameters: ParametersType = Field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass
class FunctionTool(ToolSchema, Generic[TContext]):
    """一个可被 LLM 调用的工具。

    两种用法都要支持：
      * 子类化并覆写 `call()`（LivingMemory 的两个工具走这条）；
      * 直接塞一个 `handler` 协程（`@filter.llm_tool` 装饰器走这条）。
    """

    handler: Callable[..., Awaitable[Any]] | None = None
    handler_module_path: str | None = None
    active: bool = True
    is_background_task: bool = False

    async def call(self, context: ContextWrapper[TContext], **kwargs: Any) -> ToolExecResult:
        if self.handler is None:
            raise NotImplementedError(
                f"工具 {self.name!r} 既没有 handler 也没有覆写 call()"
            )
        result = self.handler(context, **kwargs)
        if hasattr(result, "__await__"):
            result = await result
        return result if isinstance(result, str) else str(result)

    # 上游别名，插件里偶有直呼
    async def run(self, context: ContextWrapper[TContext], **kwargs: Any) -> ToolExecResult:
        return await self.call(context, **kwargs)


@dataclass
class ToolSet:
    """一组工具。"""

    tools: list[FunctionTool] = Field(default_factory=list)

    def empty(self) -> bool:
        return not self.tools

    def add_tool(self, tool: FunctionTool) -> None:
        """加入或替换同名工具。

        上游的语义是"激活态优先"：已有一个 active 的同名工具时，不让一个
        inactive 的把它顶掉。照搬，否则插件里"先注册禁用占位、后注册真身"
        这类写法会失效。
        """
        for i, existing in enumerate(self.tools):
            if existing.name != tool.name:
                continue
            if existing.active and not tool.active:
                return
            self.tools[i] = tool
            return
        self.tools.append(tool)

    def remove_tool(self, name: str) -> None:
        self.tools = [t for t in self.tools if t.name != name]

    def get_tool(self, name: str) -> FunctionTool | None:
        for tool in self.tools:
            if tool.name == name:
                return tool
        return None

    def names(self) -> list[str]:
        return [t.name for t in self.tools]

    def openai_schemas(self) -> list[dict[str, Any]]:
        return [t.openai_schema() for t in self.tools if t.active]

    def __len__(self) -> int:
        return len(self.tools)

    def __iter__(self):
        return iter(self.tools)


def build_inline_tool(
    name: str,
    description: str,
    parameters: ParametersType,
    handler: Callable[..., Awaitable[Any]],
) -> FunctionTool:
    """把一个裸协程包成 FunctionTool。`@filter.llm_tool` 与 Hermes 导出都用它。"""
    if not name:
        logger.warning("试图注册一个没有名字的 LLM 工具，已忽略")
    return FunctionTool(
        name=name,
        description=description,
        parameters=parameters,
        handler=handler,
        handler_module_path=getattr(handler, "__module__", None),
    )


__all__ = [
    "FunctionTool",
    "ParametersType",
    "ToolExecResult",
    "ToolSchema",
    "ToolSet",
    "build_inline_tool",
]
