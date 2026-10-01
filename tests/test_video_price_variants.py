"""Video price variants (migration 0070): the resolution and the soundtrack of a
clip are sent to the vendor and priced by setting.

No network, no key, no paid call: fake sessions only. What must hold:

* the vendor call always carries what the quote priced: Seedance and Wan the
  resolution (the job's, else the registry's ``default_resolution``), Seedance
  1.5 pro and Kling v3 the soundtrack flag (the job's, else silent) — never the
  vendor's own default, which would bill a different clip under the quoted price;
* a model not priced by sound is never sent a flag the job did not name, and a
  setting the model does not list is refused before any call;
* the registry states the variants and the credit units they are sold by
  (``model_<id>_<unit>[_<variant>]``), validates them, and an unread price is
  null ("unknown"), never 0;
* 0070 is built on the LATEST function bodies: every string literal of 0060's
  creative_price / creative_params_problem / sellable_models survives.
"""

from __future__ import annotations

import copy
import re
import tempfile
import unittest
from pathlib import Path

from modules import creative_adapters as ca
from modules import creative_worker as cw
from modules import model_registry as reg
from modules.capabilities import build_adapter
from modules.capabilities.base import CapabilityRequest
from tests.test_creative_media_inputs import FakeSession
from tests.test_creative_worker import JOB, ORG

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
SQL_PATH = MIGRATIONS / "0070_video_price_variants.sql"
ENV = {"SEEDANCE_API_KEY": "s" * 30, "WAN_API_KEY": "w" * 30, "KLING_API_KEY": "k" * 30}
SEED_OK = {"id": "task-1"}
WAN_OK = {"output": {"task_id": "task-1"}}
KLING_OK = {"code": 0, "data": {"task_id": "task-1"}}


def doc():
    return copy.deepcopy(reg.json.loads(reg.REGISTRY_PATH.read_text()))


def entry_by_id(d, mid):
    return next(m for m in d["models"] if m["id"] == mid)


def sent_body(sess):
    return sess.sent[0]["json"] if "json" in sess.sent[0] else sess.sent[0]["json_body"]


class Tmp(unittest.TestCase):
    def request(self, cap, params):
        return cw.GenerationRequest(job_id=JOB, org_id=ORG, capability=cap, model="m", params=params,
                                    input_files=())

    def adapter(self, model, route):
        entry = reg.get(model)
        sess = FakeSession([route])
        return ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=ENV, session=sess), sync_store={}), sess


SEED = ("POST", "/contents/generations/tasks", 200, SEED_OK)
WAN = ("POST", "video-synthesis", 200, WAN_OK)
KLING = ("POST", "/v1/videos/text2video", 200, KLING_OK)


# ── what is sent ─────────────────────────────────────────────────────────────

class WhatIsSent(Tmp):
    def test_seedance_with_no_settings_is_sent_720p_and_a_silent_clip(self):
        ra, sess = self.adapter("seedance-1.5-pro", SEED)
        ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5}))
        body = sent_body(sess)
        self.assertEqual(body["resolution"], "720p")
        self.assertIs(body["generate_audio"], False)

    def test_seedance_sends_the_resolution_and_sound_the_job_was_quoted(self):
        ra, sess = self.adapter("seedance-1.5-pro", SEED)
        ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5, "resolution": "1080p", "audio": True}))
        body = sent_body(sess)
        self.assertEqual(body["resolution"], "1080p")
        self.assertIs(body["generate_audio"], True)

    def test_seedance_1_0_is_sent_a_resolution_but_no_sound_flag_it_never_priced(self):
        ra, sess = self.adapter("seedance-1.0-pro", SEED)
        ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5}))
        body = sent_body(sess)
        self.assertEqual(body["resolution"], "720p")
        self.assertNotIn("generate_audio", body)

    def test_wan_is_sent_the_quoted_resolution_in_the_vendors_case(self):
        for params, want in (({}, "720P"), ({"resolution": "1080p"}, "1080P")):
            ra, sess = self.adapter("wan-2.7", WAN)
            ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5, **params}))
            self.assertEqual(sent_body(sess)["parameters"]["resolution"], want)

    def test_kling_v3_is_sent_sound_off_unless_the_job_asked_for_it(self):
        for params, want in (({}, "off"), ({"audio": False}, "off"), ({"audio": True}, "on")):
            ra, sess = self.adapter("kling-v3", KLING)
            ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5, **params}))
            self.assertEqual(sent_body(sess)["sound"], want, params)

    def test_a_model_not_priced_by_sound_is_never_sent_a_flag_the_job_did_not_name(self):
        ra, sess = self.adapter("kling-v2.6", KLING)
        ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5}))
        self.assertNotIn("sound", sent_body(sess))

    def test_sound_on_a_model_that_makes_none_is_refused_before_any_call(self):
        ra, sess = self.adapter("kling-v2.6", KLING)
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5, "audio": True}))
        self.assertEqual(cm.exception.code, "bad_request")
        self.assertEqual(sess.sent, [])

    def test_a_resolution_the_model_does_not_list_is_refused_before_any_call(self):
        for model, route, res in (("wan-2.7", WAN, "480p"), ("seedance-1.5-pro", SEED, "4k"),
                                  ("kling-v3", KLING, "720p")):
            ra, sess = self.adapter(model, route)
            with self.assertRaises(ca.CreativeAdapterError, msg=model) as cm:
                ra.submit(self.request("t2v", {"prompt": "a boat", "duration_s": 5, "resolution": res}))
            self.assertEqual(cm.exception.code, "bad_request")
            self.assertEqual(sess.sent, [], model)

    def test_audio_is_a_param_of_the_job_and_only_a_real_boolean(self):
        req = ca.capability_request(self.request("t2v", {"prompt": "x", "audio": True}))
        self.assertIs(req.audio, True)
        self.assertIs(ca.capability_request(self.request("t2v", {"prompt": "x", "audio": False})).audio, False)
        self.assertIsNone(ca.capability_request(self.request("t2v", {"prompt": "x"})).audio)
        for bad in ("true", 1, None, [True]):
            self.assertIsNone(ca.capability_request(self.request("t2v", {"prompt": "x", "audio": bad})).audio, bad)

    def test_an_adapter_that_sends_no_audio_flag_refuses_a_request_naming_one(self):
        entry = reg.get("wan-2.7")
        self.assertIn("adapter video.wan does not send an audio flag",
                      build_adapter(entry.adapter, env=ENV, session=FakeSession([]))
                      .problems(CapabilityRequest("t2v", "x", audio=True), entry))


# ── the registry ─────────────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def test_the_models_state_how_they_are_priced(self):
        by = {m: reg.get(m).variants_by for m in ("seedance-1.5-pro", "wan-2.7", "kling-v3")}
        self.assertEqual(by, {"seedance-1.5-pro": "resolution_audio", "wan-2.7": "resolution", "kling-v3": "audio"})
        self.assertEqual(reg.get("seedance-1.5-pro").default_resolution, "720p")
        self.assertEqual(reg.get("wan-2.7").default_resolution, "720p")
        self.assertIsNone(reg.get("kling-v3").default_resolution)

    def test_the_prices_read_on_2026_10_01(self):
        def prices(mid):
            return reg.get(mid).raw["pricing"]["variants"]["prices"]
        self.assertEqual(prices("seedance-1.5-pro"), {
            "480p_silent": None, "480p_audio": None, "720p_silent": 0.026, "720p_audio": 0.052,
            "1080p_silent": None, "1080p_audio": 0.116})
        self.assertEqual(prices("wan-2.7"), {"720p": 0.10, "1080p": 0.15})
        self.assertEqual(prices("kling-v3"), {"silent": 0.084, "audio": 0.126})

    def test_a_setting_nobody_read_a_price_for_is_unknown_never_zero(self):
        prices = reg.get("seedance-1.5-pro").raw["pricing"]["variants"]["prices"]
        for k in ("480p_silent", "480p_audio", "1080p_silent"):
            self.assertIsNone(prices[k], k)
        self.assertNotIn(0, [v for v in prices.values()])

    def test_credit_units_follow_the_naming_rule(self):
        self.assertEqual(reg.credit_unit_for("seedance-1.5-pro", "second", "720p_audio"),
                         "model_seedance_1_5_pro_second_720p_audio")
        self.assertEqual(reg.credit_unit_for("wan-2.7", "second", "1080p"), "model_wan_2_7_second_1080p")
        self.assertEqual(reg.credit_unit_for("kling-v3", "second", "silent"), "model_kling_v3_second_silent")
        for mid in ("seedance-1.5-pro", "wan-2.7", "kling-v3"):
            e = reg.get(mid)
            for k in e.raw["pricing"]["variants"]["prices"]:
                unit = reg.credit_unit_for(mid, "second", k)
                self.assertTrue(reg.CREDIT_UNIT_RE.fullmatch(unit), unit)
                self.assertTrue(unit.startswith(e.credit_unit + "_"), unit)

    def test_the_migration_seeds_exactly_the_priced_variants_at_usd_x_100(self):
        sql = SQL_PATH.read_text()
        seeded = dict(re.findall(r"\('(model_[a-z0-9_]+)', ([0-9.]+), 1\.5,", sql))
        want = {}
        for mid in ("seedance-1.5-pro", "wan-2.7", "kling-v3"):
            for k, usd in reg.get(mid).raw["pricing"]["variants"]["prices"].items():
                if usd is not None:
                    want[reg.credit_unit_for(mid, "second", k)] = usd * 100
        self.assertEqual(sorted(seeded), sorted(want))
        for unit, credits in seeded.items():
            self.assertAlmostEqual(float(credits), want[unit], places=6, msg=unit)

    def test_no_other_model_is_priced_by_sound_or_pins_a_resolution(self):
        self.assertEqual(sorted(m.id for m in reg.load().values() if m.default_resolution),
                         ["seedance-1.5-pro", "wan-2.7"])
        self.assertEqual(sorted(m.id for m in reg.load().values() if m.priced_by_audio),
                         ["kling-v3", "seedance-1.5-pro"])

    def test_the_shipped_registry_validates(self):
        self.assertEqual(reg.validate(doc()), [])


class RegistryRejects(unittest.TestCase):
    def mutate(self, mid, fn):
        d = doc()
        fn(entry_by_id(d, mid))
        return reg.validate(d)

    def assertRejected(self, errors, fragment):
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_a_priced_variant_the_model_does_not_list_is_refused(self):
        def f(m):
            m["pricing"]["variants"]["prices"]["4k"] = 0.2
        self.assertRejected(self.mutate("wan-2.7", f), "price variants must be listed")

        def g(m):
            m["pricing"]["variants"]["prices"]["loud"] = 0.2
        self.assertRejected(self.mutate("kling-v3", g), "price variants must be listed")

    def test_a_default_resolution_the_model_does_not_list_is_refused(self):
        self.assertRejected(self.mutate("wan-2.7", lambda m: m.__setitem__("default_resolution", "480p")),
                            "default_resolution must be a listed resolution")

    def test_a_default_resolution_on_a_model_not_priced_by_resolution_is_refused(self):
        self.assertRejected(self.mutate("seedance-1.0-pro", lambda m: m.__setitem__("default_resolution", "720p")),
                            "default_resolution must be a listed resolution of a model priced by resolution")

    def test_resolution_audio_prices_need_a_pinned_resolution(self):
        def f(m):
            del m["default_resolution"]
        self.assertRejected(self.mutate("seedance-1.5-pro", f), "need default_resolution")

    def test_audio_prices_on_a_silent_model_are_refused(self):
        def f(m):
            m["audio_out"] = False
        self.assertRejected(self.mutate("kling-v3", f), "need audio_out")

    def test_audio_prices_on_an_adapter_that_sends_no_flag_are_refused(self):
        def f(m):
            m["pricing"]["variants"] = {"by": "audio", "prices": {"silent": 0.1, "audio": 0.2}}
            m["audio_out"] = True
        self.assertRejected(self.mutate("wan-2.7", f), "does not send an audio flag")

    def test_variants_by_resolution_on_a_picture_model_are_refused(self):
        def f(m):
            m["pricing"]["variants"] = {"by": "audio", "prices": {"silent": 0.1}}
        self.assertRejected(self.mutate("openai-gpt-image-2", f), "are for video models")

    def test_a_stated_variant_price_needs_where_and_when_it_was_read(self):
        def f(m):
            m["pricing"]["source_url"] = None
        self.assertRejected(self.mutate("wan-2.7", f), "needs source_url and as_of")

    def test_a_request_for_an_unlisted_setting_is_a_problem_of_the_entry(self):
        e = reg.get("wan-2.7")
        self.assertEqual(e.problems(CapabilityRequest("t2v", "x", duration_s=5, resolution="1080p")), [])
        self.assertTrue(e.problems(CapabilityRequest("t2v", "x", duration_s=5, resolution="480p")))
        self.assertTrue(reg.get("kling-v2.6").problems(CapabilityRequest("t2v", "x", duration_s=5, audio=True)))


# ── migration 0070 is built on the latest bodies ─────────────────────────────

def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(body):
    # Comments carry apostrophes: strip them, then read the SQL string
    # literals ('' is an escaped quote inside one).
    code = re.sub(r"--[^\n]*", "", body)
    return set(re.findall(r"'(?:[^']|'')*'", code))


class BuiltOnTheLatestBodies(unittest.TestCase):
    SQL = SQL_PATH.read_text()

    def latest(self, name):
        """The newest migration BELOW 0070 that defines ``name``."""
        for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
            if f.name >= "0070" or not re.match(r"^\d{4}_", f.name):
                continue
            b = bodies(f.read_text())
            if name in b:
                return f.name, b[name]
        raise AssertionError(name)

    def test_the_functions_replaced_are_the_ones_the_quote_runs(self):
        self.assertEqual(sorted(bodies(self.SQL)),
                         ["creative_params_problem", "creative_price", "model_registry_guard", "sellable_models"])

    def test_every_literal_of_the_latest_bodies_survives(self):
        new = bodies(self.SQL)
        for name in new:
            source, old = self.latest(name)
            for literal in literals(old):
                self.assertIn(literal, literals(new[name]), f"{name} lost {literal} from {source}")

    def test_the_bodies_are_taken_from_the_files_that_last_defined_them(self):
        # If a later migration (below 0070) replaces one of these, 0070 must be rebuilt on it.
        for name in ("creative_price", "creative_params_problem", "sellable_models"):
            self.assertEqual(self.latest(name)[0], "0060_image_quality.sql", name)
        self.assertEqual(self.latest("model_registry_guard")[0], "0052_video_tools.sql")

    def test_no_check_of_the_replaced_functions_is_dropped(self):
        new = bodies(self.SQL)
        for name in new:
            _, old = self.latest(name)
            for stmt in ("perform public.creative_refuse", "return format(", "return '", "raise exception"):
                self.assertGreaterEqual(new[name].count(stmt), old.count(stmt), f"{name}: fewer {stmt}")

    def test_the_guard_reopens_the_proof_for_what_is_now_sent_and_keeps_every_earlier_trigger(self):
        guard = bodies(self.SQL)["model_registry_guard"]
        for field in ("adapter", "capabilities", "spec -> 'vendor_model'", "spec -> 'vendor_model_by_capability'",
                      "spec -> 'upscale_factors'", "spec -> 'languages'", "spec -> 'upscale_targets'",
                      "spec -> 'end_frame'",
                      # 0060 (never extended there) and 0070
                      "spec -> 'qualities'", "spec -> 'default_resolution'",
                      "spec -> 'pricing' -> 'variants' -> 'by'"):
            self.assertIn(f"new.{field} is distinct from old.{field}", guard, field)
        # A change that leaves the verification untouched must not lose it, and the proof is cleared whole.
        for line in ("new.verified_at := null;", "new.verified_by := null;", "new.verified_probe_id := null;",
                     "new.availability := 'hidden';"):
            self.assertIn(line, guard)
        self.assertIn("security definer set search_path = public, pg_temp", guard)
        self.assertIn("revoke all on function public.model_registry_guard() from public, anon, authenticated;",
                      self.SQL)

    def test_every_spec_key_the_worker_sends_because_of_a_price_is_watched_by_the_guard(self):
        # What the registry adds to a call because of how a model is priced: the guard must name each.
        guard = bodies(self.SQL)["model_registry_guard"]
        for key in ("qualities", "default_resolution"):
            self.assertIn(f"'{key}'", guard)
        self.assertIn("'variants' -> 'by'", guard)

    def test_the_quote_refuses_what_the_model_does_not_list_and_names_the_variant(self):
        price = bodies(self.SQL)["creative_price"]
        self.assertIn("(m_spec -> 'resolutions') @> jsonb_build_array(p_params ->> 'resolution')", price)
        self.assertIn("format('%s does not offer %s', mdl, p_params ->> 'resolution')", price)
        self.assertIn("format('%s does not offer a choice of sound', mdl)", price)
        self.assertIn("coalesce((p_params ->> 'audio')::boolean, false)", price)
        self.assertIn("nullif(m_spec ->> 'default_resolution', '')", price)
        self.assertIn("m_unit := m_unit || '_' ||", price)
        self.assertIn("'resolution', vres, 'audio'", price)
        # unpriced is still a refusal, never a zero
        self.assertIn("perform public.creative_refuse('unpriced',", price)

    def test_the_refusals_of_a_setting_come_before_the_price_is_read(self):
        price = bodies(self.SQL)["creative_price"]
        read = price.index("select * into rate from public.credit_prices")
        for refusal in ("does not offer %s", "does not offer a choice of sound"):
            self.assertLess(price.index(refusal), read, refusal)

    def test_security_definer_functions_pin_their_search_path_and_are_revoked(self):
        for name, body in bodies(self.SQL).items():
            if "security definer" in body:
                self.assertIn("set search_path = public, pg_temp", body, name)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      self.SQL)
        self.assertIn("revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;",
                      self.SQL)
        self.assertIn("grant execute on function public.sellable_models(text, text) to authenticated, service_role;",
                      self.SQL)

    def test_prices_are_inserted_without_overwriting_and_a_verify_query_is_given(self):
        self.assertIn("on conflict (unit) do nothing", self.SQL)
        self.assertIn("-- Verify (run after applying", self.SQL)

    def test_it_needs_0060_and_the_earlier_functions_first(self):
        self.assertIn("creative_quantity(text, jsonb)", self.SQL)
        self.assertIn("0070 needs 0060_image_quality.sql", self.SQL)

    def test_the_settings_the_database_allows_are_the_ones_the_worker_knows(self):
        from modules.capabilities.base import VIDEO_VARIANT_CAPABILITIES, T2V, I2V
        self.assertEqual(VIDEO_VARIANT_CAPABILITIES, frozenset({T2V, I2V}))
        self.assertIn("p_capability not in ('t2v', 'i2v')", self.SQL)
        self.assertEqual(reg.AUDIO_STATES, ("silent", "audio"))


if __name__ == "__main__":
    unittest.main()
