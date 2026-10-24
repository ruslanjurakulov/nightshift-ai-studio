"""modules/voice_worker.py + tools/voice_worker.py: the worker of Custom Voice (migration 0117, docs/CUSTOM_VOICE.md).

No test here reaches a real service. Supabase is ``FakeSupabase`` below: an in-memory port of the 0117 queue functions
(claim_voice_job, finish_voice_clone, finish_voice_task, with their one-live-job index, the three-attempt rule and the lost-worker
sweep) and of the Storage endpoints the worker uses, answering through a ``requests``-style session so the real ``VoiceStore`` and
``SampleStorage`` code runs. ElevenLabs is ``FakeEleven``, behind the real ``ElevenLabsVoiceProvider``. Whisper and the audio probe are
injected fakes. One class talks to a real HTTP server on 127.0.0.1 (the stdlib one) to pin what a fake cannot: that ``requests`` really
does not follow a redirect with the service key, and really stops reading a body at the size limit.

What this proves is the worker's logic against the database's documented behaviour. What it cannot prove is in docs/CUSTOM_VOICE.md
("Live blockers"): the real Storage and ElevenLabs request shapes, and a real Whisper and ffprobe.
"""

import contextlib
import http.server
import itertools
import logging
import os
import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from modules import voice_profiles as vp
from modules import voice_worker as vw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SUPABASE = "https://proj.supabase.co"
SERVICE_KEY = "service-key-not-real-0123456789"
EL_KEY = "xi-secret-key-not-real"
USER = "11111111-1111-4111-8111-111111111111"
USER2 = "22222222-2222-4222-8222-222222222222"
PHRASE = "apple river candle window garden pencil"
MARKER = b"RAW-SAMPLE-MARKER-0123"
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 60 + MARKER
ON = {"NIGHTSHIFT_VOICE_CLONING": "on"}
BODY_SECRET = "PROVIDER-BODY-SECRET-TEXT"
CODE_RE = re.compile(r"^[a-z0-9_]{1,64}$")


# ── fakes ────────────────────────────────────────────────────────────────────

class Resp:
    def __init__(self, status=200, body=None, headers=None, content=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self._content = content
        self.text = ""
        self.closed = False

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body

    def iter_content(self, chunk_size=65536):
        data = self._content or b""
        for i in range(0, len(data), chunk_size):
            yield data[i:i + chunk_size]

    def close(self):
        self.closed = True


class Crash(BaseException):
    """The process dies here: nothing after it in the worker runs, and no handler of ``Exception`` sees it."""


class FakeSupabase:
    """The 0117 queue functions and the Storage endpoints the worker uses, in memory."""

    def __init__(self):
        self.objects = {}      # "<user>/<profile>/<name>" -> bytes
        self.profiles = {}
        self.jobs = []
        self.consents = []
        self.records = []
        self.calls = []        # (method, path)
        self.headers_seen = []
        self.redirect_on = None
        self.rpc_failures = {}   # rpc name -> list of exceptions raised before it is handled
        self._seq = itertools.count(1)
        self._ids = itertools.count(1)

    # -- the user's side (what the app's functions would have done) ----------------
    def request_clone(self, user=USER, phrase=PHRASE, keep=False):
        pid = f"{next(self._ids):08x}-0000-4000-8000-000000000000"
        self.profiles[pid] = dict(id=pid, user_id=user, owner_ref="ab" * 16, status="pending_verification", keep_sample=keep,
                                  sample_state="awaiting", provider=None, voice_id=None, sha=None, reject_reason=None)
        self.consents.append(dict(profile=pid, kind="accepted"))
        self._add_job(pid, "clone", phrase=phrase)
        return pid

    def upload(self, pid, data=WEBM, name="sample.webm"):
        p = self.profiles[pid]
        self.objects[f"{p['user_id']}/{pid}/{name}"] = data

    def owner_deletes(self, pid, voice_too=True):
        p = self.profiles[pid]
        p["status"] = "deleted"
        for q in self.jobs:
            if q["profile"] == pid and q["kind"] == "clone" and q["status"] == "queued":
                q["status"] = "cancelled"
        if p["voice_id"] and voice_too:
            self._add_job(pid, "delete_provider")
        if p["sample_state"] != "purged":
            p["sample_state"] = "purge_pending"
            self._add_job(pid, "purge_sample")

    def owner_deletes_sample(self, pid):
        self.profiles[pid]["sample_state"] = "purge_pending"
        self._add_job(pid, "purge_sample")

    def expire_leases(self):
        for q in self.jobs:
            if q["status"] == "running":
                q["stale"] = True

    def job(self, pid, kind):
        rows = [q for q in self.jobs if q["profile"] == pid and q["kind"] == kind]
        return rows[-1] if rows else None

    def under(self, pid):
        p = self.profiles[pid]
        return sorted(k for k in self.objects if k.startswith(f"{p['user_id']}/{pid}/"))

    # -- the database -----------------------------------------------------------
    def _add_job(self, pid, kind, phrase=None):
        if any(q["profile"] == pid and q["kind"] == kind and q["status"] in ("queued", "running") for q in self.jobs):
            return
        self.jobs.append(dict(id=f"{next(self._seq):08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa", profile=pid, kind=kind, status="queued",
                              phrase=phrase, attempts=0, max_attempts=3, worker=None, error=None, stale=False))

    def _object_of(self, p):
        names = sorted(k for k in self.objects if k.startswith(f"{p['user_id']}/{p['id']}/sample."))
        return names[0] if names else None

    def _claim(self, worker):
        for q in self.jobs:
            if q["status"] == "running" and q["stale"]:
                if q["attempts"] < q["max_attempts"]:
                    q.update(status="queued", worker=None, stale=False)
                else:
                    q.update(status="failed", worker=None, error="worker_lost")
        for q in self.jobs:
            p = self.profiles[q["profile"]]
            if q["kind"] == "clone" and q["status"] == "failed" and q["error"] == "worker_lost" and p["status"] == "pending_verification":
                p.update(status="rejected", reject_reason="worker_lost", sample_state="purge_pending")
                self._add_job(p["id"], "purge_sample")
        for q in self.jobs:
            p = self.profiles[q["profile"]]
            if q["status"] == "queued" and (q["kind"] != "clone" or (p["status"] == "pending_verification" and self._object_of(p))):
                q.update(status="running", attempts=q["attempts"] + 1, worker=worker)
                path = self._object_of(p) if q["kind"] == "clone" else None
                if q["kind"] == "clone" and p["sample_state"] == "awaiting":
                    p["sample_state"] = "stored"
                return dict(job_id=q["id"], kind=q["kind"], attempts=q["attempts"], profile_id=p["id"], user_id=p["user_id"],
                            owner_ref=p["owner_ref"], status=p["status"], keep_sample=p["keep_sample"], sample_path=path,
                            sample_prefix=f"{p['user_id']}/{p['id']}/", phrase=q["phrase"], provider=p["provider"],
                            provider_voice_id=p["voice_id"])
        return None

    def _finish_clone(self, a):
        q = next((x for x in self.jobs if x["id"] == a["p_job"]), None)
        if q is None or q["kind"] != "clone":
            return dict(ok=False, error="no_such_job")
        if q["status"] != "running" or q["worker"] != a["p_worker"]:
            return dict(ok=False, error="not_holder")
        p = self.profiles[q["profile"]]
        deleted = p["status"] == "deleted"
        err = a.get("p_error_code")
        if err:
            assert CODE_RE.match(err), f"error word {err!r} is not a closed word"
            if err == "transient" and q["attempts"] < q["max_attempts"] and not deleted:
                q.update(status="queued", worker=None, error="transient")
                return dict(ok=True, retry=True)
            q.update(status="failed", error=err)
            if not deleted:
                p.update(status="rejected", reject_reason=err, sample_state="purge_pending")
            if p["sample_state"] != "purged":
                self._add_job(p["id"], "purge_sample")
            return dict(ok=True, status="deleted" if deleted else "rejected")
        assert a["p_verification"] in ("passed", "failed")
        assert re.fullmatch(r"[0-9a-f]{64}", a["p_sample_sha256"] or ""), "a bad hash is refused by the database"
        self.consents.append(dict(profile=p["id"], kind="verification", result=a["p_verification"], sha=a["p_sample_sha256"]))
        if a["p_verification"] == "failed":
            q.update(status="failed", error="verification_failed")
            if not deleted:
                p.update(status="rejected", reject_reason="verification_failed", sha=a["p_sample_sha256"], sample_state="purge_pending")
            self._add_job(p["id"], "purge_sample")
            return dict(ok=True, status="deleted" if deleted else "rejected")
        assert a["p_provider"] == "elevenlabs" and re.fullmatch(r"[A-Za-z0-9]{20}", a["p_voice_id"] or "")
        if any(x["voice_id"] == a["p_voice_id"] for x in self.profiles.values()):
            return dict(ok=False, error="voice_id_taken")
        p.update(provider=a["p_provider"], voice_id=a["p_voice_id"], sha=a["p_sample_sha256"],
                 status="deleted" if deleted else "testing",
                 sample_state=p["sample_state"] if p["keep_sample"] and not deleted else "purge_pending")
        q.update(status="succeeded")
        purge = not (p["keep_sample"] and not deleted)
        if purge:
            self._add_job(p["id"], "purge_sample")
        if deleted:
            self._add_job(p["id"], "delete_provider")
        return dict(ok=True, status="deleted" if deleted else "testing", sample_purge_queued=purge)

    def _finish_task(self, a):
        q = next((x for x in self.jobs if x["id"] == a["p_job"]), None)
        if q is None or q["kind"] not in ("delete_provider", "purge_sample"):
            return dict(ok=False, error="no_such_job")
        if q["status"] != "running" or q["worker"] != a["p_worker"]:
            return dict(ok=False, error="not_holder")
        p = self.profiles[q["profile"]]
        if a["p_ok"]:
            q.update(status="succeeded", error=None)
            if q["kind"] == "purge_sample":
                p["sample_state"] = "purged"
            self.records.append(dict(profile=p["id"], event="sample_purged" if q["kind"] == "purge_sample" else "provider_deleted"))
            return dict(ok=True)
        err = a.get("p_error_code")
        err = err if err and CODE_RE.match(err) else "failed"
        if q["attempts"] < q["max_attempts"]:
            q.update(status="queued", worker=None, error=err)
            return dict(ok=True, retry=True)
        q.update(status="failed", error=err)
        return dict(ok=True, failed=True)

    # -- the HTTP face ------------------------------------------------------------
    def _route(self, method, url, kw):
        assert url.startswith(SUPABASE), "only the project's own host is ever called"
        path = url[len(SUPABASE):]
        self.calls.append((method, path))
        self.headers_seen.append(kw.get("headers") or {})
        assert kw.get("allow_redirects") is False, "a redirect must never be followed with the service key"
        assert kw.get("timeout"), "every request has a timeout"
        if self.redirect_on and self.redirect_on in path:
            return Resp(302, headers={"Location": "https://evil.example/steal"})
        if path.startswith("/rest/v1/rpc/"):
            name = path.rsplit("/", 1)[1]
            if self.rpc_failures.get(name):
                raise self.rpc_failures[name].pop(0)
            a = kw["json"]
            out = {"claim_voice_job": lambda: self._claim(a["p_worker"]), "finish_voice_clone": lambda: self._finish_clone(a),
                   "finish_voice_task": lambda: self._finish_task(a)}[name]()
            return Resp(200, out)
        if path == "/storage/v1/object/list/voice-samples":
            prefix = kw["json"]["prefix"].strip("/") + "/"
            seen, rows = set(), []
            for k in sorted(self.objects):
                if k.startswith(prefix):
                    rest = k[len(prefix):]
                    head = rest.split("/", 1)[0]
                    if "/" in rest:
                        if head not in seen:
                            seen.add(head)
                            rows.append({"name": head, "id": None})
                    else:
                        rows.append({"name": head, "id": "obj-" + head})
            off, lim = kw["json"].get("offset", 0), kw["json"]["limit"]
            return Resp(200, rows[off:off + lim])
        if method == "get" and path.startswith("/storage/v1/object/voice-samples/"):
            key = path[len("/storage/v1/object/voice-samples/"):]
            if key not in self.objects:
                return Resp(400, {"statusCode": "404", "error": "not_found"})
            data = self.objects[key]
            return Resp(200, headers={"Content-Length": str(len(data))}, content=data)
        if method == "delete" and path == "/storage/v1/object/voice-samples":
            for k in kw["json"]["prefixes"]:
                self.objects.pop(k, None)
            return Resp(200, [])
        raise AssertionError(f"unexpected request {method} {path}")

    def post(self, url, **kw):
        return self._route("post", url, kw)

    def get(self, url, **kw):
        return self._route("get", url, kw)

    def delete(self, url, **kw):
        return self._route("delete", url, kw)


class FakeEleven:
    """The ElevenLabs endpoints the adapter uses. ``script[key]`` is a list of answers used first: a Resp, an exception to raise,
    or ``("made", exc_or_resp)`` meaning the voice IS created and then the exception is raised / the answer returned (a timeout, or
    an answer without an id, after the server did the work)."""

    def __init__(self, plan=True):
        self.plan = plan
        self.voices = {}
        self.calls = []
        self.script = {}
        self.after_create = None
        self._n = itertools.count(1)

    def _create(self, kw):
        vid = "Vx%018d" % next(self._n)
        self.voices[vid] = kw["data"]["name"]
        return vid

    def _do(self, method, url, **kw):
        assert url.startswith("https://api.elevenlabs.io/v1/"), "only ElevenLabs gets the key"
        assert kw.get("allow_redirects") is False
        path = url[len("https://api.elevenlabs.io/v1"):]
        key = f"{method}:{'/voices/{id}' if path.startswith('/voices/') and path != '/voices/add' else path}"
        self.calls.append((method, path, kw))
        queue = self.script.get(key)
        if queue:
            a = queue.pop(0)
            if isinstance(a, tuple) and a[0] == "made":
                self._create(kw)
                if isinstance(a[1], BaseException):
                    raise a[1]
                return a[1]
            if isinstance(a, BaseException):
                raise a
            return a
        if path == "/user/subscription":
            body = {} if self.plan is None else {"can_use_instant_voice_cloning": self.plan}
            return Resp(200, body)
        if path == "/voices" and method == "get":
            return Resp(200, {"voices": [{"voice_id": v, "name": n} for v, n in self.voices.items()]})
        if path == "/voices/add":
            vid = self._create(kw)
            if self.after_create:
                self.after_create()
            return Resp(200, {"voice_id": vid})
        if method == "delete" and path.startswith("/voices/"):
            vid = path.rsplit("/", 1)[1]
            return Resp(200, {}) if self.voices.pop(vid, None) is not None else Resp(404, {})
        raise AssertionError(f"unexpected ElevenLabs request {method} {path}")

    def get(self, url, **kw):
        return self._do("get", url, **kw)

    def post(self, url, **kw):
        return self._do("post", url, **kw)

    def delete(self, url, **kw):
        return self._do("delete", url, **kw)

    def posts(self):
        return [c for c in self.calls if c[0] == "post"]


class Transcriber:
    def __init__(self, text=PHRASE):
        self.text = text
        self.paths = []
        self.seen = []

    def __call__(self, path):
        self.paths.append(path)
        self.seen.append(Path(path).read_bytes())
        if isinstance(self.text, BaseException):
            raise self.text
        return self.text


class Probe:
    def __init__(self, facts=vw.AudioFacts(1, 0, 12.0)):
        self.facts = facts
        self.calls = 0

    def __call__(self, path):
        self.calls += 1
        if isinstance(self.facts, BaseException):
            raise self.facts
        return self.facts


class LogCatcher(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class Harness(unittest.TestCase):
    def setUp(self):
        self.db = FakeSupabase()
        self.el = FakeEleven()
        self.tr = Transcriber()
        self.probe = Probe()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sleeps = []
        self.logs = LogCatcher()
        logging.getLogger().addHandler(self.logs)
        self.prev_level = logging.getLogger().level
        logging.getLogger().setLevel(logging.DEBUG)
        self.addCleanup(lambda: (logging.getLogger().removeHandler(self.logs), logging.getLogger().setLevel(self.prev_level)))
        self.w = self.worker("w1")

    def worker(self, wid, env=ON):
        return vw.VoiceWorker(vw.VoiceStore(SUPABASE, SERVICE_KEY, session=self.db), vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db),
                              vp.ElevenLabsVoiceProvider(self.el, EL_KEY), worker_id=wid, transcribe=self.tr, probe=self.probe,
                              env=env, sleep=self.sleeps.append, tmp_root=self.tmp.name)

    def ready(self, **kw):
        pid = self.db.request_clone(**kw)
        self.db.upload(pid)
        return pid

    def run_all(self, worker=None, limit=12):
        out = []
        for _ in range(limit):
            o = (worker or self.w).run_once()
            if o is None:
                return out
            out.append(o)
        raise AssertionError("the queue never emptied")

    def profile(self, pid):
        return self.db.profiles[pid]

    def assertNothingLeaks(self, *extra):
        text = "\n".join(self.logs.lines)
        for secret in (SERVICE_KEY, EL_KEY, PHRASE, "apple river", MARKER.decode(), BODY_SECRET, *extra):
            self.assertNotIn(secret, text)
        for v in self.el.voices:
            self.assertNotIn(v, text, "a provider voice id is never logged")
        self.assertEqual(os.listdir(self.tmp.name), [], "the local copy of the sample is removed on every path")


# ── the bytes ────────────────────────────────────────────────────────────────

class Sniffing(unittest.TestCase):
    def test_each_audio_container_is_recognised_by_its_first_bytes(self):
        pad = b"\x00" * 20
        cases = {
            "audio/webm": b"\x1a\x45\xdf\xa3" + pad, "audio/ogg": b"OggS" + pad, "audio/flac": b"fLaC" + pad,
            "audio/wav": b"RIFF\x00\x00\x00\x00WAVEfmt " + pad, "audio/mp4": b"\x00\x00\x00\x20ftypM4A " + pad,
            "audio/mpeg": b"ID3\x04" + pad, "audio/aac": b"\xff\xf1\x50\x80" + pad,
        }
        for mime, head in cases.items():
            with self.subTest(mime=mime):
                got = vw.sniff_audio(head)
                self.assertEqual(got.mime, mime)
                self.assertIn(got.mime, vp.SAMPLE_TYPES, "the provider adapter accepts every type the sniffer can name")
        self.assertEqual(vw.sniff_audio(b"\xff\xfb\x90\x00" + pad).mime, "audio/mpeg")   # a bare MPEG frame

    def test_things_that_are_not_audio_are_refused_whatever_they_are_called(self):
        pad = b"\x00" * 40
        for name, head in {
            "png": b"\x89PNG\r\n\x1a\n" + pad, "pdf": b"%PDF-1.7\n" + pad, "zip": b"PK\x03\x04" + pad, "html": b"<!doctype html><html>",
            "text": b"hello, this is not audio at all", "exe": b"MZ\x90\x00" + pad, "gif": b"GIF89a" + pad, "jpeg": b"\xff\xd8\xff\xe0" + pad,
            "empty": b"", "short": b"OggS", "riff-but-avi": b"RIFF\x00\x00\x00\x00AVI LIST" + pad,
            "reserved mpeg frame": b"\xff\xe8\x90\x00" + pad, "reserved mpeg version": b"\xff\xea\x90\x00" + pad, "bad bitrate frame": b"\xff\xfb\xf0\x00" + pad,
        }.items():
            with self.subTest(name=name):
                self.assertIsNone(vw.sniff_audio(head))

    def test_ffprobe_json_is_read_for_streams_and_length(self):
        doc = {"streams": [{"codec_type": "audio"}], "format": {"duration": "12.5"}}
        self.assertEqual(vw.facts_from_ffprobe(doc), vw.AudioFacts(1, 0, 12.5))
        cover = {"streams": [{"codec_type": "audio"}, {"codec_type": "video", "disposition": {"attached_pic": 1}}], "format": {"duration": "3"}}
        self.assertEqual(vw.facts_from_ffprobe(cover).video_streams, 0, "cover art is not a video")
        film = {"streams": [{"codec_type": "audio"}, {"codec_type": "video", "disposition": {"attached_pic": 0}}], "format": {"duration": "3"}}
        self.assertEqual(vw.facts_from_ffprobe(film).video_streams, 1)
        live = {"streams": [{"codec_type": "audio"}], "format": {"duration": "N/A"}}   # MediaRecorder's webm states no length
        self.assertIsNone(vw.facts_from_ffprobe(live).duration_s)
        self.assertEqual(vw.facts_from_ffprobe(live, 7.25).duration_s, 7.25)
        self.assertIsNone(vw.facts_from_ffprobe({"streams": [], "format": {"duration": "-1"}}).duration_s)
        with self.assertRaises(vw.ProbeError):
            vw.facts_from_ffprobe([])
        self.assertEqual(vw.decoded_seconds_from_progress("out_time_us=100\nout_time_us=2500000\nprogress=end\n"), 2.5)
        self.assertIsNone(vw.decoded_seconds_from_progress("progress=end"))

    def test_the_default_probe_asks_ffprobe_then_decodes_only_when_the_container_states_no_length(self):
        calls = []

        def run(cmd, **kw):
            calls.append(cmd[0])
            self.assertIsInstance(cmd, list, "no shell")
            self.assertTrue(kw["timeout"])
            if cmd[0] == "ffprobe":
                return mock.Mock(returncode=0, stdout='{"streams":[{"codec_type":"audio"}],"format":{"duration":"N/A"}}')
            return mock.Mock(returncode=0, stdout="out_time_us=4000000\nprogress=end\n")

        facts = vw.ffmpeg_probe(Path("/x/sample.webm"), run=run)
        self.assertEqual((calls, facts), (["ffprobe", "ffmpeg"], vw.AudioFacts(1, 0, 4.0)))
        calls.clear()
        stated = lambda cmd, **kw: (calls.append(cmd[0]), mock.Mock(returncode=0, stdout='{"streams":[{"codec_type":"audio"}],"format":{"duration":"9"}}'))[1]
        self.assertEqual(vw.ffmpeg_probe(Path("/x/s.wav"), run=stated).duration_s, 9.0)
        self.assertEqual(calls, ["ffprobe"])
        for broken in (mock.Mock(returncode=1, stdout=""), mock.Mock(returncode=0, stdout="not json")):
            with self.subTest(out=broken.stdout), self.assertRaises(vw.ProbeError):
                vw.ffmpeg_probe(Path("/x/s.wav"), run=lambda cmd, **kw: broken)
        with self.assertRaises(vw.ProbeError):
            vw.ffmpeg_probe(Path("/x/s.wav"), run=mock.Mock(side_effect=FileNotFoundError("no ffprobe")))

    def test_the_default_transcriber_is_the_pipelines_whisper_and_fixes_the_language(self):
        model = mock.Mock()
        model.transcribe.return_value = {"text": " apple river "}
        fake_whisper = mock.Mock()
        fake_whisper.load_model.return_value = model
        fake_subs = mock.Mock(WHISPER_MODEL="base")
        with mock.patch.dict(sys.modules, {"whisper": fake_whisper, "modules.subtitle_generator": fake_subs}):
            self.assertEqual(vw.whisper_transcriber()(Path("/x/sample.webm")), " apple river ")
        fake_whisper.load_model.assert_called_once_with("base")
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "en")
        src = (ROOT / "modules" / "subtitle_generator.py").read_text(encoding="utf-8")
        self.assertRegex(src, r'(?m)^WHISPER_MODEL = "')


# ── the switch ───────────────────────────────────────────────────────────────

class TheSwitch(Harness):
    def test_only_an_explicit_on_turns_it_on(self):
        for v in ("on", "ON", "1", "true", "Yes", " on "):
            self.assertTrue(vw.enabled({"NIGHTSHIFT_VOICE_CLONING": v}), v)
        for v in ("", "off", "0", "false", "no", "enabled", "2", " "):
            self.assertFalse(vw.enabled({"NIGHTSHIFT_VOICE_CLONING": v}), repr(v))
        self.assertFalse(vw.enabled({}))
        with mock.patch.dict(os.environ, {"NIGHTSHIFT_VOICE_CLONING": ""}):
            self.assertFalse(vw.enabled())

    def test_with_the_switch_off_nothing_is_claimed_fetched_or_called(self):
        pid = self.ready()
        for env in ({}, {"NIGHTSHIFT_VOICE_CLONING": ""}, {"NIGHTSHIFT_VOICE_CLONING": "off"}):
            self.assertIsNone(self.worker("w", env=env).run_once())
        self.assertEqual((self.db.calls, self.el.calls, self.tr.paths), ([], [], []))
        self.assertEqual(self.profile(pid)["status"], "pending_verification")
        self.assertEqual(len(self.db.under(pid)), 1, "and nothing is deleted either")

    def test_the_command_line_does_nothing_at_all_with_the_switch_off(self):
        from tools import voice_worker as cli

        with mock.patch.dict(os.environ, {"NIGHTSHIFT_VOICE_CLONING": "", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k",
                                          "ELEVENLABS_API_KEY": "e"}), \
                mock.patch.object(vw, "VoiceStore", side_effect=AssertionError("built a store")), \
                mock.patch.object(vw, "VoiceWorker", side_effect=AssertionError("built a worker")):
            self.assertEqual(cli.main(["--once"]), 0)

    def test_the_command_line_claims_nothing_without_what_it_needs(self):
        from tools import voice_worker as cli

        base = {"NIGHTSHIFT_VOICE_CLONING": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k", "ELEVENLABS_API_KEY": "e"}
        for missing in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "ELEVENLABS_API_KEY"):
            env = {k: v for k, v in base.items() if k != missing}
            with self.subTest(missing=missing), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(vw, "VoiceWorker", side_effect=AssertionError("started without " + missing)):
                self.assertEqual(cli.main(["--once"]), 2)

    def test_the_command_line_runs_one_step_with_everything_set(self):
        from tools import voice_worker as cli

        env = {"NIGHTSHIFT_VOICE_CLONING": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k", "ELEVENLABS_API_KEY": "e"}
        worker = mock.Mock()
        worker.run_once.return_value = None
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(vw, "VoiceWorker", return_value=worker) as made, \
                mock.patch.object(vw, "whisper_transcriber", return_value=lambda p: ""), mock.patch.object(cli.signal, "signal"):
            self.assertEqual(cli.main(["--once", "--worker-id", "w9"]), 0)
        worker.run_once.assert_called_once_with()
        self.assertEqual(made.call_args.kwargs["worker_id"], "w9")

    def test_nothing_in_the_repository_runs_the_worker(self):
        # The owner starts it by hand after the steps in docs/CUSTOM_VOICE.md. A service, a cron entry or a workflow would be a
        # different decision, made in a different PR.
        hits = []
        for base in (".github", "deploy", "Dockerfile.worker"):
            p = ROOT / base
            for f in ([p] if p.is_file() else [f for f in p.rglob("*") if f.is_file()]):
                if "voice_worker" in f.read_text(encoding="utf-8", errors="ignore"):
                    hits.append(str(f.relative_to(ROOT)))
        for f in (ROOT / "tools").glob("*.py"):
            if f.name != "voice_worker.py" and "voice_worker" in f.read_text(encoding="utf-8"):
                hits.append(str(f.relative_to(ROOT)))
        self.assertEqual(hits, [])
        self.assertNotIn("voice_worker", (ROOT / "tools" / "queue_worker.py").read_text(encoding="utf-8"))


# ── a clone ──────────────────────────────────────────────────────────────────

class Clone(Harness):
    def test_the_happy_path_clones_records_and_deletes_our_copy(self):
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.kind, out.result), ("clone", "cloned"))
        p = self.profile(pid)
        self.assertEqual(p["status"], "testing")
        self.assertEqual(p["provider"], "elevenlabs")
        self.assertRegex(p["voice_id"], r"^[A-Za-z0-9]{20}$")
        self.assertEqual(p["voice_id"], list(self.el.voices)[0])
        self.assertEqual(p["sha"], vp.sample_sha256(WEBM), "only the hash of the sample survives")
        self.assertEqual(self.db.under(pid), [], "our copy is gone the moment the answer was recorded")
        self.assertEqual(p["sample_state"], "purge_pending", "and the purge job is the confirmation")
        # The provider saw exactly: the plan probe, a name lookup, one create with the SNIFFED type and the traceable name.
        self.assertEqual([(m, path) for m, path, _ in self.el.calls], [("get", "/user/subscription"), ("get", "/voices"),
                                                                       ("get", "/user/subscription"), ("post", "/voices/add")])
        create = self.el.posts()[0][2]
        self.assertEqual(create["data"]["name"], vp.provider_voice_name("ab" * 16, pid))
        self.assertEqual(create["files"]["files"][0], "sample.webm")
        self.assertEqual(create["files"]["files"][2], "audio/webm")
        self.assertEqual(create["files"]["files"][1], WEBM)
        self.assertNotIn("Mine", str(create["data"]), "the user's own words never reach the provider")
        self.assertEqual(self.tr.seen, [WEBM], "Whisper read the real bytes")
        self.assertEqual(self.db.consents[-1]["result"], "passed")
        self.assertNothingLeaks(p["voice_id"])

    def test_the_purge_job_that_follows_is_idempotent_and_ends_it(self):
        pid = self.ready()
        outcomes = self.run_all()
        self.assertEqual([(o.kind, o.result) for o in outcomes], [("clone", "cloned"), ("purge_sample", "purged")])
        self.assertEqual(self.profile(pid)["sample_state"], "purged")
        self.assertEqual(len(self.el.voices), 1, "one voice, however many jobs ran")
        self.assertEqual([r["event"] for r in self.db.records], ["sample_purged"])
        self.assertIsNone(self.w.run_once())

    def test_the_declared_type_is_never_trusted(self):
        # A PNG uploaded under a name and a type that say webm: the bucket let it in, the worker must not.
        pid = self.db.request_clone()
        self.db.upload(pid, b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, name="sample.webm")
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "not_audio"))
        self.assertEqual(self.profile(pid)["reject_reason"], "not_audio")
        self.assertEqual((self.tr.paths, self.probe.calls, self.el.posts()), ([], 0, []), "nothing was transcribed, probed or sent")
        self.assertEqual(self.db.under(pid), [])
        self.assertNothingLeaks()

    def test_the_provider_gets_the_sniffed_type_not_the_one_in_the_name(self):
        pid = self.db.request_clone()
        ogg = b"OggS" + b"\x00" * 40 + MARKER
        self.db.upload(pid, ogg, name="sample.webm")   # called webm, is ogg
        self.assertEqual(self.w.run_once().result, "cloned")
        sent = self.el.posts()[0][2]["files"]["files"]
        self.assertEqual((sent[0], sent[1], sent[2]), ("sample.ogg", ogg, "audio/ogg"))
        self.assertEqual(self.tr.paths[0].suffix, ".ogg", "and the local copy is named for what it is")

    def test_an_object_that_vanished_or_a_storage_error_is_told_apart(self):
        real = self.db._route
        for answer, expect in ((Resp(404), ("rejected", "sample_missing")), (Resp(400, {"statusCode": "404"}), ("rejected", "sample_missing")),
                               (Resp(400, {"statusCode": "403"}), ("retry", "transient")), (Resp(500), ("retry", "transient"))):
            with self.subTest(status=answer.status_code, body=answer._body):
                self.setUp()
                pid = self.ready()
                real = self.db._route
                self.db._route = lambda m, u, kw, real=real, answer=answer: answer if m == "get" else real(m, u, kw)
                out = self.w.run_once()
                self.assertEqual((out.result, out.code), expect)
                self.assertEqual((self.tr.paths, self.el.posts()), ([], []))

    def test_a_clone_job_with_no_phrase_or_a_bad_owner_reference_is_ended_not_guessed(self):
        pid = self.db.request_clone(phrase=None)
        self.db.upload(pid)
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "bad_job"))
        self.setUp()
        pid = self.ready()
        self.profile(pid)["owner_ref"] = "not-an-owner-ref"
        self.assertEqual(self.w.run_once().code, "bad_job")
        self.assertEqual((self.el.calls, self.tr.paths), ([], []))

    def test_a_real_audio_container_that_is_really_a_video_is_refused(self):
        self.probe.facts = vw.AudioFacts(1, 1, 5.0)
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "not_audio"))
        self.assertEqual((self.tr.paths, self.el.posts(), self.db.under(pid)), ([], [], []))

    def test_a_file_the_probe_cannot_read_or_that_has_no_audio_or_no_length_is_refused(self):
        for facts, word in ((vw.ProbeError("x"), "unreadable_audio"), (vw.AudioFacts(0, 0, 5.0), "not_audio"),
                            (vw.AudioFacts(1, 0, None), "unreadable_audio"), (vw.AudioFacts(1, 0, 0.0), "unreadable_audio")):
            with self.subTest(word=word, facts=repr(facts)):
                self.setUp()
                self.probe.facts = facts
                pid = self.ready()
                out = self.w.run_once()
                self.assertEqual((out.result, out.code), ("rejected", word))
                self.assertEqual((self.tr.paths, self.el.posts(), self.db.under(pid)), ([], [], []))

    def test_over_length_is_refused_at_the_limit_and_not_before(self):
        self.probe.facts = vw.AudioFacts(1, 0, vw.MAX_SAMPLE_SECONDS)
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "cloned")
        self.setUp()
        self.probe.facts = vw.AudioFacts(1, 0, vw.MAX_SAMPLE_SECONDS + 0.5)
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "sample_too_long"))
        self.assertEqual((self.tr.paths, self.el.posts(), self.db.under(pid)), ([], [], []))

    def test_oversize_is_refused_by_the_declared_length_and_by_what_actually_arrives(self):
        pid = self.db.request_clone()
        self.db.upload(pid, WEBM + b"\x00" * 5000)
        small = vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db, max_bytes=1000)
        self.w.storage = small
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "sample_too_large"))
        self.assertEqual((self.tr.paths, self.el.posts(), self.db.under(pid)), ([], [], []))
        # A declared length over the limit is refused before a single byte is read.
        class Declared(Resp):
            def iter_content(self, chunk_size=65536):
                raise AssertionError("the body was read although its declared length is over the limit")

        session = mock.Mock()
        session.get.return_value = Declared(200, headers={"Content-Length": "1001"})
        with self.assertRaises(vw.StorageError) as declared:
            vw.SampleStorage(SUPABASE, SERVICE_KEY, session=session, max_bytes=1000).download(f"{USER}/0000000f-0000-4000-8000-000000000000/sample.webm")
        self.assertEqual(declared.exception.code, "too_large")
        # No Content-Length at all: the read itself stops.
        got = []

        class Chunked(Resp):
            def iter_content(self, chunk_size=65536):
                for _ in range(10):
                    got.append(chunk_size)
                    yield b"\x00" * 600

        key = f"{USER}/{'0000000f'}-0000-4000-8000-000000000000/sample.webm"
        session = mock.Mock()
        session.get.return_value = Chunked(200)
        with self.assertRaises(vw.StorageError) as ctx:
            vw.SampleStorage(SUPABASE, SERVICE_KEY, session=session, max_bytes=1000).download(key)
        self.assertEqual(ctx.exception.code, "too_large")
        self.assertLess(len(got), 10, "the read stopped as soon as the limit was crossed")
        self.assertTrue(session.get.return_value.closed)

    def test_a_wrong_phrase_is_rejected_and_the_provider_is_never_asked(self):
        self.tr.text = "banana table lamp window garden pencil"
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "verification_failed"))
        p = self.profile(pid)
        self.assertEqual((p["status"], p["reject_reason"]), ("rejected", "verification_failed"))
        self.assertEqual(self.db.consents[-1]["result"], "failed")
        self.assertEqual(self.db.consents[-1]["sha"], vp.sample_sha256(WEBM), "the hash of what was heard is the hash recorded")
        self.assertEqual(self.el.posts(), [], "no create")
        self.assertNotIn(("get", "/voices"), [(m, path) for m, path, _ in self.el.calls], "not even a lookup")
        self.assertEqual(self.db.under(pid), [])
        self.assertEqual(self.run_all()[0].result, "purged", "and the purge job confirms it")
        self.assertNothingLeaks()

    def test_a_near_miss_word_is_tolerated_as_the_pure_check_says(self):
        self.tr.text = "Okay. Apple, river, candle, windo, garden, pencil."
        self.ready()
        self.assertEqual(self.w.run_once().result, "cloned")

    def test_a_transcriber_that_fails_is_retried_then_ended_with_its_own_word(self):
        self.tr.text = RuntimeError("whisper blew up: " + BODY_SECRET)
        pid = self.ready()
        results = [self.w.run_once() for _ in range(3)]
        self.assertEqual([r.result for r in results], ["retry", "retry", "rejected"])
        self.assertEqual(self.profile(pid)["reject_reason"], "transcribe_failed")
        self.assertEqual(self.db.under(pid), [])
        self.assertEqual(self.el.posts(), [])
        self.assertNothingLeaks()

    def test_a_job_the_database_would_never_send_is_not_acted_on(self):
        good = dict(job_id="00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind="clone", attempts=1, profile_id="00000002-0000-4000-8000-000000000000",
                    user_id=USER, owner_ref="ab" * 16, keep_sample=False, phrase=PHRASE,
                    sample_prefix=f"{USER}/00000002-0000-4000-8000-000000000000/",
                    sample_path=f"{USER}/00000002-0000-4000-8000-000000000000/sample.webm", provider_voice_id=None)
        self.assertFalse(vw.Job.parse(good).keep_sample)
        self.assertFalse(vw.Job.parse({k: v for k, v in good.items() if k != "keep_sample"}).keep_sample, "a missing choice is not 'keep'")
        self.assertTrue(vw.Job.parse(dict(good, keep_sample=True)).keep_sample)
        for patch in ({"sample_prefix": f"{USER2}/00000002-0000-4000-8000-000000000000/"},
                      {"sample_path": f"{USER}/00000002-0000-4000-8000-000000000000/../x/sample.webm"},
                      {"sample_path": f"{USER2}/00000002-0000-4000-8000-000000000000/sample.webm"},
                      {"sample_path": f"{USER}/00000002-0000-4000-8000-000000000000/other.webm"},
                      {"kind": "wipe"}, {"attempts": 0}, {"attempts": True}, {"user_id": "../.."}, {"profile_id": ""}, {"job_id": None}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                vw.Job.parse(dict(good, **patch))
        self.db.calls.clear()
        store = mock.Mock()
        store.claim.return_value = dict(good, sample_prefix="../")
        storage = mock.Mock()
        w = vw.VoiceWorker(store, storage, mock.Mock(), worker_id="w", transcribe=self.tr, probe=self.probe, env=ON)
        self.assertEqual(w.run_once().result, "invalid")
        self.assertEqual(storage.mock_calls, [])

    def test_the_workers_own_size_check_holds_even_if_the_storage_client_let_more_through(self):
        pid = self.ready()
        with mock.patch.object(vw, "MAX_SAMPLE_BYTES", len(WEBM) - 1):
            out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "sample_too_large"))
        self.assertEqual((self.tr.paths, self.el.posts()), ([], []))

    def test_a_storage_prefix_can_only_be_two_uuids_deep(self):
        for user, profile in (("", ""), ("..", "x"), (USER, ""), (USER, "../" + USER2), ("*", "*"), (USER, "all")):
            with self.subTest(user=user, profile=profile), self.assertRaises(vw.StorageError):
                vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db).delete_prefix(user, profile)
        self.assertEqual(self.db.calls, [])


# ── the plan ─────────────────────────────────────────────────────────────────

class ThePlan(Harness):
    def free_plan_ends_in_provider_not_enabled(self, plan):
        self.setUp()
        self.el.plan = plan
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "provider_not_enabled"))
        p = self.profile(pid)
        self.assertEqual((p["status"], p["reject_reason"], p["voice_id"]), ("rejected", "provider_not_enabled", None))
        self.assertEqual([(m, path) for m, path, _ in self.el.calls], [("get", "/user/subscription")],
                         "one read-only plan probe and nothing else: no lookup, no create, nothing spent")
        self.assertFalse([c for c in self.db.calls if c[0] == "get"], "the sample was not even fetched")
        self.assertEqual(self.tr.paths, [])
        self.assertEqual(self.db.under(pid), [], "and our copy is purged")
        self.assertEqual([o.result for o in self.run_all()], ["purged"])
        self.assertNothingLeaks()

    def test_the_free_plan_ends_every_clone_as_provider_not_enabled_with_nothing_spent(self):
        self.free_plan_ends_in_provider_not_enabled(False)

    def test_a_plan_answer_without_the_flag_is_not_a_yes(self):
        self.free_plan_ends_in_provider_not_enabled(None)

    def test_a_non_boolean_flag_is_not_a_yes(self):
        self.el.script["get:/user/subscription"] = [Resp(200, {"can_use_instant_voice_cloning": "true"})]
        pid = self.ready()
        self.assertEqual(self.w.run_once().code, "provider_not_enabled")
        self.assertEqual(self.el.posts(), [])

    def test_a_deletion_never_needs_the_plan(self):
        self.el.plan = False
        pid = self.db.request_clone()
        self.profile(pid).update(status="testing", provider="elevenlabs", voice_id="AbCdEfGhIjKlMnOpQrSt", sample_state="purged")
        self.el.voices["AbCdEfGhIjKlMnOpQrSt"] = "x"
        self.db.owner_deletes(pid)
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("delete_provider", "deleted")])
        self.assertEqual(self.el.voices, {})
        self.assertNotIn("/user/subscription", [path for _, path, _ in self.el.calls])


# ── the provider ─────────────────────────────────────────────────────────────

class Provider(Harness):
    def only(self, key, *answers):
        self.el.script[key] = list(answers)

    def test_a_non_retryable_answer_ends_it_at_once_with_a_closed_word(self):
        cases = [
            (Resp(401, {"detail": {"status": "invalid_api_key", "message": BODY_SECRET}}, content=BODY_SECRET.encode()), "provider_auth"),
            (Resp(401, {"detail": {"status": "can_not_use_instant_voice_cloning", "message": BODY_SECRET}}), "provider_not_enabled"),
            (Resp(422, {"detail": BODY_SECRET}), "provider_rejected"),
            (Resp(400, {"detail": BODY_SECRET}), "provider_error"),
        ]
        for answer, word in cases:
            with self.subTest(word=word, status=answer.status_code):
                self.setUp()
                self.only("post:/voices/add", answer)
                pid = self.ready()
                out = self.w.run_once()
                self.assertEqual((out.result, out.code), ("rejected", word))
                self.assertEqual(self.profile(pid)["reject_reason"], word)
                self.assertEqual(self.job_attempts(pid), 1, "not retried")
                self.assertEqual(self.db.under(pid), [])
                self.assertNothingLeaks()

    def job_attempts(self, pid):
        return self.db.job(pid, "clone")["attempts"]

    def test_an_error_from_the_provider_never_carries_its_body_into_the_database_or_the_log(self):
        self.only("post:/voices/add", Resp(422, {"detail": {"status": "x_" + BODY_SECRET.lower().replace("-", "_"), "message": BODY_SECRET}}))
        pid = self.ready()
        self.w.run_once()
        stored = " ".join(str(v) for v in self.profile(pid).values()) + " ".join(str(j["error"]) for j in self.db.jobs)
        self.assertNotIn(BODY_SECRET, stored)
        self.assertNothingLeaks()

    def test_5xx_and_429_are_retried_with_the_three_attempt_rule_and_then_ended(self):
        for status in (500, 503, 429):
            with self.subTest(status=status):
                self.setUp()
                self.only("post:/voices/add", Resp(status, {"detail": BODY_SECRET}), Resp(status), Resp(status))
                pid = self.ready()
                outs = [self.w.run_once() for _ in range(3)]
                self.assertEqual([o.result for o in outs], ["retry", "retry", "rejected"])
                self.assertEqual(outs[-1].code, "provider_unavailable", "the last attempt says what happened, not 'transient'")
                self.assertEqual(self.profile(pid)["reject_reason"], "provider_unavailable")
                self.assertEqual(self.db.under(pid), [], "kept between attempts, gone at the end")
                self.assertEqual(self.job_attempts(pid), 3)
                self.assertEqual(self.el.voices, {}, "nothing was created")

    def test_the_sample_is_kept_while_a_retry_is_still_possible(self):
        self.only("post:/voices/add", Resp(503))
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual(out.result, "retry")
        self.assertEqual(len(self.db.under(pid)), 1)
        self.assertEqual(self.profile(pid)["status"], "pending_verification")
        self.assertEqual(self.w.retry_wait(out), vw.BACKOFF_SECONDS[0])
        self.assertEqual(self.w.run_once().result, "cloned", "the next claim clones it")
        self.assertEqual(self.db.under(pid), [])

    def test_the_wait_between_attempts_grows(self):
        mk = lambda n: vw.Outcome("clone", "retry", "transient", n)
        self.assertEqual([self.w.retry_wait(mk(n)) for n in (1, 2, 3, 9)], [30.0, 120.0, 600.0, 600.0])
        self.assertEqual(self.w.retry_wait(vw.Outcome("clone", "cloned")), 0.0)

    def test_a_timeout_on_the_plan_probe_is_retried_and_spends_nothing(self):
        self.only("get:/user/subscription", TimeoutError("slow " + BODY_SECRET))
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "retry")
        self.assertEqual(self.el.posts(), [])
        self.assertEqual(self.w.run_once().result, "cloned")

    def test_a_timeout_after_the_voice_was_made_is_adopted_not_made_twice(self):
        # The nasty one: the provider did the work and the answer never arrived.
        self.only("post:/voices/add", ("made", TimeoutError("read timed out " + BODY_SECRET)))
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "retry")
        self.assertEqual(len(self.el.voices), 1)
        out = self.w.run_once()
        self.assertEqual(out.result, "cloned")
        self.assertEqual(len(self.el.voices), 1, "the second attempt found the voice by its name")
        self.assertEqual(len(self.el.posts()), 1, "and did not create another")
        self.assertEqual(self.profile(pid)["voice_id"], list(self.el.voices)[0])
        self.assertNothingLeaks()

    def test_a_create_that_returns_no_usable_id_is_adopted_on_the_next_attempt(self):
        self.only("post:/voices/add", ("made", Resp(200, {"nope": 1})))
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "retry", "maybe created: look before creating again")
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertEqual((len(self.el.voices), len(self.el.posts())), (1, 1))

    def test_an_http_answer_the_adapter_does_not_know_is_not_retried(self):
        self.only("post:/voices/add", Resp(402, {"detail": BODY_SECRET}))
        pid = self.ready()
        self.assertEqual((self.w.run_once().result, self.job_attempts(pid)), ("rejected", 1))
        self.assertEqual(self.profile(pid)["reject_reason"], "provider_error")

    def test_a_redirect_from_the_provider_is_refused_and_never_followed(self):
        self.only("post:/voices/add", Resp(302, headers={"Location": "https://evil.example/"}))
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "provider_redirect"))
        self.assertEqual([c for c in self.el.calls if "evil" in c[1]], [])
        self.assertNothingLeaks()

    def test_a_possibly_created_voice_is_removed_when_the_clone_ends_for_good(self):
        # The last attempt creates the voice and then loses the answer: the profile is rejected, and a clone of a person's voice
        # must not be left in the provider account.
        self.only("post:/voices/add", Resp(503), Resp(503), ("made", ConnectionError(BODY_SECRET)))
        pid = self.ready()
        outs = [self.w.run_once() for _ in range(3)]
        self.assertEqual([o.result for o in outs], ["retry", "retry", "rejected"])
        self.assertEqual(self.profile(pid)["reject_reason"], "provider_unavailable")
        self.assertEqual(self.el.voices, {}, "the voice that may have been created was deleted")
        self.assertNothingLeaks()

    def test_a_provider_that_answers_the_name_lookup_with_two_voices_keeps_one(self):
        pid = self.ready()
        name = vp.provider_voice_name("ab" * 16, pid)
        self.el.voices.update({"A" * 20: name, "B" * 20: name, "C" * 20: "someone elses"})
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertEqual(self.profile(pid)["voice_id"], "A" * 20)
        self.assertEqual(sorted(self.el.voices), ["A" * 20, "C" * 20], "the duplicate of OUR name went; a stranger's voice is untouched")
        self.assertEqual(self.el.posts(), [])

    def test_a_listed_voice_with_a_malformed_id_is_never_adopted(self):
        pid = self.ready()
        name = vp.provider_voice_name("ab" * 16, pid)
        self.el.voices.update({"short": name, "x/../y" + "z" * 14: name})
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertRegex(self.profile(pid)["voice_id"], r"^Vx\d{18}$", "a fresh voice was made instead")

    def test_the_key_goes_only_to_elevenlabs_and_only_in_the_header(self):
        self.ready()
        self.w.run_once()
        for method, path, kw in self.el.calls:
            self.assertEqual(kw["headers"]["xi-api-key"], EL_KEY)
            self.assertNotIn(EL_KEY, str(kw.get("data")) + str(kw.get("files")))
        for headers in self.db.headers_seen:
            self.assertNotIn("xi-api-key", headers, "the Supabase calls never carry the ElevenLabs key")


# ── two workers, crashes, resumption ─────────────────────────────────────────

class Concurrency(Harness):
    def test_two_workers_never_take_the_same_job(self):
        pid = self.ready()
        w2 = self.worker("w2")
        first = self.w.run_once()
        self.assertEqual(first.result, "cloned")
        self.assertEqual([(o.kind, o.result) for o in self.run_all(w2)], [("purge_sample", "purged")], "w2 only gets what is left")
        self.assertEqual(len(self.el.posts()), 1)

    def test_a_job_that_is_running_is_not_handed_out_again(self):
        self.ready()
        claimed = self.db._claim("w1")
        self.assertEqual(claimed["attempts"], 1)
        self.assertIsNone(self.worker("w2").run_once(), "the lease is still good")
        self.assertEqual(self.el.calls, [])

    def test_a_stale_lease_taken_over_by_a_second_worker_leaves_one_voice_and_the_first_cannot_overwrite(self):
        pid = self.ready()
        w2 = self.worker("w2")
        seen = {}

        def lease_runs_out_and_w2_finishes_the_job():
            if seen:
                return
            seen["done"] = True
            self.db.expire_leases()
            seen["w2"] = w2.run_once()

        self.el.after_create = lease_runs_out_and_w2_finishes_the_job
        out = self.w.run_once()
        self.assertEqual(seen["w2"].result, "cloned", "w2 adopted the voice w1 had just made and recorded it")
        self.assertEqual(out.result, "lost", "w1's late answer was refused as not_holder")
        self.assertEqual(len(self.el.voices), 1)
        self.assertEqual(len(self.el.posts()), 1)
        self.assertEqual(self.profile(pid)["voice_id"], list(self.el.voices)[0])
        self.assertEqual(self.profile(pid)["status"], "testing")

    def test_a_finish_for_a_job_this_worker_does_not_hold_is_lost_and_changes_nothing(self):
        pid = self.ready()
        self.db._claim("someone-else")
        store = vw.VoiceStore(SUPABASE, SERVICE_KEY, session=self.db)
        job = self.db.job(pid, "clone")
        res = store.finish_clone(job["id"], "w1", "passed", "elevenlabs", "A" * 20, "0" * 64, None)
        self.assertEqual(res, {"ok": False, "error": "not_holder"})
        self.assertEqual(len(self.db.under(pid)), 1)


class Crashes(Harness):
    def test_a_crash_after_the_voice_was_made_resumes_by_adopting_it_and_the_sample_is_purged(self):
        pid = self.ready()

        def die():
            raise Crash()

        self.el.after_create = die
        with self.assertRaises(Crash):
            self.w.run_once()
        self.assertEqual(self.profile(pid)["status"], "pending_verification")
        self.assertEqual(len(self.db.under(pid)), 1, "the sample is still there: nothing was recorded")
        self.assertEqual(self.db.job(pid, "clone")["status"], "running")
        self.assertIsNone(self.worker("w2").run_once(), "not until the lease runs out")
        self.el.after_create = None
        self.db.expire_leases()
        outs = self.run_all(self.worker("w2"))
        self.assertEqual([(o.kind, o.result) for o in outs], [("clone", "cloned"), ("purge_sample", "purged")])
        self.assertEqual(self.db.job(pid, "clone")["attempts"], 2)
        self.assertEqual(len(self.el.voices), 1, "resumed, not repeated")
        self.assertEqual(len(self.el.posts()), 1)
        self.assertEqual(self.db.under(pid), [])
        self.assertEqual(self.profile(pid)["sample_state"], "purged")

    def test_a_crash_while_deleting_our_copy_leaves_a_purge_job_that_finishes_it(self):
        pid = self.ready()
        real = vw.SampleStorage.delete_prefix
        state = {"n": 0}

        def flaky(self_, user, profile):
            state["n"] += 1
            if state["n"] == 1:
                raise Crash()
            return real(self_, user, profile)

        with mock.patch.object(vw.SampleStorage, "delete_prefix", flaky), self.assertRaises(Crash):
            self.w.run_once()
        self.assertEqual(self.profile(pid)["status"], "testing", "the answer was already recorded")
        self.assertEqual(len(self.db.under(pid)), 1)
        with mock.patch.object(vw.SampleStorage, "delete_prefix", flaky):
            self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("purge_sample", "purged")])
        self.assertEqual(self.db.under(pid), [])

    def test_a_worker_that_dies_three_times_ends_with_the_voice_removed_and_the_sample_purged(self):
        pid = self.ready()
        self.db.rpc_failures["finish_voice_clone"] = [Crash(), Crash(), Crash()]   # dies each time it is about to record
        for attempt in (1, 2, 3):
            with self.assertRaises(Crash):
                self.worker(f"w{attempt}").run_once()
            self.db.expire_leases()
        self.assertEqual(len(self.el.voices), 1, "made once and adopted twice")
        self.assertEqual(len(self.db.under(pid)), 1, "nothing was ever recorded, so nothing was let go of")
        outs = self.run_all(self.worker("w4"))
        self.assertEqual([(o.kind, o.result) for o in outs], [("purge_sample", "purged")])
        p = self.profile(pid)
        self.assertEqual((p["status"], p["reject_reason"], p["sample_state"]), ("rejected", "worker_lost", "purged"))
        self.assertEqual(self.db.under(pid), [])
        self.assertEqual(self.el.voices, {}, "no clone of a rejected profile is left in the provider account")
        self.assertNothingLeaks()

    def test_the_orphan_sweep_only_touches_voices_of_that_profiles_own_name(self):
        pid = self.db.request_clone()
        other = self.db.request_clone()
        self.profile(pid).update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = [j for j in self.db.jobs if j["profile"] == other]
        self.db._add_job(pid, "purge_sample")
        self.el.voices.update({"A" * 20: vp.provider_voice_name("ab" * 16, pid), "B" * 20: vp.provider_voice_name("ab" * 16, other),
                               "C" * 20: "Rachel"})
        self.run_all()
        self.assertEqual(sorted(self.el.voices), ["B" * 20, "C" * 20])

    def test_a_database_that_cannot_be_reached_after_the_voice_was_made_does_not_lose_it(self):
        pid = self.ready()
        self.db.rpc_failures["finish_voice_clone"] = [ConnectionError(SERVICE_KEY)] * 3
        out = self.w.run_once()
        self.assertEqual(out.result, "unrecorded")
        self.assertEqual(len(self.db.under(pid)), 1, "the sample stays until the database has accepted the answer")
        self.assertEqual(self.sleeps, [1, 3])
        self.db.expire_leases()
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("clone", "cloned"), ("purge_sample", "purged")])
        self.assertEqual(len(self.el.voices), 1)
        self.assertNothingLeaks()

    def test_an_unforeseen_exception_is_reported_as_transient_and_then_as_a_worker_error(self):
        pid = self.ready()
        with mock.patch.object(vw.VoiceWorker, "_clone", side_effect=ValueError("boom " + BODY_SECRET)):
            outs = [self.w.run_once() for _ in range(3)]
        self.assertEqual([o.result for o in outs], ["retry", "retry", "rejected"])
        self.assertEqual(self.profile(pid)["reject_reason"], "worker_error")
        self.assertNothingLeaks()

    def test_a_claim_that_cannot_reach_the_database_is_quiet_and_logged_once(self):
        self.db.rpc_failures["claim_voice_job"] = [ConnectionError(SERVICE_KEY)] * 2
        self.assertIsNone(self.w.run_once())
        self.assertIsNone(self.w.run_once())
        warnings = [l for l in self.logs.lines if "queue unavailable" in l]
        self.assertEqual(len(warnings), 1)
        self.assertNothingLeaks()


# ── deleting at the provider, purging, keeping ───────────────────────────────

class OtherJobs(Harness):
    def voiced(self, keep=False):
        pid = self.db.request_clone(keep=keep)
        self.profile(pid).update(status="testing", provider="elevenlabs", voice_id="AbCdEfGhIjKlMnOpQrSt", sample_state="purged")
        self.el.voices["AbCdEfGhIjKlMnOpQrSt"] = "x"
        return pid

    def test_a_deletion_calls_delete_and_a_404_counts_as_done(self):
        pid = self.voiced()
        self.db.owner_deletes(pid)
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("delete_provider", "deleted")])
        self.assertEqual(self.el.voices, {})
        self.assertEqual([c[:2] for c in self.el.calls], [("delete", "/voices/AbCdEfGhIjKlMnOpQrSt")])
        pid2 = self.voiced()
        self.profile(pid2)["voice_id"] = "ZyXwVuTsRqPoNmLkJiHg"   # not in the provider account at all
        self.db.owner_deletes(pid2)
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("delete_provider", "deleted")])
        self.assertEqual(self.db.job(pid2, "delete_provider")["status"], "succeeded")

    def test_a_failing_provider_delete_is_retried_three_times_and_then_stays_failed(self):
        pid = self.voiced()
        self.db.owner_deletes(pid)
        self.el.script["delete:/voices/{id}"] = [Resp(500, {"detail": BODY_SECRET}), Resp(503), Resp(500)]
        outs = [self.w.run_once() for _ in range(3)]
        self.assertEqual([o.result for o in outs], ["retry", "retry", "failed"])
        self.assertEqual(self.db.job(pid, "delete_provider")["status"], "failed")
        self.assertEqual(self.db.job(pid, "delete_provider")["error"], "provider_unavailable")
        self.assertIn("AbCdEfGhIjKlMnOpQrSt", self.el.voices, "and the voice is still there to be found, not forgotten")
        self.assertNothingLeaks()

    def test_a_delete_job_without_a_voice_id_fails_closed(self):
        pid = self.db.request_clone()
        self.db._add_job(pid, "delete_provider")
        self.db.jobs[:] = [j for j in self.db.jobs if j["kind"] != "clone"]
        self.assertEqual(self.w.run_once().result, "retry")
        self.assertEqual(self.el.calls, [])
        self.assertEqual(self.db.job(pid, "delete_provider")["error"], "no_voice_id")

    def test_a_provider_that_says_the_voice_is_not_gone_is_not_believed(self):
        pid = self.voiced()
        self.db.owner_deletes(pid)
        self.w.provider = mock.Mock()
        self.w.provider.delete_voice.return_value = False
        self.assertEqual(self.w.run_once().result, "retry")
        self.assertEqual(self.db.job(pid, "delete_provider")["error"], "provider_error")
        self.assertNotEqual(self.db.job(pid, "delete_provider")["status"], "succeeded")

    def test_a_purge_removes_the_whole_prefix_and_nothing_beside_it(self):
        pid = self.db.request_clone()
        other_profile = self.db.request_clone()
        other_user = self.db.request_clone(user=USER2)
        p = self.profile(pid)
        base = f"{p['user_id']}/{pid}"
        self.db.objects.update({f"{base}/sample.webm": b"a", f"{base}/sample.ogg": b"b", f"{base}/.emptyFolderPlaceholder": b"",
                                f"{base}/nested/deeper/x.bin": b"c"})
        self.db.upload(other_profile)
        self.db.upload(other_user)
        self.db.profiles[pid].update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = []
        self.db._add_job(pid, "purge_sample")
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("purge_sample", "purged")])
        self.assertEqual(self.db.under(pid), [])
        self.assertEqual(len(self.db.under(other_profile)), 1, "a sibling profile of the same user is untouched")
        self.assertEqual(len(self.db.under(other_user)), 1, "another user's prefix is untouched")
        self.assertEqual(self.profile(pid)["sample_state"], "purged")

    def test_a_purge_that_cannot_confirm_the_prefix_is_empty_is_not_reported_done(self):
        pid = self.ready()
        self.profile(pid).update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = []
        self.db._add_job(pid, "purge_sample")
        real = self.db._route

        def keep_objects(method, url, kw):
            if method == "delete":
                return Resp(200, [])
            return real(method, url, kw)

        self.db._route = keep_objects
        outs = [self.w.run_once() for _ in range(3)]
        self.assertEqual([o.result for o in outs], ["retry", "retry", "failed"])
        self.assertEqual(self.db.job(pid, "purge_sample")["error"], "storage_not_deleted")
        self.assertNotEqual(self.profile(pid)["sample_state"], "purged", "never claims a deletion it could not confirm")

    def test_a_sample_the_owner_chose_to_keep_is_kept_until_they_delete_it(self):
        pid = self.ready(keep=True)
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertEqual(len(self.db.under(pid)), 1, "keep means keep: the database queued no purge")
        self.assertEqual(self.profile(pid)["sample_state"], "stored")
        self.assertIsNone(self.w.run_once())
        self.db.owner_deletes_sample(pid)
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("purge_sample", "purged")])
        self.assertEqual(self.db.under(pid), [])
        self.assertEqual(self.profile(pid)["status"], "testing", "the voice itself is untouched")

    def test_a_voice_the_owner_deleted_while_it_was_being_made_is_cleaned_up(self):
        pid = self.ready()
        self.el.after_create = lambda: self.db.owner_deletes(pid)
        out = self.w.run_once()
        self.assertEqual(out.result, "rejected")
        self.assertEqual(self.profile(pid)["status"], "deleted")
        self.assertEqual(self.db.under(pid), [])
        self.el.after_create = None
        kinds = [(o.kind, o.result) for o in self.run_all()]
        self.assertIn(("delete_provider", "deleted"), kinds)
        self.assertEqual(self.el.voices, {}, "the voice that was made while the owner deleted is removed")


# ── Supabase over real HTTP: what a fake cannot show ─────────────────────────

class _Target(http.server.BaseHTTPRequestHandler):
    seen = []
    big = b""
    omit_length = False

    def log_message(self, *a):
        pass

    def do_GET(self):
        type(self).seen.append((self.path, dict(self.headers)))
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.other_port}/stolen")
            self.end_headers()
        elif self.path.startswith("/storage/v1/object/voice-samples/"):
            body = type(self).big
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            if not type(self).omit_length:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                for i in range(0, len(body), 8192):
                    self.wfile.write(body[i:i + 8192])
            except OSError:
                pass
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        type(self).seen.append((self.path, dict(self.headers)))
        self.send_response(302)
        self.send_header("Location", f"http://127.0.0.1:{self.server.other_port}/stolen")
        self.end_headers()


class RealHttp(unittest.TestCase):
    def setUp(self):
        _Target.seen = []
        _Target.omit_length = False
        self.other = http.server.HTTPServer(("127.0.0.1", 0), _Target)
        self.main = http.server.HTTPServer(("127.0.0.1", 0), _Target)
        self.main.other_port = self.other.server_port
        for srv in (self.main, self.other):
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            self.addCleanup(srv.server_close)
            self.addCleanup(srv.shutdown)
        import requests

        self.session = requests.Session()
        self.session.trust_env = False   # 127.0.0.1 must not go through the agent proxy
        self.url = f"http://127.0.0.1:{self.main.server_port}"
        self.key = f"{USER}/00000001-0000-4000-8000-000000000000/sample.webm"

    def test_a_redirect_is_not_followed_so_the_service_key_never_reaches_another_host(self):
        store = vw.VoiceStore(self.url, SERVICE_KEY, session=self.session)
        with self.assertRaises(RuntimeError) as ctx:
            store.claim("w")
        self.assertNotIn(SERVICE_KEY, str(ctx.exception))
        storage = vw.SampleStorage(self.url, SERVICE_KEY, session=self.session)
        with self.assertRaises(vw.StorageError) as sctx:
            storage.list_files(f"{USER}/00000001-0000-4000-8000-000000000000")
        self.assertEqual(sctx.exception.code, "redirect")
        self.assertEqual([p for p, _ in _Target.seen if p.startswith("/stolen")], [], "the redirect target was never asked")

    def test_the_download_really_stops_at_the_size_limit(self):
        _Target.big = b"\x00" * 3_000_000
        storage = vw.SampleStorage(self.url, SERVICE_KEY, session=self.session, max_bytes=100_000)
        with self.assertRaises(vw.StorageError) as ctx:
            storage.download(self.key)
        self.assertEqual(ctx.exception.code, "too_large", "by Content-Length, before reading")
        _Target.omit_length = True   # no Content-Length: only reading it can tell
        with self.assertRaises(vw.StorageError) as ctx2:
            storage.download(self.key)
        self.assertEqual(ctx2.exception.code, "too_large")

    def test_a_download_within_the_limit_arrives_whole_with_the_key_in_headers_only(self):
        _Target.big = WEBM
        data = vw.SampleStorage(self.url, SERVICE_KEY, session=self.session).download(self.key)
        self.assertEqual(data, WEBM)
        path, headers = _Target.seen[-1]
        self.assertEqual(headers["Authorization"], f"Bearer {SERVICE_KEY}")
        self.assertNotIn(SERVICE_KEY, path)

    def test_a_connection_that_cannot_be_made_is_a_network_error_without_the_text(self):
        storage = vw.SampleStorage("http://127.0.0.1:1", SERVICE_KEY, session=self.session, timeout=2)
        with self.assertRaises(vw.StorageError) as ctx:
            storage.download(self.key)
        self.assertEqual(ctx.exception.code, "network")
        self.assertNotIn("127.0.0.1", str(ctx.exception))


class Redirects(Harness):
    def test_a_redirect_from_supabase_storage_is_refused_by_the_worker_too(self):
        pid = self.ready()
        self.db.redirect_on = "/storage/v1/object/voice-samples/"
        out = self.w.run_once()
        self.assertEqual(out.result, "retry", "a storage error may pass: retried, sample kept")
        self.assertEqual(len(self.db.under(pid)), 1)
        self.assertEqual(self.tr.paths, [])
        self.assertNothingLeaks()

    def test_a_redirect_from_the_rpc_endpoint_claims_nothing(self):
        self.ready()
        self.db.redirect_on = "/rest/v1/rpc/claim_voice_job"
        self.assertIsNone(self.w.run_once())


class Hygiene(unittest.TestCase):
    def test_the_worker_reads_no_environment_but_the_switch(self):
        src = (ROOT / "modules" / "voice_worker.py").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"os\.environ[^\n]*", src), ["os.environ if env is None else env", "os.environ if env is None else env"])
        self.assertNotRegex(src, r"\bprint\(")

    def test_no_log_call_is_given_a_secret_a_phrase_a_sample_a_voice_id_or_a_body(self):
        import ast

        forbidden = {"data", "phrase", "voice_id", "provider_voice_id", "sample", "sample_path", "transcript", "resp", "response",
                     "key", "_key", "body", "text", "voice"}
        for rel in ("modules/voice_worker.py", "tools/voice_worker.py"):
            tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                        and node.func.value.id == "logger"):
                    self.assertNotIn(node.func.attr, ("exception",), f"{rel}:{node.lineno}: a traceback carries the message")
                    for arg in node.args[1:]:
                        names = {n.id for n in ast.walk(arg) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(arg) if isinstance(n, ast.Attribute)}
                        self.assertFalse(names & forbidden, f"{rel}:{node.lineno}: logs {sorted(names & forbidden)}")
                    self.assertFalse([k for k in node.keywords if k.arg == "exc_info"], f"{rel}:{node.lineno}")

    def test_the_new_adapter_method_is_marked_unverified_and_in_the_protocol(self):
        self.assertIn("UNVERIFIED", vp.ElevenLabsVoiceProvider.find_voices_by_name.__doc__)
        self.assertTrue(hasattr(vp.VoiceProvider, "find_voices_by_name") and hasattr(vp.VoiceProvider, "ensure_plan"))
        with self.assertRaises(ValueError):
            vp.ElevenLabsVoiceProvider(mock.Mock(), EL_KEY).find_voices_by_name("Rachel")

    def test_the_module_says_it_is_unverified_live(self):
        self.assertIn("UNVERIFIED", vw.__doc__)


if __name__ == "__main__":
    unittest.main()
