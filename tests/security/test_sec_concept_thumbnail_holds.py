"""Migration 0163 — the database's own prices (a series episode, a video asked for over MCP) carry a concept-thumbnail
channel's generated images, exactly as the worker's floor demands them (modules/credits.minimum_reservation).

What would break without these:

* the database prices a concept channel's run at the bare floor while the worker demands the images: every series
  episode and every MCP video of that channel is queued, then refused, and a refused episode blocks its whole series;
* the two disagree on what "concept" is (" Concept ", a JSON array, a number) or on the rounding, so an honest hold
  lands a cent under the worker's floor;
* unpriced images read as 0, and the run is held without them;
* an API role calls a price helper directly;
* the rollback does not restore 0120's and 0094's bodies byte for byte, or 0163 does not apply again on top.

The behaviour of the two callers (the quote, the hold, the refusal) is attacked where their worlds live:
tests/security/test_sec_series_tables.py and tests/security/test_sec_mcp_oauth.py (the "0163" tests).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

import sec_db
from sec_db import as_superuser

sys.path.insert(0, str(sec_db.REPO))
from modules import credits  # noqa: E402 — stdlib only; the floor the worker applies

MIGRATION = sec_db.MIGRATION_0163
ROLLBACK = sec_db.ROLLBACK_0163
CHANNEL = "chan-0163"
BODIES = ("public.quote_series_episode(uuid)", "public.start_series_episode(uuid, numeric, text, boolean)",
          "public.oauth_create_video(text, text, jsonb, text, text)")


def set_prices(su, rows):
    su.rows("delete from public.credit_prices where unit in ('job_minimum', 'video_minute', 'image_generations') returning 1")
    for unit, rate, margin in rows:
        su.rows("insert into public.credit_prices (unit, credits_per_unit, margin) values (%s, %s, %s) returning 1", [unit, rate, margin])


def set_config(su, agent_config):
    su.rows("update public.channels set agent_config = %s::jsonb where channel_id = %s returning 1",
            [None if agent_config is None else json.dumps(agent_config), CHANNEL])


@pytest.fixture()
def su(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.rows("insert into public.channels (channel_id, name, niche, status, org_id) values (%s, %s, 'tech', 'PAUSED', %s) returning 1",
               [CHANNEL, CHANNEL, sc.alice.org])
        yield s


READINGS = [
    {"thumbnail_mode": "concept"}, {"thumbnail_mode": " Concept "}, {"thumbnail_mode": "CONCEPT\n"}, {"thumbnail_mode": "\tconcept"},
    {"thumbnail_mode": "frame"}, {"thumbnail_mode": "conceptual"}, {"thumbnail_mode": "con cept"}, {"thumbnail_mode": ""},
    {"thumbnail_mode": ["concept"]}, {"thumbnail_mode": {"mode": "concept"}}, {"thumbnail_mode": 1}, {"thumbnail_mode": True},
    {"thumbnail_mode": None}, {},          # (channels.agent_config itself is NOT NULL)
    # every character Python's str.strip() removes, before and after the word, and two it keeps (zero-width space, BOM):
    # the worker and the database must both call each of these concept, or both frame.
    *({"thumbnail_mode": f"{ch}concept{ch}"} for ch in
      "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2005\u200a\u2028\u2029\u202f\u205f\u3000\u200b\ufeff"),
]


@pytest.mark.parametrize("agent_config", READINGS, ids=[json.dumps(r) for r in READINGS])
def test_the_database_reads_concept_exactly_as_the_worker_does(su, agent_config):
    set_prices(su, [("image_generations", 2, 0.25)])
    set_config(su, agent_config)
    got = su.value("select public.concept_thumbnail_credits(%s)", [CHANNEL])
    want = 10 if credits.concept_thumbnail_on(agent_config) else 0
    assert float(got) == want


PRICE_CASES = [
    # (job_minimum, video_minute, margin), image (rate, margin), seconds
    ((5, 6, 0.25), (2, 0.25), 120),
    ((5, 6, 0.25), (2, 0.25), 30),          # the job_minimum floor wins, then the images go on top
    ((0, 0.07, 0), (0.013, 0.1), 61),       # cents: each step rounds UP, floor first, then floor + images
    ((10, 60, 0.5), (1.5, 0.2), 3600),
    ((5, 6, 0.25), (0, 0), 120),            # a free image is priced at 0, not unpriced
]                                           # (a negative margin cannot be stored: credit_prices_margin_check)


@pytest.mark.parametrize("case", PRICE_CASES)
def test_an_episodes_price_is_the_workers_floor_to_the_cent(su, case):
    (jm, vm, vm_margin), (img, img_margin), secs = case
    rows = [("job_minimum", jm, 0), ("video_minute", vm, vm_margin), ("image_generations", img, img_margin)]
    set_prices(su, rows)
    prices = credits.parse_prices([{"unit": u, "credits_per_unit": r, "margin": m} for u, r, m in rows])
    for cfg in ({"thumbnail_mode": "concept"}, {"thumbnail_mode": "frame"}):
        set_config(su, cfg)
        got = su.value("select public.series_episode_price(%s, %s)", [secs, CHANNEL])
        assert float(got) == credits.minimum_reservation(prices, secs, cfg), (case, cfg)


def test_unpriced_images_are_unknown_for_a_concept_channel_and_irrelevant_for_a_frame_one(su):
    set_prices(su, [("job_minimum", 5, 0), ("video_minute", 6, 0.25)])
    set_config(su, {"thumbnail_mode": "concept"})
    assert su.value("select public.concept_thumbnail_credits(%s)", [CHANNEL]) is None
    assert su.value("select public.series_episode_price(120, %s)", [CHANNEL]) is None
    with pytest.raises(credits.CreditRefused):        # the worker refuses the same run
        credits.minimum_reservation(credits.parse_prices([{"unit": "job_minimum", "credits_per_unit": 5},
                                                          {"unit": "video_minute", "credits_per_unit": 6, "margin": 0.25}]),
                                    120, {"thumbnail_mode": "concept"})
    set_config(su, {"thumbnail_mode": "frame"})
    assert float(su.value("select public.series_episode_price(120, %s)", [CHANNEL])) == 15.0


def test_a_nan_image_price_is_unpriced_never_a_price(su):
    # numeric accepts 'NaN' and NaN >= 0 holds, so credit_prices' check lets it in; the worker reads it as unpriced.
    set_prices(su, [("job_minimum", 5, 0), ("video_minute", 6, 0.25), ("image_generations", "NaN", 0)])
    set_config(su, {"thumbnail_mode": "concept"})
    assert su.value("select public.concept_thumbnail_credits(%s)", [CHANNEL]) is None
    assert su.value("select public.series_episode_price(120, %s)", [CHANNEL]) is None
    assert credits.parse_prices([{"unit": "image_generations", "credits_per_unit": float("nan")}]) == {}
    # (a NaN margin cannot be stored: credit_prices_margin_check refuses it)


@pytest.mark.parametrize("role", ["anon", "authenticated", "service_role"])
@pytest.mark.parametrize("sig", ["public.concept_thumbnail_credits(text)", "public.series_episode_price(integer, text)"])
def test_no_api_role_can_call_a_price_helper(su, role, sig):
    assert su.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig]) is False


def test_the_callers_keep_their_grants(su):
    for role, sig, want in (("authenticated", BODIES[0], True), ("authenticated", BODIES[1], True), ("anon", BODIES[2], True),
                            ("anon", BODIES[0], False), ("service_role", BODIES[1], False), ("authenticated", BODIES[2], False)):
        assert su.value("select has_function_privilege(%s, %s, 'EXECUTE')", [role, sig]) is want, (role, sig)


def _defs(su):
    return {s: (su.value("select pg_get_functiondef(%s::regprocedure)", [s]),
                su.value("select proacl::text from pg_proc where oid = %s::regprocedure", [s])) for s in BODIES}


def _body(path: Path) -> str:
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def test_a_replay_changes_nothing(su):
    before = _defs(su)
    su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert _defs(su) == before


def test_the_rollback_restores_0120s_and_0094s_bodies_byte_for_byte_and_0163_applies_again(su):
    applied = _defs(su)
    su.conn.execute(_body(ROLLBACK))
    for sig, h in sec_db._BEFORE_0163.items():
        assert sec_db._live_md5(su, sig) == h, sig
    for sig in ("public.concept_thumbnail_credits(text)", "public.series_episode_price(integer, text)"):
        assert su.value("select to_regprocedure(%s)", [sig]) is None, sig
    assert su.value("select to_regprocedure('public.series_episode_price(integer)') is not null") is True
    su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
    assert _defs(su) == applied


def test_the_migration_refuses_a_body_it_does_not_know(su):
    su.conn.execute("savepoint sp")
    try:
        su.conn.execute("create or replace function public.quote_series_episode(p_episode uuid) returns jsonb "
                        "language sql stable as $$ select '{}'::jsonb $$")
        with pytest.raises(Exception) as e:
            su.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert "neither 0120's body nor 0163's" in str(e.value)
    finally:
        su.conn.execute("rollback to savepoint sp")


def test_the_rollback_refuses_a_body_that_is_not_0163s(su):
    su.conn.execute("savepoint sp")
    try:
        su.conn.execute("create or replace function public.oauth_create_video(p_token_hash text, p_channel_id text, p_params jsonb, "
                        "p_idem_key text default null, p_request_id text default null) returns jsonb "
                        "language sql stable as $$ select '{}'::jsonb $$")
        with pytest.raises(Exception) as e:
            su.conn.execute(_body(ROLLBACK))
        assert "is not 0163's body" in str(e.value)
    finally:
        su.conn.execute("rollback to savepoint sp")
