"""astrbot.core.star.config —— 插件配置对象。

`AstrBotConfig` 在真框架里是 dict 的子类，额外带 save_config() 与 schema。
插件把它当普通 dict 用，偶尔调 save_config()。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class AstrBotConfig(dict):
    """带落盘能力的 dict。"""

    def __init__(self, *args: Any, config_path: str | Path | None = None, schema: dict | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.config_path = str(config_path) if config_path else ""
        self.schema = schema or {}

    def save_config(self, replace_config: dict | None = None) -> None:
        if replace_config:
            self.clear()
            self.update(replace_config)
        if not self.config_path:
            return
        path = Path(self.config_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(dict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def save(self, replace_config: dict | None = None) -> None:
        """兼容别名：直接调用 save_config"""
        self.save_config(replace_config)

    @classmethod
    def from_schema(cls, schema: dict, config_path: str | Path | None = None) -> "AstrBotConfig":
        """按 _conf_schema.json 的 default 值铺一份默认配置。

        三个插件都靠这个拿到全套默认值 —— 缺字段时插件里到处是
        `config.get("x")` 返回 None 然后炸在下游，铺满默认值比逐处兜底可靠。

        必须**递归**：AstrBot 的 schema 用 `type: object` + `items` 表示嵌套，
        只铺一层的话 `config["access_control"]["whitelist_enabled"]` 会是 None，
        表现为"配置写了但功能没生效"，而且不报错。
        """
        return cls(_walk_schema(schema or {}), config_path=config_path, schema=schema)


def _walk_schema(node: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, definition in node.items():
        if not isinstance(definition, dict):
            continue
        if definition.get("type") == "object" and isinstance(definition.get("items"), dict):
            nested = _walk_schema(definition["items"])
            default = definition.get("default")
            if isinstance(default, dict):
                nested.update(default)
            out[key] = nested
        elif "default" in definition:
            out[key] = definition["default"]
        elif definition.get("type") == "list":
            out[key] = []
        elif definition.get("type") == "object":
            out[key] = {}
    return out


__all__ = ["AstrBotConfig"]
