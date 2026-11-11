"""The makers' watermarks and provenance are kept, everywhere.

Nightshift's letters to the model makers (sent 2026-11-11) say: "We keep vendor attribution and
watermarks/C2PA". This file is the code holding us to that sentence. A repo review found two adapters
that asked for, or stored, the copy without the maker's mark (Alibaba HappyHorse / Qwen sent
``watermark: false``; Vidu stored ``url`` instead of ``watermarked_url``). docs/AI_DISCLOSURE.md
("Vendor watermarks and provenance") lists, per vendor, what is kept and what the vendor offers.

No vendor is called: every request goes to a fake session (tests/test_capabilities.FakeSession).

What would break without these tests:

* an adapter sending a watermark-off value (``watermark: false``, ``aigc_watermark: false``,
  ``logo_add: 0``, ``watermark_info.enabled: false``) or a field that replaces the maker's mark or
  label with ours (``wm_url``, ``meta_data``) — caught statically in the source AND in the bodies
  every registry model's probe request actually sends;
* a constant, setting or argument that lets someone switch a vendor watermark off again
  (``WATERMARK = False``, ``STORE_WATERMARKED``);
* an adapter whose vendor offers a mark no longer asking for it, or a new adapter that adds a
  watermark field without a test here;
* Kling or Vidu storing the unmarked link when the vendor hands back both, or falling back to it;
* a store path rewriting a vendor file, so its C2PA manifest / XMP / watermark metadata is lost.
"""

from __future__ import annotations

import ast
import base64
import hashlib
import inspect
import re
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from typing import Iterator, List, Tuple

from modules import media_library as ml
from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities.base import (
    EDIT,
    I2V,
    SUCCEEDED,
    T2I,
    T2V,
    AdapterError,
    CapabilityRequest,
    PollResult,
    ProviderTask,
)
from tests.test_capabilities import ENV, FakeResp, FakeSession

ROOT = Path(__file__).resolve().parent.parent

#: Request fields that switch a maker's mark on or off: only the "on" value may ever be sent.
ON_OFF_FLAGS = {"watermark", "add_watermark", "aigc_watermark", "enable_watermark", "logo_add"}
#: Fields that remove the maker's mark, or replace its mark / label with ours: never sent at all.
NEVER_SENT = {"no_watermark", "remove_watermark", "watermark_free", "without_watermark", "wm_url", "meta_data"}
#: Words that name an unmarked copy. No code path may ask for one.
UNMARKED_WORDS = ("no_watermark", "nowatermark", "watermark_free", "watermarkfree", "without_watermark",
                  "unwatermarked", "remove_watermark", "removewatermark", "strip_watermark", "strip_c2pa")
_ON = (True, 1, "true", "1", "on", "True")


def _off(value) -> bool:
    """True unless ``value`` is unmistakably "keep the mark on"."""
    if isinstance(value, bool):
        return value is not True
    if isinstance(value, (int, float)):
        return value != 1
    if isinstance(value, str):
        return value.strip().lower() not in ("true", "1", "on")
    return True


def watermark_offences(obj, path: str = "$") -> Iterator[str]:
    """Every place in a request body that turns a maker's mark off or replaces it."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = str(k).lower()
            here = f"{path}.{k}"
            if key in ON_OFF_FLAGS and _off(v):
                yield f"{here} = {v!r}"
            elif key == "watermark_info" and not (isinstance(v, dict) and v.get("enabled") is True):
                yield f"{here} = {v!r}"
            elif key in NEVER_SENT:
                yield f"{here} is sent"
            yield from watermark_offences(v, here)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from watermark_offences(v, f"{path}[{i}]")


def sent_bodies(session: FakeSession) -> List[Tuple[str, object]]:
    out = []
    for method, url, kw in session.calls:
        for field in ("json", "data", "params"):
            if kw.get(field) is not None:
                out.append((f"{method} {url} [{field}]", kw[field]))
    return out


def _png(extra_chunks: bytes = b"") -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x10\x20\x30" * 2 for _ in range(2))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + extra_chunks + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


#: A picture as a maker ships it: a C2PA manifest store (``caBX``, JUMBF) and an XMP packet that says
#: who made it. The store path must keep every byte of both.
C2PA_JUMBF = b"\x00\x00\x00\x40jumb\x00\x00\x00\x18jumdc2pa\x00\x11\x00\x10\x80\x00\xaa\x008\x9bq" + b"manifest" * 4
XMP = (b"XML:com.adobe.xmp\x00\x00\x00\x00\x00<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:Description "
       b"xmlns:Iptc4xmpExt='http://iptc.org/std/Iptc4xmpExt/2008-02-29/' "
       b"Iptc4xmpExt:DigitalSourceType='trainedAlgorithmicMedia'/></x:xmpmeta>")
VENDOR_PNG = _png(_chunk(b"caBX", C2PA_JUMBF) + _chunk(b"iTXt", XMP))
#: An MP4 as a maker ships it: ``ftyp``, a C2PA ``uuid`` box (the manifest store's home in BMFF) and data.
C2PA_UUID = bytes.fromhex("d8fec3d61b0e483c92975828877ec481")
VENDOR_MP4 = (struct.pack(">I", 24) + b"ftypisom" + struct.pack(">I", 0x200) + b"isomiso2"
              + struct.pack(">I", 8 + 16 + len(C2PA_JUMBF)) + b"uuid" + C2PA_UUID + C2PA_JUMBF
              + struct.pack(">I", 16) + b"mdat" + b"\x00" * 8)


# ── 1. the source: no watermark-off value, no switch, anywhere the bot or the worker runs ───────────────

def _python_sources() -> List[Path]:
    files = [ROOT / "main.py", ROOT / "config.py"]
    for top in ("modules", "tools"):
        files += sorted((ROOT / top).rglob("*.py"))
    return [f for f in files if f.is_file() and "__pycache__" not in f.parts]


def _key(node) -> str:
    return node.value.lower() if isinstance(node, ast.Constant) and isinstance(node.value, str) else ""


def _value_offence(key: str, value: ast.AST) -> str:
    """Why sending ``value`` under ``key`` is not allowed ('' when it is). Only a literal "on" passes:
    a variable, a constant or an expression is a switch someone can flip."""
    if key in NEVER_SENT:
        return f"{key!r} is sent"
    if key in ON_OFF_FLAGS:
        if isinstance(value, ast.Constant) and value.value in _ON and value.value is not False:
            return ""
        return f"{key!r} = {ast.unparse(value)} (only a literal true keeps the maker's mark)"
    if key == "watermark_info":
        if isinstance(value, ast.Dict):
            for k, v in zip(value.keys, value.values):
                if _key(k) == "enabled" and isinstance(v, ast.Constant) and v.value is True:
                    return ""
        return f"'watermark_info' = {ast.unparse(value)} (only {{'enabled': True}} keeps the maker's copy)"
    return ""


def source_offences(path: Path) -> List[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    rel = path.relative_to(ROOT)
    found: List[str] = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                why = _value_offence(_key(k), v) if k is not None else ""
                if why:
                    found.append(f"{rel}:{line}: {why}")
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Subscript):
                    why = _value_offence(_key(target.slice), node.value)
                    if why:
                        found.append(f"{rel}:{line}: {why}")
                if isinstance(target, ast.Name) and "WATERMARK" in target.id.upper():
                    found.append(f"{rel}:{line}: {target.id} is a switch for a vendor watermark")
        elif isinstance(node, ast.Call):
            for kw in node.keywords:
                why = _value_offence((kw.arg or "").lower(), kw.value) if kw.arg else ""
                if why:
                    found.append(f"{rel}:{line}: {why}")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            low = node.value.lower()
            for word in UNMARKED_WORDS:
                if word in low:
                    found.append(f"{rel}:{line}: names an unmarked copy ({word!r})")
    return found


#: Non-Python code that could build a request or a setting: the dashboard, the database, the registry.
_TEXT_OFF = re.compile(r"""(?ix)
    ["']?(?:add_|aigc_|enable_)?watermark["']?\s*[:=]\s*(?:false|0|["']false["']|["']0["']|["']off["'])
    | ["']?logo_add["']?\s*[:=]\s*(?:0|false)
    | ["']?enabled["']?\s*:\s*false\s*}?\s*,?\s*//?\s*watermark
""")


def _text_sources() -> List[Path]:
    out: List[Path] = []
    for top, globs in (("command-center", ("app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "lib/**/*.tsx",
                                           "components/**/*.tsx", "components/**/*.ts", "middleware.ts")),
                       ("supabase", ("migrations/*.sql",)), ("schemas", ("*.json",))):
        base = ROOT / top
        for g in globs:
            out += [p for p in base.glob(g) if p.is_file() and "node_modules" not in p.parts]
    return out


class SourceGuardTests(unittest.TestCase):
    def test_the_guard_reads_the_code_it_claims_to(self):
        names = {p.relative_to(ROOT).as_posix() for p in _python_sources()}
        for must in ("modules/capabilities/alibaba.py", "modules/capabilities/vidu.py", "modules/capabilities/video.py",
                     "modules/capabilities/image.py", "modules/video_providers.py", "modules/image_providers.py",
                     "modules/media_library.py", "main.py"):
            self.assertIn(must, names)
        self.assertTrue(any(p.name == "model_registry.json" for p in _text_sources()))

    def test_no_code_sends_a_watermark_off_value_or_keeps_a_switch_for_one(self):
        found = [o for f in _python_sources() for o in source_offences(f)]
        self.assertEqual(found, [], "a vendor watermark can be turned off:\n" + "\n".join(found))

    def test_no_dashboard_migration_or_registry_text_turns_a_watermark_off(self):
        found = []
        for f in _text_sources():
            for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                low = line.lower()
                if _TEXT_OFF.search(line) or any(w in low for w in UNMARKED_WORDS):
                    found.append(f"{f.relative_to(ROOT)}:{n}: {line.strip()[:160]}")
        self.assertEqual(found, [], "\n".join(found))

    def test_the_guard_itself_catches_each_way_back(self):
        # The guard is only as good as what it notices: each of these is a real way the review found, or could find.
        bad = {
            '{"watermark": False}': "watermark",
            '{"watermark": bool(self.WATERMARK)}': "watermark",
            'params["watermark"] = flag': "watermark",
            '{"aigc_watermark": False}': "aigc_watermark",
            '{"logo_add": 0}': "logo_add",
            '{"watermark_info": {"enabled": False}}': "watermark_info",
            '{"meta_data": "{}"}': "meta_data",
            'body["wm_url"] = ours': "wm_url",
            'call(watermark=False)': "watermark",
            'STORE_WATERMARKED = False': "STORE_WATERMARKED",
            'key = "url_no_watermark"': "no_watermark",
        }
        with tempfile.TemporaryDirectory() as tmp:
            for code, word in bad.items():
                p = Path(tmp) / "x.py"
                p.write_text(code + "\n", encoding="utf-8")
                old = globals()["ROOT"]
                try:
                    globals()["ROOT"] = Path(tmp)
                    found = source_offences(p)
                finally:
                    globals()["ROOT"] = old
                self.assertTrue(found and word in found[0], f"{code!r} was not caught: {found}")
        for ok in ('{"watermark": True}', '{"watermark_info": {"enabled": True}}', '{"logo_add": 1}',
                   'key = "watermarked_url"'):
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / "x.py"
                p.write_text(ok + "\n", encoding="utf-8")
                old = globals()["ROOT"]
                try:
                    globals()["ROOT"] = Path(tmp)
                    self.assertEqual(source_offences(p), [], ok)
                finally:
                    globals()["ROOT"] = old
        for line in ('"watermark": false', "watermark: false,", "'aigc_watermark': 'false'", "logo_add: 0"):
            self.assertTrue(_TEXT_OFF.search(line), line)
        self.assertFalse(_TEXT_OFF.search('"watermark": true'))
        self.assertEqual(list(watermark_offences({"parameters": {"watermark": False}})), ["$.parameters.watermark = False"])
        self.assertEqual(list(watermark_offences({"a": [{"watermark_info": {"enabled": True}}], "watermark": True})), [])


# ── 2. what every adapter actually sends: each registry model's probe request ─────────────────────────────

#: adapter -> where its maker's switch lives in the body it sends, and the value that keeps the mark.
#: Each was read from the vendor's own page on 2026-11-11 (the adapters cite the URLs).
KEEPS = {
    "video.happyhorse": (("parameters", "watermark"), True),
    "image.dashscope": (("parameters", "watermark"), True),       # Qwen; Z-Image has no such field (below)
    "video.wan": (("parameters", "watermark"), True),
    "video.seedance": (("watermark",), True),
    "video.seedance2": (("watermark",), True),
    "image.seedream": (("watermark",), True),
    "video.kling": (("watermark_info",), {"enabled": True}),
}
#: Vendors that hand back a marked AND an unmarked link: the marked one is the one stored (tested below).
MARKED_LINK = {"video.vidu": "watermarked_url", "video.kling": "watermark_url"}
#: Models of a KEEPS adapter whose own page lists no watermark field: nothing to ask for.
NO_SWITCH_MODELS = {"z-image-turbo"}
_GENERIC = FakeResp(200, {})


def _dig(body, path):
    for p in path:
        body = body.get(p) if isinstance(body, dict) else None
    return body


class EveryModelTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        from tools.probe_models import probe_image

        self.frame = str(probe_image(self.tmp / "frame.png"))
        self.end = str(probe_image(self.tmp / "end.png", end=True))

    def submit_probe(self, entry, capability=None):
        """What ``entry``'s adapter sends for its probe request (or for ``capability``), to a session that
        answers every call with an empty 200. Nothing after the first request matters here."""
        session = FakeSession([(m, "", _GENERIC) for m in ("POST", "GET", "PUT", "DELETE", "PATCH")],
                              downloads={})
        a = build_adapter(entry.adapter, env=ENV, session=session)
        req = entry.probe_request(voice_id="v" * 20, generated_image=self.frame, generated_end_image=self.end,
                                  generated_speech=self.frame, generated_video=self.frame)
        if capability and capability != req.capability:
            req = CapabilityRequest(capability, "a boat at dawn", resolution=req.resolution, duration_s=req.duration_s,
                                    input_images=(self.frame,) if capability in (I2V, EDIT) else ())
        if entry.adapter == "video.wan" and req.capability == I2V:
            # Wan takes the first frame as an https link only.
            req = CapabilityRequest(I2V, req.prompt or "a boat", resolution=req.resolution, duration_s=req.duration_s,
                                    input_images=("https://example.invalid/frame.png",))
        try:
            a.submit(req, entry.vendor_model_for(req.capability))
        except (AdapterError, AssertionError, KeyError, TypeError, ValueError, OSError):
            pass                                                   # the empty answer is not a task: expected
        return sent_bodies(session)

    def test_no_model_in_the_registry_sends_a_watermark_off_value(self):
        offences, sent = [], 0
        for entry in reg.registry().values():
            for where, body in self.submit_probe(entry):
                sent += 1
                offences += [f"{entry.id} ({entry.adapter}) {where}: {o}" for o in watermark_offences(body)]
        self.assertGreater(sent, 50)                               # the sweep reached most of the catalogue
        self.assertEqual(offences, [], "\n".join(offences))

    def test_every_model_whose_maker_offers_a_mark_asks_for_it(self):
        seen = set()
        for entry in reg.registry().values():
            if entry.adapter not in KEEPS:
                continue
            path, on = KEEPS[entry.adapter]
            for cap in entry.capabilities:
                bodies = [b for _, b in self.submit_probe(entry, cap) if isinstance(b, dict) and "model" in b
                          or isinstance(b, dict) and "model_name" in b]
                self.assertTrue(bodies, f"{entry.id} {cap}: nothing was sent")
                got = _dig(bodies[0], path)
                if entry.vendor_model_for(cap) in NO_SWITCH_MODELS:
                    self.assertIsNone(got, f"{entry.id}: its page lists no watermark field")
                    continue
                self.assertEqual(got, on, f"{entry.id} {cap}: {'.'.join(path)} is {got!r}")
                seen.add(entry.adapter)
        self.assertEqual(seen, set(KEEPS))                         # every listed adapter still has a model

    def test_an_adapter_that_names_a_watermark_field_is_covered_here(self):
        # A new adapter (or a new field) that touches a vendor mark must come with a row in KEEPS / MARKED_LINK.
        mentions = set()
        for key, cls in ADAPTERS.items():
            src = inspect.getsource(cls).lower()
            if re.search(r"""["'](?:add_|aigc_|enable_)?watermark(?:_info|ed_url|_url)?["']|["']logo_add["']""", src):
                mentions.add(key)
        self.assertEqual(mentions - set(KEEPS) - set(MARKED_LINK), set())
        self.assertEqual((set(KEEPS) | set(MARKED_LINK)) - mentions, set())

    def test_no_adapter_class_carries_a_watermark_switch(self):
        for key, cls in ADAPTERS.items():
            for name in dir(cls):
                self.assertNotIn("WATERMARK", name.upper(), f"{key}.{name}")


# ── 3. links: the marked copy is the one stored, and the unmarked one is never a fallback ─────────────────

class MarkedLinkTests(unittest.TestCase):
    def test_kling_stores_the_watermarked_copy_and_never_the_plain_one(self):
        a = build_adapter("video.kling", env=ENV, session=FakeSession([("GET", "text2video/abc", FakeResp(200, {
            "code": 0, "data": {"task_status": "succeed", "task_result": {"videos": [
                {"id": "v", "url": "https://cdn.kling.example/plain.mp4",
                 "watermark_url": "https://cdn.kling.example/marked.mp4"}]}}}))]))
        res = a.poll(ProviderTask("video.kling", "kling-v2-6", "text2video/abc"))
        self.assertEqual((res.state, res.outputs[0].url), (SUCCEEDED, "https://cdn.kling.example/marked.mp4"))

    def test_kling_without_its_watermarked_copy_fails_instead_of_storing_the_plain_one(self):
        a = build_adapter("video.kling", env=ENV, session=FakeSession([("GET", "image2video/abc", FakeResp(200, {
            "code": 0, "data": {"task_status": "succeed", "task_result": {"videos": [
                {"id": "v", "url": "https://cdn.kling.example/plain.mp4"}]}}}))]))
        with self.assertRaises(AdapterError) as cm:
            a.poll(ProviderTask("video.kling", "kling-v2-6", "image2video/abc"))
        self.assertIn("watermark", cm.exception.message)
        self.assertNotIn("plain.mp4", cm.exception.message)

    def test_kling_asks_for_the_marked_copy_on_both_endpoints(self):
        for cap, route in ((T2V, "text2video"), (I2V, "image2video")):
            session = FakeSession([("POST", route, FakeResp(200, {"code": 0, "data": {"task_id": "t1"}}))])
            a = build_adapter("video.kling", env=ENV, session=session)
            a.submit(CapabilityRequest(cap, "boat", aspect_ratio="16:9" if cap == T2V else None, duration_s=5,
                                       input_images=("https://example.invalid/f.png",) if cap == I2V else ()),
                     "kling-v2-6")
            self.assertEqual(session.calls[0][2]["json"]["watermark_info"], {"enabled": True}, cap)

    def test_vidu_stores_the_watermarked_copy_and_never_the_plain_one(self):
        session = FakeSession([("GET", "/creations", FakeResp(200, {"state": "success", "creations": [
            {"url": "https://clips.vidu.example/plain.mp4", "watermarked_url": "https://clips.vidu.example/marked.mp4"}]}))])
        a = build_adapter("video.vidu", env=ENV, session=session)
        a.result_hosts = ("vidu.example",)
        res = a.poll(ProviderTask("video.vidu", "viduq3-pro", "t1"))
        self.assertEqual(res.outputs[0].url, "https://clips.vidu.example/marked.mp4")
        session = FakeSession([("GET", "/creations", FakeResp(200, {"state": "success", "creations": [
            {"url": "https://clips.vidu.example/plain.mp4"}]}))])
        a = build_adapter("video.vidu", env=ENV, session=session)
        a.result_hosts = ("vidu.example",)
        with self.assertRaises(AdapterError) as cm:
            a.poll(ProviderTask("video.vidu", "viduq3-pro", "t1"))
        self.assertIn("watermark", cm.exception.message)


# ── 4. storage: a vendor file reaches the library byte for byte ──────────────────────────────────────────

class _Store:
    def __init__(self):
        self.rows = []

    def register(self, **kw):
        self.rows.append(kw)
        return {"id": kw["asset_id"]}


class StorePathTests(unittest.TestCase):
    """The library stores the vendor's file as ``original``, unchanged; the thumbnail and the 480p proxy are
    derived re-encodes beside it (they carry no C2PA: a re-encode cannot keep a signed manifest valid), and they
    are previews, never what a person downloads, exports or publishes as the generated file."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def store(self, data: bytes, name: str, kind: str, **kw):
        src = self.tmp / name
        src.write_bytes(data)
        store = _Store()
        aid = "0b6c8a57-1f8e-4d7c-9a51-6f0e2b9d3c41"
        ml.store_generated(src, asset_id=aid, org_id="org", store=store, media_root=self.tmp / "media", tools=None,
                           provenance={"job_id": "j", "provider": "vendor", "rights": "generated_for_org"},
                           expect_kind=kind, **kw)
        return ml.asset_file(self.tmp / "media", aid, "original"), store.rows[0]

    def test_a_picture_keeps_its_c2pa_manifest_and_xmp_byte_for_byte(self):
        original, row = self.store(VENDOR_PNG, "out.png", "image")
        self.assertEqual(original.read_bytes(), VENDOR_PNG)
        self.assertIn(b"caBX", original.read_bytes())
        self.assertIn(b"trainedAlgorithmicMedia", original.read_bytes())
        self.assertEqual(row["sha256"], hashlib.sha256(VENDOR_PNG).hexdigest())   # the row names the vendor's bytes
        self.assertEqual(row["provenance"]["provider"], "vendor")

    def test_a_clip_keeps_its_c2pa_box_byte_for_byte(self):
        original, row = self.store(VENDOR_MP4, "out.mp4", "video")
        self.assertEqual(original.read_bytes(), VENDOR_MP4)
        self.assertIn(C2PA_UUID, original.read_bytes())
        self.assertEqual(row["bytes"], len(VENDOR_MP4))

    def test_derived_previews_never_replace_the_original(self):
        src = self.tmp / "clip.mp4"
        src.write_bytes(VENDOR_MP4)
        seen = []

        def runner(argv, beat, **kw):
            seen.append(argv)
            Path(argv[-1]).write_bytes(b"\xff\xd8\xff re-encoded preview")      # what ffmpeg would leave
            return 0

        probe = ml.Probe("video", "video/mp4", 2, 2, 1.0)
        store = _Store()
        aid = "1b6c8a57-1f8e-4d7c-9a51-6f0e2b9d3c42"
        ml.store_generated(src, asset_id=aid, org_id="org", store=store, media_root=self.tmp / "media",
                           tools=ml.Tools("ffprobe", "ffmpeg"), provenance={"job_id": "j"}, expect_kind="video",
                           runner=runner, prober=lambda *a, **k: probe)
        self.assertEqual(ml.asset_file(self.tmp / "media", aid, "original").read_bytes(), VENDOR_MP4)
        self.assertEqual(sorted(store.rows[0]["variants"]), ["proxy", "thumb"])
        for argv in seen:                                            # ffmpeg reads the original, never writes it
            self.assertNotEqual(Path(argv[-1]).name, ml.VARIANT_FILES["original"])

    def test_a_picture_returned_inline_is_written_as_the_vendor_sent_it(self):
        # Seedream answers base64: decoding it must not re-encode the picture (its "AI-generated" mark and
        # any C2PA / XMP ride in the bytes).
        session = FakeSession([("POST", "images/generations", FakeResp(200, {"data": [
            {"b64_json": base64.b64encode(VENDOR_PNG).decode()}]}))])
        a = build_adapter("image.seedream", env=ENV, session=session)
        task = a.submit(CapabilityRequest(T2I, "an apple"), "dola-seedream-5-0-pro-260628")
        (path,) = a.fetch(a.poll(task), self.tmp / "out", stem="img")
        self.assertEqual(path.read_bytes(), VENDOR_PNG)
        self.assertIs(session.calls[0][2]["json"]["watermark"], True)

    def test_a_downloaded_result_is_written_as_the_vendor_sent_it(self):
        # The plain download path (Kling, Wan, Runway, ...): bytes in, the same bytes out.
        class Download(FakeResp):
            def iter_content(self, chunk_size=1):
                yield VENDOR_MP4[:20]
                yield VENDOR_MP4[20:]

        url = "https://cdn.kling.example/marked.mp4"
        session = FakeSession(downloads={url: Download(200)})
        a = build_adapter("video.kling", env=ENV, session=session)
        from modules.capabilities.base import Output

        (path,) = a.fetch(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]), self.tmp / "dl", stem="clip")
        self.assertEqual(path.read_bytes(), VENDOR_MP4)


if __name__ == "__main__":
    unittest.main()
