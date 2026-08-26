"""astrbot.core.utils.astrbot_path —— 数据目录解析。

真 AstrBot 用 `data/` 作为可写根。宿主把它重定向到自己的 data/，
避免与插件各自的 *_data 目录混在一起，也让"删掉 data/ 就是干净重来"成立。

宿主启动时会调 rebind()，把根改成 config.yaml 里配置的路径。
"""

from __future__ import annotations

import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[4] / "data"


def rebind(root: str | os.PathLike) -> None:
    global _ROOT
    _ROOT = Path(root).resolve()
    _ROOT.mkdir(parents=True, exist_ok=True)


def get_astrbot_root() -> str:
    return str(_ROOT.parent)


def get_astrbot_data_path() -> str:
    _ROOT.mkdir(parents=True, exist_ok=True)
    return str(_ROOT)


def get_astrbot_plugin_path() -> str:
    path = _ROOT / "plugins"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def get_astrbot_config_path() -> str:
    # 统一收敛至 plugin_data，杜绝多重路径
    path = _ROOT / "plugin_data"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def get_astrbot_temp_path() -> str:
    path = _ROOT / "temp"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def get_astrbot_plugin_data_path() -> str:
    path = _ROOT / "plugin_data"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


__all__ = [
    "get_astrbot_config_path",
    "get_astrbot_data_path",
    "get_astrbot_plugin_data_path",
    "get_astrbot_plugin_path",
    "get_astrbot_root",
    "get_astrbot_temp_path",
    "rebind",
]
