"""D1: a finished video is always visible, even when it was not uploaded.

* every held state (blocked, awaiting approval, held) also puts the 480p preview
  and the script where the Command Center reads them;
* an upload that raised leaves a held row whose cause is the fixed word
  ``upload_failed`` - never the exception text;
* pruning ranks held previews apart from uploaded ones.

No network: Supabase is the in-memory fake from test_video_review_record and the
real ``_record_held_run`` closure is lifted out of main.py and run against it.
"""

import ast
import logging
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from modules import held_video
from modules.held_video import HeldVideos, held_video_id
from modules.video_review import VideoReview
from tests.test_video_review_record import FakeSupabase, KEY, URL, _patched, _record, _review

MAIN = Path(__file__).resolve().parent.parent / "main.py"


def _held_runner(**over):
    """The real ``_record_held_run`` from main.py with its closure supplied."""
    tree = ast.parse(MAIN.read_text())
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, ast.FunctionDef) and n.name == "_record_held_run")
    ns = dict(
        held_video=held_video, VideoReview=VideoReview, logger=logging.getLogger("t"),
        claim_scenes=SimpleNamespace(annotate_scenes=lambda *a: [{"name": "Hook"}]),
        script=SimpleNamespace(full_narration=lambda: "the narration"),
        section_claims=[], fact_results=[], channel_id="news", slug="the-lost-city",
        topic="The lost city", published_title="The Lost City", ir_project=None,
        video_path=Path("/out/final_video.mp4"),
    )
    ns.update(over)
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(MAIN), "exec"), ns)
    return ns["_record_held_run"]


def _run(state, gate_meta, fake=None, **over):
    fake = fake or FakeSupabase()
    env = {"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}
    with _patched(fake), mock.patch.dict(os.environ, env), \
            mock.patch.object(VideoReview, "upload_preview",
                              return_value=f"news/{held_video_id('news', 'the-lost-city')}.mp4"):
        _held_runner(**over)(state, gate_meta=gate_meta)
    return fake


class HeldRunsGetAPreview(unittest.TestCase):
    HID = held_video_id("news", "the-lost-city")

    def test_every_held_state_records_preview_and_script_on_the_held_row(self):
        for state in (held_video.STATE_BLOCKED, held_video.STATE_AWAITING_APPROVAL,
                      held_video.STATE_HELD):
            with self.subTest(state=state):
                fake = _run(state, {"allowed": state != held_video.STATE_BLOCKED,
                                    "blocks": ["qc"] if state == "blocked" else []})
                self.assertEqual(list(fake.rows), [self.HID])
                row = fake.rows[self.HID]
                self.assertEqual(row["preview_path"], f"news/{self.HID}.mp4")
                self.assertEqual(row["script_text"], "the narration")
                self.assertEqual(row["publish_state"], state)
                self.assertEqual(row["review_state"], "pending")
                self.assertIsNone(row["published_at"])  # still reads as not uploaded
                self.assertIsNone(row["privacy"])

    def test_a_storage_outage_still_leaves_the_held_row(self):
        fake = FakeSupabase()
        env = {"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}
        with _patched(fake), mock.patch.dict(os.environ, env), \
                mock.patch.object(VideoReview, "upload_preview", side_effect=RuntimeError("down")):
            _held_runner()(held_video.STATE_HELD, gate_meta={"allowed": True})
        self.assertIn("publish_state", fake.rows[self.HID])


class UploadFailedIsRecorded(unittest.TestCase):
    HID = held_video_id("news", "the-lost-city")

    def test_row_exists_with_the_fixed_cause_and_the_gate_verdict(self):
        gate = {"allowed": True, "blocks": [], "warnings": ["w"], "checks_run": ["qc"]}
        fake = _run(held_video.STATE_HELD, {**gate, "reason": "upload_failed"})
        row = fake.rows[self.HID]
        self.assertEqual(row["hold_detail"]["cause"], "upload_failed")
        self.assertEqual(row["hold_detail"]["reason"], "held")
        self.assertTrue(row["hold_detail"]["gate"]["allowed"])
        self.assertTrue(row["preview_path"])

    def test_free_text_is_never_stored(self):
        secret = "ya29.A0-token-for-someone"
        detail = held_video.gate_detail(
            "held", {"allowed": True, "reason": f"HttpError: invalid_grant {secret}"})
        self.assertNotIn("cause", detail)
        self.assertNotIn(secret, repr(detail))
        fake = _run(held_video.STATE_HELD, {"allowed": True, "reason": f"boom {secret}"})
        self.assertNotIn(secret, repr(fake.rows) + repr(fake.calls))

    def test_gate_detail_without_cause_is_unchanged(self):
        self.assertEqual(held_video.gate_detail("blocked", {"allowed": False, "blocks": ["qc"]}),
                         {"reason": "blocked", "gate": {"allowed": False, "blocks": ["qc"],
                                                        "warnings": [], "checks_run": []}})


class PruneRanksHeldApart(unittest.TestCase):
    def test_uploaded_and_held_previews_are_listed_separately(self):
        calls = []

        def get(url, params=None, headers=None, timeout=None):
            calls.append(params)
            return mock.Mock(raise_for_status=lambda: None, json=lambda: [])

        with mock.patch("requests.get", get):
            VideoReview(url=URL, service_key=KEY).prune("news")
        by_filter = {p["published_at"]: p["order"] for p in calls}
        self.assertEqual(by_filter, {"not.is.null": "published_at.desc", "is.null": "held_at.desc"})

    def test_a_failing_held_listing_still_prunes_uploaded_ones(self):
        def get(url, params=None, headers=None, timeout=None):
            if params["published_at"] == "is.null":
                raise ConnectionError("no held_at column")
            return mock.Mock(raise_for_status=lambda: None,
                             json=lambda: [{"video_id": "old", "preview_path": "news/old.mp4"}])

        deleted = []
        with mock.patch("requests.get", get), \
                mock.patch("requests.delete", lambda *a, **k: deleted.append(k["json"]) or
                           mock.Mock(status_code=200)), \
                mock.patch("requests.patch", lambda *a, **k: mock.Mock(status_code=200)):
            n = VideoReview(url=URL, service_key=KEY).prune("news")
        self.assertEqual(n, 1)
        self.assertEqual(deleted, [{"prefixes": ["news/old.mp4"]}])


HELD_OBJECT = f"news/{held_video_id('news', 'the-lost-city')}.mp4"


def _storage_deletes(fake):
    return [c[3]["prefixes"] for c in fake.calls if c[0] == "delete" and "/storage/" in c[1]]


class HeldPreviewIsNotOrphaned(unittest.TestCase):
    """F6: the held run's preview object goes when the run uploads (or its row is merged away)."""

    def _hold(self, fake):
        HeldVideos(url=URL, service_key=KEY).record_held(
            channel_id="news", slug="the-lost-city", state=held_video.STATE_HELD, topic="t")
        fake.rows[held_video_id("news", "the-lost-city")]["preview_path"] = HELD_OBJECT

    def _promote(self):
        return HeldVideos(url=URL, service_key=KEY).promote(
            channel_id="news", slug="the-lost-city", youtube_id="dQw4w9WgXcQ",
            published_at="2026-09-26T08:00:00", privacy="private")

    def test_upload_after_hold_deletes_the_old_object_and_points_at_the_new_one(self):
        fake = FakeSupabase()
        with _patched(fake):
            self._hold(fake)
            self.assertTrue(self._promote())
            _record(_review())  # upload_preview -> news/dQw4w9WgXcQ.mp4
        self.assertEqual(fake.rows["dQw4w9WgXcQ"]["preview_path"], "news/dQw4w9WgXcQ.mp4")
        self.assertIn([HELD_OBJECT], _storage_deletes(fake))

    def test_a_failed_new_upload_keeps_the_old_object(self):
        fake = FakeSupabase()
        r = _review()
        r.upload_preview = mock.MagicMock(return_value=None)
        with _patched(fake):
            self._hold(fake)
            self._promote()
            _record(r)
        self.assertNotIn([HELD_OBJECT], _storage_deletes(fake))

    def test_re_recording_a_held_run_does_not_delete_its_own_preview(self):
        fake = FakeSupabase()
        r = _review()
        r.upload_preview = mock.MagicMock(return_value=HELD_OBJECT)
        with _patched(fake):
            self._hold(fake)
            _record(r, video_id=held_video_id("news", "the-lost-city"))
        self.assertNotIn([HELD_OBJECT], _storage_deletes(fake))

    def test_the_merged_away_held_row_takes_its_object_with_it(self):
        fake = FakeSupabase()
        with _patched(fake):
            self._hold(fake)
            fake.rows["dQw4w9WgXcQ"] = {"video_id": "dQw4w9WgXcQ", "channel_id": "news"}  # the mirror got there first
            self.assertTrue(self._promote())
        self.assertNotIn(held_video_id("news", "the-lost-city"), fake.rows)
        self.assertIn([HELD_OBJECT], _storage_deletes(fake))

    def test_prune_keeps_two_held_and_five_uploaded(self):
        offsets = {}

        def get(url, params=None, headers=None, timeout=None):
            offsets[params["published_at"]] = params["offset"]
            return mock.Mock(raise_for_status=lambda: None, json=lambda: [])

        with mock.patch("requests.get", get):
            VideoReview(url=URL, service_key=KEY).prune("news")
        self.assertEqual(offsets, {"not.is.null": "5", "is.null": "2"})


class RepairedRowShowsTheRepairedCut(unittest.TestCase):
    """F7: a 'repaired' row never keeps the pre-repair preview."""

    def _repair(self, new_preview):
        from modules import scene_repair

        fake = FakeSupabase()
        plan = SimpleNamespace(channel_id="news", slug="the-lost-city", topic="t", run_dir=Path("/nonexistent"),
                               script={"title": "T", "sections": []}, scene_ids=("s001",))
        result = SimpleNamespace(video_path=Path("/out/final_video.mp4"), repaired_at="2026-09-25T10:00:00+00:00")
        env = {"SUPABASE_URL": URL, "SUPABASE_SERVICE_KEY": KEY}
        with _patched(fake), mock.patch.dict(os.environ, env), \
                mock.patch.object(VideoReview, "upload_preview", return_value=new_preview):
            HeldVideos().record_held(channel_id="news", slug="the-lost-city", state=held_video.STATE_HELD, script_text="s")
            fake.rows[held_video_id("news", "the-lost-city")]["preview_path"] = HELD_OBJECT
            scene_repair._record_repaired_row(plan, result)
        return fake.rows[held_video_id("news", "the-lost-city")]

    def test_the_repaired_cut_replaces_the_preview(self):
        row = self._repair("news/new-cut.mp4")
        self.assertEqual(row["publish_state"], "repaired_awaiting_review")
        self.assertEqual(row["preview_path"], "news/new-cut.mp4")
        self.assertEqual(row["script_text"], "s")  # the first hold's script is not blanked

    def test_without_a_new_copy_the_old_pointer_is_cleared(self):
        self.assertIsNone(self._repair(None)["preview_path"])


if __name__ == "__main__":
    unittest.main()
