"""A script with no thumbnail overlay text ships a thumbnail with NO overlay text.

main.py used to hand the generator `script.thumbnail_overlay_text or "SHOCKING"`: when the model
left the field out, the literal word SHOCKING was drawn on the real thumbnail while publish_score
reported the dimension as missing. A default the owner never saw, presented as the script's own
words (CLAUDE.md #4 no silent fallback, #5 a default is not a measurement).

What would break without these:

* "SHOCKING" (or any invented word) reaching the thumbnail request or the drawn pixels;
* a None / whitespace-only overlay crashing the generator (None has no .upper());
* the missing overlay being invisible to the owner (no `thumbnail_overlay: missing` on the event);
* an overlay that IS present changing in any way, or the publish score / gate reading the
  missing field differently from before.

Nothing here calls a provider or the network. The pipeline test runs main.run in a child
interpreter (as tests/test_spend_guard.py does: `import main` is heavy) with every external stage
replaced, and stops at the presenter, which comes right after the thumbnails.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules import publish_gate, publish_score, thumbnail_generator as tg  # noqa: E402

MISSING = (None, "", "   ", "\n\t ")


class Recorder:
    """Stands in for the stroke-text drawer: records every string put on the canvas."""

    def __init__(self):
        self.texts = []

    def __call__(self, draw, text, xy, font, **kw):
        self.texts.append(text)


def render(overlay, variant="A"):
    rec = Recorder()
    with tempfile.TemporaryDirectory() as d, patch.object(tg, "_draw_text_with_stroke", rec):
        tg._make_thumbnail(None, overlay, "The Fall of Rome", Path(d) / "t.jpg", variant)
    return rec.texts


class OverlayIsMissing(unittest.TestCase):
    def test_none_empty_and_whitespace_are_missing(self):
        for v in MISSING:
            with self.subTest(v=v):
                self.assertTrue(tg.overlay_is_missing(v))

    def test_any_real_word_is_present(self):
        for v in ("STILL LOCKED", " x ", "0"):
            with self.subTest(v=v):
                self.assertFalse(tg.overlay_is_missing(v))


class GeneratorDrawsNoInventedText(unittest.TestCase):
    def test_a_missing_overlay_draws_only_the_topic_caption(self):
        for v in MISSING:
            for variant in ("A", "B", "C"):
                with self.subTest(v=v, variant=variant):
                    texts = render(v, variant)
                    self.assertEqual(texts, ["The Fall of Rome"])
                    self.assertNotIn("SHOCKING", " ".join(texts).upper())

    def test_a_present_overlay_is_drawn_exactly_as_before(self):
        # upper-cased, wrapped at 12 chars (STILL LOCKED fits one line), then the topic caption: the pre-change behaviour
        self.assertEqual(render("Still locked"), ["STILL LOCKED", "The Fall of Rome"])
        self.assertEqual(render("SECRET MAP FOUND!"), ["SECRET MAP", "FOUND!", "The Fall of Rome"])

    def test_generate_variants_with_a_missing_overlay_renders_every_arm_without_it(self):
        for v in MISSING:
            rec = Recorder()
            with tempfile.TemporaryDirectory() as d, patch.object(tg, "_draw_text_with_stroke", rec):
                gen = tg.ThumbnailGenerator("overlay-missing")
                gen.out_dir = Path(d)
                out = gen.generate_variants("The Fall of Rome", v, variants=("A", "B", "C"))
                self.assertEqual(set(out), {"A", "B", "C"})
                self.assertTrue(all(p.exists() for p in out.values()))
            with self.subTest(v=v):
                self.assertEqual(rec.texts, ["The Fall of Rome"] * 3)

    def test_generate_with_a_missing_overlay_does_not_crash(self):
        rec = Recorder()
        with tempfile.TemporaryDirectory() as d, patch.object(tg, "_draw_text_with_stroke", rec):
            gen = tg.ThumbnailGenerator("overlay-missing")
            gen.out_dir = Path(d)
            gen.generate("The Fall of Rome", None)
        self.assertEqual(rec.texts, ["The Fall of Rome"] * 2)


class ScoreAndGateReadMissingOverlayAsBefore(unittest.TestCase):
    """The advisory score already says the dimension is missing; nothing here is widened."""

    def test_publish_score_reports_the_thumbnail_dimension_as_missing(self):
        d = publish_score._thumbnail_score("")
        self.assertIsNone(d.score)
        self.assertEqual(d.confidence, publish_score.NONE)
        self.assertEqual(d.basis, "no thumbnail overlay text")

    def test_a_script_with_no_overlay_scores_the_same_through_inputs_from_script(self):
        from types import SimpleNamespace
        for v in MISSING:
            with self.subTest(v=v):
                d = publish_score.evaluate(publish_score.inputs_from_script(
                    SimpleNamespace(title="t", thumbnail_overlay_text=v))).dimensions
                thumb = next(x for x in d if x.key == "thumbnail")
                self.assertIsNone(thumb.score)
                self.assertEqual(thumb.basis, "no thumbnail overlay text")

    def test_publish_gate_never_reads_the_overlay_text(self):
        src = Path(publish_gate.__file__).read_text()
        self.assertNotIn("overlay", src)


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
out = {"requests": [], "warnings": []}

import logging
class Collect(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.WARNING:
            out["warnings"].append(record.getMessage())
logging.getLogger().addHandler(Collect())

class FakeMixer:
    characters_synthesized = 10
    def __init__(self, *a, **k): pass
    def build(self, script):
        return work / "a.mp3", []
    def describe_voice(self):
        return {"provider": "edge", "source": "default"}

class FakeThumbs:
    def __init__(self, slug): pass
    def generate_variants(self, topic, overlay_text, variants=("A", "B"), backgrounds=None):
        out["requests"].append({"topic": topic, "overlay_text": overlay_text})
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
for p in patches: p.start()
try:
    main.run(script_file=script_file, channel=ctx.channel_id, skip_upload=True)
    out["raised"] = None
except BaseException as e:
    out["raised"] = [type(e).__name__, str(e)]
    out["tb"] = traceback.format_exc()[-1500:]
store = StateStore(db)
out["thumbnail_events"] = [
    {"event": e["event"], "metadata": e["metadata"]}
    for e in store.list_events(limit=500) if str(e["event"]).startswith("thumbnail.")]
print("RESULT " + json.dumps(out))
"""

ROW = {"channel_id": "news", "name": "news", "niche": "tech", "status": "ACTIVE",
       "agent_config": {"language": "English"},
       "schedule_config": {"enabled": True, "publish_hour_utc": 15},
       "credential_ref": {"youtube_channel_id": "UCnews", "verified_at": "2026-09-01T00:00:00Z"}}


def drive(overlay):
    """main.run on the demo script with its overlay text replaced; "<absent>" removes the key."""
    script = json.loads((ROOT / "samples" / "demo_script.json").read_text())
    if overlay == "<absent>":
        script.pop("thumbnail_overlay_text")
    else:
        script["thumbnail_overlay_text"] = overlay
    path = Path(tempfile.mkdtemp()) / "script.json"
    path.write_text(json.dumps(script))
    proc = subprocess.run(
        [sys.executable, "-I", "-c", _CHILD, str(ROOT), json.dumps(ROW), str(path)],
        capture_output=True, text=True, timeout=300, cwd=tempfile.gettempdir(),
        env={"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir(), "GEMINI_API_KEY": "not-a-real-key",
             "PEXELS_API_KEY": "not-a-real-key", "CHRONOS_STATE_DB": str(Path(tempfile.mkdtemp()) / "state.db"),
             "NIGHTSHIFT_MIN_FREE_DISK_GB": "0", "NIGHTSHIFT_GROUNDED_FACTCHECK": "off",
             "NIGHTSHIFT_PACKAGING_REPAIR": "off"})
    line = next((l for l in proc.stdout.splitlines() if l.startswith("RESULT ")), None)
    assert line is not None, proc.stderr[-3000:]
    return json.loads(line[len("RESULT "):])


class PipelineDoesNotInventAnOverlay(unittest.TestCase):
    def assert_reached_thumbnails(self, out):
        self.assertEqual(out["raised"][0], "AvatarUnavailable", out.get("tb"))
        self.assertEqual(len(out["requests"]), 1)

    def test_a_script_without_overlay_text_asks_for_none_and_says_so(self):
        for overlay in ("<absent>", None, "", "   "):
            with self.subTest(overlay=overlay):
                out = drive(overlay)
                self.assert_reached_thumbnails(out)
                sent = out["requests"][0]["overlay_text"]
                self.assertNotIn("SHOCKING", str(sent).upper())
                self.assertTrue(tg.overlay_is_missing(sent))
                done = [e for e in out["thumbnail_events"] if e["event"] == "thumbnail.completed"]
                self.assertEqual(len(done), 1)
                self.assertEqual(json.loads(done[0]["metadata"]), {"thumbnail_overlay": "missing"})
                self.assertTrue([w for w in out["warnings"] if "no thumbnail overlay text" in w])

    def test_a_script_with_overlay_text_sends_it_unchanged_and_adds_nothing_to_the_event(self):
        out = drive("STILL LOCKED")
        self.assert_reached_thumbnails(out)
        self.assertEqual(out["requests"][0]["overlay_text"], "STILL LOCKED")
        done = [e for e in out["thumbnail_events"] if e["event"] == "thumbnail.completed"]
        self.assertEqual(len(done), 1)
        self.assertIsNone(done[0]["metadata"])
        self.assertFalse([w for w in out["warnings"] if "overlay" in w])


if __name__ == "__main__":
    unittest.main()
