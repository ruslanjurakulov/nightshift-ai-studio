"""The paid Lyria probe (tools/lyria_vocal_probe.py), its workflow, and the product adapter it must not weaken.

Offline: no network, no model, no key, no spend. Google is a fake ``post`` and the detectors a fake ``measure``; the adapter
regression talks to a real HTTPS socket on 127.0.0.1 (tests/loopback_vendor.py).

What would break without these tests:

* a sixth paid call, or a call with no key, or a run nobody confirmed;
* lyrics or base64 audio reaching the PUBLIC Actions log (the repository is public);
* an audio file left behind after the run;
* the probe's "no suffix, no output check" path leaking into the product: the adapter still appends the instrumental
  instruction and still refuses a song that came back sung;
* a detector that did not run being read as "no vocals" (rule 5);
* the workflow running on a push, uploading an artifact, or using an action by a movable tag.
"""

from __future__ import annotations

import base64
import inspect
import io
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

import yaml

from modules.capabilities import build_adapter
from modules.capabilities.base import E_BAD_RESPONSE, MUSIC, AdapterError, CapabilityRequest
from modules.capabilities.google_interactions import LYRIA_API_REVISION, LYRIA_INSTRUMENTAL, GoogleLyriaAdapter
from tests.loopback_vendor import FakeVendor, Resp, cleanup_certificate
from tools import lyria_vocal_probe as probe

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "lyria_vocal_probe.yml"
KEY = "AIzaSy-test-NOT-A-REAL-KEY-0123456789abcdef"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 4096
LYRICS = "[Verse]\nSecret marmalade lyric line one\n[Chorus]\nAnother unmistakable lyric phrase"


def tearDownModule():
    cleanup_certificate()


def answer(text=LYRICS, data=None, mime="audio/mpeg"):
    content = []
    if text is not None:
        content.append({"type": "text", "text": text})
    content.append({"type": "audio", "mime_type": mime, "data": data if data is not None else base64.b64encode(MP3).decode()})
    return {"id": "v1_x", "status": "completed", "steps": [{"type": "model_output", "content": content}]}


class FakeResp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakePost:
    def __init__(self, resp=None):
        self.calls = []
        self.resp = resp or FakeResp(200, answer())

    def __call__(self, url, headers, body, timeout):
        self.calls.append((url, dict(headers), json.loads(json.dumps(body))))
        return self.resp


def fake_measure(seen):
    def m(path):
        seen.append(Path(path))
        assert Path(path).read_bytes() == MP3
        return {"duration_s": 1.5, "checks": {"umx_vocals": "ran"}, "umx_vocal_to_mix": {"p50_db": -3.0}}
    return m


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = {"GEMINI_API_KEY": KEY, "RUNNER_TEMP": str(self.tmp)}

    def run_probe(self, count=5, post=None, measure=None, prompts=probe.PROMPTS):
        out = io.StringIO()
        self.post = post or FakePost()
        self.seen = []
        rc = probe.run(count, env=self.env, out=out, post=self.post, measure=measure or fake_measure(self.seen), prompts=prompts)
        return rc, out.getvalue()


class BudgetTests(Case):
    def test_more_than_five_calls_is_refused_before_any_call(self):
        for n in (6, 50, 0, -1):
            with self.subTest(n=n), self.assertRaises(probe.ProbeRefused):
                self.run_probe(count=n)
            self.assertEqual(self.post.calls if hasattr(self, "post") else [], [])

    def test_the_cap_holds_at_the_call_even_with_more_prompts(self):
        many = probe.PROMPTS + probe.PROMPTS
        rc, out = self.run_probe(count=5, prompts=many)
        self.assertEqual(len(self.post.calls), 5)
        self.assertEqual(len(out.splitlines()), 5)
        b = probe.CallBudget(5)
        for _ in range(5):
            b.spend()
        with self.assertRaises(probe.ProbeRefused):
            b.spend()

    def test_without_the_key_nothing_is_called_or_loaded(self):
        post = FakePost()
        for env in ({}, {"GEMINI_API_KEY": "   "}):
            with self.subTest(env=env), self.assertRaises(probe.ProbeRefused):
                probe.run(1, env=env, out=io.StringIO(), post=post, measure=lambda p: self.fail("measured"))
        self.assertEqual(post.calls, [])

    def test_main_needs_the_confirm_word_and_refuses_six(self):
        post_calls = []
        err = io.StringIO()
        import contextlib

        with contextlib.redirect_stderr(err):
            self.assertEqual(probe.main(["--count", "1"], env=self.env, out=io.StringIO()), 2)
            self.assertEqual(probe.main(["--count", "6", "--confirm", probe.CONFIRM], env=self.env, out=io.StringIO()), 2)
            self.assertEqual(probe.main(["--confirm", probe.CONFIRM], env={}, out=io.StringIO()), 2)
        self.assertEqual(post_calls, [])
        self.assertEqual(probe.MAX_CALLS, 5)


class PublicLogTests(Case):
    def test_neither_the_lyrics_nor_the_audio_nor_the_key_reach_stdout(self):
        rc, out = self.run_probe(count=5)
        self.assertEqual(rc, 0)
        b64 = base64.b64encode(MP3).decode()
        for needle in ("marmalade", "unmistakable", "Verse", "Chorus", b64, b64[:40], KEY, KEY[:12]):
            self.assertNotIn(needle, out)
        for line in out.splitlines():
            row = json.loads(line)
            self.assertTrue(row["has_text_block"])
            self.assertEqual(row["text_length"], len(LYRICS))
            self.assertEqual(row["text_lines"], 4)
            self.assertTrue(row["returned_singing"])
            self.assertEqual((row["mime"], row["audio_bytes"]), ("audio/mpeg", len(MP3)))
        md = probe.markdown(out.splitlines())
        for needle in ("marmalade", b64[:40], KEY):
            self.assertNotIn(needle, md)

    def test_a_google_error_that_quotes_the_prompt_is_not_printed(self):
        post = FakePost(FakeResp(400, {"error": {"status": "INVALID_ARGUMENT", "message": "blocked: Secret marmalade lyric"}}))
        rc, out = self.run_probe(count=1, post=post)
        self.assertEqual(rc, 1)
        self.assertNotIn("marmalade", out)
        row = json.loads(out)
        self.assertEqual(row["error"]["google_status"], "INVALID_ARGUMENT")
        self.assertEqual(row["error"]["spend"], "unknown")

    def test_the_audio_files_are_deleted(self):
        self.run_probe(count=5)
        self.assertEqual(len(self.seen), 5)
        for p in self.seen:
            self.assertFalse(p.exists())
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_the_audio_is_deleted_even_when_the_measurement_crashes(self):
        seen = []

        def boom(path):
            seen.append(Path(path))
            raise RuntimeError("detector crashed on /some/where")

        rc, out = self.run_probe(count=1, measure=boom)
        self.assertFalse(seen[0].exists())
        self.assertEqual(list(self.tmp.iterdir()), [])
        row = json.loads(out)
        # A check that did not run is "measure_failed" with no numbers: never something that reads as "no vocals".
        self.assertEqual((row["ok"], row["measure"], row["error"]["kind"]), (False, None, "measure_failed"))
        self.assertNotIn("/some/where", out)
        self.assertEqual(rc, 1)


class RequestTests(Case):
    def test_positives_carry_no_suffix_and_negatives_exactly_the_products(self):
        self.run_probe(count=5)
        by_id = {pid: body for (pid, _p, _s), (_u, _h, body) in zip(probe.PROMPTS, self.post.calls)}
        for pid in ("P1", "P2", "P3"):
            self.assertNotIn(LYRIA_INSTRUMENTAL, by_id[pid]["input"])
            self.assertIn("[Verse]", by_id[pid]["input"])
        for pid, prompt, sung in probe.PROMPTS:
            if not sung:
                product = GoogleLyriaAdapter(env={})._input(CapabilityRequest(capability=MUSIC, prompt=prompt))
                self.assertEqual(by_id[pid]["input"], product)
                self.assertTrue(by_id[pid]["input"].endswith(LYRIA_INSTRUMENTAL))

    def test_the_request_is_the_adapters_shape_with_the_key_in_a_header(self):
        self.run_probe(count=1)
        url, headers, body = self.post.calls[0]
        self.assertEqual(url, "https://generativelanguage.googleapis.com/v1beta/interactions")
        self.assertNotIn(KEY, url)
        self.assertEqual(headers["x-goog-api-key"], KEY)
        self.assertEqual(headers["Api-Revision"], LYRIA_API_REVISION)
        self.assertEqual({k: v for k, v in body.items() if k != "input"},
                         {"model": "lyria-3.5", "response_format": {"type": "audio"}, "background": False, "store": False})

    def test_the_prompt_set_is_three_sung_languages_and_two_instrumentals(self):
        self.assertEqual([(p, s) for p, _t, s in probe.PROMPTS],
                         [("P1", True), ("P2", True), ("P3", True), ("N1", False), ("N2", False)])
        self.assertRegex(probe.PROMPTS[1][1], "[а-яё]")
        self.assertIn("Uzbek", probe.PROMPTS[2][1])
        self.assertIn("saxophone", probe.PROMPTS[4][1])

    def test_the_tool_never_uses_the_product_adapter_to_skip_its_check(self):
        # It imports constants and read-only helpers, never the adapter class: nothing it does can reach the adapter's
        # instrumental=False branch, and the adapter needs no new switch for it.
        import ast

        tree = ast.parse((ROOT / "tools" / "lyria_vocal_probe.py").read_text())
        used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names}
        for name in ("GoogleLyriaAdapter", "build_adapter", "text_language", "_song_of", "_song"):
            self.assertNotIn(name, used | imported)


# ── the product adapter is unchanged by this probe ─────────────────────────────────

class ProductAdapterRegressionTests(unittest.TestCase):
    def setUp(self):
        self.vendor = FakeVendor()
        self.addCleanup(self.vendor.close)
        self.env = {"GEMINI_API_KEY": KEY, "GEMINI_BASE_URL": self.vendor.base_url + "/v1beta"}

    def lyria(self):
        return build_adapter("audio.google_lyria", env=self.env, session=self.vendor.session())

    def test_it_still_appends_the_instrumental_instruction(self):
        self.vendor.on("POST", "/v1beta/interactions", Resp(200, answer(text="[Instrumental]")))
        self.lyria().submit(CapabilityRequest(capability=MUSIC, prompt="a calm solo piano piece"), "lyria-3.5")
        (req,) = self.vendor.seen("POST", "/v1beta/interactions")
        self.assertEqual(req.json()["input"], f"a calm solo piano piece\n\n{LYRIA_INSTRUMENTAL}")

    def test_it_still_refuses_a_song_that_came_back_sung(self):
        self.vendor.on("POST", "/v1beta/interactions", Resp(200, answer()))
        with self.assertRaises(AdapterError) as cm:
            self.lyria().submit(CapabilityRequest(capability=MUSIC, prompt="a calm solo piano piece"), "lyria-3.5")
        self.assertEqual(cm.exception.code, E_BAD_RESPONSE)
        self.assertIn("returned singing", cm.exception.message)

    def test_it_gained_no_switch_to_skip_the_check(self):
        self.assertEqual(list(inspect.signature(GoogleLyriaAdapter.submit).parameters), ["self", "request", "vendor_model"])
        self.assertEqual(GoogleLyriaAdapter.SPECS["lyria-3.5"]["vocal_languages"], ())


# ── the workflow ──────────────────────────────────────────────────────────────────

def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


class WorkflowTests(unittest.TestCase):
    def test_manual_only_with_the_confirm_word_and_a_count_of_one_to_five(self):
        on = workflow()[True]
        self.assertEqual(set(on), {"workflow_dispatch"})
        inputs = on["workflow_dispatch"]["inputs"]
        self.assertTrue(inputs["confirm"]["required"])
        self.assertEqual(inputs["count"]["options"], ["1", "2", "3", "4", "5"])
        self.assertEqual(inputs["count"]["default"], "5")

    def test_the_guard_is_the_first_step_and_checks_the_literal(self):
        steps = workflow()["jobs"]["probe"]["steps"]
        guard = steps[0]
        self.assertIn('"$CONFIRM" != "spend-5-lyria-calls"', guard["run"])
        self.assertIn("exit 1", guard["run"])
        self.assertIn("^[1-5]$", guard["run"])
        self.assertEqual(guard["env"]["CONFIRM"], "${{ inputs.confirm }}")
        self.assertEqual(probe.CONFIRM, "spend-5-lyria-calls")

    def test_no_artifact_is_uploaded_and_no_audio_is_cached(self):
        text = WORKFLOW.read_text()
        self.assertNotIn("upload-artifact", text)
        for s in workflow()["jobs"]["probe"]["steps"]:
            if "actions/cache" in s.get("uses", ""):
                self.assertEqual(s["with"]["path"], "~/.cache/nightshift-vocal-measure")

    def test_every_action_is_pinned_by_sha(self):
        for s in workflow()["jobs"]["probe"]["steps"]:
            if "uses" in s:
                self.assertRegex(s["uses"], r"^[\w.-]+/[\w.-]+(/[\w.-]+)?@[0-9a-f]{40}$")

    def test_read_only_token_one_at_a_time_and_the_key_only_in_env(self):
        wf = workflow()
        self.assertEqual(wf["permissions"], {"contents": "read"})
        self.assertFalse(wf["concurrency"]["cancel-in-progress"])
        text = WORKFLOW.read_text()
        self.assertNotRegex(text, r"toJSON\(")
        self.assertEqual(len(re.findall(r"secrets\.", text)), 1)
        for s in wf["jobs"]["probe"]["steps"]:
            self.assertNotIn("${{", s.get("run", ""), s.get("name"))
            for name, expr in (s.get("env") or {}).items():
                if "secrets." in str(expr):
                    self.assertEqual((name, expr), ("GEMINI_API_KEY", "${{ secrets.GEMINI_API_KEY }}"))


if __name__ == "__main__":
    unittest.main()
