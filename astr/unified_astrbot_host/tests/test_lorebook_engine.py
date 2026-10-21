"""Offline behavioral tests for the pure lorebook engine (no ST installation).

ST reference: WorldInfoBuffer, newWorldInfoEntryDefinition, checkWorldInfo,
filterByInclusionGroups and WorldInfoTimedEffects. Tests intentionally enforce
stronger atomic budget/admitted-only recursion and multi-group invariants than
the browser's historical splice/overflow implementation.
"""

from copy import deepcopy
from itertools import product
import json
from types import SimpleNamespace

import pytest

from hermes_layer.lorebook_engine import (
    ENTRY_DEFAULTS,
    clear_regex_cache,
    evaluate,
    get_regex_cache_stats,
    invalidate_regex_cache,
    normalize_entry,
)


def entry(uid=1, **overrides):
    return {"uid": uid, "world": "book", "key": ["start"], "content": f"entry-{uid}", **overrides}


def chat(*contents):
    return [{"role": "user" if i % 2 == 0 else "assistant", "content": text}
            for i, text in enumerate(contents)]


def ids(result):
    return [e["uid"] for e in result["entries"]]


def rejected(result):
    return {item["entry"]["uid"]: item["reason"] for item in result["dropped"]}


class Rolls:
    """Strict RNG spy: unexpected calls fail rather than silently returning 0."""

    def __init__(self, *values):
        self.values = iter(values)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return next(self.values)


def test_st_defaults_complete_and_normalization_preserves_raw_metadata():
    expected = {
        "key": [], "keysecondary": [], "comment": "", "content": "",
        "constant": False, "vectorized": False, "selective": True,
        "selectiveLogic": 0, "addMemo": False, "order": 100, "position": 0,
        "disable": False, "ignoreBudget": False, "excludeRecursion": False,
        "preventRecursion": False, "matchPersonaDescription": False,
        "matchCharacterDescription": False, "matchCharacterPersonality": False,
        "matchCharacterDepthPrompt": False, "matchScenario": False,
        "matchCreatorNotes": False, "delayUntilRecursion": 0,
        "probability": 100, "useProbability": True, "depth": 4,
        "outletName": "", "group": "", "groupOverride": False,
        "groupWeight": 100, "scanDepth": None, "caseSensitive": None,
        "matchWholeWords": None, "useGroupScoring": None, "automationId": "",
        "role": 0, "sticky": None, "cooldown": None, "delay": None,
        "characterFilterNames": [], "characterFilterTags": [],
        "characterFilterExclude": False, "triggers": [],
    }
    assert ENTRY_DEFAULTS == expected
    raw = {"uid": 3, "world": "other", "key": ["x"], "caseSensitive": None,
           "automationId": "automate", "vectorized": True, "position": 7,
           "outletName": "custom", "triggers": ["normal"], "future": {"list": [1]}}
    original = deepcopy(raw)
    normalized = normalize_entry(raw)
    assert normalized == {**expected, **raw}
    normalized["key"].append("new")
    normalized["future"]["list"].append(2)
    normalized["keysecondary"].append("secondary")
    assert raw == original
    assert normalize_entry({}) == expected


@pytest.mark.parametrize("logic", range(4))
@pytest.mark.parametrize("a,b", list(product([False, True], repeat=2)))
@pytest.mark.parametrize("primary", [False, True])
def test_secondary_full_truth_tables(logic, a, b, primary):
    text = " ".join(word for word, hit in (("start", primary), ("alpha", a), ("beta", b)) if hit)
    e = entry(keysecondary=["alpha", "beta"], selectiveLogic=logic)
    result = evaluate([e], chat(text))
    expected = primary and [a or b, not (a and b), not (a or b), a and b][logic]
    assert bool(ids(result)) is expected


@pytest.mark.parametrize("selective", [False, True])
@pytest.mark.parametrize("logic", range(4))
def test_selective_only_gates_secondary_never_primary(selective, logic):
    e = entry(keysecondary=["missing"], selective=selective, selectiveLogic=logic)
    assert not ids(evaluate([e], chat("missing")))
    if not selective:
        assert ids(evaluate([e], chat("start"))) == [1]
    e["keysecondary"] = []
    assert ids(evaluate([e], chat("start"))) == [1]


@pytest.mark.parametrize("logic,expected", [(0, False), (1, True), (2, True), (3, False)])
def test_empty_secondary_slot_is_false_not_an_absent_list(logic, expected):
    result = evaluate([entry(keysecondary=["   "], selectiveLogic=logic)], chat("start"))
    assert bool(ids(result)) is expected


def test_primary_or_and_empty_or_missing_keys():
    assert ids(evaluate([entry(key=["absent", "start"])], chat("start"))) == [1]
    for keys in ([], None, ["", "   "], "start"):
        assert not ids(evaluate([entry(key=keys)], chat("start")))
    e = entry(key=["  start  "], keysecondary=["  second  "], selectiveLogic=None)
    assert ids(evaluate([e], chat("start second"))) == [1]


@pytest.mark.parametrize("global_case,local_case,expected", [
    (False, None, True), (True, None, False),
    (True, False, True), (False, True, False),
])
def test_case_nullable_global_overrides(global_case, local_case, expected):
    result = evaluate([entry(key=["START"], caseSensitive=local_case)], chat("start"),
                      {"caseSensitive": global_case})
    assert bool(ids(result)) is expected


@pytest.mark.parametrize("key,text,expected", [
    ("cat", "catapult", False), ("cat", "a cat!", True),
    ("cat", "cat_", False), ("cat", "cat2", False),
    ("cat", "猫cat猫", True),  # JS ASCII \\W, NOT Unicode boundaries
    ("猫", "猫咪", True), ("猫", "a猫b", False),
    ("a+b", "(a+b)", True), ("red fox", "red foxes", True),
    ("red fox", "red  fox", False),
])
def test_whole_words_js_ascii_and_multiword_substrings(key, text, expected):
    result = evaluate([entry(key=[key])], chat(text), {"matchWholeWords": True})
    assert bool(ids(result)) is expected


def test_whole_words_local_false_overrides_global():
    assert ids(evaluate([entry(key=["cat"], matchWholeWords=False)], chat("catapult"),
                        {"matchWholeWords": True})) == [1]


@pytest.mark.parametrize("key,text,expected", [
    (r"/START/", "start", False), (r"/START/i", "start", True),
    (r"/start/g", "start start", True), (r"/start/u", "start", True),
    (r"/st.rt/s", "st\nrt", True), (r"/st.rt/", "st\nrt", False),
    (r"/^second$/m", "first\nsecond\nthird", True),
    (r"/second/y", "second", False),  # ST's buffer begins with \\x01
    (r"/\x01second/y", "second", True),
    (r"/a\/b/", "a/b", True), (r"/\bcat\b/", "猫cat猫", True),
    (r"/(?<animal>cat)\k<animal>/", "catcat", True),
    (r"/[/", "literal /[/ here", True),  # invalid regex -> literal fallback
    (r"/cat/ii", "cat", False), (r"/cat/z", "cat", False),
    (r"/a/b/", "a/b", False),  # unescaped delimiter -> literal fallback
])
def test_regex_flags_boundaries_and_invalid_fallback(key, text, expected):
    result = evaluate([entry(key=[key])], chat(text),
                      {"caseSensitive": True, "matchWholeWords": True})
    assert bool(ids(result)) is expected


def test_regex_ignores_plaintext_case_and_word_settings_and_has_no_lastindex():
    e = entry(key=["/cat/ig"])
    settings = {"caseSensitive": True, "matchWholeWords": True}
    for _ in range(3):
        assert ids(evaluate([e], chat("CATapult"), settings)) == [1]
    assert not ids(evaluate([entry(key=["/CAT/"])], chat("cat")))


def test_scan_depth_order_content_only_and_message_objects():
    messages = chat("old needle", "middle", "new")
    e = entry(key=["needle"])
    assert not ids(evaluate([e], messages))  # default depth 2, oldest excluded
    assert ids(evaluate([e], messages, {"scanDepth": 3})) == [1]
    assert not ids(evaluate([entry(key=["needle"], scanDepth=1)], messages, {"scanDepth": 3}))
    assert ids(evaluate([entry(scanDepth=3, key=["needle"])], messages, {"scanDepth": 1})) == [1]
    assert ids(evaluate([entry()], [SimpleNamespace(role="assistant", content="start")])) == [1]
    assert not ids(evaluate([entry(key=["start"])], [{"role": "start", "content": "none", "text": "start"}]))
    assert not ids(evaluate([entry()], [{"content": {"text": "start"}}]))
    assert not ids(evaluate([entry()], []))


@pytest.mark.parametrize("depth", [0, -1])
def test_zero_depth_blocks_messages_recursion_regex_and_globals(depth):
    source = entry(1, constant=True, content="start")
    blocked = entry(2, scanDepth=depth, key=["start", "/^$/"], matchScenario=True)
    result = evaluate([source, blocked], chat("start"), {"globalScanData": {"scenario": "start"}})
    assert ids(result) == [1]
    assert result["iterations"] == 2


def test_global_zero_depth_still_allows_explicit_entry_override_and_constants():
    result = evaluate([entry(1), entry(2, scanDepth=1), entry(3, constant=True)], chat("start"), {"scanDepth": 0})
    assert ids(result) == [2, 3]


def test_scan_depth_clamped_to_st_maximum():
    messages = chat("start", *("nothing" for _ in range(1000)))
    assert not ids(evaluate([entry(scanDepth=9999)], messages))
    messages[-1000]["content"] = "start"
    assert ids(evaluate([entry(scanDepth=9999)], messages)) == [1]


@pytest.mark.parametrize("flag,field", [
    ("matchPersonaDescription", "personaDescription"),
    ("matchCharacterDescription", "characterDescription"),
    ("matchCharacterPersonality", "characterPersonality"),
    ("matchCharacterDepthPrompt", "characterDepthPrompt"),
    ("matchScenario", "scenario"), ("matchCreatorNotes", "creatorNotes"),
])
def test_opt_in_global_text_fields(flag, field):
    settings = {"globalScanData": {field: "start"}}
    assert not ids(evaluate([entry()], chat("nothing"), settings))
    assert ids(evaluate([entry(**{flag: True})], chat("nothing"), settings)) == [1]


def test_constants_bypass_keys_secondary_depth_but_not_disable_probability_or_timing():
    e = entry(key=[], keysecondary=["never"], constant=True, scanDepth=0)
    assert ids(evaluate([e], [])) == [1]
    assert not ids(evaluate([{**e, "disable": True}], []))
    assert not ids(evaluate([{**e, "probability": 0}], [], rng=Rolls()))
    assert not ids(evaluate([{**e, "delay": 3}], [], message_count=2))
    assert ids(evaluate([{**e, "delay": 3}], [], message_count=3)) == [1]


def test_disabled_engine_is_noop_with_no_rng_or_effect_changes():
    state = {"sticky": {"book.1": {"start": 1, "end": 5}}, "custom": [1]}
    original = deepcopy(state)
    result = evaluate([entry(constant=True)], chat("start"), {"enabled": False}, effects=state, rng=Rolls())
    assert result == {"entries": [], "tokensEstimate": 0,
                      "dropped": [{"entry": normalize_entry(entry(constant=True)), "reason": "disabled"}],
                      "effects": original, "iterations": 0}
    result["effects"]["custom"].append(2)
    assert state == original


def test_recursion_chain_cycles_dedup_and_descending_output_order():
    entries = [entry(1, content="alpha", order=5),
               entry(2, key=["alpha"], content="beta", order=50),
               entry(3, key=["beta"], content="start", order=500)]
    result = evaluate(entries, chat("start"))
    assert ids(result) == [3, 2, 1]
    assert result["iterations"] == 4  # last scan establishes fixed point
    assert result["tokensEstimate"] == sum(len(e["content"].encode()) for e in entries)
    assert not result["dropped"]
    assert ids(evaluate(entries, chat("start"), {"recursive": False})) == [1]


def test_duplicate_identity_not_admitted_twice_but_crossbook_uids_are_distinct():
    entries = [entry(1), entry(1), entry(1, world="other")]
    result = evaluate(entries, chat("start"))
    assert [(e["world"], e["uid"]) for e in result["entries"]] == [("book", 1), ("other", 1)]
    assert [d["reason"] for d in result["dropped"]] == ["duplicate"]
    assert ids(evaluate([{"constant": True}, {"constant": True}], [])) == [0, 1]


def test_exclude_recursion_only_blocks_recursive_phase_and_prevent_only_blocks_feed():
    entries = [entry(1, content="alpha", preventRecursion=True),
               entry(2, key=["alpha"], content="beta")]
    assert ids(evaluate(entries, chat("start"))) == [1]
    entries[0]["preventRecursion"] = False
    entries[1]["excludeRecursion"] = True
    assert ids(evaluate(entries, chat("start"))) == [1]
    assert ids(evaluate(entries, chat("start alpha"))) == [1, 2]
    entries[0]["excludeRecursion"] = True
    entries[1]["excludeRecursion"] = False
    assert ids(evaluate(entries, chat("start"))) == [1, 2]


def test_delayed_recursion_ranks_wait_for_current_chain_not_loop_number():
    entries = [entry(1, content="alpha"),
               entry(2, key=["alpha"], content="beta", delayUntilRecursion=10),
               entry(3, key=["beta"], content="gamma", delayUntilRecursion=10),
               entry(4, key=["gamma"], content="delta", delayUntilRecursion=900),
               entry(5, key=["delta"], content="end", delayUntilRecursion=5000)]
    result = evaluate(entries, chat("start"))
    assert ids(result) == [1, 2, 3, 4, 5]
    assert result["iterations"] == 8
    # At loop 4 rank 10 is stalled. Loop 5 opens 900; not 900 iterations!
    partial = evaluate(entries, chat("start"), {"maxRecursionSteps": 4})
    assert ids(partial) == [1, 2, 3]
    assert ids(evaluate(entries, chat("start"), {"maxRecursionSteps": 5})) == [1, 2, 3, 4]


def test_delayed_level_source_edge_first_rank_is_preset_not_forced():
    # ST pre-shifts the first level, but only forces scans for remaining ranks.
    assert not ids(evaluate([entry(constant=True, delayUntilRecursion=10)], []))
    result = evaluate([entry(1, constant=True, delayUntilRecursion=10),
                       entry(2, constant=True, delayUntilRecursion=100)], [])
    assert ids(result) == [1, 2]
    assert result["iterations"] == 3
    assert not ids(evaluate([entry(constant=True, delayUntilRecursion=True)], [], {"recursive": False}))


def test_st_delayed_ranks_force_scans_even_with_regular_recursion_disabled():
    entries = [entry(1, content="alpha", delayUntilRecursion=10),
               entry(2, key=["alpha"], delayUntilRecursion=20, excludeRecursion=True)]
    result = evaluate(entries, chat("start"), {"recursive": False})
    # Forced delayed scan admits rank 10; rank 20 cannot see its content until
    # a subsequent scan, and recursive=False does not schedule that scan.
    assert ids(result) == [1]
    assert result["iterations"] == 2
    entries[1]["constant"] = True
    assert ids(evaluate(entries, chat("start"), {"recursive": False})) == [1, 2]


def test_boolean_delay_until_recursion_is_rank_one_and_flags_still_apply():
    entries = [entry(1), entry(2, constant=True, delayUntilRecursion=True),
               entry(3, constant=True, delayUntilRecursion=1, excludeRecursion=True)]
    assert ids(evaluate(entries, chat("start"))) == [1, 2]


@pytest.mark.parametrize("limit,expected", [(1, 1), (2, 2), (3, 3), (0, 8), (-1, 8)])
def test_total_loop_bound_includes_initial_and_zero_cannot_make_it_unbounded(limit, expected):
    entries = [entry(i, key=[f"key{i}"], content=f"key{i+1}") for i in range(20)]
    result = evaluate(entries, chat("key0"), {"maxRecursionSteps": limit})
    assert result["iterations"] == expected
    assert len(ids(result)) == expected
    empty = evaluate([], [])
    assert empty["iterations"] == 1
    assert empty["entries"] == []


@pytest.mark.parametrize("roll,winner", [(0, 1), (0.249, 1), (0.25, 2), (0.999, 2)])
def test_weighted_group_selection_across_books(roll, winner):
    entries = [entry(1, group="shared", groupWeight=1),
               entry(2, world="other", group="shared", groupWeight=3)]
    rng = Rolls(roll)
    result = evaluate(entries, chat("start"), rng=rng)
    assert ids(result) == [winner]
    assert rng.calls == 1
    assert list(rejected(result).values()) == ["group"]


def test_group_override_uses_highest_order_among_overrides_not_heaviest():
    entries = [entry(1, group="g", order=1000, groupWeight=999999),
               entry(2, group="g", order=200, groupOverride=True),
               entry(3, group="g", order=300, groupOverride=True)]
    assert ids(evaluate(entries, chat("start"), rng=Rolls())) == [3]


def test_group_ties_stable_and_zero_negative_weights_do_not_win_at_rng_zero():
    entries = [entry(1, group="g", groupWeight=0),
               entry(2, group="g", groupWeight=-3),
               entry(3, group="g", groupWeight=1)]
    assert ids(evaluate(entries, chat("start"), rng=Rolls(0))) == [3]
    assert ids(evaluate(entries[:2], chat("start"), rng=Rolls())) == [1]
    assert ids(evaluate([entry(1, group="g", groupOverride=True),
                        entry(2, group="g", groupOverride=True)], chat("start"), rng=Rolls())) == [1]


@pytest.mark.parametrize("roll", [0, 0.3, 0.9])
def test_multigroup_overlaps_never_select_two_same_group_and_never_ghost_winners(roll):
    entries = [entry(1, group="alpha, beta"),
               entry(2, group="alpha", world="other"),
               entry(3, group=" beta , gamma "),
               entry(4, group="gamma"), entry(5, group="delta")]
    result = evaluate(entries, chat("start"), rng=lambda: roll)
    seen = set()
    for e in result["entries"]:
        groups = {name.strip() for name in e["group"].split(",") if name.strip()}
        assert not seen.intersection(groups)
        seen.update(groups)
    assert 5 in ids(result)
    if roll == 0:
        assert ids(result) == [1, 4, 5]  # removed entry 3 must not evict entry 4


def test_group_occupied_across_recursive_phases_with_comma_membership():
    entries = [entry(1, group="alpha, beta", content="next"),
               entry(2, world="other", group="beta", key=["next"], groupOverride=True)]
    result = evaluate(entries, chat("start"), rng=Rolls())
    assert ids(result) == [1]
    assert rejected(result)[2] == "group"


@pytest.mark.parametrize("global_scoring,local_scoring,winner", [
    (False, None, 1), (True, None, 2), (False, True, 2),
    (True, False, 1),
])
def test_group_scoring_global_and_nullable_local_override(global_scoring, local_scoring, winner):
    entries = [entry(1, group="g", useGroupScoring=local_scoring),
               entry(2, group="g", key=["start", "second"], useGroupScoring=local_scoring)]
    result = evaluate(entries, chat("start second"), {"useGroupScoring": global_scoring}, rng=lambda: 0)
    assert ids(result) == [winner]


@pytest.mark.parametrize("logic,winner", [(0, 1), (1, 2), (2, 2), (3, 1)])
def test_group_score_secondary_positive_logic_only(logic, winner):
    # Constants bypass secondary activation to isolate the score calculation.
    entries = [entry(1, constant=True, group="g", keysecondary=["second", "third"], selectiveLogic=logic),
               entry(2, constant=True, group="g", key=["start", "fourth"])]
    result = evaluate(entries, chat("start second third fourth"), {"useGroupScoring": True}, rng=Rolls())
    assert ids(result) == [winner]


def test_group_score_and_all_partial_only_counts_primary_and_no_primary_is_zero():
    entries = [entry(1, constant=True, group="g", key=[], keysecondary=["a", "b", "c"]),
               entry(2, constant=True, group="g", keysecondary=["a", "b", "missing"], selectiveLogic=3),
               entry(3, group="g", key=["start", "a"])]
    assert ids(evaluate(entries, chat("start a b c"), {"useGroupScoring": True}, rng=Rolls())) == [3]


def test_probability_after_grouping_no_fallback_and_zero_always_fails():
    entries = [entry(1, group="g", groupOverride=True, probability=0),
               entry(2, group="g")]
    rng = Rolls()
    result = evaluate(entries, chat("start"), rng=rng)
    assert not ids(result)
    assert rejected(result) == {1: "probability", 2: "group"}
    assert rng.calls == 0
    assert not ids(evaluate([entry(probability=0)], chat("start"), rng=lambda: 0))


def test_probability_failed_group_winner_never_rerolls_but_other_member_can_win_later_scan():
    entries = [entry(1, group="g", groupOverride=True, probability=10),
               entry(2, group="g"), entry(3, content="next")]
    rng = Rolls(0.8)
    result = evaluate(entries, chat("start"), rng=rng)
    assert ids(result) == [2, 3]
    assert rejected(result) == {1: "probability"}
    assert rng.calls == 1


def test_probability_draw_happens_after_weighted_group_draw():
    rng = Rolls(0.75, 0.9)
    result = evaluate([entry(1, group="g", probability=10),
                       entry(2, group="g", probability=10)], chat("start"), rng=rng)
    assert not ids(result)
    assert rejected(result) == {1: "group", 2: "probability"}
    assert rng.calls == 2


def test_probability_failure_never_rerolled_in_same_turn_or_fed_to_recursion():
    entries = [entry(1, probability=20, content="hidden"),
               entry(2, content="next"), entry(3, key=["next"], content="end"),
               entry(4, key=["hidden"])]
    rng = Rolls(0.8)
    result = evaluate(entries, chat("start"), rng=rng)
    assert ids(result) == [2, 3]
    assert rejected(result)[1] == "probability"
    assert rng.calls == 1
    # Failure isn't persisted as global state: a fresh evaluation can pass.
    assert ids(evaluate([entries[0]], chat("start"), rng=Rolls(0))) == [1]


@pytest.mark.parametrize("probability,use_probability", [(100, True), (0, False), (10, False)])
def test_probability_bypass_does_not_consume_rng(probability, use_probability):
    assert ids(evaluate([entry(probability=probability, useProbability=use_probability)], chat("start"), rng=Rolls())) == [1]


def test_budget_whole_entry_stop_exact_fit_ignore_budget_and_total_reported():
    entries = [entry(1, order=400, content='{"text":"ok"}'),
               entry(2, order=300, content="too long to fit"),
               entry(3, order=200, content="x"),
               entry(4, order=100, content="ignored budget", ignoreBudget=True)]
    first_cost = len(entries[0]["content"].encode())
    result = evaluate(entries, chat("start"), {"budgetTokens": first_cost})
    assert ids(result) == [1, 4]
    assert result["entries"][0]["content"] == '{"text":"ok"}'
    assert json.loads(result["entries"][0]["content"]) == {"text": "ok"}
    assert result["tokensEstimate"] == first_cost + len("ignored budget")
    assert rejected(result) == {2: "budget", 3: "budget"}
    assert result["iterations"] == 1


def test_ignore_budget_cost_counts_against_later_budgeted_entries():
    entries = [entry(1, content="oversized", ignoreBudget=True, order=200),
               entry(2, content="a", order=100), entry(3, content="b", ignoreBudget=True)]
    result = evaluate(entries, chat("start"), {"budgetTokens": 1})
    assert ids(result) == [1, 3]
    assert result["tokensEstimate"] == 10


def test_budget_atomic_content_estimate_utf8_nonzero_short_content_and_empty():
    entries = [entry(1, content="猫🙂a"), entry(2, content="", ignoreBudget=True)]
    result = evaluate(entries, chat("start"), {"budgetTokens": 7})
    assert ids(result) == [2]
    assert result["tokensEstimate"] == 0
    assert entries[0]["content"] == "猫🙂a"
    assert evaluate([entries[0]], chat("start"), {"budgetTokens": 8})["tokensEstimate"] == 8
    assert not ids(evaluate([entry(content="a")], chat("start"), {"budgetTokens": 0}))
    assert ids(evaluate([entry(content="")], chat("start"), {"budgetTokens": 0})) == [1]


def test_group_loser_content_never_feeds_recursion():
    entries = [entry(1, group="g", groupOverride=True, content="public"),
               entry(2, group="g", content="hidden"),
               entry(3, key=["hidden"]), entry(4, key=["public"])]
    assert ids(evaluate(entries, chat("start"), rng=Rolls())) == [1, 4]


def test_prevent_recursion_entry_does_not_leak_when_another_entry_causes_scan():
    entries = [entry(1, content="hidden", preventRecursion=True),
               entry(2, content="public"), entry(3, key=["hidden"]),
               entry(4, key=["public"])]
    assert ids(evaluate(entries, chat("start"))) == [1, 2, 4]


def test_budget_rejected_content_never_feeds_recursion_even_with_remaining_delay_levels():
    entries = [entry(1, content="hidden"),
               entry(2, key=["hidden"], ignoreBudget=True, delayUntilRecursion=10),
               entry(3, key=["hidden"], ignoreBudget=True, delayUntilRecursion=20)]
    result = evaluate(entries, chat("start"), {"budgetTokens": 0})
    assert not ids(result)
    assert result["iterations"] == 2  # rank 20 forces a scan despite overflow
    assert rejected(result)[1] == "budget"


def test_probability_failure_does_not_spend_budget():
    result = evaluate([entry(1, content="very large" * 10, probability=1, order=200),
                       entry(2, content="ok")], chat("start"), {"budgetTokens": 2}, rng=Rolls(0.9))
    assert ids(result) == [2]
    assert result["tokensEstimate"] == 2


def test_budget_admission_is_descending_order_not_input_order():
    entries = [entry(1, order=1, content="x"), entry(2, order=500, content="high"),
               entry(3, order=100, content="middle")]
    assert ids(evaluate(entries, chat("start"), {"budgetTokens": 4})) == [2]


def test_delay_absolute_message_count_threshold_and_window_override():
    e = entry(delay=5)
    assert rejected(evaluate([e], chat("start"), message_count=4)) == {1: "delay"}
    assert ids(evaluate([e], chat("start"), message_count=5)) == [1]
    assert ids(evaluate([e], chat("", "", "", "", "start"))) == [1]
    assert ids(evaluate([entry(delay=None)], chat("start"))) == [1]


def test_sticky_and_cooldown_full_lifecycle_at_exclusive_boundaries():
    e = entry(sticky=3, cooldown=2)
    first = evaluate([e], chat("start"), message_count=10)
    assert first["effects"] == {
        "sticky": {"book.1": {"start": 10, "end": 13, "protected": False}},
        "cooldown": {"book.1": {"start": 10, "end": 12, "protected": False}},
    }
    second = evaluate([e], chat("absent"), message_count=11, effects=first["effects"])
    assert ids(second) == [1]  # sticky bypasses keys and concurrent cooldown
    assert second["effects"] == first["effects"]  # no sliding-window refresh
    third = evaluate([e], chat("absent"), message_count=12, effects=second["effects"])
    assert ids(third) == [1]
    assert third["effects"]["sticky"] == first["effects"]["sticky"]
    expired = evaluate([e], chat("start"), message_count=13, effects=third["effects"])
    assert not ids(expired)
    assert rejected(expired) == {1: "cooldown"}
    assert expired["effects"] == {"sticky": {}, "cooldown": {
        "book.1": {"start": 13, "end": 15, "protected": True}}}
    same_count = evaluate([e], chat("start"), message_count=13, effects=expired["effects"])
    assert not ids(same_count)  # protected cooldown survives same-count call
    still_cooling = evaluate([e], chat("start"), message_count=14, effects=same_count["effects"])
    assert not ids(still_cooling)
    again = evaluate([e], chat("start"), message_count=15, effects=still_cooling["effects"])
    assert ids(again) == [1]
    assert again["effects"]["sticky"]["book.1"]["start"] == 15


@pytest.mark.parametrize("count", [9, 10])
def test_st_same_count_retry_or_rewind_discards_unprotected_effects(count):
    e = entry(sticky=4, cooldown=4)
    first = evaluate([e], chat("start"), message_count=10)
    result = evaluate([e], chat("absent"), message_count=count, effects=first["effects"])
    assert not ids(result)
    assert result["effects"] == {"sticky": {}, "cooldown": {}}


def test_sticky_expiry_after_large_message_jump_starts_cooldown_now_not_in_past():
    e = entry(sticky=2, cooldown=3)
    state = evaluate([e], chat("start"), message_count=10)["effects"]
    result = evaluate([e], chat("start"), message_count=30, effects=state)
    assert not ids(result)
    assert result["effects"] == {"sticky": {}, "cooldown": {
        "book.1": {"start": 30, "end": 33, "protected": True}}}


def test_cooldown_without_sticky_and_no_new_effect_on_nonadmission():
    e = entry(cooldown=2)
    first = evaluate([e], chat("start"), message_count=10)
    blocked = evaluate([e], chat("start"), message_count=11, effects=first["effects"])
    assert not ids(blocked)
    assert ids(evaluate([e], chat("start"), message_count=12, effects=blocked["effects"])) == [1]
    assert evaluate([{**e, "probability": 0}], chat("start"))["effects"] == {"sticky": {}, "cooldown": {}}
    assert evaluate([e], chat("start"), {"budgetTokens": 0})["effects"] == {"sticky": {}, "cooldown": {}}


def test_sticky_bypasses_probability_recursion_delay_but_not_disable_or_absolute_delay():
    e = entry(sticky=5, probability=0, delayUntilRecursion=999, excludeRecursion=True)
    state = {"sticky": {"book.1": {"start": 10, "end": 15, "protected": False}}}
    assert ids(evaluate([e], chat("absent"), message_count=11, effects=state, rng=Rolls())) == [1]
    assert not ids(evaluate([{**e, "disable": True}], [], message_count=11, effects=state))
    assert not ids(evaluate([{**e, "delay": 12}], [], message_count=11, effects=state))


def test_group_sticky_preferred_over_scoring_override_weight_and_multisticky_exclusive():
    entries = [entry(1, sticky=5, group="a, b", key=[], probability=0),
               entry(2, group="a", groupOverride=True, order=999, key=["start", "extra"]),
               entry(3, group="b", groupOverride=True, order=999)]
    state = {"sticky": {"book.1": {"start": 10, "end": 15}}}
    assert ids(evaluate(entries, chat("start extra"), {"useGroupScoring": True},
                        message_count=11, effects=state, rng=Rolls())) == [1]
    entries[1]["sticky"] = 5
    state["sticky"]["book.2"] = {"start": 10, "end": 15}
    result = evaluate(entries, chat("start"), message_count=11, effects=state, rng=Rolls())
    # Entry 1 loses group a; on the next scan entry 3 can occupy now-free b.
    assert ids(result) == [2, 3]


def test_effects_missing_entry_retention_expiry_invalid_and_changed_hash_cleanup():
    state = {
        "sticky": {
            "other.8": {"start": 1, "end": 9},
            "other.9": {"start": 1, "end": 3},
            "book.1": {"start": 1, "end": 9, "hash": "old"},
            "bad": None,
        },
        "cooldown": {"book.1": {"start": 1, "end": 9}},
        "custom": {"keep": [1]},
    }
    result = evaluate([entry(sticky=5, cooldown=None, hash="new")], chat("absent"), message_count=4, effects=state)
    assert not ids(result)
    assert result["effects"] == {"sticky": {"other.8": {"start": 1, "end": 9}},
                                  "cooldown": {}, "custom": {"keep": [1]}}
    assert evaluate([entry(sticky=2, hash="h")], chat("start"))["effects"]["sticky"]["book.1"]["hash"] == "h"
    assert evaluate([], [], effects={"sticky": [], "cooldown": False})["effects"] == {"sticky": {}, "cooldown": {}}


def test_timing_identity_is_scoped_by_world_not_uid():
    state = {"sticky": {"other.1": {"start": 1, "end": 6}}}
    result = evaluate([entry(1, sticky=5), entry(1, world="other", sticky=5)],
                      chat("absent"), message_count=3, effects=state)
    assert [(e["world"], e["uid"]) for e in result["entries"]] == [("other", 1)]


def test_vectorized_metadata_does_not_activate_without_provider_but_keywords_still_can():
    entries = [entry(1, vectorized=True, key=[]), entry(2, vectorized=True),
               entry(3, vectorized=True, constant=True, key=[])]
    result = evaluate(entries, chat("start"))
    assert ids(result) == [2, 3]
    assert all(e["vectorized"] is True for e in result["entries"])


def test_trigger_filter_and_outlet_automation_metadata_preserved():
    e = entry(constant=True, triggers=["normal"], position=7, outletName="outlet",
              automationId="automation", characterFilter={"names": ["A"]}, future={"x": [1]})
    assert not ids(evaluate([e], []))
    assert not ids(evaluate([e], [], {"trigger": "swipe"}))
    result = evaluate([e], [], {"trigger": "normal"})
    assert ids(result) == [1]
    for key, value in e.items():
        assert result["entries"][0][key] == value
    assert ids(evaluate([e], [], {"globalScanData": {"trigger": "normal"}})) == [1]


def test_evaluation_no_input_mutations_determinism_and_json_roundtrip():
    entries = [entry(1, group="g", sticky=3, automationId="x", unknown={"list": [1]}),
               entry(2, group="g"), entry(3, delay=7)]
    messages = chat("old", "start")
    settings = {"scanDepth": 2, "globalScanData": {"scenario": "start"}}
    state = {"sticky": {}, "cooldown": {}, "custom": {"data": [1]}}
    before = deepcopy((entries, messages, settings, state))
    a = evaluate(entries, messages, settings, effects=state, rng=Rolls(0))
    b = evaluate(entries, messages, settings, effects=state, rng=Rolls(0))
    assert a == b
    assert json.loads(json.dumps(a, ensure_ascii=False)) == a
    a["entries"][0]["unknown"]["list"].append(2)
    a["effects"]["custom"]["data"].append(2)
    assert (entries, messages, settings, state) == before


def test_active_sticky_admitted_before_higher_order_normal_under_tight_budget():
    entries = [entry(1, content="new", constant=True, order=200),
               entry(2, content="old", sticky=5, order=1)]
    effects = {"sticky": {"book.2": {"start": 1, "end": 6, "protected": False}}}
    result = evaluate(entries, chat("absent"), {"budgetTokens": 3}, effects=effects, message_count=2)
    assert ids(result) == [2]
    assert rejected(result)[1] == "budget"


def test_key_regex_switch_matches_pattern_and_literal_when_off():
    pattern = r"我已经\s*\d+\s*秒没听到.+的故事了"
    regex_entry = entry(1, key=[pattern], keyRegex=True, content="定型文解释")
    literal_entry = entry(2, key=[pattern], keyRegex=False, content="字面解释")
    default_entry = entry(3, key=[pattern], content="默认字面解释")

    hit = evaluate([regex_entry, literal_entry, default_entry], chat("我已经 30 秒没听到 abc 的故事了"))
    assert ids(hit) == [1]
    assert rejected(hit) == {2: "no-match", 3: "no-match"}
    assert hit["diagnostics"] == []

    # When the literal regex source string itself is sent, literal entries match too.
    literal_hit = evaluate([literal_entry, default_entry], chat(pattern))
    assert ids(literal_hit) == [2, 3]


@pytest.mark.parametrize("global_case,local_case,text,expected", [
    (False, None, "我已经 30 秒没听到 ABC 的故事了", True),
    (False, False, "我已经 30 秒没听到 ABC 的故事了", True),
    (True, None, "我已经 30 秒没听到 ABC 的故事了", False),
    (True, None, "我已经 30 秒没听到 abc 的故事了", True),
    (False, True, "我已经 30 秒没听到 ABC 的故事了", False),
    (True, False, "我已经 30 秒没听到 ABC 的故事了", True),
])
def test_key_regex_case_sensitive_controls_i_flag_and_ignores_whole_words(global_case, local_case, text, expected):
    e = entry(
        1,
        key=[r"我已经\s*\d+\s*秒没听到\s*abc\s*的故事了"],
        keyRegex=True,
        caseSensitive=local_case,
        matchWholeWords=True,
    )
    res = evaluate([e], chat(text), {"caseSensitive": global_case, "matchWholeWords": True})
    assert bool(ids(res)) is expected

    # Verify matchWholeWords=True does NOT block substring regex matches inside words.
    sub = entry(2, key=[r"cat\d+"], keyRegex=True, matchWholeWords=True)
    assert ids(evaluate([sub], chat("supercat42pro"), {"matchWholeWords": True})) == [2]


def test_key_regex_invalid_pattern_falls_back_to_literal_and_records_diagnostics():
    clear_regex_cache()
    # Entry 1 has an invalid regex key and a valid regex key; entry 2 has only an invalid regex key.
    e1 = entry(1, key=["[unclosed", r"story\s+\d+"], keyRegex=True)
    e2 = entry(2, key=["(?P<broken"], keyRegex=True)

    # 1) Neither matches literal, but e1 matches via its second valid regex key; no exception raised.
    res1 = evaluate([e1, e2], chat("tell me story 99"))
    assert ids(res1) == [1]
    reasons = {(d["uid"], d["key"]): (d["reason"], d["fallback"]) for d in res1["diagnostics"]}
    assert reasons[(1, "[unclosed")] == ("invalid-regex", "literal")
    assert reasons[(2, "(?P<broken")] == ("invalid-regex", "literal")

    # 2) Invalid regex falls back to literal matching (respecting caseSensitive).
    res2 = evaluate([e2], chat("here is (?p<broken literal text"))
    assert ids(res2) == [2]
    assert len(res2["diagnostics"]) == 1
    assert res2["diagnostics"][0]["reason"] == "invalid-regex"
    assert res2["diagnostics"][0]["fallback"] == "literal"


def test_key_regex_compilation_cache_hit_and_invalidation():
    clear_regex_cache()
    e = entry(1, world="bookA", key=[r"我已经\s*\d+\s*秒没听到.+的故事了"], keyRegex=True)

    for n in (5, 30, 120):
        res = evaluate([e], chat(f"我已经 {n} 秒没听到 ruanruan 的故事了"))
        assert ids(res) == [1]

    stats = get_regex_cache_stats()
    assert stats["compiles"] == 1
    assert stats["hits"] == 2
    assert stats["misses"] == 1

    # Modifying the entry's key or caseSensitive invalidates its old cached pattern.
    e_modified = {**e, "key": [r"全新的正则\s*\d+"]}
    assert ids(evaluate([e_modified], chat("全新的正则 42"))) == [1]
    stats_after_edit = get_regex_cache_stats()
    assert stats_after_edit["compiles"] == 2
    assert stats_after_edit["invalidations"] >= 1

    # Explicit store-level invalidation also evicts cached patterns.
    removed = invalidate_regex_cache(world="bookA", uid=1)
    assert removed == 1
    assert ids(evaluate([e_modified], chat("全新的正则 42"))) == [1]
    assert get_regex_cache_stats()["compiles"] == 3


def test_key_regex_catastrophic_backtracking_defenses():
    clear_regex_cache()
    # Defense 1: nested quantifiers such as (a+)+$ are rejected statically without hanging.
    evil = entry(1, key=[r"(a+)+$"], keyRegex=True)
    attack_text = "a" * 32 + "!"
    res_evil = evaluate([evil], chat(attack_text))
    assert not ids(res_evil)
    assert len(res_evil["diagnostics"]) == 1
    assert res_evil["diagnostics"][0]["reason"] == "unsafe-regex"
    assert res_evil["diagnostics"][0]["fallback"] == "literal"
    # Literal fallback still works if the literal string `(a+)+$` appears in text.
    assert ids(evaluate([evil], chat("literal (a+)+$ in message"))) == [1]

    # Defense 2: overly long regex pattern is rejected and falls back to literal.
    long_pat = "a" * 505
    too_long = entry(2, key=[long_pat], keyRegex=True)
    res_long = evaluate([too_long], chat("short"))
    assert not ids(res_long)
    assert res_long["diagnostics"][0]["reason"] == "regex-too-long"
    assert res_long["diagnostics"][0]["fallback"] == "literal"

    # Defense 3: per-turn regex scan time budget skips remaining regex keys when exhausted.
    budget_entry = entry(3, key=[r"alpha\d+"], keyRegex=True)
    res_timeout = evaluate([budget_entry], chat("alpha123"), {"maxRegexScanMs": 0})
    assert not ids(res_timeout)
    assert res_timeout["diagnostics"][0]["reason"] == "regex-scan-timeout"
    assert res_timeout["diagnostics"][0]["fallback"] == "skipped"

