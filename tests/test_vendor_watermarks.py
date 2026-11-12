"""Each maker's own terms decide its watermark; invisible provenance is always kept.

Nightshift's letters to the model makers (sent 2026-11-11) say: "We keep vendor attribution and
watermarks/C2PA". The owner's rule (2026-11-12, option A) for holding to it:

* a mark a maker's terms REQUIRE stays on (none of the adapters here has one: see POLICY);
* an optional visible mark keeps the vendor's DEFAULT: never sent off where the default is on, never
  forced on where the default is off;
* invisible provenance (C2PA, metadata labels, SynthID) is always kept: nothing that replaces a maker's
  label or mark is ever sent (``meta_data``, ``wm_url``), and every vendor file is stored byte for byte.

docs/AI_DISCLOSURE.md ("Vendor watermarks and provenance") is the per-vendor table. No vendor is called:
every request goes to a fake session (tests/test_capabilities.FakeSession).

What would break without these tests:

* a default-on mark (HappyHorse, Seedream) sent off, or an optional default-off mark forced on;
* a field that replaces the maker's own label or mark with ours, or code that strips provenance;
* a constant or setting that switches a vendor watermark (``WATERMARK``, ``STORE_WATERMARKED``);
* a new adapter (or field) that touches a vendor mark without a row in POLICY;
* Kling or Vidu storing something other than the vendor's default output;
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
from typing import List, Tuple

from modules import media_library as ml
from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities.base import (
    EDIT,
    I2V,
    SUCCEEDED,
    T2I,
    CapabilityRequest,
    PollResult,
    ProviderTask,
)
from tests.test_capabilities import ENV, FakeResp, FakeSession

ROOT = Path(__file__).resolve().parent.parent

#: Request fields that switch a visible mark.
WATERMARK_FIELDS = {"watermark", "add_watermark", "aigc_watermark", "enable_watermark", "logo_add", "watermark_info"}
#: Fields that replace a maker's own provenance label or mark with ours: never sent, by anyone.
NEVER_SENT = {"wm_url", "meta_data"}
#: Words that name stripping provenance or a mark. No code path may do it.
STRIP_WORDS = ("no_watermark", "nowatermark", "watermark_free", "without_watermark", "remove_watermark",
               "strip_watermark", "strip_c2pa", "remove_c2pa", "strip_metadata", "map_metadata -1")


def provenance_offences(obj, path: str = "$"):
    """Every place in a request body that replaces a maker's label or mark."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in NEVER_SENT:
                yield f"{path}.{k} is sent"
            yield from provenance_offences(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from provenance_offences(v, f"{path}[{i}]")


def watermark_fields(obj, path: str = "$"):
    """(path, value) of every watermark switch in a request body."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in WATERMARK_FIELDS:
                yield f"{path}.{k}", v
            yield from watermark_fields(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from watermark_fields(v, f"{path}[{i}]")


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



# ── 1. the source: nothing strips provenance, and nothing switches a vendor mark ─────────────────────────

def _python_sources() -> List[Path]:
    files = [ROOT / "main.py", ROOT / "config.py"]
    for top in ("modules", "tools"):
        files += sorted((ROOT / top).rglob("*.py"))
    return [f for f in files if f.is_file() and "__pycache__" not in f.parts]


def _key(node) -> str:
    return node.value.lower() if isinstance(node, ast.Constant) and isinstance(node.value, str) else ""


def source_offences(path: Path, root: Path = ROOT) -> List[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    rel = path.relative_to(root)
    found: List[str] = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        keys: List[str] = []
        if isinstance(node, ast.Dict):
            keys = [_key(k) for k in node.keys if k is not None]
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Subscript):
                    keys.append(_key(target.slice))
                if isinstance(target, ast.Name) and "WATERMARK" in target.id.upper():
                    found.append(f"{rel}:{line}: {target.id} is a switch for a vendor watermark")
        elif isinstance(node, ast.Call):
            keys = [(kw.arg or "").lower() for kw in node.keywords]
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            low = node.value.lower()
            found += [f"{rel}:{line}: strips provenance or a mark ({w!r})" for w in STRIP_WORDS if w in low]
        found += [f"{rel}:{line}: {k!r} replaces the maker's label or mark" for k in keys if k in NEVER_SENT]
    return found


class SourceGuardTests(unittest.TestCase):
    def test_the_guard_reads_the_code_it_claims_to(self):
        names = {p.relative_to(ROOT).as_posix() for p in _python_sources()}
        for must in ("modules/capabilities/alibaba.py", "modules/capabilities/vidu.py", "modules/capabilities/video.py",
                     "modules/capabilities/image.py", "modules/video_providers.py", "modules/media_library.py", "main.py"):
            self.assertIn(must, names)

    def test_no_code_strips_provenance_replaces_a_label_or_keeps_a_watermark_switch(self):
        found = [o for f in _python_sources() for o in source_offences(f)]
        self.assertEqual(found, [], "\n".join(found))

    def test_the_guard_itself_catches_each_way_back(self):
        bad = {'{"meta_data": "{}"}': "meta_data", 'body["wm_url"] = ours': "wm_url", 'call(meta_data=x)': "meta_data",
               'STORE_WATERMARKED = False': "STORE_WATERMARKED", 'WATERMARK = True': "WATERMARK",
               'argv = ["-map_metadata -1"]': "map_metadata", 'key = "url_no_watermark"': "no_watermark"}
        for code, word in {**bad, '{"watermark": True}': None, 'key = "watermarked_url"': None}.items():
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / "x.py"
                p.write_text(code + "\n", encoding="utf-8")
                found = source_offences(p, Path(tmp))
            if word is None:
                self.assertEqual(found, [], code)
            else:
                self.assertTrue(found and word in found[0], f"{code!r} was not caught: {found}")


# ── 2. what every adapter actually sends: each registry model's probe request ─────────────────────────────

#: adapter -> (terms require the visible mark?, the vendor's default, where we send it, what we send).
#: ``None`` as "what we send" means the field is not sent, so the vendor's default applies. Read 2026-11-11;
#: the adapters cite the pages. A REQUIRED mark would be sent on whatever its default; none here is.
POLICY = {
    "video.happyhorse": (False, "on", ("parameters", "watermark"), True),
    "image.dashscope": (False, "off", ("parameters", "watermark"), None),     # Qwen; Z-Image has no field
    "video.wan": (False, "off", ("parameters", "watermark"), None),
    "video.seedance": (False, "off", ("watermark",), None),
    "video.seedance2": (False, "off", ("watermark",), None),
    "image.seedream": (False, "on", ("watermark",), True),
    "video.kling": (False, "off", ("watermark_info",), None),
    "video.vidu": (False, "off", ("watermark",), None),                       # visible mark; its label is kept
}
_GENERIC = FakeResp(200, {})
_MISSING = object()


def _dig(body, path):
    for p in path:
        body = body.get(p, _MISSING) if isinstance(body, dict) else _MISSING
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
        session = FakeSession([(m, "", _GENERIC) for m in ("POST", "GET", "PUT", "DELETE", "PATCH")], downloads={})
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
        except Exception:                                          # noqa: BLE001 — the empty answer is not a task
            pass
        return sent_bodies(session)

    def test_no_model_sends_anything_that_replaces_the_makers_label_or_mark(self):
        offences, sent = [], 0
        for entry in reg.registry().values():
            for where, body in self.submit_probe(entry):
                sent += 1
                offences += [f"{entry.id} ({entry.adapter}) {where}: {o}" for o in provenance_offences(body)]
        self.assertGreater(sent, 50)                               # the sweep reached most of the catalogue
        self.assertEqual(offences, [], "\n".join(offences))

    def test_a_watermark_switch_is_sent_only_by_an_adapter_with_a_policy_row(self):
        found = []
        for entry in reg.registry().values():
            if entry.adapter in POLICY:
                continue
            for where, body in self.submit_probe(entry):
                found += [f"{entry.id} {where}: {p} = {v!r}" for p, v in watermark_fields(body)]
        self.assertEqual(found, [], "\n".join(found))

    def test_every_model_sends_its_vendors_default_and_never_turns_a_default_on_mark_off(self):
        seen = set()
        for entry in reg.registry().values():
            if entry.adapter not in POLICY:
                continue
            required, default, path, sent = POLICY[entry.adapter]
            for cap in entry.capabilities:
                bodies = [b for _, b in self.submit_probe(entry, cap) if isinstance(b, dict)
                          and ("model" in b or "model_name" in b)]
                self.assertTrue(bodies, f"{entry.id} {cap}: nothing was sent")
                got = _dig(bodies[0], path)
                if required or default == "on":
                    self.assertIn(got, (True, {"enabled": True}, _MISSING), f"{entry.id} {cap}: turned off")
                if sent is None:
                    self.assertIs(got, _MISSING, f"{entry.id} {cap}: {'.'.join(path)} should be the vendor's default")
                else:
                    self.assertEqual(got, sent, f"{entry.id} {cap}: {'.'.join(path)} is {got!r}")
                seen.add(entry.adapter)
        self.assertEqual(seen, set(POLICY))                        # every row still has a model

    def test_an_adapter_that_names_a_watermark_field_has_a_policy_row(self):
        for key, cls in ADAPTERS.items():
            src = inspect.getsource(cls).lower()
            if re.search(r"""["'](?:add_|aigc_|enable_)?watermark(?:_info)?["']|["']logo_add["']""", src):
                self.assertIn(key, POLICY, key)

    def test_no_adapter_class_carries_a_watermark_switch(self):
        for key, cls in ADAPTERS.items():
            for name in dir(cls):
                self.assertNotIn("WATERMARK", name.upper(), f"{key}.{name}")


# ── 3. links: Kling and Vidu store the vendor's default output (their terms require no visible mark) ─────

class DefaultOutputTests(unittest.TestCase):
    def test_kling_stores_its_default_output(self):
        a = build_adapter("video.kling", env=ENV, session=FakeSession([("GET", "text2video/abc", FakeResp(200, {
            "code": 0, "data": {"task_status": "succeed", "task_result": {"videos": [
                {"id": "v", "url": "https://cdn.kling.example/clip.mp4",
                 "watermark_url": "https://cdn.kling.example/marked.mp4"}]}}}))]))
        res = a.poll(ProviderTask("video.kling", "kling-v2-6", "text2video/abc"))
        self.assertEqual((res.state, res.outputs[0].url), (SUCCEEDED, "https://cdn.kling.example/clip.mp4"))

    def test_vidu_stores_its_default_output_and_never_replaces_its_label(self):
        session = FakeSession([("GET", "/creations", FakeResp(200, {"state": "success", "creations": [
            {"url": "https://clips.vidu.example/clip.mp4", "watermarked_url": "https://clips.vidu.example/marked.mp4"}]}))])
        a = build_adapter("video.vidu", env=ENV, session=session)
        a.result_hosts = ("vidu.example",)
        res = a.poll(ProviderTask("video.vidu", "viduq3-pro", "t1"))
        self.assertEqual((res.state, res.outputs[0].url), (SUCCEEDED, "https://clips.vidu.example/clip.mp4"))


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

    def test_a_muse_image_picture_keeps_whatever_meta_put_in_it_byte_for_byte(self):
        # Meta's AUP bars removing or altering "any watermark, label, metadata, or other provenance signal". The docs do not
        # say whether one is applied, so the answer's base64 is decoded and stored as is, and nothing that could switch or
        # replace a mark is sent (docs/AI_DISCLOSURE.md row `image.meta`).
        session = FakeSession([("POST", "/responses", FakeResp(200, {"status": "completed", "output": [
            {"type": "image_generation_call", "id": "ig_1", "status": "completed",
             "result": base64.b64encode(VENDOR_PNG).decode()}]}))])
        a = build_adapter("image.meta", env=ENV, session=session)
        task = a.submit(CapabilityRequest(T2I, "an apple", aspect_ratio="1:1"), "muse-image-1.0")
        (path,) = a.fetch(a.poll(task), self.tmp / "out", stem="img")
        self.assertEqual(path.read_bytes(), VENDOR_PNG)
        self.assertIn(b"caBX", path.read_bytes())
        body = session.calls[0][2]["json"]
        self.assertEqual(list(provenance_offences(body)), [])
        self.assertEqual(list(watermark_fields(body)), [])
        self.assertIs(body["store"], False)

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
