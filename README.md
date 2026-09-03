# RUAJI Bridge v2 🐭

> 高性能、事件驱动型 QQ ↔ 大语言模型 (LLM) 智能交互桥接网关与运维中枢。

---

## ✨ 核心特性

- 🚀 **双总线解耦架构**：
  - **EventBus**：异步生命周期事件广播（`message.received`, `llm.request`, `llm.response`, `message.sent`），轻量高效，零阻塞主链路。
  - **CapabilityBus**：能力调用总线，支持优先级调度、超时控制、熔断保护（CircuitBreaker）与平滑降级。
- 🌊 **自然流式切句与后处理管线**：
  - 智能切句：严格基于自然空行分段，杜绝数字小数、URL 与英文缩写被误切断。
  - 洋葱模型中间件（Middleware Pipeline）：好感度标签剥离、媒体提取、表情包解析、Markdown 安全清洗、拟人化打字延迟。
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
      # Bridge 运维面板地址，search_memes 等本地自有工具据此检索；改过 web.port 时必须同步
      RUAJI_V2_WEB_BASE_URL: http://127.0.0.1:29998
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

## 📄 许可证

MIT License
