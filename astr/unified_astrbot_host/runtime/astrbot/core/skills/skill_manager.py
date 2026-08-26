"""astrbot.core.skills.skill_manager —— Skills 清单。

GCP 在构造 system prompt 时可选地追加 Skills 列表（main.py:10994-11001），
整段包在 try 里。宿主没有 skills 目录，所以这里是一个**诚实返回空**的实现：
`list_skills()` 给空表，`build_skills_prompt([])` 给空串，于是 GCP 那段
`if skills_prompt:` 自然不追加 —— 比抛异常让它进 except 分支干净。

如果以后真要给瑞姬挂 skills，把 skills_root 指到目录即可，扫描逻辑已经在了。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from astrbot.core import logger
from astrbot.core.utils.astrbot_path import get_astrbot_data_path


@dataclass
class SkillInfo:
    name: str
    description: str = ""
    path: str = ""
    source_type: str = "workspace"
    active: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)


def build_skills_prompt(skills: list[SkillInfo]) -> str:
    """渲染 Skills 清单段。

    只给 name + description + 文件路径（渐进披露）—— 模型要用之前得自己
    去读 SKILL.md，这样清单再长也不会把 system prompt 撑爆。
    """
    if not skills:
        return ""
    lines = [
        f"- **{s.name}**: {s.description or 'No description'}\n  File: `{s.path or '<skills_root>/<skill_name>/SKILL.md'}`"
        for s in skills
        if s.active
    ]
    if not lines:
        return ""
    return "# Available Skills\n\n" + "\n".join(lines) + "\n"


class SkillManager:
    def __init__(
        self,
        skills_root: str | None = None,
        plugins_root: str | None = None,
    ) -> None:
        self.skills_root = Path(skills_root or os.path.join(get_astrbot_data_path(), "skills"))
        self.plugins_root = Path(plugins_root) if plugins_root else None

    def list_skills(self, *args: Any, **kwargs: Any) -> list[SkillInfo]:  # noqa: ARG002
        """扫描 skills_root 下每个含 SKILL.md 的子目录。目录不存在就是空表。"""
        if not self.skills_root.is_dir():
            return []
        out: list[SkillInfo] = []
        for entry in sorted(self.skills_root.iterdir()):
            manifest = entry / "SKILL.md"
            if not (entry.is_dir() and manifest.is_file()):
                continue
            try:
                head = manifest.read_text(encoding="utf-8", errors="ignore")[:2000]
            except OSError as exc:
                logger.warning("读取 %s 失败: %s", manifest, exc)
                continue
            out.append(
                SkillInfo(
                    name=entry.name,
                    description=_first_description(head),
                    path=str(manifest),
                )
            )
        return out

    def list_workspace_skills(self, *args: Any, **kwargs: Any) -> list[SkillInfo]:
        return self.list_skills(*args, **kwargs)

    def is_plugin_skill(self, name: str) -> bool:  # noqa: ARG002
        return False

    def is_sandbox_only_skill(self, name: str) -> bool:  # noqa: ARG002
        return False

    def set_skill_active(self, name: str, active: bool) -> None:
        logger.info("[垫片] 宿主不持久化 skill 激活状态: %s -> %s", name, active)


def _first_description(text: str) -> str:
    """取 SKILL.md front matter 里的 description，没有就取第一段正文。"""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("description:"):
            return stripped.split(":", 1)[1].strip()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith(("#", "-", "---")):
            return stripped[:200]
    return ""


__all__ = ["SkillInfo", "SkillManager", "build_skills_prompt"]
