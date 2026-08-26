"""astrbot —— 统一兼容垫片的根包。

这不是 AstrBot，是一层**刚好够三个插件跑起来**的兼容层。

为什么要有它：GCP / SelfLearning / LivingMemory 三个插件都是为 AstrBot 写的，
它们 import 的是 `astrbot.api.star.Context`、`astrbot.api.event.filter` 这些
框架符号。要在 Hermes 侧同进程跑它们，只有两条路 —— 把插件改成不依赖 AstrBot
（等于分叉维护三份上游代码），或者提供一层符合 AstrBot 契约的垫片。选了后者：
插件源码保持零修改，上游更新可以直接覆盖。

垫片的接口是照着 `F:\\harness\\reference document\\AstrBot` 的真实源码抄的签名，
但实现一律取最小可用集。凡是三个插件用不到的分支，这里一概不实现；
需要时按真实源码补，不要凭想象扩展。

与三个插件各自 `make_shim.py` 生成的旧垫片的区别：
  1. 旧垫片一式三份，同一个 Context 在三个进程里各有一份状态，插件之间只能
     靠 HTTP 互相探测。这里只有一份 UnifiedContext，插件在内存里直接看见彼此。
  2. 旧垫片把 API Key、数据目录、模型名硬编码在源码里（例如从 D:/cpa/config.yaml
     读 key、写死 F:/harness/self_learning_data）。这里一律走 config.yaml + 环境变量。
"""

from __future__ import annotations

import logging

from .core import logger

__all__ = ["logger"]
