"""Every registry model's ``takes_negative_prompt`` is what its adapter really puts in the vendor's request.

Migration 0218 sells a negative prompt only to a model whose synced spec says ``takes_negative_prompt: true``, and refuses it before any
hold for every other model; ModelEntry.problems refuses it again in the worker. Both rest on the registry flag being TRUE: a flag set on a
model whose adapter drops the field would charge for a setting nobody receives (CLAUDE.md #4), and a flag missing on one that sends it
refuses what works. A class attribute (TAKES_NEGATIVE_PROMPT) can drift from the code under it, so this test does not read it: it runs
each model's own ``submit`` against a recording HTTP session (no network, no key: every answer is a lab 500) and looks for a sentinel
negative prompt in what was sent.

For a model whose adapter refuses a negative prompt itself before sending anything (LTX, Vidu, Luma Uni-1 ...), "not sent" is right too.
For every other model the same request without a negative prompt must reach the vendor call, so the absence of the sentinel is a
measurement of the body, not of a request that never got that far.
"""

import dataclasses
import os
import struct
import tempfile
import unittest
import zlib

from modules import model_registry as mr

SENTINEL = "zz-negative-sentinel-0218"


class _Resp:
    status_code = 500
    text = "lab"
    headers: dict = {}

    def __init__(self, status=500, body=None):
        self.status_code = status
        self._body = body if body is not None else {}

    def json(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_content(self, chunk_size=1):
        return iter(())


class _Session:
    """Records every request; answers a lab 500 (an outage: the adapter raises after sending), except a picture upload, which gets a
    hosted link back so that an adapter that uploads first (Pika) reaches its paid call."""

    def __init__(self, upload_url=None):
        self.sent = []
        self.upload_url = upload_url

    def request(self, method, url, **kw):
        self.sent.append(repr({k: kw.get(k) for k in ("json", "data", "files", "params")}))
        if self.upload_url and method == "POST" and url.endswith("/v1/media/uploads"):
            return _Resp(200, {"url": self.upload_url})
        return _Resp()

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)


class _Env(dict):
    """A key for every adapter, and no base-URL override (the default https host is kept)."""

    def get(self, k, d=None):
        return "" if k.endswith("BASE_URL") else "lab-key-0000000000"


def _png(path):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b""))


#: Text-led capabilities first: a request that needs no picture reaches the vendor call on every adapter.
_PREFERRED = ("t2i", "t2v", "tts", "sfx", "music")


def _submit(entry, picture, negative):
    cls = mr.ADAPTERS[entry.adapter]
    hosts = getattr(cls, "upload_hosts", None)
    session = _Session(upload_url=f"https://{hosts[0]}/lab.png" if hosts else None)
    adapter = cls(env=_Env(), session=session)
    req = entry.probe_request(voice_id="A" * 20, generated_image=picture, generated_speech=picture,
                              generated_end_image=picture, generated_video=picture)
    cap = next((c for c in _PREFERRED if c in entry.capabilities), req.capability)
    if cap != req.capability:
        # The probe's own settings where the two capabilities share them (a clip model probed by i2v keeps its resolution and length).
        same = {req.capability, cap} <= {"t2v", "i2v"} or {req.capability, cap} <= {"t2i", "edit"}
        req = dataclasses.replace(req, capability=cap, input_images=(), end_image=None, input_media=(), scale=None, look=None,
                                  duration_s=req.duration_s if same else (entry.durations_s[0] if entry.durations_s else None),
                                  resolution=req.resolution if same else None, quality=req.quality if same else None,
                                  image_size=req.image_size if same else None,
                                  voice_id=req.voice_id if cap == "tts" else None)
    vendor_model = entry.vendor_model_for(cap)
    if hasattr(adapter, "probing_past_shutdown"):
        # Veo refuses an id past its announced shutdown before sending; the probe's own switch is how a test reaches the body.
        adapter.probing_past_shutdown = vendor_model
    req = dataclasses.replace(req, prompt=req.prompt or "a lighthouse at dawn", negative_prompt=negative)
    try:
        adapter.submit(req, vendor_model)
    except Exception:  # noqa: BLE001 - every lab answer is an error; what was SENT is the measurement
        pass
    return session.sent


class NegativePromptWiring(unittest.TestCase):
    def test_every_models_flag_is_what_its_adapter_sends(self):
        tmp = tempfile.mkdtemp()
        picture = os.path.join(tmp, "lab.png")
        _png(picture)
        unproven = []
        for entry in mr.load().values():
            with_neg = _submit(entry, picture, SENTINEL)
            sent = any(SENTINEL in body for body in with_neg)
            self.assertEqual(sent, entry.takes_negative_prompt,
                             f"{entry.id} ({entry.adapter}): registry takes_negative_prompt={entry.takes_negative_prompt}, "
                             f"the vendor request {'carries' if sent else 'does not carry'} the negative prompt")
            if not entry.takes_negative_prompt and with_neg:
                # It sent a request without the field: that IS the drop the quote now refuses up front.
                continue
            if not entry.takes_negative_prompt and not _submit(entry, picture, ""):
                unproven.append(entry.id)
        # The models whose lab request cannot reach a vendor call at all (a recording or a video the adapter must fetch itself, a
        # provider this worker has no key shape for). Their adapters have no code path that reads negative_prompt (grep pins it below).
        self.assertLessEqual(set(unproven), {
            "gemini-2.5-flash-image-relight", "elevenlabs-scribe-v2", "assemblyai-universal-2", "runway-video-upscale",
            "generic-video-edit", "generic-video-reframe", "generic-video-remove-bg", "elevenlabs-voice-changer",
            "elevenlabs-dubbing-v2", "elevenlabs-dubbing-v1", "sonilo-video-music", "kling-4.0-omni-edit", "seedance-2.5-edit"},
            unproven)

    def test_the_adapters_that_could_not_be_driven_never_read_a_negative_prompt_into_a_body(self):
        import inspect

        for mid in ("gemini-2.5-flash-image-relight", "elevenlabs-scribe-v2", "assemblyai-universal-2", "runway-video-upscale",
                    "generic-video-edit", "elevenlabs-voice-changer", "elevenlabs-dubbing-v2", "kling-4.0-omni-edit",
                    "seedance-2.5-edit"):
            cls = mr.ADAPTERS[mr.get(mid).adapter]
            src = inspect.getsource(cls.submit)
            self.assertNotIn("negative_prompt", src.replace("request.negative_prompt:", ""), mid)
            self.assertFalse(mr.get(mid).takes_negative_prompt, mid)

    def test_the_flag_reaches_the_synced_spec_for_every_model(self):
        r = mr.load()
        for row in mr.sync_rows(list(r.values())):
            self.assertIs(row["spec"]["takes_negative_prompt"], r[row["id"]].takes_negative_prompt, row["id"])

    def test_the_worker_refuses_a_negative_prompt_the_model_does_not_take(self):
        from modules.capabilities.base import CapabilityRequest

        r = mr.load()
        for mid in ("recraft-v4.1", "ideogram-3", "ideogram-4", "ideogram-4.5", "openai-gpt-image-2.6-flare", "minimax-h3"):
            e = r[mid]
            cap = "t2i" if "t2i" in e.capabilities else "t2v"
            msg = f"{mid} does not take a negative prompt; remove it or choose a model that does"
            self.assertIn(msg, e.problems(CapabilityRequest(capability=cap, prompt="x", negative_prompt="blur")), mid)
            self.assertNotIn(msg, e.problems(CapabilityRequest(capability=cap, prompt="x", negative_prompt="   ")), mid)
        for mid in ("kling-v3", "krea-3", "veo-3.1", "wan-3.0", "pika-2.5"):
            e = r[mid]
            cap = "t2i" if "t2i" in e.capabilities else "t2v"
            self.assertFalse([p for p in e.problems(CapabilityRequest(capability=cap, prompt="x", negative_prompt="blur"))
                              if "negative prompt" in p], mid)

    def test_the_registry_refuses_a_flag_that_disagrees_with_the_adapter(self):
        import copy
        import json

        doc = json.loads(mr.REGISTRY_PATH.read_text())
        bad = copy.deepcopy(doc)
        for m in bad["models"]:
            if m["id"] == "recraft-v4.1":
                m["takes_negative_prompt"] = True
            if m["id"] == "kling-v3":
                m.pop("takes_negative_prompt")
            if m["id"] == "krea-3":
                m["limits"]["max_negative_prompt_chars"] = 2000
        errors = "\n".join(mr.validate(bad))
        self.assertIn("recraft-v4.1: takes_negative_prompt must be False", errors)
        self.assertIn("kling-v3: takes_negative_prompt must be True", errors)
        self.assertIn("krea-3: limits.max_negative_prompt_chars must be the adapter's own limit (1024)", errors)
        self.assertEqual(mr.validate(doc), [])


if __name__ == "__main__":
    unittest.main()
