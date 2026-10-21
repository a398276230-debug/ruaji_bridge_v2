"""Pure, standard-library-only SillyTavern-style lorebook evaluation.

Interface: evaluate(entries, messages, settings=None, *, rng=random.random,
                    effects=None, message_count=None).
Messages are oldest first; only string content is scanned. No inputs mutate.
Results: normalized entries sorted by descending order (stable ties),
tokensEstimate, dropped ({entry: normalized copy, reason: string}), effects,
and iterations (TOTAL scans including the initial scan).

Persist the returned effects and pass them back next turn. Effects are JSON
serializable ST-shaped maps, e.g. {'sticky': {'book.1': {'start': 10, 'end': 13,
'protected': False}}, 'cooldown': {}}. Identity is world.uid. An optional entry
hash is copied and checked for changes. Missing uids get input-index fallbacks.
message_count defaults to len(messages); supply the FULL chat length when
messages is a window. Delay is an absolute message-count threshold. Ordinary
effect intervals are start-exclusive/end-exclusive; protected effects survive
same-count retries. Sticky overrides cooldown; sticky expiry starts protected
cooldown at the CURRENT count. Existing effects do not renew on activation.

Budget is atomic, never truncating content/JSON. First overflow stops further
budgeted entries, but ignoreBudget entries are still admitted and counted.
Estimate is conservatively one token per UTF-8 byte of admitted content; exact
fits are allowed. Only admitted content feeds recursion. maxRecursionSteps
bounds TOTAL scans; nonpositive values use the default finite bound (8).
recursive=False disables regular recursion; as in ST, remaining delayed ranks
can still force recursive phases. Delayed recursion ranks are opened when a
chain stalls, not at their numeric iteration count. The first
rank is preset (ST behavior); alone it cannot force recursion without a feed.

Groups span books, comma-separated memberships are trimmed, and overlapping or
sticky groups still permit at most one admitted member per group. Probability
is checked AFTER grouping, with no same-pass fallback or failed-entry reroll.
Zero probability always fails, including rng=0. Unknown metadata is preserved;
vectorized alone cannot activate without a provider. No service, macro,
decorator, character filtering or prompt-assembly pipeline runs here. Optional
settings trigger and globalScanData support trigger filters and opt-in global
text. Missing trigger cannot satisfy a nonempty trigger filter.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import math
import random
import re
from typing import Any

__all__ = ["ENTRY_DEFAULTS", "normalize_entry", "evaluate"]

# ST newWorldInfoEntryDefinition, including fields excluded from the UI template.
# DEFAULT_DEPTH = 4, DEFAULT_WEIGHT = 100, AND_ANY = 0.
ENTRY_DEFAULTS = {
    "key": [], "keysecondary": [], "comment": "", "content": "",
    "constant": False, "vectorized": False, "selective": True,
    "selectiveLogic": 0, "addMemo": False, "order": 100, "position": 0,
    "disable": False, "ignoreBudget": False, "excludeRecursion": False,
    "preventRecursion": False, "matchPersonaDescription": False,
    "matchCharacterDescription": False, "matchCharacterPersonality": False,
    "matchCharacterDepthPrompt": False, "matchScenario": False,
    "matchCreatorNotes": False, "delayUntilRecursion": 0,
    "probability": 100, "useProbability": True, "depth": 4, "outletName": "",
    "group": "", "groupOverride": False, "groupWeight": 100,
    "scanDepth": None, "caseSensitive": None, "matchWholeWords": None,
    "useGroupScoring": None, "automationId": "", "role": 0,
    "sticky": None, "cooldown": None, "delay": None,
    "characterFilterNames": [], "characterFilterTags": [],
    "characterFilterExclude": False, "triggers": [],
}
_SETTINGS = {
    "enabled": True, "scanDepth": 2, "recursive": True,
    "maxRecursionSteps": 8, "budgetTokens": 2048, "caseSensitive": False,
    "matchWholeWords": False, "useGroupScoring": False,
}
_GLOBAL_FIELDS = {
    "matchPersonaDescription": "personaDescription",
    "matchCharacterDescription": "characterDescription",
    "matchCharacterPersonality": "characterPersonality",
    "matchCharacterDepthPrompt": "characterDepthPrompt",
    "matchScenario": "scenario", "matchCreatorNotes": "creatorNotes",
}


def normalize_entry(entry: Mapping[str, Any]) -> dict:
    """Deep-copy defaults plus raw fields, preserving unknowns and explicit nulls."""
    result = deepcopy(ENTRY_DEFAULTS)
    result.update(deepcopy(dict(entry)))
    return result


def _number(value, default=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError, OverflowError):
        return default


def _option(entry, settings, name):
    return settings[name] if entry.get(name) is None else entry[name]


def _keys(entry, field):
    raw = entry.get(field)
    # Empty secondary slots are non-matches, not an absent secondary list.
    return [s.strip() for s in raw if isinstance(s, str)] if isinstance(raw, list) else []


def _regex(key):
    """Common JS syntax via Python re; invalid literals fall back to plaintext.

    g/u have no state here; y matches at offset zero. i/m/s are supported;
    named JS groups/backrefs are translated. ASCII classes emulate JS w/b/d.
    Unicode property escapes, UTF-16 surrogates and full JS regex syntax are
    not emulated. Regex execution is not a sandbox for pathological patterns.
    """
    literal = re.fullmatch(r"/([\s\S]+?)/([gimsuy]*)", key)
    if not literal:
        return None
    pattern, flags = literal.groups()
    if len(set(flags)) != len(flags) or re.search(r"(^|[^\\])/", pattern):
        return None
    pattern = pattern.replace(r"\/", "/")
    pattern = re.sub(r"\(\?<([A-Za-z_]\w*)>", r"(?P<\1>", pattern)
    pattern = re.sub(r"\\k<([A-Za-z_]\w*)>", r"(?P=\1)", pattern)
    options = re.ASCII
    for flag, option in (("i", re.I), ("m", re.M), ("s", re.S)):
        if flag in flags:
            options |= option
    try:
        return re.compile(pattern, options), "y" in flags
    except re.error:
        return None


def _match(text, key, entry, settings):
    if not key:
        return False
    regex = _regex(key)
    if regex is not None:
        pattern, sticky = regex
        return (pattern.match(text) if sticky else pattern.search(text)) is not None
    if not _option(entry, settings, "caseSensitive"):
        text, key = text.lower(), key.lower()
    if _option(entry, settings, "matchWholeWords") and len(re.split(r"\s+", key)) == 1:
        return re.search(r"(?:^|\W)" + re.escape(key) + r"(?:$|\W)", text, re.ASCII) is not None
    return key in text  # ST uses substring matching for multiword whole-word keys


def _matches(text, entry, settings):
    if not any(_match(text, key, entry, settings) for key in _keys(entry, "key")):
        return False
    secondary = _keys(entry, "keysecondary")
    if not entry.get("selective") or not secondary:
        return True
    hits = [_match(text, key, entry, settings) for key in secondary]
    logic = entry.get("selectiveLogic")
    return {0: any(hits), 1: not all(hits), 2: not any(hits), 3: all(hits)}.get(0 if logic is None else logic, False)


def _score(text, entry, settings):
    primary = _keys(entry, "key")
    if not primary:
        return 0
    score = sum(_match(text, key, entry, settings) for key in primary)
    secondary = _keys(entry, "keysecondary")
    hits = sum(_match(text, key, entry, settings) for key in secondary)
    if entry.get("selectiveLogic") == 0 or (entry.get("selectiveLogic") == 3 and hits == len(secondary)):
        score += hits
    return score


def _groups(entry):
    raw = entry.get("group")
    return {s.strip() for s in raw.split(",") if s.strip()} if isinstance(raw, str) else set()


def _effect_key(entry):
    return f"{entry.get('world', '')}.{entry['uid']}"


def _new_effect(entry, kind, count, protected=False):
    effect = {"start": count, "end": count + _number(entry[kind]), "protected": protected}
    if "hash" in entry:
        effect["hash"] = deepcopy(entry["hash"])
    return effect


def _prepare_effects(entries, effects, count):
    state = deepcopy(dict(effects or {}))
    by_key = {}
    for i, entry in enumerate(entries):
        by_key.setdefault(_effect_key(entry), i)
    active = {"sticky": set(), "cooldown": set()}
    for kind in active:
        raw = state.get(kind)
        state[kind] = dict(raw) if isinstance(raw, Mapping) else {}
    # Order matters: sticky expiry inserts immediately active protected cooldown.
    for kind in active:
        for key, effect in list(state[kind].items()):
            if not isinstance(effect, Mapping):
                del state[kind][key]
                continue
            start, end = _number(effect.get("start")), _number(effect.get("end"))
            index = by_key.get(key)
            if count <= start and not effect.get("protected"):
                del state[kind][key]
                continue
            if index is None:
                if count >= end:
                    del state[kind][key]
                continue
            entry = entries[index]
            if not entry.get(kind) or ("hash" in effect and effect["hash"] != entry.get("hash")):
                del state[kind][key]
                continue
            if count >= end:
                del state[kind][key]
                if kind == "sticky" and _number(entry.get("cooldown")) > 0:
                    state["cooldown"][key] = _new_effect(entry, "cooldown", count, True)
                continue
            active[kind].add(index)
    return state, active["sticky"], active["cooldown"]


def _filter_groups(candidates, entries, texts, settings, sticky, occupied, rng):
    live = set(candidates)
    names = list(dict.fromkeys(name for i in candidates for name in sorted(_groups(entries[i]))))
    memberships = {i: _groups(entries[i]) for i in candidates}
    live.difference_update(i for i in candidates if memberships[i] & occupied)

    def members(name):
        return [i for i in candidates if i in live and name in memberships[i]]

    # Work on live membership, never stale group snapshots or ghost winners.
    for name in names:
        group = members(name)
        if any(i in sticky for i in group):
            live.difference_update(i for i in group if i not in sticky)
    for name in names:
        group = members(name)
        if not group or any(i in sticky for i in group):
            continue
        if not settings["useGroupScoring"] and not any(entries[i].get("useGroupScoring") for i in group):
            continue
        scores = {i: _score(texts[i], entries[i], settings) for i in group}
        highest = max(scores.values())
        live.difference_update(i for i in group if _option(entries[i], settings, "useGroupScoring") and scores[i] < highest)
    for name in names:
        group = members(name)
        if len(group) < 2:
            continue
        pool = [i for i in group if i in sticky] or group
        overrides = [i for i in pool if entries[i].get("groupOverride")]
        if overrides:
            winner = overrides[0]  # candidates already in descending order
        elif len(pool) == 1:
            winner = pool[0]
        else:
            weights = [max(0, _number(entries[i].get("groupWeight"), 100)) for i in pool]
            total = sum(weights)
            winner = pool[0]  # deterministic fallback for all-zero weights
            if total > 0:
                roll = min(max(_number(rng()), 0), math.nextafter(1.0, 0.0)) * total
                for index, weight in zip(pool, weights):
                    roll -= weight
                    if weight > 0 and roll < 0:
                        winner = index
                        break
        live.difference_update(i for i in group if i != winner)
    return [i for i in candidates if i in live]


def evaluate(entries, messages, settings=None, *, rng=random.random, effects=None, message_count=None) -> dict:
    """Evaluate one turn; see module documentation for semantics and schemas."""
    config = dict(_SETTINGS)
    config.update({k: v for k, v in dict(settings or {}).items() if v is not None})
    normalized = [normalize_entry(entry) for entry in entries]
    for index, entry in enumerate(normalized):
        if entry.get("uid") is None:
            entry["uid"] = index
    messages = list(messages)
    count = max(0, int(_number(len(messages) if message_count is None else message_count)))
    if not config["enabled"]:
        return {"entries": [], "tokensEstimate": 0,
                "dropped": [{"entry": e, "reason": "disabled"} for e in normalized],
                "effects": deepcopy(dict(effects or {})), "iterations": 0}
    state, sticky, cooldown = _prepare_effects(normalized, effects, count)
    order = sorted(range(len(normalized)), key=lambda i: -_number(normalized[i].get("order"), 100))
    seen, unique, reasons = set(), [], {}
    for i in order:
        identity = _effect_key(normalized[i])
        if identity in seen:
            reasons[i] = "duplicate"
        else:
            unique.append(i)
            seen.add(identity)
    order = unique
    message_text = []
    for message in reversed(messages[-1000:]):
        content = message.get("content") if isinstance(message, Mapping) else getattr(message, "content", None)
        message_text.append(content.strip() if isinstance(content, str) else "")
    global_data = config.get("globalScanData")
    global_data = global_data if isinstance(global_data, Mapping) else {}
    recurse_text = []

    def buffer(entry):
        depth = max(0, min(1000, int(_number(_option(entry, config, "scanDepth")))))
        if depth == 0:
            return ""  # recursion and global text must not leak in
        parts = message_text[:depth]
        parts += [global_data[name] for flag, name in _GLOBAL_FIELDS.items()
                  if entry.get(flag) and isinstance(global_data.get(name), str) and global_data[name]]
        parts += recurse_text
        return "\x01" + "\n\x01".join(parts)

    delay_levels = sorted({_number(e.get("delayUntilRecursion")) for e in normalized
                           if _number(e.get("delayUntilRecursion")) > 0})
    current_level = delay_levels.pop(0) if delay_levels else 0
    max_steps = int(_number(config["maxRecursionSteps"]))
    max_steps = max_steps if max_steps > 0 else _SETTINGS["maxRecursionSteps"]
    budget = max(0, _number(config["budgetTokens"]))
    selected, failed, budget_rejected, occupied = set(), set(), set(), set()
    total, iterations, overflow = 0, 0, False
    recursive_phase = False
    while iterations < max_steps:
        iterations += 1
        candidates, texts = [], {}
        for i in order:
            if i in selected or i in failed or i in budget_rejected:
                continue
            entry = normalized[i]
            reason = None
            triggers = entry.get("triggers")
            delayed = _number(entry.get("delayUntilRecursion"))
            if entry.get("disable"):
                reason = "disabled"
            elif isinstance(triggers, list) and triggers and config.get("trigger", global_data.get("trigger")) not in triggers:
                reason = "trigger"
            elif count < _number(entry.get("delay")):
                reason = "delay"
            elif i in cooldown and i not in sticky:
                reason = "cooldown"
            elif delayed > 0 and i not in sticky and (not recursive_phase or delayed > current_level):
                reason = "recursion-delay"
            elif recursive_phase and config["recursive"] and entry.get("excludeRecursion") and i not in sticky:
                reason = "exclude-recursion"
            if reason:
                reasons[i] = reason
                continue
            texts[i] = buffer(entry)
            if entry.get("constant") or i in sticky or (texts[i] and _matches(texts[i], entry, config)):
                candidates.append(i)
            else:
                reasons[i] = "no-match"
        # ST prioritizes active sticky entries before grouping and budget admission.
        # Keep original order within each tier; final prompt sorting stays separate.
        candidates.sort(key=lambda i: i not in sticky)
        winners = _filter_groups(candidates, normalized, texts, config, sticky, occupied, rng)
        for i in set(candidates) - set(winners):
            reasons[i] = "group"
        admitted = []
        for i in winners:
            entry = normalized[i]
            if overflow and not entry.get("ignoreBudget"):
                reasons[i] = "budget"
                budget_rejected.add(i)
                continue
            probability = _number(entry.get("probability"), 100)
            if entry.get("useProbability") and i not in sticky and probability < 100:
                if probability <= 0 or _number(rng()) * 100 > probability:
                    reasons[i] = "probability"
                    failed.add(i)
                    continue
            content = entry.get("content")
            cost = len(content.encode("utf-8")) if isinstance(content, str) else 0
            if not entry.get("ignoreBudget") and total + cost > budget:
                overflow = True
                reasons[i] = "budget"
                budget_rejected.add(i)
                continue
            selected.add(i)
            admitted.append(i)
            total += cost
            occupied.update(_groups(entry))
        feeds = [normalized[i].get("content") for i in admitted if not normalized[i].get("preventRecursion")]
        if config["recursive"] and feeds and not overflow:
            next_scan = True
        elif delay_levels:
            # First rank is preset like ST; higher ranks open on chain stalls.
            current_level = delay_levels.pop(0)
            next_scan = True
        else:
            next_scan = False
        if not next_scan:
            break
        recurse_text.extend(text for text in feeds if isinstance(text, str) and text)
        recursive_phase = True
    admitted_entries = [normalized[i] for i in order if i in selected]
    for entry in admitted_entries:
        for kind in ("sticky", "cooldown"):
            if _number(entry.get(kind)) > 0:
                state[kind].setdefault(_effect_key(entry), _new_effect(entry, kind, count))
    return {"entries": admitted_entries, "tokensEstimate": total,
            "dropped": [{"entry": e, "reason": reasons.get(i, "no-match")}
                        for i, e in enumerate(normalized) if i not in selected],
            "effects": state, "iterations": iterations}
