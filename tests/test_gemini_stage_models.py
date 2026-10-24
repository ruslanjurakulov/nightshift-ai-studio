"""Per-stage Gemini models: optional, validated, and a no-op when nothing is set.

Why: the free tier's quota is per day AND per model (``limit: 20, model: gemini-3.6-flash`` in Actions run
40051405982), so the owner needs to be able to move one stage to another model without moving the rest. This
change adds the levers and chooses nothing: every default is ``GEMINI_MODEL``.

Pinned, and what would break:

  * with nothing set, EVERY stage resolves to ``GEMINI_MODEL`` (byte-identical behaviour) .. NothingSetChangesNothing
  * a set variable moves exactly its own stages, and no other .............................. AVariableMovesItsOwnStages
  * a value that is not a plain model id falls back with a warning that never echoes it .... JunkFallsBackWithoutEchoing
  * the variables reach every place a variable has to be wired (Actions, deploy, example) .. TheVariablesAreWired
"""

from __future__ import annotations

import importlib
import os
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
from modules import gemini_stages  # noqa: E402
from modules.gemini_stages import MODEL_GROUPS, STAGE_GROUP, model_for  # noqa: E402

VARIABLES = {g: "GEMINI_MODEL_" + g.upper() for g in MODEL_GROUPS}


def reloaded_config(**env):
    """``config`` re-imported under ``env`` (and with every stage variable otherwise cleared)."""
    clean = {k: v for k, v in os.environ.items() if not k.startswith("GEMINI_MODEL")}
    clean.update(env)
    with patch.dict(os.environ, clean, clear=True), patch("dotenv.load_dotenv"):
        return importlib.reload(config)


class Restore(unittest.TestCase):
    def tearDown(self):
        importlib.reload(config)


class NothingSetChangesNothing(Restore):
    def test_every_stage_resolves_to_gemini_model(self):
        cfg = reloaded_config()
        self.assertEqual(cfg.GEMINI_MODEL, "gemini-3.6-flash", "the default model is not changed by this")
        self.assertEqual(sorted(cfg.GEMINI_STAGE_MODELS), sorted(MODEL_GROUPS))
        for group, model in cfg.GEMINI_STAGE_MODELS.items():
            self.assertEqual(model, cfg.GEMINI_MODEL, group)
        for stage in STAGE_GROUP:
            self.assertEqual(model_for(stage), config.GEMINI_MODEL, stage)

    def test_every_stage_follows_gemini_model_when_only_that_is_set(self):
        cfg = reloaded_config(GEMINI_MODEL="gemini-x-flash")
        for stage in STAGE_GROUP:
            self.assertEqual(model_for(stage), "gemini-x-flash", stage)
        self.assertTrue(all(m == "gemini-x-flash" for m in cfg.GEMINI_STAGE_MODELS.values()))

    def test_empty_and_blank_variables_mean_the_default(self):
        cfg = reloaded_config(GEMINI_MODEL_SCRIPT="", GEMINI_MODEL_TOPIC="   ")
        self.assertEqual(cfg.GEMINI_STAGE_MODELS["script"], cfg.GEMINI_MODEL)
        self.assertEqual(cfg.GEMINI_STAGE_MODELS["topic"], cfg.GEMINI_MODEL)

    def test_the_model_id_is_the_plain_string_the_sdk_always_got(self):
        self.assertEqual(model_for("script"), config.GEMINI_MODEL)
        self.assertEqual(hash(model_for("script")), hash(config.GEMINI_MODEL))
        self.assertEqual(f"models/{model_for('script')}", f"models/{config.GEMINI_MODEL}")

    def test_a_missing_or_empty_entry_in_the_table_still_resolves_to_gemini_model(self):
        with patch.dict("config.GEMINI_STAGE_MODELS", {"script": ""}), patch("config.GEMINI_MODEL", "fallback-model"):
            self.assertEqual(model_for("script"), "fallback-model")
        with patch("config.GEMINI_STAGE_MODELS", {}), patch("config.GEMINI_MODEL", "fallback-model"):
            self.assertEqual(model_for("topic_pick"), "fallback-model")

    def test_a_stage_the_table_does_not_know_still_gets_a_model(self):
        self.assertEqual(model_for("made_up_stage"), config.GEMINI_MODEL)
        self.assertEqual(gemini_stages.stage_of(model_for("made_up_stage")), gemini_stages.UNLABELLED)

    def test_the_groups_are_the_documented_ones(self):
        self.assertEqual(set(STAGE_GROUP.values()), set(MODEL_GROUPS))


class AVariableMovesItsOwnStages(Restore):
    def test_each_variable_moves_only_its_group(self):
        for group, name in VARIABLES.items():
            with self.subTest(variable=name):
                cfg = reloaded_config(**{name: "model-for-" + group})
                for other, model in cfg.GEMINI_STAGE_MODELS.items():
                    self.assertEqual(model, "model-for-" + group if other == group else cfg.GEMINI_MODEL, other)
                for stage, stage_group in STAGE_GROUP.items():
                    self.assertEqual(model_for(stage),
                                     "model-for-" + group if stage_group == group else cfg.GEMINI_MODEL,
                                     f"{name} -> {stage}")

    def test_the_topic_variable_covers_the_pick_and_the_niche_check(self):
        reloaded_config(GEMINI_MODEL_TOPIC="topic-model")
        self.assertEqual((model_for("topic_pick"), model_for("topic_gate")), ("topic-model", "topic-model"))

    def test_other_covers_comments_replies_and_the_frame_critic(self):
        reloaded_config(GEMINI_MODEL_OTHER="small-model")
        for stage in ("comment_intel", "comment_replies", "video_critic"):
            self.assertEqual(model_for(stage), "small-model", stage)
        self.assertEqual(model_for("script"), config.GEMINI_MODEL)

    def test_the_request_goes_out_with_the_stages_model(self):
        from types import SimpleNamespace

        from modules import gemini_client

        reloaded_config(GEMINI_MODEL_FACTCHECK="checker-model")
        seen = []
        client = SimpleNamespace(models=SimpleNamespace(
            generate_content=lambda model, contents, config=None: seen.append(model) or SimpleNamespace(text="x")))
        gemini_client.generate_with_retry(client, model_for("fact_check"), "p")
        gemini_client.generate_with_retry(client, model_for("script"), "p")
        self.assertEqual(seen, ["checker-model", config.GEMINI_MODEL])


class JunkFallsBackWithoutEchoing(Restore):
    JUNK = ["AIzaSyD-NotAModel_but_a_key_pasted_in_the_wrong_box", "Gemini-3.6-Flash", "models/gemini-3.6-flash",
            "https://example.com/x", "two words", "-leading-dash", "a" * 65, "gemini;rm -rf", "модель"]

    def test_junk_is_ignored_with_a_warning_that_names_the_variable_and_not_the_value(self):
        for junk in self.JUNK:
            with self.subTest(junk=junk[:12]):
                with self.assertLogs("config", "WARNING") as logs:
                    cfg = reloaded_config(GEMINI_MODEL_SCRIPT=junk)
                self.assertEqual(cfg.GEMINI_STAGE_MODELS["script"], cfg.GEMINI_MODEL)
                text = "\n".join(logs.output)
                self.assertIn("GEMINI_MODEL_SCRIPT", text)
                self.assertNotIn(junk, text)
                self.assertNotIn(junk[:10], text)

    def test_plain_ids_are_accepted(self):
        for ok in ("gemini-3.6-flash", "gemini-3.6-flash-lite", "gemini-2.5-pro", "a", "gemma_3.1-27b-it", "a" * 64):
            with self.subTest(ok=ok[:20]):
                self.assertEqual(reloaded_config(GEMINI_MODEL_SCRIPT=ok).GEMINI_STAGE_MODELS["script"], ok)

    def test_surrounding_whitespace_is_trimmed_not_rejected(self):
        self.assertEqual(reloaded_config(GEMINI_MODEL_SCRIPT="  gemini-x \n").GEMINI_STAGE_MODELS["script"], "gemini-x")

    def test_an_unreadable_value_never_reaches_a_log_line_or_event_through_the_counter(self):
        self.assertEqual(gemini_stages.label_model("AIzaSyD-key-like-value"), gemini_stages.UNRECOGNISED_MODEL)
        self.assertEqual(gemini_stages.label_model("gemini-3.6-flash"), "gemini-3.6-flash")


class TheVariablesAreWired(unittest.TestCase):
    def test_config_reads_each_variable_by_its_literal_name(self):
        text = (ROOT / "config.py").read_text()
        for name in VARIABLES.values():
            self.assertIn(f'os.getenv("{name}")', text, name)

    def test_the_example_the_deploy_reads_lists_each_as_a_key(self):
        keys = re.findall(r"^([A-Z][A-Z0-9_]*)=", (ROOT / "deploy" / ".env.worker.example").read_text(), re.M)
        for name in VARIABLES.values():
            self.assertEqual(keys.count(name), 1, name)

    def test_deploy_web_maps_each_to_a_repository_variable_not_a_secret(self):
        flow = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        for name in VARIABLES.values():
            self.assertIn(f"WORKERENV_{name}: ${{{{ vars.{name} }}}}", flow, name)

    def test_the_scheduled_run_gets_each_as_a_repository_variable(self):
        flow = (ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        for name in VARIABLES.values():
            self.assertIn(f"{name}: ${{{{ vars.{name} }}}}", flow, name)
            self.assertNotIn(f"secrets.{name}", flow)


if __name__ == "__main__":
    unittest.main()


class TheStageModelSurvivesCopyingAndPickling(unittest.TestCase):
    """``StageModel`` is a str that remembers its stage. It lands in data classes (``CriticReport.model``), which
    ``dataclasses.asdict`` deep-copies, so copy, deepcopy and pickle must round-trip it."""

    def setUp(self):
        self.model = model_for("fact_check")

    def check(self, clone):
        self.assertEqual(clone, config.GEMINI_MODEL)
        self.assertEqual(gemini_stages.stage_of(clone), "fact_check")

    def test_copy(self):
        import copy
        self.check(copy.copy(self.model))

    def test_deepcopy(self):
        import copy
        self.check(copy.deepcopy(self.model))

    def test_pickle_every_protocol(self):
        import pickle
        for protocol in range(0, pickle.HIGHEST_PROTOCOL + 1):
            with self.subTest(protocol=protocol):
                self.check(pickle.loads(pickle.dumps(self.model, protocol)))

    def test_dataclasses_asdict_of_the_critic_report(self):
        import dataclasses

        from modules import video_critic

        report = video_critic.CriticReport(model=model_for("video_critic"))
        self.assertEqual(dataclasses.asdict(report)["model"], config.GEMINI_MODEL)

    def test_the_stage_has_a_default(self):
        self.assertEqual(gemini_stages.stage_of(gemini_stages.StageModel("gemini-x")), gemini_stages.UNLABELLED)

    def test_json_serialises_as_the_plain_id(self):
        import json
        self.assertEqual(json.dumps({"m": self.model}), json.dumps({"m": config.GEMINI_MODEL}))


class DoctorProbesTheStageVariablesToo(unittest.TestCase):
    """A typo in GEMINI_MODEL_SCRIPT used to surface as a 404 traceback at the script stage; the doctor probed only
    GEMINI_MODEL. Same free models GET, only for a variable that is set to something other than the main model."""

    def setUp(self):
        from tests import test_doctor as td

        self.td, self.d = td, td.d

    def routes(self, **by_model):
        base = "generativelanguage.googleapis.com/v1beta/models/"
        return [("GET", base + m, self.td.Resp(code)) for m, code in by_model.items()]

    def test_nothing_set_is_exactly_the_old_single_probe(self):
        ctx = self.td.make_ctx(routes=self.routes(**{"gemini-3.6-flash": 200}))
        out = self.d.check_gemini(ctx)
        self.assertEqual([c.name for c in out], ["gemini"])
        self.assertEqual(len(ctx.http.calls), 1)

    def test_a_stage_variable_naming_a_model_that_does_not_exist_fails_with_its_name(self):
        ctx = self.td.make_ctx({"GEMINI_MODEL_SCRIPT": "gemini-typo-flash"},
                               self.routes(**{"gemini-3.6-flash": 200, "gemini-typo-flash": 404}))
        out = {c.name: c for c in self.d.check_gemini(ctx)}
        self.assertEqual(out["gemini"].status, self.td.PASS)
        self.assertEqual(out["gemini script"].status, self.td.FAIL)
        self.assertIn("GEMINI_MODEL_SCRIPT", out["gemini script"].detail + out["gemini script"].fix)

    def test_a_good_stage_model_passes_and_one_equal_to_the_main_model_is_not_probed_twice(self):
        ctx = self.td.make_ctx({"GEMINI_MODEL_TOPIC": "gemini-ok-flash", "GEMINI_MODEL_OTHER": "gemini-3.6-flash"},
                               self.routes(**{"gemini-3.6-flash": 200, "gemini-ok-flash": 200}))
        out = {c.name: c for c in self.d.check_gemini(ctx)}
        self.assertEqual(sorted(out), ["gemini", "gemini topic"])
        self.assertEqual(out["gemini topic"].status, self.td.PASS)
        self.assertEqual(len(ctx.http.calls), 2)

    def test_junk_is_a_warning_that_does_not_echo_it_and_is_never_sent(self):
        junk = "AIzaSyD-pasted-in-the-wrong-box"
        ctx = self.td.make_ctx({"GEMINI_MODEL_FACTCHECK": junk}, self.routes(**{"gemini-3.6-flash": 200}))
        out = self.d.check_gemini(ctx)
        warn = next(c for c in out if c.name == "gemini factcheck")
        self.assertEqual(warn.status, self.td.WARN)
        self.assertNotIn(junk, warn.detail + warn.fix)
        self.assertEqual(len(ctx.http.calls), 1, "the junk value is not put in a URL")

    def test_a_refused_key_is_reported_once_not_per_variable(self):
        ctx = self.td.make_ctx({"GEMINI_MODEL_TOPIC": "gemini-ok-flash"}, [("GET", "generativelanguage", self.td.Resp(403))])
        out = self.d.check_gemini(ctx)
        self.assertEqual([c.name for c in out], ["gemini"])
        self.assertEqual(len(ctx.http.calls), 1)

    def test_the_stage_variables_are_scrubbed_like_gemini_model(self):
        for name in VARIABLES.values():
            self.assertIn(name, self.d.FREE_TEXT_VARS)
        self.assertEqual(sorted(self.d.GEMINI_STAGE_VARS), sorted(VARIABLES.values()))


class OneVariableMovesEverythingInActions(unittest.TestCase):
    """``daily_video.yml`` never passed GEMINI_MODEL, so the repository variable moved only the worker. An empty
    variable must stay the code default (``os.getenv(...) or default``)."""

    FLOWS = ("daily_video.yml", "intelligence_poll.yml", "factcheck_calibration.yml")

    def test_each_gemini_workflow_passes_the_variable_as_a_variable(self):
        for flow in self.FLOWS:
            text = (ROOT / ".github" / "workflows" / flow).read_text()
            self.assertIn("GEMINI_MODEL: ${{ vars.GEMINI_MODEL }}", text, flow)
            self.assertNotIn("secrets.GEMINI_MODEL", text, flow)

    def test_the_poll_and_the_calibration_also_pass_the_override_of_the_stage_they_run(self):
        poll = (ROOT / ".github" / "workflows" / "intelligence_poll.yml").read_text()
        cal = (ROOT / ".github" / "workflows" / "factcheck_calibration.yml").read_text()
        self.assertIn("GEMINI_MODEL_OTHER: ${{ vars.GEMINI_MODEL_OTHER }}", poll)
        self.assertIn("GEMINI_MODEL_FACTCHECK: ${{ vars.GEMINI_MODEL_FACTCHECK }}", cal)

    def test_an_empty_variable_is_the_code_default_and_a_set_one_moves_every_stage(self):
        # What Actions writes for an unset variable is the empty string.
        cfg = reloaded_config(GEMINI_MODEL="")
        self.assertEqual(cfg.GEMINI_MODEL, "gemini-3.6-flash")
        self.assertTrue(all(m == "gemini-3.6-flash" for m in cfg.GEMINI_STAGE_MODELS.values()))
        cfg = reloaded_config(GEMINI_MODEL="gemini-next-flash", GEMINI_MODEL_SCRIPT="")
        self.assertTrue(all(m == "gemini-next-flash" for m in cfg.GEMINI_STAGE_MODELS.values()))
        cfg = reloaded_config(GEMINI_MODEL="gemini-next-flash", GEMINI_MODEL_SCRIPT="gemini-big")
        self.assertEqual(cfg.GEMINI_STAGE_MODELS["script"], "gemini-big")
        self.assertEqual(cfg.GEMINI_STAGE_MODELS["topic"], "gemini-next-flash")
        importlib.reload(config)

    def test_config_reads_gemini_model_as_getenv_or_default(self):
        self.assertIn('GEMINI_MODEL = (os.getenv("GEMINI_MODEL") or "gemini-3.6-flash")', (ROOT / "config.py").read_text())
