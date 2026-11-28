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

from unittest import mock

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


def rows(out):
    """The sample rows of a probe's output (the call_started lines are the spend counter, not samples)."""
    return [r for r in map(json.loads, out.splitlines()) if r.get("event") != "call_started"]


def started(out):
    return [r for r in map(json.loads, out.splitlines()) if r.get("event") == "call_started"]


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
        self.assertEqual((len(rows(out)), len(started(out))), (5, 5))
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
        import contextlib

        from tools import vocal_activity

        err = io.StringIO()
        with mock.patch.object(probe, "_post", side_effect=AssertionError("POSTed")) as post, \
                mock.patch.object(vocal_activity, "load_detectors", side_effect=AssertionError("models loaded")) as load, \
                contextlib.redirect_stderr(err):
            self.assertEqual(probe.main(["--count", "1"], env=self.env, out=io.StringIO()), 2)
            self.assertEqual(probe.main(["--count", "1", "--confirm", "yes"], env=self.env, out=io.StringIO()), 2)
            self.assertEqual(probe.main(["--count", "6", "--confirm", probe.CONFIRM], env=self.env, out=io.StringIO()), 2)
            self.assertEqual(probe.main(["--confirm", probe.CONFIRM], env={}, out=io.StringIO()), 2)
        post.assert_not_called()
        load.assert_not_called()
        self.assertEqual(probe.MAX_CALLS, 5)

    def test_a_detector_that_does_not_load_is_a_clean_refusal_before_any_call(self):
        import contextlib

        from tools import vocal_activity

        err = io.StringIO()
        with mock.patch.object(probe, "_post", side_effect=AssertionError("POSTed")) as post, \
                mock.patch.object(vocal_activity, "load_detectors",
                                  side_effect=vocal_activity.MeasurementError("PANNs Cnn14 did not load")), \
                contextlib.redirect_stderr(err):
            self.assertEqual(probe.main(["--count", "1", "--confirm", probe.CONFIRM], env=self.env, out=io.StringIO()), 2)
        post.assert_not_called()
        self.assertIn("did not load", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())


class PublicLogTests(Case):
    def test_neither_the_lyrics_nor_the_audio_nor_the_key_reach_stdout(self):
        rc, out = self.run_probe(count=5)
        self.assertEqual(rc, 0)
        b64 = base64.b64encode(MP3).decode()
        for needle in ("marmalade", "unmistakable", "Verse", "Chorus", b64, b64[:40], KEY, KEY[:12]):
            self.assertNotIn(needle, out)
        for row in rows(out):
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
        (row,) = rows(out)
        self.assertEqual(row["error"]["google_status"], "INVALID_ARGUMENT")
        self.assertEqual(row["spend"], "unknown")

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
        (row,) = rows(out)
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


class FailurePathTests(Case):
    def test_a_transport_error_is_a_recorded_call_with_unknown_spend(self):
        class Boom:
            def __call__(self, *a):
                raise TimeoutError("read timed out on https://generativelanguage.googleapis.com/?key=" + KEY)

        rc, out = self.run_probe(count=1, post=Boom())
        (row,) = rows(out)
        self.assertEqual((row["ok"], row["error"], row["spend"]), (False, {"kind": "TimeoutError"}, "unknown"))
        self.assertNotIn(KEY, out)
        self.assertEqual(len(started(out)), 1)
        self.assertEqual(rc, 1)

    def test_a_completed_answer_without_audio(self):
        body = answer()
        body["steps"][0]["content"] = [c for c in body["steps"][0]["content"] if c["type"] != "audio"]
        rc, out = self.run_probe(count=1, post=FakePost(FakeResp(200, body)))
        (row,) = rows(out)
        self.assertEqual((row["ok"], row["error"]["kind"], row["spend"]), (False, "no_audio", "likely"))
        self.assertEqual(self.seen, [])

    def test_bad_base64_and_an_oversize_answer_are_not_decoded(self):
        for data in ("not base64!!", base64.b64encode(MP3).decode()[:-1]):
            with self.subTest(data=data[:8]):
                rc, out = self.run_probe(count=1, post=FakePost(FakeResp(200, answer(data=data))))
                (row,) = rows(out)
                self.assertEqual(row["error"]["kind"], "bad_base64_or_too_large")
                self.assertNotIn(data, out)
        with mock.patch.object(probe, "MAX_INLINE_BYTES", 1024), \
                mock.patch.object(probe.base64, "b64decode", side_effect=AssertionError("decoded")):
            rc, out = self.run_probe(count=1)
        (row,) = rows(out)
        self.assertEqual(row["error"]["kind"], "bad_base64_or_too_large")
        self.assertEqual(self.seen, [])

    def test_every_answered_row_says_whether_it_was_likely_billed(self):
        body = answer()
        body["status"] = "in_progress"
        for resp, spend in ((FakeResp(200, answer()), "likely"), (FakeResp(200, body), "unknown"),
                            (FakeResp(500, {"error": {"status": "INTERNAL"}}), "unknown")):
            with self.subTest(spend=spend):
                rc, out = self.run_probe(count=1, post=FakePost(resp))
                self.assertEqual(rows(out)[0]["spend"], spend)

    def test_only_known_media_types_are_echoed(self):
        for mime, shown in (("audio/mpeg", "audio/mpeg"), ("audio/wav; rate=48000", "audio/wav"),
                            ("audio/x-secret-lyric-marmalade", "other"), ("text/plain", "other")):
            with self.subTest(mime=mime):
                self.assertEqual(probe._mime({"mime_type": mime}), shown)

    def test_a_run_stopped_after_spend_still_records_the_call_and_deletes_the_audio(self):
        jsonl = self.tmp / "samples.jsonl"
        seen = []

        def cancelled(path):
            seen.append(Path(path))
            raise KeyboardInterrupt()      # what a cancel looks like from inside the call

        out = io.StringIO()
        with self.assertRaises(KeyboardInterrupt):
            probe.run(5, env=self.env, out=out, post=FakePost(), measure=cancelled, jsonl=jsonl)
        lines = [json.loads(x) for x in jsonl.read_text().splitlines()]
        self.assertEqual(lines[0], {"event": "call_started", "prompt_id": "P1", "call": 1})
        self.assertEqual(lines[1], {"prompt_id": "P1", "call": 1, "ok": False, "error": {"kind": "KeyboardInterrupt"},
                                    "spend": "unknown"})
        self.assertEqual(len(lines), 2)
        self.assertFalse(seen[0].exists())
        self.assertEqual([p.name for p in self.tmp.iterdir()], ["samples.jsonl"])
        md = probe.markdown(jsonl.read_text().splitlines())
        self.assertIn("Paid Lyria calls started: 1", md)

    def test_the_transport_itself_being_interrupted_is_also_recorded(self):
        jsonl = self.tmp / "samples.jsonl"

        class Killed:
            def __call__(self, *a):
                raise probe.Terminated()

        with self.assertRaises(probe.Terminated):
            probe.run(5, env=self.env, out=io.StringIO(), post=Killed(), measure=lambda p: None, jsonl=jsonl)
        lines = [json.loads(x) for x in jsonl.read_text().splitlines()]
        self.assertEqual([x.get("event") for x in lines], ["call_started", None])
        self.assertEqual((lines[1]["error"]["kind"], lines[1]["spend"]), ("Terminated", "unknown"))

    def test_the_file_gets_each_row_as_it_happens_and_matches_stdout(self):
        jsonl = self.tmp / "samples.jsonl"
        out = io.StringIO()
        probe.run(2, env=self.env, out=out, post=FakePost(), measure=fake_measure([]), jsonl=jsonl)
        self.assertEqual(jsonl.read_text(), out.getvalue())
        self.assertNotIn("marmalade", jsonl.read_text())
        self.assertIn("Paid Lyria calls started: 2", probe.markdown(out.getvalue().splitlines()))


class NotImportedByTheProductTests(unittest.TestCase):
    def test_nothing_in_modules_or_main_imports_the_measurement_tools(self):
        import ast

        files = sorted((ROOT / "modules").rglob("*.py")) + [ROOT / "main.py"]
        for f in files:
            tree = ast.parse(f.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""] + [f"{node.module}.{a.name}" for a in node.names]
                for n in names:
                    for tool in ("tools.lyria_vocal_probe", "tools.vocal_activity", "tools.vendor_panns"):
                        self.assertFalse(n == tool or n.startswith(tool + "."), f"{f.relative_to(ROOT)} imports {n}")


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

    def test_a_re_run_cannot_reuse_the_typed_word(self):
        guard = workflow()["jobs"]["probe"]["steps"][0]
        self.assertEqual(guard["env"]["RUN_ATTEMPT"], "${{ github.run_attempt }}")
        self.assertIn('"$RUN_ATTEMPT" != "1"', guard["run"])
        self.assertIn("start a new run and type the confirm word again", guard["run"])
        self.assertLess(guard["run"].index("RUN_ATTEMPT"), guard["run"].index("exit 1"))

    def test_the_rows_survive_a_failed_or_cancelled_probe(self):
        steps = {s.get("name"): s for s in workflow()["jobs"]["probe"]["steps"]}
        run = steps["Probe"]["run"]
        self.assertIn("set -euo pipefail", run)
        self.assertIn('--jsonl "$RUNNER_TEMP/lyria-samples.jsonl"', run)
        self.assertIn("| tee", run)
        summary = steps["Summary"]
        self.assertEqual(summary["if"], "always()")
        self.assertIn("--markdown", summary["run"])
        self.assertIn("lyria-samples.jsonl", summary["run"])

    def test_requirements_install_with_hashes_only(self):
        install = {s.get("name"): s for s in workflow()["jobs"]["probe"]["steps"]}["Install the measurement requirements"]
        self.assertEqual(install["run"], "pip install --require-hashes -r requirements-measure.txt")
        text = (ROOT / "requirements-measure.txt").read_text()
        pins = re.findall(r"^([A-Za-z0-9_.-]+)==(\S+) \\\n    --hash=sha256:([0-9a-f]{64})$", text, re.M)
        reqs = [ln for ln in text.splitlines() if re.match(r"^[A-Za-z0-9_.-]+==", ln)]
        self.assertEqual(len(pins), len(reqs))
        self.assertGreaterEqual(len(pins), 21)
        self.assertIn(("torch", "2.8.0+cpu"), [(n, v) for n, v, _h in pins])

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
