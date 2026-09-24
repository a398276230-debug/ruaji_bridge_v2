"""tests/python/test_host_owner_id_injection.py —— 主人 QQ 号注入 LivingMemory。

LivingMemory 要靠 ``access_control.owner_ids`` 才知道谁的私聊专属 Mem0
（memory_scope.is_owner_private_event）。这个值不该让用户在插件面板里再填一遍：
宿主 config.yaml 的 ``identity.owner_id`` 是唯一事实源，``UnifiedContext`` 把它
派生成 ``identity_overrides``，由 plugins_mount.loader **最后**合并进插件配置 ——
排在插件自己持久化的 config.json 之后，面板一保存也覆盖不了它。

跑法：仓库根目录
  python -m pytest tests/python/test_host_owner_id_injection.py
  python -m unittest tests.python.test_host_owner_id_injection
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "astr/unified_astrbot_host"))

import bootstrap  # noqa: E402,F401

from runtime.context import UnifiedContext  # noqa: E402


class OwnerIdInjectionTests(unittest.TestCase):
    def test_living_memory_gets_owner_ids_from_identity(self):
        overrides = UnifiedContext._identity_overrides(
            "living_memory", {"owner_id": "3054039169", "robot_id": "398276230"}
        )
        self.assertEqual(overrides, {"access_control": {"owner_ids": "3054039169"}})

    def test_other_plugins_are_untouched(self):
        for key in ("group_chat_plus", "favour_ultra", "unified-host"):
            self.assertEqual(
                UnifiedContext._identity_overrides(key, {"owner_id": "3054039169"}), {}
            )

    def test_missing_or_blank_owner_id_does_not_inject(self):
        self.assertEqual(UnifiedContext._identity_overrides("living_memory", {}), {})
        self.assertEqual(
            UnifiedContext._identity_overrides("living_memory", {"owner_id": ""}), {}
        )
        self.assertEqual(
            UnifiedContext._identity_overrides("living_memory", {"owner_id": "   "}), {}
        )

    def test_owner_id_is_normalized_to_string(self):
        """YAML 把纯数字写成 int；插件侧按字符串 casefold 比对，必须归一。"""
        overrides = UnifiedContext._identity_overrides(
            "living_memory", {"owner_id": 3054039169}
        )
        self.assertEqual(overrides["access_control"]["owner_ids"], "3054039169")


if __name__ == "__main__":
    unittest.main()
