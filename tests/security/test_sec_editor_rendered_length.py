"""Parity of the database's rendered length (migration 0136 editor_doc_rendered_length) with the renderer's (modules/timeline.py
duration_s on the normalised document, speed curves integrated by modules/speed_ramp.py).

The paid request and the quote price THIS length, and the worker refuses a render that starts more minutes than were priced: if the
two ever disagreed a person would be charged for the wrong minutes or refused. What must hold, on a seeded corpus of more than 2000
documents (random curves of 2 to 6 points, speeds 0.25-4 on a curve and 0.1-10 constant, flat and nearly flat pieces, reverse, sub-
millisecond trims, several clips, sounds, texts, captions) and on documents built to end right at, just before and just after a
minute:

  * the database's length is Python's to the millisecond, and the started minutes are the same;
  * so is it on documents chosen so that each rounding step of the renderer changes the answer (a step skipped would show);
  * Python's round(x, 3) (half to even on the double's EXACT value) is the database's editor_ms, ties and their neighbours included;
  * a curve the renderer refuses is refused (invalid_speed_curve), and nothing the renderer accepts is.
"""

from __future__ import annotations

import json
import math
import random
import struct
from decimal import Decimal

import pytest

from modules import hires_export, speed_ramp
from modules import timeline as tl
from sec_db import as_superuser

A = "11111111-1111-4111-8111-111111111111"
SEED = 20261112
N_RANDOM = 2200


def _num(rng: random.Random, lo: float, hi: float, digits=None):
    v = rng.uniform(lo, hi)
    d = rng.choice([0, 1, 2, 3, 3, 3, 4, 5, 6]) if digits is None else digits
    return round(v, d) if d else float(round(v))


def _curve(rng: random.Random):
    n = rng.randint(2, 6)
    inner = sorted(rng.sample(range(1, 100), n - 2))
    ats = [0] + [round(x / 100 + rng.choice([0, 0, 0.001, 0.0004, 0.00049]), rng.choice([2, 3, 4, 5])) for x in inner] + [1]
    # Keep the renderer's rule (points 0.01 apart, in order); a draw that breaks it is redrawn by the caller.
    speeds = []
    for _ in range(n):
        kind = rng.random()
        if speeds and kind < 0.15:
            speeds.append(speeds[-1])                                  # a flat piece
        elif speeds and kind < 0.22:
            speeds.append(min(4.0, round(speeds[-1] * (1 + 1e-8), 9)))   # nearly flat (inside the 1e-7 rule, or just outside)
        else:
            speeds.append(_num(rng, 0.25, 4.0, rng.choice([1, 2, 3, 4, 5])))
    return [{"at": a, "speed": max(0.25, min(4.0, s))} for a, s in zip(ats, speeds)]


def _clip(rng: random.Random, cid: str, start: float):
    c = {"id": cid, "asset_id": A, "start_s": start}
    c["in_s"] = _num(rng, 0, 30)
    c["out_s"] = round(c["in_s"] + _num(rng, 0.2, 90), rng.choice([1, 2, 3, 4, 5, 6]))
    kind = rng.random()
    if kind < 0.6:
        c["speed_curve"] = _curve(rng)
    elif kind < 0.85:
        c["speed"] = _num(rng, 0.1, 10.0, rng.choice([1, 2, 3, 4]))
    else:
        c["reverse"] = True                                            # a reversed range is held in memory: a short one (REVERSE_MAX_BYTES)
        c["out_s"] = round(c["in_s"] + _num(rng, 0.1, 1.2), rng.choice([2, 3, 4, 5, 6]))
        if rng.random() < 0.5:
            c["speed"] = _num(rng, 0.1, 10.0, rng.choice([1, 2, 3]))
    return c


def _doc(rng: random.Random):
    clips = []
    start = _num(rng, 0, 5)
    for k in range(rng.randint(1, 4)):
        c = _clip(rng, f"c{k}", start)
        clips.append(c)
        start = tl.clip_end_s(tl.normalise({"version": 1, "width": 1920, "height": 1080, "fps": 30,
                                            "tracks": [{"id": "v", "kind": "V", "clips": [c]}]})["tracks"][0]["clips"][0]) + 0.05
    d = {"version": 1, "width": 1920, "height": 1080, "fps": rng.choice([24, 25, 30, 50, 60]),
         "tracks": [{"id": "v1", "kind": "V", "clips": clips}]}
    if rng.random() < 0.4:
        a0 = _num(rng, 0, 20)
        d["tracks"].append({"id": "a1", "kind": "A", "clips": [
            {"id": "s1", "asset_id": A, "start_s": a0, "in_s": 0, "out_s": _num(rng, 1, 200)}]})
    if rng.random() < 0.3:
        t0 = _num(rng, 0, 50)
        d["tracks"].append({"id": "t1", "kind": "T", "clips": [{"id": "x1", "text": "Hi", "start_s": t0, "end_s": t0 + _num(rng, 0.5, 30)}]})
    if rng.random() < 0.3:
        q0 = _num(rng, 0, 50)
        d["captions"] = {"cues": [{"id": "q1", "start_s": q0, "end_s": round(q0 + _num(rng, 0.5, 20), 4), "text": "cue"}]}
    return d


def _corpus():
    rng = random.Random(SEED)
    docs = []
    tries = 0
    while len(docs) < N_RANDOM and tries < N_RANDOM * 20:
        tries += 1
        d = _doc(rng)
        if not tl.validate(d):
            docs.append(d)
    return docs


def _boundary_docs():
    """Documents whose end is a millisecond before, at, and after each of the first five minutes (and 30:00), with and without a
    curve: the started minutes change exactly there."""
    out = []
    rng = random.Random(SEED + 1)
    for minute in (1, 2, 3, 4, 5, 30):
        for delta in (-0.002, -0.001, 0.0, 0.001, 0.002):
            for curved in (False, True):
                c = {"id": "c0", "asset_id": A, "start_s": 0, "in_s": 0.0, "out_s": 20.0}
                if curved:
                    c["speed_curve"] = [{"at": 0, "speed": 0.5}, {"at": 0.37, "speed": 1.7}, {"at": 1, "speed": 0.8}]
                    c["out_s"] = round(rng.uniform(5, 15), 3)
                norm = tl.normalise({"version": 1, "width": 1920, "height": 1080, "fps": 30, "tracks": [{"id": "v", "kind": "V", "clips": [c]}]})
                length = tl.clip_length_s(norm["tracks"][0]["clips"][0])
                c["start_s"] = round(60 * minute + delta - length, 3)
                if c["start_s"] < 0:
                    continue
                d = {"version": 1, "width": 1920, "height": 1080, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}
                if not tl.validate(d):
                    out.append(d)
    return out


def _sql_lengths(s, docs):
    rows = s.rows("select x.ord, public.editor_doc_rendered_length(x.doc)::text, "
                  "(public.editor_export_hires_terms(2560, 1440, public.editor_doc_rendered_length(x.doc)) ->> 'minutes')::int "
                  "from jsonb_array_elements(%s::jsonb) with ordinality as x(doc, ord) order by x.ord", [json.dumps(docs)])
    return [(Decimal(r[1]), r[2]) for r in rows]


def _python(d):
    length = tl.duration_s(tl.load(d))
    return Decimal(f"{length:.3f}"), hires_export.started_minutes(length)


def test_the_corpus_is_big_and_varied_enough():
    docs = _corpus()
    clips = [c for d in docs for c in d["tracks"][0]["clips"]]
    assert len(docs) >= 2000, len(docs)
    assert sum("speed_curve" in c for c in clips) >= 2000
    assert sum(c.get("reverse") is True for c in clips) >= 200
    assert sum("speed" in c and "speed_curve" not in c for c in clips) >= 500
    assert len({len(c["speed_curve"]) for c in clips if "speed_curve" in c}) == 5          # 2 to 6 points
    assert len(_boundary_docs()) >= 50


def test_the_database_length_is_the_renderers_to_the_millisecond_and_the_minutes_match(conn):
    docs = _corpus() + _boundary_docs()
    with as_superuser(conn, commit=False) as s:
        got = _sql_lengths(s, docs)
    want = [_python(d) for d in docs]
    bad = [(i, w, g) for i, (w, g) in enumerate(zip(want, got)) if w != g]
    assert not bad, (len(bad), bad[:5], [json.dumps(docs[i]) for i, _, _ in bad[:2]])
    # The minute edges were really crossed.
    minutes = {m for (_l, m) in want[-len(_boundary_docs()):]}
    assert {1, 2, 3, 4, 5, 6, 30, 31} <= minutes, minutes


# Each rounding step of the renderer, taken on purpose: documents where Python's answer changes when that one step is skipped (a
# random corpus meets most of them only once in thousands of documents). A curve whose length ends on half a millisecond, after a
# start that is not 0: duration_s rounds the length first, then the end (two roundings, not one).
_TWICE_ROUNDED_CURVES = [
    (339.648, 0.634, 20.594, 3.2), (291.331, 2.335, 9.294, 0.4), (48.036, 2.325, 6.242, 2.0), (76.686, 4.211, 9.58, 0.4),
    (473.349, 1.008, 16.863, 1.2), (539.923, 1.055, 15.356, 2.0), (23.883, 4.177, 8.697, 3.2), (226.431, 0.081, 12.437, 1.6),
    (247.726, 2.687, 8.092, 2.0), (257.903, 4.256, 12.719, 1.04),
]


def _v(clips, **extra):
    return {"version": 1, "width": 1920, "height": 1080, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": clips}], **extra}


def _step_docs():
    """(name, document, Python's length with that step skipped): the step must change Python's own answer, or the case tests nothing."""
    out = []
    for st, i, o, s in _TWICE_ROUNDED_CURVES:
        c = {"id": "c0", "asset_id": A, "start_s": st, "in_s": i, "out_s": o, "speed_curve": [{"at": 0, "speed": s}, {"at": 1, "speed": s}]}
        acc = speed_ramp.out_length(tl.clip_ramp_points(c))
        out.append(("curve length rounded before the end", _v([c]), tl._ms(st + acc)))
    rng = random.Random(SEED + 3)
    while sum(n == "plain length rounded before the end" for n, _, _ in out) < 12:
        sp = round(rng.uniform(0.1, 10), rng.choice([1, 2, 3]))
        i = round(rng.uniform(0, 5), 3)
        o = round(i + rng.uniform(0.5, 60), 3)
        st = round(rng.uniform(0, 600), 3)
        raw = tl._ms(st + (tl._ms(o) - tl._ms(i)) / sp)
        d = _v([{"id": "c0", "asset_id": A, "start_s": st, "in_s": i, "out_s": o, "speed": sp}])
        if raw != tl.duration_s(tl.load(d)):
            out.append(("plain length rounded before the end", d, raw))
    return out


def test_every_rounding_step_of_the_renderer_is_taken(conn):
    cases = _step_docs()
    for name, d, skipped in cases:
        assert not tl.validate(d), (name, tl.validate(d))
        assert tl.duration_s(tl.load(d)) != skipped, (name, json.dumps(d))     # the step matters for this document
    with as_superuser(conn, commit=False) as s:
        got = _sql_lengths(s, [d for _, d, _ in cases])
    bad = [(n, json.dumps(d), w, g) for (n, d, _), w, g in zip(cases, [_python(d) for _, d, _ in cases], got) if w != g]
    assert not bad, bad[:5]


def test_a_speed_the_renderer_would_not_use_is_read_as_the_renderer_reads_it(conn):
    """Documents the renderer refuses (validate), whose export fails with its hold released: the price must still be the length
    normalise gives, never a division by zero or a negative length. clip_speed takes a speed of 0 or less (or none) as 1, and a
    sound's speed (not a field a sound has) as written, where normalise rounds a video's only."""
    docs = [_v([{"id": "c0", "asset_id": A, "start_s": 2, "in_s": 0, "out_s": 61, "speed": sp}]) for sp in (0, -2, -0.5)]
    docs.append(_v([{"id": "c0", "asset_id": A, "start_s": 2, "in_s": 0, "out_s": 61}]))
    with as_superuser(conn, commit=False) as s:
        got = _sql_lengths(s, docs)
    want = [(Decimal(f"{tl.duration_s(tl.normalise(d)):.3f}"), 2) for d in docs]
    assert got == want == [(Decimal("63.000"), 2)] * 4, (got, want)
    sounds = []
    for sp in (0.73519, 1.23456, 1.98765, 0.50049):
        d = _v([{"id": "c0", "asset_id": A, "start_s": 0, "in_s": 0, "out_s": 2}])
        d["tracks"].append({"id": "a1", "kind": "A", "clips": [{"id": "s1", "asset_id": A, "start_s": 1.5, "in_s": 0, "out_s": 97.3, "speed": sp}]})
        assert tl.duration_s(tl.normalise(d)) != tl._ms(1.5 + tl._ms(97.3 / tl._ms(sp))), sp   # rounding it would show
        sounds.append(d)
    with as_superuser(conn, commit=False) as s:
        got = _sql_lengths(s, sounds)
    want = [(Decimal(f"{tl.duration_s(tl.normalise(d)):.3f}"), hires_export.started_minutes(tl.duration_s(tl.normalise(d)))) for d in sounds]
    assert got == want, (got, want)


def _next(x: float, up: bool) -> float:
    bits = struct.unpack("<q", struct.pack("<d", x))[0]
    return struct.unpack("<d", struct.pack("<q", bits + (1 if (x >= 0) == up else -1)))[0]


def test_editor_ms_is_pythons_round_to_three_places_ties_and_neighbours_included(conn):
    rng = random.Random(SEED + 2)
    xs = [rng.uniform(-100, 2000) for _ in range(3000)] + [rng.uniform(0, 1) for _ in range(1000)]
    ties = [k / 16 for k in range(1, 4000)] + [k + 0.0005 for k in range(0, 200)] + [60 * m + 0.0005 for m in range(1, 31)]
    xs += ties + [_next(t, True) for t in ties] + [_next(t, False) for t in ties]
    xs += [0.0, -0.0, 1e-300, 5e-324, 2.0 ** 53, 123456789.0625, 0.0625, 0.1875, -0.0625, 1.0005, 2.675, 1e15 + 0.5]
    with as_superuser(conn, commit=False) as s:
        got = [r[0] for r in s.rows("select public.editor_ms(x) from unnest(%s::float8[]) with ordinality as u(x, i) order by i", [xs])]
    bad = [(x, round(x, 3), g) for x, g in zip(xs, got) if round(x, 3) != g or math.copysign(1, round(x, 3)) != math.copysign(1, g)]
    assert not bad, bad[:10]


BAD_CURVES = [
    ("one point", {"speed_curve": [{"at": 0, "speed": 1}]}),
    ("seven points", {"speed_curve": [{"at": i / 6, "speed": 1} for i in range(7)]}),
    ("not a list", {"speed_curve": {"at": 0, "speed": 1}}),
    ("null", {"speed_curve": None}),
    ("first not at 0", {"speed_curve": [{"at": 0.1, "speed": 1}, {"at": 1, "speed": 1}]}),
    ("last not at 1", {"speed_curve": [{"at": 0, "speed": 1}, {"at": 0.9, "speed": 1}]}),
    ("too close", {"speed_curve": [{"at": 0, "speed": 1}, {"at": 0.005, "speed": 2}, {"at": 1, "speed": 1}]}),
    ("out of order", {"speed_curve": [{"at": 0, "speed": 1}, {"at": 0.6, "speed": 2}, {"at": 0.5, "speed": 2}, {"at": 1, "speed": 1}]}),
    ("too slow", {"speed_curve": [{"at": 0, "speed": 0.2}, {"at": 1, "speed": 1}]}),
    ("too fast", {"speed_curve": [{"at": 0, "speed": 1}, {"at": 1, "speed": 4.5}]}),
    ("a text speed", {"speed_curve": [{"at": 0, "speed": "1"}, {"at": 1, "speed": 1}]}),
    ("an extra key", {"speed_curve": [{"at": 0, "speed": 1, "ease": 1}, {"at": 1, "speed": 1}]}),
    ("with speed", {"speed": 2, "speed_curve": [{"at": 0, "speed": 1}, {"at": 1, "speed": 1}]}),
    ("with reverse", {"reverse": True, "speed_curve": [{"at": 0, "speed": 1}, {"at": 1, "speed": 1}]}),
    ("with freeze", {"freeze": True, "speed_curve": [{"at": 0, "speed": 1}, {"at": 1, "speed": 1}]}),
]


@pytest.mark.parametrize("name,fields", BAD_CURVES, ids=[b[0] for b in BAD_CURVES])
def test_a_curve_the_renderer_refuses_is_refused(conn, name, fields):
    c = {"id": "c0", "asset_id": A, "start_s": 0, "in_s": 0.0, "out_s": 10.0, **fields}
    d = {"version": 1, "width": 1920, "height": 1080, "fps": 30, "tracks": [{"id": "v1", "kind": "V", "clips": [c]}]}
    assert tl.validate(d), name                                    # the renderer refuses it
    with as_superuser(conn, commit=False) as s:
        out = s.run("select public.editor_doc_rendered_length(%s::jsonb)", [json.dumps(d)])
    assert (not out.ok) and out.sqlstate == "NS400" and "invalid_speed_curve" in (out.error or ""), (name, out)


def test_a_curve_on_a_sound_or_text_track_is_refused(conn):
    d = {"version": 1, "width": 1920, "height": 1080, "fps": 30, "tracks": [{"id": "a1", "kind": "A", "clips": [
        {"id": "s", "asset_id": A, "start_s": 0, "in_s": 0, "out_s": 10, "speed_curve": [{"at": 0, "speed": 1}, {"at": 1, "speed": 1}]}]}]}
    with as_superuser(conn, commit=False) as s:
        out = s.run("select public.editor_doc_rendered_length(%s::jsonb)", [json.dumps(d)])
    assert (not out.ok) and "invalid_speed_curve" in (out.error or ""), out


def test_a_document_that_is_not_one_has_no_length(conn):
    with as_superuser(conn, commit=False) as s:
        got = [s.value("select public.editor_doc_rendered_length(%s::jsonb)", [text]) for text in (
            "{}", '{"tracks": {}}', '{"tracks": [1]}', '{"tracks": [{"clips": [{"start_s": "0", "in_s": 0, "out_s": 1}]}]}',
            '{"tracks": [{"clips": [{"start_s": 0, "in_s": 0, "out_s": 1e400}]}]}', '{"tracks": [], "captions": {"cues": {}}}')]
        empty = s.value("select public.editor_doc_rendered_length('{\"tracks\": []}'::jsonb)")
    assert got == [None] * 6, got
    assert empty == 0
