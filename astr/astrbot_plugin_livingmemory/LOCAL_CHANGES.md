# Local Modifications Notice (`astrbot_plugin_livingmemory`)

> `Modified by ruaji_bridge_v2 on 2026-10-23; released under AGPL-3.0.`

- **Upstream Project**: `astrbot_plugin_livingmemory` (LivingMemory)
- **Upstream Author**: `lxfight`
- **Upstream Repository**: https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory
- **Upstream Base Version**: `2.6.0-beta.3` (initial reference clone HEAD `c2e733049392d1cfc27843fc083096a9103f27d1`, followed by an upstream `[Unreleased]` sync in commit `2655835` and upstream test suite import in commit `2848ec4`)
- **License**: GNU Affero General Public License v3.0 (see [`LICENSE`](LICENSE) and [`../../LICENSES/AGPL-3.0.txt`](../../LICENSES/AGPL-3.0.txt))

Per GNU AGPL v3.0 Section 5(a), this file provides prominent notice of all local modifications made to this plugin in `ruaji_bridge_v2` and the date of notice. To preserve zero-intrusion line numbers and valid JSON syntax for future upstream synchronization (`git diff` / patch replay), modification notices are centrally recorded here rather than injected into upstream source or JSON files.

---

## Modified, Added & Removed Files Compared to Upstream

| File Path (relative to `astr/astrbot_plugin_livingmemory/`) | Status | Summary of Local Changes |
| :--- | :--- | :--- |
| `_conf_schema.json` | **Modified** | 1. Changed `recall_engine.top_k` default from `5` to `3` to reduce token consumption (`b1c6b59`).<br>2. Added `access_control.owner_ids` schema field for owner private-chat isolation (`80ff8c5`). |
| `.astrbot-plugin/i18n/en-US.json` | **Modified** | Added English i18n strings for `access_control.owner_ids` (`80ff8c5`). |
| `.astrbot-plugin/i18n/ru-RU.json` | **Modified** | Added Russian i18n strings for `access_control.owner_ids` (`80ff8c5`). |
| `core/base/config_validator.py` | **Modified** | Added validation and normalization for `access_control.owner_ids` list (`80ff8c5`). |
| `core/memory_scope.py` | **Modified** | Added `resolve_owner_ids` and `is_owner_private_event` to identify owner private-chat (`FRIEND_MESSAGE`) events (with fallback to `LIVINGMEMORY_OWNER_ID` / `RUAJI_V2_OWNER_ID`) while keeping owner group messages in scope (`80ff8c5`). |
| `core/passive_group_capture.py` | **Modified** | Skip owner private-chat events in passive capture filter so owner private chats are handled exclusively by the bridge's Mem0 pipeline (`80ff8c5`). |
| `core/event_handler_modules/group_capture.py` | **Modified** | Skip owner private-chat events; allow non-owner private-chat message capture with shared message-ID deduplication against `memory_recall` (`80ff8c5`). |
| `core/event_handler_modules/memory_recall.py` | **Modified** | Changed default `top_k` fallback from `5` to `3` (`b1c6b59`); skip owner private-chat events and deduplicate non-owner private-chat message persistence (`80ff8c5`). |
| `core/event_handler_modules/memory_reflection.py` | **Modified** | Support manual/diagnostic summary reflection fallback to default LLM provider when no active request provider is attached (`23df407`); skip owner private-chat events (`80ff8c5`). |
| `core/tools/memory_search_tool.py` | **Modified** | Changed default `limit` parameter from `5` to `3` (`b1c6b59`). |
| `tests/test_event_handler.py` | **Modified** | Added unit tests for owner vs. non-owner private-chat capture, recall, and reflection isolation (`80ff8c5`). |
| `tests/test_group_capture_filter.py` | **Modified** | Added unit tests verifying passive capture filter skips owner private chats and allows non-owner private chats (`80ff8c5`). |
| `tests/test_memory_scope.py` | **Modified** | Added unit tests for `resolve_owner_ids` and `is_owner_private_event` (`80ff8c5`). |
| `.github/` | **Removed** | Upstream GitHub issue/PR templates and CI workflows removed when vendoring into `astr/astrbot_plugin_livingmemory` (`2655835`). |
| `LOCAL_CHANGES.md` | **Added** | This centralized license compliance and modification log (`2026-10-23`). |

*(Note: An early local `hermes_config.json` and dashboard Hermes provider settings block introduced in `eede321` were removed in commit `0cd5d08` when provider configuration was consolidated into `unified_astrbot_host`.)*
