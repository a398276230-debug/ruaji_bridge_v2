"""astrbot.core.pipeline.context_utils —— 事件钩子分发。

宿主的事件分发全部走这里，所以这个文件是"统一宿主"真正干活的地方之一：
UnifiedContext 收到 Bridge v2 的 `POST /api/v1/events` 后，就是调
`call_event_hook(event, EventType.OnLLMRequestEvent, req)` 让三个插件依次
往同一个 `ProviderRequest` 上打补丁 —— 这正是跨插件协作的实现方式，
GCP 塞滑窗、SelfLearning 塞语气、LivingMemory 塞记忆，都改同一个对象。

两条与上游一致的关键行为：
  1. **钩子异常只记录不外抛**。一个插件的钩子炸了不该让整条链路断掉，
     上游就是这么做的（except BaseException + traceback）。
  2. **异步生成器要走完**。插件里有 `async def on_xxx(...): ... yield`
     这种写法（洋葱模型），只 await 不迭代的话生成器体根本不执行。
"""

from __future__ import annotations

import inspect
import traceback
import typing as T

from astrbot.core import logger
from astrbot.core.message.message_event_result import CommandResult, MessageEventResult
from astrbot.core.star.star import star_map
from astrbot.core.star.star_handler import EventType, star_handlers_registry


async def call_handler(
    event: T.Any,
    handler: T.Callable[..., T.Any],
    *args: T.Any,
    **kwargs: T.Any,
) -> T.AsyncGenerator[T.Any, None]:
    """调用一个 handler，把它的产出逐个 yield 出来。"""
    ready_to_call = None
    try:
        ready_to_call = handler(event, *args, **kwargs)
    except TypeError:
        logger.error("插件 handler 的参数与定义不匹配", exc_info=True)

    if not ready_to_call:
        return

    if inspect.isasyncgen(ready_to_call):
        has_yielded = False
        async for ret in ready_to_call:
            has_yielded = True
            if isinstance(ret, MessageEventResult | CommandResult):
                event.set_result(ret)
                yield
            else:
                yield ret
        if not has_yielded:
            yield
    elif inspect.iscoroutine(ready_to_call):
        ret = await ready_to_call
        if isinstance(ret, MessageEventResult | CommandResult):
            event.set_result(ret)
            yield
        else:
            yield ret


async def call_event_hook(
    event: T.Any,
    hook_type: EventType,
    *args: T.Any,
    **kwargs: T.Any,
) -> bool:
    """把一个事件广播给所有注册了该类型的插件钩子。

    Returns:
        事件是否被某个插件终止（event.is_stopped()）。
    """
    handlers = star_handlers_registry.get_handlers_by_event_type(
        hook_type,
        plugins_name=getattr(event, "plugins_name", None),
    )
    for handler in handlers:
        star = star_map.get(handler.handler_module_path or "")
        star_name = star.name if star else handler.handler_module_path
        try:
            fn = handler.handler
            result = fn(event, *args, **kwargs)
            if inspect.isasyncgen(result):
                # 洋葱模型的钩子：必须迭代，否则函数体一行都不会执行
                async for _ in result:
                    pass
            elif inspect.isawaitable(result):
                await result
            logger.debug("hook(%s) -> %s.%s", hook_type.name, star_name, handler.handler_name)
        except BaseException:
            # 一个插件的钩子炸了不能拖垮整条链路，这与上游一致
            logger.error(
                "hook(%s) 在 %s.%s 中抛异常:\n%s",
                hook_type.name,
                star_name,
                handler.handler_name,
                traceback.format_exc(),
            )
    return bool(getattr(event, "is_stopped", lambda: False)())


__all__ = ["call_event_hook", "call_handler"]
