"""astrbot.core —— 框架级单例。

真 AstrBot 在这里挂了一堆全局单例（astrbot_config / file_token_service /
html_renderer / sp）。插件通过 `from astrbot.core import ...` 拿到它们。
垫片只提供三个插件真正用到的那几个，其余不实现。

`sp`（SharedPreferences）在 LivingMemory 里用于跨会话存少量键值对。
真实现落在 AstrBot 的数据目录，这里落到宿主自己的 data/ 下，格式同为 JSON。
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any

class _DynamicPluginLogger:
    """自动将日志归属到具体的插件模块名（如 SelfLearning / LivingMemory / GroupChatPlus）"""
    def _get_caller_logger(self):
        try:
            frame = inspect.currentframe()
            caller_frame = frame.f_back.f_back if frame and frame.f_back else None
            if caller_frame:
                mod_name = caller_frame.f_globals.get("__name__", "")
                if "group_chat_plus" in mod_name:
                    return logging.getLogger("GroupChatPlus")
                if "self_learning" in mod_name:
                    return logging.getLogger("SelfLearning")
                if "livingmemory" in mod_name:
                    return logging.getLogger("LivingMemory")
                if mod_name:
                    return logging.getLogger(mod_name.split(".")[0])
        except Exception:
            pass
        return logging.getLogger("astrbot")

    def getChild(self, suffix: str):
        return self._get_caller_logger().getChild(suffix)

    def __getattr__(self, name: str):
        return getattr(self._get_caller_logger(), name)

import inspect
logger = _DynamicPluginLogger()


class SharedPreferences:
    """极简键值存储，语义对齐 AstrBot 的 `sp`。

    写入是"每次 put 都落盘"而不是定时刷：这里存的是插件的少量状态
    （上次反思时间之类），量小、丢了很难查，用吞吐换确定性是划算的。
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        try:
            if self._path.is_file():
                self._data = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception as exc:  # 读坏了就空跑，不要让插件启动失败
            logger.warning("共享偏好读取失败，本次以空数据运行: %s", exc)
            self._data = {}

    def _flush(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self._path)
        except Exception as exc:
            logger.error("共享偏好落盘失败: %s", exc)

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, default)

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = value
            self._flush()

    # AstrBot 里这两个是 set/remove 的别名，插件两种写法都有
    set = put

    def remove(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)
            self._flush()

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._data.keys())


def _default_data_root() -> Path:
    """宿主数据根目录。由 host_server 在启动时用 config.yaml 覆写。"""
    return Path(__file__).resolve().parents[3] / "data"


sp = SharedPreferences(_default_data_root() / "shared_preferences.json")

#: 真 AstrBot 的全局配置单例。宿主启动时用 config.yaml 的内容填充。
astrbot_config: dict[str, Any] = {}


class _NullHtmlRenderer:
    """插件里只有 `logger.debug` 级别的可选调用，不实现真渲染。"""

    async def render_custom_template(self, *args: Any, **kwargs: Any) -> str:
        raise NotImplementedError("统一垫片不提供 HTML 渲染")


html_renderer = _NullHtmlRenderer()


def rebind_data_root(root: Path) -> None:
    """宿主启动时把可写根重新指向配置里的数据目录。

    两处都要改，少一处就是静默失效：

    * `sp` —— SharedPreferences 的落盘位置；
    * `astrbot_path._ROOT` —— 插件通过 `StarTools.get_data_dir()` 拿到的
      `plugin_data/<包名>`，也就是 SQLite 与 FAISS 的真实落点。

    只改前者的后果不是报错，而是 `host.data_dir` 变成一个看起来生效、
    实际只影响一个 json 文件的配置项：测试以为自己在隔离目录里跑，
    其实往生产记忆库里灌数据。
    """
    global sp
    from .utils import astrbot_path

    astrbot_path.rebind(root)
    sp = SharedPreferences(Path(root) / "shared_preferences.json")


__all__ = ["astrbot_config", "html_renderer", "logger", "rebind_data_root", "sp"]
