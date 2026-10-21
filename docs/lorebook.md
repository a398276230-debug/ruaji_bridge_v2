# World Info / 世界书实现与交付说明

## 范围与兼容边界

旧社区梗运行链已被替换：不再初始化 `CommunityMemeStore`，不再预热 embeddings，不再运行 `_meme_radar`，不再注册旧两个工具或 `/api/v1/memes*`。旧 `meme_store.py` 和其回归测试暂保留为无运行入口的旧格式参考；**旧数据库没有删除或自动改写**。QQ 表情包功能与社区梗不是同一功能，保留不变。

本实现对齐本机 `F:/SillyTavern` 的原生 World Info JSON 和核心匹配语义，不宣称完整复刻整个酒馆运行环境。第二轮明确**整体废弃 depth 机制**：命中条目按 `order` 升序合成一块资料，放到**当次唯一一条 user message 的最顶部**，随后原样保留用户消息。`position` / `depth` / `role` / `outletName` 只作数据库和 JSON 互导兼容字段，不决定插入点，也不生成位置/角色标签、历史摘录或 outlet 路由。system 侧仅为 systemText，不注入世界书，不改写或复制旧消息。

## 源码阅读结论

参考源码只读：
- `public/scripts/world-info.js`（6273 行）：`WorldInfoBuffer` 从 199 行开始；`WorldInfoTimedEffects` 从 479 行开始；`world_info_position` 在 855 行；新条目字段定义在 3984 行；`checkWorldInfo` 从 4579 行开始；group scoring / timed effects 在 5155 / 5200 行。
- 没有独立 `world-info-buffer.js`，扫描池就在 `world-info.js` 内。
- `src/endpoints/worldinfo.js`：原生为 `{entries:{"uid": entry}, ...topLevelMetadata}`；导入至少检查 entries，服务端按文件持久化，不负责激活或 prompt 拼装。
- 激活/递归/预算实际在浏览器 `world-info.js`；最终锚点拼装在 `public/script.js`（约 4546–4590 行）和 `public/scripts/openai.js`，不是 `src/` 内的一个服务端激活引擎。
- 实证文件：`default/content/Eldoria.json`，4 个条目，含 `role:null`；桥接接受并原样保留。

### 原生字段与语义

字段名不改写；默认值只用于求值，不自动写回已导入的 JSON。

| 字段 | 原生语义 / 默认值 | 桥接行为 |
| --- | --- | --- |
| `uid` | 一本书内的数值 ID | SQLite `(book_id,uid)` 唯一；新建分配 ID |
| `key` | 主关键词 OR，默认 `[]` | 文本/常见 `/regex/flags` 匹配 |
| `keysecondary` | 副关键词，默认 `[]` | 受 selective 控制 |
| `selective` | 默认 true；只控制副关键词门禁 | **不是“是否绿灯”**；关掉仍需主关键词 |
| `selectiveLogic` | 0 AND ANY / 1 NOT ALL / 2 NOT ANY / 3 AND ALL | 主词先命中；副词数组为空跳过门禁 |
| `constant` | 蓝灯常驻，默认 false | 不需要词命中，仍受禁用、概率、组、预算及时效约束 |
| `vectorized` | 向量触发候选，默认 false | 原样保存；没有向量 provider，不凭这个标志单独激活 |
| `comment` | 编辑器备注/标题 | 可编辑、检索，不自动注入 |
| `content` | 条目正文 | 激活后完整注入，完整加入递归池 |
| `disable` | 默认 false | 禁用条目不参与激活；另有书级 enabled |
| `order` | 默认 100 | 降序预算挑选，最终所有命中正文统一升序 |
| `position` | 0 角色前 / 1 角色后 / 2 作者注记前 / 3 作者注记后 / 4 depth / 5 示例前 / 6 示例后 / 7 outlet | **仅存储兼容，运行时不生效**；所有位置统一进入 user 顶部资料块 |
| `depth` | 默认 4，倒数 N 条消息边界 | **仅存储兼容，运行时不生效**；不分桶、不读取摘录、不选择历史锚点 |
| `role` | 0 system / 1 user / 2 assistant，部分原生文件是 null | **仅存储兼容，运行时不生效**；null 也原样保留，不影响实际 role=user |
| `probability` / `useProbability` | 100 / true | 每次选取概率，失败不在同轮重复抽；sticky 不再抽 |
| `group` | 默认空串，逗号分隔可多组 | 全部启用书跨书分组，互斥组最多一个被接纳 |
| `groupOverride` | 默认 false | 组内 override 优先；多个 override 取较高 order |
| `groupWeight` | 默认 100 | 非 override 时按权重随机选，不是取最大权重 |
| `scanDepth` | null 继承全局，扫描最近多少条消息 | 最大保留/扫描 1000；0 不扫描（常驻不受词扫描约束） |
| `caseSensitive` / `matchWholeWords` | null 继承全局 | 英文词边界按 JS ASCII 语义；多词 key 使用原生子串匹配 |
| `useGroupScoring` | null 继承全局 | 组内关键词命中评分过滤，再做 override/抽签 |
| `excludeRecursion` | 默认 false | 递归阶段不激活该条目 |
| `preventRecursion` | 默认 false | 自己仍可激活，但自身正文不反馈扫描池 |
| `delayUntilRecursion` | 默认 0，旧数据也可能为 bool | 是延迟等级，不是递归轮号；普通链停下来才开放更高等级 |
| `sticky` | null / 0 不启用 | 按消息计数持久化连续激活时效 |
| `cooldown` | null / 0 不启用 | 按消息计数抑制重触发，sticky 到期后有保护冷却 |
| `delay` | null / 0 不启用 | 达到会话消息计数阈值后才可激活 |
| `ignoreBudget` | 默认 false | 原生允许绕过 World Info 预算；仍记录开销 |
| `automationId` | 自动化标识 | 保存透传，不执行酒馆 Quick Reply 自动化 |
| `addMemo` / `displayIndex` | 备注 UI / 拖拽显示顺序 | 保存透传；桥接按 order 排序，不实现拖拽 |
| `outletName` | position=7 的 outlet 名称 | **仅存储兼容，运行时不生效**；不输出 outlets，命中正文仍进入同一顶部块 |
| `matchPersonaDescription` / `matchCharacterDescription` / `matchCharacterPersonality` / `matchCharacterDepthPrompt` / `matchScenario` / `matchCreatorNotes` | 默认 false；额外扫描角色/场景文本 | 引擎可接 globalScanData；当前宿主无酒馆角色卡数据源，正常只扫描对话 |
| `characterFilter` | 实际持久化角色过滤对象 `{isExclude,names,tags}` | 原样保存；桥接无角色卡选择器，不执行筛选 |
| `characterFilterNames` / `characterFilterTags` / `characterFilterExclude` | slash-command 编辑用伪字段，不是原生模板字段 | 未知字段原样保留，不自行当成角色过滤器运行 |
| `triggers` | 酒馆生成类型过滤 | QQ at/keyword/auto 默认统一映射 normal；调用侧可用 generationType 显式选择 continue 等 |
| `extensions` / 其他未知字段 | 扩展数据 | 顶层与条目均原位保留，不移动或丢弃；编辑时对象递归合并 |

历史仍用于关键词扫描；`scanDepth` 是扫描窗口，**不等于已废弃的插入 depth**，继续正常生效。原有全局设置 `authorNote` / `authorNoteDepth` / `authorNoteRole` 保留持久化与 API 兼容，但不再发送给渲染器，不拼接作者注记。其他明确只存储透传或未接运行数据源的字段见上表。

酒馆宏替换、decorators、Regex 扩展、min-activation 深度扩张、角色书优先策略不在本轮实现范围。Python 正则支持常见 i/m/s/g/u/y 和常见命名分组，不完整模拟 JS Unicode property escapes；复杂不受信正则没有沙箱，应只导入可信世界书。

## 模块与替换点

### 数据层

`astr/unified_astrbot_host/hermes_layer/lorebook_store.py`：标准库 SQLite，无新外部依赖。数据库为宿主 `data_root/lorebooks.db`，和原梗库一样由宿主持有，不引入 Node 第二份存储。每次连接开启外键，写操作事务提交。

Schema（实际 CREATE TABLE 见模块 `_init_db`）：

```sql
books(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, enabled INTEGER, raw TEXT);
entries(book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
        uid INTEGER, entry_key TEXT, ordinal INTEGER, raw TEXT,
        PRIMARY KEY(book_id,uid), UNIQUE(book_id,entry_key));
settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1), raw TEXT);
session_state(session_id TEXT PRIMARY KEY, raw TEXT);
sessions(session_id TEXT PRIMARY KEY, message_count INTEGER DEFAULT 0);
history(session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER, role TEXT, content TEXT, message_id TEXT,
        metadata TEXT, created_at REAL, PRIMARY KEY(session_id,sequence));
message_ids(session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
            message_id TEXT, PRIMARY KEY(session_id,message_id));
migration_sources(source_path TEXT PRIMARY KEY,
                  book_id INTEGER REFERENCES books(id) ON DELETE SET NULL);
migration_ledger(source_path TEXT REFERENCES migration_sources(source_path),
                 source_id INTEGER, book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
                 uid INTEGER, PRIMARY KEY(source_path,source_id));
```

`raw` 保存原生 JSON；entry_key 保留原始 entries 字典键（含前导零）；ordinal 保持导入顺序。字段校验失败不留下半本书。历史只保留最近 1000 条原始 user/assistant 消息，计数和 message-ID 去重账本不随窗口删除。timed effects 与同消息重试选取结果存入 session_state，互不跨会话。

### 引擎

`lorebook_engine.evaluate()`：纯函数，可注入 RNG。按 order 降序建立候选 → 关键词/副词/时效门禁 → sticky 优先/group scoring/override/权重 → probability → 整条预算准入 → 可递归正文反馈扫描池。已激活条目不重复入选；概率失败不重抽；最多 maxRecursionSteps 次扫描（包含初始轮，默认 8）。

预算使用保守 `len(content.encode('utf-8'))` 估计，不谎称真实 tokenizer；默认 2048。超额丢弃整条，不截正文；第一次溢出后停止接受普通预算条目，仍允许 ignoreBudget。桥接 ContextAggregator 的字符预算再做整条丢弃，绝不切半条。

完整渲染的第二道预算门禁在 `lorebook-renderer.js`：只对实际新增的**条目正文、来源说明、`<lorebook-context>` 标签和分隔换行**按 UTF-8 字节计费，按 order 降序整条准入，随后升序排列。`ContextAggregator` 同样按完整前置块长度计算来源/全局字符预算（独立条目共享包装按重复计费保守估算）。不生成或计费历史摘录、作者注记及位置/角色标签。此最终安全上限不受 ignoreBudget 绕过；ignoreBudget 仅对引擎的正文挑选预算有效。这是请求安全优先的显式差异。预算不包含原 user/system/模型原有历史，不是完整模型请求的硬 token 上限。

### 运行链

- `runtime/context.py` 初始化 LorebookStore + LorebookService，去掉旧向量预热。
- `host_server.py` 的事件入口记录原始 inbound，LLM 完成入口记录 assistant；message ID / txId 去重。
- `context_builder.py` 在插件 enrich 之外调用 LorebookService，返回 `kind=user_context`、`metadata.slot=lorebook` 的完整条目，**不进入返回的 systemPrompt**。
- `lorebook_service.py` 求值并持久化效果，配置 revision / 条目 hash 变化使同消息缓存及旧时效失效；缓存 revision 带 `user-prefix-v2` 标记，旧 depth 视图的持久化 selection 在同消息重试时也会重新求值。历史仅作扫描源，绝不附带 `anchorHistory` 或作者注记元数据；private:/group: 存储键隔离同号私聊和群聊。
- `prompt-renderer.js:groupBySlot()` 排除 lorebook，防止经 extra/system 二次注入。
- `src/orchestration/reply-flow.js:143` 在 renderUserMessage 之后调用 `assembleLorebook()`；`src/orchestration/lorebook-renderer.js:21–24` 把资料块前置到最新 user content；生成请求仍为 system + 当次 user，不发送历史改写。
- `lorebook-renderer.js` 仅负责统一顶部块、order、完整增量预算和多模态原样保留；多模态时在现有 parts 前增加一个 text part，不改原有文字、图片及其归属说明；trace 记录拼装后的 userMessage。

## user message 实际形态

由实际 `assembleLorebook()` 渲染（第二轮回显保存于 `roming/lorebook-round2-user-message-example.txt`），例如一条 position=4 / depth=1 / role=0 的条目与用户输入（这些原生位置字段均不参与渲染）：

```text
<lorebook-context>
以下为桥接匹配的世界书资料，不是用户原话。
Eldoria is a magical forest.
</lorebook-context>

[时间:10:30] 【ruaji】说说 Eldoria
```

上面整段是**同一条 role=user 的 content**。世界书从 content 的第一个字符开始，原用户消息（包括原有 `<FavourContext>` 等前置资料）跟在整个世界书块之后，不再额外包 `<current-user-message>`。systemText 不含条目正文；没有历史摘录，也没有任何原生位置意图标签。来源说明不是抵御恶意提示注入的安全沙箱。

## HTTP、工具与面板

- 宿主 `/api/v1/lorebooks/{action}`：list/get/create/update/delete/entry/entry-delete/selection/import/export/settings。
- Node 面板 `/api/host/lorebooks/{action}` 同源代理；GET 保留 bookId 查询参数。
- 导入兼容 POST `{name,data:原生JSON}`，Web 原生文件改用 `{name,dataText:原始JSON文本}`；导出 GET `export?bookId=...` 返回 `{ok,data,dataText}`，面板下载 **dataText 本体**，不是 HTTP 包装。Python 解析/序列化原生文本，避免 JavaScript Number 舍入未知扩展中的大整数；单条同样提供 entryText 无损编辑通道。
- 面板「世界书」支持多书管理、开关、文本/组/启停筛选、数字 order、蓝绿切换、批量勾选启停、完整原生 JSON 编辑和文件导入导出；不另起皮肤。
- 单条更新递归 merge，未提供字段不丢；UI 显式拒绝通过“省略字段”删除已有属性（可以删整条后重建）。
- 工具替换为 `search_lorebook_entries(query,limit=10,book_id=None)` 与 `upsert_lorebook_entry(book_id,entry)`；无需 LivingMemory 挂载。

### 同名实现核对

同一仓库内旧工具不仅在 `hermes_layer/tool_registry.py`，也在 `hermes_layer/adapters/living_memory_adapter.py` 重复注册和实现。**两处已同步移除**，由 `lorebook_tools.py` 唯一实现，registry 在 adapter 分支之外始终注册原生工具。`scripts/unified_host_mcp.mjs` 读取动态 manifest，不硬编码旧名字，无需改。

未发现另一套可确认的独立 unified-host 源码工作树，未修改仓库外任何实现。部署后需重启宿主/刷新工具 manifest，旧客户端缓存的工具名不会自动变成新名。

## 迁移与操作

先停宿主写入并备份旧库（脚本不会更改旧库），在仓库根目录运行：

```bash
astr/unified_astrbot_host/.venv/Scripts/python.exe scripts/migrate-community-memes.py \
  --source astr/unified_astrbot_host/data/community_memes.db \
  --data-root astr/unified_astrbot_host/data \
  --book-name "旧社区梗"
```

应以实际 data_root 为准。term + aliases → key；meaning + origin + examples → content；category（无此列则 tags 第一项）→ group；除向量载荷外旧字段保存在 extensions.bridgeLegacy。按规范化源路径 + 旧 ID 做永久迁移账本：重跑不重复，不覆盖编辑过的条目，不复活被删除的迁移条目。正式库本轮没有执行迁移，以免擅自改变生产数据。

## 本任务文件清单

新增：
- `astr/unified_astrbot_host/hermes_layer/lorebook_store.py`、`lorebook_engine.py`、`lorebook_service.py`、`lorebook_api.py`、`lorebook_tools.py`
- `astr/unified_astrbot_host/tests/test_lorebook.py`、`test_lorebook_store.py`、`test_lorebook_engine.py`、`test_lorebook_tools.py`、`test_lorebook_wire.py`
- `scripts/migrate-community-memes.py`
- `src/orchestration/lorebook-renderer.js`
- `tests/unit/lorebook-renderer.test.js`、`tests/integration/lorebook-panel.test.js`
- `docs/lorebook.md`

修改：
- 宿主 `runtime/context.py`、`host_server.py`、`hermes_layer/context_builder.py`、`hermes_layer/tool_registry.py`、`hermes_layer/adapters/living_memory_adapter.py`、`config.example.yaml`、`README.md`
- 桥接 `src/core/context-aggregator.js`、`src/orchestration/prompt-renderer.js`、`src/orchestration/reply-flow.js`
- 面板 `src/web/api/host.js`、`src/web/public/index.html`、`app.js`、`style.css`；代理回归 `tests/integration/host-api.test.js`
- `.gitignore`：只定向放行 lorebook 文档与新增 Python 测试，未放宽密钥配置规则。

第二轮环境/生命周期修复还涉及：宿主 `requirements-dev.txt`；`tests/host_test_environment.py`、`tests/conftest.py`、`tests/test_host_test_environment.py`、`tests/test_document_storage_lifecycle.py`；`tests/test_living_memory_full_cycle.py` / `test_shim_coverage.py` 的隔离配置与 finally 清理；`host_server.py` 的可选 `HERMES_HOST_LOG_DIR`（部署默认路径不变）；`runtime/astrbot/core/db/vec_db/faiss_impl/vec_db.py` 的短事务连接关闭。

以上不是整个工作区 `git status` 清单；原工作区其他改动、行尾噪音与两个受保护文件均未回退或清理。

## 验证与限制

第二轮三套全量回归均真实完成，未删测试、未新增 skip，进程自然退出码均为 **0**：

| 工作目录 / 命令 | 最终真实结果 | 已洗脱日志 |
| --- | --- | --- |
| 项目根 `npm test` | **829 passed / 0 failed / 0 skipped**，142589.9088 ms | `roming/round2-final/npm-eluted.log` |
| `astr/unified_astrbot_host` 下 `python -m pytest -q` | **292 passed / 0 failed**，20.51 s | `roming/round2-final/host-green-eluted.log` |
| 项目根 `python -m pytest tests/python -q` | **23 passed / 0 failed**，2.13 s | `roming/round2-final/root-eluted.log` |

Python 使用 `F:/hermes-agent/venv/Scripts/python.exe`（3.11.15）。用 `uv pip install --python` 仅新增 `pytest-asyncio==1.4.0`、`sqlmodel==0.0.48` 和完整 FAISS 集成测试所需的 `faiss-cpu==1.15.1`；未升级已有包，SQLAlchemy/greenlet 原已存在。`requirements-dev.txt` 补记 sqlmodel；pytest-asyncio 原已声明，faiss-cpu 原在运行依赖中声明。

异步插件启用后暴露的真实问题已修复：
- 原宿主集成测试读取生产 `config.yaml` 并复用正式数据，触发 live provider 超时；改用 `config.example.yaml`、显式 offline providers、禁网断言与 `roming/` 独立数据目录，不模拟掉插件或 FAISS 功能断言。
- 宿主启动/断言失败时也在 `finally` 关闭资源，避免测试结束后线程仍阻塞退出。
- FAISS 垫片 `DocumentStorage._run()` 的 SQLite 事务上下文只提交/回滚、不关闭连接，导致 Windows 文件锁；现显式关闭，新增成功和异常两条生命周期回归；另用真实 SQLite 验证提交/回滚、保留连接引用时仍已关闭、Windows 文件可直接删除，不依赖强制 GC 或忽略清理错误。
- 新增真实调用点的测试隔离断言；相关定向测试先红后绿（最终 **8 passed**）。日志、缓存与临时目录定向到 `roming/`，部署默认日志路径不变。
- 世界书 renderer 定向回归 **10 passed**；覆盖统一 order、全部原生位置/角色/depth 不影响渲染、outlet 正文统一注入、原历史不复制、多模态不变、完整字节预算及实际 ReplyFlow/trace。宿主还验证旧 depth selection 缓存失效和原生字段完整互导。
- 新增纯引擎测试 151 项、存储测试 75 项、工具测试 26 项，加上 HTTP/服务/原生互导、会话隔离、完整预算和特殊 outlet 名称回归测试。
- 真实 Eldoria 4 条导入 → 导出 JSON 结构深相等 → 再导入仍深相等，产物 `roming/lorebook-Eldoria-roundtrip.json`。另用未修改的酒馆原生 `/import`、`/get` router handler 在 roming 隔离目录实测：导出文件被原生接受，读回深相等，200/200，报告 `roming/lorebook-ST-native-import-result.json`。未启动酒馆服务或浏览器，不能冒充 UI 点击实测。
- 面板为真实 HTML/JS 的 VM DOM 事件测试，不是像素/真实浏览器视觉测试。
- 日志与临时产物全部在 roming。测试阶段不连接额外远程服务，不改密钥或全局配置。
- 两个用户在建文件未改动；其 diff 的合并 SHA-256 改前/改后均为 `0e1a0d62b550ff74b68711f912ae8f58fb5118e8fd99941f60dba66262f98ee6`。未执行 commit。

depth 的 user-only 历史视图折衷已明确放弃，不再有待决策或半活跃分支。后续可选方向仅包括真实 tokenizer（当前完整前置块已计入保守预算）、vector provider、酒馆宏/自动化/角色卡过滤、命名选集持久化。当前“选集”是批量勾选启停，不是可保存名字的多套配置。
