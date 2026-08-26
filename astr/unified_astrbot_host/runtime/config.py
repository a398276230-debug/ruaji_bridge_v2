"""runtime.config —— 读 config.yaml。

两条规则：

1. **密钥只走环境变量。** YAML 里出现的是 `api_key_env: IR_API_KEY` 这种
   *变量名*，不是密钥本身。真正取值在 `GatewayClient` 里 `os.getenv()`。
   所以这个仓库可以直接提交，不存在"忘了脱敏"的可能。
2. **`${VAR}` 与 `${VAR:-默认}` 会被展开。** 用于 base_url 这类"想覆盖但不敏感"
   的值。展开发生在解析之后、构造 GatewayClient 之前。
"""

from __future__ import annotations

import os
import re
from typing import Any

import yaml

from astrbot.core import logger

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.yaml")

_ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


def expand_env(value: Any) -> Any:
    """递归展开 `${VAR}` / `${VAR:-默认}`。

    未定义且没给默认值时保留原样并 warning —— 悄悄换成空串会让
    base_url 变成 ""，然后在第一次真实请求时才报错，那时候离原因已经很远了。
    """
    if isinstance(value, dict):
        return {k: expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_env(v) for v in value]
    if not isinstance(value, str):
        return value

    def replace(match: re.Match[str]) -> str:
        name, fallback = match.group(1), match.group(2)
        found = os.getenv(name)
        if found is not None:
            return found
        if fallback is not None:
            return fallback
        logger.warning("配置里引用了未定义的环境变量 ${%s}，保留原文", name)
        return match.group(0)

    return _ENV_REF.sub(replace, value)


def load_config(path: str | None = None) -> dict[str, Any]:
    config_path = os.path.abspath(path or DEFAULT_CONFIG_PATH)
    if not os.path.isfile(config_path):
        raise FileNotFoundError(f"找不到宿主配置: {config_path}")
    with open(config_path, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"{config_path} 的顶层必须是映射，实际是 {type(raw).__name__}")

    config = expand_env(raw)
    config.setdefault("host", {})
    config["host"].setdefault("config_path", config_path)
    _resolve_data_dir(config, os.path.dirname(config_path))
    _resolve_plugin_paths(config, os.path.dirname(config_path))
    return config


def _resolve_data_dir(config: dict[str, Any], base_dir: str) -> None:
    """`host.data_dir` 与插件路径同一套规则：相对路径相对 config.yaml。

    不按 cwd 解析，是因为 `./data` 按 cwd 解析意味着"从哪个目录敲的启动命令"
    决定了用哪个记忆库。宿主既会被 `python host_server.py` 直接拉起，
    也会被服务管理器（cwd 通常是 C:\\Windows\\system32）拉起 ——
    那种情况下记忆会静默写进一个全新的空库，表现是"机器人失忆了"。
    """
    data_dir = config["host"].get("data_dir")
    if not data_dir:
        config["host"]["data_dir"] = os.path.join(base_dir, "data")
    elif not os.path.isabs(str(data_dir)):
        config["host"]["data_dir"] = os.path.normpath(os.path.join(base_dir, str(data_dir)))


def _resolve_plugin_paths(config: dict[str, Any], base_dir: str) -> None:
    """插件路径允许写相对路径，相对于 config.yaml 所在目录。"""
    for key, entry in (config.get("plugins") or {}).items():
        if not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if path and not os.path.isabs(path):
            entry["path"] = os.path.normpath(os.path.join(base_dir, path))
        if path and not os.path.isdir(entry["path"]):
            logger.warning("插件 %s 的路径不存在: %s", key, entry["path"])


__all__ = ["DEFAULT_CONFIG_PATH", "expand_env", "load_config"]
