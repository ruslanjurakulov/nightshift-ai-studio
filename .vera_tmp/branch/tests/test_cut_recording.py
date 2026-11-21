"""What the pipeline records so a person's approval can bind to the exact cut (migration 0112).

An approval is only as good as the hash it is bound to, so these pin the writers of `videos.cut_sha256` and
`videos.gate_verdict`: the review record at upload, the held row, the promotion of a held row, and the void of an earlier
approval when a cut is recorded again or repaired. What must hold:

* the hash is the sha256 of the master FILE as it is on disk when it is recorded (not of the preview, not of a name);
* a verdict that is not known is NULL ("unknown"), never a pass; a verdict is stored exactly as the gate gave it;
* recording a cut clears the earlier approval's columns, and promoting a held row never carries the hold's verdict over to
  the upload (a failed review write can only leave "unknown");
* a database without the 0112 columns still gets the preview, the script and the scenes (nothing is lost, nothing raises);
* nothing here sends privacy, publish_state or any approval of a person: only the database function writes an approval.
"""

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import held_video, scene_repair
from modules.held_video import HeldVideos, held_video_id
from modules.video_review import NO_APPROVAL, VideoReview
from tests.test_video_review_record import (  # the same fake PostgREST the record tests use
    KEY, MANIFEST, SCENES, UPLOAD, URL, FakeSupabase, _patched, _record, _review,
)

GATE = {"allowed": True, "blocks": [], "warnings": ["thin_sources"], "checks_run": ["rights", "facts"],
        "reason": "ignored", "qc": {"huge": "report"}}
VERDICT = {"allowed": True, "blocks": [], "warnings": ["thin_sources"], "checks_run": ["rights", "facts"]}
VID = "dQw4w9WgXcQ"


class Cut(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.master = Path(self.tmp.name) / "final_video.mp4"
        self.master.write_bytes(b"the master as rendered")
        self.sha = hashlib.sha256(b"the master as rendered").hexdigest()


class TheReviewRecord(Cut):
    def test_it_stores_the_hash_of_the_master_and_the_gates_verdict_and_clears_an_old_approval(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        row = fake.rows[VID]
        self.assertEqual(row["cut_sha256"], self.sha)
        self.assertEqual(row["gate_verdict"], VERDICT)
        for column in NO_APPROVAL:
            self.assertIsNone(row[column], column)

    def test_recording_a_different_cut_again_changes_the_hash_and_voids_the_approval(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
            # a person approved that cut
            fake.rows[VID].update(review_state="approved", approved_cut_sha256=self.sha, decided_by="u1",
                                  decided_by_email="a@b.test", decided_at="2026-10-01T10:00:00Z",
                                  approval_expires_at="2026-10-02T10:00:00Z")
            self.master.write_bytes(b"a re-rendered master")
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        row = fake.rows[VID]
        self.assertEqual(row["cut_sha256"], hashlib.sha256(b"a re-rendered master").hexdigest())
        self.assertNotEqual(row["cut_sha256"], self.sha)
        self.assertEqual(row["review_state"], "pending")
        for column in NO_APPROVAL:
            self.assertIsNone(row[column], column)

    def test_an_unknown_verdict_or_an_unreadable_master_is_null_never_a_pass(self):
        for verdict in (None, "allowed", ["allowed"]):
            fake = FakeSupabase()
            with _patched(fake):
                _record(_review(), video_path=Path(self.tmp.name) / "missing.mp4", gate_verdict=verdict)
            row = fake.rows[VID]
            self.assertIsNone(row["gate_verdict"], verdict)
            self.assertIsNone(row["cut_sha256"])

    def test_a_database_without_0112_still_gets_the_preview_the_script_and_the_scenes(self):
        fake = FakeSupabase(missing_columns={"cut_sha256", "gate_verdict", *NO_APPROVAL})
        with _patched(fake):
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        row = fake.rows[VID]
        self.assertEqual(row["script_text"], "the narration")
        self.assertEqual(row["preview_path"], "news/dQw4w9WgXcQ.mp4")
        self.assertEqual(row["manifest"], MANIFEST)
        self.assertEqual(row["scenes"][0]["end_s"], 9.5)
        for column in ("cut_sha256", "gate_verdict", *NO_APPROVAL):
            self.assertNotIn(column, row)

    def test_without_0013_and_0112_it_still_lands(self):
        fake = FakeSupabase(missing_columns={"manifest", "cut_sha256", "gate_verdict", *NO_APPROVAL})
        with _patched(fake):
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        row = fake.rows[VID]
        self.assertEqual(row["script_text"], "the narration")
        self.assertNotIn("manifest", row)

    def test_without_0013_but_with_0112_the_hash_still_lands(self):
        fake = FakeSupabase(missing_columns={"manifest"})
        with _patched(fake):
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        row = fake.rows[VID]
        self.assertEqual(row["cut_sha256"], self.sha)
        self.assertNotIn("manifest", row)

    def test_it_never_sends_privacy_or_a_persons_approval(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        sent = [c[3] for c in fake.calls if c[0] in ("post", "patch") and "/rest/v1/videos" in c[1]]
        for body in sent:
            for banned in ("privacy", "publish_state"):
                self.assertNotIn(banned, body)
            for column in NO_APPROVAL:
                self.assertIsNone(body.get(column), column)   # only ever cleared

    def test_the_log_never_carries_the_key(self):
        fake = FakeSupabase(fail=True)
        with _patched(fake), self.assertLogs("modules.video_review", level="WARNING") as logs:
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        self.assertNotIn(KEY, "\n".join(logs.output))


class TheGateVerdict(unittest.TestCase):
    def test_it_keeps_what_the_gate_said_and_drops_the_bulky_reports(self):
        self.assertEqual(held_video.gate_verdict(GATE), VERDICT)
        self.assertEqual(held_video.gate_verdict({"allowed": False, "blocks": ["rights"]}),
                         {"allowed": False, "blocks": ["rights"], "warnings": [], "checks_run": []})

    def test_no_boolean_verdict_is_no_verdict(self):
        for meta in (None, {}, {"allowed": None}, {"allowed": "true"}, {"allowed": 1}, ["allowed"], "x"):
            self.assertIsNone(held_video.gate_verdict(meta), meta)


class TheHeldRow(Cut):
    def _hold(self, fake, detail, local_path=None, slug="the-lost-city"):
        with _patched(fake):
            return HeldVideos(url=URL, service_key=KEY).record_held(
                channel_id="news", slug=slug, state=held_video.STATE_HELD, topic="t",
                local_path=str(local_path or self.master), detail=detail, now="2026-09-25T10:00:00+00:00")

    def test_a_held_run_records_its_cut_and_the_verdict_of_its_gate(self):
        fake = FakeSupabase()
        vid = self._hold(fake, held_video.gate_detail("held", GATE))
        row = fake.rows[vid]
        self.assertEqual(row["cut_sha256"], self.sha)
        self.assertEqual(row["gate_verdict"], VERDICT)
        self.assertEqual(row["review_state"], "pending")

    def test_a_repairs_new_cut_has_no_verdict_the_old_one_does_not_judge_it(self):
        fake = FakeSupabase()
        vid = self._hold(fake, {"reason": "repaired_awaiting_review", "scene_ids": ["s001"]})
        # the row held a passing verdict for the cut before the repair
        fake.rows[vid]["gate_verdict"] = VERDICT
        self.master.write_bytes(b"the repaired master")
        self._hold(fake, {"reason": "repaired_awaiting_review", "scene_ids": ["s001"]})
        row = fake.rows[vid]
        self.assertIsNone(row["gate_verdict"])
        self.assertEqual(row["cut_sha256"], hashlib.sha256(b"the repaired master").hexdigest())

    def test_an_older_database_still_gets_the_held_state(self):
        fake = FakeSupabase(missing_columns={"cut_sha256", "gate_verdict"})
        vid = self._hold(fake, held_video.gate_detail("held", GATE))
        row = fake.rows[vid]
        self.assertEqual(row["publish_state"], "held")
        self.assertEqual(row["hold_detail"]["gate"]["allowed"], True)
        self.assertNotIn("cut_sha256", row)


class Promotion(Cut):
    def test_promotion_takes_the_uploaded_masters_hash_and_forgets_the_holds_verdict(self):
        fake = FakeSupabase()
        slug = UPLOAD["slug"]
        with _patched(fake):
            held = HeldVideos(url=URL, service_key=KEY)
            vid = held.record_held(channel_id="news", slug=slug, state=held_video.STATE_HELD, local_path=str(self.master),
                                   detail=held_video.gate_detail("held", GATE), now="2026-09-25T10:00:00+00:00")
            self.assertEqual(fake.rows[vid]["gate_verdict"], VERDICT)
            # the run is resumed and renders a different master, which is what gets uploaded
            self.master.write_bytes(b"the master that was uploaded")
            self.assertTrue(held.promote(channel_id="news", slug=slug, youtube_id=VID, published_at=UPLOAD["published_at"],
                                         privacy="private", local_path=str(self.master)))
        row = fake.rows[VID]
        self.assertEqual(row["cut_sha256"], hashlib.sha256(b"the master that was uploaded").hexdigest())
        self.assertIsNone(row["gate_verdict"], "the review record writes the verdict for THIS cut; until then it is unknown")

    def test_the_full_story_ends_with_the_uploaded_cut_and_its_own_verdict(self):
        fake = FakeSupabase()
        slug = UPLOAD["slug"]
        with _patched(fake):
            held = HeldVideos(url=URL, service_key=KEY)
            held.record_held(channel_id="news", slug=slug, state=held_video.STATE_BLOCKED, local_path=str(self.master),
                             detail=held_video.gate_detail("blocked", {**GATE, "allowed": False, "blocks": ["rights"]}))
            held.promote(channel_id="news", slug=slug, youtube_id=VID, published_at=UPLOAD["published_at"],
                         privacy="private", local_path=str(self.master))
            _record(_review(), video_path=self.master, gate_verdict=VERDICT)
        self.assertEqual(list(fake.rows), [VID])
        row = fake.rows[VID]
        self.assertEqual(row["gate_verdict"], VERDICT)
        self.assertEqual(row["cut_sha256"], self.sha)
        self.assertNotIn(held_video_id("news", slug), fake.rows)

    def test_an_older_database_still_promotes(self):
        fake = FakeSupabase(missing_columns={"cut_sha256", "gate_verdict"})
        slug = UPLOAD["slug"]
        with _patched(fake):
            held = HeldVideos(url=URL, service_key=KEY)
            held.record_held(channel_id="news", slug=slug, state=held_video.STATE_HELD, local_path=str(self.master))
            self.assertTrue(held.promote(channel_id="news", slug=slug, youtube_id=VID, published_at=UPLOAD["published_at"],
                                         privacy="private", local_path=str(self.master)))
        self.assertEqual(fake.rows[VID]["publish_state"], "uploaded")


class RepairVoidsTheApprovalToo(unittest.TestCase):
    class Sync:
        enabled = True

        def __init__(self, refuse_new_columns):
            self.refuse = refuse_new_columns
            self.updates = []

        def select(self, table, params):
            return [{"video_id": VID, "review_state": "approved"}]

        def update(self, table, filters, values):
            self.updates.append((table, dict(values)))
            return not (self.refuse and table == "videos" and "approved_cut_sha256" in values)

    def test_the_hash_the_person_and_the_times_are_cleared_with_the_state(self):
        sync = self.Sync(False)
        out = scene_repair.invalidate_approvals("news", "slug", ["s001"], sync=sync)
        self.assertTrue(out["videos_reset"])
        self.assertEqual(sync.updates[0], ("videos", {"review_state": "pending", **NO_APPROVAL}))

    def test_a_database_without_the_columns_still_has_its_state_reset(self):
        sync = self.Sync(True)
        out = scene_repair.invalidate_approvals("news", "slug", ["s001"], sync=sync)
        self.assertTrue(out["videos_reset"])
        self.assertEqual([u for u in sync.updates if u[0] == "videos"][-1], ("videos", {"review_state": "pending"}))


class MainWiring(unittest.TestCase):
    src = (Path(__file__).resolve().parent.parent / "main.py").read_text()

    def test_both_records_pass_the_verdict_of_their_own_gate(self):
        self.assertEqual(self.src.count("gate_verdict=held_video.gate_verdict("), 2)
        upload = self.src[self.src.index("review.record("):]
        upload = upload[:upload.index("except Exception")]
        self.assertIn("gate_verdict=held_video.gate_verdict(gate.to_metadata())", upload)
        held = self.src[self.src.index("VideoReview().record("):]
        held = held[:held.index("except Exception")]
        self.assertIn("gate_verdict=held_video.gate_verdict(gate_meta)", held)

    def test_nothing_writes_a_persons_approval_but_the_database_function(self):
        root = Path(__file__).resolve().parent.parent
        offenders = []
        for path in list(root.glob("*.py")) + list((root / "modules").rglob("*.py")) + list((root / "tools").rglob("*.py")):
            text = path.read_text(encoding="utf-8")
            for column in ("decided_by_email", "approval_expires_at"):
                if column in text and path.name not in ("video_review.py",):
                    offenders.append((path.name, column))
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
