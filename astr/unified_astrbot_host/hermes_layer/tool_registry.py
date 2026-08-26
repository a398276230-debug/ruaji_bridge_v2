"""hermes_layer.tool_registry —— 导出给 Hermes Agent 的工具集。

记忆检索/写入、知识图谱、社区黑话，外加一整套 OneBot 面（群文件、历史消息、
群成员、转发、戳一戳、语音）。`ToolRegistry.names` 是权威清单 —— 别在文档里
手抄一份数量，抄了就会漂。

## 边界

Hermes Agent 在**另一个进程**里（F:\\hermes-agent）。它通过 HTTP 调这些
工具，能收到的只有纯 JSON —— 没有 AstrMessageEvent、没有 ContextWrapper、
没有会话。这决定了本模块不能直接复用插件自带的 FunctionTool：
`MemorySearchTool.call()` 的第一个参数是 `ContextWrapper[AstrAgentContext]`，
函数体第一件事就是 `context.context.event`，拿它去过
`is_event_memory_allowed(config_manager, event)`。伪造一个 event 骗过这条链
在技术上可行，但那等于让权限检查跑在一个我们自己捏的对象上 —— 通过与否
都不说明任何事。

所以这里直接调引擎，并把插件那层检查**换成**显式的作用域解析
（`_scope()` / `_persona()`，读的还是 LivingMemory 自己的 filtering_settings）。
检查点摆在明面上，可以被测试直接断言。

## 作用域这件事必须说清

LivingMemory 默认按 session 隔离记忆（`memory_scope_mode: legacy` +
`use_session_filtering: true` → 作用域 = `unified_msg_origin`）。Hermes 没有
session，于是：

    memory_scope_mode == "global"  →  与群聊共用 `livingmemory:global`。
                                      这是唯一能让"群里学到的"与"Hermes 记的"
                                      互相看得见的模式。
    其它模式                        →  不加 session 过滤。读能读到全部，
                                      写落在 NULL 作用域上 —— 群聊那条按会话
                                      过滤的检索**看不到** Hermes 写的记忆。

后者不是缺陷，是那几种模式本来的语义。要跨面共享就得切 global，
所以宿主 config.yaml 里把它显式设成了 global。

## 不抛异常

每个 handler 一律返回 `{"ok": bool, ...}`，失败变成 `error` 字段。跨进程的
调用方是个 LLM：它读得懂 `"living_memory_unavailable"`，读不懂 HTTP 500。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from astrbot.core import logger

#: 清单协议版本。Hermes 侧按这个值判断拿到的 manifest 能不能直接用。
MANIFEST_VERSION = 1

#: 与 astrbot_plugin_livingmemory/core/memory_scope.py:8 同值。
#: 优先从插件导入（见 `_global_scope()`），导不到才用这个字面量兜底 ——
#: 硬编码一个别人的常量迟早会漂移，但"插件没挂载"时也得能回答问题。
GLOBAL_MEMORY_SCOPE_FALLBACK = "livingmemory:global"

#: memorize 的 category 白名单。越界不报错，退回 factual 并在返回里说明。
MEMORY_CATEGORIES = ("factual", "event", "preference", "relationship", "skill")

#: 图查询的三个上限。聊天图谱的度数很高，不设限一次 2 跳就能把半张图捞回来，
#: 而调用方是个有上下文预算的 LLM。
GRAPH_SEED_LIMIT = 8
GRAPH_ENTRY_LIMIT = 40
GRAPH_NEIGHBOR_LIMIT = 60
GRAPH_MEMORY_LIMIT = 24
GRAPH_MAX_HOPS = 3


@dataclass
class HermesTool:
    """一件可被 Hermes Agent 调用的工具。"""

    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Awaitable[dict[str, Any]]]
    requires: tuple[str, ...] = ()
    """依赖哪些插件就位。清单里如实写出来，Hermes 侧能提前知道
    "这件工具现在可能不可用"，而不是等调用失败才发现。"""

    def to_manifest(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "requires": list(self.requires),
        }


class ToolRegistry:
    """工具注册表。宿主启动时建一个，`/api/v1/tools/*` 用它。"""

    def __init__(self, unified: Any) -> None:
        self._unified = unified
        self._tools: dict[str, HermesTool] = {t.name: t for t in self._build()}

    # ------------------------------------------------------------------
    # 对外
    # ------------------------------------------------------------------

    @property
    def names(self) -> list[str]:
        return list(self._tools)

    def tools(self) -> list[HermesTool]:
        return list(self._tools.values())

    def manifest(self) -> dict[str, Any]:
        server = self._unified.config.get("server") or {}
        host = str(server.get("host") or "127.0.0.1")
        port = int(server.get("port") or 8870)
        return {
            "version": MANIFEST_VERSION,
            "source": "unified_astrbot_host",
            "endpoint": f"http://{host}:{port}/api/v1/tools/call",
            "shadowMode": bool((self._unified.config.get("host") or {}).get("shadow_mode", True)),
            "memoryScope": self._scope() or "(不过滤 session)",
            "tools": [t.to_manifest() for t in self._tools.values()],
        }

    def export(self, directory: str | None = None, filename: str | None = None) -> str | None:
        """把清单写到 Hermes Agent 目录。

        `export_enabled: false` 时返回 None 而不是静默写盘 —— 写别人家的目录
        是个副作用，得由配置显式许可。
        """
        cfg = self._unified.config.get("hermes") or {}
        if not cfg.get("export_enabled", False) and directory is None:
            logger.info("hermes.export_enabled 为 false，跳过工具清单导出")
            return None

        target_dir = os.path.abspath(str(directory or cfg.get("export_dir") or ""))
        if not target_dir:
            logger.warning("未配置 hermes.export_dir，跳过工具清单导出")
            return None
        if not os.path.isdir(target_dir):
            # 不自动 makedirs：目录不存在通常意味着路径写错了，
            # 建出一个空目录只会让人以为导出成功了。
            logger.warning("Hermes 目录不存在，跳过导出: %s", target_dir)
            return None

        path = os.path.join(target_dir, str(filename or cfg.get("tools_manifest") or "unified_host_tools.json"))
        payload = json.dumps(self.manifest(), ensure_ascii=False, indent=2)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
        logger.info("已导出 %d 件工具到 %s", len(self._tools), path)
        return path

    async def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """按名字调用。异常一律转成 error 字段，不向外抛。"""
        tool = self._tools.get(name)
        if tool is None:
            return {
                "ok": False,
                "error": "unknown_tool",
                "message": f"没有名为 {name} 的工具",
                "available": self.names,
            }

        started = time.perf_counter()
        try:
            result = await tool.handler(**(arguments or {}))
        except TypeError as exc:
            # 参数名/个数不对。这是调用方能自己修的错误，要把签名回给它。
            return {
                "ok": False,
                "error": "bad_arguments",
                "message": str(exc),
                "parameters": tool.parameters,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            }
        except Exception as exc:  # noqa: BLE001 —— 见模块文档："不抛异常"
            logger.exception("Hermes 工具 %s 执行失败", name)
            return {
                "ok": False,
                "error": "internal_error",
                "message": f"{type(exc).__name__}: {exc}",
                "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
            }

        result.setdefault("ok", True)
        result["tool"] = name
        result["elapsedMs"] = round((time.perf_counter() - started) * 1000, 2)
        return result

    # ------------------------------------------------------------------
    # 依赖解析
    # ------------------------------------------------------------------

    def _memory_engine(self) -> Any | None:
        return self._unified.memory_engine()

    def _graph_store(self) -> Any | None:
        return self._unified.graph_store()

    def _memory_processor(self) -> Any | None:
        """LivingMemory 的 MemoryProcessor。

        拿到它是为了让 Hermes 写入的记忆与插件自己写的**形状一致**
        （content = summary|key_facts，metadata 带 canonical_summary /
        persona_summary / summary_schema_version）。形状不一致的后果不是报错，
        而是面板上这条记忆缺字段、图抽取读不到 canonical_summary ——
        一种只在事后翻数据时才会发现的问题。
        """
        plugin = self._unified.plugin("living_memory")
        if plugin is None:
            return None
        initializer = getattr(plugin, "initializer", None)
        processor = getattr(initializer, "memory_processor", None) if initializer else None
        return processor or getattr(plugin, "memory_processor", None)

    def _db_manager(self) -> Any | None:
        """SelfLearning 的数据库管理器（黑话表在它后面）。"""
        plugin = self._unified.plugin("self_learning")
        return getattr(plugin, "db_manager", None) if plugin else None

    def _filtering(self) -> dict[str, Any]:
        mount = self._unified.mounts.get("living_memory")
        if mount is None:
            return {}
        return dict(mount.config.get("filtering_settings") or {})

    @staticmethod
    def _global_scope() -> str:
        try:
            from astrbot_plugin_livingmemory.core.memory_scope import GLOBAL_MEMORY_SCOPE

            return str(GLOBAL_MEMORY_SCOPE)
        except Exception:  # noqa: BLE001 —— 插件未挂载时用兜底值，见常量注释
            return GLOBAL_MEMORY_SCOPE_FALLBACK

    def _scope(self) -> str | None:
        """Hermes 侧读写用哪个 session 作用域。语义见模块文档。"""
        mode = str(self._filtering().get("memory_scope_mode") or "legacy").strip().lower()
        return self._global_scope() if mode == "global" else None

    async def _persona(self) -> str | None:
        """当前人格 ID。

        取值方式必须与 LivingMemory 自己的 `get_persona_id()`
        （core/utils/__init__.py:176）一致 —— 那里最终落到
        `persona_manager.get_default_persona_v3()["name"]`。取法不一致的话，
        `use_persona_filtering` 打开时 Hermes 写进去的记忆群聊检索不到，
        反之亦然，而且两边都不会报错。
        """
        if not self._filtering().get("use_persona_filtering", True):
            return None
        pm = getattr(self._unified.context, "persona_manager", None)
        if pm is None:
            return None
        try:
            persona = await pm.get_default_persona_v3()
        except Exception as exc:  # noqa: BLE001
            logger.debug("取默认人格失败，本次不按人格过滤: %s", exc)
            return None
        if not persona:
            return None
        return str(persona.get("name") or "") or None

    # ------------------------------------------------------------------
    # 工具定义
    # ------------------------------------------------------------------

    def _build(self) -> list[HermesTool]:
        return [
            HermesTool(
                name="recall_long_term_memory",
                description=(
                    "检索瑞姬的长期记忆。当前上下文不足、需要回忆此前的事实/偏好/"
                    "约定，或消歧代词指向时调用。query 用简短的关键词而不是整句原文。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "召回关键词。优先用实体、话题、偏好、承诺、过往事件，不要复制整段用户输入。",
                        },
                        "target_user_id": {
                            "type": "string",
                            "description": "可选。想回忆的对象 QQ 号。这是检索提示（会偏向提到此人的记忆），不是硬过滤。",
                            "default": "",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "返回条数上限，1-20，默认 5。",
                            "default": 5,
                        },
                    },
                    "required": ["query"],
                },
                handler=self._recall_long_term_memory,
                requires=("living_memory",),
            ),
            HermesTool(
                name="memorize_long_term_memory",
                description=(
                    "写入一条长期记忆。用户明确要求记住，或出现了稳定的偏好、身份信息、"
                    "约定、项目背景时调用。写精炼的事实，不要把整段对话塞进来。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "要记住的事实，精炼成一句话。",
                        },
                        "category": {
                            "type": "string",
                            "description": "记忆类别。",
                            "enum": list(MEMORY_CATEGORIES),
                            "default": "factual",
                        },
                        "target_user_id": {
                            "type": "string",
                            "description": "可选。这条记忆关于谁（QQ 号）。会写进 metadata 并作为可检索的 key_fact。",
                            "default": "",
                        },
                    },
                    "required": ["content"],
                },
                handler=self._memorize_long_term_memory,
                requires=("living_memory",),
            ),
            HermesTool(
                name="query_knowledge_graph",
                description=(
                    "查知识图谱：给一个实体（人、物、话题），返回它在群聊记忆里的关系网络"
                    "与相关事实陈述。适合回答「A 和 B 是什么关系」、「关于 X 我们都知道什么」。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "entity": {
                            "type": "string",
                            "description": "实体名。人名、昵称、物品、话题都可以。",
                        },
                        "depth": {
                            "type": "integer",
                            "description": f"扩展跳数，1-{GRAPH_MAX_HOPS}，默认 2。跳数越大越发散。",
                            "default": 2,
                        },
                    },
                    "required": ["entity"],
                },
                handler=self._query_knowledge_graph,
                requires=("living_memory",),
            ),
            HermesTool(
                name="query_community_jargon",
                description=(
                    "查群黑话。遇到看不懂的群内梗、缩写、自造词时调用，返回推断出的含义、"
                    "出现次数与真实使用语境。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "word": {
                            "type": "string",
                            "description": "要查的词。",
                        },
                    },
                    "required": ["word"],
                },
                handler=self._query_community_jargon,
                requires=("self_learning",),
            ),
            HermesTool(
                name="list_group_files",
                description=(
                    "查看 QQ 群文件列表（根目录或指定子文件夹）。返回群文件的文件名、大小、"
                    "上传者、上传时间及 file_id。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                        "folder_id": {
                            "type": "string",
                            "description": "可选。子文件夹 ID。不传则查询根目录。",
                            "default": "",
                        },
                    },
                    "required": ["group_id"],
                },
                handler=self._list_group_files,
            ),
            HermesTool(
                name="download_group_file",
                description=(
                    "下载指定的 QQ 群文件到本地 received_files 目录，并返回绝对路径供读取和分析。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "QQ 群号。",
                        },
                        "file_id": {
                            "type": "string",
                            "description": "群文件 ID（从 list_group_files 获取）。",
                        },
                        "busid": {
                            "type": "integer",
                            "description": "文件 busid，默认 102。",
                            "default": 102,
                        },
                        "file_name": {
                            "type": "string",
                            "description": "可选。期望保存的文件名。",
                            "default": "",
                        },
                    },
                    "required": ["group_id", "file_id"],
                },
                handler=self._download_group_file,
            ),
            HermesTool(
                name="upload_group_file",
                description=(
                    "将本地文件上传到指定 QQ 群的群文件中。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                        "file_path": {
                            "type": "string",
                            "description": "本地文件的绝对路径。",
                        },
                        "name": {
                            "type": "string",
                            "description": "可选。上传后在群文件中显示的文件名（默认取本地文件名）。",
                            "default": "",
                        },
                        "folder_id": {
                            "type": "string",
                            "description": "可选。目标群文件夹 ID（不填则传到根目录）。",
                            "default": "",
                        },
                    },
                    "required": ["group_id", "file_path"],
                },
                handler=self._upload_group_file,
            ),
            HermesTool(
                name="download_url_file",
                description=(
                    "通过底层协议端或直接下载网络直链文件 / 闪传文件到本地 received_files 缓存。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "可选。文件的网络直链 URL。",
                            "default": "",
                        },
                        "name": {
                            "type": "string",
                            "description": "可选。保存的文件名。",
                            "default": "",
                        },
                        "share_link": {
                            "type": "string",
                            "description": "可选。闪传文件链接（share_link）。",
                            "default": "",
                        },
                    },
                },
                handler=self._download_url_file,
            ),
            HermesTool(
                name="fetch_chat_history",
                description=(
                    "翻查指定 QQ 群聊或私聊的真实历史消息记录。用于还原此前对话上下文、"
                    "查找某人刚才说了什么。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "可选。群号（查群聊历史时必填）。",
                            "default": "",
                        },
                        "user_id": {
                            "type": "string",
                            "description": "可选。用户 QQ 号（查私聊历史时必填）。",
                            "default": "",
                        },
                        "count": {
                            "type": "integer",
                            "description": "拉取的历史消息条数，默认 20，最大 50。",
                            "default": 20,
                        },
                    },
                },
                handler=self._fetch_chat_history,
            ),
            HermesTool(
                name="get_forward_messages",
                description=(
                    "解包并读取合并转发消息（聊天记录包）的具体内容。需要提供消息 ID (message_id)。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "message_id": {
                            "type": "string",
                            "description": "合并转发消息的 message_id。",
                        },
                    },
                    "required": ["message_id"],
                },
                handler=self._get_forward_messages,
            ),
            HermesTool(
                name="voice_to_text",
                description=(
                    "使用 QQ 官方原生接口将指定的语音消息转换为文字。需要提供语音消息的 message_id。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "message_id": {
                            "type": "string",
                            "description": "语音消息的 message_id。",
                        },
                    },
                    "required": ["message_id"],
                },
                handler=self._voice_to_text,
            ),
            HermesTool(
                name="send_poke",
                description=(
                    "在群内或私聊中向指定用户发送戳一戳（双击头像互动）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "可选。群聊中戳人时填群号。",
                            "default": "",
                        },
                        "user_id": {
                            "type": "string",
                            "description": "目标用户的 QQ 号。",
                        },
                    },
                    "required": ["user_id"],
                },
                handler=self._send_poke,
            ),
            HermesTool(
                name="get_group_file_system_info",
                description=(
                    "查询指定 QQ 群的文件系统容量与统计信息（文件总数、空间上限、已用空间）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                    },
                    "required": ["group_id"],
                },
                handler=self._get_group_file_system_info,
            ),
            HermesTool(
                name="upload_private_file",
                description=(
                    "将本地文件通过私聊发送给指定好友（如发送生成的报告、音频、代码文件）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "user_id": {
                            "type": "string",
                            "description": "目标用户的 QQ 号。",
                        },
                        "file_path": {
                            "type": "string",
                            "description": "本地文件的绝对路径。",
                        },
                        "name": {
                            "type": "string",
                            "description": "可选。私聊窗口显示的文件名（默认取本地文件名）。",
                            "default": "",
                        },
                    },
                    "required": ["user_id", "file_path"],
                },
                handler=self._upload_private_file,
            ),
            HermesTool(
                name="get_image_detail",
                description=(
                    "获取消息中图片的本地缓存绝对路径或高清下载直链。需要提供图片的 file 标识。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "file": {
                            "type": "string",
                            "description": "图片的 file 标识（如 CQ 码中的 file=... 或文件名）。",
                        },
                    },
                    "required": ["file"],
                },
                handler=self._get_image_detail,
            ),
            HermesTool(
                name="download_chat_file",
                description=(
                    "让 QQ 客户端在后台静默下载消息中的文件并返回本地绝对路径。需要提供文件的 file 标识。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "file": {
                            "type": "string",
                            "description": "文件的 file 标识（如 CQ 码中的 file=... 或 file_id）。",
                        },
                    },
                    "required": ["file"],
                },
                handler=self._download_chat_file,
            ),
            HermesTool(
                name="convert_voice_to_mp3",
                description=(
                    "将消息中的语音（腾讯专有 silk 格式）在协议端自动转码为标准 MP3 并返回本地文件路径。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "file": {
                            "type": "string",
                            "description": "语音消息的 file 标识。",
                        },
                    },
                    "required": ["file"],
                },
                handler=self._convert_voice_to_mp3,
            ),
            HermesTool(
                name="list_joined_groups",
                description=(
                    "获取机器人当前加入的所有 QQ 群列表（包含群号 group_id、群名称 group_name、"
                    "成员总数、群主 QQ 等）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "no_cache": {
                            "type": "boolean",
                            "description": "是否强制刷新缓存，默认 false。",
                            "default": False,
                        },
                    },
                },
                handler=self._list_joined_groups,
            ),
            HermesTool(
                name="get_group_info",
                description=(
                    "获取指定 QQ 群的详细资料（群名称、公告 memo、创建时间、成员数与上限、群主等）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                    },
                    "required": ["group_id"],
                },
                handler=self._get_group_info,
            ),
            HermesTool(
                name="list_group_members",
                description=(
                    "获取指定 QQ 群的完整群成员列表（每个群员的 QQ、昵称、群名片 card、"
                    "角色 role（owner/admin/member）、专属头衔 title 等）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                        "no_cache": {
                            "type": "boolean",
                            "description": "是否强制刷新缓存，默认 false。",
                            "default": False,
                        },
                    },
                    "required": ["group_id"],
                },
                handler=self._list_group_members,
            ),
            HermesTool(
                name="get_group_member_info",
                description=(
                    "获取指定 QQ 群里某个具体群成员的详细资料（群名片、角色身份、头衔、禁言状态等）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                        "user_id": {
                            "type": "string",
                            "description": "目标群成员的 QQ 号。",
                        },
                        "no_cache": {
                            "type": "boolean",
                            "description": "是否强制刷新缓存，默认 false。",
                            "default": False,
                        },
                    },
                    "required": ["group_id", "user_id"],
                },
                handler=self._get_group_member_info,
            ),
            HermesTool(
                name="get_message_detail",
                description=(
                    "精确查询单条消息的原始详情（发送者昵称、真实卡片、原始图片直链、"
                    "CQ码与时间戳）。需要提供消息 ID (message_id)。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "message_id": {
                            "type": "string",
                            "description": "消息 ID。",
                        },
                    },
                    "required": ["message_id"],
                },
                handler=self._get_message_detail,
            ),
            HermesTool(
                name="forward_message",
                description=(
                    "以 QQ 原生消息卡片形式，将某条指定消息转发到目标群聊或私聊好友中。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "message_id": {
                            "type": "string",
                            "description": "要转发的消息 ID。",
                        },
                        "target_group_id": {
                            "type": "string",
                            "description": "可选。转发目标群号（群聊转发时填）。",
                            "default": "",
                        },
                        "target_user_id": {
                            "type": "string",
                            "description": "可选。转发目标好友 QQ 号（私聊转发时填）。",
                            "default": "",
                        },
                    },
                    "required": ["message_id"],
                },
                handler=self._forward_message,
            ),
            HermesTool(
                name="get_ai_characters",
                description=(
                    "获取群 AI 语音可用的声色列表（如酥心御姐、元气少女、傲娇少女、小新、四郎等）。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                    },
                    "required": ["group_id"],
                },
                handler=self._get_ai_characters,
            ),
            HermesTool(
                name="send_group_ai_record",
                description=(
                    "在指定群聊中，以指定的 AI 声色生成语音条并直接发送到群里。"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "group_id": {
                            "type": "string",
                            "description": "目标 QQ 群号。",
                        },
                        "character": {
                            "type": "string",
                            "description": "声色 ID（如 lucy-voice-suxinjiejie、lucy-voice-xueling、lucy-voice-f38 等，从 get_ai_characters 获取）。",
                        },
                        "text": {
                            "type": "string",
                            "description": "要转成语音发送的文本内容。",
                        },
                    },
                    "required": ["group_id", "character", "text"],
                },
                handler=self._send_group_ai_record,
            ),
        ]

    # ---------- 1. 召回 ----------

    async def _recall_long_term_memory(
        self,
        query: str,
        target_user_id: str = "",
        limit: int = 5,
    ) -> dict[str, Any]:
        cleaned = str(query or "").strip()
        if not cleaned:
            return {"ok": False, "error": "empty_query", "results": [], "count": 0}

        engine = self._memory_engine()
        if engine is None:
            return {
                "ok": False,
                "error": "living_memory_unavailable",
                "message": "LivingMemory 未挂载或尚未完成异步初始化",
                "results": [],
                "count": 0,
            }

        k = max(1, min(_as_int(limit, 5), 20))
        target = str(target_user_id or "").strip()

        # target 拼进检索串而不是当过滤器：LivingMemory 按 session 而不是按 user
        # 分作用域，没有"某人的记忆"这个维度可过滤。拼进 query 能让 BM25 那一路
        # 命中提到此人的条目，是**偏向**而不是**限定** —— 返回里用
        # targetIsHint / mentionsTarget 把这件事说明白，免得调用方以为是隔离。
        search_query = f"{cleaned} {target}".strip() if target else cleaned
        scope = self._scope()
        persona = await self._persona()

        results = await engine.search_memories(
            query=search_query,
            k=k,
            session_id=scope,
            persona_id=persona,
        )

        items: list[dict[str, Any]] = []
        for result in results or []:
            content = str(getattr(result, "content", "") or "")
            metadata = dict(getattr(result, "metadata", None) or {})
            haystack = content + json.dumps(metadata, ensure_ascii=False, default=str)
            items.append(
                {
                    "id": _as_int(getattr(result, "doc_id", 0), 0),
                    "content": content,
                    "score": round(_as_float(getattr(result, "final_score", 0.0), 0.0), 4),
                    "importance": metadata.get("importance"),
                    "createTime": metadata.get("create_time"),
                    "topics": metadata.get("topics") or [],
                    "mentionsTarget": bool(target) and target in haystack,
                }
            )

        return {
            "ok": True,
            "query": cleaned,
            "count": len(items),
            "results": items,
            "scope": scope,
            "personaId": persona,
            "targetUserId": target,
            "targetIsHint": bool(target),
        }

    # ---------- 2. 写入 ----------

    async def _memorize_long_term_memory(
        self,
        content: str,
        category: str = "factual",
        target_user_id: str = "",
    ) -> dict[str, Any]:
        text = str(content or "").strip()
        if not text:
            return {"ok": False, "error": "empty_content", "memorized": False}

        engine = self._memory_engine()
        if engine is None:
            return {
                "ok": False,
                "error": "living_memory_unavailable",
                "message": "LivingMemory 未挂载或尚未完成异步初始化",
                "memorized": False,
            }

        raw_category = str(category or "").strip().lower()
        cat = raw_category if raw_category in MEMORY_CATEGORIES else "factual"
        target = str(target_user_id or "").strip()

        # 关联用户写成 key_fact 而不是只塞 metadata：content 是 BM25/FAISS 的
        # 索引语料，metadata 不进索引。只写 metadata 的话，"关于张三的事"
        # 这种召回永远命中不到这条。
        key_facts = [f"关联用户: {target}"] if target else []
        structured = {
            "summary": text,
            "topics": [cat],
            "key_facts": key_facts,
            "sentiment": "neutral",
            "importance": 0.7,
        }

        processor = self._memory_processor()
        if processor is not None and hasattr(processor, "build_memory_from_structured_data"):
            stored, metadata, importance = processor.build_memory_from_structured_data(
                structured_data=structured,
                # Hermes 是一对一通道，不是群聊
                is_group_chat=False,
                fallback_excerpt=text,
            )
        else:
            # 拿不到 processor 也要能写。字段照 memory_processor_build.py:54
            # 的形状手搓一份，缺 processor 时至少不缺字段。
            stored = " | ".join([text, "；".join(key_facts)]) if key_facts else text
            metadata = {
                "topics": [cat],
                "key_facts": key_facts,
                "sentiment": "neutral",
                "interaction_type": "private_chat",
                "canonical_summary": stored,
                "persona_summary": text,
                "summary_schema_version": "v2",
            }
            importance = 0.7
            logger.warning("拿不到 MemoryProcessor，本次用兜底 metadata 写入记忆")

        scope = self._scope()
        metadata["memory_origin"] = "hermes_tool"
        metadata["memory_category"] = cat
        metadata["source_session_id"] = scope or ""
        metadata["source_window"] = {
            "session_id": scope or "",
            "triggered_by": "hermes_agent",
            "tool_name": "memorize_long_term_memory",
        }
        if target:
            metadata["target_user_id"] = target

        persona = await self._persona()
        memory_id = await engine.add_memory(
            content=stored,
            session_id=scope,
            persona_id=persona,
            importance=importance,
            metadata=metadata,
        )

        payload: dict[str, Any] = {
            "ok": True,
            "memorized": True,
            "id": _as_int(memory_id, 0),
            "content": stored,
            "category": cat,
            "importance": round(_as_float(importance, 0.7), 3),
            "scope": scope,
            "personaId": persona,
        }
        if raw_category and raw_category != cat:
            payload["categoryFallback"] = {"requested": raw_category, "used": cat}
        return payload

    # ---------- 3. 图谱 ----------

    async def _query_knowledge_graph(self, entity: str, depth: int = 2) -> dict[str, Any]:
        name = str(entity or "").strip()
        if not name:
            return {"ok": False, "error": "empty_entity", "found": False}

        store = self._graph_store()
        if store is None:
            return {
                "ok": False,
                "error": "graph_store_unavailable",
                "message": "graph_memory.enabled 为 false，或 LivingMemory 尚未就绪",
                "found": False,
            }

        hops = max(1, min(_as_int(depth, 2), GRAPH_MAX_HOPS))
        tokens = [name] if name.lower() == name else [name, name.lower()]

        seeds = await store.search_nodes_by_tokens(tokens, limit=GRAPH_SEED_LIMIT)
        if not seeds:
            return {
                "ok": True,
                "entity": name,
                "found": False,
                "hopsWalked": 0,
                "seeds": [],
                "relations": [],
                "statements": [],
            }

        frontier = [_as_int(node.get("id"), 0) for node in seeds]
        frontier = [i for i in frontier if i]
        visited = set(frontier)
        entries: dict[int, dict[str, Any]] = {}
        hops_walked = 0

        for _ in range(hops):
            batch = await store.get_entries_for_node_ids(frontier, limit=GRAPH_ENTRY_LIMIT)
            for entry in batch or []:
                entries.setdefault(_as_int(entry.get("entry_id"), 0), entry)
            hops_walked += 1

            neighbors = await store.get_neighbor_node_ids(frontier, limit=GRAPH_NEIGHBOR_LIMIT)
            frontier = [i for i in (neighbors or []) if i not in visited]
            if not frontier:
                break
            visited.update(frontier)

        # 边的两端在 get_neighbor_node_ids 里只有 id，没有名字。用 entries 携带的
        # source_memory_id 反查子图，一次拿回带 label 的 nodes 与 edges ——
        # 给 LLM 的必须是"甲 —关系→ 乙"，节点编号对它毫无意义。
        memory_ids = sorted({_as_int(e.get("source_memory_id"), 0) for e in entries.values()} - {0})
        memory_ids = memory_ids[:GRAPH_MEMORY_LIMIT]
        subgraph: dict[str, Any] = {"nodes": [], "edges": []}
        if memory_ids:
            subgraph = await store.get_subgraph_for_memories(memory_ids)

        labels = {
            _as_int(node.get("id"), 0): str(node.get("label") or node.get("canonical_value") or "")
            for node in subgraph.get("nodes") or []
        }
        relations = []
        for edge in subgraph.get("edges") or []:
            if str(edge.get("status") or "active") != "active":
                continue
            source = labels.get(_as_int(edge.get("source"), 0))
            target = labels.get(_as_int(edge.get("target"), 0))
            if not source or not target:
                continue
            relations.append(
                {
                    "source": source,
                    "relation": str(edge.get("relation_type") or ""),
                    "target": target,
                    "weight": round(_as_float(edge.get("weight"), 0.0), 3),
                    "confidence": round(_as_float(edge.get("confidence"), 0.0), 3),
                }
            )
        relations.sort(key=lambda r: (-r["weight"], r["source"], r["target"]))

        statements = [
            {
                "content": str(e.get("content") or ""),
                "type": str(e.get("entry_type") or ""),
                "relation": str(e.get("relation_type") or ""),
                "score": round(_as_float(e.get("score"), 0.0), 3),
                "memoryId": _as_int(e.get("source_memory_id"), 0),
            }
            for e in sorted(
                entries.values(),
                key=lambda e: -_as_float(e.get("score"), 0.0),
            )
        ]

        return {
            "ok": True,
            "entity": name,
            "found": True,
            "hopsWalked": hops_walked,
            "seeds": [
                {
                    "id": _as_int(node.get("id"), 0),
                    "value": str(node.get("node_value") or ""),
                    "type": str(node.get("node_type") or ""),
                }
                for node in seeds
            ],
            "nodesVisited": len(visited),
            "relations": relations,
            "statements": statements,
        }

    # ---------- 4. 黑话 ----------

    async def _query_community_jargon(self, word: str) -> dict[str, Any]:
        """查黑话，并顺手对齐图谱。

        黑话表在 SelfLearning（三步推断法学出来的），实体关系在 LivingMemory
        的图谱里。两边都查是因为它们回答的是同一个问题的两半：黑话表说
        "这个词是什么意思"，图谱说"这个词在群里跟谁、跟什么绑在一起"。
        单给前者，LLM 知道词义但不知道该对谁用。

        图谱那一半失败不影响整次调用 —— 词义是主菜，关系是配菜。
        """
        term = str(word or "").strip()
        if not term:
            return {"ok": False, "error": "empty_word", "found": False}

        db = self._db_manager()
        if db is None or not hasattr(db, "search_jargon"):
            return {
                "ok": False,
                "error": "self_learning_unavailable",
                "message": "SelfLearning 未挂载，或数据库尚未初始化",
                "found": False,
            }

        rows = await db.search_jargon(keyword=term, limit=10) or []

        entries = []
        for row in rows:
            entries.append(
                {
                    "word": str(row.get("content") or ""),
                    "meaning": row.get("meaning"),
                    # is_jargon 为 None 表示"还没推断"，与 False（推断为不是黑话）
                    # 是两件事。压成布尔会把"不知道"变成"不是"。
                    "confirmed": row.get("is_jargon"),
                    "count": _as_int(row.get("count"), 0),
                    "inferenceComplete": bool(row.get("is_complete")),
                    "global": bool(row.get("is_global")),
                    "chatId": str(row.get("chat_id") or ""),
                    "contexts": _parse_raw_contexts(row.get("raw_content")),
                    "updatedAt": row.get("updated_at"),
                }
            )

        payload: dict[str, Any] = {
            "ok": True,
            "word": term,
            "found": bool(entries),
            "count": len(entries),
            "entries": entries,
        }

        graph = await self._graph_context_for(term)
        if graph is not None:
            payload["graph"] = graph
        return payload

    # ---------- 5. 群文件与下载 ----------

    # ------------------------------------------------------------------
    # OneBot（NapCat）侧
    # ------------------------------------------------------------------

    def _download_dir(self) -> str:
        """群文件/私聊文件的落盘目录。

        默认落在宿主自己的 data_root 下。写死成别的项目的目录（曾经指向
        sideria_bridge_full_pack/received_files）会让文件跑到一个跟本进程
        无关的地方去，清理和排查都找不到人。
        """
        cfg = self._unified.config.get("onebot") or {}
        configured = str(cfg.get("download_dir") or "").strip()
        base = configured or os.path.join(self._unified.data_root, "received_files")
        return os.path.abspath(base)

    async def _onebot_request(
        self,
        action: str,
        method: str = "GET",
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """裸调一个 OneBot action，返回协议端的原始信封。

        成功与否交给 `_onebot_succeeded()` 判定 —— HTTP 200 不等于业务成功，
        协议端会用 200 + retcode != 0 表达逻辑失败。
        """
        http_url = str(os.environ.get("NAPCAT_HTTP_URL") or "http://127.0.0.1:3000").rstrip("/")
        # 不给 token 兜一个字面量。猜错了拿到的是 401；而"猜对了"更糟 ——
        # 那说明线上真的在用一个写在源码里的口令。
        token = str(os.environ.get("NAPCAT_ACCESS_TOKEN") or "")
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        else:
            logger.debug("NAPCAT_ACCESS_TOKEN 未设置，本次 OneBot 调用不带 Authorization 头")
        url = f"{http_url}/{action}"
        try:
            async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
                if method.upper() == "GET":
                    resp = await client.get(url, headers=headers, params=query)
                else:
                    resp = await client.post(url, headers=headers, json=body or {})
        except Exception as exc:  # noqa: BLE001 —— 调用方是个 LLM，见模块文档"不抛异常"
            return {
                "ok": False,
                "error": "onebot_unreachable",
                "message": f"连不上 OneBot ({http_url}): {exc}",
            }

        if resp.status_code != 200:
            return {
                "ok": False,
                "error": "http_error",
                "status": resp.status_code,
                "message": f"OneBot HTTP {resp.status_code}: {resp.text[:300]}",
            }
        try:
            data = resp.json()
            return data if isinstance(data, dict) else {"ok": True, "data": data}
        except Exception:
            return {"ok": True, "text": resp.text}

    @staticmethod
    def _payload(res: dict[str, Any], *keys: str) -> Any:
        """从 OneBot 信封里取 data，再按 keys 逐层下钻。取不到返回 None。"""
        cur: Any = res.get("data") if isinstance(res, dict) else None
        for k in keys:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(k)
        return cur

    async def _list_group_files(self, group_id: str, folder_id: str = "") -> dict[str, Any]:
        gid = str(group_id or "").strip()
        if not gid:
            return {"ok": False, "error": "missing_group_id", "message": "必须提供群号 group_id"}
        fid = str(folder_id or "").strip()
        action = "get_group_files_by_folder" if fid else "get_group_root_files"
        query = {"group_id": gid}
        if fid:
            query["folder_id"] = fid
        res = await self._onebot_request(action, query=query)
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        data = res.get("data") or {}
        return {
            "ok": True,
            "groupId": gid,
            "folderId": fid or "root",
            "files": data.get("files") or [],
            "folders": data.get("folders") or [],
        }

    async def _download_group_file(
        self,
        group_id: str,
        file_id: str,
        busid: int = 102,
        file_name: str = "",
    ) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        fid = str(file_id or "").strip()
        if not gid or not fid:
            return {"ok": False, "error": "missing_params", "message": "必须提供 group_id 和 file_id"}

        url_res = await self._onebot_request(
            "get_group_file_url", query={"group_id": gid, "file_id": fid, "busid": busid}
        )
        if not _onebot_succeeded(url_res):
            return _onebot_failure(url_res, "get_url_failed")
        url = self._payload(url_res, "url")
        if not url:
            return {"ok": False, "error": "get_url_failed", "message": "协议端没给出文件链接", "raw": url_res}

        clean_path = str(url).replace("file:///", "").replace("file://", "")
        if os.path.exists(clean_path):
            return {
                "ok": True,
                "localPath": os.path.abspath(clean_path),
                "url": url,
                "cached": True,
            }

        save_dir = self._download_dir()
        os.makedirs(save_dir, exist_ok=True)
        fname = str(file_name or "").strip() or f"group_file_{int(time.time())}_{os.path.basename(fid)}"
        # basename 一次：file_name 是调用方（LLM）给的，别让 ../ 把文件写到目录外面
        target_path = os.path.join(save_dir, os.path.basename(fname))

        try:
            async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
                resp = await client.get(str(url))
                if resp.status_code != 200:
                    return {"ok": False, "error": "download_failed", "status": resp.status_code}
                with open(target_path, "wb") as f:
                    f.write(resp.content)
                return {
                    "ok": True,
                    "localPath": os.path.abspath(target_path),
                    "sizeBytes": len(resp.content),
                    "url": url,
                }
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "download_exception", "message": str(exc)}

    async def _upload_group_file(
        self,
        group_id: str,
        file_path: str,
        name: str = "",
        folder_id: str = "",
    ) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        fpath = str(file_path or "").strip()
        if not gid or not fpath:
            return {"ok": False, "error": "missing_params", "message": "必须提供 group_id 和 file_path"}

        abs_path = os.path.abspath(fpath)
        if not os.path.exists(abs_path):
            return {"ok": False, "error": "file_not_found", "message": f"本地文件不存在: {abs_path}"}

        upload_name = str(name or "").strip() or os.path.basename(abs_path)
        body = {
            "group_id": _as_qq(gid),
            "file": abs_path.replace(os.sep, "/"),
            "name": upload_name,
        }
        if folder_id:
            body["folder"] = folder_id

        res = await self._onebot_request("upload_group_file", method="POST", body=body)
        if not _onebot_succeeded(res):
            return _onebot_failure(res, "upload_failed")
        return {"ok": True, "groupId": gid, "fileName": upload_name, "data": res.get("data")}

    async def _download_url_file(
        self,
        url: str = "",
        name: str = "",
        share_link: str = "",
    ) -> dict[str, Any]:
        if share_link:
            res = await self._onebot_request(
                "download_flash_file", method="POST", body={"share_link": share_link}
            )
            if not _onebot_succeeded(res):
                return _onebot_failure(res)
            return {"ok": True, "type": "flash_file", "data": res.get("data", res)}
        if url:
            res = await self._onebot_request(
                "download_file", method="POST", body={"url": url, "name": name or "downloaded_file"}
            )
            if not _onebot_succeeded(res):
                return _onebot_failure(res)
            return {"ok": True, "type": "direct_url", "data": res.get("data", res)}
        return {"ok": False, "error": "missing_url_or_link", "message": "必须提供 url 或 share_link"}

    async def _fetch_chat_history(
        self,
        group_id: str = "",
        user_id: str = "",
        count: int = 20,
    ) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        uid = str(user_id or "").strip()
        k = max(1, min(_as_int(count, 20), 50))
        if gid:
            action, query = "get_group_msg_history", {"group_id": gid, "count": k}
            kind, key, ident = "group", "groupId", gid
        elif uid:
            action, query = "get_friend_msg_history", {"user_id": uid, "count": k}
            kind, key, ident = "private", "userId", uid
        else:
            return {"ok": False, "error": "missing_target", "message": "必须提供 group_id 或 user_id"}

        res = await self._onebot_request(action, query=query)
        # 这里最不能撒谎：拉取失败若报 ok=True + messages=[]，调用方（一个 LLM）
        # 会把它读成"这个会话没有历史消息"，然后基于一个假前提往下推理。
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        msgs = self._payload(res, "messages")
        if msgs is None:
            msgs = res.get("data")
        msgs = msgs if isinstance(msgs, list) else []
        return {"ok": True, "type": kind, key: ident, "count": len(msgs), "messages": msgs}

    async def _get_forward_messages(self, message_id: str) -> dict[str, Any]:
        mid = str(message_id or "").strip()
        if not mid:
            return {"ok": False, "error": "missing_message_id", "message": "必须提供 message_id"}
        res = await self._onebot_request("get_forward_msg", query={"message_id": mid})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        msgs = self._payload(res, "messages")
        if msgs is None:
            msgs = res.get("data")
        return {"ok": True, "messageId": mid, "messages": msgs if isinstance(msgs, list) else []}

    async def _voice_to_text(self, message_id: str) -> dict[str, Any]:
        mid = str(message_id or "").strip()
        if not mid:
            return {"ok": False, "error": "missing_message_id", "message": "必须提供 message_id"}
        res = await self._onebot_request("voice_msg_to_text", query={"message_id": mid})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        text = self._payload(res, "text") or res.get("text")
        if not text:
            return {"ok": False, "error": "empty_transcript", "message": "协议端没给出转写文本", "raw": res}
        return {"ok": True, "messageId": mid, "text": str(text)}

    async def _send_poke(self, user_id: str, group_id: str = "") -> dict[str, Any]:
        uid = str(user_id or "").strip()
        gid = str(group_id or "").strip()
        if not uid:
            return {"ok": False, "error": "missing_user_id", "message": "必须提供 user_id"}
        # user_id 与 target_id 都发：不同 NapCat 构建读的字段不一样，多带一个
        # 会被忽略的字段，比少带一个导致静默不生效要好。
        body = {"user_id": _as_qq(uid), "target_id": _as_qq(uid)}
        if gid:
            body["group_id"] = _as_qq(gid)
        res = await self._onebot_request("send_poke", method="POST", body=body)
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "targetId": uid, "groupId": gid or None}

    async def _get_group_file_system_info(self, group_id: str) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        if not gid:
            return {"ok": False, "error": "missing_group_id", "message": "必须提供 group_id"}
        res = await self._onebot_request("get_group_file_system_info", query={"group_id": gid})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "groupId": gid, "data": res.get("data")}

    async def _upload_private_file(
        self,
        user_id: str,
        file_path: str,
        name: str = "",
    ) -> dict[str, Any]:
        uid = str(user_id or "").strip()
        fpath = str(file_path or "").strip()
        if not uid or not fpath:
            return {"ok": False, "error": "missing_params", "message": "必须提供 user_id 和 file_path"}

        abs_path = os.path.abspath(fpath)
        if not os.path.exists(abs_path):
            return {"ok": False, "error": "file_not_found", "message": f"本地文件不存在: {abs_path}"}

        upload_name = str(name or "").strip() or os.path.basename(abs_path)
        body = {
            "user_id": _as_qq(uid),
            "file": abs_path.replace(os.sep, "/"),
            "name": upload_name,
        }
        res = await self._onebot_request("upload_private_file", method="POST", body=body)
        if not _onebot_succeeded(res):
            return _onebot_failure(res, "upload_failed")
        return {"ok": True, "userId": uid, "fileName": upload_name, "data": res.get("data")}

    async def _get_image_detail(self, file: str) -> dict[str, Any]:
        f = str(file or "").strip()
        if not f:
            return {"ok": False, "error": "missing_file", "message": "必须提供图片的 file 标识"}
        res = await self._onebot_request("get_image", query={"file": f})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        data = res.get("data") or {}
        return {
            "ok": True,
            "file": f,
            "localPath": data.get("file"),
            "url": data.get("url"),
            "fileSize": data.get("file_size"),
            "fileName": data.get("file_name"),
        }

    async def _download_chat_file(self, file: str) -> dict[str, Any]:
        f = str(file or "").strip()
        if not f:
            return {"ok": False, "error": "missing_file", "message": "必须提供文件的 file 标识"}
        res = await self._onebot_request("get_file", method="POST", body={"file": f, "download": True})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        data = res.get("data") or {}
        return {
            "ok": True,
            "file": f,
            "localPath": data.get("file"),
            "url": data.get("url"),
            "fileSize": data.get("file_size"),
            "fileName": data.get("file_name"),
        }

    async def _convert_voice_to_mp3(self, file: str) -> dict[str, Any]:
        f = str(file or "").strip()
        if not f:
            return {"ok": False, "error": "missing_file", "message": "必须提供语音的 file 标识"}
        res = await self._onebot_request("get_record", method="POST", body={"file": f, "out_format": "mp3"})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        data = res.get("data") or {}
        return {
            "ok": True,
            "file": f,
            "localPath": data.get("file"),
            "fileSize": data.get("file_size"),
            "fileName": data.get("file_name"),
            "base64": bool(data.get("base64")),
        }

    async def _list_joined_groups(self, no_cache: bool = False) -> dict[str, Any]:
        res = await self._onebot_request("get_group_list", query={"no_cache": no_cache})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        groups = res.get("data")
        groups = groups if isinstance(groups, list) else []
        return {"ok": True, "count": len(groups), "groups": groups}

    async def _get_group_info(self, group_id: str) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        if not gid:
            return {"ok": False, "error": "missing_group_id", "message": "必须提供 group_id"}
        res = await self._onebot_request("get_group_info", query={"group_id": gid})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "groupId": gid, "data": res.get("data")}

    async def _list_group_members(self, group_id: str, no_cache: bool = False) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        if not gid:
            return {"ok": False, "error": "missing_group_id", "message": "必须提供 group_id"}
        res = await self._onebot_request(
            "get_group_member_list", query={"group_id": gid, "no_cache": no_cache}
        )
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        members = res.get("data")
        members = members if isinstance(members, list) else []
        return {"ok": True, "groupId": gid, "count": len(members), "members": members}

    async def _get_group_member_info(self, group_id: str, user_id: str, no_cache: bool = False) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        uid = str(user_id or "").strip()
        if not gid or not uid:
            return {"ok": False, "error": "missing_params", "message": "必须提供 group_id 和 user_id"}
        res = await self._onebot_request(
            "get_group_member_info", query={"group_id": gid, "user_id": uid, "no_cache": no_cache}
        )
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "groupId": gid, "userId": uid, "data": res.get("data")}

    async def _get_message_detail(self, message_id: str) -> dict[str, Any]:
        mid = str(message_id or "").strip()
        if not mid:
            return {"ok": False, "error": "missing_message_id", "message": "必须提供 message_id"}
        res = await self._onebot_request("get_msg", query={"message_id": mid})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "messageId": mid, "data": res.get("data")}

    async def _forward_message(self, message_id: str, target_group_id: str = "", target_user_id: str = "") -> dict[str, Any]:
        mid = str(message_id or "").strip()
        gid = str(target_group_id or "").strip()
        uid = str(target_user_id or "").strip()
        if not mid:
            return {"ok": False, "error": "missing_message_id", "message": "必须提供 message_id"}
        if gid:
            action = "forward_group_single_msg"
            body = {"group_id": _as_qq(gid), "message_id": _as_qq(mid)}
            tail = {"type": "group", "targetGroupId": gid}
        elif uid:
            action = "forward_friend_single_msg"
            body = {"user_id": _as_qq(uid), "message_id": _as_qq(mid)}
            tail = {"type": "private", "targetUserId": uid}
        else:
            return {"ok": False, "error": "missing_target", "message": "必须提供 target_group_id 或 target_user_id"}

        res = await self._onebot_request(action, method="POST", body=body)
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "messageId": mid, "data": res.get("data"), **tail}

    async def _get_ai_characters(self, group_id: str) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        if not gid:
            return {"ok": False, "error": "missing_group_id", "message": "必须提供 group_id"}
        res = await self._onebot_request("get_ai_characters", query={"group_id": gid, "chat_type": 1})
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "groupId": gid, "characters": res.get("data")}

    async def _send_group_ai_record(self, group_id: str, character: str, text: str) -> dict[str, Any]:
        gid = str(group_id or "").strip()
        char = str(character or "").strip()
        txt = str(text or "").strip()
        if not gid or not char or not txt:
            return {"ok": False, "error": "missing_params", "message": "必须提供 group_id, character 和 text"}
        res = await self._onebot_request(
            "send_group_ai_record",
            method="POST",
            body={"group_id": _as_qq(gid), "character": char, "text": txt},
        )
        if not _onebot_succeeded(res):
            return _onebot_failure(res)
        return {"ok": True, "groupId": gid, "character": char, "data": res.get("data")}

    async def _graph_context_for(self, term: str) -> dict[str, Any] | None:
        """这个词在图谱里跟什么绑在一起。取不到就返回 None（配菜可以没有）。"""
        store = self._graph_store()
        if store is None:
            return None
        try:
            nodes = await store.search_nodes_by_tokens([term], limit=5)
            if not nodes:
                return {"nodes": [], "statements": []}
            node_ids = [_as_int(n.get("id"), 0) for n in nodes]
            node_ids = [i for i in node_ids if i]
            hits = await store.get_entries_for_node_ids(node_ids, limit=10)
        except Exception as exc:  # noqa: BLE001 —— 见 _query_community_jargon 文档
            logger.debug("黑话查询的图谱对齐失败，本次只返回词义: %s", exc)
            return None
        return {
            "nodes": [str(n.get("node_value") or "") for n in nodes],
            "statements": [str(h.get("content") or "") for h in hits or []],
        }


# ======================================================================
# 小工具
# ======================================================================


def _onebot_succeeded(res: Any) -> bool:
    """这次 OneBot 调用到底成了没有。

    HTTP 200 不等于业务成功：协议端会用 200 + `retcode != 0` 表达逻辑失败
    （动作不存在、没权限、群号不对）。只看 status_code 会把这些读成成功，
    然后 `res["data"]` 是 None，最后返回给调用方一个 `ok: True` + 空列表 ——
    调用方是个 LLM，它会把空列表读成"这里本来就没东西"，基于假前提继续推理。

    换协议端（NapCat ⇄ LLBot）时这条尤其要紧：两边支持的 action 不是同一套，
    缺失的那些正是靠 retcode 报出来的。
    """
    if not isinstance(res, dict):
        return False
    if res.get("ok") is False:
        return False  # _onebot_request 自己判定的传输层失败
    if "retcode" in res:
        return _as_int(res.get("retcode"), -1) == 0
    if "status" in res:
        return str(res.get("status")).lower() == "ok"
    # 既没 retcode 也没 status：不是标准信封（部分扩展 action 就这样），
    # 但传输层是通的、也确实拿回了东西，按成功算。
    return True


def _onebot_failure(res: Any, error: str = "onebot_failed") -> dict[str, Any]:
    """把一次失败的 OneBot 调用翻译成 handler 的错误返回。

    把协议端自己的说法（message / wording）带出去 —— 调用方读得懂
    "群不存在"，读不懂一个光秃秃的 onebot_failed。
    """
    out: dict[str, Any] = {"ok": False, "error": error}
    if isinstance(res, dict):
        for key in ("status", "retcode", "message", "wording", "msg"):
            if key in res and res[key] is not None:
                out[key] = res[key]
        out["raw"] = res
    return out


def _as_qq(value: Any) -> Any:
    """QQ 号/消息号：纯数字就转 int，否则原样传。

    协议端对这两种都收，但有些实现在字符串上会挑食，而消息号在某些扩展里
    本来就不是数字 —— 所以不能无条件 int()。
    """
    text = str(value or "").strip()
    return int(text) if text.isdigit() else value


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_raw_contexts(raw: Any, limit: int = 5) -> list[str]:
    """黑话的 raw_content 是一个 JSON 数组字符串（多条使用语境）。

    解析失败不报错：这一列是学习过程写的，历史数据里存在非 JSON 的脏值，
    为了展示语境而让整次查询失败不值得。
    """
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            items = json.loads(raw)
        except json.JSONDecodeError:
            return [raw.strip()[:200]]
        if not isinstance(items, list):
            return [str(items)[:200]]
    else:
        return []
    return [str(item)[:200] for item in items[:limit] if str(item).strip()]


__all__ = [
    "MANIFEST_VERSION",
    "MEMORY_CATEGORIES",
    "HermesTool",
    "ToolRegistry",
]
