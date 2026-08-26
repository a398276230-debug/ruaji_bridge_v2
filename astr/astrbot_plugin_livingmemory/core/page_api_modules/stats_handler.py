"""
统计信息处理模块
"""

from typing import TYPE_CHECKING, Any

from astrbot.api import logger

if TYPE_CHECKING:
    from .utils import PageApiUtils


class StatsHandler:
    """统计信息处理器"""

    def __init__(self, utils: "PageApiUtils"):
        """
        初始化统计处理器

        Args:
            utils: PageApiUtils 工具实例
        """
        self.utils = utils

    async def get_stats(self, memory_engine) -> dict[str, Any]:
        """
        获取插件统计信息

        包括：
        - 记忆总数、会话统计
        - 图谱节点、边、入口统计
        - 原子统计
        - 重要性分布
        - 最近会话列表

        Args:
            memory_engine: 记忆引擎实例

        Returns:
            包含统计信息的字典
        """
        try:
            stats = await memory_engine.get_statistics()

            # 使用专用的 COUNT(*) 统计，确保显示完整图谱总数
            graph_store = self.utils.get_graph_store(memory_engine)
            if graph_store is not None:
                try:
                    entry_stats = await graph_store.get_memory_entry_stats()
                    stats["graph_nodes"] = entry_stats.get("graph_nodes", 0)
                    stats["graph_edges"] = entry_stats.get("graph_edges", 0)
                    stats["graph_entries"] = entry_stats.get("graph_entries", 0)
                except Exception:
                    stats["graph_nodes"] = 0
                    stats["graph_edges"] = 0
                    stats["graph_entries"] = 0
            else:
                stats["graph_nodes"] = 0
                stats["graph_edges"] = 0
                stats["graph_entries"] = 0

            # 原子统计 (if available)
            atom_store = getattr(memory_engine, "atom_store", None)
            stats["atom_count"] = 0
            stats["atom_breakdown"] = {}
            if atom_store is not None:
                try:
                    stats["atom_count"] = await atom_store.count_atoms() or 0
                except Exception:
                    pass
                try:
                    stats["atom_breakdown"] = await atom_store.count_by_type()
                except Exception:
                    pass

            # 重要性分布 — 兜底默认值（get_statistics 已计算，此处仅容错）
            if "importance_distribution" not in stats:
                stats["importance_distribution"] = {
                    "0-1": 0,
                    "1-2": 0,
                    "2-3": 0,
                    "3-4": 0,
                    "4-5": 0,
                    "5-6": 0,
                    "6-7": 0,
                    "7-8": 0,
                    "8-9": 0,
                    "9-10": 0,
                }

            # 最近会话从 sessions 统计数据派生
            session_data = stats.get("sessions", {})
            stats["recent_sessions"] = (
                [
                    {"session_id": sid, "message_count": cnt}
                    for sid, cnt in sorted(session_data.items(), key=lambda x: -x[1])[
                        :10
                    ]
                ]
                if isinstance(session_data, dict)
                else []
            )

            # 统计未总结轮次与反思进度
            total_unsummarized_messages = 0
            total_conversation_messages = 0
            try:
                import json, aiosqlite
                from astrbot.api.star import StarTools
                conv_db = str(StarTools.get_data_dir("astrbot_plugin_livingmemory") / "conversations.db")
                async with aiosqlite.connect(conv_db) as db:
                    cursor = await db.execute("SELECT COUNT(*) FROM messages")
                    total_conversation_messages = int((await cursor.fetchone())[0])
                    
                    cursor = await db.execute("SELECT session_id, message_count, metadata FROM sessions")
                    rows = await cursor.fetchall()
                    for sid, mcnt, meta_json in rows:
                        meta = json.loads(meta_json) if meta_json else {}
                        last_idx = meta.get("last_summarized_index", 0)
                        diff = max(0, (mcnt or 0) - last_idx)
                        total_unsummarized_messages += diff
            except Exception as e:
                logger.debug(f"统计反思进度异常: {e}")

            unsummarized_rounds = total_unsummarized_messages // 2
            trigger_rounds = 10
            stats["reflection_progress"] = {
                "unsummarized_messages": total_unsummarized_messages,
                "unsummarized_rounds": unsummarized_rounds,
                "trigger_rounds": trigger_rounds,
                "remaining_rounds": max(0, trigger_rounds - unsummarized_rounds),
                "total_messages": total_conversation_messages,
            }

            return self.utils.ok(stats)
        except Exception as exc:
            logger.error(f"[PageAPI] 获取统计信息失败: {exc}", exc_info=True)
            return self.utils.error(str(exc))
