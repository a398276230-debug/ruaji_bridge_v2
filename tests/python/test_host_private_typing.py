"""tests/python/test_host_private_typing.py —— 宿主私聊消息类型识别回归。

背景：桥接发往宿主的两条主载荷（``message.received`` 事件与
``/api/v1/context/enrich`` body）一直只带 ``messageType``，没有 ``isPrivate``。
``InboundMessage.from_payload`` 原先只认显式标志，于是**所有私聊都被判成群聊**：

* ``build_event`` 造出的 unified_msg_origin 变成
  ``aiocqhttp:GroupMessage:<QQ>``。LivingMemory 的 user 消息因此写进一个"群会
  话"，而 ``llm.response``（带 isPrivate）又把 assistant 写进 FriendMessage 会话 ——
  私聊对话被劈成两半，``unread // 2`` 的反思轮数永远凑不齐，长期记忆沉淀不到；
* LivingMemory 的主人私聊豁免（``is_owner_private_event`` 要求
  FRIEND_MESSAGE）永不命中，主人私聊照样被 LivingMemory 捕获，与桥接 Mem0 重叠。

修复：显式标志优先，缺失时从 ``messageType`` / ``message_type`` 推导。

跑法：仓库根目录
  python -m pytest tests/python/test_host_private_typing.py
  python -m unittest tests.python.test_host_private_typing
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "astr/unified_astrbot_host"))

import bootstrap  # noqa: E402,F401 —— 摆好 sys.path，让 astrbot 解析到垫片

from astrbot.api.platform import MessageType  # noqa: E402

from hermes_layer.context_builder import build_event  # noqa: E402
from hermes_layer.contracts import InboundMessage, is_private_message_type  # noqa: E402

BOT_ID = "398276230"


class PrivateMessageTypeTests(unittest.TestCase):
    def _event(self, payload: dict):
        return build_event(InboundMessage.from_payload(payload), self_id=BOT_ID)

    # ---------------------------------------------------------- 纯函数

    def test_accepts_bridge_and_astrbot_spellings(self):
        for value in (
            "private", "Private", "PRIVATE", "friend", "FriendMessage",
            "friend_message", "PrivateMessage", "privateChat",
        ):
            self.assertTrue(is_private_message_type(value), value)

    def test_rejects_group_and_unknown(self):
        for value in ("group", "GroupMessage", "other", "OtherMessage", "", None, "群聊"):
            self.assertFalse(is_private_message_type(value), value)

    # ---------------------------------------------------------- from_payload

    def test_infers_private_from_bridge_message_type(self):
        """桥接 message.received / context.enrich 的真实载荷：只有 messageType。"""
        msg = InboundMessage.from_payload(
            {
                "messageId": "1",
                "selfId": BOT_ID,
                "userId": "3054039169",
                "groupId": "",
                "messageType": "private",
                "text": "在吗",
                "content": "在吗",
                "isAtBot": False,
            }
        )
        self.assertTrue(msg.is_private)
        self.assertEqual(msg.message_type, "private")
        self.assertEqual(msg.session_id, "3054039169")

    def test_infers_private_from_astrbot_message_type(self):
        msg = InboundMessage.from_payload({"messageType": "FriendMessage", "userId": "42"})
        self.assertTrue(msg.is_private)
        self.assertEqual(msg.session_id, "42")

    def test_group_message_type_stays_group(self):
        msg = InboundMessage.from_payload(
            {"messageType": "group", "userId": "10001", "groupId": "1076958977", "text": "hi"}
        )
        self.assertFalse(msg.is_private)
        self.assertEqual(msg.session_id, "1076958977")

    def test_explicit_flag_wins_over_message_type(self):
        """显式标志是权威信号（llm.response 一直带着它）。"""
        explicit_false = InboundMessage.from_payload(
            {"messageType": "private", "isPrivate": False, "userId": "9"}
        )
        self.assertFalse(explicit_false.is_private)

        explicit_true = InboundMessage.from_payload(
            {"messageType": "group", "isPrivate": True, "userId": "9", "groupId": "8"}
        )
        self.assertTrue(explicit_true.is_private)

    def test_without_any_hint_defaults_group(self):
        """旧桥接/无类型载荷保持原行为（群聊），不引入隐式私聊。"""
        msg = InboundMessage.from_payload({"userId": "9", "groupId": "8", "text": "hi"})
        self.assertFalse(msg.is_private)

    # ---------------------------------------------------------- 端到端事件类型

    def test_owner_private_event_reaches_plugin_as_friend_message(self):
        """插件侧 is_owner_private_event 的判定前提。"""
        event = self._event(
            {"messageType": "private", "userId": "3054039169", "groupId": "", "text": "在吗"}
        )
        self.assertEqual(event.unified_msg_origin, "aiocqhttp:FriendMessage:3054039169")
        self.assertEqual(event.get_message_type(), MessageType.FRIEND_MESSAGE)

    def test_group_event_still_reaches_plugin_as_group_message(self):
        event = self._event(
            {"messageType": "group", "userId": "10001", "groupId": "1076958977", "text": "hi"}
        )
        self.assertEqual(event.unified_msg_origin, "aiocqhttp:GroupMessage:1076958977")
        self.assertEqual(event.get_message_type(), MessageType.GROUP_MESSAGE)


if __name__ == "__main__":
    unittest.main()
