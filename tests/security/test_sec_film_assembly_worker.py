"""Security lab: the film assembly worker (modules/film_assembly.py) against 0171's real money functions.

What would break if these failed: an assembly that crashes and leaves its line charged, or the whole hold unreleased; a retry that
charges the assembly twice; an assembly run for a workspace the flag does not list; a worker that lost the lease still recording.

The assembly is driven exactly as S6's worker hands it over (docs/studio/NIGHTSHIFT_AI.md, "Assembly handoff"): the segment is
claimed, every take made through 0171's own calls, film_begin_assembly, then assemble_segment on the same lease, then the worker's
settle. Only ffmpeg is faked (a render that writes a file, a probe that reads back the cut's own length): every row, charge, capture
and release below is the database's.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest

from modules import film_assembly as fa
from modules import media_library as ml

from test_sec_films_money import Db, a, db, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

SETTINGS = {"title": "The assembly", "language": "en", "target_seconds": 60, "keyframe_model": "img-key",
            "clip_model": "vid-clip", "voice": {"source": "creative_tts", "model": "tts-a", "voice_id": "voice_lab_1"},
            "captions_mode": "none"}
SCENES = [{"title": "Open", "narration": "It begins.", "visual_prompt": "a lighthouse at dusk", "planned_seconds": 10},
          {"title": "Close", "narration": "It ends.", "visual_prompt": "the lamp goes out", "planned_seconds": 8}]
FILM_S = 18.0
ASSEMBLY_CHARGE = Decimal(5)     # 18 s → 1 whole minute × the lab's film_assembly_minute rate (5)


class PgStore:
    """AssemblyStore over the lab database, reading as the service role (0166/0171's SELECT grants) and calling 0171 as it."""

    def __init__(self, d: Db):
        self.d = d

    def _rows(self, q, p):
        return self.d.one("service_role", None, f"select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from ({q}) x", p)

    def film(self, fid):
        r = self._rows("select * from public.films where id = %s", [fid])
        return r[0] if r else None

    def scenes(self, fid):
        return self._rows("select * from public.film_scenes where film_id = %s order by position", [fid])

    def takes(self, sid):
        return self._rows("select * from public.film_takes where segment_id = %s", [sid])

    def assets(self, org, ids):
        return self._rows("select id, org_id, kind, mime, duration_s, width, height, variants, source, provenance "
                          "from public.media_assets where org_id = %s and id = any(%s::uuid[]) and deleted_at is null",
                          [org, list(ids)])

    def segment(self, sid):
        r = self._rows("select * from public.film_segments where id = %s", [sid])
        return r[0] if r else None

    def _call(self, q, p):
        try:
            return self.d.svc(q, p)
        except psycopg.Error as e:
            raise fa.DbRefused(q.split("(")[0], 400, str(e).splitlines()[0]) from None

    def begin(self, sid, worker):
        return self._call("select public.film_begin_assembly(%s::uuid, %s)", [sid, worker])

    def record(self, sid, worker, ok, asset):
        return self._call("select public.film_record_assembly(%s::uuid, %s, %s, %s::uuid)", [sid, worker, ok, asset])


class PgMedia:
    """register_asset as the media worker calls it (the same id gets the same row)."""

    def __init__(self, d: Db):
        self.d = d

    def register(self, **kw):
        return self.d.su("select public.register_asset(%s::uuid, %s::uuid, %s, %s, %s, %s, %s, p_width => %s, p_height => %s, "
                         "p_duration_s => %s::numeric, p_provenance => %s::jsonb, p_variants => %s::text[])",
                         [kw["asset_id"], kw["org"], kw["kind"], kw["mime"], kw["bytes"], kw["sha256"], kw["source"],
                          kw["width"], kw["height"], kw["duration_s"], json.dumps(kw["provenance"]), kw["variants"]])[0][0]


def store_file(path, *, asset_id, org_id, store, media_root, tools, provenance, **kw):
    d = ml.asset_dir(media_root, asset_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "proxy.mp4").write_bytes(b"\0" * 1000)
    return store.register(asset_id=asset_id, org=org_id, kind="video", mime="video/mp4", bytes=1000,
                          sha256=uuid.uuid4().hex * 2, source=kw["source"], width=1920, height=1080, duration_s=FILM_S,
                          provenance=provenance, variants=["thumb", "proxy"])


def render(norm, resolver, out, **kw):
    Path(out).write_bytes(b"\0" * 64)
    render.calls += 1
    return out


render.calls = 0


def deps(org, **kw):
    d = dict(env={fa.ENABLE_ENV: "on", fa.ORGS_ENV: org}, render=render, store_file=store_file,
             probe=lambda p: fa.Probed(FILM_S, 1920, 1080, True), has_audio=lambda p, m: False, free_mb=lambda p: 1e9)
    d.update(kw)
    return fa.Deps(**d)


@pytest.fixture
def root():
    r = Path(tempfile.mkdtemp())
    yield r
    shutil.rmtree(r, ignore_errors=True)


def assembling(d: Db, o, root: Path):
    """A started film, claimed by w-1, every take made with files the cut accepts, and film_begin_assembly called."""
    film = d.film(o, SETTINGS, SCENES)
    d.quoted_start(o, film)
    seg = d.claim("w-1")
    assert seg is not None
    scenes = d.su("select id, position from public.film_scenes where film_id = %s order by position", [film])
    segments, at = [], 0.0
    for sid, pos in scenes:
        n = SCENES[pos]["planned_seconds"]
        segments.append({"scene_id": str(sid), "start_s": at + 0.25, "end_s": at + n - 0.5})
        at += n
    for t in d.takes(seg["id"]):
        tid, kind = t[0], t[1]
        if t[4] != "planned":
            continue
        d.begin(tid)
        if kind == "keyframe":
            out = d.output(o.org, tid, "image", "image/png")
        elif kind == "narration":
            out = d.asset(o.org, "audio", "audio/mpeg", duration=FILM_S,
                          provenance={"film_take_id": str(tid), "segments": segments, "loudness_lufs": None})
        else:
            out = str(d.su("select public.register_asset(gen_random_uuid(), %s, 'video', 'video/mp4', 1000, %s, 'generated', "
                           "p_width => 1920, p_height => 1080, p_duration_s => 10, p_provenance => %s::jsonb) ->> 'id'",
                           [o.org, uuid.uuid4().hex * 2, json.dumps({"film_take_id": str(tid)})])[0][0])
        for p in (ml.asset_dir(root, out),):
            p.mkdir(parents=True, exist_ok=True)
            (p / "original").write_bytes(b"\0")
        d.succeed(tid, None, out)
    d.svc("select public.film_begin_assembly(%s::uuid, 'w-1')", [seg["id"]])
    return film, seg_json(d, seg["id"])


def seg_json(d: Db, sid):
    """Ground truth, read as the table owner (film_segment_json is not granted to any API role)."""
    return d.su("select public.film_segment_json(s) from public.film_segments s where id = %s", [sid])[0][0]


def takes_charged(d: Db, seg):
    return sum(Decimal(t[6] or 0) for t in d.takes(seg))


def run(d, seg, root, worker="w-1", **kw):
    return fa.assemble_segment(seg, worker_id=worker, store=PgStore(d), media=PgMedia(d), media_root=root,
                               tools=ml.Tools("ffprobe", "ffmpeg"), deps=deps(seg["org_id"], **kw))


def test_a_completed_assembly_is_charged_its_recorded_minutes_once_and_the_rest_released(db, a, root):
    film, seg = assembling(db, a, root)
    out = run(db, seg, root)
    assert out.ok, (out.reason, out.detail)
    s = seg_json(db, seg["id"])
    assert s["assembly"]["status"] == "completed" and Decimal(str(s["assembly"]["charged_credits"])) == ASSEMBLY_CHARGE
    assert s["assembly"]["asset_id"] == out.asset_id
    settled = db.settle(seg["id"], "completed")
    assert settled["status"] == "settled"
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, seg["id"]) + ASSEMBLY_CHARGE
    assert db.film_row(film)[0] == "ready"
    assert db.account(a.org)[1] == 0   # nothing left reserved


def test_a_crash_mid_assembly_charges_it_nothing_and_settle_releases_its_line(db, a, root):
    film, seg = assembling(db, a, root)

    def boom(*args, **kw):
        raise KeyError("the worker fell over while storing")
    with pytest.raises(KeyError):
        run(db, seg, root, store_file=boom)
    s = seg_json(db, seg["id"])
    assert s["assembly"]["status"] == "failed" and Decimal(str(s["assembly"]["charged_credits"])) == 0
    settled = db.settle(seg["id"], "assembly_crashed")
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, seg["id"])
    assert db.account(a.org)[1] == 0
    assert db.holds(a.org)[-1][2] != "open"
    assert db.film_row(film) == ("paused", "assembly_crashed")


def test_a_retry_after_the_record_was_lost_reuses_the_file_and_charges_once(db, a, root):
    film, seg = assembling(db, a, root)
    store = PgStore(db)
    real = store.record
    lost = {"n": 1}

    def flaky(*args):
        if lost["n"]:
            lost["n"] -= 1
            raise ConnectionError("the database went away")
        return real(*args)
    store.record = flaky
    render.calls = 0
    with pytest.raises(ConnectionError):
        fa.assemble_segment(seg, worker_id="w-1", store=store, media=PgMedia(db), media_root=root,
                            tools=ml.Tools("ffprobe", "ffmpeg"), deps=deps(seg["org_id"]))
    assert db.su("select assembly_status from public.film_segments where id = %s", [seg["id"]])[0][0] == "running"
    out = run(db, seg, root)
    again = run(db, seg, root)
    assert out.ok and again.ok and out.asset_id == again.asset_id
    assert render.calls == 1, "the same cut was rendered twice"
    settled = db.settle(seg["id"], "completed")
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, seg["id"]) + ASSEMBLY_CHARGE
    # One capture for the whole segment (0020 settles once), of exactly that amount: the assembly is in it once.
    captures = db.ledger(a.org, "capture")
    assert len(captures) == 1 and abs(Decimal(captures[0])) == Decimal(str(settled["captured_credits"])), captures


def test_a_workspace_the_flag_does_not_list_is_never_assembled_and_pays_nothing_for_it(db, a, root):
    film, seg = assembling(db, a, root)
    render.calls = 0
    out = run(db, seg, root, env={fa.ENABLE_ENV: "on", fa.ORGS_ENV: str(uuid.uuid4())})
    assert (out.ok, out.reason) == (False, "assembly_not_enabled")
    assert render.calls == 0
    s = seg_json(db, seg["id"])
    assert s["assembly"]["status"] == "failed" and Decimal(str(s["assembly"]["charged_credits"])) == 0
    settled = db.settle(seg["id"], out.reason)
    assert Decimal(str(settled["captured_credits"])) == takes_charged(db, seg["id"])


def test_a_worker_that_lost_the_lease_records_nothing(db, a, root):
    film, seg = assembling(db, a, root)
    render.calls = 0
    out = run(db, seg, root, worker="w-intruder")
    assert (out.ok, out.reason) == (False, "lease_lost")
    assert render.calls == 0
    assert db.su("select assembly_status from public.film_segments where id = %s", [seg["id"]])[0][0] == "running"
