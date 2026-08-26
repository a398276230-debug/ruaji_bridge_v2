"""astrbot.core.config —— 配置入口。

`AstrBotConfig` 的实现在 astrbot.core.star.config（插件配置的落盘 dict），
这里只做转发，外加一个 GCP 的 web 面板要用的路径函数：

    group_chat_plus/web/server.py:1632
        from astrbot.core.config import get_astrbot_config_path
        config_dir = get_astrbot_config_path()

它在一个函数内的 try 块里，拿不到也不致命；但给出真路径能让 GCP 的
配置读写落到宿主的 data/config 下，而不是散落在插件目录里。
"""

from __future__ import annotations

import os

from astrbot.core.star.config import AstrBotConfig
from astrbot.core.utils.astrbot_path import get_astrbot_config_path


def get_astrbot_config_file() -> str:
    return os.path.join(get_astrbot_config_path(), "cmd_config.json")


__all__ = ["AstrBotConfig", "get_astrbot_config_file", "get_astrbot_config_path"]
