# Third-Party Open Source Components (`THIRD_PARTY.md`)

本文件登记 `ruaji_bridge_v2` 仓库在 `astr/` 目录下内嵌（vendored）的第三方开源组件、上游来源、版本/Commit 标识、许可证信息以及本地修改状态。

---

## 1. 第三方 AstrBot 插件清单

| 组件目录 | 插件名称 / 作者 | 上游仓库 URL | 当前 Vendored 版本 / Commit | 许可证精确标识 | 是否被本地修改 | 本地修改登记文件 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `astr/astrbot_plugin_Favour_Ultra` | `astrbot_plugin_Favour_Ultra`（可自定义好感度系统）<br>作者：`糯米茨` (`nuomicici`) | https://github.com/nuomicici/astrbot_plugin_Favour_Ultra | `metadata.yaml`: `v4.4.5`<br>Commit: `unknown`（插件目录无 `.git`；本地导入源克隆 HEAD 为 `2f2ec141d05052b8f641f29ca04bde8fc97e4d62`，待人工确认） | `Apache-2.0`<br>（见 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) 及插件目录 `LICENSE`） | **是（Modified）** | [`astr/astrbot_plugin_Favour_Ultra/LOCAL_CHANGES.md`](astr/astrbot_plugin_Favour_Ultra/LOCAL_CHANGES.md)<br>[`astr/astrbot_plugin_Favour_Ultra/PATCHES.md`](astr/astrbot_plugin_Favour_Ultra/PATCHES.md) |
| `astr/astrbot_plugin_group_chat_plus` | `astrbot_plugin_group_chat_plus`（`chat_plus`）<br>作者：`Him666233` | https://github.com/Him666233/astrbot_plugin_group_chat_plus | `metadata.yaml`: `V1.2.3.hotfix.2`<br>Commit: `unknown`（插件目录无 `.git`；本地导入源克隆 HEAD 为 `89ae2e1ad9c5a3e5a430a22bbd3d6e638b7f5a63`，待人工确认） | `AGPL-3.0-only` 或 `AGPL-3.0-or-later`（待人工确认，见注 1）<br>（见 [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt) 及插件目录 `LICENSE`） | **是（Modified）** | [`astr/astrbot_plugin_group_chat_plus/LOCAL_CHANGES.md`](astr/astrbot_plugin_group_chat_plus/LOCAL_CHANGES.md) |
| `astr/astrbot_plugin_livingmemory` | `astrbot_plugin_livingmemory`（LivingMemory）<br>作者：`lxfight` | https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory | `metadata.yaml`: `2.6.0-beta.3`（含后续上游 `[Unreleased]` 同步）<br>Commit: `unknown`（插件目录无 `.git`；初始参考源克隆 HEAD 为 `c2e733049392d1cfc27843fc083096a9103f27d1`，后续经本仓 `2655835` 同步上游更新但未记录上游 commit SHA） | `AGPL-3.0-only` 或 `AGPL-3.0-or-later`（待人工确认，见注 1）<br>（见 [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt) 及插件目录 `LICENSE`） | **是（Modified）** | [`astr/astrbot_plugin_livingmemory/LOCAL_CHANGES.md`](astr/astrbot_plugin_livingmemory/LOCAL_CHANGES.md) |

> **注 1（关于 AGPL-3.0 `only` / `or-later` 标识说明）**：
> `astrbot_plugin_group_chat_plus` 与 `astrbot_plugin_livingmemory` 各自目录中的 `LICENSE` 文件均为 FSF 标准 GNU Affero General Public License Version 3 (19 November 2007) 原文（其末尾 `How to Apply These Terms to Your New Programs` 附录示例含 `either version 3 of the License, or (at your option) any later version`），各自 `README.md` 仅标注 `AGPL-3.0 License` / `AGPL-3.0 许可证`，且源码文件头部均未放置版权头或 SPDX 标识符，上游未显式声明是 `AGPL-3.0-only` 还是 `AGPL-3.0-or-later`。（按 AGPL-3.0 第 14 条规定，若程序未指定具体版本范围，受让人可选择 FSF 已发布的版本；SPDX 精确标识待人工确认。）

---

## 2. 插件内部自带的嵌套第三方静态资源

| 资源路径 | 所属插件 | 名称 / 作者 | 许可证标识 | 许可证文件位置 | 是否被本地修改 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `astr/astrbot_plugin_livingmemory/pages/dashboard/vendor/lucide.min.js` | `astrbot_plugin_livingmemory` | Lucide Icons & Feather Icons（Cole Bemis） | `ISC AND MIT` | [`astr/astrbot_plugin_livingmemory/pages/dashboard/vendor/LUCIDE_LICENSE`](astr/astrbot_plugin_livingmemory/pages/dashboard/vendor/LUCIDE_LICENSE) | 否（Unmodified） |

---

## 3. 整体组合分发与 AGPL-3.0 第 13 条合规说明

1. **进程内加载与组合作品（Combined Work）**：
   本项目通过 `astr/unified_astrbot_host` 在同一 Python 进程内加载并运行上述三个第三方插件，并通过本地 HTTP 接口与 Node.js 桥接主进程（`src/`）协同工作。
   - 本仓库自有代码（`src/`、`scripts/`、`tests/`、`astr/unified_astrbot_host/`）单独以 **[MIT License](LICENSE)** 授权；
   - `Apache-2.0`（与 AGPL-3.0 单向兼容）和 `MIT` 均可与 `AGPL-3.0` 组合；
   - 当本仓库连同 `astr/` 下的 AGPL-3.0 插件作为整体分发或部署运行时，整体组合作品适用 **[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSES/AGPL-3.0.txt)**。

2. **远程网络交互源码提供（AGPL-3.0 Section 13 — Remote Network Interaction）**：
   本项目作为 QQ 机器人网关通过网络与远程用户交互。根据 AGPL-3.0 第 13 条要求，任何通过网络与本程序交互的用户均可从以下公开代码仓库免费获取完整的对应源码（Corresponding Source，含自有代码、统一宿主及经本地修改后的全部插件源码）：
   - **公开源码仓库地址**：https://github.com/a398276230-debug/ruaji_bridge_v2

3. **修改声明方式（零侵入上游原则）**：
   为便于后续与上游仓库进行 `git diff` / 补丁重放同步，避免直接改动上游源码文件头或破坏 JSON 配置文件语法，本仓库采用集中登记方案：在每个被修改的插件根目录下提供 `LOCAL_CHANGES.md`（及 `PATCHES.md`），逐文件记录修改声明、修改日期与具体变更内容。
