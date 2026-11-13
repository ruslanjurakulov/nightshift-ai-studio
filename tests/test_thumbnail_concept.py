"""Concept thumbnails (modules/thumbnail_concept.py, modules/thumbnail_overlay.py).

What would break without these:

* a channel that never opted in getting anything but the frame thumbnail it always had —
  a planner call, a generated image, a cost line, or different bytes;
* a planner reply that is not a usable concept (an emotion outside the set, a face on a
  faceless channel, lettering asked of the image model, a headline that is not the
  fact-checked overlay text) reaching the image model, or a bad pick being quietly swapped
  for the runner-up;
* the image prompt carrying the headline or asking for any lettering;
* a concept channel whose image model is missing, refuses or returns nothing shipping the
  darkened frame instead of stopping with the remedy (CLAUDE.md #4);
* a headline that is tiny or low-contrast at 120 px wide, or a flat hero, passing the check;
* A/B arms differing on more than one axis;
* the cost reading $0 when no rate is configured (CLAUDE.md #5).

No provider or network is called anywhere here.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw  # noqa: E402

from modules import image_providers, thumbnail_concept as tc, thumbnail_generator as tg  # noqa: E402
from modules import thumbnail_overlay as ov  # noqa: E402
from modules.channels import AgentConfig  # noqa: E402

HEADLINE = "STILL LOCKED"


def _has_scalable_font() -> bool:
    for path in tg.FONT_CANDIDATES:
        try:
            from PIL import ImageFont
            ImageFont.truetype(path, 20)
            return True
        except OSError:
            continue
    return False


SCALABLE = _has_scalable_font()


def concept_dict(**over) -> dict:
    d = {"framing": "object_in_trouble", "information_gap": "why the door is still bolted from inside",
         "hero_subject": "a heavy iron lighthouse door, bolted shut, waves crashing behind it",
         "key_prop": "an oversized rusted bolt", "emotion": "faceless", "camera_take": "low_angle",
         "hero_side": "right", "palette": ["deep teal", "storm orange"], "headline": HEADLINE,
         "overlay_style": "stroke", "beats_title_because": "the title says they vanished; the bolt asks how",
         "true_to_script": "section 2 describes the door found bolted from inside"}
    d.update(over)
    return d


def plan_json(*concepts, chosen=0) -> str:
    return json.dumps({"concepts": list(concepts) or [concept_dict()], "chosen": chosen, "why_chosen": "clearest gap"})


FACELESS = tc.ConceptSettings(mode="concept", image_provider="flux")
FACES = tc.ConceptSettings(mode="concept", image_provider="flux", allow_faces=True)


def agent(**concept):
    base = {"image_provider": "flux"}
    base.update(concept)
    return AgentConfig.from_dict({"thumbnail_mode": "concept", "thumbnail_concept": base})


class Script:
    topic = "The Flannan Isles lighthouse"
    title = "3 Men Vanished From This Lighthouse"
    thumbnail_overlay_text = HEADLINE
    sections = []


def hero_image(side="right") -> Image.Image:
    """A stand-in for a good generation: a calm gradient and one big detailed hero on its side."""
    img = Image.new("RGB", (1280, 720))
    d = ImageDraw.Draw(img)
    for y in range(720):
        d.line([(0, y), (1280, y)], fill=(20 + y // 12, 30, 70 + y // 10))
    x0 = 700 if side == "right" else 80
    for i in range(12):
        d.ellipse([x0 + i * 20, 120 + i * 15, x0 + 300 + i * 10, 420 + i * 18], outline=(255, 200 - i * 10, 40), width=6)
    d.rectangle([x0 + 100, 300, x0 + 400, 600], fill=(240, 240, 230))
    d.rectangle([x0 + 150, 350, x0 + 300, 500], fill=(20, 60, 120))
    return img


class FakeClient:
    def __init__(self, image=None, raises=None):
        self.image, self.raises, self.prompts = image, raises, []

    def generate(self, prompt, out_path, *, width, height):
        self.prompts.append(prompt)
        if self.raises:
            raise self.raises
        if self.image is None:
            return None
        self.image.save(out_path, "JPEG")
        return Path(out_path)


# -- the default is today's behaviour ---------------------------------------

class DefaultModeIsUnchanged(unittest.TestCase):
    def test_a_channel_that_never_opted_in_is_on_frame_mode(self):
        self.assertEqual(AgentConfig().thumbnail_mode, "frame")
        self.assertEqual(AgentConfig.from_dict({}).thumbnail_mode, "frame")
        for value in (None, "", "Frame", "conceptual", True, 1, "concept please"):
            self.assertEqual(AgentConfig.from_dict({"thumbnail_mode": value}).thumbnail_mode, "frame", value)
        self.assertEqual(AgentConfig.from_dict({"thumbnail_mode": " Concept "}).thumbnail_mode, "concept")
        again = AgentConfig.from_dict(agent(image_model="flux-2-pro").to_dict())
        self.assertEqual((again.thumbnail_mode, again.thumbnail_concept["image_model"]), ("concept", "flux-2-pro"))

    def test_frame_mode_calls_nothing_writes_nothing_and_spends_nothing(self):
        def boom(*a, **k):
            raise AssertionError("frame mode must not call the planner or record a cost")

        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "thumbs"
            with patch.object(image_providers, "client_for", boom):
                got = tc.make_concept_thumbnails(AgentConfig(), Script(), out, ("A", "B"), gen=boom,
                                                 on_planner_response=boom, on_image=boom)
            self.assertIsNone(got)
            self.assertFalse(out.exists())
        tc.preflight(AgentConfig())  # no provider configured, frame mode: nothing to check

    def test_the_frame_path_still_renders_through_the_untouched_renderer(self):
        with tempfile.TemporaryDirectory() as d, patch.object(tg, "OUTPUT_DIR", Path(d)):
            paths = tg.ThumbnailGenerator("slug").generate_variants("The Fall of Rome", HEADLINE, ("A", "B"))
            for label, path in paths.items():
                direct = Path(d) / f"direct_{label}.jpg"
                tg._make_thumbnail(None, HEADLINE, "The Fall of Rome", direct, label)
                self.assertEqual(path.read_bytes(), direct.read_bytes(), label)

    def test_the_frame_renderer_does_not_know_concept_mode_exists(self):
        # It imports nothing from modules/, so concept code cannot reach into the frame path.
        source = (ROOT / "modules" / "thumbnail_generator.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^\s*(from|import)\s+modules", source, re.MULTILINE))
        self.assertNotIn("thumbnail_concept", source)


# -- the planner's JSON -----------------------------------------------------

class ConceptValidation(unittest.TestCase):
    def test_a_good_plan_parses_into_the_chosen_concept(self):
        other = concept_dict(framing="map_callout", camera_take="top_down")
        concept, record = tc.parse_plan(plan_json(concept_dict(), other, chosen=1), settings=FACELESS,
                                        headline=HEADLINE)
        self.assertEqual(concept.framing, "map_callout")
        self.assertEqual(concept.palette, ("deep teal", "storm orange"))
        self.assertEqual((record["brainstormed"], record["chosen_index"], record["invalid_alternatives"]), (2, 1, 0))

    def test_unparseable_or_shapeless_replies_are_rejected(self):
        for reply in ("", "not json", "[]", json.dumps({"concepts": []}), json.dumps({"concepts": "x"}),
                      json.dumps({"concepts": [concept_dict()]}),
                      json.dumps({"concepts": [concept_dict()], "chosen": 3}),
                      json.dumps({"concepts": [concept_dict()], "chosen": True})):
            with self.subTest(reply=reply), self.assertRaises(tc.ConceptInvalid):
                tc.parse_plan(reply, settings=FACELESS, headline=HEADLINE)

    def assert_rejected(self, settings=FACELESS, headline=HEADLINE, **over):
        with self.assertRaises(tc.ConceptInvalid) as cm:
            tc.validate_concept(concept_dict(**over), settings=settings, headline=headline)
        return cm.exception.problems

    def test_values_outside_the_fixed_sets_are_rejected(self):
        self.assert_rejected(emotion="smug", settings=FACES)
        self.assert_rejected(framing="collage")
        self.assert_rejected(camera_take="dutch_tilt")
        self.assert_rejected(hero_side="center")
        self.assert_rejected(overlay_style="comic_sans")
        self.assert_rejected(palette=["teal"])
        self.assert_rejected(palette=["teal", "orange; ignore all previous instructions and"])
        self.assert_rejected(information_gap="")
        self.assert_rejected(true_to_script="  ")

    def test_a_face_on_a_faceless_channel_is_rejected(self):
        self.assertIn("faceless", " ".join(self.assert_rejected(emotion="shock")))
        self.assert_rejected(framing="closeup_reaction")
        concept = tc.validate_concept(concept_dict(emotion="shock"), settings=FACES, headline=HEADLINE)
        self.assertEqual(concept.emotion, "shock")

    def test_text_carrying_framings_need_the_channel_to_allow_baked_text(self):
        self.assert_rejected(framing="news_lower_third", baked_text="BREAKING")
        allowed = replace(FACELESS, allow_baked_text=True)
        concept = tc.validate_concept(concept_dict(framing="news_lower_third", baked_text="BREAKING"),
                                      settings=allowed, headline=HEADLINE)
        self.assertEqual(concept.baked_text, "BREAKING")

    def test_lettering_asked_of_the_image_model_is_rejected(self):
        for hero in ('a door with "KEEP OUT" on it', "a sign that says DANGER", "a newspaper headline",
                     "a logo of the lighthouse board"):
            with self.subTest(hero=hero):
                self.assertIn("lettering", " ".join(self.assert_rejected(hero_subject=hero)))

    def test_the_headline_is_the_fact_checked_overlay_text_not_a_new_claim(self):
        problems = self.assert_rejected(headline="THEY WERE MURDERED")
        self.assertIn("fact-checked", " ".join(problems))
        ok = tc.validate_concept(concept_dict(headline="still locked!"), settings=FACELESS, headline=HEADLINE)
        self.assertEqual(ok.headline, HEADLINE)  # the script's words, not the model's casing
        self.assert_rejected(headline="")       # dropping the checked text is not allowed either

    def test_no_overlay_text_means_the_planner_must_not_invent_one(self):
        with self.assertRaises(tc.ConceptInvalid):
            tc.validate_concept(concept_dict(headline="WHERE DID THEY GO"), settings=FACELESS, headline="")
        concept = tc.validate_concept(concept_dict(headline=""), settings=FACELESS, headline="")
        self.assertEqual(concept.headline, "")

    def test_an_invalid_pick_is_not_swapped_for_the_runner_up(self):
        with self.assertRaises(tc.ConceptInvalid):
            tc.parse_plan(plan_json(concept_dict(emotion="smug"), concept_dict(), chosen=0),
                          settings=FACELESS, headline=HEADLINE)


# -- the image prompt -------------------------------------------------------

class ImagePromptIsClean(unittest.TestCase):
    def all_concepts(self):
        settings = replace(FACES, allow_baked_text=False)
        for framing in tc.allowed_framings(settings):
            for emotion in list(tc.EMOTIONS) + [tc.FACELESS]:
                yield tc.validate_concept(concept_dict(framing=framing, emotion=emotion), settings=settings,
                                          headline=HEADLINE)

    def test_the_prompt_never_carries_the_headline_or_asks_for_lettering(self):
        for concept in self.all_concepts():
            prompt = tc.build_image_prompt(concept)
            self.assertNotIn(HEADLINE.lower(), prompt.lower())
            self.assertTrue(prompt.endswith(tc.CLEAN_CLAUSE), concept.framing)
            body = prompt[: -len(tc.CLEAN_CLAUSE)]
            self.assertIsNone(tc._LETTERING.search(body), (concept.framing, body))
            self.assertFalse(any(q in body for q in tc._QUOTES), concept.framing)

    def test_faces_are_invented_and_faceless_means_no_people(self):
        face = tc.validate_concept(concept_dict(emotion="awe"), settings=FACES, headline=HEADLINE)
        self.assertIn("resembling no real or famous person", tc.build_image_prompt(face))
        faceless = tc.validate_concept(concept_dict(), settings=FACELESS, headline=HEADLINE)
        self.assertIn("No people and no faces", tc.build_image_prompt(faceless))

    def test_a_diagram_gets_no_photographic_lighting_rig(self):
        flat = tc.validate_concept(concept_dict(framing="diagram"), settings=FACELESS, headline=HEADLINE)
        prompt = tc.build_image_prompt(flat)
        self.assertNotIn("rim light", prompt)
        self.assertIn("no photographic lighting", prompt)

    def test_the_planner_is_told_the_rules_and_the_fixed_headline(self):
        prompt = tc.build_plan_prompt(Script(), language="Uzbek", settings=FACELESS)
        self.assertIn('"STILL LOCKED"', prompt)
        self.assertIn("Channel language: Uzbek", prompt)
        self.assertIn("faceless", prompt)
        self.assertNotIn("news_lower_third", prompt)   # baked text is off on this channel
        self.assertNotIn("closeup_reaction", prompt)   # and so are faces


# -- an unavailable model stops, by name ------------------------------------

class UnavailableModelStops(unittest.TestCase):
    def test_preflight_names_the_missing_setting(self):
        with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
            tc.preflight(AgentConfig.from_dict({"thumbnail_mode": "concept"}))
        self.assertIn("thumbnail_concept.image_provider", cm.exception.remedy)
        with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
            tc.preflight(agent(image_provider="midjourney"))
        self.assertIn("not an image adapter", cm.exception.reason)

    def test_preflight_names_the_missing_key_without_reading_it_out(self):
        with patch.object(tc.config, "BFL_API_KEY", "", create=True), \
                patch.object(tc.config, "GEMINI_API_KEY", "g", create=True):
            with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
                tc.preflight(agent(image_provider="flux"))
        self.assertIn("BFL_API_KEY", cm.exception.remedy)
        with patch.object(tc.config, "BFL_API_KEY", "secret-value-123", create=True), \
                patch.object(tc.config, "GEMINI_API_KEY", "g", create=True):
            tc.preflight(agent(image_provider="flux"))

    def test_the_channel_model_is_pinned_not_the_run_wide_one(self):
        with patch.object(image_providers.config, "BFL_API_KEY", "k", create=True), \
                patch.object(image_providers.config, "IMAGE_MODEL", "gpt-image-2", create=True):
            self.assertEqual(image_providers.client_for("flux").model, "flux-2-pro")
            self.assertEqual(image_providers.client_for("flux", "flux-2-max").model, "flux-2-max")
        with patch.object(image_providers.config, "BFL_API_KEY", "", create=True):
            self.assertIsNone(image_providers.client_for("flux"))
        self.assertIsNone(image_providers.client_for("midjourney"))

    def run_concept(self, client, out, **kw):
        with patch.object(tc.config, "BFL_API_KEY", "k", create=True), \
                patch.object(tc.config, "GEMINI_API_KEY", "g", create=True):
            return tc.make_concept_thumbnails(agent(**kw), Script(), out, ("A", "B"),
                                              gen=lambda p, s: plan_json(), client=client)

    def test_a_model_that_returns_nothing_stops_and_no_frame_thumbnail_is_made(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
                self.run_concept(FakeClient(image=None), Path(d))
            self.assertEqual(cm.exception.stage, "image")
            self.assertIn("returned no image", cm.exception.reason)
            self.assertIn("thumbnail_mode back to frame", cm.exception.remedy)
            self.assertFalse(list(Path(d).glob("thumbnail_*.jpg")))

    def test_a_refusal_is_a_stop_with_the_right_remedy(self):
        policy = image_providers.ImageProviderUnavailable("FLUX", "flux-2-pro", "refused the prompt under its "
                                                          "content policy (HTTP 400)", "stills remedy")
        quota = image_providers.ImageProviderUnavailable("FLUX", "flux-2-pro", "refused the request for quota",
                                                         "top up the provider account")
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
                self.run_concept(FakeClient(raises=policy), Path(d))
            self.assertNotIn("stills", cm.exception.remedy)
            self.assertIn("thumbnail_mode back to frame", cm.exception.remedy)
            with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
                self.run_concept(FakeClient(raises=quota), Path(d))
            self.assertIn("top up", cm.exception.remedy)

    def test_an_unusable_plan_stops_before_any_image_is_paid_for(self):
        client = FakeClient(image=hero_image())
        with tempfile.TemporaryDirectory() as d, \
                patch.object(tc.config, "BFL_API_KEY", "k", create=True), \
                patch.object(tc.config, "GEMINI_API_KEY", "g", create=True):
            with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
                tc.make_concept_thumbnails(agent(), Script(), Path(d), ("A", "B"),
                                           gen=lambda p, s: plan_json(concept_dict(headline="NEW CLAIM")),
                                           client=client)
        self.assertEqual(cm.exception.stage, "plan")
        self.assertEqual(client.prompts, [])


# -- the 120 px readability gate --------------------------------------------

class ReadabilityGate(unittest.TestCase):
    def test_a_tiny_headline_fails(self):
        clean = hero_image()
        final, ground, layout = ov.render_headline(clean, HEADLINE, style="stroke", hero_side="right",
                                                   font_loader=lambda size: tg._load_font(22))
        report = ov.readability(final, ground, clean, layout, hero_side="right", headline=HEADLINE)
        self.assertFalse(report["passed"])
        self.assertLess(report["text_px"], ov.MIN_TEXT_PX)
        self.assertTrue(any("px tall" in f for f in report["failures"]))
        self.assertIn("shorten", ov.remedy_for(report["failures"]))

    def test_a_low_contrast_headline_fails(self):
        # Pale yellow ground behind white glyphs: big enough, but it vanishes at sidebar size.
        ground = Image.new("RGB", (1280, 720), (250, 245, 200))
        layout = ov.HeadlineLayout(lines=["STILL LOCKED"], font_size=120, boxes=[(48, 60, 560, 160)],
                                   line_heights=[100], style="stroke", fills=((255, 255, 255),))
        report = ov.readability(ground, ground, hero_image(), layout, hero_side="right", headline=HEADLINE)
        self.assertFalse(report["passed"])
        self.assertLess(report["contrast"], ov.MIN_CONTRAST)
        self.assertTrue(any("contrast" in f for f in report["failures"]))
        self.assertIn("plated", ov.remedy_for(report["failures"]))

    def test_a_flat_hero_and_text_over_the_hero_fail(self):
        flat = Image.new("RGB", (1280, 720), (120, 40, 160))
        layout = ov.HeadlineLayout(lines=["X"], font_size=120, boxes=[(700, 60, 1200, 400)],
                                   line_heights=[100], style="marker", fills=((12, 12, 12),))
        report = ov.readability(flat, Image.new("RGB", (1280, 720), (255, 214, 0)), flat, layout,
                                hero_side="right", headline=HEADLINE)
        joined = " ".join(report["failures"])
        self.assertIn("nearly flat", joined)
        self.assertIn("covers", joined)
        self.assertEqual(report["emotion"], "not measured (no face detector in this pipeline)")

    def test_more_than_six_words_fails(self):
        clean = hero_image()
        text = "one two three four five six seven"
        final, ground, layout = ov.render_headline(clean, text, style="pill", hero_side="right")
        report = ov.readability(final, ground, clean, layout, hero_side="right", headline=text)
        self.assertTrue(any("7 words" in f for f in report["failures"]))

    @unittest.skipUnless(SCALABLE, "needs a scalable font, as the real renderer does")
    def test_a_well_composed_thumbnail_passes_in_every_style(self):
        for side in ("right", "left"):
            clean = hero_image(side)
            for style in ov.STYLES:
                with self.subTest(style=style, side=side):
                    final, ground, layout = ov.render_headline(clean, HEADLINE, style=style, hero_side=side)
                    report = ov.readability(final, ground, clean, layout, hero_side=side, headline=HEADLINE)
                    self.assertTrue(report["passed"], report["failures"])
                    self.assertEqual(final.size, (1280, 720))

    def test_the_check_is_deterministic(self):
        clean = hero_image()
        runs = []
        for _ in range(2):
            final, ground, layout = ov.render_headline(clean, HEADLINE, style="neon", hero_side="right")
            runs.append(ov.readability(final, ground, clean, layout, hero_side="right", headline=HEADLINE))
        self.assertEqual(runs[0], runs[1])


# -- A/B on one axis, and the whole step ------------------------------------

class OneAxisAB(unittest.TestCase):
    def differing(self, a, b):
        return {k for k, v in a.to_dict().items() if b.to_dict()[k] != v}

    def test_faceless_arms_differ_only_by_camera_take(self):
        concept = tc.validate_concept(concept_dict(), settings=FACELESS, headline=HEADLINE)
        axis, arms = tc.ab_variants(concept, ("A", "B", "C", "D"))
        self.assertEqual(axis, "camera_take")
        self.assertIs(arms["A"], concept)
        for arm in ("B", "C", "D"):
            self.assertEqual(self.differing(concept, arms[arm]), {"camera_take"})
        self.assertEqual(len({c.camera_take for c in arms.values()}), 4)
        self.assertEqual(tc.ab_variants(concept, ("A", "B", "C", "D")), (axis, arms))

    def test_arms_with_a_face_differ_only_by_emotion(self):
        concept = tc.validate_concept(concept_dict(emotion="shock"), settings=FACES, headline=HEADLINE)
        axis, arms = tc.ab_variants(concept, ("A", "B"))
        self.assertEqual(axis, "emotion")
        self.assertEqual(self.differing(concept, arms["B"]), {"emotion"})


@unittest.skipUnless(SCALABLE, "needs a scalable font, as the real renderer does")
class WholeStep(unittest.TestCase):
    def run_step(self, out, client, gen=None, **kw):
        images, metered = [], []
        with patch.object(tc.config, "BFL_API_KEY", "k", create=True), \
                patch.object(tc.config, "GEMINI_API_KEY", "g", create=True):
            result = tc.make_concept_thumbnails(
                agent(**kw), Script(), out, ("A", "B"), gen=gen or (lambda p, s: plan_json()),
                on_planner_response=lambda: metered.append(1), on_image=images.append, client=client)
        return result, images, metered

    def test_two_arms_are_generated_lettered_checked_and_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            client = FakeClient(image=hero_image())
            result, images, metered = self.run_step(Path(d), client)
            self.assertEqual(sorted(result.paths), ["A", "B"])
            for path in result.paths.values():
                with Image.open(path) as im:
                    self.assertEqual(im.size, (1280, 720))
            self.assertEqual((images, metered), (["flux", "flux"], [1]))
            rec = result.record
            self.assertEqual(rec["ab_axis"], "camera_take")
            self.assertEqual(rec["ab_values"], {"A": "low_angle", "B": "eye_level"})
            self.assertTrue(all(c["passed"] for c in rec["readability"].values()))
            self.assertEqual(len(client.prompts), 2)
            for prompt in client.prompts:
                self.assertNotIn(HEADLINE.lower(), prompt.lower())
            json.dumps(rec)  # the record is an event payload

            # A re-run of the same run reuses what was paid for: no planner call, no image.
            def no_call(*a, **k):
                raise AssertionError("a reusable plan must not be paid for twice")
            again, images, metered = self.run_step(Path(d), FakeClient(raises=AssertionError("no")), gen=no_call)
            self.assertTrue(again.record["reused"])
            self.assertEqual((images, metered), ([], []))

    def test_a_generation_that_does_not_read_at_sidebar_size_stops_the_step(self):
        with tempfile.TemporaryDirectory() as d:
            flat = Image.new("RGB", (1280, 720), (120, 40, 160))
            with self.assertRaises(tc.ThumbnailConceptUnavailable) as cm:
                self.run_step(Path(d), FakeClient(image=flat))
            self.assertEqual(cm.exception.stage, "readability")
            self.assertIn("120 px", cm.exception.reason)
            self.assertFalse(cm.exception.record["readability"]["A"]["passed"])
            # A re-run composes again rather than re-lettering the same failed pictures.
            self.assertFalse((Path(d) / tc.PLAN_FILE).exists())


class ExpectedCost(unittest.TestCase):
    def test_no_rate_configured_is_unknown_not_zero(self):
        with patch.dict(os.environ, {"CHRONOS_PRICE_IMAGE_GENERATIONS": ""}):
            cost = tc.expected_cost(2)
        self.assertEqual(cost["image_generations"], 2)
        self.assertIsNone(cost["usd_per_image"])
        self.assertIsNone(cost["image_usd"])
        self.assertEqual(cost["image_price_source"], "CHRONOS_PRICE_IMAGE_GENERATIONS")

    def test_a_configured_rate_prices_one_image_per_arm(self):
        with patch.dict(os.environ, {"CHRONOS_PRICE_IMAGE_GENERATIONS": "0.04"}):
            self.assertEqual(tc.expected_cost(3)["image_usd"], 0.12)


# -- the pipeline: a concept channel whose model is missing stops before the voice

_CHILD = r"""
import json, os, sys, tempfile, traceback
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
sys.path.insert(0, sys.argv[1])
row = json.loads(sys.argv[2])
script_file = sys.argv[3]
import main
from modules.avatar import AvatarUnavailable
from modules.channels import ChannelContext
from modules.state_store import StateStore

ctx = ChannelContext.from_dict(row)
work = Path(tempfile.mkdtemp())
os.chdir(work)
db = Path(os.environ["CHRONOS_STATE_DB"])
out = {"frame_requests": 0, "voice_built": False}

class FakeMixer:
    characters_synthesized = 10
    def __init__(self, *a, **k): pass
    def build(self, script):
        out["voice_built"] = True
        return work / "a.mp3", []
    def describe_voice(self):
        return {"provider": "edge", "source": "default"}

class FakeThumbs:
    def __init__(self, slug):
        self.out_dir = work / "thumbs" / slug
        self.out_dir.mkdir(parents=True, exist_ok=True)
    def generate_variants(self, topic, overlay_text, variants=("A", "B"), backgrounds=None):
        out["frame_requests"] += 1
        return {str(v): work / f"thumb_{v}.jpg" for v in variants}

fetcher = MagicMock()
fetcher.fetch_videos.return_value = [work / "v.mp4"]
fetcher.fetch_images.return_value = [work / "i.jpg"]
fetcher.searches_made = 0
fetcher.video_terms = {}
fetcher.provenance = {}
fetcher.generate_images.return_value = []
fetcher.generate_broll.return_value = SimpleNamespace(generated=0, by_section={}, newly_generated=0, to_dict=lambda: {})

def no_presenter(*a, **k):
    raise AvatarUnavailable("stop here: the thumbnails are done")

patches = [
    patch.object(main, "resolve_channel", return_value=ctx),
    patch.object(main, "ensure_assets", return_value=0),
    patch.object(main, "verify_voice", return_value=None),
    patch.object(main.video_providers, "preflight", return_value=None),
    patch.object(main, "AudioMixer", FakeMixer),
    patch.object(main, "MediaFetcher", return_value=fetcher),
    patch.object(main, "TopicManager", return_value=MagicMock()),
    patch.object(main, "StateStore", lambda: StateStore(db)),
    patch.object(main, "resolve_avatar_config", return_value=SimpleNamespace(enabled=True, provider="x", character_prompt="")),
    patch.object(main, "preflight_avatar", return_value=None),
    patch.object(main, "maybe_generate_presenter", no_presenter),
    patch.object(main, "SubtitleGenerator", MagicMock()),
    patch.object(main, "ThumbnailGenerator", FakeThumbs),
    patch.object(main.video_ir, "write_for_run", return_value=None),
]
if sys.argv[4] == "concept_ok":
    from PIL import Image, ImageDraw
    out["planner_calls"] = 0
    out["image_calls"] = []

    class Client:
        def generate(self, prompt, out_path, *, width, height):
            out["image_calls"].append({"voice_built_yet": out["voice_built"], "prompt": prompt})
            img = Image.new("RGB", (width, height), (20, 30, 80))
            d = ImageDraw.Draw(img)
            for i in range(12):
                d.ellipse([700 + i * 20, 120 + i * 15, 1000 + i * 10, 420 + i * 18], outline=(255, 200 - i * 10, 40), width=6)
            d.rectangle([800, 300, 1100, 600], fill=(240, 240, 230))
            img.save(out_path, "JPEG")
            return Path(out_path)

    class FakeEngine(main.ScriptEngine):
        def __init__(self, *a, **k):
            self.last_response = None
        def _gen(self, prompt, system=None):
            out["planner_calls"] += 1
            return sys.argv[5]

    patches += [patch.object(main, "ScriptEngine", FakeEngine),
                patch.object(main.thumbnail_concept.image_providers, "client_for", lambda p, m="": Client())]
for p in patches: p.start()
try:
    main.run(script_file=script_file, channel=ctx.channel_id, skip_upload=True)
    out["raised"] = None
except BaseException as e:
    out["raised"] = [type(e).__name__, str(e)]
    out["tb"] = traceback.format_exc()[-1500:]
store = StateStore(db)
out["events"] = [{"event": e["event"], "agent": e.get("agent"), "metadata": e["metadata"]}
                 for e in store.list_events(limit=500)
                 if str(e["event"]).startswith("thumbnail.") or e.get("agent") in ("media_preflight", "thumbnail_concept")]
print("RESULT " + json.dumps(out))
"""


def drive(agent_config: dict, mode: str = "plain", plan: str = "", env: dict | None = None) -> dict:
    row = {"channel_id": "news", "name": "news", "niche": "tech", "status": "ACTIVE",
           "agent_config": {"language": "English", **agent_config},
           "schedule_config": {"enabled": True, "publish_hour_utc": 15},
           "credential_ref": {"youtube_channel_id": "UCnews", "verified_at": "2026-09-01T00:00:00Z"}}
    proc = subprocess.run(
        [sys.executable, "-I", "-c", _CHILD, str(ROOT), json.dumps(row), str(ROOT / "samples" / "demo_script.json"),
         mode, plan],
        capture_output=True, text=True, timeout=300, cwd=tempfile.gettempdir(),
        env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir(), "GEMINI_API_KEY": "not-a-real-key",
             "PEXELS_API_KEY": "not-a-real-key", "CHRONOS_STATE_DB": str(Path(tempfile.mkdtemp()) / "state.db"),
             "NIGHTSHIFT_MIN_FREE_DISK_GB": "0", "NIGHTSHIFT_GROUNDED_FACTCHECK": "off",
             "NIGHTSHIFT_PACKAGING_REPAIR": "off", **(env or {})})
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")), None)
    assert line is not None, proc.stderr[-3000:]
    return json.loads(line[len("RESULT "):])


class PipelineStopsOnAnUnavailableModel(unittest.TestCase):
    def test_a_concept_channel_without_its_model_key_stops_before_the_voice_and_never_ships_a_frame(self):
        out = drive({"thumbnail_mode": "concept", "thumbnail_concept": {"image_provider": "flux"}})
        self.assertEqual(out["raised"][0], "ThumbnailConceptUnavailable", out.get("tb"))
        self.assertIn("BFL_API_KEY", out["raised"][1])
        self.assertFalse(out["voice_built"])
        self.assertEqual(out["frame_requests"], 0)
        failed = [e for e in out["events"] if e["agent"] == "media_preflight"]
        self.assertEqual(len(failed), 1)
        self.assertIn("BFL_API_KEY", json.loads(failed[0]["metadata"])["error"])

    def test_a_frame_channel_renders_frames_and_records_nothing_new(self):
        out = drive({})
        self.assertEqual(out["raised"][0], "AvatarUnavailable", out.get("tb"))
        self.assertEqual(out["frame_requests"], 1)
        done = [e for e in out["events"] if e["event"] == "thumbnail.completed"]
        self.assertEqual(len(done), 1)
        self.assertIsNone(done[0]["metadata"])
        self.assertFalse([e for e in out["events"] if e["agent"] == "thumbnail_concept"])


    @unittest.skipUnless(SCALABLE, "needs a scalable font, as the real renderer does")
    def test_a_concept_channel_plans_and_generates_before_the_voice_and_ships_the_concept(self):
        out = drive({"thumbnail_mode": "concept", "thumbnail_concept": {"image_provider": "flux"}},
                    mode="concept_ok", plan=plan_json(), env={"BFL_API_KEY": "not-a-real-key"})
        self.assertEqual(out["raised"][0], "AvatarUnavailable", out.get("tb"))
        self.assertEqual(out["planner_calls"], 1)
        self.assertEqual(len(out["image_calls"]), 2)
        self.assertFalse(any(c["voice_built_yet"] for c in out["image_calls"]))
        self.assertTrue(out["voice_built"])
        self.assertEqual(out["frame_requests"], 0)
        done = [e for e in out["events"] if e["event"] == "thumbnail.completed"]
        self.assertEqual(len(done), 1)
        record = json.loads(done[0]["metadata"])
        self.assertEqual((record["thumbnail_mode"], record["ab_axis"]), ("concept", "camera_take"))
        self.assertTrue(all(c["passed"] for c in record["readability"].values()))


if __name__ == "__main__":
    unittest.main()
