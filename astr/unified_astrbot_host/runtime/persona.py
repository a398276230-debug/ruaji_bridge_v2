"""runtime.persona —— 宿主的人格管理器。

真 AstrBot 的 PersonaManager 挂在 SQLModel 数据库上（`persona_mgr.py` 收
`BaseDatabase` 与 `AstrBotConfigManager`）。宿主不引整套 ORM，改成一个 JSON
文件 —— 但**必须落盘**，因为 SelfLearning 的人格审阅会往回写 system_prompt，
只存内存的话，宿主一重启，学了几天的语气就全没了。

## 接口来自这些真实调用点（不是猜的）

    livingmemory/core/utils/__init__.py:174    get_default_persona_v3(umo=umo) → ["name"]
    livingmemory/core/processors/memory_processor.py:189  get_persona(persona_id) → .prompt
    self_learning/core/factory.py:716          get_default_persona_v3() → .get("prompt")
    self_learning/persona_web_manager.py       personas / get_all_personas / initialize
                                               create_persona / update_persona / delete_persona
                                               db.get_persona_by_id

注意 v3 与 v4 两套并存：v3 是 `Personality` TypedDict（键 `name` / `prompt`），
v4 是 `Persona` dataclass（字段 `persona_id` / `system_prompt`）。上游同时暴露
两套，调用方混着用 —— LivingMemory 取 `["name"]`，SelfLearning 取 `.get("prompt")`。
所以 v3 返回 dict，且两套共享同一份底层数据，不能各存一份。
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from astrbot.core import logger
from astrbot.core.db.po import Persona, Personality


class _PersonaStore:
    """`persona_manager.db` 的替身。只需要 `get_persona_by_id`。"""

    def __init__(self, owner: "PersonaManager") -> None:
        self._owner = owner

    async def get_persona_by_id(self, persona_id: str) -> Persona | None:
        return self._owner._by_id(persona_id)


class PersonaManager:
    """人格的唯一真相。三个插件共用这一个实例。"""

    def __init__(
        self,
        persona_id: str = "ruaji",
        system_prompt: str = "",
        store_path: str = "",
    ) -> None:
        self.store_path = store_path
        self.default_persona_id = persona_id
        self.personas: list[Persona] = []
        self.personas_v3: list[Personality] = []
        self.selected_default_persona: Persona | None = None
        self.selected_default_persona_v3: Personality | None = None
        self.db = _PersonaStore(self)
        self._lock = asyncio.Lock()

        self._load(fallback_prompt=system_prompt)

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    def _load(self, fallback_prompt: str = "") -> None:
        """读盘。优先支持带 <Self-awareness> 标签的 Markdown 格式 soul 文件。
        
        只提取 <Self-awareness> 内部作为 AstrBot 的人格内容，隔离其他指令。
        """
        import re
        self_awareness_prompt = ""
        raw: list[dict[str, Any]] = []

        if self.store_path and os.path.isfile(self.store_path):
            try:
                with open(self.store_path, "r", encoding="utf-8") as fh:
                    content = fh.read()
                
                # 尝试解析 Markdown 标签
                m = re.search(r"<Self-awareness>(.*?)</Self-awareness>", content, re.DOTALL)
                if m:
                    self_awareness_prompt = m.group(1).strip()
                    raw = [{"persona_id": self.default_persona_id, "system_prompt": self_awareness_prompt}]
                    logger.info("成功从 %s 解析出 <Self-awareness> 人格 (%d 字符)", os.path.basename(self.store_path), len(self_awareness_prompt))
                elif self.store_path.endswith(".json"):
                    payload = json.loads(content)
                    raw = payload.get("personas") or []
                    self.default_persona_id = payload.get("default") or self.default_persona_id
                else:
                    self_awareness_prompt = content.strip()
                    raw = [{"persona_id": self.default_persona_id, "system_prompt": self_awareness_prompt}]
            except Exception as exc:
                logger.warning("人格文件读取失败，改用配置里的种子人格: %s", exc)
                raw = []

        if not raw:
            raw = [{"persona_id": self.default_persona_id, "system_prompt": fallback_prompt}]
            logger.info("初始化人格 %s（来自 config.yaml 的种子）", self.default_persona_id)

        self.personas = [
            Persona(
                persona_id=str(item.get("persona_id") or "default"),
                system_prompt=str(item.get("system_prompt") or ""),
                begin_dialogs=list(item.get("begin_dialogs") or []),
                tools=item.get("tools"),
                skills=item.get("skills"),
            )
            for item in raw
        ]
        self._resync()

    def _flush(self) -> None:
        """写盘。若为 Markdown 格式，只精准回填 <Self-awareness> 段落，绝不污染其他标签。"""
        if not self.store_path:
            return
        import re
        target_persona = self._by_id(self.default_persona_id) or (self.personas[0] if self.personas else None)
        new_prompt = target_persona.system_prompt if target_persona else ""

        try:
            os.makedirs(os.path.dirname(self.store_path) or ".", exist_ok=True)
            tmp = f"{self.store_path}.tmp"

            if self.store_path.endswith(".md") or (os.path.isfile(self.store_path) and not self.store_path.endswith(".json")):
                orig_text = ""
                if os.path.isfile(self.store_path):
                    with open(self.store_path, "r", encoding="utf-8") as fh:
                        orig_text = fh.read()
                
                if "<Self-awareness>" in orig_text and "</Self-awareness>" in orig_text:
                    # 精准替换 <Self-awareness> 段落
                    updated_text = re.sub(
                        r"<Self-awareness>.*?</Self-awareness>",
                        f"<Self-awareness>\n{new_prompt.strip()}\n</Self-awareness>",
                        orig_text,
                        flags=re.DOTALL
                    )
                else:
                    # 自动包裹
                    updated_text = f"<Self-awareness>\n{new_prompt.strip()}\n</Self-awareness>\n\n" + orig_text.strip()

                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(updated_text)
                os.replace(tmp, self.store_path)
                logger.info("已精准将人格更新写回 %s 的 <Self-awareness> 标签", os.path.basename(self.store_path))
            else:
                payload = {
                    "default": self.default_persona_id,
                    "personas": [
                        {
                            "persona_id": p.persona_id,
                            "system_prompt": p.system_prompt,
                            "begin_dialogs": p.begin_dialogs,
                            "tools": p.tools,
                            "skills": p.skills,
                        }
                        for p in self.personas
                    ],
                }
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh, ensure_ascii=False, indent=2)
                os.replace(tmp, self.store_path)
        except OSError as exc:
            logger.error("人格落盘失败，本次演化只在内存里: %s", exc)

    def _resync(self) -> None:
        """v4 列表变了之后，重建 v3 视图与默认指针。

        两套视图必须由同一处代码重建 —— 分头维护迟早会漂移，而"哪份是对的"
        在调用点上看不出来（LivingMemory 只读 v3，SelfLearning 两套都读）。
        """
        self.personas_v3 = [
            Personality(
                name=p.persona_id,
                prompt=p.system_prompt,
                begin_dialogs=list(p.begin_dialogs),
                mood_imitation_dialogs=[],
                tools=p.tools,
                skills=p.skills,
                custom_error_message=None,
            )
            for p in self.personas
        ]
        self.selected_default_persona = self._by_id(self.default_persona_id) or (
            self.personas[0] if self.personas else None
        )
        target = self.selected_default_persona
        self.selected_default_persona_v3 = (
            next((v for v in self.personas_v3 if v["name"] == target.persona_id), None)
            if target
            else None
        )

    def _by_id(self, persona_id: str | None) -> Persona | None:
        if not persona_id:
            return None
        return next((p for p in self.personas if p.persona_id == persona_id), None)

    # ------------------------------------------------------------------
    # 上游接口
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        self.personas = await self.get_all_personas()
        self._resync()
        logger.info("人格管理器就绪，共 %d 个人格", len(self.personas))

    async def get_all_personas(self) -> list[Persona]:
        return list(self.personas)

    async def get_persona(self, persona_id: str) -> Persona | None:
        return self._by_id(persona_id)

    def get_persona_v3_by_id(self, persona_id: str | None) -> Personality | None:
        if persona_id is None:
            return self.selected_default_persona_v3
        return next((v for v in self.personas_v3 if v["name"] == persona_id), None)

    async def get_default_persona_v3(
        self, umo: Any = None, **kwargs: Any
    ) -> Personality | None:  # noqa: ARG002
        """全局默认人格。

        宿主只有一份人格，所以 umo（会话标识）被忽略。上游支持按会话覆写；
        这里如实不支持，而不是假装支持后返回同一份 —— 两者行为相同，
        但注释里说清了，将来要加就知道从哪加。
        """
        return self.selected_default_persona_v3

    async def resolve_selected_persona(self, umo: Any = None, **kwargs: Any):  # noqa: ARG002
        target = self.selected_default_persona_v3
        pid = target.get("name", "ruaji") if isinstance(target, dict) else getattr(target, "persona_id", "ruaji")
        return pid, target, None, target

    def get_v3_persona_data(self, *args: Any, **kwargs: Any) -> list[Personality]:  # noqa: ARG002
        return list(self.personas_v3)

    async def create_persona(
        self,
        persona_id: str,
        system_prompt: str = "",
        begin_dialogs: list[str] | None = None,
        tools: list[str] | None = None,
        **kwargs: Any,
    ) -> Persona:
        async with self._lock:
            if self._by_id(persona_id) is not None:
                raise ValueError(f"人格 {persona_id} 已存在")
            persona = Persona(
                persona_id=persona_id,
                system_prompt=system_prompt,
                begin_dialogs=list(begin_dialogs or []),
                tools=tools,
                skills=kwargs.get("skills"),
            )
            self.personas.append(persona)
            self._resync()
            self._flush()
        logger.info("新建人格 %s", persona_id)
        return persona

    async def update_persona(
        self,
        persona_id: str,
        system_prompt: str | None = None,
        begin_dialogs: list[str] | None = None,
        tools: list[str] | None = None,
        **kwargs: Any,
    ) -> Persona:
        """改人格。这是 SelfLearning 人格演化的落点。

        `None` 表示"这一项不动"，不是"清空" —— SelfLearning 只传
        system_prompt（persona_learning.py:293），其余字段必须原样保留。
        """
        async with self._lock:
            persona = self._by_id(persona_id)
            if persona is None:
                raise ValueError(f"人格 {persona_id} 不存在")
            if system_prompt is not None:
                persona.system_prompt = system_prompt
            if begin_dialogs is not None:
                persona.begin_dialogs = list(begin_dialogs)
            if tools is not None:
                persona.tools = tools
            if kwargs.get("skills") is not None:
                persona.skills = kwargs["skills"]
            self._resync()
            self._flush()
        logger.info("人格 %s 已更新并落盘", persona_id)
        return persona

    async def delete_persona(self, persona_id: str) -> None:
        async with self._lock:
            self.personas = [p for p in self.personas if p.persona_id != persona_id]
            self._resync()
            self._flush()
        logger.info("人格 %s 已删除", persona_id)

    # 目录/排序相关接口宿主不提供层级人格，返回空即可
    async def get_folder_tree(self) -> list[dict]:
        return []

    async def get_all_folders(self) -> list[Any]:
        return []


__all__ = ["PersonaManager"]
