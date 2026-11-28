"""Breach's second round on migration 0248 (84ee95d45, Atlas's hybrid rule): can one tenant infer another tenant's take timings or
activity from film_take_typical_seconds? Against the money lab's own scratch database (its fixtures, and the 0246/0248 file's
take-insert helpers: each test uses a model id of its own, so no other test feeds its platform window).

Ledger (Breach, 2026-11-28, 84ee95d45). FIXED by Atlas's decision: the cross-customer median is gone; the second figure is the
operator organization's own takes only (basis 'nightshift'), so no customer's takes are in another customer's answer. The three
holes below are kept as permanent pins and pass.

* B-0248-1 (MEDIUM against the header's promise, LOW in data value; confirmed, FAILING until fixed). The 5-organization /
  20-take floor counts organizations, and organizations are cheap to the attacker: create_organization (0018) lets one account
  make 10, every account gets one more. The platform figure is the median of per-organization medians, an order statistic that
  an attacker holding all but one vote places exactly on the victim's vote: two of their organizations fast, two slow, the
  victim in the middle, and the figure IS the victim's median (whole seconds). A rare model makes it trivial (only the victim
  and the attacker's organizations use it); excluding the caller's own organization alone does not fix it (six votes average
  the 3rd and 4th, and the attacker solves for the victim's from their own known one). Mitigation in the lab and in production
  today: Film Studio is a per-organization switch the owner turns on (0198), so the attacker needs four enabled organizations.
  Test: test_organizations_the_attacker_controls_cannot_place_the_platform_figure_on_one_victims_median.
* B-0248-2 (LOW; confirmed, FAILING until fixed). The floor counts the caller's own organization: a caller with one or two takes
  of a model plus FOUR other organizations gets the platform figure, so k is 4 others, not 5, and the caller's own vote, which
  it knows, is one of the five it is solving with. The 0248/0246 file pins this as intended
  (test_fewer_than_three_of_yours_and_five_workspaces_of_four_...); this test says it should not be.
  Test: test_the_floor_is_five_organizations_other_than_the_callers.
* B-0248-3 (LOW; confirmed, FAILING until fixed). Activity: with the attacker's organizations at four votes and 20 takes, the
  answer is basis null until any one other organization completes its FIRST take of that model, then 'platform', and every
  further take of the victim moves the figure. Polling the live route therefore reports when the victim works and with which
  model. Same root cause as B-0248-1 (a count of organizations is not a count of independent parties).
  Test: test_one_other_organizations_first_take_does_not_flip_the_answer_for_an_attacker_at_the_floor.
* Held (pinned, passing): a non-member, a removed member and anon get not_found / 42501 with no figure; the error does not
  differ between a film that exists and one that does not, nor between bases; at the n = 3 boundary the caller learns only its
  own figure (basis 'yours' carries no platform field, 'platform' and null carry no n or count); the answer names only the
  film's own models. Rounding to whole seconds is not a leak in itself (B-0248-1 recovers the victim's figure to the second,
  which is the same rounding the victim sees).
"""

from __future__ import annotations

import pytest

from test_sec_films_money import a, b, db, err, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are
from test_sec_take_progress_0246_0248 import _model, _takes, row_for, typical


def _sybils(db, model, fast=10, slow=900, each=5):
    """Four organizations the attacker controls, two fast and two slow, 20 takes between them (the take floor met)."""
    for secs in (fast, fast, slow, slow):
        _takes(db, db.new_org(), model, [secs] * each)


def test_organizations_the_attacker_controls_cannot_place_the_platform_figure_on_one_victims_median(db):
    m = _model()
    attacker = db.new_org()
    film = _takes(db, attacker, m, [60], status="failed")   # the attacker's film names the model; no vote of its own
    _sybils(db, m)
    victim = db.new_org()
    _takes(db, victim, m, [137])                              # one take of the victim, 137 s
    r = row_for(db, attacker.viewer, film, m)
    assert not (r.get("median_s") == 137), \
        "the second figure is exactly one other organization's median: four attacker organizations isolated it"
    assert r == {"model": m, "capability": "t2i", "basis": None}, r


def test_the_floor_is_five_organizations_other_than_the_callers(db):
    m = _model()
    caller = db.new_org()
    film = _takes(db, caller, m, [5, 5])                      # the caller's own two votes-worth: n = 2, not 'yours'
    for secs in (20, 30, 40, 50):
        _takes(db, db.new_org(), m, [secs] * 5)
    r = row_for(db, caller.viewer, film, m)
    assert r["basis"] is None, f"four organizations other than the caller's gave a figure: {r}"


def test_one_other_organizations_first_take_does_not_flip_the_answer_for_an_attacker_at_the_floor(db):
    m = _model()
    attacker = db.new_org()
    film = _takes(db, attacker, m, [60], status="failed")
    _sybils(db, m)
    before = row_for(db, attacker.viewer, film, m)
    assert before["basis"] is None
    _takes(db, db.new_org(), m, [137])                        # the victim's first take of the model
    after = row_for(db, attacker.viewer, film, m)
    assert after == before, f"one other organization's first take is visible to an attacker at the floor: {before} -> {after}"


# ── held ────────────────────────────────────────────────────────────────────

def test_non_members_removed_members_and_anon_get_no_figure_and_the_same_error(db, a, b):
    m = _model()
    film = _takes(db, a, m, [10, 11, 12])
    for secs in (20, 30, 40, 50, 60):
        _takes(db, db.new_org(), m, [secs] * 5)
    seen = set()
    for f in (film, "00000000-0000-4000-8000-0000000000bb"):
        state, msg, detail = err(lambda: typical(db, b.admin, f))
        seen.add((state, msg, detail))
    assert len(seen) == 1 and next(iter(seen))[0] == "P0002" and "not_found" in next(iter(seen))[1], seen
    db.su("delete from public.org_members where org_id = %s and user_id = %s", [a.org, a.editor])
    state, _m, _d = err(lambda: typical(db, a.editor, film))
    assert state == "P0002"
    state, _m, _d = err(lambda: db.act("anon", None, "select public.film_take_typical_seconds(%s)", [film]))
    assert state == "42501"
    state, _m, _d = err(lambda: db.act("authenticated", None, "select public.film_take_typical_seconds(%s)", [film]))
    assert state == "P0002"                                    # signed-in claims without a sub: no one's org


def test_at_the_n3_boundary_the_caller_learns_only_its_own_figure(db, a):
    m = _model()
    film = _takes(db, a, m, [7, 8])
    for secs in (20, 30, 40, 50, 60):
        _takes(db, db.new_org(), m, [secs] * 5)
    two = row_for(db, a.viewer, film, m)
    assert two == {"model": m, "capability": "t2i", "basis": None}     # five customer organizations are never a figure
    _takes(db, a, m, [9], film=film)
    three = row_for(db, a.viewer, film, m)
    assert three == {"model": m, "capability": "t2i", "basis": "yours", "median_s": 8, "n": 3}
