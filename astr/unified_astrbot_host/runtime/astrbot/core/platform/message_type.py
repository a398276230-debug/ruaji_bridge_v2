from enum import Enum


class MessageType(Enum):
    """消息类型。

    取值与真实 AstrBot 完全一致（"GroupMessage" / "FriendMessage" / "OtherMessage"）。
    这一点很要紧：LivingMemory 会把 `MessageType(...)` 的 value 拼进
    unified_msg_origin，再用它做记忆的会话隔离。值对不上，历史记忆就找不回来。
    """

    GROUP_MESSAGE = "GroupMessage"
    FRIEND_MESSAGE = "FriendMessage"
    OTHER_MESSAGE = "OtherMessage"
