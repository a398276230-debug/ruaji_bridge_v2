"""hermes_layer.adapters —— 插件适配器汇总。

每个适配器封装一个 AstrBot 生态插件，对外只暴露
``UnifiedPluginContract`` 标准接口。
"""

from hermes_layer.adapters.living_memory_adapter import LivingMemoryAdapter
from hermes_layer.adapters.group_chat_plus_adapter import GroupChatPlusAdapter

__all__ = [
    "GroupChatPlusAdapter",
    "LivingMemoryAdapter",
]
