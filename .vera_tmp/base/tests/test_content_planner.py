"""Tests for modules.content_planner — the pre-pipeline topic queue.

Every test uses a tempdir-backed store_path; the real history/ directory is
never touched.
"""

import shutil
import tempfile
import types
import unittest
from pathlib import Path

from modules.content_planner import CalendarEntry, ContentPlanner


class ContentPlannerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="content_planner_test_")
        self.store_path = Path(self.tmpdir) / "content_calendar.json"
        self.planner = ContentPlanner(store_path=self.store_path)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # -- enqueue + list --------------------------------------------------

    def test_enqueue_and_list(self):
        entry = self.planner.enqueue("The Fall of Constantinople", source="manual")
        self.assertIsInstance(entry, CalendarEntry)
        self.assertEqual(entry.topic, "The Fall of Constantinople")
        self.assertEqual(entry.source, "manual")
        self.assertEqual(entry.status, "queued")
        self.assertTrue(entry.entry_id)

        entries = self.planner.list_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].entry_id, entry.entry_id)

    # -- dedup -------------------------------------------------------------

    def test_exact_duplicate_queued_topic_returns_existing_entry(self):
        first = self.planner.enqueue("Roman Aqueducts")
        second = self.planner.enqueue("Roman Aqueducts")
        self.assertEqual(first.entry_id, second.entry_id)
        self.assertEqual(len(self.planner.list_entries()), 1)

    def test_published_topic_can_be_reenqueued(self):
        first = self.planner.enqueue("Byzantine Trade Routes")
        self.planner.mark_published(first.entry_id)

        second = self.planner.enqueue("Byzantine Trade Routes")
        self.assertNotEqual(first.entry_id, second.entry_id)
        self.assertEqual(second.status, "queued")

        all_entries = self.planner.list_entries()
        self.assertEqual(len(all_entries), 2)

    def test_skipped_topic_can_be_reenqueued(self):
        first = self.planner.enqueue("Hittite Empire")
        self.planner.mark_skipped(first.entry_id, reason="too niche")

        second = self.planner.enqueue("Hittite Empire")
        self.assertNotEqual(first.entry_id, second.entry_id)
        self.assertEqual(second.status, "queued")
        self.assertEqual(len(self.planner.list_entries()), 2)

    # -- next_topic ----------------------------------------------------

    def test_next_topic_returns_oldest_queued_without_mutating(self):
        first = self.planner.enqueue("Topic A")
        self.planner.enqueue("Topic B")
        self.planner.enqueue("Topic C")

        peeked = self.planner.next_topic()
        self.assertEqual(peeked.entry_id, first.entry_id)

        # Peeking again returns the same entry, and status is untouched.
        peeked_again = self.planner.next_topic()
        self.assertEqual(peeked_again.entry_id, first.entry_id)
        self.assertEqual(peeked_again.status, "queued")

        # Confirm nothing was mutated on disk either.
        reloaded = self.planner.list_entries(status="queued")
        self.assertEqual(len(reloaded), 3)

    def test_next_topic_empty_queue_returns_none(self):
        self.assertIsNone(self.planner.next_topic())

    def test_next_topic_skips_non_queued_entries(self):
        first = self.planner.enqueue("Topic A")
        second = self.planner.enqueue("Topic B")
        self.planner.mark_published(first.entry_id)

        next_up = self.planner.next_topic()
        self.assertEqual(next_up.entry_id, second.entry_id)

    # -- reserve / mark_rendered lifecycle -------------------------------

    def test_reserve_then_render_then_publish(self):
        entry = self.planner.enqueue("Topic A")

        self.assertEqual(self.planner.reserve(entry.entry_id).status, "reserved")
        self.assertEqual(self.planner.list_entries()[0].status, "reserved")

        self.assertEqual(self.planner.mark_rendered(entry.entry_id).status, "rendered")
        self.assertEqual(self.planner.list_entries()[0].status, "rendered")

        self.assertEqual(self.planner.mark_published(entry.entry_id).status, "published")
        self.assertEqual(self.planner.list_entries()[0].status, "published")

    def test_next_topic_skips_reserved_and_rendered_entries(self):
        """A reserved or rendered entry belongs to a run already in flight; it
        must never be handed to a second run as the next thing to make."""
        first = self.planner.enqueue("Topic A")
        second = self.planner.enqueue("Topic B")
        self.planner.reserve(first.entry_id)

        self.assertEqual(self.planner.next_topic().entry_id, second.entry_id)

        self.planner.mark_rendered(first.entry_id)
        self.assertEqual(self.planner.next_topic().entry_id, second.entry_id)

    def test_reserve_unknown_id_raises(self):
        with self.assertRaises(ValueError):
            self.planner.reserve("nonexistent-id")

    def test_mark_rendered_unknown_id_raises(self):
        with self.assertRaises(ValueError):
            self.planner.mark_rendered("nonexistent-id")

    # -- mark_published / mark_skipped ----------------------------------

    def test_mark_published_updates_status(self):
        entry = self.planner.enqueue("Topic A")
        updated = self.planner.mark_published(entry.entry_id)
        self.assertEqual(updated.status, "published")

        reloaded = self.planner.list_entries()[0]
        self.assertEqual(reloaded.status, "published")

    def test_mark_published_unknown_id_raises(self):
        with self.assertRaises(ValueError):
            self.planner.mark_published("nonexistent-id")

    def test_mark_skipped_updates_status_and_appends_reason(self):
        entry = self.planner.enqueue("Topic A", rationale="seemed promising")
        updated = self.planner.mark_skipped(entry.entry_id, reason="duplicate coverage")
        self.assertEqual(updated.status, "skipped")
        self.assertIn("seemed promising", updated.rationale)
        self.assertIn("[skipped: duplicate coverage]", updated.rationale)

    def test_mark_skipped_without_reason_leaves_rationale_unchanged(self):
        entry = self.planner.enqueue("Topic A", rationale="seemed promising")
        updated = self.planner.mark_skipped(entry.entry_id)
        self.assertEqual(updated.status, "skipped")
        self.assertEqual(updated.rationale, "seemed promising")

    def test_mark_skipped_unknown_id_raises(self):
        with self.assertRaises(ValueError):
            self.planner.mark_skipped("nonexistent-id", reason="whatever")

    # -- list_entries filtering ------------------------------------------

    def test_list_entries_filters_by_status(self):
        a = self.planner.enqueue("Topic A")
        b = self.planner.enqueue("Topic B")
        c = self.planner.enqueue("Topic C")
        self.planner.mark_published(a.entry_id)
        self.planner.mark_skipped(b.entry_id, reason="nope")

        queued = self.planner.list_entries(status="queued")
        published = self.planner.list_entries(status="published")
        skipped = self.planner.list_entries(status="skipped")

        self.assertEqual([e.entry_id for e in queued], [c.entry_id])
        self.assertEqual([e.entry_id for e in published], [a.entry_id])
        self.assertEqual([e.entry_id for e in skipped], [b.entry_id])

    # -- enqueue_opportunity (duck-typed) --------------------------------

    def test_enqueue_opportunity_duck_typed(self):
        fake_opportunity = types.SimpleNamespace(
            topic="Ancient Trade Routes",
            source="trend",
            rationale="view velocity 500 views/hr",
        )
        entry = self.planner.enqueue_opportunity(fake_opportunity)
        self.assertEqual(entry.topic, "Ancient Trade Routes")
        self.assertEqual(entry.source, "content_opportunity:trend")
        self.assertEqual(entry.rationale, "view velocity 500 views/hr")
        self.assertEqual(entry.status, "queued")

    def test_enqueue_opportunity_dedup_with_plain_enqueue(self):
        fake_opportunity = types.SimpleNamespace(
            topic="Ancient Trade Routes",
            source="trend",
            rationale="view velocity 500 views/hr",
        )
        first = self.planner.enqueue_opportunity(fake_opportunity)
        second = self.planner.enqueue_opportunity(fake_opportunity)
        self.assertEqual(first.entry_id, second.entry_id)

    # -- persistence ---------------------------------------------------

    def test_persistence_round_trip_across_instances(self):
        entry = self.planner.enqueue("Persisted Topic", source="manual")
        entry_id = entry.entry_id

        second_planner = ContentPlanner(store_path=self.store_path)
        reloaded = second_planner.list_entries()
        self.assertEqual(len(reloaded), 1)
        self.assertEqual(reloaded[0].entry_id, entry_id)
        self.assertEqual(reloaded[0].topic, "Persisted Topic")

        second_planner.mark_published(entry_id)
        third_planner = ContentPlanner(store_path=self.store_path)
        self.assertEqual(third_planner.list_entries()[0].status, "published")

    def test_empty_or_missing_store_returns_cleanly(self):
        missing_path = Path(self.tmpdir) / "does_not_exist_yet.json"
        planner = ContentPlanner(store_path=missing_path)
        self.assertEqual(planner.list_entries(), [])
        self.assertIsNone(planner.next_topic())


if __name__ == "__main__":
    unittest.main()
