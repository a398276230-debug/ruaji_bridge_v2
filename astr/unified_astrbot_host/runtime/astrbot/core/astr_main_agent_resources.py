"""astrbot.core.astr_main_agent_resources —— 主 Agent 的提示词常量。

GCP 只用其中一个（main.py:11014）：

    if TOOL_CALL_PROMPT not in req.system_prompt:
        req.system_prompt += f"\\n{TOOL_CALL_PROMPT}\\n"

那个 `not in` 判断意味着字符串必须与上游**逐字一致** —— 否则同一段约束会被
重复追加，system prompt 里出现两份互相打架的工具调用规范。所以这里是照抄。
"""

TOOL_CALL_PROMPT = (
    "When using tools: "
    "never return an empty response; "
    "briefly explain the purpose when starting a new type of task, but not before every tool call; "
    "follow the tool schema exactly and do not invent parameters; "
    "keep the conversation style consistent."
)

TOOL_CALL_PROMPT_SKILLS_LIKE_MODE = (
    "You MUST NOT return an empty response, especially after invoking a tool."
    " Before calling any tool, provide a brief explanatory message to the user stating the purpose of the tool call."
    " Tool schemas are provided in two stages: first only name and description; "
    "if you decide to use a tool, the full parameter schema will be provided in "
    "a follow-up step. Do not guess arguments before you see the schema."
    " After the tool call is completed, you must briefly summarize the results returned by the tool for the user."
    " Keep the role-play and style consistent throughout the conversation."
)

__all__ = ["TOOL_CALL_PROMPT", "TOOL_CALL_PROMPT_SKILLS_LIKE_MODE"]
