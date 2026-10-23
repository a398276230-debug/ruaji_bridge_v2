# Local Modifications Notice (`astrbot_plugin_Favour_Ultra`)

> `Modified by ruaji_bridge_v2 on 2026-10-23; released under Apache-2.0 (and AGPL-3.0 when distributed as part of the ruaji_bridge_v2 combined work).`

- **Upstream Project**: `astrbot_plugin_Favour_Ultra` (可自定义好感度系统)
- **Upstream Author**: 糯米茨 (`nuomicici`)
- **Upstream Repository**: https://github.com/nuomicici/astrbot_plugin_Favour_Ultra
- **Upstream Base Version**: `v4.4.5` (reference clone HEAD `2f2ec141d05052b8f641f29ca04bde8fc97e4d62`)
- **Upstream License**: Apache License, Version 2.0 (see [`LICENSE`](LICENSE) and [`../../LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt))

Per Apache License 2.0 Section 4(b), this file provides prominent notice of all local modifications made to this plugin in `ruaji_bridge_v2`. To preserve zero-intrusion line numbers for future upstream synchronization (`git diff` / patch replay), modification notices are centrally recorded here and in [`PATCHES.md`](PATCHES.md) rather than injected into upstream source headers.

---

## Modified & Added Files Compared to Upstream `v4.4.5`

| File Path (relative to `astr/astrbot_plugin_Favour_Ultra/`) | Status | Summary of Local Changes |
| :--- | :--- | :--- |
| `main.py` | **Modified** | Unified host adaptation; owner record immutability (`_write_favour`); admin-only command `施加冷暴力` (`impose_cold_violence`) and help menu entry; shared-mode exclusive relationship snapshot injection; proactive turn (`ai_decision`) exemption from personal favour evaluation; static `<FavorabilityPlugin>` prompt block builder (`_build_static_favour_prompt`) injected consistently across manual and auto turns to preserve Prompt Cache prefix stability; read-only reply gate delegation (`check_reply_gate`); owner identity resolution improvements. (Commits: `a36709e`, `c45ac96`, `1d7c20a`, `1bb7b60`, `0302ab2`, `69b74ee`, `a91a110`, `9362ea7`) |
| `storage.py` | **Modified** | Database-layer owner record immutability guards (canonicalizing owner writes to `favour=1000, relationship=亲密, is_unique=true`, refusing owner deletes, excluding owner from decay, preserving owner rows on clear); `ensure_owner_records` rebuild helper; runtime shared session key alignment (`aiocqhttp`) and legacy mistaken record cleanup. (Commits: `c45ac96`, `1d7c20a`, `a91a110`) |
| `config_manager.py` | **Modified** | Prefer framework-provided plugin data directory passed by `unified_astrbot_host` over parent-of-parent directory derivation, falling back to upstream behavior when absent. (Commit: `c45ac96`) |
| `reply_gate.py` | **Added** | Read-only preflight reply gate (`check_reply_gate`) checking auto-blacklist and cold-violence status without mutating state or injecting prompts, supporting bridge admin intervention (`/api/v1/reply/preflight`). (Commit: `69b74ee`) |
| `PATCHES.md` | **Added** | Detailed technical notes for patches 1–11 applied to the vendored copy. (Commits: `a36709e`, `c45ac96`, `1bb7b60`, `0302ab2`) |
| `LOCAL_CHANGES.md` | **Added** | This centralized license compliance and modification log (`2026-10-23`). |
