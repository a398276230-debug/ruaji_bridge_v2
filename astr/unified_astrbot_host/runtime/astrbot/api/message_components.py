"""astrbot.api.message_components —— 消息链元件。

`from astrbot.api.message_components import Plain, At, Image` 是插件构造回复的
标准写法。这里只做转发，实现在 astrbot.core.message.components。
"""

from astrbot.core.message.components import (
    At,
    AtAll,
    BaseMessageComponent,
    ComponentType,
    Face,
    File,
    Forward,
    Image,
    Json,
    Node,
    Nodes,
    Plain,
    Poke,
    Record,
    Reply,
    Unknown,
    Video,
    WechatEmoji,
    Xml,
)

__all__ = [
    "At",
    "AtAll",
    "BaseMessageComponent",
    "ComponentType",
    "Face",
    "File",
    "Forward",
    "Image",
    "Json",
    "Node",
    "Nodes",
    "Plain",
    "Poke",
    "Record",
    "Reply",
    "Unknown",
    "Video",
    "WechatEmoji",
    "Xml",
]
