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
import io
import itertools
import json
import logging
import os
import re
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from shutil import which as shutil_which
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


def _make_wav(frames=1600, marker=b"DECODED-WAV-MARKER"):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((marker * ((frames * 2) // len(marker) + 1))[:frames * 2])
    return buf.getvalue()


WAV = _make_wav()
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
        self.labels = {}       # voice id -> labels (a voice put in `voices` by hand has none unless set here)
        self.list_labels = True  # does the listing carry labels, or only GET /voices/{id}?
        self._n = itertools.count(1)

    def _create(self, kw):
        vid = "Vx%018d" % next(self._n)
        self.voices[vid] = kw["data"]["name"]
        self.labels[vid] = json.loads(kw["data"]["labels"])
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
            return Resp(200, {"voices": [dict({"voice_id": v, "name": n}, **({"labels": self.labels.get(v, {})} if self.list_labels else {}))
                                         for v, n in self.voices.items()]})
        if method == "get" and path.startswith("/voices/") and path != "/voices/add":
            vid = path.rsplit("/", 1)[1]
            return Resp(200, {"voice_id": vid, "name": self.voices[vid], "labels": self.labels.get(vid, {})}) if vid in self.voices else Resp(404, {})
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


class Normaliser:
    """Stands in for ffmpeg_normalise: writes a real mono 16 kHz wav into the work directory and says how long it is."""

    def __init__(self, seconds=12.0, error=None):
        self.seconds = seconds
        self.error = error
        self.calls = []

    def __call__(self, src, sniffed, workdir):
        self.calls.append((Path(src).read_bytes(), sniffed))
        if self.error is not None:
            raise self.error
        out = Path(workdir) / "decoded.wav"
        out.write_bytes(WAV)
        return vw.Normalised(out, self.seconds)


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
        self.norm = Normaliser()
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
                              vp.ElevenLabsVoiceProvider(self.el, EL_KEY), worker_id=wid, transcribe=self.tr, normalise=self.norm,
                              env=env, sleep=self.sleeps.append, tmp_root=self.tmp.name)

    def again(self, worker=None):
        """The next claim of a parked job: its 30-minute lease has run out."""
        self.db.expire_leases()
        return (worker or self.w).run_once()

    def attempts(self, n, worker=None):
        outs = [(worker or self.w).run_once()]
        for _ in range(n - 1):
            outs.append(self.again(worker))
        return outs

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



# ── the decode: what ffmpeg is asked, and that a lying header changes nothing ─────────

class FakeTools:
    """A ``subprocess.run`` stand-in: ffprobe answers ``doc``; ffmpeg writes a mono 16 kHz wav of ``seconds`` seconds."""

    def __init__(self, doc=None, seconds=5.0, probe_rc=0, decode_rc=0, raises=None, wav_params=(1, 16000, 2)):
        self.doc = doc if doc is not None else {"streams": [{"codec_type": "audio"}], "format": {"duration": "5.0"}}
        self.seconds = seconds
        self.probe_rc, self.decode_rc, self.raises = probe_rc, decode_rc, raises
        self.wav_params = wav_params
        self.calls = []

    def __call__(self, argv, **kw):
        self.calls.append((list(argv), kw))
        if self.raises is not None:
            raise self.raises
        if Path(argv[0]).name == "ffprobe":
            return mock.Mock(returncode=self.probe_rc, stdout=json.dumps(self.doc))
        ch, rate, width = self.wav_params
        with wave.open(argv[-1], "wb") as w:   # written even when ffmpeg "fails": a failed run's file is not to be trusted
            w.setnchannels(ch)
            w.setsampwidth(width)
            w.setframerate(rate)
            w.writeframes(bytes(int(self.seconds * rate) * ch * width))
        return mock.Mock(returncode=self.decode_rc, stdout="")


def which_both(name):
    return f"/opt/ff/{name}"


class Decode(unittest.TestCase):
    SNIFF = vw.Sniffed("audio/ogg", "ogg")

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.work = Path(self.dir.name)
        self.src = self.work / "sample.ogg"
        self.src.write_bytes(b"OggS" + b"\x00" * 40)

    def normalise(self, tools, sniffed=None, which=which_both):
        return vw.ffmpeg_normalise(self.src, sniffed or self.SNIFF, self.work, run=tools, which=which)

    def test_streams_are_counted_and_cover_art_is_not_a_video(self):
        doc = {"streams": [{"codec_type": "audio"}, {"codec_type": "video", "disposition": {"attached_pic": 1}}, {"codec_type": "data"}]}
        self.assertEqual(vw.streams_from_ffprobe(doc), (1, 0))
        self.assertEqual(vw.streams_from_ffprobe({"streams": [{"codec_type": "audio"}, {"codec_type": "audio"}, {"codec_type": "video"}]}), (2, 1))
        self.assertEqual(vw.streams_from_ffprobe({}), (0, 0))
        with self.assertRaises(vw.AudioRefused):
            vw.streams_from_ffprobe([])

    def test_a_header_that_says_5_seconds_over_900_seconds_of_audio_is_refused_by_the_decoded_length(self):
        # The reviewer's case: an Ogg Opus file whose last page's granule position was patched, so the container reports 5 s.
        tools = FakeTools(doc={"streams": [{"codec_type": "audio"}], "format": {"duration": "5.08"}}, seconds=vw.MAX_DECODE_SECONDS)
        with self.assertRaises(vw.AudioRefused) as ctx:
            self.normalise(tools)
        self.assertEqual(ctx.exception.code, "sample_too_long")

    def test_the_decode_is_cut_and_bounded_and_runs_without_this_processs_secrets(self):
        env = {"SUPABASE_SERVICE_KEY": SERVICE_KEY, "ELEVENLABS_API_KEY": EL_KEY, "NIGHTSHIFT_VOICE_CLONING": "on", "PATH": "/x"}
        tools = FakeTools(seconds=4.0)
        with mock.patch.dict(os.environ, env):
            out = self.normalise(tools)
        self.assertEqual((out.seconds, out.path), (4.0, self.work / "decoded.wav"))
        self.assertEqual([Path(c[0][0]).name for c in tools.calls], ["ffprobe", "ffmpeg"])
        probe, decode = tools.calls[0][0], tools.calls[1][0]
        for argv in (probe, decode):
            self.assertEqual(argv[argv.index("-protocol_whitelist") + 1], "file")
            self.assertEqual(argv[argv.index("-f") + 1], "ogg", "the demuxer the bytes named, never auto-detected")
        self.assertEqual(decode[decode.index("-t") + 1], str(vw.MAX_DECODE_SECONDS), "the decode is cut: never an unbounded one")
        self.assertEqual(vw.MAX_DECODE_SECONDS, int(vw.MAX_SAMPLE_SECONDS) + 1)
        self.assertEqual(decode[decode.index("-map") + 1], "0:a:0", "only the first (and only) audio stream")
        self.assertEqual((decode[decode.index("-ac") + 1], decode[decode.index("-ar") + 1]), ("1", "16000"))
        self.assertIn("-fs", decode)
        self.assertLessEqual(int(decode[decode.index("-fs") + 1]), vw.MAX_WAV_BYTES)
        for argv, kw in tools.calls:
            self.assertEqual(set(kw["env"]), {"PATH", "HOME", "LANG", "LC_ALL"}, "an empty environment: no key of ours reaches a tool")
            for value in kw["env"].values():
                self.assertNotIn(SERVICE_KEY, value)
                self.assertNotIn(EL_KEY, value)
            self.assertTrue(kw["timeout"] and kw["timeout"] <= vw.DECODE_TIMEOUT_S)
            self.assertEqual(kw["cwd"], str(self.work))
            self.assertIs(kw["stdin"], subprocess_devnull())
            if os.name == "posix":
                self.assertIs(kw["preexec_fn"], vw._child_limits)
            self.assertNotIn(SERVICE_KEY + EL_KEY, " ".join(argv))

    def test_the_resource_limits_really_apply_to_the_child(self):
        import subprocess
        import resource

        if os.name != "posix":
            self.skipTest("rlimits are POSIX")
        out = subprocess.run([sys.executable, "-I", "-c", "import resource as r;print(r.getrlimit(r.RLIMIT_CPU)[0],r.getrlimit(r.RLIMIT_AS)[0],"
                              "r.getrlimit(r.RLIMIT_FSIZE)[0],r.getrlimit(r.RLIMIT_CORE)[0])"],
                             capture_output=True, text=True, preexec_fn=vw._child_limits, timeout=60)
        cpu, address_space, fsize, core = (int(x) for x in out.stdout.split())
        self.assertEqual((cpu, address_space, fsize, core), (120, 3 << 30, 2 * vw.MAX_WAV_BYTES, 0))
        self.assertNotEqual(resource.getrlimit(resource.RLIMIT_FSIZE)[0], 2 * vw.MAX_WAV_BYTES, "and not this process")

    def test_each_container_is_decoded_with_its_own_demuxer_only(self):
        for ext, demuxer in vw._DEMUXER.items():
            tools = FakeTools()
            self.normalise(tools, vw.Sniffed("audio/x", ext))
            self.assertEqual(tools.calls[1][0][tools.calls[1][0].index("-f") + 1], demuxer)
        self.assertEqual(vw._DEMUXER, {"webm": "matroska,webm", "ogg": "ogg", "flac": "flac", "wav": "wav", "m4a": "mov,mp4,m4a,3gp,3g2,mj2",
                                       "mp3": "mp3", "aac": "aac"}, "every type the sniffer can name, each with the one demuxer ffmpeg calls it")
        with self.assertRaises(vw.AudioRefused):
            self.normalise(FakeTools(), vw.Sniffed("audio/x", "m3u8"))

    def test_more_than_one_audio_stream_or_any_video_or_none_is_refused_before_a_decode(self):
        for streams in ([{"codec_type": "audio"}, {"codec_type": "audio"}], [{"codec_type": "audio"}, {"codec_type": "video"}],
                        [{"codec_type": "video"}], [], [{"codec_type": "subtitle"}]):
            with self.subTest(streams=streams):
                tools = FakeTools(doc={"streams": streams})
                with self.assertRaises(vw.AudioRefused) as ctx:
                    self.normalise(tools)
                self.assertEqual(ctx.exception.code, "not_audio")
                self.assertEqual(len(tools.calls), 1, "no decode was started")

    def test_a_file_the_tools_cannot_read_is_unreadable_and_a_missing_tool_is_the_machines_fault(self):
        for kw, code in ((dict(probe_rc=1), "unreadable_audio"), (dict(decode_rc=1), "unreadable_audio"),
                         (dict(raises=__import__("subprocess").TimeoutExpired("ffmpeg", 1)), "unreadable_audio"),
                         (dict(doc={"streams": "oops"}), "not_audio")):
            with self.subTest(kw=list(kw)):
                with self.assertRaises(vw.AudioRefused) as ctx:
                    self.normalise(FakeTools(**kw))
                self.assertEqual(ctx.exception.code, code)
        with self.assertRaises(vw.AudioToolError):
            self.normalise(FakeTools(raises=FileNotFoundError("ffmpeg")))
        with self.assertRaises(vw.AudioToolError):
            self.normalise(FakeTools(), which=lambda name: None)
        with self.assertRaises(vw.AudioToolError):
            self.normalise(FakeTools(), which=lambda name: "/x/ffmpeg" if name == "ffmpeg" else None)

    def test_ffprobe_that_prints_something_else_is_unreadable(self):
        tools = FakeTools()
        bad = lambda argv, **kw: mock.Mock(returncode=0, stdout="not json at all")
        with self.assertRaises(vw.AudioRefused) as ctx:
            self.normalise(bad)
        self.assertEqual(ctx.exception.code, "unreadable_audio")

    def test_the_decoded_wav_is_measured_from_its_own_frames_and_must_be_what_was_asked_for(self):
        def wav(name, seconds=1.0, params=(1, 16000, 2)):
            path = self.work / name
            ch, rate, width = params
            with wave.open(str(path), "wb") as w:
                w.setnchannels(ch)
                w.setsampwidth(width)
                w.setframerate(rate)
                w.writeframes(bytes(int(seconds * rate) * ch * width))
            return path

        self.assertEqual(vw.measure_wav(wav("a.wav", 2.5)).seconds, 2.5)
        self.assertEqual(vw.measure_wav(wav("b.wav", vw.MAX_SAMPLE_SECONDS)).seconds, vw.MAX_SAMPLE_SECONDS)
        with self.assertRaises(vw.AudioRefused) as over:
            vw.measure_wav(wav("c.wav", vw.MAX_SAMPLE_SECONDS + 0.5))
        self.assertEqual(over.exception.code, "sample_too_long")
        for name, params in (("stereo", (2, 16000, 2)), ("rate", (1, 44100, 2)), ("8bit", (1, 16000, 1))):
            with self.subTest(name=name), self.assertRaises(vw.AudioRefused) as ctx:
                vw.measure_wav(wav(name + ".wav", 1.0, params))
            self.assertEqual(ctx.exception.code, "unreadable_audio")
        (self.work / "junk.wav").write_bytes(b"RIFFnot a wav")
        (self.work / "empty.wav").write_bytes(b"")
        for name in ("junk.wav", "empty.wav", "missing.wav"):
            with self.subTest(name=name), self.assertRaises(vw.AudioRefused) as ctx:
                vw.measure_wav(self.work / name)
            self.assertEqual(ctx.exception.code, "unreadable_audio")
        with self.assertRaises(vw.AudioRefused) as zero:
            vw.measure_wav(wav("zero.wav", 0.0))
        self.assertEqual(zero.exception.code, "unreadable_audio")
        big = self.work / "big.wav"
        big.write_bytes(b"\x00" * (vw.MAX_WAV_BYTES + 1))
        with self.assertRaises(vw.AudioRefused) as huge:
            vw.measure_wav(big)
        self.assertEqual(huge.exception.code, "sample_too_long", "the decoded size is capped before it is even opened")


def subprocess_devnull():
    import subprocess

    return subprocess.DEVNULL


def _ogg_with_a_lying_end(path_in, path_out, seconds):
    """Patch the granule position of the last Ogg page (and its CRC) so the container reports ``seconds`` of audio."""
    import struct

    table = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else (r << 1)
            r &= 0xFFFFFFFF
        table.append(r)

    def crc(data):
        c = 0
        for b in data:
            c = ((c << 8) & 0xFFFFFFFF) ^ table[((c >> 24) & 0xFF) ^ b]
        return c

    d = bytearray(Path(path_in).read_bytes())
    i = d.rfind(b"OggS")
    n = d[i + 26]
    length = 27 + n + sum(d[i + 27:i + 27 + n])
    struct.pack_into("<q", d, i + 6, int(seconds * 48000) + 3840)
    d[i + 22:i + 26] = b"\0\0\0\0"
    struct.pack_into("<I", d, i + 22, crc(bytes(d[i:i + length])))
    Path(path_out).write_bytes(d)


@unittest.skipUnless(shutil_which("ffmpeg") and shutil_which("ffprobe"), "needs ffmpeg and ffprobe on PATH")
class DecodeWithTheRealTools(unittest.TestCase):
    """The real ffmpeg and ffprobe, when the machine has them (the worker image does: Dockerfile.worker)."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.work = Path(self.dir.name)

    def make(self, name, *args):
        import subprocess

        out = self.work / name
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", *args, str(out)], check=True, timeout=120)
        return out

    def test_a_long_file_whose_header_says_five_seconds_is_refused_and_a_short_one_passes(self):
        long_ = self.make("long.ogg", "-f", "lavfi", "-i", "sine=frequency=300:duration=330:sample_rate=48000", "-c:a", "libopus", "-b:a", "8k")
        lie = self.work / "lie.ogg"
        _ogg_with_a_lying_end(long_, lie, 5)
        with self.assertRaises(vw.AudioRefused) as ctx:
            vw.ffmpeg_normalise(lie, vw.Sniffed("audio/ogg", "ogg"), self.work)
        self.assertEqual(ctx.exception.code, "sample_too_long")
        short = self.make("short.wav", "-f", "lavfi", "-i", "sine=frequency=300:duration=3:sample_rate=44100", "-ac", "2")
        out = vw.ffmpeg_normalise(short, vw.Sniffed("audio/wav", "wav"), self.work)
        self.assertAlmostEqual(out.seconds, 3.0, delta=0.1)

    def test_two_audio_streams_are_refused(self):
        two = self.make("two.mkv", "-f", "lavfi", "-i", "sine=duration=2", "-f", "lavfi", "-i", "sine=f=900:duration=2", "-map", "0", "-map", "1", "-c:a", "flac")
        with self.assertRaises(vw.AudioRefused) as ctx:
            vw.ffmpeg_normalise(two, vw.Sniffed("audio/webm", "webm"), self.work)
        self.assertEqual(ctx.exception.code, "not_audio")


class Whisper(unittest.TestCase):
    def test_the_default_transcriber_gives_whisper_our_decoded_samples_not_a_path_and_fixes_the_language(self):
        import numpy as np

        model = mock.Mock()
        model.transcribe.return_value = {"text": " apple river "}
        fake_whisper = mock.Mock()
        fake_whisper.load_model.return_value = model
        fake_subs = mock.Mock(WHISPER_MODEL="base")
        with tempfile.TemporaryDirectory() as d:
            wav = Path(d) / "decoded.wav"
            wav.write_bytes(WAV)
            with mock.patch.dict(sys.modules, {"whisper": fake_whisper, "modules.subtitle_generator": fake_subs}):
                self.assertEqual(vw.whisper_transcriber()(wav), " apple river ")
        fake_whisper.load_model.assert_called_once_with("base")
        audio = model.transcribe.call_args.args[0]
        self.assertIsInstance(audio, np.ndarray)
        self.assertEqual((audio.dtype, len(audio)), (np.float32, 1600))
        self.assertLessEqual(float(abs(audio).max()), 1.0)
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "en")
        src = (ROOT / "modules" / "subtitle_generator.py").read_text(encoding="utf-8")
        self.assertRegex(src, r'(?m)^WHISPER_MODEL = "')


class StaleWorkdirs(unittest.TestCase):
    def test_a_killed_workers_leftovers_are_removed_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as root:
            r = Path(root)
            old, young, afile, other = r / "nsvoice-old", r / "nsvoice-young", r / "nsvoice-file", r / "other-old"
            for d in (old, young, other):
                d.mkdir()
                (d / "sample.webm").write_bytes(b"x")
            afile.write_bytes(b"x")
            (r / "nsvoice-link").symlink_to(other)
            long_ago = 1_000_000_000
            for p in (old, other, afile):
                os.utime(p, (long_ago, long_ago))
            os.utime(r / "nsvoice-link", (long_ago, long_ago), follow_symlinks=False)
            self.assertEqual(vw.sweep_stale_workdirs(root, older_than_s=3600), 1)
            self.assertFalse(old.exists())
            for kept in (young, afile, other, r / "nsvoice-link"):
                self.assertTrue(os.path.lexists(kept), f"{kept.name} must stay")
            self.assertTrue((other / "sample.webm").exists(), "the target of a symlink is never followed")
            self.assertEqual(vw.sweep_stale_workdirs(str(r / "nope")), 0)

    def test_the_command_line_sweeps_on_start(self):
        from tools import voice_worker as cli

        env = {"NIGHTSHIFT_VOICE_CLONING": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k"}
        worker = mock.Mock()
        worker.run_once.return_value = None
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(vw, "VoiceWorker", return_value=worker), \
                mock.patch.object(vw, "whisper_transcriber", return_value=lambda p: ""), mock.patch.object(cli.signal, "signal"), \
                mock.patch.object(vw, "sweep_stale_workdirs") as sweep:
            self.assertEqual(cli.main(["--once"]), 0)
        sweep.assert_called_once_with()


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
        for missing in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
            env = {k: v for k, v in base.items() if k != missing}
            with self.subTest(missing=missing), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(vw, "VoiceWorker", side_effect=AssertionError("started without " + missing)):
                self.assertEqual(cli.main(["--once"]), 2)

    def test_without_the_elevenlabs_key_the_command_line_still_runs_but_with_no_provider(self):
        from tools import voice_worker as cli

        env = {"NIGHTSHIFT_VOICE_CLONING": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k"}
        worker = mock.Mock()
        worker.run_once.return_value = None
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(vw, "VoiceWorker", return_value=worker) as made, \
                mock.patch.object(vw, "whisper_transcriber", return_value=lambda p: ""), mock.patch.object(cli.signal, "signal"):
            self.assertEqual(cli.main(["--once"]), 0)
        self.assertIsNone(made.call_args.args[2], "no provider: purge_sample can still be carried out")
        worker.run_once.assert_called_once_with()

    def test_the_loop_waits_only_when_there_was_nothing_to_do(self):
        from tools import voice_worker as cli

        waits = []

        class Stop:
            def __init__(self):
                self.flag = False

            def is_set(self):
                return self.flag

            def set(self):
                self.flag = True

            def wait(self, seconds=None):
                waits.append(seconds)
                self.flag = True

        env = {"NIGHTSHIFT_VOICE_CLONING": "on", "SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_KEY": "k"}
        worker = mock.Mock()
        worker.run_once.side_effect = [vw.Outcome("clone", "parked", "x", 1), None]
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(vw, "VoiceWorker", return_value=worker), \
                mock.patch.object(vw, "whisper_transcriber", return_value=lambda p: ""), mock.patch.object(cli.signal, "signal"), \
                mock.patch.object(cli.threading, "Event", Stop), mock.patch.object(vw, "sweep_stale_workdirs"):
            self.assertEqual(cli.main([]), 0)
        self.assertEqual(worker.run_once.call_count, 2, "work found: look again at once")
        self.assertEqual(waits, [cli.POLL_SECONDS], "nothing found: wait")

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
        self.assertEqual(create["files"]["files"][0], "sample.wav")
        self.assertEqual(create["files"]["files"][2], "audio/wav")
        self.assertEqual(create["files"]["files"][1], WAV, "the provider gets the capped, normalised wav, never the upload")
        self.assertNotIn(MARKER, create["files"]["files"][1])
        self.assertNotIn("Mine", str(create["data"]), "the user's own words never reach the provider")
        self.assertEqual(self.tr.seen, [WAV], "Whisper heard the same decoded wav")
        self.assertEqual(self.norm.calls[0][0], WEBM, "and the decode was of the real upload")
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
        self.assertEqual((self.tr.paths, self.norm.calls, self.el.posts()), ([], [], []), "nothing was decoded, transcribed or sent")
        self.assertEqual(self.db.under(pid), [])
        self.assertNothingLeaks()

    def test_the_decode_is_told_the_sniffed_type_not_the_one_in_the_name(self):
        pid = self.db.request_clone()
        ogg = b"OggS" + b"\x00" * 40 + MARKER
        self.db.upload(pid, ogg, name="sample.webm")   # called webm, is ogg
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertEqual(self.norm.calls[0], (ogg, vw.Sniffed("audio/ogg", "ogg")))

    def test_an_object_that_vanished_or_a_storage_error_is_told_apart(self):
        real = self.db._route
        for answer, expect in ((Resp(404), ("rejected", "sample_missing")), (Resp(400, {"statusCode": "404"}), ("rejected", "sample_missing")),
                               (Resp(400, {"statusCode": "403"}), ("parked", "storage_error")), (Resp(500), ("parked", "storage_error"))):
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

    def test_a_recording_the_decode_refuses_is_rejected_with_its_word_and_nothing_else_happens(self):
        for word in ("not_audio", "unreadable_audio", "sample_too_long"):
            with self.subTest(word=word):
                self.setUp()
                self.norm.error = vw.AudioRefused(word)
                pid = self.ready()
                out = self.w.run_once()
                self.assertEqual((out.result, out.code), ("rejected", word))
                self.assertEqual(self.profile(pid)["reject_reason"], word)
                self.assertEqual((self.tr.paths, self.el.posts(), self.db.under(pid)), ([], [], []))
                self.assertNothingLeaks()

    def test_a_machine_without_working_audio_tools_parks_the_job_it_does_not_reject_the_person(self):
        self.norm.error = vw.AudioToolError("ffmpeg is not installed")
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("parked", "audio_tool_error"))
        self.assertEqual(len(self.db.under(pid)), 1, "the recording is kept")
        self.assertEqual(self.profile(pid)["status"], "pending_verification")
        self.norm.error = None
        self.assertEqual(self.again().result, "cloned", "and it is cloned when the tools are back")

    def test_the_provider_and_whisper_get_the_decoded_wav_whatever_the_upload_claimed(self):
        # The upload may state any length; the decoded copy is what everything after the decode sees.
        self.norm.seconds = 7.5
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertEqual(self.tr.seen, [WAV])
        self.assertEqual(self.el.posts()[0][2]["files"]["files"][1], WAV)

    def test_a_transcription_that_never_ends_is_cut_off_and_parked(self):
        import time as _time

        pid = self.ready()
        w = self.worker("w1")
        w._transcribe_timeout = 0.2
        w.transcribe = lambda path: _time.sleep(5) or PHRASE
        started = _time.monotonic()
        out = w.run_once()
        self.assertLess(_time.monotonic() - started, 3)
        self.assertEqual((out.result, out.code), ("parked", "transcribe_timeout"))
        self.assertEqual(self.el.posts(), [])
        self.assertEqual(len(self.db.under(pid)), 1)

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

    def test_a_transcriber_that_fails_is_parked_twice_and_then_ended_with_its_own_word(self):
        self.tr.text = RuntimeError("whisper blew up: " + BODY_SECRET)
        pid = self.ready()
        results = self.attempts(3)
        self.assertEqual([r.result for r in results], ["parked", "parked", "rejected"])
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
        w = vw.VoiceWorker(store, storage, mock.Mock(), worker_id="w", transcribe=self.tr, normalise=self.norm, env=ON)
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
    def test_the_free_plan_ends_every_clone_at_once_as_provider_not_enabled_with_nothing_spent(self):
        self.el.plan = False   # the subscription says, in so many words, that instant cloning is not allowed
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("rejected", "provider_not_enabled"))
        p = self.profile(pid)
        self.assertEqual((p["status"], p["reject_reason"], p["voice_id"]), ("rejected", "provider_not_enabled", None))
        self.assertEqual([(m, path) for m, path, _ in self.el.calls], [("get", "/user/subscription")],
                         "one read-only plan probe and nothing else: no lookup, no create, nothing spent")
        self.assertFalse([c for c in self.db.calls if c[0] == "get"], "the sample was not even fetched")
        self.assertEqual(self.tr.paths, [])
        self.assertEqual(self.db.job(pid, "clone")["attempts"], 1, "a verdict, not a retry")
        self.assertEqual(self.db.under(pid), [], "and our copy is purged")
        self.assertEqual([o.result for o in self.run_all()], ["purged"])
        self.assertNothingLeaks()

    def test_a_subscription_that_says_nothing_is_not_a_verdict_it_is_parked_and_the_recording_kept(self):
        for answer in (None, "missing"):
            with self.subTest(answer=answer):
                self.setUp()
                self.el.plan = None   # no can_use_instant_voice_cloning field at all
                pid = self.ready()
                out = self.w.run_once()
                self.assertEqual((out.result, out.code), ("parked", "provider_plan_unknown"))
                self.assertEqual(self.profile(pid)["status"], "pending_verification", "not rejected")
                self.assertEqual(len(self.db.under(pid)), 1, "the recording is still there")
                self.assertEqual(self.el.posts(), [])
                self.assertEqual(self.db.job(pid, "clone")["status"], "running", "left to its lease")

    def test_a_non_boolean_flag_is_the_same_as_none(self):
        self.el.script["get:/user/subscription"] = [Resp(200, {"can_use_instant_voice_cloning": "true"})]
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("parked", "provider_plan_unknown"))
        self.assertEqual(self.el.posts(), [])

    def test_a_plan_that_stays_unknown_ends_with_its_own_word_only_on_the_last_claim(self):
        self.el.plan = None
        pid = self.ready()
        outs = self.attempts(3)
        self.assertEqual([o.result for o in outs], ["parked", "parked", "rejected"])
        self.assertEqual(self.profile(pid)["reject_reason"], "provider_plan_unknown")
        self.assertEqual(self.db.under(pid), [])

    def test_when_the_operator_fixes_the_plan_in_time_the_parked_job_is_cloned(self):
        self.el.plan = None
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "parked")
        self.el.plan = True
        self.assertEqual(self.again().result, "cloned")
        self.assertEqual(self.profile(pid)["status"], "testing")

    def test_a_bad_key_on_the_plan_probe_is_parked_not_a_verdict(self):
        self.el.script["get:/user/subscription"] = [Resp(401, {"detail": {"status": "invalid_api_key", "message": BODY_SECRET}})]
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("parked", "provider_auth"))
        self.assertEqual(len(self.db.under(pid)), 1)
        self.assertNothingLeaks()

    def test_a_deletion_never_needs_the_plan(self):
        self.el.plan = False
        pid = self.db.request_clone()
        self.profile(pid).update(status="testing", provider="elevenlabs", voice_id="AbCdEfGhIjKlMnOpQrSt", sample_state="purged")
        self.el.voices["AbCdEfGhIjKlMnOpQrSt"] = "x"
        self.db.owner_deletes(pid)
        self.assertEqual([(o.kind, o.result) for o in self.run_all()], [("delete_provider", "deleted")])
        self.assertEqual(self.el.voices, {})
        self.assertNotIn("/user/subscription", [path for _, path, _ in self.el.calls])

    def test_the_plan_probe_failing_in_every_way_is_never_a_yes(self):
        for answer in (Resp(500), Resp(403, {"detail": "x"}), Resp(200, None), Resp(200, ["not", "an", "object"])):
            with self.subTest(status=answer.status_code):
                self.setUp()
                self.el.script["get:/user/subscription"] = [answer]
                pid = self.ready()
                self.assertEqual(self.w.run_once().result, "parked")
                self.assertEqual((self.el.posts(), self.tr.paths), ([], []))


# ── the provider ─────────────────────────────────────────────────────────────

class Provider(Harness):
    def only(self, key, *answers):
        self.el.script[key] = list(answers)

    def job_attempts(self, pid):
        return self.db.job(pid, "clone")["attempts"]

    def test_the_persons_own_faults_end_it_at_once_with_a_closed_word(self):
        # A 422 from the provider says the recording was refused; a 400 is an answer that will not change.
        for answer, word in ((Resp(422, {"detail": BODY_SECRET}), "provider_rejected"), (Resp(400, {"detail": BODY_SECRET}), "provider_error")):
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

    def test_the_operators_faults_are_parked_and_only_the_last_claim_rejects(self):
        # A key, the account, an outage: not the person's doing, so their recording is not burned on the first try.
        cases = [
            (Resp(401, {"detail": {"status": "invalid_api_key", "message": BODY_SECRET}}), "provider_auth"),
            (Resp(401, {"detail": {"status": "can_not_use_instant_voice_cloning", "message": BODY_SECRET}}), "provider_not_enabled"),
            (Resp(500, {"detail": BODY_SECRET}), "provider_unavailable"),
            (Resp(503), "provider_unavailable"),
            (Resp(429), "provider_unavailable"),
            (Resp(302, headers={"Location": "https://evil.example/"}), "provider_redirect"),
        ]
        for answer, word in cases:
            with self.subTest(word=word, status=answer.status_code):
                self.setUp()
                self.only("post:/voices/add", answer, answer, answer)
                pid = self.ready()
                outs = self.attempts(3)
                self.assertEqual([o.result for o in outs], ["parked", "parked", "rejected"])
                self.assertEqual([o.code for o in outs], [word] * 3)
                self.assertEqual(self.profile(pid)["reject_reason"], word)
                self.assertEqual(self.job_attempts(pid), 3)
                self.assertEqual(self.db.under(pid), [], "kept between claims, gone at the end")
                self.assertEqual(self.el.voices, {}, "nothing was created")
                self.assertNothingLeaks()

    def test_a_parked_clone_is_not_answered_so_the_profile_and_the_recording_are_untouched(self):
        self.only("post:/voices/add", Resp(503))
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual(out.result, "parked")
        self.assertEqual(len(self.db.under(pid)), 1)
        self.assertEqual(self.profile(pid)["status"], "pending_verification")
        self.assertEqual(self.db.job(pid, "clone")["status"], "running")
        self.assertIsNone(self.w.run_once(), "nothing to claim until the lease runs out")
        self.assertEqual(self.again().result, "cloned", "and then it is cloned")
        self.assertEqual(self.db.under(pid), [])

    def test_an_error_from_the_provider_never_carries_its_body_into_the_database_or_the_log(self):
        self.only("post:/voices/add", Resp(422, {"detail": {"status": "x_" + BODY_SECRET.lower().replace("-", "_"), "message": BODY_SECRET}}))
        pid = self.ready()
        self.w.run_once()
        stored = " ".join(str(v) for v in self.profile(pid).values()) + " ".join(str(j["error"]) for j in self.db.jobs)
        self.assertNotIn(BODY_SECRET, stored)
        self.assertNothingLeaks()

    def test_a_timeout_on_the_plan_probe_is_parked_and_spends_nothing(self):
        self.only("get:/user/subscription", TimeoutError("slow " + BODY_SECRET))
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "parked")
        self.assertEqual(self.el.posts(), [])
        self.assertEqual(self.again().result, "cloned")

    def test_a_timeout_after_the_voice_was_made_is_adopted_not_made_twice(self):
        # The nasty one: the provider did the work and the answer never arrived.
        self.only("post:/voices/add", ("made", TimeoutError("read timed out " + BODY_SECRET)))
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "parked")
        self.assertEqual(len(self.el.voices), 1)
        out = self.again()
        self.assertEqual(out.result, "cloned")
        self.assertEqual(len(self.el.voices), 1, "the second attempt found the voice by its labels")
        self.assertEqual(len(self.el.posts()), 1, "and did not create another")
        self.assertEqual(self.profile(pid)["voice_id"], list(self.el.voices)[0])
        self.assertNothingLeaks()

    def test_a_create_that_returns_no_usable_id_is_adopted_on_the_next_attempt(self):
        self.only("post:/voices/add", ("made", Resp(200, {"nope": 1})))
        pid = self.ready()
        self.assertEqual(self.w.run_once().result, "parked", "maybe created: look before creating again")
        self.assertEqual(self.again().result, "cloned")
        self.assertEqual((len(self.el.voices), len(self.el.posts())), (1, 1))

    def test_an_http_answer_the_adapter_does_not_know_is_not_retried(self):
        self.only("post:/voices/add", Resp(402, {"detail": BODY_SECRET}))
        pid = self.ready()
        self.assertEqual((self.w.run_once().result, self.job_attempts(pid)), ("rejected", 1))
        self.assertEqual(self.profile(pid)["reject_reason"], "provider_error")

    def test_a_redirect_from_the_provider_is_never_followed(self):
        self.only("post:/voices/add", Resp(302, headers={"Location": "https://evil.example/"}))
        pid = self.ready()
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("parked", "provider_redirect"))
        self.assertEqual([c for c in self.el.calls if "evil" in c[1]], [])
        self.assertNothingLeaks()

    def test_a_possibly_created_voice_is_removed_when_the_clone_ends_for_good(self):
        # The last claim creates the voice and then loses the answer: the profile is rejected, and a clone of a person's voice
        # must not be left in the provider account.
        self.only("post:/voices/add", Resp(503), Resp(503), ("made", ConnectionError(BODY_SECRET)))
        pid = self.ready()
        outs = self.attempts(3)
        self.assertEqual([o.result for o in outs], ["parked", "parked", "rejected"])
        self.assertEqual(self.profile(pid)["reject_reason"], "provider_unavailable")
        self.assertEqual(self.el.voices, {}, "the voice that may have been created was deleted")
        self.assertNothingLeaks()

    def test_a_voice_labelled_for_this_profile_is_adopted_and_its_duplicates_removed(self):
        pid = self.ready()
        name = vp.provider_voice_name("ab" * 16, pid)
        mine = {"nightshift_profile": pid, "nightshift_owner_ref": "ab" * 16}
        self.el.voices.update({"A" * 20: name, "B" * 20: name, "C" * 20: "someone elses"})
        self.el.labels.update({"A" * 20: dict(mine), "B" * 20: dict(mine), "C" * 20: {}})
        self.assertEqual(self.w.run_once().result, "cloned")
        self.assertEqual(self.profile(pid)["voice_id"], "A" * 20)
        self.assertEqual(sorted(self.el.voices), ["A" * 20, "C" * 20], "the duplicate of OUR labelled voice went; a stranger's is untouched")
        self.assertEqual(self.el.posts(), [])

    def test_a_voice_with_our_name_but_another_profiles_label_is_never_adopted_or_deleted(self):
        pid = self.ready()
        name = vp.provider_voice_name("ab" * 16, pid)
        other = "99999999-0000-4000-8000-000000000000"
        for labels in ({"nightshift_profile": other, "nightshift_owner_ref": "ab" * 16},
                       {"nightshift_profile": pid[:8], "nightshift_owner_ref": "ab" * 16},      # only the 8 hex of the id
                       {"nightshift_profile": pid, "nightshift_owner_ref": "cd" * 16},          # another owner
                       {"nightshift_profile": pid}, {}):
            with self.subTest(labels=labels):
                self.setUp()
                pid = self.ready()
                name = vp.provider_voice_name("ab" * 16, pid)
                labels = {k: (pid if v == "PID" else v) for k, v in labels.items()}
                self.el.voices["Z" * 20] = name
                self.el.labels["Z" * 20] = {k: (pid if k == "nightshift_profile" and v == "FULL" else v) for k, v in labels.items()}
                out = self.w.run_once()
                self.assertEqual((out.result, out.code), ("rejected", "provider_conflict"))
                self.assertEqual(list(self.el.voices), ["Z" * 20], "not deleted")
                self.assertEqual(self.el.posts(), [], "not duplicated either")
                self.assertIsNone(self.profile(pid)["voice_id"], "and not recorded as this profile's")

    def test_the_labels_are_read_by_id_when_the_listing_carries_none(self):
        self.el.list_labels = False
        pid = self.ready()
        self.only("post:/voices/add", ("made", TimeoutError()))
        self.assertEqual(self.w.run_once().result, "parked")
        self.assertEqual(self.again().result, "cloned")
        self.assertEqual((len(self.el.voices), len(self.el.posts())), (1, 1))
        self.assertIn(("get", "/voices/" + list(self.el.voices)[0]), [(m, p) for m, p, _ in self.el.calls])

    def test_a_voice_the_database_says_is_another_profiles_is_not_deleted(self):
        # The service key cannot read other profiles; the database's UNIQUE (provider, voice id) is the check, and it said no.
        pid = self.ready()
        other = self.db.request_clone()
        self.profile(other).update(status="testing", provider="elevenlabs", voice_id="Vx" + "0" * 18, sample_state="purged")
        self.db.jobs[:] = [j for j in self.db.jobs if j["profile"] == pid]
        name = vp.provider_voice_name("ab" * 16, pid)
        self.el.voices["Vx" + "0" * 18] = name
        self.el.labels["Vx" + "0" * 18] = {"nightshift_profile": pid, "nightshift_owner_ref": "ab" * 16}
        out = self.w.run_once()
        self.assertEqual((out.result, out.code), ("unrecorded", "voice_id_taken"))
        self.assertIn("Vx" + "0" * 18, self.el.voices, "nothing deleted")
        self.assertEqual(len(self.db.under(pid)), 1, "the recording is kept")
        self.assertIn("another profile", " ".join(self.logs.lines))

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

    def test_without_a_provider_a_clone_is_parked_and_nothing_is_fetched(self):
        pid = self.ready()
        w = self.worker("w1")
        w.provider = None
        out = w.run_once()
        self.assertEqual((out.result, out.code), ("parked", "provider_not_configured"))
        self.assertFalse([c for c in self.db.calls if c[0] == "get"])
        self.assertEqual(len(self.db.under(pid)), 1)
        outs = self.attempts(2, w)[1:]
        self.assertEqual(outs[0].result, "parked")
        self.assertEqual(self.again(w).result, "rejected", "the third claim says the specific word")
        self.assertEqual(self.profile(pid)["reject_reason"], "provider_not_configured")


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

    def rejected_with_purge(self):
        pid = self.db.request_clone()
        other = self.db.request_clone()
        self.profile(pid).update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = [j for j in self.db.jobs if j["profile"] == other]
        self.db._add_job(pid, "purge_sample")
        return pid, other

    def mine(self, pid):
        return {"nightshift_profile": pid, "nightshift_owner_ref": "ab" * 16}

    def test_the_orphan_sweep_only_touches_voices_labelled_for_that_profile(self):
        pid, other = self.rejected_with_purge()
        self.el.voices.update({"A" * 20: vp.provider_voice_name("ab" * 16, pid), "B" * 20: vp.provider_voice_name("ab" * 16, other),
                               "C" * 20: "Rachel", "D" * 20: vp.provider_voice_name("ab" * 16, pid)})
        self.el.labels.update({"A" * 20: self.mine(pid), "B" * 20: self.mine(other), "C" * 20: {},
                               "D" * 20: {"nightshift_profile": other, "nightshift_owner_ref": "ab" * 16}})   # our name, someone else's label
        self.assertEqual([o.result for o in self.run_all()], ["purged"])
        self.assertEqual(sorted(self.el.voices), ["B" * 20, "C" * 20, "D" * 20])

    def test_the_orphan_sweep_does_not_run_for_a_profile_that_may_have_a_clone_in_flight(self):
        for status in ("deleted", "pending_verification", "testing"):
            with self.subTest(status=status):
                self.setUp()
                pid, other = self.rejected_with_purge()
                self.profile(pid)["status"] = status
                self.el.voices["A" * 20] = vp.provider_voice_name("ab" * 16, pid)
                self.el.labels["A" * 20] = self.mine(pid)
                self.assertEqual([o.result for o in self.run_all()], ["purged"])
                self.assertIn("A" * 20, self.el.voices, "a clone being made must not lose its voice to a purge")
                self.assertNotIn("/voices", [p for _, p, _ in self.el.calls], "and the provider was not even listed")

    def test_the_orphan_sweep_is_skipped_when_the_profile_already_has_a_recorded_voice(self):
        pid, other = self.rejected_with_purge()
        self.profile(pid)["voice_id"] = "Vx" + "9" * 18
        self.profile(pid)["provider"] = "elevenlabs"
        self.el.voices["A" * 20] = vp.provider_voice_name("ab" * 16, pid)
        self.el.labels["A" * 20] = self.mine(pid)
        self.run_all()
        self.assertIn("A" * 20, self.el.voices)

    def test_a_worker_that_lost_its_lease_or_could_not_record_does_not_delete_the_voice_another_may_have_adopted(self):
        for how in ("lost", "unrecorded"):
            with self.subTest(how=how):
                self.setUp()
                pid = self.ready()
                self.db.job(pid, "clone")["attempts"] = 2   # this is the last claim: the answer is final
                self.only_create_then_fail()
                if how == "lost":
                    real = self.db._finish_clone
                    self.db._finish_clone = lambda a: {"ok": False, "error": "not_holder"}
                else:
                    self.db.rpc_failures["finish_voice_clone"] = [ConnectionError()] * 3
                out = self.w.run_once()
                self.assertEqual(out.result, how)
                self.assertEqual(len(self.el.voices), 1, "the voice the other worker may have adopted is still there")
                self.assertEqual(len(self.db.under(pid)), 1, "and so is the recording: nothing was accepted")

    def only_create_then_fail(self):
        self.el.script["post:/voices/add"] = [("made", ConnectionError(BODY_SECRET))]

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

    def test_an_unforeseen_exception_parks_the_job_and_the_last_claim_answers_worker_error(self):
        pid = self.ready()
        with mock.patch.object(vw.VoiceWorker, "_clone", side_effect=ValueError("boom " + BODY_SECRET)):
            outs = self.attempts(3)
        self.assertEqual([o.result for o in outs], ["parked", "parked", "rejected"])
        self.assertEqual(self.profile(pid)["reject_reason"], "worker_error")
        self.assertEqual(self.db.under(pid), [])
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

    def test_a_failing_provider_delete_is_parked_for_its_leases_and_then_reported_overdue(self):
        pid = self.voiced()
        self.db.owner_deletes(pid)
        self.el.script["delete:/voices/{id}"] = [Resp(500, {"detail": BODY_SECRET}), Resp(503), Resp(500)]
        first = self.w.run_once()
        self.assertEqual((first.result, first.code), ("parked", "provider_unavailable"))
        self.assertEqual(self.db.job(pid, "delete_provider")["status"], "running", "not answered: the lease brings it back, not a 3-attempt sprint")
        self.assertIsNone(self.w.run_once(), "it is not retried a second later")
        self.assertEqual(self.again().result, "parked")
        last = self.again()
        self.assertEqual((last.result, last.code), ("failed", "provider_unavailable"))
        self.assertEqual(self.db.job(pid, "delete_provider")["status"], "failed")
        self.assertEqual(self.db.job(pid, "delete_provider")["error"], "provider_unavailable")
        self.assertIn("AbCdEfGhIjKlMnOpQrSt", self.el.voices, "and the voice is still there to be found, not forgotten")
        overdue = [l for l in self.logs.lines if "OVERDUE" in l]
        self.assertEqual(len(overdue), 1)
        self.assertIn("delete_provider", overdue[0])
        self.assertNothingLeaks()

    def test_a_delete_job_without_a_voice_id_is_never_answered_ok(self):
        pid = self.db.request_clone()
        self.db._add_job(pid, "delete_provider")
        self.db.jobs[:] = [j for j in self.db.jobs if j["kind"] != "clone"]
        outs = self.attempts(3)
        self.assertEqual([o.result for o in outs], ["parked", "parked", "failed"])
        self.assertEqual(self.el.calls, [])
        self.assertEqual(self.db.job(pid, "delete_provider")["error"], "no_voice_id")

    def test_a_provider_that_says_the_voice_is_not_gone_is_not_believed(self):
        pid = self.voiced()
        self.db.owner_deletes(pid)
        self.w.provider = mock.Mock()
        self.w.provider.delete_voice.return_value = False
        outs = self.attempts(3)
        self.assertEqual([o.result for o in outs], ["parked", "parked", "failed"])
        self.assertEqual(self.db.job(pid, "delete_provider")["error"], "provider_error")
        self.assertNotEqual(self.db.job(pid, "delete_provider")["status"], "succeeded")

    def test_without_a_provider_a_delete_is_parked_but_a_purge_is_carried_out(self):
        pid = self.voiced()
        self.db.owner_deletes(pid)
        pid2 = self.ready()
        self.profile(pid2).update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = [j for j in self.db.jobs if j["kind"] == "delete_provider"]
        self.db._add_job(pid2, "purge_sample")
        w = self.worker("w1")
        w.provider = None
        results = []
        for _ in range(2):
            out = w.run_once()
            results.append((out.kind, out.result, out.code))
        self.assertEqual(sorted(results), [("delete_provider", "parked", "provider_not_configured"), ("purge_sample", "purged", None)])
        self.assertEqual(self.db.under(pid2), [], "the recording was purged without any ElevenLabs key")
        self.assertEqual(self.profile(pid2)["sample_state"], "purged")
        self.assertEqual(self.el.calls, [], "and nothing was asked of the provider")
        self.assertNotIn("could not be removed", " ".join(self.logs.lines), "and no orphan sweep was even attempted")

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

    def test_a_purge_that_cannot_confirm_the_prefix_is_empty_is_parked_and_never_reported_done(self):
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
        outs = self.attempts(3)
        self.assertEqual([o.result for o in outs], ["parked", "parked", "failed"])
        self.assertEqual(self.db.job(pid, "purge_sample")["error"], "storage_not_deleted")
        self.assertNotEqual(self.profile(pid)["sample_state"], "purged", "never claims a deletion it could not confirm")
        self.assertEqual(len([l for l in self.logs.lines if "OVERDUE" in l]), 1)

    def test_a_purge_that_fails_once_is_carried_out_at_the_next_claim(self):
        pid = self.ready()
        self.profile(pid).update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = []
        self.db._add_job(pid, "purge_sample")
        real = self.db._route
        down = {"on": True}

        def flaky(method, url, kw):
            if down["on"] and method == "delete":
                return Resp(503)
            return real(method, url, kw)

        self.db._route = flaky
        self.assertEqual(self.w.run_once().result, "parked")
        self.assertEqual(len(self.db.under(pid)), 1)
        down["on"] = False
        self.assertEqual(self.again().result, "purged")
        self.assertEqual(self.db.under(pid), [])

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
        self.assertEqual((out.result, out.code), ("parked", "storage_error"), "a storage error may pass: parked, sample kept")
        self.assertEqual(len(self.db.under(pid)), 1)
        self.assertEqual(self.tr.paths, [])
        self.assertNothingLeaks()

    def test_a_redirect_from_the_rpc_endpoint_claims_nothing(self):
        self.ready()
        self.db.redirect_on = "/rest/v1/rpc/claim_voice_job"
        self.assertIsNone(self.w.run_once())


# ── the review's survivors: each line below was once removable without a test noticing ───────────────

class AddressingAndErrors(Harness):
    def test_a_download_path_that_is_not_user_profile_sample_is_refused_before_any_request(self):
        good = f"{USER}/00000001-0000-4000-8000-000000000000/sample.webm"
        storage = vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db)
        for bad in ("", None, "../" + good, good + "/../../x", f"{USER}/00000001-0000-4000-8000-000000000000/other.webm",
                    f"{USER}/00000001-0000-4000-8000-000000000000/sample.webm/x", f"{USER}/sample.webm", "sample.webm",
                    f"{USER}/../{USER2}/sample.webm", f"{USER2}//sample.webm", good.upper(), good + "\x00", "/" + good,
                    f"{USER}/00000001-0000-4000-8000-000000000000/sample.WEBM", f"{USER}/00000001-0000-4000-8000-000000000000/sample.",
                    f"{USER}/00000001-0000-4000-8000-000000000000/sample.webmwebmx"):
            with self.subTest(path=bad), self.assertRaises(vw.StorageError):
                storage.download(bad)
        self.assertEqual(self.db.calls, [], "no request was made for any of them")

    def test_a_listing_that_names_something_that_cannot_be_addressed_safely_stops_everything(self):
        pid = self.ready()
        p = self.profile(pid)
        for name in ("../../other/x/sample.webm", "a/b", "..", ".", "", "x\x00y", "x\ny", "z" * 300, None, 7):
            with self.subTest(name=name):
                self.db.calls.clear()
                real = self.db._route

                def bad_list(method, url, kw, name=name, real=real):
                    if url.endswith("/object/list/voice-samples"):
                        return Resp(200, [{"name": name, "id": "o1"}])
                    return real(method, url, kw)

                self.db._route = bad_list
                try:
                    with self.assertRaises(vw.StorageError) as ctx:
                        vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db).delete_prefix(p["user_id"], pid)
                finally:
                    self.db._route = real
                self.assertEqual(ctx.exception.code, "odd_listing")
                self.assertNotIn("delete", [m for m, _ in self.db.calls], "nothing was deleted on the strength of such a name")
                self.assertEqual(len(self.db.under(pid)), 1)

    def test_a_listing_that_is_not_a_list_or_not_json_or_too_large_or_too_deep_is_refused(self):
        pid = self.ready()
        p = self.profile(pid)
        real = self.db._route
        endless = [{"name": f"f{i}", "id": "o"} for i in range(vw._LIST_PAGE)]
        for answer in (Resp(200, {"not": "a list"}), Resp(200, None), Resp(500), Resp(200, endless)):
            with self.subTest(status=answer.status_code, body=type(answer._body).__name__):
                self.db._route = lambda m, u, kw, answer=answer, real=real: answer if u.endswith("/object/list/voice-samples") else real(m, u, kw)
                try:
                    with self.assertRaises(vw.StorageError):
                        vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db).delete_prefix(p["user_id"], pid)
                finally:
                    self.db._route = real
        self.assertEqual(len(self.db.under(pid)), 1)
        deep = Resp(200, [{"name": "d", "id": None}])
        self.db._route = lambda m, u, kw: deep if u.endswith("/object/list/voice-samples") else real(m, u, kw)
        with self.assertRaises(vw.StorageError) as ctx:
            vw.SampleStorage(SUPABASE, SERVICE_KEY, session=self.db).list_files(f"{p['user_id']}/{pid}")
        self.assertEqual(ctx.exception.code, "odd_listing", "nesting is bounded: a loop of folders cannot run for ever")

    def test_an_rpc_error_carries_the_status_and_never_the_body(self):
        for status in (400, 401, 500, 503):
            with self.subTest(status=status):
                session = mock.Mock()
                session.post.return_value = Resp(status, {"message": BODY_SECRET, "hint": SERVICE_KEY})
                session.post.return_value.text = BODY_SECRET + SERVICE_KEY
                with self.assertRaises(RuntimeError) as ctx:
                    vw.VoiceStore(SUPABASE, SERVICE_KEY, session=session).claim("w")
                self.assertIn(str(status), str(ctx.exception))
                self.assertNotIn(BODY_SECRET, str(ctx.exception))
                self.assertNotIn(SERVICE_KEY, str(ctx.exception))

    def test_a_storage_error_carries_the_status_and_never_the_body(self):
        for method, call in (("get", lambda st: st.download(f"{USER}/00000001-0000-4000-8000-000000000000/sample.webm")),
                             ("post", lambda st: st.list_files(f"{USER}/00000001-0000-4000-8000-000000000000"))):
            with self.subTest(method=method):
                session = mock.Mock()
                resp = Resp(500, {"message": BODY_SECRET}, content=BODY_SECRET.encode())
                resp.text = BODY_SECRET
                getattr(session, method).return_value = resp
                with self.assertRaises(vw.StorageError) as ctx:
                    call(vw.SampleStorage(SUPABASE, SERVICE_KEY, session=session))
                self.assertIn("500", str(ctx.exception))
                self.assertNotIn(BODY_SECRET, str(ctx.exception))

    def test_nothing_that_prints_an_object_shows_a_key(self):
        provider = vp.ElevenLabsVoiceProvider(self.el, EL_KEY)
        for obj in (vw.VoiceStore(SUPABASE, SERVICE_KEY), vw.SampleStorage(SUPABASE, SERVICE_KEY), provider,
                    vw.VoiceWorker(vw.VoiceStore(SUPABASE, SERVICE_KEY), vw.SampleStorage(SUPABASE, SERVICE_KEY), provider,
                                   worker_id="w", transcribe=self.tr, normalise=self.norm)):
            for text in (repr(obj), str(obj), f"{obj!r:>5}"):
                self.assertNotIn(SERVICE_KEY, text)
                self.assertNotIn(EL_KEY, text)
                self.assertNotIn(SERVICE_KEY[:8], text)
        self.assertIn("<key hidden>", repr(vw.VoiceStore(SUPABASE, SERVICE_KEY)))
        self.assertIn("<key hidden>", repr(vw.SampleStorage(SUPABASE, SERVICE_KEY)))

    def test_not_holder_is_lost_for_every_kind_of_answer(self):
        job = vw.Job.parse(dict(job_id="00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind="purge_sample", attempts=1,
                                profile_id="00000002-0000-4000-8000-000000000000", user_id=USER, owner_ref="ab" * 16, keep_sample=False,
                                sample_prefix=f"{USER}/00000002-0000-4000-8000-000000000000/", status="rejected"))
        clone = vw.Job.parse(dict(job.__dict__, kind="clone", sample_prefix=job.prefix))
        for j in (job, clone):
            with self.subTest(kind=j.kind):
                self.assertEqual(vw.VoiceWorker._outcome_of(j, {"ok": False, "error": "not_holder"}, "x").result, "lost")
                self.assertEqual(vw.VoiceWorker._outcome_of(j, {"ok": False, "error": "no_such_job"}, "x").result, "unrecorded")
                self.assertEqual(vw.VoiceWorker._outcome_of(j, None, "x").result, "unrecorded")
        # and through the real code: a purge whose answer is refused as not_holder deletes nothing more and says lost
        pid = self.ready()
        self.profile(pid).update(status="rejected", sample_state="purge_pending")
        self.db.jobs[:] = []
        self.db._add_job(pid, "purge_sample")
        self.db._finish_task = lambda a: {"ok": False, "error": "not_holder"}
        self.assertEqual(self.w.run_once().result, "lost")
        # an error answer for a clone that is refused as not_holder is lost too, and the recording is kept
        self.setUp()
        pid = self.ready()
        self.norm.error = vw.AudioRefused("not_audio")
        self.db._finish_clone = lambda a: {"ok": False, "error": "not_holder"}
        self.assertEqual(self.w.run_once().result, "lost")
        self.assertEqual(len(self.db.under(pid)), 1, "an answer the database refused lets go of nothing")


class AdapterBranches(unittest.TestCase):
    """The non-200 and malformed branches of the two read-only calls the worker relies on."""

    def provider(self, *answers):
        el = FakeEleven()
        el.script["get:/user/subscription"] = [a for a in answers]
        el.script["get:/voices"] = [a for a in answers]
        return vp.ElevenLabsVoiceProvider(el, EL_KEY)

    def test_the_plan_probe_fails_closed_on_every_odd_answer(self):
        cases = [(Resp(500, {"detail": BODY_SECRET}), "transient"), (Resp(401, {"detail": {"status": "invalid_api_key"}}), "auth"),
                 (Resp(404), "not_found"), (Resp(200, None), "unexpected"), (Resp(200, ["x"]), "unexpected"), (Resp(302), "redirect")]
        for answer, code in cases:
            with self.subTest(code=code, status=answer.status_code):
                with self.assertRaises(vp.ProviderError) as ctx:
                    self.provider(answer).ensure_plan()
                self.assertEqual(ctx.exception.code, code)
                self.assertNotIn(BODY_SECRET, str(ctx.exception))
        with self.assertRaises(vp.ProviderError) as net:
            self.provider(TimeoutError(BODY_SECRET)).ensure_plan()
        self.assertEqual(net.exception.code, "network")
        self.assertNotIn(BODY_SECRET, str(net.exception))

    def test_the_listing_fails_closed_on_every_odd_answer(self):
        pid = "00000001-0000-4000-8000-000000000000"
        cases = [(Resp(503, {"detail": BODY_SECRET}), "transient"), (Resp(401), "auth"), (Resp(200, None), "unexpected"),
                 (Resp(200, {"voices": "nope"}), "unexpected"), (Resp(200, {}), "unexpected"), (Resp(302), "redirect")]
        for answer, code in cases:
            with self.subTest(code=code, status=answer.status_code):
                with self.assertRaises(vp.ProviderError) as ctx:
                    self.provider(answer).find_voices_for_profile("ab" * 16, pid)
                self.assertEqual(ctx.exception.code, code)
                self.assertNotIn(BODY_SECRET, str(ctx.exception))

    def test_labels_decide_ownership_and_only_the_full_profile_id_with_the_owner_counts(self):
        pid = "abcdef01-0000-4000-8000-000000000000"
        name = vp.provider_voice_name("ab" * 16, pid)
        listing = {"voices": [
            {"voice_id": "A" * 20, "name": name, "labels": {"nightshift_profile": pid, "nightshift_owner_ref": "ab" * 16}},
            {"voice_id": "B" * 20, "name": name, "labels": {"nightshift_profile": pid.upper(), "nightshift_owner_ref": "ab" * 16}},
            {"voice_id": "C" * 20, "name": name, "labels": {"nightshift_profile": pid[:8], "nightshift_owner_ref": "ab" * 16}},
            {"voice_id": "D" * 20, "name": name, "labels": {"nightshift_profile": pid, "nightshift_owner_ref": "cd" * 16}},
            {"voice_id": "E" * 20, "name": name, "labels": {"nightshift_profile": pid}},
            {"voice_id": "F" * 20, "name": name, "labels": {}},
            {"voice_id": "G" * 20, "name": name + "x", "labels": {"nightshift_profile": pid, "nightshift_owner_ref": "ab" * 16}},
            {"voice_id": "H" * 20, "name": "Rachel"}, "junk", {"name": name}, {"voice_id": "bad", "name": name}]}
        el = FakeEleven()
        el.script["get:/voices"] = [Resp(200, listing)]
        got = vp.ElevenLabsVoiceProvider(el, EL_KEY).find_voices_for_profile("ab" * 16, pid)
        self.assertEqual(got.owned, ("A" * 20,))
        self.assertEqual(got.conflicting, ("B" * 20, "C" * 20, "D" * 20, "E" * 20, "F" * 20))


class TheLogsAreQuietWhateverHappens(Harness):
    """Behavioural, not an inspection of the source: run every path with sentinel values in every place a secret could come from
    (the keys, the phrase, the sample, response bodies, exception messages, voice ids) and read everything that was logged,
    printed or stored."""

    SENTINELS = ("SENTINEL-SERVICE-KEY", "SENTINEL-EL-KEY", "SENTINEL-BODY", "SENTINEL-EXC", "SENTINEL-SAMPLE", "SENTINEL-PHRASE")

    def run_battery(self):
        storage_leak = lambda *a, **k: (_ for _ in ()).throw(ConnectionError("SENTINEL-EXC SENTINEL-SERVICE-KEY"))
        scenarios = []

        def scenario(setup):
            scenarios.append(setup)

        scenario(lambda: None)                                                          # the happy path
        scenario(lambda: setattr(self.tr, "text", "SENTINEL-PHRASE wrong words entirely"))   # wrong phrase
        scenario(lambda: setattr(self.tr, "text", RuntimeError("SENTINEL-EXC SENTINEL-PHRASE")))   # transcriber blows up
        scenario(lambda: setattr(self.norm, "error", RuntimeError("SENTINEL-EXC")))      # decode blows up
        scenario(lambda: setattr(self.norm, "error", vw.AudioRefused("not_audio")))
        scenario(lambda: self.el.script.__setitem__("post:/voices/add", [Resp(500, {"detail": "SENTINEL-BODY"}), ("made", ConnectionError("SENTINEL-EXC SENTINEL-EL-KEY"))]))
        scenario(lambda: self.el.script.__setitem__("get:/user/subscription", [Resp(401, {"detail": {"status": "invalid_api_key", "message": "SENTINEL-BODY"}})]))
        scenario(lambda: self.el.script.__setitem__("get:/voices", [Resp(200, {"voices": "SENTINEL-BODY"})]))
        scenario(lambda: setattr(self.db, "rpc_failures", {"finish_voice_clone": [ConnectionError("SENTINEL-EXC SENTINEL-SERVICE-KEY")] * 3}))
        scenario(lambda: setattr(self.db, "rpc_failures", {"claim_voice_job": [RuntimeError("SENTINEL-EXC")]}))
        scenario(lambda: setattr(self.db, "redirect_on", "/storage/v1/object/voice-samples/"))
        scenario(lambda: setattr(self.db, "_route", lambda m, u, kw, real=self.db._route: Resp(500, {"message": "SENTINEL-BODY"}) if m == "get" else real(m, u, kw)))
        for setup in scenarios:
            self.setUp()
            setup()
            pid = self.db.request_clone(phrase=PHRASE)
            self.db.upload(pid, WEBM.replace(MARKER, b"SENTINEL-SAMPLE"))
            for _ in range(4):
                try:
                    self.w.run_once()
                except Exception:
                    pass
                self.db.expire_leases()
            yield pid

    def test_no_sentinel_reaches_a_log_a_stdout_or_stderr_line_or_the_database_across_every_path(self):
        seen = []
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            for pid in self.run_battery():
                jobs = [{k: v for k, v in j.items() if k != "phrase"} for j in self.db.jobs]   # the phrase is the queue row's own column
                stored = json.dumps([self.db.profiles, jobs, self.db.consents, self.db.records], default=str)
                records = []
                logging.getLogger().handlers  # the catcher of this harness holds the rendered messages
                records += self.logs.lines
                for sentinel in self.SENTINELS + (SERVICE_KEY, EL_KEY, "apple river"):
                    self.assertNotIn(sentinel, stored, f"{sentinel} reached the database")
                    for line in records:
                        self.assertNotIn(sentinel, line, f"{sentinel} reached a log line: {line}")
                for v in list(self.el.voices):
                    for line in records:
                        self.assertNotIn(v, line, "a provider voice id reached a log line")
                seen.append(len(records))
        self.assertNotIn("SENTINEL", out.getvalue() + err.getvalue())
        self.assertGreater(sum(seen), 20, "the battery really did log things")

    def test_a_log_record_carries_no_exception_object_or_arguments_that_could_print_one_later(self):
        # logging formats lazily: an exception passed as an argument is rendered by whatever handler runs. Only type names may be passed.
        class Keep(logging.Handler):
            def __init__(self):
                super().__init__(logging.DEBUG)
                self.records = []

            def emit(self, record):
                self.records.append(record)

        keep = Keep()
        logging.getLogger().addHandler(keep)
        try:
            for _ in self.run_battery():
                pass
        finally:
            logging.getLogger().removeHandler(keep)
        self.assertTrue(keep.records)
        for r in keep.records:
            if not r.name.startswith("modules.voice_worker"):
                continue
            self.assertIsNone(r.exc_info, "no traceback: it carries the message")
            for arg in (r.args if isinstance(r.args, tuple) else tuple((r.args or {}).values())):
                self.assertNotIsInstance(arg, BaseException, f"an exception object was passed to the logger: {r.msg}")
                for sentinel in self.SENTINELS + (SERVICE_KEY, EL_KEY):
                    self.assertNotIn(sentinel, str(arg))


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

    def test_the_adapter_methods_are_marked_unverified_and_in_the_protocol(self):
        self.assertIn("UNVERIFIED", vp.ElevenLabsVoiceProvider.find_voices_for_profile.__doc__)
        self.assertTrue(hasattr(vp.VoiceProvider, "find_voices_for_profile") and hasattr(vp.VoiceProvider, "ensure_plan"))
        with self.assertRaises(ValueError):
            vp.ElevenLabsVoiceProvider(mock.Mock(), EL_KEY).find_voices_for_profile("not-a-ref", "not-a-uuid")

    def test_the_module_says_it_is_unverified_live(self):
        self.assertIn("UNVERIFIED", vw.__doc__)


if __name__ == "__main__":
    unittest.main()
