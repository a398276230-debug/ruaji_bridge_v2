"""
消息捕获模块
负责捕获和存储群聊中的全部消息，以及非主人好友的私聊消息。
主人私聊由桥接的 Mem0 专属沉淀（src/orchestration/mem0-ingestor.js），此处跳过。
"""

import asyncio
from typing import TYPE_CHECKING

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent
from astrbot.api.platform import MessageType

from ..memory_scope import is_event_memory_allowed, is_owner_private_event

if TYPE_CHECKING:
    from ..base.config_manager import ConfigManager
    from ..managers.conversation_manager import ConversationManager
    from .message_utils import MessageUtils


class GroupCapture:
    """群聊消息捕获类"""

    def __init__(
        self,
        config_manager: "ConfigManager",
        conversation_manager: "ConversationManager",
        message_utils: "MessageUtils",
    ):
        """
        初始化群聊消息捕获模块

        Args:
            config_manager: 配置管理器
            conversation_manager: 会话管理器
            message_utils: 消息处理工具
        """
        self.config_manager = config_manager
        self.conversation_manager = conversation_manager
        self.message_utils = message_utils

    async def handle_all_group_messages(self, event: AstrMessageEvent):
        """Capture group messages and non-owner friend messages for memory storage"""
        # 检查配置
        if not self.config_manager.get(
            "session_manager.enable_full_group_capture", True
        ):
            return

        # 只处理群聊与非主人私聊；其他消息类型一律不碰
        try:
            message_type = event.get_message_type()
        except Exception:
            return
        if message_type not in (MessageType.GROUP_MESSAGE, MessageType.FRIEND_MESSAGE):
            return

        # 主人私聊专属 Mem0（桥接 mem0-ingestor），LivingMemory 不捕获不落库。
        if is_owner_private_event(self.config_manager, event):
            return

        if not is_event_memory_allowed(self.config_manager, event):
            return

        # 群聊中 Bot 自己的消息由 handle_memory_reflection 负责写入，此处跳过
        # 避免 platform echo 导致 assistant 响应被写入两次
        if event.get_sender_id() == event.get_self_id():
            return

        try:
            session_id = event.unified_msg_origin
            is_private = message_type == MessageType.FRIEND_MESSAGE

            # 检测异常session_id
            if session_id and (
                "Error:" in session_id or "error:" in session_id.lower()
            ):
                logger.warning(
                    f"检测到异常的session_id: {session_id}。"
                    f"这可能是平台适配器初始化问题，建议检查平台配置。"
                )

            # 获取消息内容
            content = await self.message_utils.extract_message_content(event)
            dedup_key = await self.message_utils.build_dedup_key(
                event, session_id, content
            )

            # 消息去重：先占位再落库。与 on_llm_request 的私聊存储路径（memory_recall）
            # 共享同一份去重缓存，两条路径并发时也不会双双写入。
            if dedup_key:
                if await self.message_utils.is_duplicate_message(dedup_key):
                    logger.debug(f"[{session_id}] 消息已存在,跳过: dedup_key={dedup_key}")
                    return
                await self.message_utils.mark_message_processed(dedup_key)

            # 存储消息到数据库（用户消息，role 固定为 user）
            await self.conversation_manager.add_message_from_event(
                event=event,
                role="user",
                content=content,
            )

            # 执行消息数量上限控制
            await self.message_utils.enforce_message_limit(session_id)

            logger.debug(
                f"[{session_id}] 捕获{'私聊' if is_private else '群聊'}消息: "
                f"sender={event.get_sender_name()}({event.get_sender_id()}), "
                f"content={content[:50]}..."
            )

        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"处理全量消息捕获时发生错误: {e}", exc_info=True)
