"""Meta Model API, Muse Image (first party): the adapter, the registry entry, and the rule that none of it is for sale.

The adapter talks to a REAL HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py): no network, no key, no spend.

What would break without these tests:

* a request without ``store: false`` (Meta would keep the response), or one sent to the images endpoints, which refuse
  ``store`` as an unknown field;
* a field the docs do not show (``n``, ``output_format``, a watermark switch...) slipping into the body;
* an aspect ratio past 16:1, an image size the vendor never states, an 11th picture or a URL reaching the vendor;
* a prompt that asks for a real or famous person, a deepfake or a child being sent (the AUP; Character Studio's screen);
* Meta's name reaching a person through an error message (ToS 7), or appearing in the registry's id or display name;
* a refusal, a lost answer and an answer with no picture all read as the same thing;
* the model becoming sellable, priced, or exposed on the public API.
"""

from __future__ import annotations

import base64
import io
import re
import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import model_registry as reg
from modules.capabilities import ADAPTERS, build_adapter
from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_CONFIGURED,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    E_VENDOR_TOOL_UNSUPPORTED,
    EDIT,
    SUCCEEDED,
    T2I,
    AdapterError,
    CapabilityRequest,
)
import os

from modules.capabilities import meta as meta_mod
from modules.capabilities.meta import (MAX_RATIO, MAX_IMAGE_BYTES, TOOL_REFUSED, MuseImageAdapter, ratio_size,
                                       real_person_problem)
from modules.capabilities.safe_fetch import AFTER_COMPLETION, UNCONFIRMED
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate

ROOT = Path(__file__).resolve().parent.parent
KEY = "LLM_1234567890_NOT-A-REAL-KEY-abcdef"
MID, VENDOR = "grounded-image-1.0", "muse-image-1.0"
RESPONSES = "/v1/responses"
BRAND = re.compile(r"(?i)\b(meta|muse)\b")


def tearDownModule():
    cleanup_certificate()


def picture(fmt: str = "PNG", color=(200, 30, 30)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, fmt)
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def answer(*images: bytes, status: str = "completed") -> dict:
    """The documented shape: a reasoning summary, the assistant message, one image_generation_call per picture."""
    out = [{"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "Planned it."}],
            "status": "completed"},
           {"type": "message", "id": "msg_1", "role": "assistant", "content": [], "status": "completed"}]
    out += [{"type": "image_generation_call", "id": f"ig_{i}", "status": "completed", "result": b64(img)}
            for i, img in enumerate(images)]
    return {"id": "resp_1", "object": "response", "status": status, "output": out}


def t2i(**kw) -> CapabilityRequest:
    return CapabilityRequest(**{**dict(capability=T2I, prompt="a red apple on a white table"), **kw})


class VendorCase(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="muse_test_"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.env = {"META_API_KEY": KEY, "META_BASE_URL": self.vendor.base_url + "/v1"}
        self.vendor.on("POST", RESPONSES, Resp(200, answer(picture("WEBP"))))

    def adapter(self, env=None) -> MuseImageAdapter:
        return build_adapter("image.meta", env=env or self.env, session=self.vendor.session())

    def file(self, name="ref.png", data=None) -> str:
        p = self.tmp / name
        p.write_bytes(picture() if data is None else data)
        return str(p)

    def sent(self) -> dict:
        (req,) = self.vendor.seen("POST", RESPONSES)
        return req.json()

    def answers(self, resp: Resp):
        self.vendor._routes.clear()
        self.vendor.on("POST", RESPONSES, resp)


# ── the request ────────────────────────────────────────────────────────────────

class RequestShapeTests(VendorCase):
    def test_text_to_image_is_the_minimal_documented_body_with_store_false(self):
        a = self.adapter()
        task = a.submit(t2i(), VENDOR)
        (req,) = self.vendor.seen("POST", RESPONSES)
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual(req.json(), {"model": VENDOR, "store": False, "input": "a red apple on a white table"})
        self.assertIsNone(task.task_id)                                   # synchronous: finished inside submit
        self.assertEqual(self.vendor.seen("POST", "/v1/images"), [])      # never the endpoints that refuse `store`

    def test_store_false_is_on_every_request_whatever_the_job(self):
        a = self.adapter()
        a.submit(t2i(aspect_ratio="16:9", end_user="u" * 32), VENDOR)
        a.submit(CapabilityRequest(EDIT, "make it night", input_images=(self.file(),)), VENDOR)
        bodies = [r.json() for r in self.vendor.seen("POST", RESPONSES)]
        self.assertEqual([b["store"] for b in bodies], [False, False])
        for b in bodies:
            self.assertIs(b["store"], False)                              # the boolean, not a string

    def test_an_aspect_ratio_rides_in_the_image_generation_tool_as_an_exact_size(self):
        self.adapter().submit(t2i(aspect_ratio="16:9"), VENDOR)
        self.assertEqual(self.sent()["tools"], [{"type": "image_generation", "size": "1024x576"}])

    def test_no_aspect_ratio_sends_no_tool_so_the_vendors_default_shape_applies(self):
        self.adapter().submit(t2i(), VENDOR)
        self.assertNotIn("tools", self.sent())

    def test_only_documented_fields_are_sent_and_nothing_a_mark_or_label_could_hang_on(self):
        self.adapter().submit(t2i(aspect_ratio="1:1", end_user="abc"), VENDOR)
        body = self.sent()
        self.assertEqual(set(body), {"model", "store", "input", "tools", "safety_identifier"})
        self.assertEqual(set(body["tools"][0]), {"type", "size"})       # no output_format, no reasoning or tool switches

    def test_pictures_ride_as_input_image_parts_after_the_words_labelled_by_their_bytes(self):
        png, jpg = self.file("a.png"), self.file("b.jpg", picture("JPEG"))
        self.adapter().submit(CapabilityRequest(EDIT, "  put the fox next to the mug  ", input_images=(png, jpg)), VENDOR)
        (msg,) = self.sent()["input"]
        self.assertEqual(msg["role"], "user")
        content = msg["content"]
        self.assertEqual(content[0], {"type": "input_text", "text": "put the fox next to the mug"})
        self.assertEqual([c["type"] for c in content[1:]], ["input_image", "input_image"])
        self.assertTrue(content[1]["image_url"].startswith("data:image/png;base64,"))
        self.assertTrue(content[2]["image_url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(base64.b64decode(content[1]["image_url"].split(",", 1)[1]), picture())

    def test_text_to_image_with_style_references_sends_them_too(self):
        self.adapter().submit(t2i(input_images=(self.file(),)), VENDOR)
        self.assertEqual([c["type"] for c in self.sent()["input"][0]["content"]], ["input_text", "input_image"])

    def test_the_end_user_id_is_sent_as_safety_identifier_only_when_it_is_a_plain_token(self):
        self.adapter().submit(t2i(end_user="b" * 64), VENDOR)
        self.assertEqual(self.sent()["safety_identifier"], "b" * 64)
        for bad in ("someone@example.com", "b" * 65, "a b", ""):
            self.vendor.requests.clear()
            self.adapter().submit(t2i(end_user=bad), VENDOR)
            self.assertNotIn("safety_identifier", self.sent(), bad)
            self.assertNotIn("user", self.sent(), bad)


class RatioTests(unittest.TestCase):
    def test_the_size_keeps_the_exact_ratio_with_a_long_side_of_about_1024(self):
        for ratio, size in {"1:1": "1024x1024", "16:9": "1024x576", "9:16": "576x1024", "4:3": "1024x768",
                            "3:2": "1026x684", "21:9": "1029x441", "9:21": "441x1029", "16:1": "1024x64"}.items():
            self.assertEqual(ratio_size(ratio), size, ratio)
            w, h = map(int, size.split("x"))
            a, b = map(int, ratio.split(":"))
            self.assertEqual(w * b, h * a, ratio)                        # the shape asked for, exactly

    def test_past_16_to_1_either_way_or_not_a_ratio_is_none(self):
        self.assertEqual(MAX_RATIO, 16)
        for bad in ("17:1", "1:17", "33:2", "0:1", "1:0", "16x9", "16:9:1", "", None, "a:b", "100:1"):
            self.assertIsNone(ratio_size(bad), bad)


class RefusedBeforeAnyCallTests(VendorCase):
    def refused(self, req, model=VENDOR, fragment="", code=E_BAD_REQUEST):
        with self.assertRaises(AdapterError, msg=(model, req)) as cm:
            self.adapter().submit(req, model)
        self.assertEqual(cm.exception.code, code)
        self.assertTrue(cm.exception.not_accepted)                        # nothing left this process
        self.assertIn(fragment, cm.exception.message)
        return cm.exception

    def test_ratios_past_16_to_1_and_ratios_not_offered_are_refused_never_clamped(self):
        self.refused(t2i(aspect_ratio="17:1"), fragment="at most 16:1")
        self.refused(t2i(aspect_ratio="1:20"), fragment="at most 16:1")
        self.refused(t2i(aspect_ratio="16:1"), fragment="not offered")    # the vendor takes it; the registry does not list it
        self.refused(t2i(aspect_ratio="19.5:9"), fragment="at most 16:1")
        self.assertEqual(self.vendor.requests, [])

    def test_an_image_size_is_refused_because_the_vendor_never_states_its_resolution(self):
        self.refused(t2i(image_size="1K"), fragment="its own resolution")

    def test_reference_pictures_one_to_ten_files_from_the_library(self):
        ten = tuple(self.file(f"r{i}.png") for i in range(10))
        self.adapter().submit(CapabilityRequest(EDIT, "compose them", input_images=ten), VENDOR)
        self.assertEqual(len(self.sent()["input"][0]["content"]), 11)
        self.vendor.requests.clear()
        self.refused(CapabilityRequest(EDIT, "x", input_images=ten + (self.file("r10.png"),)), fragment="at most 10")
        self.refused(CapabilityRequest(EDIT, "x"), fragment="at least one picture")
        self.refused(CapabilityRequest(EDIT, "x", input_images=("https://example.com/a.png",)), fragment="not https URLs")
        self.refused(CapabilityRequest(EDIT, "x", input_images=(self.file("a.gif"),)), fragment="PNG, JPEG or WebP")
        self.refused(CapabilityRequest(EDIT, "x", input_images=(self.file("fake.png", b"%PDF-1.7 not a picture"),)),
                     fragment="its bytes say otherwise")
        self.assertEqual(self.vendor.requests, [])

    def test_a_path_that_is_not_a_regular_file_is_refused_and_never_read(self):
        real = self.file("real.png")
        link = self.tmp / "link.png"
        os.symlink(real, link)                                            # even a link to a real picture
        dev = self.tmp / "zero.png"
        os.symlink("/dev/zero", dev)                                      # a device would read forever
        fifo = self.tmp / "pipe.png"
        os.mkfifo(fifo)                                                   # a FIFO would block the open
        folder = self.tmp / "dir.png"
        folder.mkdir()
        for bad in (link, dev, fifo, folder):
            self.refused(CapabilityRequest(EDIT, "x", input_images=(str(bad),)), fragment="not a regular file")
            with self.assertRaises(AdapterError, msg=str(bad)) as cm:
                meta_mod._picture_part(str(bad))
            self.assertEqual(cm.exception.code, E_BAD_REQUEST)
            self.assertTrue(cm.exception.not_accepted)
            self.assertIn("not a regular file", cm.exception.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_read_is_capped_at_the_limit_even_when_the_file_is_bigger_than_its_check(self):
        big = self.file("grown.png", picture() + b"\x00" * MAX_IMAGE_BYTES)
        with self.assertRaises(AdapterError) as cm:
            meta_mod._read_picture(big)
        self.assertIn("over 15 MB", cm.exception.message)
        reads = []
        real_fdopen = os.fdopen

        class Spy:
            def __init__(self, fh):
                self.fh = fh

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.fh.close()

            def read(self, n=-1):
                reads.append(n)
                return self.fh.read(n)

        from unittest import mock
        with mock.patch.object(meta_mod.os, "fstat", lambda fd: os.stat_result((0o100644, 0, 0, 1, 0, 0, 10, 0, 0, 0))), \
                mock.patch.object(meta_mod.os, "fdopen", lambda fd, mode: Spy(real_fdopen(fd, mode))):
            with self.assertRaises(AdapterError):                         # the size said 10 bytes; the file has more
                meta_mod._read_picture(big)
        self.assertEqual(reads, [MAX_IMAGE_BYTES + 1])                     # never an unbounded read

    def test_a_picture_over_15_mb_or_pictures_over_36_mb_together_are_refused(self):
        big = self.file("big.png", picture() + b"\x00" * (15 * 1024 * 1024))
        self.refused(CapabilityRequest(EDIT, "x", input_images=(big,)), fragment="over 15 MB")
        six = tuple(self.file(f"m{i}.png", picture() + b"\x00" * (7 * 1024 * 1024)) for i in range(6))
        self.refused(CapabilityRequest(EDIT, "x", input_images=six), fragment="over 36 MB together")

    def test_what_the_model_does_not_take_is_refused_not_dropped(self):
        self.refused(t2i(negative_prompt="no text"), fragment="negative prompt")
        self.refused(t2i(prompt="   "), fragment="prompt is empty")
        self.refused(t2i(), model="muse-image-2.0", fragment="not a model this adapter knows")
        self.refused(CapabilityRequest("t2v", "a boat"), fragment="cannot do t2v")

    def test_a_prompt_that_reads_as_a_real_person_a_deepfake_or_a_child_is_never_sent(self):
        for prompt in ("a photo of a famous actor at the beach", "a deepfake of the president", "Taylor, a celebrity",
                       "make him look like a real person I know", "two children on a swing", "знаменитый певец",
                       "mashhur aktyor portreti"):
            e = self.refused(t2i(prompt=prompt), fragment="real or famous person", code=E_POLICY)
            self.assertIn("nothing was sent", e.message)
        self.assertEqual(self.vendor.requests, [])

    def test_the_screen_is_character_studios_and_passes_ordinary_prompts(self):
        self.assertFalse(real_person_problem("a red apple on a white table"))
        self.assertFalse(real_person_problem("a watercolor fox in the snow, golden hour"))
        self.assertTrue(real_person_problem("a lookalike of a footballer"))

    def test_no_key_is_a_refusal_before_any_call(self):
        with self.assertRaises(AdapterError) as cm:
            self.adapter(env={"META_BASE_URL": self.env["META_BASE_URL"]}).submit(t2i(), VENDOR)
        self.assertEqual(cm.exception.code, E_NOT_CONFIGURED)
        self.assertIn("META_API_KEY", cm.exception.message)
        self.assertTrue(cm.exception.not_accepted)
        self.assertEqual(self.vendor.requests, [])


# ── the answer ─────────────────────────────────────────────────────────────────

class AnswerTests(VendorCase):
    def test_the_picture_comes_back_inline_and_is_stored_byte_for_byte(self):
        webp = picture("WEBP")
        a = self.adapter()
        task = a.submit(t2i(), VENDOR)
        res = a.poll(task)
        self.assertEqual(res.state, SUCCEEDED)
        (path,) = a.fetch(res, self.tmp / "out", stem="img")
        self.assertEqual(path.suffix, ".webp")                            # the bytes decide the type
        self.assertEqual(path.read_bytes(), webp)                         # never re-encoded: provenance survives

    def test_every_picture_the_answer_carries_is_handed_back_because_each_is_billed(self):
        self.answers(Resp(200, answer(picture("WEBP"), picture("PNG", (1, 2, 3)))))
        task = self.adapter().submit(t2i(), VENDOR)
        self.assertEqual([o.mime for o in task.outputs], ["image/webp", "image/png"])

    def test_an_answer_without_a_usable_picture_may_have_billed(self):
        for body in ({"status": "completed", "output": []},
                     {"status": "completed", "output": [{"type": "message", "content": []}]},
                     {"status": "completed", "output": [{"type": "image_generation_call", "result": ""}]},
                     {"status": "completed", "output": [{"type": "image_generation_call", "result": b64(b"<html>x</html>")}]},
                     {"status": "in_progress", "output": []}, {"output": "nope"}, [], {}):
            self.answers(Resp(200, body))
            with self.assertRaises(AdapterError, msg=repr(body)) as cm:
                self.adapter().submit(t2i(), VENDOR)
            self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
            self.assertFalse(cm.exception.not_accepted)
            # No picture: the vendor may be billing it. A picture we could not read: it finished, and was billed.
            self.assertTrue(cm.exception.message.startswith((UNCONFIRMED, AFTER_COMPLETION)), cm.exception.message)

    def test_a_finished_picture_in_an_incomplete_or_failed_answer_is_kept_because_it_was_billed(self):
        good = picture("WEBP")
        for status in ("incomplete", "failed", "cancelled", "in_progress"):
            body = answer(good, status=status)
            body["error"] = {"code": "server_error", "message": "stopped"}
            self.answers(Resp(200, body))
            task = self.adapter().submit(t2i(), VENDOR)
            self.assertEqual([o.data for o in task.outputs], [good], status)

    def test_an_incomplete_answer_with_no_picture_says_the_spend_may_have_happened(self):
        for status, err, code in (("incomplete", None, E_UNAVAILABLE),
                                  ("incomplete", {"code": "server_error", "message": "cut"}, E_UNAVAILABLE),
                                  ("failed", {"code": "image_content_policy_violation", "message": "no"}, E_POLICY)):
            body = {"status": status, "output": [{"type": "reasoning", "summary": []}]}
            if err:
                body["error"] = err
            self.answers(Resp(200, body))
            with self.assertRaises(AdapterError, msg=status) as cm:
                self.adapter().submit(t2i(), VENDOR)
            self.assertEqual(cm.exception.code, code)
            self.assertFalse(cm.exception.not_accepted)
            self.assertTrue(cm.exception.message.startswith(UNCONFIRMED), cm.exception.message)

    def test_one_corrupt_picture_does_not_lose_the_good_billed_ones_and_is_reported(self):
        good = picture("PNG")
        body = answer(good, picture("WEBP", (9, 9, 9)))
        body["output"].insert(2, {"type": "image_generation_call", "id": "ig_bad", "status": "completed",
                                  "result": b64(b"<html>not a picture</html>")})
        self.answers(Resp(200, body))
        with self.assertLogs("modules.capabilities.meta", level="WARNING") as logs:
            task = self.adapter().submit(t2i(), VENDOR)
        self.assertEqual([o.mime for o in task.outputs], ["image/png", "image/webp"])
        self.assertEqual(task.outputs[0].data, good)
        self.assertIn("image 1 is not a PNG, JPEG or WebP file", "\n".join(logs.output))
        self.assertIn("kept 2 image(s)", "\n".join(logs.output))

    def test_only_corrupt_pictures_is_a_completed_billed_failure(self):
        body = {"status": "completed", "output": [
            {"type": "image_generation_call", "status": "completed", "result": b64(b"%PDF-1.7")},
            {"type": "image_generation_call", "status": "completed", "result": b64(b"GIF89a....")}]}
        self.answers(Resp(200, body))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), VENDOR)
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertTrue(cm.exception.message.startswith(AFTER_COMPLETION), cm.exception.message)
        self.assertIn("image 1", cm.exception.message)
        self.assertIn("image 2", cm.exception.message)

    def test_a_failed_response_carries_the_vendors_code_and_the_right_remedy(self):
        for code, ours in (("image_content_policy_violation", E_POLICY), ("rate_limit_exceeded", E_RATE_LIMITED),
                           ("invalid_image_format", E_BAD_REQUEST), ("server_error", E_UNAVAILABLE)):
            self.answers(Resp(200, {"status": "failed", "error": {"code": code, "message": "no"}, "output": []}))
            with self.assertRaises(AdapterError, msg=code) as cm:
                self.adapter().submit(t2i(), VENDOR)
            self.assertEqual(cm.exception.code, ours, code)


class ErrorMappingTests(VendorCase):
    def error(self, status, err=None, raw=None):
        self.answers(Resp(status, {"error": err} if err is not None else None, raw=raw))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), VENDOR)
        return cm.exception

    def test_the_documented_envelope_decides_the_remedy(self):
        cases = (
            (400, {"type": "invalid_request_error", "code": "content_policy_violation", "param": "prompt",
                   "message": "blocked"}, E_POLICY, False),
            (400, {"type": "invalid_request_error", "param": "size", "code": None, "message": "ratio"}, E_BAD_REQUEST, False),
            (401, {"type": "authentication_error", "code": "invalid_api_key", "message": "Unauthorized"}, E_AUTH, True),
            (402, {"type": "billing_error", "code": "billing_not_configured", "message": "Billing"}, E_QUOTA, True),
            (403, {"type": "invalid_request_error", "code": None, "message": "no access"}, E_AUTH, True),
            (404, {"type": "invalid_request_error", "code": "model_not_found", "message": "no"}, E_NOT_FOUND, True),
            (413, {"type": "invalid_request_error", "code": "payload_too_large", "message": "big"}, E_BAD_REQUEST, False),
            (415, {"code": "unsupported_media_type", "message": "json"}, E_BAD_REQUEST, False),
            (429, {"type": "rate_limit_error", "code": "rate_limit_exceeded", "message": "slow"}, E_RATE_LIMITED, True),
        )
        for status, err, code, proof in cases:
            e = self.error(status, err)
            self.assertEqual(e.code, code, (status, err))
            self.assertEqual(e.not_accepted, proof, (status, err))       # only an outright refusal proves nothing was bought
            self.assertEqual(e.http_status, status)

    def test_the_vendor_refusing_the_image_tool_has_its_own_code_a_clear_message_and_no_retry(self):
        # The first real probe's answer, byte for byte (Actions run 43286239903, 2026-11-12).
        refused = {"code": None, "message": "Unsupported tool type: 'image_generation'", "param": "tools",
                   "type": "invalid_request_error"}
        self.answers(Resp(400, {"error": refused}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(aspect_ratio="16:9"), VENDOR)
        e = cm.exception
        self.assertEqual((e.code, e.http_status), (E_VENDOR_TOOL_UNSUPPORTED, 400))
        self.assertTrue(e.message.startswith(TOOL_REFUSED), e.message)    # the reason first, for the Studio and the log
        self.assertIn("nothing was charged", e.message)
        self.assertIn("Unsupported tool type: 'image_generation'", e.message)   # the vendor's words, for the operator
        self.assertNotRegex(e.message, BRAND)
        self.assertNotIn(KEY, e.message)
        self.assertFalse(e.retryable)
        self.assertFalse(e.not_accepted)                                  # a 400 is never taken as proof (as above)
        (only,) = self.vendor.seen("POST", RESPONSES)                     # exactly one call: no silent retry without the tool
        self.assertEqual(only.json()["tools"], [{"type": "image_generation", "size": "1024x576"}])

    def test_only_a_400_naming_the_tools_param_is_the_tool_refusal(self):
        for status, err, code in (
                (400, {"type": "invalid_request_error", "param": "size", "code": None, "message": "ratio"}, E_BAD_REQUEST),
                (400, {"type": "invalid_request_error", "param": None, "code": None, "message": "bad"}, E_BAD_REQUEST),
                (400, {"type": "invalid_request_error", "param": "tools", "code": "content_policy_violation",
                       "message": "blocked"}, E_POLICY),
                (400, {"type": "invalid_request_error", "param": "TOOLS", "code": None, "message": "x"},
                 E_VENDOR_TOOL_UNSUPPORTED),
                (422, {"type": "invalid_request_error", "param": "tools", "code": None, "message": "x"}, E_BAD_REQUEST)):
            self.assertEqual(self.error(status, err).code, code, (status, err))

    def test_a_404_with_an_empty_body_is_not_found(self):
        self.assertEqual(self.error(404, raw=b"").code, E_NOT_FOUND)

    def test_overload_and_5xx_may_have_billed_and_say_so(self):
        for status, err in ((503, {"type": "server_error", "code": "service_overloaded", "message": "busy"}),
                            (500, {"type": "server_error", "code": None, "message": "oops"})):
            e = self.error(status, err)
            self.assertEqual(e.code, E_UNAVAILABLE)
            self.assertFalse(e.not_accepted)
            self.assertTrue(e.message.startswith(UNCONFIRMED))

    def test_a_lost_answer_may_have_billed(self):
        self.answers(Resp(drop=True))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), VENDOR)
        self.assertFalse(cm.exception.not_accepted)
        self.assertTrue(cm.exception.message.startswith(UNCONFIRMED))

    def test_every_form_of_the_makers_name_is_replaced(self):
        for text in ("MetaAI refused it", "metaai", "Meta AI said no", "Meta-AI", "META", "Meta's filter", "Meta\u2019s filter",
                     "MetaAI's policy", "Muse Image", "MuseImage", "muse-image-1.0", "Muse", "Llama"):
            out = meta_mod._debrand(text)
            self.assertNotRegex(out, r"(?i)meta|muse|llama", text)
            self.assertIn("the vendor", out, text)
        for kept in ("metadata", "metamorphosis", "amused", "museum"):
            self.assertEqual(meta_mod._debrand(kept), kept)

    def test_no_message_names_the_maker_and_the_key_is_scrubbed(self):
        e = self.error(400, {"code": "content_policy_violation",
                             "message": f"Meta's Muse Image refused it under Meta policy; key {KEY}"})
        self.assertNotRegex(e.message, BRAND)
        self.assertNotIn(KEY, e.message)
        self.assertIn("the vendor", e.message)
        self.answers(Resp(200, {"status": "failed", "error": {"code": "server_error", "message": "Muse-Image backend"}}))
        with self.assertRaises(AdapterError) as cm:
            self.adapter().submit(t2i(), VENDOR)
        self.assertNotRegex(cm.exception.message, BRAND)


# ── the registry: hidden, gated, unpriced, neutral ─────────────────────────────

class RegistryEntryTests(unittest.TestCase):
    def setUp(self):
        self.e = reg.load()[MID]

    def test_one_entry_on_this_adapter_with_the_vendors_model_id(self):
        self.assertEqual((self.e.adapter, self.e.provider, self.e.vendor_model), ("image.meta", "meta", VENDOR))
        self.assertEqual(tuple(self.e.capabilities), (T2I, EDIT))
        self.assertEqual([m.id for m in reg.load().values() if m.adapter == "image.meta"], [MID])
        self.assertEqual(self.e.image_refs_max, MuseImageAdapter.MAX_IMAGES)

    def test_no_meta_name_in_what_a_customer_could_see(self):
        # ToS 7: no Meta name or mark. The id rides in URLs and credit units; the display name is the Studio's label.
        for value in (self.e.id, self.e.display_name, self.e.credit_unit):
            self.assertNotRegex(value.replace("_", " "), BRAND, value)
        self.assertIsNone(self.e.raw["attribution"])

    def test_it_cannot_be_sold_used_on_the_public_api_or_priced(self):
        self.assertEqual(self.e.terms_gate, "terms_review_required")
        self.assertEqual(self.e.api_exposure, "web_only")
        p = self.e.raw["pricing"]
        self.assertEqual((p["unit"], p["provider_usd_per_unit"], p["confirmed"]), ("image", 0.01, False))
        self.assertTrue(p["source_url"].startswith("https://dev.meta.ai/"))
        self.assertIn("not on sale", p["note"])
        hits = []
        for folder in ("supabase/migrations", "docs/sql", "deploy", "command-center/lib"):
            for path in (ROOT / folder).rglob("*"):
                if path.is_file() and path.suffix in (".sql", ".ts", ".json", ".yml", ".txt"):
                    if re.search(rf"\b{self.e.credit_unit}\b", path.read_text(errors="ignore")):
                        hits.append(str(path.relative_to(ROOT)))
        self.assertEqual(hits, [], "a credit_prices row would put a gated model on sale")

    def test_the_gate_reaches_the_database_row_and_the_row_is_reachable_by_the_switches(self):
        # The sync writes the row (availability stays the database's default, hidden); sellable_models refuses it while
        # spec.terms_gate is set, and the owner's provider switch for "meta" covers it like any other row.
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.load().values()))}
        self.assertIn(MID, rows)
        self.assertEqual(rows[MID]["provider"], "meta")
        self.assertEqual(rows[MID]["spec"]["terms_gate"], "terms_review_required")
        self.assertNotIn("availability", rows[MID])
        self.assertFalse(self.e.registry_only)

    def test_the_creative_bridge_reaches_the_adapter(self):
        bridge = ca.resolve(MID, env={"META_API_KEY": KEY})
        self.assertIsNotNone(bridge)
        self.assertIsInstance(bridge.adapter, MuseImageAdapter)
        self.assertIs(ADAPTERS["image.meta"], MuseImageAdapter)

    def test_what_the_registry_offers_is_what_the_adapter_will_send(self):
        ratios = MuseImageAdapter.SPECS[VENDOR]["ratios"]
        self.assertEqual(list(self.e.aspect_ratios), list(ratios))
        for r in ratios:
            self.assertIsNotNone(ratio_size(r), r)
        self.assertEqual(tuple(self.e.image_sizes), ())                   # no resolution is promised
        self.assertEqual(tuple(self.e.qualities), ())

    def test_the_registry_and_the_adapter_refuse_the_same_and_the_probe_is_servable(self):
        a = MuseImageAdapter(env={"META_API_KEY": KEY})
        probe = self.e.probe_request()
        # No aspect ratio: the cheapest valid call, with no tool (the first probe's tool was refused, 2026-11-12).
        self.assertEqual((probe.capability, probe.aspect_ratio, probe.image_size), (T2I, None, None))
        self.assertEqual(probe.prompt, "a red apple on a white table")
        self.assertEqual(a.problems(probe, self.e), [])
        self.assertEqual(a.problems(t2i(aspect_ratio="1:1"), self.e), [])   # a ratio is still offered and accepted
        for bad in (t2i(image_size="1K"), t2i(aspect_ratio="17:1"), t2i(quality="low"),
                    t2i(prompt="a famous singer on stage")):
            self.assertTrue(a.problems(bad, self.e), bad)

    def test_the_terms_notes_carry_each_obligation(self):
        notes = " ".join(self.e.raw["terms_notes"])
        for must in ("18", "ToS 7", "watermark", "likeness", "2026-11-09", "Restricted Territories", "requester-country",
                     "store false", "10.1(i)"):
            self.assertIn(must, notes)

    def test_a_paid_probe_of_every_model_never_calls_it(self):
        from tools import probe_models

        entries = list(reg.registry().values())
        self.assertNotIn(MID, {e.id for e in probe_models.select(entries, [], None, True)})
        self.assertIn(MID, {e.id for e in probe_models.select(entries, [MID], None, True)})   # only when named


class ProbeTests(VendorCase):
    def test_the_probe_runs_the_whole_chain_against_a_fake_and_stores_a_real_picture(self):
        from tools.probe_models import run_probe

        res = run_probe(reg.get(MID), env=self.env, voice_id=None, workdir=self.tmp, session=self.vendor.session(),
                        sleep=lambda s: None)
        self.assertTrue(res.ok, res.message)
        # The whole probe body: no aspect ratio, so no `tools`; the vendor's plain text-to-image call.
        self.assertEqual(self.sent(), {"model": VENDOR, "store": False, "input": "a red apple on a white table"})

    def test_a_refused_tool_is_named_by_its_own_code_in_the_probe_result(self):
        from tools.probe_models import BRIEF_CODES, run_probe

        self.answers(Resp(400, {"error": {"code": None, "message": "Unsupported tool type: 'image_generation'",
                                          "param": "tools", "type": "invalid_request_error"}}))
        res = run_probe(reg.get(MID), env=self.env, voice_id=None, workdir=self.tmp, session=self.vendor.session(),
                        sleep=lambda s: None)
        self.assertFalse(res.ok)
        self.assertEqual(res.code, E_VENDOR_TOOL_UNSUPPORTED)
        self.assertIn(E_VENDOR_TOOL_UNSUPPORTED, BRIEF_CODES)              # the public --brief log prints the word
        self.assertNotRegex(res.message, BRAND)


class WiringTests(unittest.TestCase):
    def test_the_adapter_is_wired_like_a_bearer_key_adapter_that_downloads_nothing(self):
        a = MuseImageAdapter
        self.assertEqual((a.key, a.key_env, a.base_url_env, a.default_base_url),
                         ("image.meta", ("META_API_KEY",), "META_BASE_URL", "https://api.meta.ai/v1"))
        self.assertEqual(a.result_hosts, ())
        self.assertEqual((a.capabilities, a.reference_capabilities), ((T2I, EDIT), (T2I, EDIT)))
        self.assertEqual((a.quality_capabilities, a.audio_capabilities, a.end_frame_capabilities), ((), (), ()))
        self.assertEqual(a(env={"META_API_KEY": KEY}).auth_headers(), {"Authorization": f"Bearer {KEY}"})
        self.assertEqual(a(env={"META_API_KEY": KEY, "META_BASE_URL": "http://api.meta.ai/v1"}).base_url,
                         "https://api.meta.ai/v1")                       # a plain-http override would leak the key

    def test_the_key_is_one_the_worker_the_probe_workflow_and_the_doctor_can_be_given(self):
        example = (ROOT / "deploy" / ".env.worker.example").read_text()
        deploy = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        probe = (ROOT / ".github" / "workflows" / "probe_models.yml").read_text()
        doctor = (ROOT / "tools" / "doctor.py").read_text()
        self.assertRegex(example, r"(?m)^META_API_KEY=$")                 # empty in the example, never a value
        self.assertIn("WORKERENV_META_API_KEY: ${{ secrets.META_API_KEY }}", deploy)
        self.assertIn("META_API_KEY: ${{ secrets.META_API_KEY }}", probe)
        self.assertIn('("META_API_KEY", "meta")', doctor)

    def test_the_key_page_checks_the_key_with_the_free_model_list(self):
        text = (ROOT / "command-center" / "lib" / "model-keys.ts").read_text()
        i = text.index('id: "meta"')
        card = text[i:text.index("\n  },\n", i)]
        for must in ('envSets: [["META_API_KEY"]]', 'origin: "https://api.meta.ai"', 'path: "/v1/models"',
                     "rejectStatuses: [401]", 'name: "data"'):
            self.assertIn(must, card)

    def test_the_maker_is_on_every_banned_list_for_public_text(self):
        self.assertIn('"meta", "muse image"', (ROOT / "docs" / "news" / "banned-claims.json").read_text())
        self.assertIn('"meta", "muse image"', (ROOT / "command-center" / "lib" / "marketing-banned.ts").read_text())
        self.assertIn("meta(?!", (ROOT / "command-center" / "tests" / "helpers" / "brands.ts").read_text())

    def test_the_watermark_policy_and_the_geography_gap_are_written_down(self):
        disclosure = (ROOT / "docs" / "AI_DISCLOSURE.md").read_text()
        row = next(line for line in disclosure.splitlines() if "`image.meta`" in line)
        self.assertIn("byte for byte", row)
        self.assertIn("tamper", row)
        research = (ROOT / "docs" / "research" / "meta-muse-image-first-party.md").read_text()
        self.assertIn("## Geography: the gap", research)
        self.assertIn("Last updated: November 9, 2026", research)        # the policy's own date, re-read 2026-11-12
        self.assertIn("Muse Image is\n  no longer listed", research)


if __name__ == "__main__":
    unittest.main()
