"""bootstrap.py —— 把 import 路径摆好，必须在任何 astrbot 相关 import 之前执行。

垫片把 AstrBot 运行时放在 `runtime/astrbot/`，而三个插件的源码里写的是
`from astrbot.api.star import Star` —— 它们是为真正的 AstrBot 写的，
一个字都不该为宿主改。所以 `runtime/` 必须进 sys.path，让顶层名字
`astrbot` 解析到垫片。

这是一个独立模块而不是某个函数里的几行：`import` 语句在模块加载时就执行，
写在 `main()` 里的路径设置永远赶不上文件顶部的 `from astrbot.core import logger`。
"""

from __future__ import annotations

import os
import sys

#: 项目根（config.yaml、host_server.py 所在处）
ROOT = os.path.dirname(os.path.abspath(__file__))
#: 垫片根。`astrbot` 顶层包在这里面。
RUNTIME = os.path.join(ROOT, "runtime")


def install() -> None:
    for path in (RUNTIME, ROOT):
        if path not in sys.path:
            sys.path.insert(0, path)


install()

__all__ = ["ROOT", "RUNTIME", "install"]
