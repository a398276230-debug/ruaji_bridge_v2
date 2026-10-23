# RUAJI Bridge v2 🐭

> 高性能、事件驱动型 QQ ↔ 大语言模型 (LLM) 智能交互桥接网关与运维中枢。

---

## ⚖️ 开源许可与源码获取声明（License & Corresponding Source）

本项目由**自有桥接/宿主代码**与 `astr/` 目录下内嵌的**第三方 AstrBot 插件**共同组成，采用如下分层许可结构：

1. **自有代码（MIT License）**：
   本仓库除 `astr/astrbot_plugin_*` 以外的自有代码（包括 `src/`、`scripts/`、`tests/` 以及 `astr/unified_astrbot_host/` 统一宿主垫片层）采用 **[MIT License](LICENSE)** 授权。
2. **内嵌第三方插件及各自许可证**：
   - [`astr/astrbot_plugin_Favour_Ultra`](astr/astrbot_plugin_Favour_Ultra)（作者：糯米茨 / `nuomicici`）：**[Apache License 2.0](LICENSES/Apache-2.0.txt)**（本地修改见 [LOCAL_CHANGES.md](astr/astrbot_plugin_Favour_Ultra/LOCAL_CHANGES.md) 与 [PATCHES.md](astr/astrbot_plugin_Favour_Ultra/PATCHES.md)）
   - [`astr/astrbot_plugin_group_chat_plus`](astr/astrbot_plugin_group_chat_plus)（作者：`Him666233`）：**[GNU AGPL v3.0](LICENSES/AGPL-3.0.txt)**（本地修改见 [LOCAL_CHANGES.md](astr/astrbot_plugin_group_chat_plus/LOCAL_CHANGES.md)）
   - [`astr/astrbot_plugin_livingmemory`](astr/astrbot_plugin_livingmemory)（作者：`lxfight`）：**[GNU AGPL v3.0](LICENSES/AGPL-3.0.txt)**（本地修改见 [LOCAL_CHANGES.md](astr/astrbot_plugin_livingmemory/LOCAL_CHANGES.md)）
   - 完整第三方组件来源、版本与合规说明详见 **[THIRD_PARTY.md](THIRD_PARTY.md)** 与 **[NOTICE](NOTICE)**。
3. **整体分发与网络交互合规（Combined Work under AGPL-3.0）**：
   由于本项目通过 `astr/unified_astrbot_host` 以进程内（in-process）方式加载并运行上述 AGPL-3.0 插件，且作为 QQ 机器人通过网络向远程用户提供交互服务，**当本项目作为整体打包分发或对外提供网络服务时，整体组合作品适用 [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSES/AGPL-3.0.txt)**。
4. **完整对应源码获取地址（AGPL-3.0 Section 13 — Remote Network Interaction）**：
   根据 AGPL-3.0 第 13 条规定，任何通过网络与本机器人交互的用户均可直接从本公开仓库免费获取完整对应源码（Corresponding Source，含自有代码、统一宿主及经本地修改后的全部第三方插件源码）：
   👉 **https://github.com/a398276230-debug/ruaji_bridge_v2**

---

## ✨ 核心特性

- 🚀 **双总线解耦架构**：
  - **EventBus**：异步生命周期事件广播（`message.received`, `llm.request`, `llm.response`, `message.sent`），轻量高效，零阻塞主链路。
  - **CapabilityBus**：能力调用总线，支持优先级调度、超时控制、熔断保护（CircuitBreaker）与平滑降级。
- 🌊 **自然流式切句与后处理管线**：
  - 智能切句：严格基于自然空行分段，杜绝数字小数、URL 与英文缩写被误切断。
  - 洋葱模型中间件（Middleware Pipeline）：好感度标签剥离、媒体提取、表情包解析、Markdown 安全清洗、拟人化打字延迟。
  - 私聊开始处理后，每 0.5 秒刷新 QQ 原生「正在输入中」，覆盖上下文读取、模型处理与分段投递，完成、失败或打断时停止上报，提示由 QQ 自行清除。兼容 [LLBot 7.12.3+](https://llonebot.apifox.cn/api-449484306) 与 NapCat，参考 [input_state_by_nc](https://github.com/ctrlkk/astrbot_plugin_input_state_by_nc) 的刷新方式。默认开启，可在「客制化设置 → NapCat / LLBot 协议端与运行模式」关闭，或配置 `napcat.inputStatusEnabled: false`。群聊、影子模式和测试模式不触发，接口失败时本轮跳过。
- 🖼️ **表情包图库与 AI 视觉打标**：
  - 自动收集群聊表情包并异步调用视觉模型（GPT-4o-mini / Gemini-Flash 等）分析画面文字梗并自动打标入库。
  - 支持 `&&meme:ID&&` 精准引用与 `[表情:标签]` 语义模糊检索。
- 💬 **上下文预算与群聊智能决策**：
  - 本地滑窗与消息去重，800ms 快速连发消息防抖合并。
  - 严格的字符预算控制（全局与单源预算分配），防止长文本撑爆上下文。
- 🛡️ **离线沙箱与安全隔离**：
  - **离线沙箱**：在控制台中构造虚拟消息，单步可视化展开规范化、上下文聚合、Prompt 渲染与模型回复。
  - **私聊白名单**：严格防盗刷与敏感隔离，非白名单私聊前置静默丢弃。
- 🎛️ **内置 Web 运维与客制化控制台**（默认 `:29998`）：
  - **系统大盘**：服务探活、延迟分布、裁决统计与熔断状态监控。
  - **全链路追踪**：按 ID/内容检索消息树状时序与各步骤详细耗时。
  - **好感度看板**：可视化查看好感度阶段与手动微调。
  - **客制化设置**：无需重启，直接在网页上修改模型、主人QQ、唤醒词、识图模型与协议端配置，支持一键连通性测速。
- ⏰ **后台任务异步唤醒回推**（`wakeDelivery`，见 [docs/hermes-async-wake.md](docs/hermes-async-wake.md)）：
  - `terminal(background=true, notify_on_complete=true)` / `watch_patterns` 跑完后，Hermes 会把完成通知自投递成一次唤醒轮写回会话 transcript，桥接轮询取回并推回它原本所在的 QQ 群 / 私聊——不再需要人追问一句"好了吗"。
  - `delegate_task(background=true)` 跑完后 Hermes 只落一条写给 agent 的内部汇报行、**不会**起唤醒轮；桥接把它当作锚点，以同一会话自投递一次唤醒轮让瑞姬用自己的口吻转述（`wakeDelivery.delegationRelay`，只发极简提示、不重复内嵌报告正文），内部汇报行永不原样推给 QQ。
  - 需要两侧同时开：Hermes `platforms.api_server.extra.async_delivery: true` + 本侧 `wakeDelivery.enabled: true`。游标与去重记录落盘，桥接重启只补发没推过的通知，绝不复读。

---

## 🚀 快速开始

### 1. 环境准备
- **Node.js** >= 18.0.0 (推荐 Node.js 20+)
- **NapCat OneBot**（提供 QQ 协议端 WebSocket / HTTP 服务，默认 `ws://127.0.0.1:3001`）
- **大模型端点**（本地 Hermes 网关 `:8642`、或任意 OpenAI 兼容的 API 服务）

### 2. 安装依赖
```bash
git clone <repository-url>
cd ruaji_bridge_v2
npm install
```
*(本项目遵循极简依赖设计，仅依赖原生 ESM 与 `ws` 库)*

### 3. 启动并配置

```bash
npm start
```

启动后，在浏览器中打开运维控制台：
👉 **http://127.0.0.1:29998/**

点击顶部的 **「客制化设置」** 页面即可直接进行可视化配置：
- 填入你的 **主人 QQ 号** 与 **机器人 QQ 号**
- 按需填入 **私聊白名单**（只有名单内的 QQ 能私聊触发；主人恒放行，**留空即"仅主人可私聊"**）
- 填入 **主对话模型 API 地址** 与 **API Key**
- 设置 **表情包识图模型**（如 `gpt-4o-mini` / `gemini-2.5-flash`）
- 点击 **「💾 保存并应用配置」** 即可生效！

*(亦可将 `bridge.config.example.json` 复制为 `bridge.config.json` 进行手动文件配置)*

---

## 🧭 控制台功能概览

| 功能页面 | 说明 |
| :--- | :--- |
| **系统大盘** | 查看 NapCat/LLBot、LLM 与统一宿主的健康状态、实时吞吐量与 Middleware 延迟 |
| **全链路追踪** | 查看任意一条消息从接收、裁决、上下文聚合、LLM 推理到发送的完整时序树 |
| **离线沙箱** | 在不连接真实 QQ 的情况下输入测试消息，单步调试 Prompt 渲染与输出 |
| **好感度** | 查看群友的好感度阶梯与互动记录，支持管理员手动增减与冷暴力管理 |
| **群友画像** | 卡片化展示群友性格画像与雷区提示，支持手动重分析 |
| **表情包** | 浏览本地表情包图库，测试 Tag 检索与引用效果 |
| **客制化设置** | 图形化配置身份、模型、协议端、快速应答、识图打标与影子模式（统计画像模仿指定群友说话），支持一键测速 |

---

## 🛠️ 工具进度提示配置（默认关闭）

顶层 `toolProgress` 控制工具调用的实时进度消息，默认关闭。支持 Hermes `hermes.tool.progress` 和标准 OpenAI 流式 `tool_calls`；非流式响应只能在响应返回时提示，无法提供执行中的实时进度。提示沿用本轮输出队列，不参与好感度/评分处理，也不会占用后台通知的回复引用锚点。
默认值如下：

```json
"toolProgress": {
  "enabled": false,
  "groupWhitelist": [],
  "privateEnabled": false,
  "privateWhitelist": [],
  "maxMessagesPerTurn": 8,
  "minIntervalMs": 1500
}
```

- **主动启用**：`enabled: true` 为总开关；群聊还必须在 `groupWhitelist` 中明确列出群号，空列表不允许任何群。
- 私聊：总开关开启后，`privateEnabled: true` 允许所有私聊显示进度；否则仅允许 `privateWhitelist` 明确列出的 QQ 用户，空列表不允许任何私聊。
- 这些名单**不改变原有回复资格**，不会绕过身份白名单、唤醒、频控等既有门禁，也不会让原本不应回复的消息触发回复。
- 进度提示仅展示**工具名称**，不展示工具参数或工具输出。
- 每轮最多 `maxMessagesPerTurn` 条提示（默认 8，须为 1–100 的整数）；同轮提示间冷却时间为 `minIntervalMs` 毫秒（默认 1500，须为非负有限数字，0 表示无冷却）。
- `enabled`、`privateEnabled` 必须为 JSON 布尔值；两个名单必须为正整数 QQ ID 的字符串或数字数组（不接受布尔值）。建议用字符串填写 QQ ID。

## 🚦 频控（限速名单）

名单内用户在滑动窗口内的回复条数达到上限后**静默忽略**（不回复、不排队、不触发模型），
用来挡住「AI 与 AI 互刷」和恶意刷屏。名单与额度**全部热生效**，面板保存即应用，无需重启。

`identity.rateLimitUsers` 支持四种写法（可混用，也可以在配置文件里写完整对象）：

| 写法 | 含义 |
| :--- | :--- |
| `"10000002"` | 用全局默认额度（`decision.rateLimit`） |
| `"10000003:2"` | 单独额度：窗口内最多 2 条 |
| `"10000004:2:600000"` | 单独额度 + 单独窗口：10 分钟内最多 2 条 |
| `"10000005:block"` / `"10000005:0"` | 严格拦截：永不回复 |

```json
"identity": {
  "rateLimitUsers": [
    "10000002",
    { "userId": "10000003", "maxReplies": 2 },
    { "userId": "10000004", "maxReplies": 2, "windowMs": 600000 },
    { "userId": "10000005", "block": true }
  ]
},
"decision": {
  "rateLimit": { "maxReplies": 5, "windowMs": 300000, "applyToPrivate": false }
}
```

说明：

- 判定是**滑动窗口计数**，计的是**实际发出的回复条数**（模型跑失败、被主人打断不计）。
- 入队时与真正生成前各校验一次：在途生成期间排队的消息，如果轮到自己时额度已用满，直接丢弃，
  不会因为「先排队后超限」绕过限速。
- 宿主主动接话（`handleProactive`）同样受频控约束。
- `applyToPrivate` 默认 `false`：私聊本来就要过白名单门禁，不把频控顺带压到私聊上。
- 名单外用户完全不受影响。

---

## 🧠 统一灵魂与 SOUL.md 人格规范

系统与统一宿主（AstrBot 插件生态）通过直连 Hermes 的 `SOUL.md` 实现全生命周期人格统一与沙箱隔离。

### 核心规范要求：
为保证人格能够在 **Hermes Agent**、**GCP（读空气决策）** 与 **LivingMemory（记忆图谱）** 之间完美同步与安全共生，系统要求 `SOUL.md` 中**必须包含 `<Self-awareness>...</Self-awareness>` 结构化标签**：

```markdown
<Self-awareness>
（这里填写角色的核心人设与自我认知）
</Self-awareness>

<extra_command>
...（外围系统级指令）
</extra_command>
```

- **读隔离**：统一宿主底层垫片会自动正则提取 `<Self-awareness>` 内部作为 AstrBot 插件的人格核心（如 GCP 读空气决策），严格隔离标签外的系统级指令；
- **写隔离**：系统精准只读取 `<Self-awareness>` 内部，绝不污染或破坏外围指令，实现真正的人格打通与安全共生。

---

## 🔌 Hermes MCP (Model Context Protocol) 扩展

本项目提供了标准的 Model Context Protocol (stdio MCP) 桥接器，允许将统一宿主（AstrBot 生态能力：长期记忆检索、知识图谱查询、记忆写入等）作为外部原生工具无缝接入 **Hermes Agent**、Claude Code 或任何支持 MCP 协议的智能体。

### 1. 架构组件说明

1. **MCP 桥接适配器 (`scripts/unified_host_mcp.mjs`)**：
   - 基于 Node.js 实现的轻量级 stdio MCP 服务器（JSON-RPC 2.0 协议）；
   - 负责与 Hermes Agent / Host 进行生命周期握手、能力清单宣告与工具调用双向转发。
2. **后端服务与工具端点 (`astr/unified_astrbot_host`)**：
   - 宿主源码：`astr/unified_astrbot_host/hermes_layer/tool_registry.py`；
   - 在线端点：`http://127.0.0.1:8870/api/v1/tools`（动态工具清单）与 `http://127.0.0.1:8870/api/v1/tools/call`（工具执行网关）；
   - 静态离线清单：`unified_host_tools.json`（宿主启动时自动同步导出，在网络或端口尚未就绪时提供安全 Fallback）。

### 2. Hermes Agent 注册配置

在 Hermes 配置文件（`~/.hermes/config.yaml`）的 `mcp_servers` 节点下注册该服务：

```yaml
mcp_servers:
  unified-host:
    command: C:\Program Files\nodejs\node.exe
    args:
      - F:\hermescache\hermes-workspace
uaji_bridge_v2\scripts\unified_host_mcp.mjs
    env:
      UNIFIED_HOST_URL: http://127.0.0.1:8870
      UNIFIED_HOST_MANIFEST: F:\hermes-agent\unified_host_tools.json
    enabled: true
    timeout: 60
```

配置后 Hermes Agent 在启动或会话中即可自动发现并调用 `recall_long_term_memory`、`memorize_long_term_memory`、`query_knowledge_graph` 等工具。

---

## ⚖️ 免责声明与开源致谢

1. **开源致谢**：本项目及 `astr/` 目录中集成了 AstrBot 生态社区的优秀开源组件及二次开发适配（包含但不限于 `astrbot_plugin_group_chat_plus`、`astrbot_plugin_livingmemory` 与 `unified_astrbot_host` 等）。所有第三方开源代码与资源的知识产权及著作权归原作者所有。
2. **学习与交流**：本项目仅供个人技术研究、自动化架构探索及非商业学习交流使用。
3. **免责条款**：使用者在部署及使用本系统时，应严格遵守当地法律法规以及相关平台的服务协议。因不当使用、二次分发或第三方服务政策变更造成的任何纠纷与损失，原插件作者及本项目维护者概不承担任何直接或间接法律责任。

---

## 管理员介入

管理员的直接触发消息经过只读门禁后，可以使用 `【管理员介入】` 前缀 redirect 纠偏。当前轮仍按原回复对象结算好感度，不另行评价介入者。auto 消息始终不介入。

auto 不注入、不结算好感度，但仍检查触发用户的自动拉黑和冷暴力状态。被拦截的 auto 静默结束，不调用模型，也不发送冷暴力提示；正常用户或冷暴力已过期时继续按原规则接话。

门禁拒绝或检查失败时不注入、不打断；redirect 未被接受时回退正常回复流程。私聊白名单、限流仍在介入前执行。桥接和统一宿主需一同重启加载此功能，旧宿主缺少预检接口时会拒绝管理员介入。

redirect 回退硬打断时，桥接立即停止旧回复投递，并主动调用 Hermes `/v1/chat/stop`，无需只等 SSE 断连被上游发现。stop 请求返回或超时（2.5 秒）前，同会话替代轮次等待；请求失败时仍保留本地取消。日志的 `serverStopAcknowledged` 表示接口已确认处理请求，不代表所有工具已退出。此优化不改变 Hermes 启动窗口内可能拒绝 redirect 的行为。

宿主 `POST /api/v1/reply/preflight` 只调用插件的只读 `check_reply_gate`，不执行上下文注入或结算。Favour 的普通注入和预检共用自动拉黑、冷暴力检查；新增带门禁的插件也须实现该接口。未配置宿主且未启用 Favour 时，仅检查本地冷暴力。

## 📄 许可证

- **自有代码**（`src/`、`scripts/`、`tests/`、`astr/unified_astrbot_host/`）：[MIT License](LICENSE)
- **内嵌第三方插件**：
  - `astr/astrbot_plugin_Favour_Ultra`：[Apache License 2.0](LICENSES/Apache-2.0.txt)
  - `astr/astrbot_plugin_group_chat_plus`：[GNU AGPL v3.0](LICENSES/AGPL-3.0.txt)
  - `astr/astrbot_plugin_livingmemory`：[GNU AGPL v3.0](LICENSES/AGPL-3.0.txt)
- **整体分发与远程网络交互服务**：适用 **[GNU AGPL v3.0](LICENSES/AGPL-3.0.txt)**（详见顶部「开源许可与源码获取声明」、[THIRD_PARTY.md](THIRD_PARTY.md) 及 [NOTICE](NOTICE)）
- **完整源码获取地址**：https://github.com/a398276230-debug/ruaji_bridge_v2

