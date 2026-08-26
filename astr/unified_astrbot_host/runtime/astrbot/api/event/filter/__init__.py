"""astrbot.api.event.filter —— 插件写 `@filter.xxx` 时看到的这个 `filter`。

短名到 register_* 的映射。三个插件实际用到的 11 个装饰器 + 4 个枚举都在这里，
其余的按上游名字补齐，免得以后插件升级时缺一个就炸在导入期。
"""

from astrbot.core.star.filter import (
    CommandFilter,
    CustomFilter,
    CustomFilterWrapper,
    EventMessageType,
    EventMessageTypeFilter,
    PermissionType,
    PermissionTypeFilter,
    PlatformAdapterType,
    PlatformAdapterTypeFilter,
    RegexFilter,
)
from astrbot.core.star.register import (
    register_after_message_sent as after_message_sent,
)
from astrbot.core.star.register import (
    register_command as command,
)
from astrbot.core.star.register import (
    register_command_group as command_group,
)
from astrbot.core.star.register import (
    register_custom_filter as custom_filter,
)
from astrbot.core.star.register import (
    register_event_message_type as event_message_type,
)
from astrbot.core.star.register import (
    register_llm_tool as llm_tool,
)
from astrbot.core.star.register import (
    register_on_agent_begin as on_agent_begin,
)
from astrbot.core.star.register import (
    register_on_agent_done as on_agent_done,
)
from astrbot.core.star.register import (
    register_on_astrbot_loaded as on_astrbot_loaded,
)
from astrbot.core.star.register import (
    register_on_decorating_result as on_decorating_result,
)
from astrbot.core.star.register import (
    register_on_llm_request as on_llm_request,
)
from astrbot.core.star.register import (
    register_on_llm_response as on_llm_response,
)
from astrbot.core.star.register import (
    register_on_llm_tool_respond as on_llm_tool_respond,
)
from astrbot.core.star.register import (
    register_on_platform_loaded as on_platform_loaded,
)
from astrbot.core.star.register import (
    register_on_plugin_error as on_plugin_error,
)
from astrbot.core.star.register import (
    register_on_plugin_loaded as on_plugin_loaded,
)
from astrbot.core.star.register import (
    register_on_plugin_unloaded as on_plugin_unloaded,
)
from astrbot.core.star.register import (
    register_on_using_llm_tool as on_using_llm_tool,
)
from astrbot.core.star.register import (
    register_on_waiting_llm_request as on_waiting_llm_request,
)
from astrbot.core.star.register import (
    register_permission_type as permission_type,
)
from astrbot.core.star.register import (
    register_platform_adapter_type as platform_adapter_type,
)
from astrbot.core.star.register import (
    register_regex as regex,
)

__all__ = [
    "CommandFilter",
    "CustomFilter",
    "CustomFilterWrapper",
    "EventMessageType",
    "EventMessageTypeFilter",
    "PermissionType",
    "PermissionTypeFilter",
    "PlatformAdapterType",
    "PlatformAdapterTypeFilter",
    "RegexFilter",
    "after_message_sent",
    "command",
    "command_group",
    "custom_filter",
    "event_message_type",
    "llm_tool",
    "on_agent_begin",
    "on_agent_done",
    "on_astrbot_loaded",
    "on_decorating_result",
    "on_llm_request",
    "on_llm_response",
    "on_llm_tool_respond",
    "on_platform_loaded",
    "on_plugin_error",
    "on_plugin_loaded",
    "on_plugin_unloaded",
    "on_using_llm_tool",
    "on_waiting_llm_request",
    "permission_type",
    "platform_adapter_type",
    "regex",
]
