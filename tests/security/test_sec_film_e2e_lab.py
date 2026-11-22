"""Film Studio end to end in the security lab: the REAL segment worker (modules/film_orchestrator.py: FilmOrchestrator + FilmRest, and
the creative job calls of modules/creative_worker.CreativeRest) against the REAL migrations 0171/0198/0200, over an in-process
PostgREST stand-in.

Why this exists (rule 8, measurement first): tests/test_film_orchestrator.py drives the orchestrator against a fake 0171, and
test_sec_film_assembly_worker.py drives only the assembly against real SQL. Nothing had ever sent FilmRest's RPC bodies, its read
selects, or CreativeRest's job calls to the real function signatures. A body key the function does not have is exactly the bug class
this file hunts, so the stand-in REFUSES it (404, as PostgREST answers an unknown overload), never drops it.

What is faked, and only this:
  * the HTTP hop (FakePostgrest): every POST /rest/v1/rpc/<name> calls public.<name>(k => v, ...) as service_role, the arguments
    typed from pg_catalog through jsonb_to_record (what PostgREST itself does); every GET reads the table as service_role;
  * the provider (LabAdapter, through the resolver interface the worker uses: model id -> adapter);
  * ffmpeg/ffprobe (LabMedia: the real Media.copy_input and the real media_library.store_generated, with only the probe, the
    thumbnail/proxy encode, the last-frame extract, the narration mix and the loudness faked);
  * the assembly's render and probe (test_sec_film_assembly_worker's fakes), while the REAL modules.film_assembly.assemble_segment is
    run through the orchestrator's ``assemble=`` hook with ``db=<FilmRest>`` exactly as the orchestrator calls it, so its own REST
    clients (AssemblyStore/MediaStore, built by clients_from) also go through the stand-in.
Every row, charge, capture and release asserted below is the database's.
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
import pytest
from psycopg import sql

from modules import creative_worker as cw
from modules import film_assembly as fa
from modules import film_orchestrator as fo
from modules import media_library as ml

import test_sec_film_assembly_worker as asm_lab
from test_sec_films_money import Db, a, db, no_live_segment  # noqa: F401 — the money lab's fixtures, reused as they are

URL = "http://lab-postgrest.invalid"
KEY = "lab-dummy-service-key"   # not a secret: the stand-in only checks that the worker sends the one it was given
SETTINGS = {"title": "The lighthouse", "language": "en", "target_seconds": 60, "keyframe_model": "img-key",
            "clip_model": "vid-clip", "voice": {"source": "creative_tts", "model": "tts-a", "voice_id": "voice_lab_1"},
            "captions_mode": "none"}
# Scene 2 starts from scene 1's last frame: the chain key frame -> clip -> last frame -> clip runs through the database's inputs.
SCENES = [{"title": "Open", "narration": "It begins.", "visual_prompt": "a lighthouse at dusk", "planned_seconds": 10},
          {"title": "Close", "narration": "It ends.", "visual_prompt": "the lamp goes out", "planned_seconds": 8,
           "first_frame": "previous"}]
assert sum(s["planned_seconds"] for s in SCENES) == asm_lab.FILM_S  # the assembly lab's render/probe fakes measure this length

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 256
MP4 = b"\0\0\0\x18ftypisom\0\0\0\0isomiso2" + b"\0" * 256
MP3 = b"ID3\x04\0\0\0\0\0\0" + b"\0" * 256
M4A = b"\0\0\0\x18ftypM4A \0\0\0\0M4A isom" + b"\0" * 256
VIDEO_S = 10.0       # what a lab clip measures (each clip line is confirmed for 10 s)
SCENE_TTS_S = 2.0    # one scene's voiced words: 0.25 + 2 + 0.25 fits the 8 s scene


# ── the PostgREST stand-in ──────────────────────────────────────────────────

class Resp:
    def __init__(self, status: int, body):
        self.status_code = status
        self.text = "" if body is None else json.dumps(body)
        self.content = self.text.encode()

    def json(self):
        if not self.text:
            raise ValueError("empty body")
        return json.loads(self.text)


def http_status(sqlstate: str) -> int:
    """PostgREST's SQLSTATE -> HTTP table (docs, "Errors"), the part these functions can reach."""
    s = sqlstate or ""
    if s.startswith("08") or s.startswith("53"):
        return 503
    if s == "42501":
        return 403
    if s in ("23503", "23505"):
        return 409
    if s == "P0001":
        return 400
    if s in ("42883", "42P01"):
        return 404
    if s[:2] in ("09", "25", "2D", "38", "39", "3B", "40", "54", "55", "57", "58", "F0", "HV", "P0", "XX"):
        return 500
    return 400


class FakePostgrest:
    """A requests.Session-like object over the lab database. Honest on purpose: an RPC body key that is not a parameter of any
    overload is a 404 (PGRST202), a SQL error is PostgREST's 4xx/5xx with {code, message, details, hint}, and a call runs in its own
    transaction as service_role (EXECUTE grants and RLS apply as they would behind the gateway)."""

    _IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")

    def __init__(self, dsn: str):
        self.dsn = dsn
        self.calls: list = []      # (method, name, sorted body keys or params) — never values
        self.unknown: list = []    # RPCs refused because their body did not match a signature
        self._lock = threading.Lock()

    # -- requests.Session's surface ---------------------------------------------------
    def post(self, url, json=None, headers=None, timeout=None, **kw):  # noqa: A002 — requests' own keyword
        return self.request("POST", url, json=json, headers=headers, timeout=timeout, **kw)

    def get(self, url, params=None, headers=None, timeout=None, **kw):
        return self.request("GET", url, params=params, headers=headers, timeout=timeout, **kw)

    def patch(self, url, **kw):
        return self.request("PATCH", url, **kw)

    def request(self, method, url, *, json=None, params=None, headers=None, timeout=None, **kw):  # noqa: A002
        h = headers or {}
        if h.get("apikey") != KEY or h.get("Authorization") != f"Bearer {KEY}":
            return Resp(401, {"code": "PGRST301", "message": "JWT invalid"})
        parts = urlsplit(url)
        assert f"{parts.scheme}://{parts.netloc}" == URL, "a call left the lab"
        path = parts.path
        assert path.startswith("/rest/v1/"), path
        rest = path[len("/rest/v1/"):]
        if method == "POST" and rest.startswith("rpc/"):
            return self._rpc(rest[4:], json if json is not None else {})
        if method == "GET":
            return self._select(rest, dict(params or {}))
        return Resp(405, {"code": "PGRST", "message": f"{method} not supported by the lab stand-in"})

    # -- RPC --------------------------------------------------------------------------
    def _overloads(self, c, name):
        return c.execute(
            "select p.proname, p.pronargs, p.pronargdefaults, p.proretset, coalesce(p.proargnames, '{}'), "
            "       coalesce(p.proargmodes::text[], '{}'), "
            "       array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality u(t, i) order by i) "
            "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = %s",
            [name]).fetchall()

    def _rpc(self, name: str, body):
        keys = sorted(body) if isinstance(body, dict) else None
        with self._lock:
            self.calls.append(("rpc", name, tuple(keys or ())))
        if not self._IDENT.match(name) or keys is None:
            return Resp(404, {"code": "PGRST202", "message": f"Could not find the function public.{name}"})
        with psycopg.connect(self.dsn, autocommit=False) as c:
            match = None
            for _n, nargs, ndef, retset, names, modes, types in self._overloads(c, name):
                ins = [nm for i, nm in enumerate(names) if not modes or modes[i] in ("i", "b", "v")][:nargs]
                if len(ins) != nargs:
                    continue
                required = set(ins[:nargs - ndef])
                if set(keys) <= set(ins) and required <= set(keys):
                    match = (retset, ins, types)
                    break
            if match is None:
                with self._lock:
                    self.unknown.append((name, tuple(keys)))
                return Resp(404, {"code": "PGRST202", "hint": None, "details": None,
                                  "message": f"Could not find the function public.{name}({', '.join(keys)}) in the schema cache"})
            retset, ins, types = match
            typ = dict(zip(ins, types))
            fn = sql.SQL("public.{}").format(sql.Identifier(name))
            args = sql.SQL(", ").join(sql.SQL("{} => r.{}").format(sql.Identifier(k), sql.Identifier(k)) for k in keys)
            if keys:
                cols = sql.SQL(", ").join(sql.SQL("{} {}").format(sql.Identifier(k), sql.SQL(typ[k])) for k in keys)
                src = sql.SQL("jsonb_to_record(%s::jsonb) as r({})").format(cols)
                params = [json.dumps(body)]
            else:
                src, params = None, []
            if retset:
                q = sql.SQL("select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from {} {} x").format(
                    sql.SQL("{}, lateral").format(src) if src else sql.SQL(""), sql.SQL("{}({})").format(fn, args))
            elif src:
                q = sql.SQL("select to_jsonb({}({}))::text from {}").format(fn, args, src)
            else:
                q = sql.SQL("select to_jsonb({}())::text").format(fn)
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
                c.execute("set local role service_role")
                row = c.execute(q, params).fetchone()
                c.commit()
            except psycopg.Error as e:
                c.rollback()
                d = e.diag
                return Resp(http_status(e.sqlstate or ""), {"code": e.sqlstate, "message": d.message_primary,
                                                            "details": d.message_detail, "hint": d.message_hint})
        text = row[0] if row else None
        return Resp(200, None if text is None else json.loads(text))

    # -- table reads ----------------------------------------------------------------------
    def _select(self, table: str, params: dict):
        with self._lock:
            self.calls.append(("get", table, tuple(sorted(params))))
        if not self._IDENT.match(table):
            return Resp(404, {"code": "42P01", "message": "relation does not exist"})
        cols = params.pop("select", "*")
        order = params.pop("order", None)
        sel = sql.SQL("*") if cols == "*" else sql.SQL(", ").join(sql.Identifier(x.strip()) for x in cols.split(","))
        conds, vals = [], []
        for col, spec in params.items():
            op, _, v = str(spec).partition(".")
            ident = sql.Identifier(col)
            if op == "eq":
                conds.append(sql.SQL("{}::text = %s").format(ident))
                vals.append(v)
            elif op == "in":
                conds.append(sql.SQL("{}::text = any(%s::text[])").format(ident))
                vals.append([x for x in v.strip("()").split(",") if x])
            elif op == "is" and v == "null":
                conds.append(sql.SQL("{} is null").format(ident))
            else:
                return Resp(400, {"code": "PGRST100", "message": f"unsupported filter {col}={spec}"})
        where = sql.SQL(" where ") + sql.SQL(" and ").join(conds) if conds else sql.SQL("")
        ob = sql.SQL("")
        if order:
            col, _, d = order.partition(".")
            ob = sql.SQL(" order by {} {}").format(sql.Identifier(col), sql.SQL("desc" if d == "desc" else "asc"))
        q = sql.SQL("select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text from (select {} from public.{}{}{}) x").format(
            sel, sql.Identifier(table), where, ob)
        with psycopg.connect(self.dsn, autocommit=False) as c:
            try:
                c.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps({"role": "service_role"})])
                c.execute("set local role service_role")
                text = c.execute(q, vals).fetchone()[0]
                c.commit()
            except psycopg.Error as e:
                c.rollback()
                return Resp(http_status(e.sqlstate or ""), {"code": e.sqlstate, "message": e.diag.message_primary,
                                                            "details": e.diag.message_detail})
        return Resp(200, json.loads(text))

    def rpcs(self, name):
        return [c for c in self.calls if c[0] == "rpc" and c[1] == name]


# ── the provider and the media side ───────────────────────────────────────────

class ProviderErr(Exception):
    def __init__(self, code, message="the provider refused"):
        super().__init__(message)
        self.code, self.message = code, message


class LabAdapter:
    """One model. ``script``: per submit, None (accepted) or an exception to raise. ``on_poll(adapter, task)`` may answer a poll itself
    (return a ProviderPoll) or return None for the default: the file is written and the task succeeds."""

    def __init__(self, model, payload, script=None, on_poll=None):
        self.model, self.payload = model, payload
        self.script = list(script or [])
        self.on_poll = on_poll
        self.usage = False         # report what the vendor billed (record_creative_job_cost, whose errors the worker only logs)
        self.submits: list = []
        self.inputs: list = []     # the bytes of the pictures each call was handed (the work dir goes after the take)
        self.polls: list = []

    def submit(self, request):
        self.submits.append(request)
        self.inputs.append([Path(f).read_bytes() for f in request.input_files])
        if self.script:
            e = self.script.pop(0)
            if e is not None:
                raise e
        return f"lab-{self.model}-{len(self.submits)}"

    def poll(self, task, request, out_dir):
        self.polls.append(task)
        if self.on_poll is not None:
            r = self.on_poll(self, task)
            if r is not None:
                return r
        out_dir.mkdir(parents=True, exist_ok=True)
        f = out_dir / "output_0.bin"
        f.write_bytes(self.payload)
        usage = cw.ProviderUsage("acme", vendor_model="acme-" + self.model, unit="call", quantity=1.0) if self.usage else None
        return cw.ProviderPoll(cw.SUCCEEDED, files=[f], usage=usage)


def adapters(**script):
    return {"img-key": LabAdapter("img-key", PNG, script.get("img")),
            "vid-clip": LabAdapter("vid-clip", MP4, script.get("vid")),
            "tts-a": LabAdapter("tts-a", MP3, script.get("tts"))}


def lab_probe(exe, path, sniffed, **kw):
    kind = ml.ALLOWED_MIME[sniffed]
    dur = VIDEO_S if kind == "video" else (asm_lab.FILM_S if kind == "audio" else None)
    return ml.Probe(kind, sniffed, 1920, 1080, dur)


def lab_runner(argv, beat, *, timeout_s, frame_px=None, **kw):
    """ffmpeg's thumbnail / 480p proxy: the variant file is written, exit 0."""
    for x in argv:
        p = Path(str(x))
        if p.name in (ml.VARIANT_FILES["thumb"], ml.VARIANT_FILES["proxy"]):
            p.write_bytes(b"\0" * 64)
    return 0


class LabMedia(fo.Media):
    """The real Media (copy_input) and the real store_generated through register_asset over the stand-in; ffmpeg faked."""

    def store_file(self, path, *, asset_id, org_id, provenance, expect_kind, parent_asset_id=None):
        return ml.store_generated(path, asset_id=asset_id, org_id=org_id, store=self.store, media_root=self.media_root,
                                  tools=self.tools, provenance=provenance, expect_kind=expect_kind, parent_asset_id=parent_asset_id,
                                  runner=lab_runner, prober=lab_probe)

    def last_frame(self, video, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(PNG)
        return out

    def duration(self, path):
        with open(path, "rb") as f:
            kind = ml.ALLOWED_MIME.get(ml.sniff(f.read(64)) or "")
        if kind == "video":
            return VIDEO_S
        if kind == "audio":
            return asm_lab.FILM_S if Path(path).name.startswith("narration") else SCENE_TTS_S
        return None

    def narration_mix(self, clips, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(M4A)
        return out

    def loudness(self, path):
        return -16.0, -1.5


# ── the lab ─────────────────────────────────────────────────────────────────

class Lab:
    def __init__(self, d: Db, root: Path, pg: FakePostgrest):
        self.d, self.root, self.pg = d, root, pg
        self.media_root = root / "media"
        self.media_root.mkdir()
        self.tools = ml.Tools("ffprobe", "ffmpeg")
        self.rest = fo.FilmRest(URL, KEY, session=pg)
        self.rest.creative._http = pg
        self.assembled: list = []

    def assemble(self, seg, *, worker_id, db, media_root, tools):
        """The orchestrator's own call into the REAL assembly, with only its render and probe faked."""
        self.assembled.append((seg["id"], worker_id))
        return fa.assemble_segment(seg, worker_id=worker_id, db=db, media_root=media_root, tools=tools,
                                   deps=asm_lab.deps(seg["org_id"]))

    def worker(self, ads, worker_id="w-1", stop=None, **kw):
        media = LabMedia(ml.MediaStore(URL, KEY, session=self.pg), self.media_root, self.tools)
        kw.setdefault("env", {fo.ASSEMBLY_FLAG: "on"})
        return fo.FilmOrchestrator(self.rest, ads.get, worker_id=worker_id, media=media, out_dir=self.root / f"out-{worker_id}",
                                   media_root=self.media_root, tools=self.tools, assemble=self.assemble, heartbeat_seconds=0,
                                   poll_seconds=0, sleep=lambda s: None, stop=stop, **kw)

    # -- the browser's side, as the org's people ---------------------------------
    def started(self, o):
        fid = self.d.film(o, SETTINGS, SCENES)
        q = self.d.quote(o.admin, fid)
        assert q["startable"] is True, (q["blocked_by"], q["refusals"])
        seg = self.d.start(o.admin, fid, q["quote_id"], self.d.key())
        assert seg["ok"] is True, seg
        return fid, seg

    # -- ground truth ---------------------------------------------------------------
    def money(self, sid):
        takes = Decimal(self.d.su("select coalesce(sum(charged_credits), 0) from public.film_takes where segment_id = %s", [sid])[0][0])
        asm = self.d.su("select coalesce(assembly_charged_credits, 0) from public.film_segments where id = %s", [sid])[0][0]
        return takes, Decimal(asm)

    def take_rows(self, sid):
        return self.d.su("select t.kind, s.position, t.attempt, t.status, t.charged_credits, t.charge_basis, t.error_code "
                         "from public.film_takes t left join public.film_scenes s on s.id = t.scene_id where t.segment_id = %s "
                         "order by case t.kind when 'keyframe' then 0 when 'narration' then 2 else 1 end, s.position nulls last, "
                         "t.shot_index, t.attempt", [sid])


@pytest.fixture
def lab(db, tmp_path, monkeypatch):
    pg = FakePostgrest(db.dsn)
    import requests
    # No network, ever: any client the code under test builds for itself (clients_from's MediaStore) gets the stand-in too.
    monkeypatch.setattr(requests, "Session", lambda: pg)
    yield Lab(db, tmp_path, pg)
    # Every RPC the worker sent matched a real signature: a body key the function does not have is the bug this file hunts.
    assert pg.unknown == [], f"RPC bodies that match no real function signature: {pg.unknown}"


def settled_money_holds(lab, o, sid, before_balance):
    """captured == the takes' and the assembly's charges, never above the hold; the rest released; the ledger moved by exactly it."""
    status, captured, _reason, ref, confirmed, _att = lab.d.segment(sid)
    takes, asm = lab.money(sid)
    holds = [h for h in lab.d.holds(o.org) if h[0] == ref]
    assert len(holds) == 1, holds
    _job, held, hold_status, hold_captured = holds[0]
    assert Decimal(held) == Decimal(confirmed)
    assert Decimal(captured) == takes + asm <= Decimal(held), (captured, takes, asm, held)
    balance, reserved = lab.d.account(o.org)
    assert reserved == 0, "a part of the hold was left reserved"
    assert Decimal(before_balance) - Decimal(balance) == Decimal(captured)
    if Decimal(captured) > 0:
        assert hold_status == "captured" and Decimal(hold_captured) == Decimal(captured)
        caps = lab.d.ledger(o.org, "capture")
        assert len(caps) == 1 and abs(Decimal(caps[0])) == Decimal(captured), caps
    else:
        assert hold_status != "open" and lab.d.ledger(o.org, "capture") == []
    return status, Decimal(captured)


# ── the happy path ────────────────────────────────────────────────────────────

def test_happy_path_real_worker_makes_every_take_assembles_and_captures_exactly_the_charges(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    ads = adapters()
    for ad in ads.values():
        ad.usage = True
    out = lab.worker(ads).run_once()
    assert out is not None and out.segment_id == seg["id"]
    assert (out.result, out.reason) == ("settled", "completed"), (out, lab.take_rows(seg["id"]), lab.d.segment(seg["id"]))
    rows = lab.take_rows(seg["id"])
    assert [(r[0], r[1], r[2], r[3]) for r in rows] == [("keyframe", 0, 1, "completed"), ("clip", 0, 1, "completed"),
                                                        ("clip", 1, 1, "completed"), ("narration", None, 1, "completed")], rows
    # One provider call per take: no retry loop of the worker's own, no fallback model.
    assert (len(ads["img-key"].submits), len(ads["vid-clip"].submits), len(ads["tts-a"].submits)) == (1, 2, 2)
    # The clips started from the database's pictures (key frame, then scene 1's last frame), copied from the library.
    assert ads["vid-clip"].inputs == [[PNG], [PNG]]
    assert lab.assembled == [(seg["id"], "w-1")]
    s = asm_lab.seg_json(lab.d, seg["id"])
    assert s["assembly"]["status"] == "completed" and s["assembly"]["asset_id"]
    status, captured = settled_money_holds(lab, a, seg["id"], before)
    assert status == "settled" and captured > 0
    assert lab.d.film_row(fid)[0] == "ready"
    ev = lab.d.events(fid)
    assert "started" in ev and ev[-1] == "segment_settled", ev
    # Every take's creative job ended completed, film-paid, with no hold of its own.
    jobs = lab.d.su("select j.status, j.payer, j.credit_ref from public.creative_jobs j join public.film_takes t on t.creative_job_id = j.id "
                    "where t.segment_id = %s", [seg["id"]])
    assert sorted(jobs) == [("completed", "film", None)] * 4, jobs
    # What the vendor billed the platform, one row per provider call (the worker only logs this call's failure: checked here).
    assert lab.d.su("select count(*) from public.creative_job_costs c join public.film_takes t on t.creative_job_id = c.job_id "
                    "where t.segment_id = %s", [seg["id"]])[0][0] == 5
    # Every call the worker and the assembly made reached a real function (the fixture also asserts none was refused as unknown).
    called = {c[1] for c in lab.pg.calls if c[0] == "rpc"}
    assert called >= {"film_claim_segment", "film_studio_on_for", "film_begin_take", "film_take_job", "advance_creative_job",
                      "register_asset", "attach_creative_job_assets", "film_take_succeeded", "finish_creative_job",
                      "record_creative_job_cost", "film_begin_assembly", "film_heartbeat_segment", "film_record_assembly",
                      "film_settle_segment"}, called
    # The worker found nothing more to do.
    assert lab.worker(adapters()).run_once() is None


# ── provider outage, timeout ──────────────────────────────────────────────────

def test_a_provider_outage_on_one_take_is_charged_zero_and_its_one_retry_is_charged_once(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    ads = adapters(vid=[ProviderErr("provider_error", "502 from the vendor")])
    out = lab.worker(ads).run_once()
    assert (out.result, out.reason) == ("settled", "completed"), (out, lab.take_rows(seg["id"]))
    clips = [r for r in lab.take_rows(seg["id"]) if r[0] == "clip" and r[1] == 0]
    assert [(r[2], r[3], Decimal(r[4]), r[6]) for r in clips] == [(1, "superseded", Decimal(0), "provider_error"),
                                                                  (2, "completed", Decimal(20), None)], clips
    assert len(ads["vid-clip"].submits) == 3  # the failed call, its one retry, scene 2's clip
    status, captured = settled_money_holds(lab, a, seg["id"], before)
    assert status == "settled" and lab.d.film_row(fid)[0] == "ready"


def test_a_clip_that_fails_twice_is_charged_nothing_the_film_pauses_and_the_rest_of_the_hold_goes_back(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    # Scene 1's clip is fine; scene 2's clip fails, and so does 0171's one retry.
    ads = adapters(vid=[None, ProviderErr("provider_error"), ProviderErr("provider_error")])
    out = lab.worker(ads).run_once()
    assert (out.result, out.reason) == ("settled", "takes_failed"), (out, lab.take_rows(seg["id"]))
    s2 = [r for r in lab.take_rows(seg["id"]) if r[0] == "clip" and r[1] == 1]
    assert [(r[2], r[3], Decimal(r[4])) for r in s2] == [(1, "superseded", Decimal(0)), (2, "failed", Decimal(0))], s2
    assert lab.assembled == []
    status, captured = settled_money_holds(lab, a, seg["id"], before)
    assert status == "settled" and captured > 0
    assert lab.d.film_row(fid) == ("paused", "takes_failed")


def test_a_paused_film_resumed_is_driven_by_the_real_worker_unchanged_and_nothing_made_is_made_or_paid_again(lab, a):
    """0215 (gate G1): the film above pauses (scene 2's clip failed twice). Its admin quotes and starts the resume through the real
    SQL; the same worker, unchanged, claims the resume segment, skips the carried takes (completed, at 0), makes only scene 2's clip
    from scene 1's carried last frame, assembles, and settles. The new hold pays only what was left."""
    fid, seg = lab.started(a)
    out = lab.worker(adapters(vid=[None, ProviderErr("provider_error"), ProviderErr("provider_error")])).run_once()
    assert (out.result, out.reason) == ("settled", "takes_failed"), out
    first = Decimal(lab.d.segment(seg["id"])[1])
    balance = lab.d.account(a.org)[0]
    q = lab.d.one("authenticated", a.admin, "select public.quote_film_resume(%s::uuid, %s::integer)", [fid, lab.d.version(fid)])
    assert sorted(ln["line"] for ln in q["lines"]) == ["assembly", "clip"] and q["startable"] is True, q
    r = lab.d.one("authenticated", a.admin, "select public.start_film_resume(%s::uuid, %s, %s)", [fid, q["quote_id"], lab.d.key()])
    assert r["ok"] is True and r["carried"] == 3, r
    ads = adapters()
    out = lab.worker(ads).run_once()
    assert out.segment_id == r["id"] and (out.result, out.reason) == ("settled", "completed"), (out, lab.take_rows(r["id"]))
    # Only scene 2's clip reached a vendor: the key frame, scene 1's clip and the narration were carried, not made again.
    assert (len(ads["img-key"].submits), len(ads["vid-clip"].submits), len(ads["tts-a"].submits)) == (0, 1, 0)
    assert ads["vid-clip"].inputs == [[PNG]]
    carried_last, new_first = lab.d.su(
        "select (select t.result_last_frame_asset_id from public.film_takes t join public.film_scenes s on s.id = t.scene_id "
        "         where t.segment_id = %s and t.kind = 'clip' and s.position = 0), "
        "       (select t.first_frame_asset_id from public.film_takes t join public.film_scenes s on s.id = t.scene_id "
        "         where t.segment_id = %s and t.kind = 'clip' and s.position = 1)", [r["id"], r["id"]])[0]
    assert carried_last is not None and new_first == carried_last
    assert lab.assembled == [(r["id"], "w-1")]
    rows = lab.take_rows(r["id"])
    assert sorted((x[0], x[1], x[3], Decimal(x[4]), x[5]) for x in rows) == sorted([
        ("keyframe", 0, "completed", Decimal(0), "carried_not_charged"), ("clip", 0, "completed", Decimal(0), "carried_not_charged"),
        ("narration", None, "completed", Decimal(0), "carried_not_charged"), ("clip", 1, "completed", Decimal(20), "full_line")]), rows
    status, captured, _reason, ref, confirmed, _att = lab.d.segment(r["id"])
    takes, asm = lab.money(r["id"])
    assert status == "settled" and Decimal(captured) == takes + asm == Decimal(25) <= Decimal(confirmed)
    hold = [h for h in lab.d.holds(a.org) if h[0] == ref][0]
    assert hold[2] == "captured" and Decimal(hold[1]) == Decimal(confirmed) and Decimal(hold[3]) == Decimal(captured)
    assert lab.d.account(a.org) == (balance - Decimal(captured), 0)
    assert lab.d.ledger(a.org, "capture") == [-first, -Decimal(captured)]  # the film's 49, once: 24 then 25
    assert lab.d.film_row(fid) == ("ready", None)
    assert lab.worker(adapters()).run_once() is None


def test_a_key_frame_that_fails_twice_skips_both_clips_at_zero_but_the_narration_is_still_voiced_and_charged(lab, a):
    """The key frame fails, and so does its retry: neither clip can begin (no picture to start from). What the run still spends is
    measured here: the narration is still voiced and charged, which is what 0171's settle captures."""
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    ads = adapters(img=[ProviderErr("provider_error"), ProviderErr("provider_error")])
    out = lab.worker(ads).run_once()
    assert out.result == "settled" and out.reason == "takes_failed", out
    assert ads["vid-clip"].submits == []  # never sent: its input failed for good
    rows = lab.take_rows(seg["id"])
    assert [(r[0], r[3]) for r in rows if r[0] == "clip"] == [("clip", "skipped"), ("clip", "skipped")], rows
    assert all(Decimal(r[4] or 0) == 0 for r in rows if r[0] != "narration"), rows
    status, captured = settled_money_holds(lab, a, seg["id"], before)
    narr = [r for r in rows if r[0] == "narration"][0]
    # Measured, not endorsed: the narration (1 credit, the job minimum) is still voiced for a segment that can no longer become a
    # film, so the film pauses with that capture instead of going back to draft at 0 (film_orchestrator._inputs_ready: a narration
    # is always ready). Reported to the lead as a rule-6 question; pinned here so a change to it is a decision, not an accident.
    assert (narr[3], Decimal(narr[4])) == ("completed", Decimal(1)) and captured == Decimal(1)
    assert lab.d.film_row(fid) == ("paused", "takes_failed")


def test_both_attempts_failing_on_the_only_billable_path_releases_the_whole_hold_and_returns_the_film_to_draft(lab, a):
    """Every provider is down: nothing is made, nothing is charged, the film goes back to its storyboard (0171's rule)."""
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    down = [ProviderErr("provider_error")] * 2
    ads = adapters(img=list(down), vid=list(down), tts=list(down))
    out = lab.worker(ads).run_once()
    assert out.result == "settled", out  # 'released' counts as settled for the worker
    status, captured = settled_money_holds(lab, a, seg["id"], before)
    assert (status, captured) == ("released", Decimal(0))
    assert lab.d.film_row(fid)[0] == "draft"


@pytest.mark.parametrize("code", ["provider_timeout", "timeout"])
def test_a_provider_timeout_is_stored_as_timeout_charged_zero_and_retried_once(lab, a, code):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    ads = adapters(img=[ProviderErr(code, "the vendor did not answer in time")])
    out = lab.worker(ads).run_once()
    assert (out.result, out.reason) == ("settled", "completed"), (out, lab.take_rows(seg["id"]))
    kf = [r for r in lab.take_rows(seg["id"]) if r[0] == "keyframe"]
    assert [(r[2], r[3], Decimal(r[4]), r[6]) for r in kf] == [(1, "superseded", Decimal(0), "timeout"),
                                                              (2, "completed", Decimal(3), None)], kf
    settled_money_holds(lab, a, seg["id"], before)


def test_a_task_the_provider_never_finishes_times_out_by_the_workers_clock_and_is_charged_zero(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    pending = {"n": 0}

    def never_first(ad, task):
        if task.endswith("-1"):
            pending["n"] += 1
            return cw.ProviderPoll(cw.PENDING)
        return None

    ads = adapters()
    ads["img-key"].on_poll = never_first
    tick = iter(range(0, 10 ** 9, 100))
    out = lab.worker(ads, clock=lambda: float(next(tick)), max_poll_seconds=250).run_once()
    assert (out.result, out.reason) == ("settled", "completed"), out
    kf = [r for r in lab.take_rows(seg["id"]) if r[0] == "keyframe"]
    assert [(r[2], r[3], Decimal(r[4]), r[6]) for r in kf] == [(1, "superseded", Decimal(0), "timeout"),
                                                              (2, "completed", Decimal(3), None)], kf
    settled_money_holds(lab, a, seg["id"], before)


# ── the start ──────────────────────────────────────────────────────────────────

def test_insufficient_credits_refuse_the_start_with_ns402_and_the_worker_finds_nothing_to_claim(lab):
    o = lab.d.new_org(credits=10)
    fid = lab.d.film(o, SETTINGS, SCENES)
    q = lab.d.quote(o.admin, fid)
    assert [r["reason"] for r in q["blocked_by"]] == ["insufficient_credits"] and q["startable"] is False
    out = lab.d.start(o.admin, fid, q["quote_id"], lab.d.key())
    assert (out.get("ok"), out.get("reason"), out.get("code")) == (False, "insufficient_credits", "NS402"), out
    assert lab.d.holds(o.org) == [] and lab.d.account(o.org) == (Decimal(10), Decimal(0))
    assert lab.worker(adapters()).run_once() is None
    assert lab.d.film_row(fid)[0] == "draft"


def test_a_rate_that_moved_after_the_quote_refuses_the_start_as_price_changed(lab, a):
    fid = lab.d.film(a, SETTINGS, SCENES)
    qid = lab.d.quote(a.admin, fid)["quote_id"]
    try:
        lab.d.su("update public.credit_prices set credits_per_unit = 3 where unit = 'model_vid_clip_second'")
        out = lab.d.start(a.admin, fid, qid, lab.d.key())
    finally:
        lab.d.su("update public.credit_prices set credits_per_unit = 2 where unit = 'model_vid_clip_second'")
    assert (out.get("ok"), out.get("reason"), out.get("code")) == (False, "price_changed", "NS409"), out
    assert lab.d.holds(a.org) == [] and lab.worker(adapters()).run_once() is None


def _err(fn):
    with pytest.raises(psycopg.Error) as e:
        fn()
    return e.value.sqlstate, str(e.value).splitlines()[0]


def test_a_duplicate_start_with_the_same_key_replays_one_segment_and_a_new_key_is_refused(lab, a):
    fid = lab.d.film(a, SETTINGS, SCENES)
    qid, key = lab.d.quote(a.admin, fid)["quote_id"], lab.d.key()
    first = lab.d.start(a.admin, fid, qid, key)
    again = lab.d.start(a.admin, fid, qid, key)
    assert first["ok"] is True and again["id"] == first["id"] and again["replayed"] is True
    assert _err(lambda: lab.d.start(a.admin, fid, qid, lab.d.key())) == ("NS409", "film_not_startable")
    assert len(lab.d.holds(a.org)) == 1
    assert lab.d.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1
    before = lab.d.account(a.org)[0]
    w = lab.worker(adapters())
    assert w.run_once().result == "settled"
    assert w.run_once() is None  # one segment, driven once
    settled_money_holds(lab, a, first["id"], before)


def test_two_concurrent_starts_from_threads_make_one_segment_one_hold_and_one_claim(lab):
    o = lab.d.new_org(credits=1000)
    fid = lab.d.film(o, SETTINGS, SCENES)
    qid = lab.d.quote(o.admin, fid)["quote_id"]
    keys = [lab.d.key(), lab.d.key()]
    ok, refused, gate = [], [], threading.Barrier(2)

    def go(k):
        gate.wait()
        try:
            ok.append(lab.d.start(o.admin, fid, qid, k)["id"])
        except psycopg.Error as e:
            refused.append((e.sqlstate, str(e).splitlines()[0]))

    th = [threading.Thread(target=go, args=(k,)) for k in keys]
    [t.start() for t in th]
    [t.join() for t in th]
    assert len(ok) == 1 and refused == [("NS409", "film_not_startable")], (ok, refused)
    assert len(lab.d.holds(o.org)) == 1
    assert lab.d.su("select count(*) from public.film_segments where film_id = %s", [fid])[0][0] == 1
    before = lab.d.account(o.org)[0]
    w = lab.worker(adapters())
    assert w.run_once().result == "settled" and w.run_once() is None
    settled_money_holds(lab, o, ok[0], before)


# ── a worker that stops, a worker that is lost ─────────────────────────────────

def _age_lease(lab, sid):
    lab.d.su("update public.film_segments set heartbeat_at = now() - interval '11 minutes' where id = %s", [sid])


def test_a_worker_restarted_after_one_take_resumes_and_never_pays_a_made_take_twice(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    stop = threading.Event()
    first = adapters()
    real_poll = first["img-key"].poll

    def poll_then_stop(task, request, out_dir):
        r = real_poll(task, request, out_dir)
        stop.set()  # the process is told to stop while the key frame's result is in hand
        return r

    first["img-key"].poll = poll_then_stop
    out = lab.worker(first, "w-1", stop=stop).run_once()
    assert (out.result, out.reason) == ("left", "stopping"), out
    assert [(r[0], r[3]) for r in lab.take_rows(seg["id"])][0] == ("keyframe", "completed")
    assert lab.d.segment(seg["id"])[0] == "running"
    # A fresh worker cannot take a live lease; once it is stale, it can.
    second = adapters()
    assert lab.worker(second, "w-2").run_once() is None
    _age_lease(lab, seg["id"])
    out = lab.worker(second, "w-2").run_once()
    assert (out.result, out.reason) == ("settled", "completed"), (out, lab.take_rows(seg["id"]))
    assert len(first["img-key"].submits) == 1 and second["img-key"].submits == []  # the key frame was paid for once
    rows = lab.take_rows(seg["id"])
    assert sum(1 for r in rows if r[0] == "keyframe") == 1, rows
    settled_money_holds(lab, a, seg["id"], before)
    assert lab.d.film_row(fid)[0] == "ready"


def test_a_worker_restarted_while_a_clip_is_at_the_vendor_polls_the_stored_task_and_never_submits_again(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    stop = threading.Event()
    first = adapters()

    def pending_then_stop(ad, task):
        stop.set()  # a deploy: the clip is at the vendor, its task id stored, and this process stops
        return cw.ProviderPoll(cw.PENDING)

    first["vid-clip"].on_poll = pending_then_stop
    out = lab.worker(first, "w-1", stop=stop).run_once()
    assert out.result == "left", out
    task = lab.d.su("select j.provider_task_id, j.status from public.creative_jobs j join public.film_takes t on t.creative_job_id = j.id "
                    "where t.segment_id = %s and t.kind = 'clip' and t.status = 'running'", [seg["id"]])
    assert task == [("lab-vid-clip-1", "provider_pending")], task
    _age_lease(lab, seg["id"])
    second = adapters()
    out = lab.worker(second, "w-2").run_once()
    assert (out.result, out.reason) == ("settled", "completed"), (out, lab.take_rows(seg["id"]))
    assert second["vid-clip"].polls[0] == "lab-vid-clip-1"  # the stored task, polled
    assert len(first["vid-clip"].submits) + len(second["vid-clip"].submits) == 2  # one paid call per clip, never a second
    assert not any(r[2] == 2 for r in lab.take_rows(seg["id"]))  # no retry planned: nothing was lost
    settled_money_holds(lab, a, seg["id"], before)


def test_a_lost_worker_past_the_deadline_and_grace_is_settled_by_filmrest_expire_while_its_hold_is_open(lab, a):
    fid, seg = lab.started(a)
    before = lab.d.account(a.org)[0]
    stop = threading.Event()
    ads = adapters()
    real_poll = ads["img-key"].poll

    def poll_then_die(task, request, out_dir):
        r = real_poll(task, request, out_dir)
        stop.set()
        return r

    ads["img-key"].poll = poll_then_die
    assert lab.worker(ads, "w-1", stop=stop).run_once().result == "left"
    assert [h[2] for h in lab.d.holds(a.org)] == ["open"]
    lab.d.su("update public.film_segments set deadline_at = now() - interval '2 hours 1 minute' where id = %s", [seg["id"]])
    assert lab.rest.expire() == 1
    status, captured = settled_money_holds(lab, a, seg["id"], before)
    assert status == "settled" and captured == Decimal(3)  # the key frame it made, and nothing else
    assert lab.d.segment(seg["id"])[2] == "deadline"
    assert lab.d.film_row(fid) == ("paused", "deadline")
    assert lab.rest.expire() == 0


def test_the_lease_heartbeat_and_the_take_jobs_heartbeat_reach_the_real_functions(lab, a):
    """The runs above beat no heartbeat (heartbeat_seconds=0). _Lease.beat is what keeps a 45-minute clip's segment AND its job alive:
    a body the real film_heartbeat_segment / heartbeat_creative_job do not take would be swallowed as a warning, and the lease would
    lapse mid-take for the next claim to resume while this worker still runs."""
    _fid, seg = lab.started(a)
    stop = threading.Event()
    ads = adapters()

    def pending_then_stop(ad, task):
        stop.set()
        return cw.ProviderPoll(cw.PENDING)

    ads["vid-clip"].on_poll = pending_then_stop
    assert lab.worker(ads, "w-1", stop=stop).run_once().result == "left"
    job = lab.d.su("select t.creative_job_id from public.film_takes t where t.segment_id = %s and t.status = 'running'", [seg["id"]])[0][0]
    lab.d.su("update public.film_segments set heartbeat_at = now() - interval '5 minutes' where id = %s", [seg["id"]])
    lab.d.su("update public.creative_jobs set heartbeat_at = now() - interval '5 minutes' where id = %s", [job])
    lease = fo._Lease(lab.rest, seg["id"], "w-1", 0)
    lease.job_id = str(job)
    lease.beat()
    assert not lease.lost.is_set()
    fresh = lab.d.su("select (select heartbeat_at > now() - interval '1 minute' from public.film_segments where id = %s), "
                     "(select heartbeat_at > now() - interval '1 minute' from public.creative_jobs where id = %s)", [seg["id"], job])[0]
    assert fresh == (True, True), fresh
    other = fo._Lease(lab.rest, seg["id"], "w-other", 0)
    other.beat()
    assert other.lost.is_set()  # the database says it is not this worker's segment
    assert lab.pg.rpcs("heartbeat_creative_job") and lab.pg.rpcs("film_heartbeat_segment")


# ── the stand-in itself: it must catch the bug class it exists for ──────────────

def test_the_stand_in_refuses_a_body_key_the_function_does_not_take_and_filmrest_does_not_read_it_as_a_decision(lab, a):
    with pytest.raises(fo.FilmUnavailable):
        lab.rest.rpc("film_studio_on_for", {"p_org": a.org, "p_typo": 1})
    with pytest.raises(fo.FilmUnavailable):
        lab.rest.rpc("film_studio_on_for", {})  # a required argument missing
    assert lab.pg.unknown == [("film_studio_on_for", ("p_org", "p_typo")), ("film_studio_on_for", ())]
    lab.pg.unknown.clear()  # seen and asserted: the fixture's own check is for the worker's calls
    assert lab.rest.studio_on_for(a.org) is True


def test_the_stand_in_answers_a_raised_refusal_as_postgrest_does_and_filmrest_reads_its_word(lab, a):
    _fid, seg = lab.started(a)
    # 0171's not_found is P0002, which PostgREST answers 500 (P0* other than P0001): the worker reads it as "no answer", not a word.
    with pytest.raises(fo.FilmUnavailable):
        lab.rest.begin_take(str(uuid.uuid4()), "w-1")
    with pytest.raises(fo.FilmRefused) as e:
        lab.rest.begin_assembly(seg["id"], "w-nobody")
    assert e.value.word in ("lease_lost", "not_running"), e.value.word
    r = lab.pg.post(f"{URL}/rest/v1/rpc/film_studio_on_for", json={"p_org": "not-a-uuid"},
                    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    assert r.status_code == 400 and r.json()["code"] == "22P02"
    assert lab.pg.post(f"{URL}/rest/v1/rpc/film_studio_on_for", json={"p_org": a.org}, headers={}).status_code == 401
