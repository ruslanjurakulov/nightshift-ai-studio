"""Image quality tiers (migration 0060): low / medium / high for the OpenAI
picture models, sent to the vendor and priced by tier.

No network, no key, no paid call: fake sessions only. What must hold:

* the vendor call carries ``quality`` — the tier the job was quoted, else
  ``medium`` (the quote's own default), never nothing, because without the
  field the vendor renders and bills at its own, dearer, default;
* a model that lists no tiers is never sent one, and a request that names one
  is refused before the call rather than ignored;
* the registry states the tiers and the credit units they are sold by
  (``model_<id>_<unit>_<tier>``), validates them, and states no USD price it
  has not read (null is "unknown", never 0);
* 0060 is built on the LATEST function bodies: every string literal of
  0052's creative_price and 0055's creative_params_problem / sellable_models
  survives, so the video tools, describe, styles and sources still work.
"""

from __future__ import annotations

import base64
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
from tests.test_creative_media_inputs import PNG, SRC, FakeSession
from tests.test_creative_worker import JOB, ORG

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
OPENAI = ("openai-gpt-image-2", "openai-gpt-image-2.5-flare", "openai-gpt-image-2.5-sunburst")
IMG = {"data": [{"b64_json": base64.b64encode(PNG).decode()}]}


def doc():
    return copy.deepcopy(reg.json.loads(reg.REGISTRY_PATH.read_text()))


def entry_by_id(d, mid):
    return next(m for m in d["models"] if m["id"] == mid)


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = self.dir / "source.png"
        self.src.write_bytes(PNG)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, cap, params, files=()):
        return cw.GenerationRequest(job_id=JOB, org_id=ORG, capability=cap, model="m", params=params,
                                    input_files=tuple(files))

    def adapter(self, model, route, session=None):
        entry = reg.get(model)
        sess = session or FakeSession([route])
        env = {"OPENAI_API_KEY": "o" * 30, "GEMINI_API_KEY": "g" * 30}
        return ca.RegistryAdapter(entry, build_adapter(entry.adapter, env=env, session=sess), sync_store={}), sess


# ── what is sent ─────────────────────────────────────────────────────────────

class WhatIsSent(Tmp):
    def test_a_t2i_names_the_quoted_tier_in_the_generation_call(self):
        for tier in ("low", "medium", "high"):
            ra, sess = self.adapter("openai-gpt-image-2", ("POST", "/images/generations", 200, IMG))
            ra.submit(self.request("t2i", {"prompt": "a cat", "quality": tier}))
            self.assertEqual(sess.sent[0]["json"]["quality"], tier)

    def test_an_edit_names_the_quoted_tier_in_the_multipart_form(self):
        ra, sess = self.adapter("openai-gpt-image-2", ("POST", "/images/edits", 200, IMG))
        ra.submit(self.request("edit", {"prompt": "night", "source_asset_id": SRC, "quality": "high"}, [self.src]))
        self.assertEqual(sess.sent[0]["data"]["quality"], "high")

    def test_a_job_without_a_stored_tier_is_refused_before_any_call_never_given_a_default(self):
        # The database writes the tier it priced into the job's params. A job
        # without one was not priced by tier: any tier sent here (the vendor's
        # own default, or one of ours) would bill what was not quoted.
        for model in OPENAI:
            for cap, route, files in (("t2i", "/images/generations", ()), ("edit", "/images/edits", (self.src,))):
                ra, sess = self.adapter(model, ("POST", route, 200, IMG))
                params = {"prompt": "x", **({"source_asset_id": SRC} if cap == "edit" else {})}
                with self.assertRaises(ca.CreativeAdapterError) as cm:
                    ra.submit(self.request(cap, params, files))
                self.assertEqual(cm.exception.code, "bad_request", (model, cap))
                self.assertIn("no quality tier", cm.exception.message)
                self.assertEqual(sess.sent, [], (model, cap))

    def test_the_worker_sends_exactly_the_stored_tier_for_every_model(self):
        for model in OPENAI:
            for tier in ("low", "medium", "high"):
                ra, sess = self.adapter(model, ("POST", "/images/generations", 200, IMG))
                ra.submit(self.request("t2i", {"prompt": "x", "quality": tier}))
                self.assertEqual(sess.sent[0]["json"]["quality"], tier, (model, tier))

    def test_the_worker_has_no_default_tier_of_its_own(self):
        import modules.capabilities.base as base
        self.assertFalse(hasattr(base, "DEFAULT_IMAGE_QUALITY"))
        seam = Path(ca.__file__).read_text().split("def capability_request")[1]
        self.assertNotIn('"medium"', seam)

    def test_a_model_without_tiers_is_never_sent_the_field(self):
        ra, sess = self.adapter("gemini-3.1-flash-image", ("POST", ":generateContent", 200,
                                                           {"candidates": [{"content": {"parts": [
                                                               {"inlineData": {"mimeType": "image/png",
                                                                               "data": IMG["data"][0]["b64_json"]}}]}}]}))
        ra.submit(self.request("t2i", {"prompt": "x"}))
        self.assertNotIn("quality", str(sess.sent[0]["json"]))

    def test_a_tier_on_a_model_that_lists_none_is_refused_before_any_call(self):
        ra, sess = self.adapter("gemini-3.1-flash-image", ("POST", ":generateContent", 200, {}))
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(self.request("t2i", {"prompt": "x", "quality": "high"}))
        self.assertEqual(cm.exception.code, "bad_request")
        self.assertEqual(sess.sent, [])

    def test_a_tier_the_model_does_not_list_is_refused_before_any_call(self):
        ra, sess = self.adapter("openai-gpt-image-2", ("POST", "/images/generations", 200, IMG))
        with self.assertRaises(ca.CreativeAdapterError) as cm:
            ra.submit(self.request("t2i", {"prompt": "x", "quality": "ultra"}))
        self.assertIn("quality ultra is not offered", cm.exception.message)
        self.assertEqual(sess.sent, [])

    def test_the_tier_is_a_param_of_the_job_not_of_the_prompt(self):
        req = ca.capability_request(self.request("t2i", {"prompt": "high quality, ultra", "quality": "low"}))
        self.assertEqual(req.quality, "low")
        self.assertIsNone(ca.capability_request(self.request("t2i", {"prompt": "high"})).quality)

    def test_the_tier_never_reaches_a_capability_that_has_none(self):
        entry = reg.get("openai-gpt-image-2")
        self.assertIn("a quality does not apply to describe",
                      entry.problems(CapabilityRequest("describe", quality="low")))


# ── the registry ─────────────────────────────────────────────────────────────

class Registry(unittest.TestCase):
    def test_openai_models_state_their_tiers_and_how_they_are_priced(self):
        for mid in OPENAI:
            e = reg.get(mid)
            self.assertEqual(e.qualities, ("low", "medium", "high"))
            v = e.raw["pricing"]["variants"]
            self.assertEqual(v["by"], "quality")
            # Not read from the vendor's page yet: unknown, never 0 (CLAUDE.md #5).
            self.assertEqual(v["prices"], {"low": None, "medium": None, "high": None})
            self.assertIsNone(e.raw["pricing"]["provider_usd_per_unit"])

    def test_no_other_model_claims_tiers(self):
        self.assertEqual([m.id for m in reg.load().values() if m.qualities], list(OPENAI))

    def test_credit_units_follow_the_naming_rule(self):
        self.assertEqual(reg.credit_unit_for("openai-gpt-image-2", "image", "medium"),
                         "model_openai_gpt_image_2_image_medium")
        self.assertEqual(reg.credit_unit_for("openai-gpt-image-2.5-flare", "image", "low"),
                         "model_openai_gpt_image_2_5_flare_image_low")
        for mid in OPENAI:
            e = reg.get(mid)
            for tier in e.qualities:
                unit = reg.credit_unit_for(mid, "image", tier)
                self.assertTrue(reg.CREDIT_UNIT_RE.fullmatch(unit), unit)
                self.assertTrue(unit.startswith(e.credit_unit + "_"), unit)

    def test_the_probe_asks_for_the_cheapest_tier(self):
        self.assertEqual(reg.get("openai-gpt-image-2").probe_request().quality, "low")

    def test_the_shipped_registry_validates(self):
        self.assertEqual(reg.validate(doc()), [])


class RegistryRejects(unittest.TestCase):
    def mutate(self, mid, fn):
        d = doc()
        fn(entry_by_id(d, mid))
        return reg.validate(d)

    def assertRejected(self, errors, fragment):
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_a_tier_outside_the_allow_list_is_refused(self):
        self.assertTrue(self.mutate("openai-gpt-image-2", lambda m: m.__setitem__("qualities", ["low", "ultra"])))

    def test_tiers_on_an_adapter_that_would_drop_them_are_refused(self):
        def f(m):
            m["qualities"] = ["low", "medium"]
        self.assertRejected(self.mutate("gemini-3.1-flash-image", f), "does not send a quality")

    def test_tiers_on_a_video_model_are_refused(self):
        self.assertRejected(self.mutate("veo-3.1", lambda m: m.__setitem__("qualities", ["low"])),
                            "qualities is for image models")

    def test_a_priced_tier_not_listed_by_the_model_is_refused(self):
        def f(m):
            m["qualities"] = ["low", "medium"]          # the variants still price 'high'
        self.assertRejected(self.mutate("openai-gpt-image-2", f), "price variants must be listed")

    def test_a_stated_tier_price_needs_where_and_when_it_was_read(self):
        def f(m):
            m["pricing"]["variants"]["prices"]["medium"] = 0.04
        self.assertRejected(self.mutate("openai-gpt-image-2", f), "needs source_url and as_of")

        def g(m):
            f(m)
            m["pricing"]["source_url"] = "https://example.com/pricing"
            m["pricing"]["as_of"] = "2026-09-30"
        self.assertEqual(self.mutate("openai-gpt-image-2", g), [])

    def test_a_request_for_an_unlisted_tier_is_a_problem_of_the_entry(self):
        e = reg.get("openai-gpt-image-2")
        self.assertEqual(e.problems(CapabilityRequest("t2i", "x", quality="high")), [])
        self.assertTrue(e.problems(CapabilityRequest("t2i", "x", quality="ultra")))
        self.assertTrue(reg.get("flux-2-pro").problems(CapabilityRequest("t2i", "x", quality="low")))


# ── migration 0060 is built on the latest bodies ─────────────────────────────

def bodies(text):
    return {m.group(1): m.group(0) for m in
            re.finditer(r"create or replace function public\.(\w+)\(.*?\n\$\$;\n", text, re.S)}


def literals(body):
    # Comments carry apostrophes: strip them, then read the SQL string
    # literals ('' is an escaped quote inside one).
    code = re.sub(r"--[^\n]*", "", body)
    return set(re.findall(r"'(?:[^']|'')*'", code))


class BuiltOnTheLatestBodies(unittest.TestCase):
    SQL = (MIGRATIONS / "0060_image_quality.sql").read_text()

    def latest(self, name):
        """The newest migration BELOW 0060 that defines ``name``."""
        for f in sorted(MIGRATIONS.glob("*.sql"), reverse=True):
            if f.name >= "0060" or not re.match(r"^\d{4}_", f.name):
                continue
            b = bodies(f.read_text())
            if name in b:
                return f.name, b[name]
        raise AssertionError(name)

    def test_the_functions_replaced_are_the_ones_the_quote_runs(self):
        self.assertEqual(sorted(bodies(self.SQL)),
                         ["create_creative_job", "creative_params_problem", "creative_price", "sellable_models"])

    def test_every_literal_of_the_latest_bodies_survives(self):
        new = bodies(self.SQL)
        for name in new:
            source, old = self.latest(name)
            for literal in literals(old):
                self.assertIn(literal, literals(new[name]), f"{name} lost {literal} from {source}")

    def test_the_bodies_are_taken_from_the_files_that_last_defined_them(self):
        # If a later migration replaces one of these, 0060 must be rebuilt on it.
        self.assertEqual(self.latest("create_creative_job")[0], "0036_creative_jobs.sql")
        self.assertEqual(self.latest("creative_price")[0], "0052_video_tools.sql")
        self.assertEqual(self.latest("creative_params_problem")[0], "0055_describe_image.sql")
        self.assertEqual(self.latest("sellable_models")[0], "0055_describe_image.sql")

    def test_no_check_of_the_replaced_functions_is_dropped(self):
        new = bodies(self.SQL)
        for name in new:
            _, old = self.latest(name)
            for stmt in ("perform public.creative_refuse", "return format(", "return '"):
                self.assertGreaterEqual(new[name].count(stmt), old.count(stmt), f"{name}: fewer {stmt}")

    def test_the_quote_applies_the_tier_and_names_it(self):
        price = bodies(self.SQL)["creative_price"]
        self.assertIn("'variants' ->> 'by' = 'quality'", price)
        self.assertIn("coalesce(p_params ->> 'quality', 'medium')", price)
        self.assertIn("m_unit := m_unit || '_' ||", price)
        self.assertIn("jsonb_build_object('quality', tier)", price)
        # unpriced is still a refusal, never a zero
        self.assertIn("perform public.creative_refuse('unpriced',", price)

    def test_the_job_stores_the_tier_that_was_priced_and_nothing_else_changes(self):
        create = bodies(self.SQL)["create_creative_job"]
        self.assertIn("if q ? 'quality' then", create)
        self.assertIn("jsonb_build_object('quality', q ->> 'quality')", create)
        # stored params, but the idempotency hash still covers what the caller sent
        self.assertIn("jparams, 'queued', 'credits', ref,", create)
        self.assertIn("'params', coalesce(p_params, 'null'::jsonb)", create)
        self.assertIn("price > p_max_credits", create)
        self.assertIn("creative_platform_reserve(p_org, ref, price)", create)

    def test_it_says_what_to_do_when_the_flat_prices_come_later(self):
        self.assertIn("ORDER. If 0060 is applied BEFORE", self.SQL)
        self.assertIn("no_flat_price_without_tier_rows", self.SQL)
        self.assertIn("WORKER. A tiered model's job that carries no tier", self.SQL)

    def test_security_definer_functions_pin_their_search_path_and_are_revoked(self):
        for name, body in bodies(self.SQL).items():
            if "security definer" in body:
                self.assertIn("set search_path = public, pg_temp", body, name)
        self.assertIn("revoke all on function public.creative_price(uuid, text, text, jsonb) from public, anon, authenticated, service_role;",
                      self.SQL)
        self.assertIn("grant execute on function public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated;",
                      self.SQL)
        self.assertIn("revoke all on function public.creative_params_problem(text, jsonb) from public, anon, authenticated, service_role;",
                      self.SQL)
        self.assertIn("grant execute on function public.sellable_models(text, text) to authenticated, service_role;",
                      self.SQL)

    def test_prices_are_inserted_without_overwriting_and_only_from_a_real_flat_price(self):
        self.assertIn("on conflict (unit) do nothing", self.SQL)
        self.assertIn("b.credits_per_unit > 0", self.SQL)
        self.assertIn("-- Verify (run after applying", self.SQL)

    def test_it_needs_0052_and_0055_first(self):
        self.assertIn("creative_quantity(text, jsonb)", self.SQL)
        self.assertIn("creative_picture_problem(uuid, uuid, text)", self.SQL)

    def test_the_tiers_the_database_allows_are_the_ones_the_worker_knows(self):
        from modules.capabilities.base import IMAGE_QUALITIES
        self.assertEqual(IMAGE_QUALITIES, ("low", "medium", "high"))
        self.assertIn("not in ('low', 'medium', 'high')", self.SQL)


if __name__ == "__main__":
    unittest.main()
