"""Breach on 0199's Lens round (not_sent / refused outcomes, request ids, text normalisation, model_ref).

Each test names the attack. A test that fails here is a hole still open, kept failing (never skipped) until 0199 closes it:

* model_ref is md5 of a fixed prefix and the model id, and the candidate ids are a member's to list (sellable_models, which the
  route itself calls as the member): the "reference" reverses to the owner's model id in two hashes;
* not_sent is excluded from EVERY cap (plan, trial, per-person, platform), and a member can reserve and finish their own call as
  not_sent by hand: unlimited stored messages (and payloads) past every brake, from a Free workspace too;
* refused / vendor_refused are excluded from the trial: a Free workspace's refusals are bounded only by the per-person cap, and
  through the route each one is a paid vendor call;
* reserve_turn's emptiness check misses line/paragraph separators, NEL, and several blank-rendering code points.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from sec_db import acting, as_superuser
from test_sec_ai_chat import RESERVE, _cap, _free, _plan, _trial

RESERVE_ID = "select public.ai_chat_reserve_turn(%s, %s, false, %s)"
FINISH_NOT_SENT = ("select public.ai_chat_finish_turn(%s, 'not_sent', null, null, %s, %s::jsonb, null, null, null, null)")
FINISH = "select public.ai_chat_finish_turn(%s, %s, null, null, null, null, null, null, null, null)"


def _limits(su, per_user: int, global_daily: int) -> None:
    su.rows("update public.ai_chat_settings set per_user_daily = %s, global_daily = %s where id returning 1", [per_user, global_daily])


def test_breach_lens_model_ref_never_carries_the_id_and_its_reversibility_is_the_documented_limit(conn, sc):
    """Accepted limit, not a fix (Atlas told on 0199): the web server reads as the member (anon key only, CLAUDE.md rule 3), so no
    value it can map back to a model is hidden from a member who hashes the few public candidate ids. What IS guaranteed, and pinned
    here: the id itself never reaches a member, not from ai_chat_quota and not from their session row. Breach's reversal stays
    recorded below so the limit cannot be forgotten: if a server-only secret ever exists, this assertion is where it gets tightened."""
    with as_superuser(conn, commit=False) as su:
        owner_model = su.value("select model from public.ai_chat_settings where id")
        with acting(conn, sc.alice.actor) as s:
            q = s.value("select public.ai_chat_quota(%s)", [sc.alice.org])
            assert owner_model not in json.dumps(q), q
            assert not s.run("select model from public.ai_chat_sessions limit 1").ok
            ref = q["model_ref"]
            cands = {"anthropic-claude-sonnet-5-5", "openai-gpt-6-luna"}
            recovered = [c for c in cands if hashlib.md5(f"nightshift-chat-model:{c}".encode()).hexdigest() == ref]
            # The documented limit, as it stands: a guess list of the shipped ids confirms the owner's choice.
            assert recovered == [owner_model]


def test_breach_lens_not_sent_by_hand_takes_turns_past_every_cap(conn, sc):
    with as_superuser(conn, commit=False) as su:
        # Every cap two turns above what the lab already counts: two more turns are allowed, an eighth is past all three brakes.
        live = "created_at > now() - interval '24 hours' and outcome not in ('not_sent', 'not_configured', 'vendor_refused', 'refused')"
        _cap(su, _plan(su, sc.alice.org), su.value(f"select count(*) from public.ai_chat_calls where org_id = %s and {live}",
                                                   [sc.alice.org]) + 2)
        _limits(su, per_user=su.value("select count(*) from public.ai_chat_calls where user_id = %s and outcome <> 'not_sent' "
                                      "and created_at > now() - interval '24 hours'", [sc.alice.actor.uid]) + 2,
                global_daily=su.value("select count(*) from public.ai_chat_calls where outcome <> 'not_sent' "
                                      "and created_at > now() - interval '24 hours'") + 2)
        with acting(conn, sc.alice.actor) as s:
            taken = 0
            for i in range(8):
                out = s.run(RESERVE, [sc.alice.ai_chat_session, f"stored message {i} " + "x" * 1500])
                if not out.ok:
                    print("refused at", i, out)
                    break
                call = _value(out)["call_id"]
                assert s.run(FINISH_NOT_SENT, [call, "y" * 4000, json.dumps({"blob": "z" * 100000})]).ok
                taken += 1
            # The plan, the person's and the platform's caps are all 2 here: a third stored turn is past every brake.
            assert taken <= 2, f"{taken} turns reserved and stored (each ~105 KB) with every cap 2 above the count: not_sent is uncapped"


def test_breach_lens_not_sent_by_hand_never_spends_a_free_workspaces_trial(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _free(su, sc.alice.org)
        _trial(su, 2)
        su.rows("delete from public.ai_chat_calls where org_id = %s returning 1", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            n = 0
            for i in range(6):
                r = s.run(RESERVE, [sc.alice.ai_chat_session, f"free storage {i}"])
                if not r.ok:
                    break
                call = _value(r)["call_id"]
                assert s.run(FINISH_NOT_SENT, [call, "answer", "{}"]).ok
                n += 1
            assert n <= 2, f"a Free workspace with a 2-message trial stored {n} turns and its trial still reads " \
                f"{s.value('select public.ai_chat_quota(%s)', [sc.alice.org])['trial_left']}"


def test_breach_lens_refusals_on_a_free_trial_are_bounded_only_by_the_per_person_cap(conn, sc):
    # Through the route, a refused / vendor_refused turn is a PAID vendor call (route.ts finishes it after callChatModel). Here the
    # finish is by hand, which is exactly what the route does: the counting is the database's either way.
    with as_superuser(conn, commit=False) as su:
        _free(su, sc.alice.org)
        _trial(su, 1)
        su.rows("delete from public.ai_chat_calls where org_id = %s returning 1", [sc.alice.org])
        with acting(conn, sc.alice.actor) as s:
            n = 0
            for i in range(10):
                r = s.run(RESERVE, [sc.alice.ai_chat_session, f"forbidden ask {i}"])
                if not r.ok:
                    break
                call = _value(r)["call_id"]
                assert s.run(FINISH, [call, "vendor_refused" if i % 2 else "refused"]).ok
                n += 1
            assert n <= 3, f"a Free workspace with a 1-message trial took {n} vendor-reaching refused turns and kept its trial"


def _value(out):
    v = getattr(out, "value", None)
    if isinstance(v, dict):
        return v
    rows = getattr(out, "rows", None)
    return rows[0][0] if rows else {}


@pytest.mark.parametrize("text", [" ", " ", "\u0085", "᠎", "ㅤ", "ᅟᅠ", "ﾠ", "⠀",
                                  "­", "͏", "‎‏", "‪‬", "️", "\U000e0020"],
                         ids=["LSEP", "PSEP", "NEL", "MVS", "HANGUL_FILLER", "HANGUL_JAMO_FILLERS", "HALFWIDTH_FILLER",
                              "BRAILLE_BLANK", "SOFT_HYPHEN", "CGJ", "LRM_RLM", "BIDI_EMBED", "VS16", "TAG_SPACE"])
def test_breach_lens_a_blank_rendering_message_is_empty(conn, sc, text):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE, [sc.alice.ai_chat_session, text * 3])
            assert not out.ok and out.error == "invalid_params", out


@pytest.mark.parametrize("rid", ["abcdefgh\n", "abcdefgh\r", "abcdéfgh", "abcdefgh ", "ａｂｃｄｅｆｇｈ"])
def test_breach_lens_an_odd_request_id_is_refused(conn, sc, rid):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            out = s.run(RESERVE_ID, [sc.alice.ai_chat_session, "hello there friend", rid])
            assert not out.ok and out.error == "invalid_params", out


def test_breach_lens_request_ids_are_per_person_not_global(conn, sc):
    # Bob using Alice's request id is not a duplicate of hers (no cross-user denial), and hers stays a duplicate for her.
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.alice.org), 1000)
        _cap(su, _plan(su, sc.bob.org), 1000)
        with acting(conn, sc.alice.actor) as s:
            assert s.run(RESERVE_ID, [sc.alice.ai_chat_session, "alice speaks", "shared-id-0001"]).ok
        with acting(conn, sc.bob.actor) as s:
            assert s.run(RESERVE_ID, [sc.bob.ai_chat_session, "bob speaks", "shared-id-0001"]).ok


def test_breach_lens_a_member_cannot_finish_into_anothers_session_or_embed_the_model(conn, sc):
    with as_superuser(conn, commit=False) as su:
        _cap(su, _plan(su, sc.bob.org), 1000)
        with acting(conn, sc.bob.actor) as s:
            call = _value(s.run(RESERVE, [sc.bob.ai_chat_session, "bob's own"]))["call_id"]
        with acting(conn, sc.alice.actor) as s:
            out = s.run(FINISH_NOT_SENT, [call, "alice writes into bob", "{}"])
            assert not out.ok and out.error == "call_not_found", out
            # PostgREST embedding compiles to a join on the session: the model column stays closed through it.
            out = s.run("select m.id, s.model from public.ai_chat_messages m join public.ai_chat_sessions s on s.id = m.session_id")
            assert not out.ok and out.sqlstate == "42501", out
            out = s.run("select to_jsonb(s) from public.ai_chat_sessions s")
            assert not out.ok and out.sqlstate == "42501", out
