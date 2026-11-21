"""Film Studio P4b (modules/film_assembly.py): one assembling segment → one finished, registered mp4.

What would break if these failed: an assembly that renders for a workspace the flag does not cover, a
crash that leaves the segment's money unrecorded, a retry that renders and charges twice, a missing
clip quietly rendered as a shorter film, a film whose sound drifts off its picture, a film longer or
shorter than its scenes, a 9:16 film rendered 16:9, or captions that cross from one scene into the next.

The fixture renders use the real editor path (timeline_render → render_backend → ffmpeg) on tiny clips
made here by ffmpeg; they skip where ffmpeg is not installed."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import film_assembly as fa
from modules import film_timeline as ft
from modules import media_library as ml

FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")
ORG = "0a000000-0000-4000-8000-000000000001"
OTHER_ORG = "0a000000-0000-4000-8000-000000000002"
SEG = "5e000000-0000-4000-8000-000000000001"
FILM = "f1000000-0000-4000-8000-000000000001"
NARR = "aa000000-0000-4000-8000-000000000001"
ENV = {fa.ENABLE_ENV: "on"}


def _u(n: int, kind: int) -> str:
    return f"{kind:08x}-0000-4000-8000-{n:012x}"


# ── fakes ────────────────────────────────────────────────────────────────────

class FakeDb:
    """0171's assembly calls as the migration defines them: begin is idempotent while running; record
    happens once (a retry with the same outcome and file answers as it is, another is a conflict); the
    charge is the recorded length in whole minutes at the rate, never above the line."""

    def __init__(self, film, scenes, takes, assets, *, rate=2.0, line=10.0, worker="w-1"):
        self.film_row, self.scene_rows, self.take_rows = film, scenes, takes
        self.asset_rows = {ml.canonical_id(k): {"id": k, **v} for k, v in assets.items()}
        self.seg = {"id": SEG, "film_id": FILM, "org_id": ORG, "status": "running", "film_version": 1,
                    "assembly": {"status": "running", "asset_id": None, "charged_credits": None}}
        self.rate, self.line, self.worker = rate, line, worker
        self.calls = []
        self.record_failures = 0       # how many record calls raise a connection error first
        self.enabled_orgs = {ORG}      # film_studio_on_for(org)
        self.lease_alive = True        # film_heartbeat_segment
        self.discarded = []

    def org_enabled(self, org):
        self.calls.append(("org_enabled", org))
        return org in self.enabled_orgs

    def heartbeat(self, sid, worker):
        return self.lease_alive and worker == self.worker

    def discard_unrecorded(self, sid, asset):
        self.calls.append(("discard", asset))
        if self.seg["assembly"]["status"] == "running" or self.seg["assembly"]["asset_id"] == asset:
            return 0
        self.discarded.append(asset)
        self.asset_rows[asset]["deleted_at"] = "now"
        return 1

    # AssemblyStore
    def film(self, fid):
        return self.film_row

    def scenes(self, fid):
        return self.scene_rows

    def takes(self, sid):
        return self.take_rows

    def assets(self, org, ids):
        return [r for i, r in self.asset_rows.items() if i in {ml.canonical_id(x) for x in ids}
                and r.get("org_id", ORG) == org and not r.get("deleted_at")]

    def _lease(self, worker):
        if worker != self.worker:
            raise fa.DbRefused("film", 409, "lease_lost")

    def begin(self, sid, worker):
        self.calls.append(("begin", worker))
        self._lease(worker)
        # As 0171: answered as it is only while running; ended (or never begun) it refuses.
        if self.seg["assembly"]["status"] != "running":
            raise fa.DbRefused("film_begin_assembly", 409, "not_running")
        return json.loads(json.dumps(self.seg))

    def segment(self, sid):
        a = self.seg["assembly"]
        return {"id": SEG, "status": self.seg["status"], "assembly_status": a["status"],
                "assembly_asset_id": a["asset_id"], "assembly_charged_credits": a["charged_credits"]}

    def record(self, sid, worker, ok, asset):
        self.calls.append(("record", ok, asset))
        self._lease(worker)
        if self.record_failures:
            self.record_failures -= 1
            raise fa.DbUnavailable("database unreachable")
        a = self.seg["assembly"]
        if a["status"] in ("completed", "failed"):
            if ok != (a["status"] == "completed") or (ok and asset != a["asset_id"]):
                raise fa.DbRefused("film_record_assembly", 409, "idempotency_conflict")
            return json.loads(json.dumps(self.seg))
        charge = 0.0
        if ok:
            secs = self.asset_rows[asset]["duration_s"]
            charge = min(-(-secs // 60) * self.rate, self.line)
        a.update(status="completed" if ok else "failed", asset_id=asset if ok else None, charged_credits=charge)
        return json.loads(json.dumps(self.seg))

    def records(self):
        return [c for c in self.calls if c[0] == "record"]


class FakeMedia:
    """register_asset: the same id gets the same row (0038)."""

    def __init__(self, db: FakeDb):
        self.db = db
        self.registered = []

    def register(self, **kw):
        aid = kw["asset_id"]
        self.registered.append(aid)
        self.db.asset_rows.setdefault(aid, {"id": aid, "org_id": kw["org"], "kind": kw["kind"], "mime": kw["mime"],
                                            "duration_s": kw["duration_s"], "width": kw["width"],
                                            "height": kw["height"], "variants": kw["variants"], "source": kw["source"],
                                            "provenance": kw["provenance"]})
        return {"id": aid}


# ── a small film on disk ─────────────────────────────────────────────────────

def ff(*args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True, timeout=120)


class DiskFilm:
    """N scenes of one shot each, clips and narration written into a media_root laid out as the library.

    Scene 1's clip flashes white at FLASH_S into its clip; the narration beeps at the same film time, so
    the render's A/V sync can be read off the output."""

    FLASH_S = 1.0

    def __init__(self, root: Path, *, scenes=2, seconds=3, aspect="16:9", captions="none", words=True,
                 render_files=True):
        self.root = root
        w, h = ft.frame_for(aspect, "720p")
        self.film = {"id": FILM, "org_id": ORG, "aspect": aspect, "resolution": "720p", "transition_default": "cut",
                     "captions_mode": captions, "music_asset_id": None, "music_gain_db": None, "duck_db": None,
                     "language": "en"}
        self.scenes, self.takes, self.assets = [], [], {}
        segments, word_rows = [], []
        for i in range(scenes):
            sid, tid, res, last = _u(100 + i, 0x5), _u(1000 + i, 0x7), _u(2000 + i, 0xB), _u(3000 + i, 0xC)
            self.scenes.append({"id": sid, "position": i, "planned_seconds": seconds, "shot_count": 1,
                                "first_frame": "keyframe", "transition_in": None, "current_version": 1,
                                "narration": f"Scene {i + 1} speaks."})
            self.takes.append({"id": tid, "segment_id": SEG, "scene_id": sid, "kind": "clip", "shot_index": 1,
                               "version": 1, "attempt": 1, "status": "completed", "result_asset_id": res,
                               "result_last_frame_asset_id": last, "first_frame_asset_id": _u(4000 + i, 0xD),
                               "params": {}})
            self.assets[res] = {"org_id": ORG, "kind": "video", "mime": "video/mp4", "duration_s": seconds + 1.0,
                                "width": w, "height": h, "variants": []}
            # On the film's clock: the scene's words start NARRATION_LEAD_S into it, file time = film time.
            a = i * seconds + ft.NARRATION_LEAD_S
            segments.append({"scene_id": sid, "start_s": a, "end_s": a + seconds - 0.5})
            word_rows += [{"word": "Scene", "start": a + 0.1, "end": a + 0.5},
                          {"word": f"{i + 1}", "start": a + 0.5, "end": a + 0.9},
                          {"word": "speaks.", "start": a + 0.9, "end": a + 1.4}]
            if render_files:
                path = self._place(res)
                if i == 0:
                    ff("-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r=30:d={seconds + 1}",
                       "-vf", f"drawbox=c=white:t=fill:enable='between(t,{self.FLASH_S},{self.FLASH_S + 0.2})'",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", str(path))
                else:
                    ff("-f", "lavfi", "-i", f"color=c=0x202020:s={w}x{h}:r=30:d={seconds + 1}",
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", str(path))
        total = scenes * seconds
        params = {"segments": segments, "loudness_lufs": None, "true_peak_db": None}
        if words:
            params["words"] = word_rows
        self.takes.append({"id": _u(9000, 0x7), "segment_id": SEG, "scene_id": None, "kind": "narration",
                           "shot_index": 0, "version": 1, "attempt": 1, "status": "completed",
                           "result_asset_id": NARR, "params": params})
        self.assets[NARR] = {"org_id": ORG, "kind": "audio", "mime": "audio/mpeg", "duration_s": float(total),
                             "variants": []}
        if render_files:
            # Silence with a 1 kHz beep at the flash's film time.
            ff("-f", "lavfi", "-i", f"aevalsrc='0.8*sin(2*PI*1000*t)*between(t,{self.FLASH_S},{self.FLASH_S + 0.1})'"
               f":s=48000:d={total}", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3",
               str(self._place(NARR)))

    def _place(self, aid):
        d = ml.asset_dir(self.root, aid)
        d.mkdir(parents=True, exist_ok=True)
        return d / ml.VARIANT_FILES["original"]

    def db(self, **kw):
        return FakeDb(self.film, self.scenes, self.takes, self.assets, **kw)


def run(db: FakeDb, root: Path, *, worker="w-1", deps=None, **dk):
    deps = deps or fa.Deps(env=ENV, **dk)
    tools = ml.Tools(ffprobe=FFPROBE or "ffprobe", ffmpeg=FFMPEG or "ffmpeg")
    return fa.assemble_segment(db.seg, worker_id=worker, store=db, media=FakeMedia(db), media_root=root, tools=tools,
                               deps=deps)


def fake_render(length_s, w, h):
    """A render that writes a file the fake probe reads back as (length_s, w, h, sound)."""
    calls = []

    def render(norm, resolver, out, timings=None, **kw):
        calls.append(kw)
        if timings is not None:       # as render_backend reports a full-quality render
            timings.mode, timings.intermediate = "sequential", "fast"
        Path(out).write_bytes(b"\0" * 64)
        return out
    return render, calls, (lambda p: fa.Probed(length_s, w, h, True))


def fake_store_file(db: FakeDb, root: Path, proxy_bytes=1000, duration=6.0):
    def store_file(path, *, asset_id, org_id, store, media_root, tools, provenance, **kw):
        d = ml.asset_dir(media_root, asset_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "proxy.mp4").write_bytes(b"\0" * proxy_bytes)
        return store.register(asset_id=asset_id, org=org_id, kind="video", mime="video/mp4", bytes=64, sha256="x",
                              source=kw.get("source"), width=1280, height=720, duration_s=duration,
                              provenance=provenance, derived_bytes=0, variants=["thumb", "proxy"],
                              parent_asset_id=None)
    return store_file


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def fake_deps(self, db, *, length=6.0, w=1280, h=720, **kw):
        render, calls, probe = fake_render(length, w, h)
        self.render_calls = calls
        d = dict(env=ENV, render=render, probe=probe, store_file=fake_store_file(db, self.root),
                 store_captions=lambda path, **k: k["store"].register(
                     asset_id=k["asset_id"], org=k["org_id"], kind="caption", mime="text/vtt", bytes=10, sha256="x",
                     source="generated", width=None, height=None, duration_s=None, provenance=k["provenance"],
                     derived_bytes=0, variants=[], parent_asset_id=None),
                 has_audio=lambda p, m: False,
                 free_mb=lambda p: 1e9)
        d.update(kw)
        return fa.Deps(**d)

    def film(self, **kw):
        # Files on disk (so the resolver finds them) but placeholders: the render itself is faked.
        f = DiskFilm(self.root, render_files=False, **kw)
        for aid in f.assets:
            f._place(aid).write_bytes(b"\0")
        return f


# ── the flag ─────────────────────────────────────────────────────────────────

class FlagTest(Base):
    def test_a_workspace_the_database_does_not_enable_is_recorded_at_zero_and_never_assembled(self):
        f = self.film()
        for orgs in (set(), {OTHER_ORG}):
            db = f.db()
            db.enabled_orgs = orgs
            out = run(db, self.root, deps=self.fake_deps(db))
            self.assertEqual((out.ok, out.reason, out.recorded), (False, "assembly_not_enabled", True), orgs)
            self.assertEqual(self.render_calls, [])
            # The database said false: that is a decision, recorded at 0. Nothing begun, nothing rendered.
            self.assertEqual([c for c in db.calls if c[0] != "org_enabled"], [("record", False, None)])
            self.assertEqual(db.seg["assembly"]["charged_credits"], 0.0)

    def test_the_kill_switch_off_stops_before_the_database_and_records_nothing(self):
        f = self.film()
        for env in ({}, {fa.ENABLE_ENV: "off"}, {fa.ENABLE_ENV: "1"}):
            db = f.db()
            with self.assertRaises(fa.AssemblyDisabled):
                run(db, self.root, deps=self.fake_deps(db, env=env))
            self.assertEqual(db.calls, [], env)
            self.assertEqual(self.render_calls, [])
            self.assertEqual(db.seg["assembly"]["status"], "running")

    def test_a_flag_the_database_cannot_answer_assembles_nothing_and_records_nothing(self):
        f = self.film()
        db = f.db()

        def unanswered(org):
            raise fa.DbUnavailable("film_studio_on_for did not answer")
        db.org_enabled = unanswered
        with self.assertRaises(fa.DbUnavailable):
            run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual(db.records(), [])
        self.assertEqual(self.render_calls, [])

    def test_the_enabled_workspace_is_assembled(self):
        f = self.film()
        db = f.db()
        out = run(db, self.root, deps=self.fake_deps(db))
        self.assertTrue(out.ok, out)
        self.assertEqual(len(self.render_calls), 1)


# ── money and retries ────────────────────────────────────────────────────────

class MoneyTest(Base):
    def test_a_crash_mid_assembly_is_recorded_at_zero_so_settle_releases_the_line(self):
        f = self.film()
        db = f.db()

        def boom(*a, **k):
            raise KeyError("something nobody expected")
        with self.assertRaises(KeyError):
            run(db, self.root, deps=self.fake_deps(db, store_file=boom))
        self.assertEqual(db.records(), [("record", False, None)])
        self.assertEqual(db.seg["assembly"], {"status": "failed", "asset_id": None, "charged_credits": 0.0})
        self.assertFalse((self.root / fa.WORK_DIRNAME / SEG).exists(), "the work folder is left behind")

    def test_a_render_that_fails_is_recorded_at_zero_by_name(self):
        f = self.film()
        db = f.db()

        def render(*a, **k):
            raise RuntimeError("ffmpeg exit 1")
        out = run(db, self.root, deps=self.fake_deps(db, render=render))
        self.assertEqual((out.ok, out.reason), (False, "render_failed"))
        self.assertEqual(db.seg["assembly"]["charged_credits"], 0.0)

    def test_a_rerun_after_a_crash_before_the_record_reuses_the_file_and_charges_once(self):
        f = self.film()
        db = f.db()
        db.record_failures = 1          # registered, then the database went away before the record
        with self.assertRaises(fa.DbUnavailable):
            run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual(db.seg["assembly"]["status"], "running")
        self.assertEqual(db.records(), [("record", True, db.records()[0][2])], "a lost record was turned into a failure")
        first_renders = len(self.render_calls)
        out = run(db, self.root, deps=self.fake_deps(db))
        self.assertTrue(out.ok, out)
        self.assertFalse(out.rendered, "the second attempt rendered the same cut again")
        self.assertEqual(first_renders, 1)
        self.assertEqual(self.render_calls, [])
        self.assertEqual(db.seg["assembly"]["charged_credits"], 2.0)   # 6 s → 1 minute × 2
        # Called again after it completed: answered as it is, nothing rendered or recorded again.
        n = len(db.records())
        again = run(db, self.root, deps=self.fake_deps(db))
        self.assertTrue(again.ok)
        self.assertEqual(again.asset_id, out.asset_id)
        self.assertEqual(len(db.records()), n)
        self.assertEqual(db.seg["assembly"]["charged_credits"], 2.0)

    def test_the_master_id_is_the_cut_so_a_changed_film_is_a_new_file(self):
        self.assertEqual(fa.master_asset_id(SEG, "a" * 64), fa.master_asset_id(SEG, "a" * 64))
        self.assertNotEqual(fa.master_asset_id(SEG, "a" * 64), fa.master_asset_id(SEG, "b" * 64))
        self.assertNotEqual(fa.master_asset_id(SEG, "a" * 64), fa.captions_asset_id(SEG, "a" * 64))

    def test_a_lost_lease_records_nothing(self):
        f = self.film()
        db = f.db(worker="w-2")
        out = run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual((out.ok, out.reason), (False, "lease_lost"))
        self.assertEqual(db.records(), [])
        self.assertEqual(self.render_calls, [])


# ── no silent fallback ───────────────────────────────────────────────────────

class LoudFailureTest(Base):
    def assert_fails(self, db, reason, **kw):
        out = run(db, self.root, deps=self.fake_deps(db, **kw))
        self.assertEqual((out.ok, out.reason), (False, reason), out.detail)
        self.assertEqual(db.seg["assembly"]["charged_credits"], 0.0)
        self.assertTrue(out.detail)
        return out

    def test_a_missing_clip_fails_the_film_never_renders_a_shorter_one(self):
        f = self.film(scenes=3)
        f.takes[1]["status"] = "failed"
        db = f.db()
        self.assert_fails(db, "take_failed")
        self.assertEqual(self.render_calls, [])

    def test_a_clip_deleted_from_the_library_fails_by_name(self):
        f = self.film(scenes=2)
        db = f.db()
        del db.asset_rows[f.takes[1]["result_asset_id"]]
        self.assert_fails(db, "asset_unavailable")
        self.assertEqual(self.render_calls, [])

    def test_a_clip_whose_file_is_gone_from_the_volume_fails_before_rendering(self):
        f = self.film()
        (ml.asset_dir(self.root, f.takes[0]["result_asset_id"]) / "original").unlink()
        self.assert_fails(f.db(), "asset_unavailable")
        self.assertEqual(self.render_calls, [])

    def test_too_little_disk_for_full_quality_fails_instead_of_the_compact_fallback(self):
        f = self.film()
        out = self.assert_fails(f.db(), "disk_low", free_mb=lambda p: 1.0)
        self.assertIn("free space", out.detail)
        self.assertEqual(self.render_calls, [])

    def test_an_output_shorter_than_its_scenes_fails(self):
        f = self.film()
        render, _c, probe = fake_render(5.5, 1280, 720)
        self.assert_fails(f.db(), "output_mismatch", render=render, probe=probe)

    def test_an_output_in_the_wrong_frame_fails(self):
        f = self.film()
        render, _c, probe = fake_render(6.0, 720, 1280)
        self.assert_fails(f.db(), "output_mismatch", render=render, probe=probe)

    def test_an_output_without_its_sound_fails(self):
        f = self.film()
        render, _c, _p = fake_render(6.0, 1280, 720)
        self.assert_fails(f.db(), "output_mismatch", render=render, probe=lambda p: fa.Probed(6.0, 1280, 720, False))

    def test_narration_scenes_without_a_narration_take_fail(self):
        f = self.film()
        f.takes[:] = [t for t in f.takes if t["kind"] != "narration"]
        self.assert_fails(f.db(), "narration_missing")

    def test_a_review_copy_over_the_supabase_object_ceiling_fails(self):
        f = self.film()
        db = f.db()
        self.assert_fails(db, "review_copy_too_large",
                          store_file=fake_store_file(db, self.root, proxy_bytes=fa.REVIEW_COPY_MAX_BYTES + 1))

    def test_captions_asked_for_and_not_transcribable_fail(self):
        f = self.film(captions="sidecar", words=False)

        def deaf(path, language):
            raise RuntimeError("no model")
        self.assert_fails(f.db(), "captions_failed", transcribe=deaf)


# ── Lens / Breach findings ──────────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.content = b"x" if body is not None else b""

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeHttp:
    """PostgREST as the gateway answers: per rpc name, a (status, body) or an exception."""

    def __init__(self, answers):
        self.answers, self.sent = answers, []

    def request(self, method, url, **kw):
        name = url.rsplit("/", 1)[-1]
        self.sent.append((name, kw.get("json")))
        a = self.answers.get(name, (200, True))
        if isinstance(a, Exception):
            raise a
        return FakeResponse(*a)


class RestStoreTest(unittest.TestCase):
    def store(self, answers):
        media = ml.MediaStore("http://db.invalid", "service-key-placeholder", session=FakeHttp(answers))
        return fa.AssemblyStore(media), media.http()

    def test_a_gateway_5xx_is_not_a_refusal(self):
        st, http = self.store({"film_record_assembly": (503, ValueError("html, not json"))})
        with self.assertRaises(fa.DbUnavailable):
            st.record(SEG, "w-1", True, NARR)

    def test_a_4xx_with_the_databases_code_and_word_is_a_refusal(self):
        for body in ({"code": "NS409", "message": "lease_lost"}, {"code": "P0001", "message": "lease_lost"}):
            st, _ = self.store({"film_record_assembly": (400, body)})
            with self.assertRaises(fa.DbRefused) as cm:
                st.record(SEG, "w-1", True, NARR)
            self.assertEqual(cm.exception.word, "lease_lost")

    def test_a_gateway_4xx_without_the_databases_word_is_not_a_refusal(self):
        for status, body in ((429, {"message": "API rate limit exceeded"}),
                             (401, {"code": "PGRST301", "message": "JWT expired"}),
                             (404, {"code": "PGRST202", "message": "Could not find the function"}),
                             (400, {"code": "NS409", "message": "Not a machine word"})):
            st, _ = self.store({"film_record_assembly": (status, body)})
            with self.assertRaises(fa.DbUnavailable, msg=(status, body)):
                st.record(SEG, "w-1", True, NARR)

    def test_no_answer_at_all_is_not_a_refusal(self):
        st, _ = self.store({"film_begin_assembly": OSError("connection reset")})
        with self.assertRaises(fa.DbUnavailable):
            st.begin(SEG, "w-1")

    def test_the_flag_is_only_ever_a_plain_true_or_false_from_the_database(self):
        self.assertTrue(self.store({"film_studio_on_for": (200, True)})[0].org_enabled(ORG))
        self.assertFalse(self.store({"film_studio_on_for": (200, False)})[0].org_enabled(ORG))
        # Missing (its migration not applied), a string, a null, a refusal: no answer, never "on".
        for a in ((404, {"code": "PGRST202", "message": "Could not find the function"}), (200, "true"), (200, None),
                  (400, {"code": "NS400", "message": "invalid_params"})):
            with self.assertRaises(fa.DbUnavailable, msg=a):
                self.store({"film_studio_on_for": a})[0].org_enabled(ORG)

    def test_a_large_film_reads_its_files_in_small_requests(self):
        st, http = self.store({})
        calls = []
        st._get = lambda table, params: calls.append(params["id"]) or []
        st.assets(ORG, [_u(i, 0xB) for i in range(130)])
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c.count(",") < fa.ID_CHUNK for c in calls))


class FilmWorkerCallTest(Base):
    """The film worker's exact call (modules/film_orchestrator.FilmOrchestrator._run_assembly): a TypeError there would
    record every assembly as failed."""

    def test_the_film_workers_call_and_its_rest_client_are_accepted(self):
        import inspect
        from modules import film_orchestrator as fo
        src = inspect.getsource(fo.FilmOrchestrator._run_assembly)
        self.assertIn("assemble(dict(seg), worker_id=self.worker_id, db=self.db, media_root=self.media_root, "
                      "tools=self.tools)", src)
        rest = fo.FilmRest("http://db.invalid", "service-key-placeholder", session=FakeHttp({}))
        st, media = fa.clients_from(rest)
        self.assertEqual((st.media.url, media.url), ("http://db.invalid", "http://db.invalid"))
        sig = inspect.signature(fa.assemble_segment)
        sig.bind({}, worker_id="w-1", db=rest, media_root=self.root, tools=None)   # raises TypeError if the call drifts

    def test_a_db_without_its_url_and_key_is_a_clear_error(self):
        with self.assertRaises(TypeError):
            fa.clients_from(object())


class FindingsTest(Base):
    def test_a_5xx_on_the_success_record_keeps_the_rendered_film_and_the_assembly_running(self):
        f = self.film()
        db = f.db()
        real = db.record

        def record(sid, worker, ok, asset):
            if ok:
                db.calls.append(("record", ok, asset))
                raise fa.DbUnavailable("film_record_assembly: HTTP 503")
            return real(sid, worker, ok, asset)
        db.record = record
        with self.assertRaises(fa.DbUnavailable):
            run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual(db.seg["assembly"]["status"], "running")
        self.assertNotIn(("record", False, None), db.calls)

    def test_a_lost_answer_from_register_asset_keeps_the_rendered_film_and_the_assembly_running(self):
        import requests
        for err in (requests.ReadTimeout("read timed out"), requests.ConnectionError("connection reset")):
            f = self.film()
            db = f.db()
            stored = fake_store_file(db, self.root)

            def flaky(path, **kw):
                stored(path, **kw)        # the row is written; the answer is lost on the way back
                raise err
            with self.assertRaises(fa.DbUnavailable, msg=type(err).__name__):
                run(db, self.root, deps=self.fake_deps(db, store_file=flaky))
            self.assertEqual(db.records(), [], "a lost answer was recorded as the film's failure")
            self.assertEqual(db.seg["assembly"]["status"], "running")
            again = run(db, self.root, deps=self.fake_deps(db))
            self.assertTrue(again.ok and not again.rendered, again)
            self.assertEqual(len(db.records()), 1)

    def test_dropped_words_are_recorded_on_the_film_and_in_the_outcome(self):
        f = self.film(captions="sidecar", words=False)

        def transcribe(path, language):
            return [{"word": "Scene", "start": 0.35, "end": 0.7}, {"word": "uh", "start": 2.8, "end": 3.0}]
        db = f.db()
        out = run(db, self.root, deps=self.fake_deps(db, transcribe=transcribe))
        self.assertTrue(out.ok, out)
        self.assertEqual(out.dropped_words, ({"word": "uh", "start_s": 2.8, "end_s": 3.0},))
        self.assertIn("1 word(s) outside speech dropped", out.detail)
        prov = db.asset_rows[out.asset_id]["provenance"]["captions_dropped_words"]
        self.assertEqual((prov["count"], prov["words"][0]["start_s"]), (1, 2.8))

    def test_a_5xx_on_begin_records_nothing(self):
        f = self.film()
        db = f.db()

        def begin(sid, worker):
            raise fa.DbUnavailable("film_begin_assembly: HTTP 502")
        db.begin = begin
        with self.assertRaises(fa.DbUnavailable):
            run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual(db.records(), [])
        self.assertEqual(self.render_calls, [])

    def test_a_refused_begin_is_reported_and_records_nothing(self):
        f = self.film()
        db = f.db()
        db.seg["assembly"]["status"] = "planned"     # S6 called before film_begin_assembly
        out = run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual((out.ok, out.reason, out.recorded), (False, "not_running", False))
        self.assertEqual(db.records(), [])

    def test_a_render_that_fell_back_to_the_compact_encode_fails(self):
        f = self.film()
        db = f.db()
        render, _c, probe = fake_render(6.0, 1280, 720)

        def degraded(*a, timings=None, **kw):
            timings.mode, timings.intermediate = "fallback", "compact"
            return render(*a, **kw)
        out = run(db, self.root, deps=self.fake_deps(db, render=degraded, probe=probe))
        self.assertEqual((out.ok, out.reason), (False, "render_degraded"))
        self.assertEqual(db.seg["assembly"]["charged_credits"], 0.0)

    def test_a_render_that_outlived_its_lease_registers_nothing(self):
        f = self.film()
        db = f.db()
        db.lease_alive = False
        media_regs = []
        deps = self.fake_deps(db)
        out = run(db, self.root, deps=deps)
        self.assertEqual((out.ok, out.reason), (False, "lease_lost"))
        self.assertEqual(db.records(), [])
        self.assertFalse(any(a.get("provenance") for a in db.asset_rows.values() if a.get("kind") == "video"
                             and a["id"] not in f.assets))

    def test_a_file_registered_before_the_lease_was_lost_is_discarded_once_the_assembly_ended(self):
        f = self.film()
        db = f.db()
        real = db.record

        def record(sid, worker, ok, asset):
            if ok:
                # Meanwhile the sweep failed the assembly and settled; this worker's record is refused.
                db.seg["assembly"].update(status="failed", charged_credits=0.0)
                raise fa.DbRefused("film_record_assembly", 409, "lease_lost")
            return real(sid, worker, ok, asset)
        db.record = record
        out = run(db, self.root, deps=self.fake_deps(db))
        self.assertEqual(out.reason, "lease_lost")
        self.assertEqual(len(db.discarded), 1, "an unpaid finished film stayed in the library")

    def test_each_attempt_works_in_its_own_folder(self):
        f = self.film()
        seen = []
        for _ in range(2):
            db = f.db()
            render, _c, probe = fake_render(6.0, 1280, 720)

            def spy(norm, resolver, out, workdir=None, **kw):
                seen.append(workdir)
                return render(norm, resolver, out, **kw)
            run(db, self.root, deps=self.fake_deps(db, render=spy, probe=probe))
            shutil.rmtree(ml.asset_dir(self.root, db.records()[-1][2]), ignore_errors=True)
            for a in list(db.asset_rows):
                if a not in f.assets:
                    del db.asset_rows[a]
        self.assertEqual(len(set(seen)), 2, seen)
        self.assertFalse((self.root / fa.WORK_DIRNAME / SEG).exists())

    def test_whisper_runs_once_per_narration_so_a_retry_builds_the_same_cut(self):
        f = self.film(captions="sidecar", words=False)
        heard = []

        def transcribe(path, language):
            heard.append(path)
            return [{"word": "Scene", "start": 0.35, "end": 0.7}, {"word": "speaks.", "start": 0.7, "end": 1.2}]
        shas = []
        for _ in range(2):
            db = f.db()
            out = run(db, self.root, deps=self.fake_deps(db, transcribe=transcribe))
            self.assertTrue(out.ok, out)
            shas.append(out.cut_sha256)
        self.assertEqual(len(heard), 1)
        self.assertEqual(shas[0], shas[1])


# ── captions ─────────────────────────────────────────────────────────────────

@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg is not installed")
class RenderBackendReportsTheEncodeTest(Base):
    """The assembly refuses anything but the fast encode, so render_backend must say which one it used on every path."""

    def render(self, **patches):
        from modules import render_backend as rb
        f = DiskFilm(self.root, scenes=1, seconds=3)
        cut = ft.build_cut(f.film, fa._with_versions(f.scenes, f.takes), f.takes, f.assets,
                           {"asset_id": NARR, "segments": f.takes[-1]["params"]["segments"]}, None)
        rows = [{"id": k, **v} for k, v in f.assets.items()]
        from modules import editor_export, timeline as tl
        resolver = editor_export.build_resolver(rows, self.root, has_audio=lambda p, m: False)
        timings = rb.RenderTimings()
        work = self.root / "w"
        work.mkdir()
        with mock.patch.multiple(rb, **patches) if patches else mock.patch.object(rb, "logger"):
            fa.render_strict(tl.load(cut.doc), resolver, str(work / "o.mp4"), ffmpeg=FFMPEG, workdir=str(work), jobs=1,
                             timeout_s=300, timings=timings)
        return timings

    def test_a_render_with_room_reports_the_fast_encode(self):
        self.assertEqual(self.render().intermediate, "fast")

    def test_a_short_disk_reports_the_compact_encode(self):
        self.assertEqual(self.render(_free_mb=lambda p: 0.0).intermediate, "compact")

    def test_a_failed_encode_redone_compact_reports_it(self):
        from modules import render_backend as rb
        real = rb._run_sequential
        calls = {"n": 0}

        def first_fails(tasks):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("an encode failed")
            return real(tasks)
        t = self.render(_run_sequential=first_fails)
        self.assertEqual((t.mode, t.intermediate), ("fallback", "compact"))


class CaptionTest(unittest.TestCase):
    SEGS = [{"start_s": 0.25, "end_s": 2.5}, {"start_s": 3.25, "end_s": 5.5}]

    def test_cues_never_cross_a_scene_and_are_deterministic(self):
        words = [{"word": w, "start": 0.3 + i * 0.3, "end": 0.55 + i * 0.3} for i, w in enumerate("a b c d e".split())]
        words += [{"word": "next", "start": 3.3, "end": 3.6}]
        cues = fa.cues_from_words(words, self.SEGS, 30)
        self.assertEqual(cues, fa.cues_from_words(list(reversed(words)), self.SEGS, 30))
        self.assertEqual([c["text"] for c in cues], ["a b c d e", "next"])
        for c in cues:
            self.assertTrue(any(s["start_s"] <= c["start_s"] and c["end_s"] <= s["end_s"] for s in self.SEGS), c)

    def test_a_first_word_aligned_just_before_its_segment_is_still_captioned(self):
        words = [{"word": "It", "start": 0.22, "end": 0.45}, {"word": "begins.", "start": 0.5, "end": 1.0}]
        self.assertEqual([c["text"] for c in fa.cues_from_words(words, self.SEGS, 30)], ["It begins."])

    def test_a_word_entirely_in_a_silent_gap_is_dropped_and_reported_never_fails_the_film(self):
        words = [{"word": "a", "start": 0.3, "end": 0.6}, {"word": "stray", "start": 2.8, "end": 3.0}]
        dropped = []
        cues = fa.cues_from_words(words, self.SEGS, 30, dropped=dropped)
        self.assertEqual([c["text"] for c in cues], ["a"])
        self.assertEqual(dropped, [{"word": "stray", "start_s": 2.8, "end_s": 3.0}])

    def test_a_word_that_overlaps_a_segment_even_slightly_is_kept(self):
        words = [{"word": "edge", "start": 2.45, "end": 2.9}]       # 50 ms inside the first segment
        dropped = []
        self.assertEqual([c["text"] for c in fa.cues_from_words(words, self.SEGS, 30, dropped=dropped)], ["edge"])
        self.assertEqual(dropped, [])

    def test_a_sentence_end_or_three_seconds_ends_a_cue(self):
        words = [{"word": "One.", "start": 0.3, "end": 0.6}, {"word": "Two", "start": 0.7, "end": 1.0}]
        self.assertEqual([c["text"] for c in fa.cues_from_words(words, self.SEGS, 30)], ["One.", "Two"])
        long_ = [{"word": f"w{i}", "start": 0.3 + i * 0.5, "end": 0.7 + i * 0.5} for i in range(5)]
        cues = fa.cues_from_words(long_, [{"start_s": 0.25, "end_s": 10}], 60)
        self.assertTrue(all(c["end_s"] - c["start_s"] <= fa.CUE_MAX_S + 1e-9 for c in cues), cues)

    def test_vtt_is_the_srt_with_points(self):
        srt = ft.srt_text([{"start_s": 1.5, "end_s": 2.25, "text": "Hi"}])
        self.assertEqual(fa.vtt_text(srt), "WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.250\nHi\n")


# ── real renders of fixture clips ────────────────────────────────────────────

def probe(path):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                          "-of", "json", str(path)], capture_output=True, check=True, timeout=60)
    return json.loads(out.stdout)


def stream_start_s(path, kind):
    """Where a stream starts on the file's clock: a delayed first sound is written as a later start_time
    (measured: 0.228 s for a 0.25 s narration lead), so a sample's index alone is not its time."""
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", f"{kind}:0", "-show_entries", "stream=start_time",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True, timeout=60)
    return float(out.stdout.strip() or 0)


def first_bright_frame_s(path, fps=30):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vf", "scale=16:16,format=gray", "-r", str(fps),
                          "-f", "rawvideo", "-"], capture_output=True, check=True, timeout=120).stdout
    for i in range(len(raw) // 256):
        if sum(raw[i * 256:(i + 1) * 256]) / 256 > 128:
            return stream_start_s(path, "v") + i / fps
    return None


def first_loud_sample_s(path, rate=48000):
    import array
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", str(rate),
                          "-f", "s16le", "-"], capture_output=True, check=True, timeout=120).stdout
    a = array.array("h", raw)
    for i, s in enumerate(a):
        if abs(s) > 1500:
            return stream_start_s(path, "a") + i / rate
    return None


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg is not installed")
class RenderTest(Base):
    def assemble(self, f: DiskFilm, **kw):
        db = f.db()
        media = FakeMedia(db)
        tools = ml.Tools(ffprobe=FFPROBE, ffmpeg=FFMPEG)
        out = fa.assemble_segment(db.seg, worker_id="w-1", store=db, media=media, media_root=self.root, tools=tools,
                                  deps=fa.Deps(env=ENV, **kw))
        self.assertTrue(out.ok, (out.reason, out.detail))
        return db, out, ml.asset_file(self.root, out.asset_id, "original")

    def test_fixture_clips_cut_deterministically_in_sync_at_the_right_length_and_aspect(self):
        f = DiskFilm(self.root, scenes=2, seconds=3)
        db, out, path = self.assemble(f)
        info = probe(path)
        v = next(s for s in info["streams"] if s["codec_type"] == "video")
        self.assertEqual((v["width"], v["height"]), (1280, 720))
        self.assertTrue(any(s["codec_type"] == "audio" for s in info["streams"]))
        # The film lasts the sum of its scenes.
        self.assertAlmostEqual(float(info["format"]["duration"]), 6.0, delta=fa.DURATION_TOLERANCE_S)
        # A/V sync: the flash and the beep were placed at the same film time.
        flash, beep = first_bright_frame_s(path), first_loud_sample_s(path)
        self.assertIsNotNone(flash)
        self.assertIsNotNone(beep)
        self.assertLess(abs(flash - beep), 0.05, (flash, beep))
        self.assertAlmostEqual(flash, DiskFilm.FLASH_S, delta=0.05)
        # The library row carries the review copy and the provenance 0171 checks.
        row = db.asset_rows[out.asset_id]
        self.assertIn("proxy", row["variants"])
        self.assertEqual(row["source"], "generated")
        self.assertEqual(row["provenance"]["film_segment_id"], SEG)
        self.assertEqual(row["provenance"]["cut_sha256"], out.cut_sha256)
        self.assertLessEqual(ml.asset_file(self.root, out.asset_id, "proxy").stat().st_size, fa.REVIEW_COPY_MAX_BYTES)
        # Deterministic: the same rows give the same cut, so the same master id.
        cut1 = out.cut_sha256
        shutil.rmtree(ml.asset_dir(self.root, out.asset_id))
        db2 = f.db()
        out2 = fa.assemble_segment(db2.seg, worker_id="w-1", store=db2, media=FakeMedia(db2), media_root=self.root,
                                   tools=ml.Tools(ffprobe=FFPROBE, ffmpeg=FFMPEG), deps=fa.Deps(env=ENV))
        self.assertEqual((out2.cut_sha256, out2.asset_id), (cut1, out.asset_id))

    def test_a_vertical_film_renders_vertical_with_its_captions_burned_and_a_vtt_sidecar(self):
        f = DiskFilm(self.root, scenes=2, seconds=3, aspect="9:16", captions="both")
        db, out, path = self.assemble(f)
        v = next(s for s in probe(path)["streams"] if s["codec_type"] == "video")
        self.assertEqual((v["width"], v["height"]), (720, 1280))
        self.assertIsNotNone(out.captions_asset_id)
        vtt = ml.asset_file(self.root, out.captions_asset_id, "original").read_text(encoding="utf-8")
        self.assertTrue(vtt.startswith("WEBVTT"))
        self.assertIn("Scene 1 speaks.", vtt)
        self.assertEqual(db.asset_rows[out.captions_asset_id]["kind"], "caption")
        self.assertEqual(db.asset_rows[out.asset_id]["provenance"]["captions_asset_id"], out.captions_asset_id)


if __name__ == "__main__":
    unittest.main()
