"""plugins_mount.loader —— 把三个 AstrBot 插件装进同一个进程。

## 为什么顺序不能乱

    LivingMemory  →  SelfLearning  →  GroupChatPlus

1. **LivingMemory 必须最先注册。** SelfLearning 在 `initialize()` 里调
   `FeatureDelegation.memory_plugin()`，那个函数走
   `context.get_registered_star("LivingMemory")`。如果 LivingMemory 还没进
   star_registry，委托检测就返回 None，SelfLearning 会退回本地长期记忆 ——
   于是同一批事实在两个库里各写一份，而且两份会随时间漂移。
   这个失败是**静默**的：日志里只是少了一行 `[功能融合]`。
2. **GroupChatPlus 最后。** 它的 on_llm_request 钩子要在别人都注入完之后
   才做"差分保留第三方提示词"（main.py 的通用保留机制），顺序靠
   star_handlers_registry 的登记次序，也就是 import 次序。

## 与真 AstrBot 的一处刻意差异

真框架的 PluginManager 会为每个插件建独立的 `data/plugin_data/<name>/`，
并把 `_conf_schema.json` 的默认值和用户配置合并后传进去。垫片这里照做，
但用户配置来自宿主的 config.yaml（`plugins.<key>.config`），而不是
AstrBot 的 cmd_config.json —— 宿主只有一份配置文件，不再有第二处真相。
"""

from __future__ import annotations

import functools
import importlib
import inspect
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Any

import yaml

from astrbot.core import logger
from astrbot.core.star.config import AstrBotConfig
from astrbot.core.star.register import llm_tools
from astrbot.core.star.star import Star, StarMetadata, star_map, star_registry
from astrbot.core.star.star_handler import star_handlers_registry

#: 挂载顺序。改动前先读本模块顶部的说明。
MOUNT_ORDER = ("living_memory", "self_learning", "group_chat_plus")


@dataclass
class MountSpec:
    """一个插件该怎么挂。"""

    key: str
    """宿主内部的短名（config.yaml 里的键）"""
    package: str
    """Python 包名，例如 astrbot_plugin_livingmemory"""
    path: str
    """插件目录的绝对路径"""
    entry: str = "main"
    """入口模块名。

    AstrBot 的约定是 `main.py`，框架自己也是 `__import__("data.plugins.<name>.main")`。
    这一层不能省：LivingMemory 与 GCP 连 `__init__.py` 都没有（命名空间包），
    只导入包名的话拿到的是个空模块，`_find_star_class` 自然什么也找不到。
    """
    config_overrides: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True

    @property
    def entry_module(self) -> str:
        return f"{self.package}.{self.entry}" if self.entry else self.package


@dataclass
class PluginMount:
    """挂载完成后的产物。"""

    spec: MountSpec
    metadata: StarMetadata
    instance: Star
    config: AstrBotConfig

    @property
    def name(self) -> str:
        return self.metadata.name or self.spec.package

    @property
    def initialized(self) -> bool:
        """插件是否已自认就绪。

        三个插件的就绪信号各不相同，所以这里按具体字段判断而不是笼统返回 True ——
        /health 的分层就绪要靠它，笼统返回 True 会让"没跑起来"看着像"跑起来了"。
        """
        inst = self.instance
        initializer = getattr(inst, "initializer", None)
        if initializer is not None:
            return bool(getattr(initializer, "is_initialized", False))
        for attr in ("_initialized", "is_initialized", "initialized"):
            if hasattr(inst, attr):
                return bool(getattr(inst, attr))
        return True


# ======================================================================
# 配置
# ======================================================================


def load_conf_defaults(plugin_dir: str) -> dict[str, Any]:
    """把 `_conf_schema.json` 摊平成一份默认配置。

    递归展开由 AstrBotConfig.from_schema 负责（那里说明了为什么必须递归）。
    """
    schema = read_conf_schema(plugin_dir)
    return dict(AstrBotConfig.from_schema(schema))


def read_conf_schema(plugin_dir: str) -> dict[str, Any]:
    schema_path = os.path.join(plugin_dir, "_conf_schema.json")
    if not os.path.isfile(schema_path):
        return {}
    try:
        with open(schema_path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("读取 %s 失败，使用空配置: %s", schema_path, exc)
        return {}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _read_metadata_yaml(plugin_dir: str) -> dict[str, Any]:
    path = os.path.join(plugin_dir, "metadata.yaml")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except (OSError, yaml.YAMLError) as exc:
        logger.warning("读取 %s 失败: %s", path, exc)
        return {}


# ======================================================================
# 挂载
# ======================================================================


def _ensure_importable(plugin_dir: str) -> None:
    """把插件目录的父路径放进 sys.path 最前面。"""
    parent = os.path.dirname(os.path.abspath(plugin_dir))
    if parent not in sys.path:
        sys.path.insert(0, parent)


def _find_star_class(module: Any) -> type[Star]:
    """在插件模块里找出那个 Star 子类。

    不能只信 `@register` —— SelfLearning 根本没写那个装饰器（它的元数据全在
    metadata.yaml 里），真 AstrBot 也是靠"扫模块找 Star 子类"兜底的。
    """
    candidates = [
        obj
        for _, obj in inspect.getmembers(module, inspect.isclass)
        if issubclass(obj, Star) and obj is not Star and obj.__module__ == module.__name__
    ]
    if not candidates:
        # 有些插件把 Star 子类定义在子模块里再 import 进 main
        candidates = [
            obj
            for _, obj in inspect.getmembers(module, inspect.isclass)
            if issubclass(obj, Star) and obj is not Star
        ]
    if not candidates:
        raise RuntimeError(f"{module.__name__} 里找不到 Star 子类")
    if len(candidates) > 1:
        logger.warning(
            "%s 里有多个 Star 子类 %s，取第一个",
            module.__name__,
            [c.__name__ for c in candidates],
        )
    return candidates[0]


def _register_metadata(
    module_name: str,
    star_cls: type[Star],
    spec: MountSpec,
    meta_yaml: dict[str, Any],
) -> StarMetadata:
    """确保 star_registry 里有这个插件的条目，并补齐匹配用的字段。

    `@register` 装饰器已经建过条目的（GCP / LivingMemory）就补字段；
    没有的（SelfLearning）在这里新建。四个字段都要填 ——
    FeatureDelegation 会拿 name / display_name / root_dir_name / module_path
    逐个去撞，缺一个就少一条命中路径。
    """
    metadata = star_map.get(module_name)
    if metadata is None:
        # 装饰器登记的 module_path 是定义 Star 子类的那个模块，可能是 main 的子模块
        metadata = star_map.get(star_cls.__module__)
    if metadata is None:
        metadata = StarMetadata(module_path=module_name)
        star_map[module_name] = metadata
        star_registry.append(metadata)

    metadata.name = metadata.name or meta_yaml.get("name") or spec.package
    metadata.display_name = metadata.display_name or meta_yaml.get("display_name") or metadata.name
    metadata.author = metadata.author or meta_yaml.get("author")
    metadata.desc = metadata.desc or meta_yaml.get("desc") or meta_yaml.get("description")
    metadata.version = metadata.version or str(meta_yaml.get("version") or "")
    metadata.repo = metadata.repo or meta_yaml.get("repo")
    metadata.root_dir_name = spec.package
    metadata.star_cls_type = star_cls
    metadata.activated = True
    if not metadata.module_path:
        metadata.module_path = module_name
    return metadata


def mount_one(context: Any, spec: MountSpec) -> PluginMount:
    """挂载一个插件：import → 建配置 → 实例化 → 登记。

    不吞异常。一个插件挂不上就该让宿主启动失败并说清是谁 ——
    带着两个插件"半跑"起来，比干脆起不来更难查。
    """
    if not os.path.isdir(spec.path):
        raise FileNotFoundError(f"插件目录不存在: {spec.path}")

    _ensure_importable(spec.path)
    module = importlib.import_module(spec.entry_module)

    meta_yaml = _read_metadata_yaml(spec.path)
    defaults = load_conf_defaults(spec.path)
    merged = _deep_merge(defaults, spec.config_overrides)

    from astrbot.core.utils.astrbot_path import get_astrbot_config_path, get_astrbot_plugin_data_path

    data_dir = os.path.join(get_astrbot_plugin_data_path(), spec.package)
    os.makedirs(data_dir, exist_ok=True)

    # 精准加载插件唯一持久化配置 (data/plugin_data/{pkg}/config.json)
    candidate_cfg = os.path.join(data_dir, "config.json")
    if os.path.isfile(candidate_cfg):
        try:
            with open(candidate_cfg, "r", encoding="utf-8-sig") as fh:
                saved_json = json.load(fh)
                merged = _deep_merge(merged, saved_json)
                logger.debug("已合并持久化配置: %s", candidate_cfg)
        except Exception as exc:
            logger.warning("读取已持久化配置 %s 失败: %s", candidate_cfg, exc)
    config = AstrBotConfig(
        merged,
        config_path=os.path.join(data_dir, "config.json"),
        schema=read_conf_schema(spec.path),
    )

    star_cls = _find_star_class(module)
    metadata = _register_metadata(spec.entry_module, star_cls, spec, meta_yaml)
    metadata.module = module
    metadata.config = config

    instance = _instantiate(star_cls, context, config)

    # 关键一步：FeatureDelegation._is_active_star 要求 star_cls 非 None，
    # graph_service 也是从 star.star_cls 摸到 memory_engine 的。
    metadata.star_cls = instance

    bound = bind_handlers(metadata.module_path or spec.entry_module, instance)

    logger.info(
        "已挂载插件 %s (%s) v%s | 绑定 handler %d 个",
        metadata.name,
        spec.package,
        metadata.version or "?",
        bound,
    )
    return PluginMount(spec=spec, metadata=metadata, instance=instance, config=config)


def bind_handlers(module_path: str, instance: Star) -> int:
    """把导入期登记的**未绑定函数**换成绑到实例上的可调用对象。

    装饰器是在类体里执行的，那时候还没有实例，所以 star_handlers_registry 里
    存的是 `def handle_memory_recall(self, event, req)` 这个裸函数。宿主调用时
    只传 (event, req)，`self` 位就被 event 顶掉了 —— 症状是插件里
    `self.event_handler` 变成 AstrMessageEvent，然后 AttributeError，
    而且报错位置在插件内部，看不出根因在宿主。

    绑定方式与上游一致（star_manager.py:1261）：`functools.partial(raw, instance)`，
    并且**先解包已有的 partial** 使其可重复执行 —— 热重载会再走一遍，
    不解包就会叠成 partial(partial(f, old), new)，把旧实例一直钉在内存里。
    """
    count = 0
    for handler in star_handlers_registry.get_handlers_by_module_name(module_path):
        raw = handler.handler.func if isinstance(handler.handler, functools.partial) else handler.handler
        if raw is None:
            continue
        handler.handler = functools.partial(raw, instance)
        count += 1

    # LLM 工具走另一张表（register.llm_tools），同样需要绑定，
    # 否则 recall_long_term_memory 这类 @filter.llm_tool 一调用就崩。
    for entry in llm_tools.values():
        raw = entry.get("handler")
        raw = raw.func if isinstance(raw, functools.partial) else raw
        if raw is None:
            continue
        owner = str(entry.get("handler_module_path") or getattr(raw, "__module__", ""))
        if owner == module_path or owner.startswith(module_path.rsplit(".", 1)[0] + "."):
            entry["handler"] = functools.partial(raw, instance)
            count += 1

    return count


def _instantiate(star_cls: type[Star], context: Any, config: AstrBotConfig) -> Star:
    """按签名调构造函数。

    三个插件的签名各不相同（`(context, config)`、`(context, config=None)`、
    `(context, config: dict)`），还有些老插件只收 context。按参数名探测，
    别硬编码。
    """
    params = inspect.signature(star_cls.__init__).parameters
    if "config" in params:
        return star_cls(context, config)
    return star_cls(context)


def mount_all(
    context: Any,
    specs: dict[str, MountSpec],
    order: tuple[str, ...] = MOUNT_ORDER,
) -> dict[str, PluginMount]:
    """按 MOUNT_ORDER 依次挂载。"""
    mounts: dict[str, PluginMount] = {}
    for key in order:
        spec = specs.get(key)
        if spec is None:
            logger.warning("config.yaml 里没有插件 %s 的配置，跳过", key)
            continue
        if not spec.enabled:
            logger.info("插件 %s 被配置为 enabled: false，跳过挂载", key)
            continue
        mounts[key] = mount_one(context, spec)
    # 配置里出现了但不在 MOUNT_ORDER 中的，最后挂，并明确说一声
    for key, spec in specs.items():
        if key in mounts or key in order or not spec.enabled:
            continue
        logger.warning("插件 %s 不在 MOUNT_ORDER 中，挂载顺序无保证", key)
        mounts[key] = mount_one(context, spec)
    return mounts


__all__ = [
    "MOUNT_ORDER",
    "bind_handlers",
    "MountSpec",
    "PluginMount",
    "load_conf_defaults",
    "mount_all",
    "mount_one",
]
