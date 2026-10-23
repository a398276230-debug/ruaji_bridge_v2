# Local Modifications Notice (`astrbot_plugin_group_chat_plus`)

> `Modified by ruaji_bridge_v2 on 2026-10-23; released under AGPL-3.0.`

- **Upstream Project**: `astrbot_plugin_group_chat_plus` (`chat_plus`)
- **Upstream Author**: `Him666233`
- **Upstream Repository**: https://github.com/Him666233/astrbot_plugin_group_chat_plus
- **Upstream Base Version**: `V1.2.3.hotfix.2` (reference clone HEAD `89ae2e1ad9c5a3e5a430a22bbd3d6e638b7f5a63`)
- **License**: GNU Affero General Public License v3.0 (see [`LICENSE`](LICENSE) and [`../../LICENSES/AGPL-3.0.txt`](../../LICENSES/AGPL-3.0.txt))

Per GNU AGPL v3.0 Section 5(a), this file provides prominent notice of all local modifications made to this plugin in `ruaji_bridge_v2` and the date of notice. To preserve zero-intrusion line numbers for future upstream synchronization (`git diff` / patch replay), modification notices are centrally recorded here rather than injected into upstream source headers.

---

## Modified & Added Files Compared to Upstream `V1.2.3.hotfix.2`

| File Path (relative to `astr/astrbot_plugin_group_chat_plus/`) | Status | Summary of Local Changes |
| :--- | :--- | :--- |
| `web/server.py` | **Modified** | 1. Changed `gcp_token` and `gcp_device_id` cookie `samesite` attribute from `"Strict"` to `"Lax"`.<br>2. Commented out `"X-Frame-Options": "DENY"` in `_SECURITY_HEADERS` and relaxed CSP `frame-ancestors` from `'none'` to `'self' http://127.0.0.1:* http://localhost:*` so the Web UI can be embedded in the local `ruaji_bridge_v2` ops console iframe.<br>3. Updated `_get_config_file_path()` to resolve the plugin config under the unified host's `data/plugin_data/astrbot_plugin_group_chat_plus/config.json`. (Commit: `eede321`) |
| `private_chat/private_chat_utils/_session_guard.py` | **Added** | Added a package-local copy of upstream `utils/_session_guard.py` (identical content to upstream `private_chat/private_chat_utils/private_chat_session_guard.py` and `utils/_session_guard.py`) to satisfy relative import resolution when loaded as a namespace package in `unified_astrbot_host`. (Commit: `eede321`) |
| `LOCAL_CHANGES.md` | **Added** | This centralized license compliance and modification log (`2026-10-23`). |

*(Note: A local runtime configuration file `config.json` was initially committed in `eede321` and removed from git tracking in `46153d3` via `.gitignore`.)*
