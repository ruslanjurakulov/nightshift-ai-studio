"""A vendor-announced shutdown date: the registry field, the Google entries, the sale guard, the Veo client.

Google's deprecations page (ai.google.dev/gemini-api/docs/deprecations, read 2026-10-25)
lists veo-3.1-generate-preview, -fast- and -lite- with shutdown 2026-10-22 and
calls every date there "the earliest possible". These tests pin what Nightshift
does with that, and what it refuses to do:

* the date is a registry field with its source, and it ends the sale (migration
  0125) on that day; a date nobody can read does not read as "safe";
* the Veo client in modules/video_providers.py stops BEFORE any request when
  the model is past that date or unset, says why, and never switches model
  (CLAUDE.md #4);
* every Google entry is web_only (Google APIs Terms 4(a)) and carries the
  18+ and consumer-use clauses of the Gemini API Additional Terms.

Nothing here makes a request to anyone.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

import config
from modules import model_registry as reg
from modules import video_providers as vp
from modules.minimax_broll import VideoModelUnavailable
from tests.test_model_registry import doc, entry_by_id

REPO = Path(__file__).resolve().parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"
NEW_PATH = MIGRATIONS / "0125_model_shutdown.sql"
OLD_PATH = MIGRATIONS / "0124_model_switch.sql"
ROLLBACK_PATH = REPO / "docs" / "sql" / "rollback_0125_model_shutdown.sql"

VEO_IDS = ("veo-3.1", "veo-3.1-fast", "veo-3.1-lite")
OPS_IDS = ("gemini-2.5-flash-image-expand", "gemini-2.5-flash-image-relight", "gemini-2.5-flash-image-erase")
DEPRECATIONS = "https://ai.google.dev/gemini-api/docs/deprecations"


class RegistryFieldTests(unittest.TestCase):
    def test_the_veo_previews_carry_googles_earliest_shutdown_date_and_its_source(self):
        r = reg.load()
        for mid in VEO_IDS:
            s = r[mid].raw["shutdown"]
            self.assertEqual((s["on"], s["source_url"], s["as_of"], s["replacement"]),
                             ("2026-10-22", DEPRECATIONS, "2026-10-25", "gemini-omni-1.1-flash"), mid)
            self.assertEqual(r[mid].shutdown_on, date(2026, 10, 22))
            self.assertIn("EARLIEST", r[mid].raw["api_documented"]["note"], mid)
            self.assertIn("tools/probe_models.py", r[mid].raw["api_documented"]["note"], mid)

    def test_the_picture_ops_on_gemini_2_5_flash_image_carry_its_2027_date(self):
        r = reg.load()
        for mid in OPS_IDS:
            self.assertEqual(r[mid].raw["shutdown"]["on"], "2027-03-15", mid)
            self.assertEqual(r[mid].raw["shutdown"]["replacement"], "gemini-3.1-flash-lite-image", mid)
            self.assertFalse(r[mid].shut_down(date(2026, 10, 25)), mid)
            self.assertTrue(r[mid].shut_down(date(2027, 3, 15)), mid)

    def test_no_other_entry_claims_a_shutdown_date(self):
        # A date is a vendor announcement with a source, never a guess: only the entries Google's page lists.
        have = {mid for mid, e in reg.load().items() if "shutdown" in e.raw}
        self.assertEqual(have, set(VEO_IDS) | set(OPS_IDS))

    def test_gemini_3_1_flash_image_names_its_replacement_but_has_no_date(self):
        e = reg.load()["gemini-3.1-flash-image"]
        self.assertNotIn("shutdown", e.raw)                    # Google: "No shutdown date announced"
        self.assertFalse(e.shut_down(date(2999, 1, 1)))
        note = e.raw["api_documented"]["note"]
        self.assertIn("gemini-nano-banana-2.1", note)
        self.assertIn("no shutdown date", note)

    def test_the_boundary_day_is_already_shut_down(self):
        e = reg.load()["veo-3.1"]
        self.assertFalse(e.shut_down(date(2026, 10, 21)))
        self.assertTrue(e.shut_down(date(2026, 10, 22)))
        self.assertTrue(e.shut_down(date(2026, 10, 23)))

    def test_an_entry_without_a_date_is_never_shut_down_here(self):
        self.assertFalse(reg.load()["openai-gpt-image-2"].shut_down(date(2999, 1, 1)))

    def test_the_schema_demands_the_source_and_a_real_date(self):
        def mutate(fn):
            d = doc()
            fn(entry_by_id(d, "veo-3.1"))
            return reg.validate(d)

        self.assertEqual(mutate(lambda m: None), [])
        for key in ("source_url", "as_of", "on"):
            self.assertTrue(mutate(lambda m, k=key: m["shutdown"].pop(k)), key)
        self.assertTrue(mutate(lambda m: m["shutdown"].__setitem__("extra", 1)))
        self.assertTrue(mutate(lambda m: m["shutdown"].__setitem__("on", "Oct 22, 2026")))
        self.assertTrue(mutate(lambda m: m["shutdown"].__setitem__("source_url", "http://insecure.example")))
        # The migration casts `on` to a date: a calendar nonsense that matches the pattern is refused here.
        errs = mutate(lambda m: m["shutdown"].__setitem__("on", "2026-13-45"))
        self.assertTrue(any("shutdown.on is not a calendar date" in e for e in errs), errs)
        errs = mutate(lambda m: m["shutdown"].__setitem__("as_of", "2026-02-30"))
        self.assertTrue(any("shutdown.as_of is not a calendar date" in e for e in errs), errs)

    def test_the_date_reaches_the_database_row_with_the_other_static_facts(self):
        rows = {r["id"]: r for r in reg.sync_rows(list(reg.registry().values()))}
        self.assertEqual(rows["veo-3.1-lite"]["spec"]["shutdown"]["on"], "2026-10-22")
        self.assertNotIn("shutdown", rows["gemini-3.1-flash-image"]["spec"])


class GoogleTermsTests(unittest.TestCase):
    def google(self):
        found = [e for e in reg.load().values() if e.provider == "google"]
        self.assertGreaterEqual(len(found), 10)             # three images, three ops, one describe, three Veo
        return found

    def test_every_google_entry_is_web_only_because_of_the_apis_terms_section_4a(self):
        for e in self.google():
            self.assertEqual(e.api_exposure, "web_only", e.id)
            notes = " ".join(e.raw["terms_notes"])
            self.assertIn("§4(a)", notes, e.id)
            self.assertIn("sublicensing an API", notes, e.id)

    def test_every_google_entry_carries_the_18_plus_and_the_consumer_clauses(self):
        for e in self.google():
            notes = e.raw["terms_notes"]
            age = [n for n in notes if "Age Requirements" in n]
            self.assertEqual(len(age), 1, e.id)
            self.assertIn("18+", age[0])
            self.assertIn("likely to be accessed by people under 18", age[0])
            self.assertIn("Gemini API Additional Terms", age[0])
            self.assertTrue(any("not for consumer use" in n for n in notes), e.id)
            # The older Cloud-terms notes stay (tests/test_model_registry.py pins them).
            self.assertTrue(any("§20.d" in n for n in notes), e.id)

    def test_prices_and_sellability_of_the_google_entries_were_not_touched(self):
        # This change adds notes, web_only and dates. It sets no gate and prices nothing.
        r = reg.load()
        for mid, price in (("veo-3.1", 0.4), ("veo-3.1-fast", 0.1), ("veo-3.1-lite", 0.05),
                           ("gemini-3.1-flash-image", 0.067), ("gemini-3-pro-image", 0.134)):
            self.assertEqual(r[mid].raw["pricing"]["provider_usd_per_unit"], price, mid)
            self.assertIsNone(r[mid].terms_gate, mid)
        for mid in OPS_IDS:
            self.assertEqual(r[mid].terms_gate, "terms_review_required", mid)


def bodies(text):
    return {m.group(1): m.group(0) for m in re.finditer(r"(?m)^create or replace function public\.(\w+)\(.*?^\$\$;\n", text, re.S)}


def body(fn):
    return fn[fn.index("$$") + 2: fn.rindex("$$")]


def md5_of(fn):
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


NEW_TEXT = NEW_PATH.read_text(encoding="utf-8")
ROLLBACK_TEXT = ROLLBACK_PATH.read_text(encoding="utf-8")
NEW = bodies(NEW_TEXT)
OLD = bodies(OLD_PATH.read_text(encoding="utf-8"))          # 0124's: the latest before this file
CODE = "\n".join(line.split("--", 1)[0] for line in NEW_TEXT.splitlines())

ADDED = {
    "sellable_models": "       -- 0125: a shutdown date the vendor announced (spec.shutdown.on) that has come ends the sale.\n"
                       "       and not public.model_past_shutdown(m.spec)\n",
    "creative_price": "     -- 0125: the same date, so a model named directly is not quoted either.\n"
                      "     and not public.model_past_shutdown(r.spec)\n",
}


class MigrationTests(unittest.TestCase):
    def test_it_replaces_exactly_the_helper_and_the_two_functions(self):
        self.assertEqual(set(NEW), {"model_past_shutdown", "sellable_models", "creative_price"})

    def test_each_replaced_function_is_0124s_body_plus_exactly_the_added_lines(self):
        for name, added in ADDED.items():
            self.assertEqual(NEW[name].count(added), 1, name)
            self.assertEqual(NEW[name].replace(added, ""), OLD[name], f"{name} differs from 0124 beyond the guard")
            self.assertIn("model_is_available", NEW[name], f"{name} lost 0124's switch")

    def test_the_drift_guard_carries_the_hashes_of_the_repos_bodies(self):
        # 0124's md5 and this file's md5 of each replaced function, and this file's own helper: recomputed from the files.
        for name in ("sellable_models", "creative_price"):
            self.assertIn(md5_of(OLD[name]), NEW_TEXT, name)
            self.assertIn(md5_of(NEW[name]), NEW_TEXT, name)
            self.assertIn(md5_of(OLD[name]), ROLLBACK_TEXT, name)
            self.assertIn(md5_of(NEW[name]), ROLLBACK_TEXT, name)
        self.assertIn(md5_of(NEW["model_past_shutdown"]), NEW_TEXT)
        self.assertIn("0125 found a sellable_models() that is neither 0124''s body nor 0125''s", NEW_TEXT)
        self.assertIn("0125 found a creative_price() that is neither 0124''s body nor 0125''s", NEW_TEXT)

    def test_the_rollback_restores_0124s_text_byte_for_byte_and_drops_the_helper(self):
        rb = bodies(ROLLBACK_TEXT)
        for name in ("sellable_models", "creative_price"):
            self.assertEqual(rb[name], OLD[name], name)
        self.assertIn("drop function if exists public.model_past_shutdown(jsonb);", ROLLBACK_TEXT)
        self.assertIn("rollback 0125 found a sellable_models() that is neither 0125''s body nor 0124''s", ROLLBACK_TEXT)
        self.assertEqual(ROLLBACK_TEXT.count("begin;"), 1)
        self.assertEqual(ROLLBACK_TEXT.count("commit;"), 1)

    def test_the_helper_fails_closed_and_reads_the_date_in_the_database_not_the_clock_of_the_caller(self):
        h = NEW["model_past_shutdown"]
        self.assertIn("<= (now() at time zone 'utc')::date", h)
        self.assertNotIn("current_date", h)
        self.assertRegex(h, r"exception when others then\s+return true;")
        self.assertIn("is distinct from 'object'", h)
        self.assertIn("is distinct from 'string'", h)
        self.assertIn("!~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'", h)
        self.assertRegex(h, r"if p_spec is null or not \(p_spec \? 'shutdown'\) then\s+return false;")

    def test_it_refuses_to_apply_without_0124_before_changing_anything(self):
        self.assertIn("0125 needs 0124_model_switch.sql (and 0100): apply them first", NEW_TEXT)
        self.assertIn("to_regprocedure('public.model_is_available(text)') is null", NEW_TEXT)
        self.assertLess(NEW_TEXT.index("0125 needs 0124_model_switch.sql"), NEW_TEXT.index("create or replace function"))
        self.assertLess(NEW_TEXT.index("0125 found a sellable_models()"), NEW_TEXT.index("create or replace function"))

    def test_the_helper_is_internal_and_the_two_functions_keep_their_grants(self):
        self.assertIn("revoke all on function public.model_past_shutdown(jsonb) from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("grant execute on function public.model_past_shutdown", CODE)
        self.assertIn("revoke all on function public.sellable_models(text, text) from public, anon;\n"
                      "grant execute on function public.sellable_models(text, text) to authenticated, service_role;", CODE)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;", CODE)
        self.assertNotIn("grant execute on function public.creative_price", CODE)

    def test_additive_and_it_sells_nothing(self):
        low = CODE.lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table"):
            self.assertNotIn(word, low)
        self.assertNotRegex(low, r"\b(insert\s+into|update\s+public\.|upsert)")
        self.assertIn("-- Verify", NEW_TEXT)
        for col in ("date_compared", "unreadable_reads_as_past", "both_read_it_and_0124_kept", "functions_scoped"):
            self.assertIn(col, NEW_TEXT[NEW_TEXT.index("-- Verify"):])

    def test_a_later_migration_that_replaces_either_function_must_keep_the_guard(self):
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if int(path.name[:4]) <= 125:
                continue
            for name, fn in bodies(path.read_text(encoding="utf-8")).items():
                if name in ("sellable_models", "creative_price"):
                    self.assertIn("model_past_shutdown", fn, f"{path.name} replaces {name} without the shutdown guard")
                    self.assertIn("model_is_available", fn, f"{path.name} replaces {name} without 0124's switch")

    def test_the_security_lab_declares_the_helper_as_service_only_and_can_take_0125_off(self):
        text = (REPO / "tests" / "security" / "sec_expectations.py").read_text()
        self.assertIn('"model_past_shutdown": SERVICE,', text)
        lab = (REPO / "tests" / "security" / "sec_db.py").read_text()
        self.assertIn("def take_off_0125(", lab)
        self.assertIn("def put_back_0125(", lab)


def veo_config(**values):
    """vp._veo_config() with config set the way a worker would have it (no request is made)."""
    base = {"VEO_API_KEY": "k" * 20, "VEO_MODEL": "", "VEO_BASE_URL": "https://generativelanguage.googleapis.com",
            "VEO_SUBMIT_PATH": "/v1beta/models/{model}:predictLongRunning"}
    base.update(values)
    with mock.patch.multiple(config, **base, create=True):
        return vp._veo_config()


class VeoClientTests(unittest.TestCase):
    def assertStops(self, cfg, *needles):
        client = vp.GenericAsyncVideoClient(cfg)
        client.session = mock.Mock()
        with self.assertRaises(VideoModelUnavailable) as ctx:
            client.preflight()
        for n in needles:
            self.assertIn(n, str(ctx.exception))
        # Before any request, and the model the owner configured is the model that was refused: no swap.
        client.session.post.assert_not_called()
        client.session.get.assert_not_called()
        self.assertEqual(cfg.model, ctx.exception.model)
        return ctx.exception

    def test_unset_model_has_no_default_and_the_run_stops_with_the_remedy(self):
        cfg = veo_config(VEO_MODEL="")
        self.assertEqual(cfg.model, "")
        e = self.assertStops(cfg, "VEO_MODEL is not set", "there is no default", "2026-10-22", DEPRECATIONS)
        self.assertIn("CHRONOS_VIDEO_PROVIDER", e.remedy)

    def test_each_veo_3_1_preview_is_refused_with_googles_date_and_the_probe_to_run(self):
        for vendor, mid in (("veo-3.1-generate-preview", "veo-3.1"), ("veo-3.1-fast-generate-preview", "veo-3.1-fast"),
                            ("veo-3.1-lite-generate-preview", "veo-3.1-lite")):
            with self.subTest(vendor):
                cfg = veo_config(VEO_MODEL=vendor)
                self.assertEqual(cfg.model, vendor)                   # kept as configured, never rewritten
                e = self.assertStops(cfg, vendor, "2026-10-22", "EARLIEST", "may already be off",
                                     "not verified here", "will not guess or switch models", "gemini-omni-1.1-flash",
                                     f"tools/probe_models.py --model {mid}")
                self.assertIn(DEPRECATIONS, e.remedy)

    def test_a_past_shutdown_id_spelled_into_a_custom_submit_path_is_refused_too(self):
        cfg = veo_config(VEO_MODEL="veo-test-model",
                         VEO_SUBMIT_PATH="/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning")
        self.assertStops(cfg, "veo-3.1-fast-generate-preview", "2026-10-22")

    def test_the_old_hard_shutdown_ids_are_still_refused_and_no_longer_point_at_a_dead_default(self):
        e = self.assertStops(veo_config(VEO_MODEL="veo-3.0-generate-preview"), "shut down by Google on 2025-11-12")
        self.assertNotIn("veo-3.1-generate-preview", e.remedy)

    def test_an_id_the_registry_has_no_date_for_is_not_blocked_by_a_guess(self):
        # Nothing announced is not "safe" (the probe decides), but it is not this guard's call to refuse it.
        cfg = veo_config(VEO_MODEL="veo-test-model")
        self.assertEqual(cfg.config_problem, "")
        vp.GenericAsyncVideoClient(cfg).preflight()

    def test_before_the_date_the_same_id_is_not_blocked(self):
        # The guard reads the clock through the registry entry, so a date in the future leaves the id alone.
        with mock.patch.object(reg.ModelEntry, "shut_down", return_value=False):
            cfg = veo_config(VEO_MODEL="veo-3.1-generate-preview")
        self.assertEqual(cfg.config_problem, "")

    def test_the_guard_follows_the_registry_not_a_second_list(self):
        # Re-opening an id after a probe is ONE edit (the registry's shutdown.on), which also re-opens its sale.
        d = copy.deepcopy(doc())
        entry_by_id(d, "veo-3.1")["shutdown"]["on"] = "2999-01-01"
        with mock.patch.object(reg, "registry", return_value={m["id"]: reg._entry(m) for m in d["models"]}):
            cfg = veo_config(VEO_MODEL="veo-3.1-generate-preview")
            self.assertEqual(cfg.config_problem, "")
            fast = veo_config(VEO_MODEL="veo-3.1-fast-generate-preview")
            self.assertIn("2026-10-22", fast.config_problem)

    def test_a_deprecated_id_cannot_dodge_the_guard_by_how_it_is_written(self):
        spellings = ("VEO-3.1-GENERATE-PREVIEW", "models/veo-3.1-generate-preview", "veo-3.1-generate-preview:predictLongRunning",
                     "veo-3.1-generate-preview?x=1", "x/../veo-3.1-generate-preview", "Models/Veo-3.1-Fast-Generate-Preview",
                     "veo-3.1-lite-generate-preview/")
        for spelling in spellings:
            with self.subTest(spelling):
                cfg = veo_config(VEO_MODEL=spelling)
                self.assertEqual(cfg.model, spelling)                          # kept as configured, never rewritten
                self.assertStops(cfg, "2026-10-22", "will not guess or switch models")

    def test_the_old_hard_shutdown_ids_are_matched_in_any_spelling_too(self):
        for spelling in ("VEO-3.0-GENERATE-PREVIEW", "models/veo-3.0-fast-generate-preview", "veo-3.0-generate-preview:x"):
            with self.subTest(spelling):
                self.assertStops(veo_config(VEO_MODEL=spelling), "shut down by Google on 2025-11-12")

    def test_a_model_that_is_not_a_bare_id_is_refused_rather_than_put_into_the_path(self):
        for bad in ("models/veo-test", "veo-test:predictLongRunning", "veo-test?x=1", "veo-test/../x", "veo test", "-veo"):
            with self.subTest(bad):
                self.assertStops(veo_config(VEO_MODEL=bad), "must be a bare model id")

    def test_a_longer_id_that_merely_starts_with_a_listed_one_is_a_different_id(self):
        cfg = veo_config(VEO_MODEL="veo-3.1-generate-preview-001")
        self.assertEqual(cfg.config_problem, "")

    def test_the_workflows_forward_veo_model_next_to_the_key_and_the_docs_say_it_is_required(self):
        for rel in (".github/workflows/daily_video.yml", ".github/workflows/doctor_scheduled.yml"):
            text = (REPO / rel).read_text()
            self.assertIn("          VEO_API_KEY: ${{ secrets.VEO_API_KEY }}\n", text, rel)
            self.assertIn("          VEO_MODEL: ${{ vars.VEO_MODEL }}\n", text, rel)
        self.assertIn("WORKERENV_VEO_MODEL: ${{ vars.VEO_MODEL }}", (REPO / ".github/workflows/deploy_web.yml").read_text())
        guide = (REPO / "docs" / "VIDEO_GO_LIVE.md").read_text()
        self.assertRegex(guide, r"`veo` \| `VEO_API_KEY` and \*\*`VEO_MODEL`\*\*[^|]*REQUIRED")

    def test_the_worker_env_example_says_there_is_no_default(self):
        text = (REPO / "deploy" / ".env.worker.example").read_text()
        self.assertIn("VEO_MODEL has NO default", text)
        self.assertIn("\nVEO_MODEL=\n", text)

    def test_config_has_no_default_model(self):
        src = (REPO / "config.py").read_text()
        self.assertIn('VEO_MODEL = os.getenv("VEO_MODEL", "").strip()\n', src)
        self.assertNotIn('or "veo-3.1', src)


if __name__ == "__main__":
    unittest.main()


class VeoAdapterAtSubmitTests(unittest.TestCase):
    """The Creative OS adapter: a job priced before the date and advanced after it is refused before any request."""

    def adapter(self, env=None):
        from modules.capabilities import build_adapter

        session = mock.Mock()
        resp = mock.Mock(status_code=200)
        resp.json.return_value = {"name": "models/veo-test-model/operations/op1"}
        session.request.return_value = resp
        return build_adapter("video.veo", env={"VEO_API_KEY": "k" * 24, **(env or {})}, session=session), session

    def request(self):
        from modules.capabilities.base import T2V, CapabilityRequest

        return CapabilityRequest(T2V, "a boat", duration_s=4, resolution="720p")

    def test_each_past_shutdown_veo_id_is_refused_in_any_spelling_before_any_request_and_no_model_is_tried(self):
        from modules.capabilities.base import E_NOT_FOUND, AdapterError

        for vendor in ("veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview",
                       "models/VEO-3.1-GENERATE-PREVIEW", "veo-3.1-generate-preview:predictLongRunning"):
            with self.subTest(vendor):
                a, session = self.adapter()
                with self.assertRaises(AdapterError) as cm:
                    a.submit(self.request(), vendor)
                e = cm.exception
                self.assertEqual(e.code, E_NOT_FOUND)
                self.assertTrue(e.not_accepted)                      # nothing was sent
                for needle in ("2026-10-22", "EARLIEST", "nothing was sent", "no other model was tried", "tools/probe_models.py"):
                    self.assertIn(needle, e.message)
                session.request.assert_not_called()

    def test_an_id_with_no_announced_date_is_not_refused(self):
        a, session = self.adapter()
        task = a.submit(self.request(), "veo-test-model")
        self.assertEqual(task.vendor_model, "veo-test-model")
        session.request.assert_called_once()

    def test_before_the_date_the_same_id_is_sent(self):
        a, session = self.adapter()
        with mock.patch.object(reg.ModelEntry, "shut_down", return_value=False):
            a.submit(self.request(), "veo-3.1-generate-preview")
        session.request.assert_called_once()

    def test_only_the_probe_can_let_one_past_shutdown_id_through_and_only_that_id(self):
        from tools import probe_models

        a, session = self.adapter({"NIGHTSHIFT_PROBE_PAST_SHUTDOWN": "veo-3.1-generate-preview"})
        a.submit(self.request(), "veo-3.1-generate-preview")
        session.request.assert_called_once()
        from modules.capabilities.base import AdapterError

        a, session = self.adapter({"NIGHTSHIFT_PROBE_PAST_SHUTDOWN": "veo-3.1-generate-preview"})
        with self.assertRaises(AdapterError):
            a.submit(self.request(), "veo-3.1-fast-generate-preview")          # another id is not let through
        session.request.assert_not_called()
        # the probe tool names exactly the vendor model it probes, and only for a past-shutdown entry
        seen = {}
        real = probe_models.build_adapter

        def spy(key, env=None, session=None):
            seen[key] = dict(env)
            return real(key, env=env, session=session)

        for mid in ("veo-3.1-lite", "gemini-3-pro-image"):
            entry = reg.get(mid)
            with mock.patch.object(probe_models, "build_adapter", spy), tempfile.TemporaryDirectory() as d:
                ok = mock.Mock(status_code=200)
                ok.json.return_value = {"name": "models/veo-test-model/operations/op1"}
                sess = mock.Mock()
                sess.request.return_value = ok
                sess.get.return_value = ok
                probe_models.run_probe(entry, env={"GEMINI_API_KEY": "k" * 24}, voice_id=None, workdir=Path(d), session=sess,
                                       timeout_s=1, poll_every_s=0, sleep=lambda s: None)
            if entry.shut_down():
                self.assertEqual(seen[entry.adapter]["NIGHTSHIFT_PROBE_PAST_SHUTDOWN"], entry.vendor_model)
            else:
                self.assertNotIn("NIGHTSHIFT_PROBE_PAST_SHUTDOWN", seen[entry.adapter])
