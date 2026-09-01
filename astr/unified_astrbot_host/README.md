# 统一 AstrBot 宿主

一个 Python 进程里同时跑三个 AstrBot 插件，对外只暴露一组 HTTP 接口。
插件源码一个字都没改 —— 它们仍然是为真正的 AstrBot 写的，这里提供的是一层
**足够骗过它们**的运行时垫片。

```
                    ┌──────────────────────────────────────────┐
Bridge v2  ──HTTP──▶│  127.0.0.1:8870                          │
Hermes Agent ─────▶ │  ┌────────────────────────────────────┐  │
                    │  │ LivingMemory │ SelfLearning │ GCP   │  │  ← 同一进程
                    │  └────────────────────────────────────┘  │
                    │  runtime/astrbot/  ← 垫片（假的 AstrBot） │
                    └──────────────────┬───────────────────────┘
                                       │ GatewayClient（唯一出站口）
                          gemini-proxy :8868 / youzi.today
```

## 为什么是一个进程

三个插件在旧桥接里是三个独立服务（:8876 / :8877 / :8878），各自一份记忆、
各自一个 Provider 连接池。合到一个进程里换来三件事：

* **插件间能直接共享 `graph_store` 与 `meme_store`**（同一个 Python 对象，
  不是 HTTP）。图谱与社区梗库的联动对齐就靠这个。
* **一份记忆库**。`memory_scope_mode: global` 之下，群里学到的与 Hermes 记下的
  是同一批数据。
* **一个出站连接池**。记忆摄取一次要发几十个 embedding 请求，旧实现每次
  新建 `AsyncClient`。

## 跑起来

```bash
.venv/Scripts/python host_server.py --self-check   # 只装配，打印健康快照与工具清单
.venv/Scripts/python host_server.py                # 常驻，监听 :8870
```

必须用 `.venv/Scripts/python`（3.11）。PATH 上的 `python` 是 hermes-agent 的
venv，没有 faiss。

启动日志里这类行是**预期的降级提示**，不是错误：`No module named 'quart'`
（插件自带的 web 页面）、`scikit-learn未安装`（退回基础统计）、
`服务 xxx 没有stop方法`。

## 接口

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 分层就绪。`?probe=1` 才会真打三个上游端点 |
| `POST /api/v1/events` | 一条群消息交给记忆与学习插件摄取 |
| `POST /api/v1/decision` | 问 GCP 要不要回：`direct` / `auto` / `ignore` + `reason` |
| `POST /api/v1/context/enrich` | 取三个插件的上下文块 |
| `GET /api/v1/tools` | 四件 Hermes 工具的清单 |
| `POST /api/v1/tools/call` | 调用一件工具 |

只监听 127.0.0.1，因为**这些端点没有任何鉴权**：谁能连上就能读全部长期记忆、
能往里写记忆。改成 `0.0.0.0` 之前请先想清楚谁会连上来。

`/api/v1/events` 刻意**不**广播给 GCP —— `AdapterMessageEvent` 上挂着 GCP 完整的
决策+生成+发送流水线，而决策已经由 `/api/v1/decision` 单独问过了。两边都跑会
把同一条消息决策两次（结果还可能不同，概率是随机的），白烧一次 LLM 调用，
而影子模式下这条回复被丢弃。

## enrich 为什么分两阶段

GCP 保留第三方 prompt 的做法是 diff：拿自己动手前后的 `system_prompt` 做差集
（`main.py:10674`，priority=-1）。也就是说它**必须最后跑，而且必须看得见别人的
输出**。所以：

1. LivingMemory 与 SelfLearning 并发，各拿一份 `ProviderRequest` 的深拷贝
   （共用一个对象会串味，那种 bug 只在并发下出现且不可复现）；
2. 合并两者的 `system_prompt`，再串行交给 GCP。

## 目录

```
bootstrap.py          sys.path 摆位。必须在任何 astrbot import 之前
host_server.py        HTTP 面 + 进程入口
config.yaml           全部配置，含每个非默认值的理由
runtime/astrbot/      垫片：Star / Context / Provider / EventType …
runtime/context.py    UnifiedContext —— 宿主的全部可变状态
plugins_mount/        插件装载与 handler 重绑
hermes_layer/
  gateway_client.py   唯一出站口（chat / embedding / rerank）
  contracts.py        InboundMessage
  decision.py         DecisionEngine → direct/auto/ignore
  context_builder.py  两阶段 enrich
  tool_registry.py    四件 Hermes 工具
```

### 两个容易踩的点

**handler 重绑。** `@filter.*` 装饰器在**类体执行时**就把函数注册进全局
`star_handlers_registry`，那时还没有实例，注册进去的是未绑定函数。
`plugins_mount/loader.py` 在实例化之后用 `functools.partial(raw, instance)`
补上 `self`。

**命名空间包。** LivingMemory 与 GCP 没有 `__init__.py`，所以要
`import <pkg>.main` 而不是 `import <pkg>`。

### 改插件之前先读这篇

`docs/PLUGIN_PIPELINE.md` —— 三个插件是怎么接进数据流的：接缝表（桥接事件/能力 →
宿主端点 → EventType → 具体钩子）、五个必踩的坑、以及给一个钩子接上数据流的配方。
**垫片定义了 16 种 EventType，宿主只调用其中 3 种** —— 挂在其余 13 种上的钩子是死的，
不报错也不执行。动手前先去那张表上确认。

### 数据落点

| 谁 | 写到哪 | 由谁决定 |
| --- | --- | --- |
| 宿主自身、LivingMemory、GCP | `data/`（`plugin_data/<包名>/`） | `host.data_dir` → `rebind_data_root()` |
| SelfLearning | `F:\harness\self_learning_data` | config.yaml 的 `Storage_Settings.data_dir` |

SelfLearning 不跟 `host.data_dir` 走，是因为它的语料库（`messages.db`，
`raw_messages` 两千多条）本来就在那个绝对目录里，而不在宿主目录下。

它原来的默认值是 `./data/plugin_data/astrbot_plugin_self_learning` ——
**cwd 相对**，而 `plugins_mount/loader.py` 会把 `_conf_schema.json` 的默认值
合进插件配置，于是这条相对路径走的是 `main.py` 里「用户自定义数据路径」那一支
（`os.path.abspath` 按 cwd 解析），**绕过 `rebind_data_root`**。后果不是报错：
从宿主目录起进程和从别处起进程各写一份数据，两份都"看起来正常"，只有比对
mtime 才发现散落。schema 默认值已改成空串（= 跟随宿主数据目录），
插件 `config.py` 的兜底值改成绝对路径，真正的绑定收在 config.yaml 一处。

要换目录就设 `SELF_LEARNING_DATA_DIR` —— config.yaml 与插件兜底读的是同一个变量。

## 测试

```bash
.venv/Scripts/python tests/test_living_memory_full_cycle.py   # 37/37
.venv/Scripts/python tests/verify_hermes_tools.py             # 43/43
.venv/Scripts/python tests/smoke_http.py                      # 需要宿主已在跑
```

`test_living_memory_full_cycle.py` 是 LivingMemory 那条「未跑满完整链路」的答卷：
摄取 10 条群消息 → 原子分类 + SQLite/FAISS 落盘 → 混合检索与 RRF 融合 →
时间推进与生命周期 → 整合 + 图谱。LLM 是脚本化的（离线网关的 chat 只保证
形状对，用它测抽取只能证明"降级路径不炸"），**embedding 没有 stub** ——
离线网关用哈希词袋 + CJK bigram 合成向量，余弦相似度是真的。

两个测试都往 `data/.fullcycle` / `data/.verify` 写，跑完删掉。生产记忆库
（`data/plugin_data/`）零改动。

`verify_hermes_tools.py` 会装 SelfLearning，所以它额外把
`Storage_Settings.data_dir` 也改到 `data/.verify/self_learning`
（`_isolate_self_learning()`）—— 少了这一步，一次验收就会往上面那个真实语料库
里建表、刷空图谱，而且不报错。全周期测试直接把 SelfLearning `enabled: false`，
不需要这层保护。

## 已知的插件缺口

`AtomStatus.DORMANT` 在枚举里定义了，但**全仓没有任何代码写入它** ——
`expire_stale_atoms()` 只做 `active → expired`。状态本身是可用的
（`search_fts` 过滤 `status='active'`，dormant 会被正确排除），
但没有调度器会把它置上。全周期测试第 3 步是手动置位验证的，并在输出里说明了
这一点。要真正拿到 `active ➔ dormant ➔ expired` 三段生命周期，
需要在插件里补一条规则 —— 那属于改业务代码，不在「只做接口对接」范围内。

## 红线

* 影子模式 `shadow_mode: true`：宿主不主动投递任何消息，只回答询问。
  `StarTools.create_message` / `create_event` 直接抛 `NotImplementedError`。
* `providers.mode: offline` 时不产生任何出站流量。测试脚本强制走这条路。
* 密钥只认环境变量名（配置里写 `api_key_env`），不进配置文件、不进日志、
  不进导出的工具清单 —— `verify_hermes_tools.py` 会检查这一条。
* `F:\hermescache\hermes-workspace\sideria_bridge_full_pack\` 是生产备份，
  只读。

## live 模式的一个雷

httpx 默认 `trust_env=True`，会读 Windows 注册表里的系统代理，
**连 `127.0.0.1` 也走代理** —— 表现是本地服务明明活着却返回 502 空 body。
`gateway_client.py` 已经关掉了（`trust_env=False`），切 live 打本地
gemini-proxy `:8868` 时如果换了 HTTP 客户端，记得同样处理。
