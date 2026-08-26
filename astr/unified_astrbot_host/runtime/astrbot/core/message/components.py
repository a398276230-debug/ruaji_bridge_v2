"""astrbot.core.message.components —— 消息段模型。

对齐 AstrBot 的 `BaseMessageComponent` 家族。三个插件用到的段类型：
    Plain / At / AtAll / Image / Reply / Face / Video / Record / File / Forward / Node

真实现里这些类基于 pydantic 且带下载、转 base64、file_token 等一整套能力。
垫片只保留"数据 + toString()"：Bridge v2 才是唯一拼装 CQ 码的地方
（见 ruaji_bridge_v2 的 adapters/napcat/），插件这一侧只需要能表达段结构。
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class ComponentType(Enum):
    Plain = "Plain"
    Face = "Face"
    Record = "Record"
    Video = "Video"
    At = "At"
    AtAll = "AtAll"
    RPS = "RPS"
    Dice = "Dice"
    Shake = "Shake"
    Anonymous = "Anonymous"
    Share = "Share"
    Contact = "Contact"
    Location = "Location"
    Music = "Music"
    Image = "Image"
    Reply = "Reply"
    RedBag = "RedBag"
    Poke = "Poke"
    Forward = "Forward"
    Node = "Node"
    Nodes = "Nodes"
    Xml = "Xml"
    Json = "Json"
    CardImage = "CardImage"
    TTS = "TTS"
    Unknown = "Unknown"
    File = "File"
    WechatEmoji = "WechatEmoji"


class BaseMessageComponent:
    """所有消息段的基类。

    刻意不用 dataclass：插件里存在 `Plain("文本")` 与 `Plain(text="文本")`
    两种写法，还有 `At(qq=123)` / `At(123)`。用显式 __init__ 才能都兼容。
    """

    type: ComponentType = ComponentType.Unknown

    def __init__(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)

    def toString(self) -> str:  # noqa: N802 —— 名字对齐上游 API
        return ""

    def toDict(self) -> dict[str, Any]:  # noqa: N802
        data = {k: v for k, v in self.__dict__.items() if not k.startswith("_")}
        return {"type": self.type.value, "data": data}

    def __repr__(self) -> str:
        inner = ", ".join(f"{k}={v!r}" for k, v in self.__dict__.items() if not k.startswith("_"))
        return f"{self.__class__.__name__}({inner})"


class Plain(BaseMessageComponent):
    type = ComponentType.Plain

    def __init__(self, text: str = "", convert: bool = True, **kwargs: Any) -> None:
        self.text = str(text)
        self.convert = convert
        super().__init__(**kwargs)

    def toString(self) -> str:  # noqa: N802
        return self.text


class At(BaseMessageComponent):
    type = ComponentType.At

    def __init__(self, qq: Any = "", name: str = "", **kwargs: Any) -> None:
        self.qq = str(qq)
        self.name = name
        super().__init__(**kwargs)

    def toString(self) -> str:  # noqa: N802
        return f"[CQ:at,qq={self.qq}]"


class AtAll(At):
    type = ComponentType.AtAll

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(qq="all", **kwargs)

    def toString(self) -> str:  # noqa: N802
        return "[CQ:at,qq=all]"


class Image(BaseMessageComponent):
    type = ComponentType.Image

    def __init__(self, file: str = "", url: str = "", **kwargs: Any) -> None:
        self.file = file
        self.url = url or file
        super().__init__(**kwargs)

    @staticmethod
    def fromURL(url: str, **kwargs: Any) -> "Image":  # noqa: N802
        return Image(file=url, url=url, **kwargs)

    @staticmethod
    def fromFileSystem(path: str, **kwargs: Any) -> "Image":  # noqa: N802
        return Image(file=f"file:///{path}", url=f"file:///{path}", **kwargs)

    def toString(self) -> str:  # noqa: N802
        return f"[CQ:image,file={self.file}]"


class Reply(BaseMessageComponent):
    type = ComponentType.Reply

    def __init__(
        self,
        id: Any = "",  # noqa: A002 —— 字段名对齐上游
        chain: list[BaseMessageComponent] | None = None,
        sender_id: Any = "",
        sender_nickname: str = "",
        message_str: str = "",
        **kwargs: Any,
    ) -> None:
        self.id = str(id)
        self.chain = chain or []
        self.sender_id = str(sender_id)
        self.sender_nickname = sender_nickname
        self.message_str = message_str
        super().__init__(**kwargs)

    def toString(self) -> str:  # noqa: N802
        return f"[CQ:reply,id={self.id}]"


class Face(BaseMessageComponent):
    type = ComponentType.Face

    def __init__(self, id: Any = 0, **kwargs: Any) -> None:  # noqa: A002
        self.id = id
        super().__init__(**kwargs)

    def toString(self) -> str:  # noqa: N802
        return f"[CQ:face,id={self.id}]"


class Record(BaseMessageComponent):
    type = ComponentType.Record

    def __init__(self, file: str = "", url: str = "", **kwargs: Any) -> None:
        self.file = file
        self.url = url or file
        super().__init__(**kwargs)


class Video(BaseMessageComponent):
    type = ComponentType.Video

    def __init__(self, file: str = "", url: str = "", **kwargs: Any) -> None:
        self.file = file
        self.url = url or file
        super().__init__(**kwargs)


class File(BaseMessageComponent):
    type = ComponentType.File

    def __init__(self, name: str = "", file: str = "", url: str = "", **kwargs: Any) -> None:
        self.name = name
        self.file = file
        self.url = url or file
        super().__init__(**kwargs)


class Node(BaseMessageComponent):
    """合并转发里的一条。"""

    type = ComponentType.Node

    def __init__(
        self,
        content: list[BaseMessageComponent] | str | None = None,
        uin: Any = "",
        name: str = "",
        time: int | None = None,
        **kwargs: Any,
    ) -> None:
        self.content = content if content is not None else []
        self.uin = str(uin)
        self.name = name
        self.time = time
        super().__init__(**kwargs)


class Forward(BaseMessageComponent):
    type = ComponentType.Forward

    def __init__(self, id: Any = "", nodes: list[Node] | None = None, **kwargs: Any) -> None:  # noqa: A002
        self.id = str(id)
        self.nodes = nodes or []
        super().__init__(**kwargs)


class Nodes(BaseMessageComponent):
    type = ComponentType.Nodes

    def __init__(self, nodes: list[Node] | None = None, **kwargs: Any) -> None:
        self.nodes = nodes or []
        super().__init__(**kwargs)


class Poke(BaseMessageComponent):
    type = ComponentType.Poke

    def __init__(self, qq: Any = "", type: Any = "", id: Any = "", **kwargs: Any) -> None:  # noqa: A002
        self.qq = str(qq)
        self.poke_type = type
        self.id = id
        super().__init__(**kwargs)


class Json(BaseMessageComponent):
    type = ComponentType.Json

    def __init__(self, data: Any = "", **kwargs: Any) -> None:
        self.data = data
        super().__init__(**kwargs)


class Xml(BaseMessageComponent):
    type = ComponentType.Xml

    def __init__(self, data: Any = "", **kwargs: Any) -> None:
        self.data = data
        super().__init__(**kwargs)


class WechatEmoji(BaseMessageComponent):
    type = ComponentType.WechatEmoji

    def __init__(self, md5: str = "", md5_len: int = 0, cdnurl: str = "", **kwargs: Any) -> None:
        self.md5 = md5
        self.md5_len = md5_len
        self.cdnurl = cdnurl
        super().__init__(**kwargs)


class Unknown(BaseMessageComponent):
    type = ComponentType.Unknown

    def __init__(self, text: str = "", **kwargs: Any) -> None:
        self.text = text
        super().__init__(**kwargs)


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
