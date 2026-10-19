"""Tests for modules/supabase_sync.py.

No real network calls: `requests.post` is mocked. A real tempdir StateStore is
used so mirror_from_store exercises the real read path and row shaping.
"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from modules.state_store import StateStore
from modules.supabase_sync import (
    SupabaseSync,
    _canonical_quantity,
    video_cost_row_key,
    video_cost_rows_with_keys,
)


class SupabaseSyncDisabledTestCase(unittest.TestCase):
    def test_disabled_without_credentials(self):
        sync = SupabaseSync(url="", service_key="")
        self.assertFalse(sync.enabled)
        self.assertEqual(sync.upsert("videos", [{"video_id": "v1"}], on_conflict="video_id"), 0)

    def test_disabled_mirror_returns_empty(self):
        sync = SupabaseSync(url="", service_key="")
        self.assertEqual(sync.mirror_from_store(MagicMock()), {})


class SupabaseSyncEnabledTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test_chronos.db"
        self.store = StateStore(self.db_path)
        self.sync = SupabaseSync(url="https://demo.supabase.co", service_key="service-key-123")

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _ok_response(self):
        resp = MagicMock()
        resp.status_code = 201
        resp.text = ""
        return resp

    def test_enabled_with_credentials(self):
        self.assertTrue(self.sync.enabled)

    def test_upsert_posts_with_conflict_and_auth(self):
        with patch("modules.supabase_sync.requests.post", return_value=self._ok_response()) as post:
            n = self.sync.upsert("videos", [{"video_id": "v1", "title": "T"}], on_conflict="video_id")
        self.assertEqual(n, 1)
        _, kwargs = post.call_args
        self.assertEqual(kwargs["params"]["on_conflict"], "video_id")
        self.assertIn("merge-duplicates", kwargs["headers"]["Prefer"])
        self.assertEqual(kwargs["headers"]["apikey"], "service-key-123")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer service-key-123")

    def test_upsert_empty_rows_is_noop(self):
        with patch("modules.supabase_sync.requests.post") as post:
            self.assertEqual(self.sync.upsert("videos", [], on_conflict="video_id"), 0)
        post.assert_not_called()

    def test_upsert_can_ignore_duplicates_instead_of_merging(self):
        # learnings: an existing (possibly human-decided) row must be left alone.
        with patch("modules.supabase_sync.requests.post", return_value=self._ok_response()) as post:
            self.sync.upsert("learnings", [{"dedup_key": "k"}], on_conflict="channel_id,dedup_key",
                             ignore_duplicates=True)
        _, kwargs = post.call_args
        self.assertIn("ignore-duplicates", kwargs["headers"]["Prefer"])
        self.assertNotIn("merge-duplicates", kwargs["headers"]["Prefer"])

    def test_update_patches_with_filters(self):
        ok = self._ok_response()
        ok.status_code = 204
        with patch("modules.supabase_sync.requests.patch", return_value=ok) as patch_:
            self.assertTrue(self.sync.update("learnings", {"status": "eq.pending"}, {"confidence": 0.5}))
        _, kwargs = patch_.call_args
        self.assertEqual(kwargs["params"], {"status": "eq.pending"})
        self.assertEqual(kwargs["json"], {"confidence": 0.5})

    def test_update_refuses_an_unfiltered_patch(self):
        with patch("modules.supabase_sync.requests.patch") as patch_:
            self.assertFalse(self.sync.update("learnings", {}, {"confidence": 0.5}))
        patch_.assert_not_called()

    def test_update_failure_returns_false_without_raising(self):
        with patch("modules.supabase_sync.requests.patch", side_effect=ConnectionError("down")):
            self.assertFalse(self.sync.update("learnings", {"id": "eq.1"}, {"confidence": 0.5}))

    def test_upsert_http_error_returns_zero(self):
        bad = MagicMock()
        bad.status_code = 400
        bad.text = "bad request"
        with patch("modules.supabase_sync.requests.post", return_value=bad):
            self.assertEqual(self.sync.upsert("videos", [{"video_id": "v1"}], on_conflict="video_id"), 0)

    def test_upsert_network_error_returns_zero(self):
        with patch("modules.supabase_sync.requests.post", side_effect=RuntimeError("connection reset")):
            self.assertEqual(self.sync.upsert("videos", [{"video_id": "v1"}], on_conflict="video_id"), 0)

    def test_mirror_from_store_covers_all_tables(self):
        # Seed one row into each mirrored table so every upsert has something.
        self.store.record_video(video_id="v1", topic="Rome", title="T", published_at="2026-08-20T00:00:00")
        self.store.record_metrics_snapshot(video_id="v1", snapshot_date="2026-08-25", views=100)
        self.store.record_feedback_signal(video_id="v1", signal="HIGH_RETENTION", analyzed_date="2026-08-25", topic="Rome")
        self.store.upsert_topic_performance(topic="Rome", score=88.0, videos_analyzed=1, updated_at="2026-08-25")
        self.store.record_competitor_snapshot(
            video_id="cv1", channel_id="c1", title="rival", view_count=10, like_count=1,
            comment_count=0, published_at="2026-08-01", polled_date="2026-08-25", view_velocity=1.0,
        )
        self.store.record_trending_snapshot(
            video_id="tv1", title="trend", view_count=99, like_count=5, comment_count=2,
            published_at="2026-08-02", region_code="US", category_id="24", polled_date="2026-08-25",
        )
        from modules import event_log as events
        events.emit(events.TOPIC_SELECTED, agent="topic_manager", metadata={"topic": "Rome"}, store=self.store)

        posted_tables = []

        def capture(url, **kwargs):
            posted_tables.append(url.rsplit("/", 1)[-1])
            return self._ok_response()

        with patch("modules.supabase_sync.requests.post", side_effect=capture):
            counts = self.sync.mirror_from_store(self.store)

        # Every mirrored table got a POST and a non-zero count.
        for table in ("videos", "metrics_snapshots", "feedback_signals", "topic_performance",
                      "competitor_snapshots", "trending_snapshots", "system_events"):
            self.assertIn(table, posted_tables, f"{table} was not mirrored")
            self.assertEqual(counts.get(table), 1)

    def test_event_row_gets_synthetic_key_and_no_local_id(self):
        row = SupabaseSync._event_row({"id": 7, "ts": "2026-08-25T00:00:00", "event": "topic.selected", "video_id": "v1"})
        self.assertNotIn("id", row)
        self.assertEqual(row["event_key"], "2026-08-25T00:00:00|topic.selected|7")

    def test_strip_local_id(self):
        self.assertEqual(SupabaseSync._strip_local_id({"id": 3, "video_id": "v1"}), {"video_id": "v1"})


class FakeCostsTable:
    """A stand-in for the hosted video_costs table that enforces what migration
    0106 does: a UNIQUE row_key, and PostgREST's ignore-duplicates on it."""

    def __init__(self, migrated=True, missing_code="PGRST204", fail_after=None, fail_status=500):
        self.rows = []
        self.posts = []
        self.migrated = migrated
        self.missing_code = missing_code
        #: fail every costs request after this many have succeeded (a flaky network)
        self.fail_after = fail_after
        self.fail_status = fail_status

    def post(self, url, params=None, json=None, headers=None, timeout=None):
        resp = MagicMock()
        self.posts.append({"url": url, "params": params, "prefer": (headers or {}).get("Prefer", ""), "n": len(json)})
        if not url.endswith("/video_costs"):
            resp.status_code, resp.text = 201, ""
            return resp
        if not self.migrated:
            resp.status_code, resp.text = 400, '{"code":"%s","message":"no row_key column"}' % self.missing_code
            resp.json.return_value = {"code": self.missing_code, "message": "no row_key column"}
            return resp
        if self.fail_after is not None and sum(1 for p in self.posts if p["url"].endswith("/video_costs")) > self.fail_after:
            resp.status_code, resp.text = self.fail_status, "upstream timeout"
            resp.json.side_effect = ValueError("not json")
            return resp
        assert params == {"on_conflict": "row_key"}, params
        assert "resolution=ignore-duplicates" in headers["Prefer"], headers["Prefer"]
        have = {r["row_key"] for r in self.rows}
        for r in json:
            if r["row_key"] not in have:
                self.rows.append(r)
                have.add(r["row_key"])
        resp.status_code, resp.text = 201, ""
        return resp


class VideoCostsIdempotentTestCase(unittest.TestCase):
    """B-03: the nightly mirror re-sends all of video_costs; a re-send must add nothing."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self._tmpdir.name) / "costs.db")
        self.sync = SupabaseSync(url="https://demo.supabase.co", service_key="service-key-123")

    def tearDown(self):
        self.store.close()
        self._tmpdir.cleanup()

    def _cost(self, unit="gemini_input_tokens", quantity=100.0, recorded_at="2026-09-01T10:00:00+00:00", **kw):
        kw.setdefault("video_id", "v1")
        kw.setdefault("slug", "rome")
        kw.setdefault("stage", "script")
        self.store.record_video_cost(unit=unit, quantity=quantity, recorded_at=recorded_at, **kw)

    def _mirror(self, table):
        with patch("modules.supabase_sync.requests.post", side_effect=table.post):
            return self.sync.mirror_from_store(self.store)

    def test_mirroring_twice_leaves_the_same_row_count(self):
        self._cost()
        self._cost(unit="tts_characters", quantity=1200)
        table = FakeCostsTable()
        first = self._mirror(table)
        self.assertEqual((first["video_costs"], len(table.rows)), (2, 2))
        second = self._mirror(table)
        self.assertEqual(second["video_costs"], 2)  # re-sent, all ignored
        self.assertEqual(len(table.rows), 2)

    def test_a_row_recorded_between_runs_is_added_once(self):
        self._cost()
        table = FakeCostsTable()
        self._mirror(table)
        self._cost(unit="render_seconds", quantity=42.5, recorded_at="2026-09-02T10:00:00+00:00")
        self._mirror(table)
        self._mirror(table)
        self.assertEqual(len(table.rows), 2)

    # -- mirror_costs: what the queue worker sends after each job --

    def _costs_only(self, table, **kw):
        with patch("modules.supabase_sync.requests.post", side_effect=table.post):
            return self.sync.mirror_costs(self.store, **kw)

    def test_mirror_costs_sends_only_the_cost_table(self):
        # mirror_from_store would also upsert videos/topic rows from the worker's db
        # over the Actions poll's fresher copy; the worker must not do that.
        self.store.record_video(video_id="v1", title="T", topic="rome")
        self._cost()
        table = FakeCostsTable()
        self.assertEqual(self._costs_only(table), 1)
        self.assertEqual([p["url"].rsplit("/", 1)[-1] for p in table.posts], ["video_costs"])

    def test_mirror_costs_twice_and_overlapping_windows_add_nothing(self):
        self._cost(recorded_at="2026-09-01T10:00:00+00:00")
        self._cost(unit="video_gen_clips", quantity=1, stage="broll:kling", recorded_at="2026-09-02T10:00:00+00:00")
        self._cost(unit="video_gen_clips", quantity=1, stage="broll:kling", recorded_at="2026-09-02T10:00:00+00:00")
        table = FakeCostsTable()
        self._costs_only(table)
        self._costs_only(table, since_iso="2026-09-02T00:00:00+00:00")   # overlaps: same keys
        self._costs_only(table)
        self.assertEqual(len(table.rows), 3)
        self.assertEqual(len({r["row_key"] for r in table.rows}), 3)

    def test_since_sends_only_newer_rows_and_keeps_a_group_whole(self):
        self._cost(recorded_at="2026-09-01T10:00:00+00:00")
        self._cost(unit="video_gen_clips", quantity=1, stage="broll:kling", recorded_at="2026-09-02T10:00:00+00:00")
        self._cost(unit="video_gen_clips", quantity=1, stage="broll:kling", recorded_at="2026-09-02T10:00:00+00:00")
        table = FakeCostsTable()
        self.assertEqual(self._costs_only(table, since_iso="2026-09-02T00:00:00+00:00"), 2)
        self.assertEqual(len(table.rows), 2)

    def test_mirror_costs_never_raises_and_a_later_call_catches_up(self):
        self._cost()
        down = FakeCostsTable(fail_after=0)
        self.assertEqual(self._costs_only(down), 0)
        unmigrated = FakeCostsTable(migrated=False)
        self.assertEqual(self._costs_only(unmigrated), 0)
        self.assertEqual(unmigrated.rows, [])           # nothing inserted without its row_key
        broken = MagicMock()
        broken.list_video_costs.side_effect = RuntimeError("disk gone")
        self.assertEqual(self.sync.mirror_costs(broken), 0)
        table = FakeCostsTable()
        self.assertEqual(self._costs_only(table), 1)

    def test_customer_channels_rows_carry_no_usd_but_keep_units_and_stage(self):
        self._cost(unit="tts_characters", quantity=500, channel_id="ours", estimated_usd=0.5)
        self._cost(unit="video_gen_clips", quantity=2, channel_id="theirs", estimated_usd=3.2, stage="broll:kling")
        table = FakeCostsTable()
        self._costs_only(table, is_operator=lambda cid: cid == "ours")
        by_channel = {r["channel_id"]: r for r in table.rows}
        self.assertEqual(by_channel["ours"]["estimated_usd"], 0.5)
        self.assertIsNone(by_channel["theirs"]["estimated_usd"])
        self.assertEqual((by_channel["theirs"]["unit"], by_channel["theirs"]["quantity"], by_channel["theirs"]["stage"]),
                         ("video_gen_clips", 2, "broll:kling"))
        # the local ledger is untouched
        self.assertEqual({r["channel_id"]: r["estimated_usd"] for r in self.store.list_video_costs()},
                         {"ours": 0.5, "theirs": 3.2})

    def test_without_an_operator_test_no_usd_is_sent(self):
        self._cost(estimated_usd=1.0, channel_id="ours")
        table = FakeCostsTable()
        self._costs_only(table)
        self.assertEqual([r["estimated_usd"] for r in table.rows], [None])

    def test_mirror_video_costs_itself_is_default_deny_with_no_policy(self):
        # The private sender is the one place a USD figure leaves the machine. Called with no policy at all (a
        # future caller that forgets one) it must still send units and stages but never a provider's price, and
        # a channel-less row (blank channel_id) is not "the operator's" by omission either.
        self._cost(estimated_usd=1.0, channel_id="ours")
        self._cost(unit="tts_characters", quantity=300, estimated_usd=2.0, channel_id="")
        table = FakeCostsTable()
        with patch("modules.supabase_sync.requests.post", side_effect=table.post):
            sent = self.sync._mirror_video_costs(self.store)
        self.assertEqual(sent, 2)
        self.assertEqual(len(table.rows), 2)
        self.assertEqual({r["estimated_usd"] for r in table.rows}, {None})
        self.assertEqual({r["unit"] for r in table.rows}, {"gemini_input_tokens", "tts_characters"})
        # the local ledger keeps what was paid
        self.assertEqual(sorted(r["estimated_usd"] for r in self.store.list_video_costs()), [1.0, 2.0])

    def test_a_channel_that_cannot_be_looked_up_is_skipped_not_sent_without_usd(self):
        # ignore-duplicates would lock a wrongly-NULL row in forever: wait until it can be decided
        self._cost(estimated_usd=1.0, channel_id="ours")
        self._cost(unit="tts_characters", estimated_usd=2.0, channel_id="theirs")
        registry_up = {"ok": False}

        def is_operator(cid):
            if not registry_up["ok"]:
                raise RuntimeError("registry down")
            return cid == "ours"

        table = FakeCostsTable()
        self.assertEqual(self._costs_only(table, is_operator=is_operator), 0)
        self.assertEqual(table.rows, [])
        registry_up["ok"] = True
        self._costs_only(table, is_operator=is_operator)
        self.assertEqual(sorted((r["channel_id"], r["estimated_usd"]) for r in table.rows),
                         [("ours", 1.0), ("theirs", None)])

    def test_mirror_from_store_the_actions_path_also_hides_customer_usd(self):
        self._cost(estimated_usd=1.0, channel_id="ours")
        self._cost(unit="tts_characters", estimated_usd=2.0, channel_id="theirs")
        table = FakeCostsTable()
        with patch("modules.supabase_sync.requests.post", side_effect=table.post):
            self.sync.mirror_from_store(self.store, is_operator=lambda cid: cid == "ours")
        self.assertEqual(sorted((r["channel_id"], r["estimated_usd"]) for r in table.rows),
                         [("ours", 1.0), ("theirs", None)])
        table = FakeCostsTable()
        with patch("modules.supabase_sync.requests.post", side_effect=table.post):
            self.sync.mirror_from_store(self.store)             # no test given: nobody's USD
        self.assertEqual({r["estimated_usd"] for r in table.rows}, {None})

    def test_hiding_the_usd_does_not_change_the_row_keys(self):
        self._cost(estimated_usd=1.0, channel_id="ours")
        shown, hidden = FakeCostsTable(), FakeCostsTable()
        self._costs_only(shown, is_operator=lambda cid: True)
        self._costs_only(hidden)
        self.assertEqual([r["row_key"] for r in shown.rows], [r["row_key"] for r in hidden.rows])

    def test_mirror_costs_is_off_without_credentials(self):
        self._cost()
        self.assertEqual(SupabaseSync(url="", service_key="").mirror_costs(self.store), 0)

    def test_two_genuinely_identical_rows_stay_two_across_runs(self):
        # one flush of the ledger can record two equal entries (two clips, same stage)
        self._cost(unit="video_gen_clips", quantity=1, stage="broll:minimax")
        self._cost(unit="video_gen_clips", quantity=1, stage="broll:minimax")
        table = FakeCostsTable()
        self._mirror(table)
        self._mirror(table)
        self.assertEqual(len(table.rows), 2)
        self.assertEqual(len({r["row_key"] for r in table.rows}), 2)

    def test_rows_sent_carry_a_row_key_and_no_local_id(self):
        self._cost()
        table = FakeCostsTable()
        self._mirror(table)
        row = table.rows[0]
        self.assertNotIn("id", row)
        self.assertTrue(row["row_key"].startswith("v1:") and len(row["row_key"]) == 3 + 64)
        self.assertEqual((row["unit"], row["quantity"], row["slug"]), ("gemini_input_tokens", 100.0, "rome"))

    def test_the_failure_path_a_database_without_the_migration_inserts_nothing(self):
        self._cost()
        self._cost(unit="tts_characters", quantity=5)
        table = FakeCostsTable(migrated=False)
        counts = self._mirror(table)
        cost_posts = [p for p in table.posts if p["url"].endswith("/video_costs")]
        self.assertEqual(counts["video_costs"], 0)
        self.assertEqual(len(cost_posts), 1, "no second attempt, no fallback to a plain insert")
        self.assertEqual(table.rows, [])
        # the other tables are still mirrored: one table skipped, not the run
        self.assertIn("system_events", counts)

    def test_the_failure_is_logged_and_the_next_run_after_the_migration_catches_up(self):
        self._cost()
        table = FakeCostsTable(migrated=False)
        with self.assertLogs("modules.supabase_sync", level="WARNING") as logs:
            self._mirror(table)
        self.assertTrue(any("0106" in line for line in logs.output), logs.output)
        table.migrated = True
        self._mirror(table)
        self._mirror(table)
        self.assertEqual(len(table.rows), 1)

    def test_the_missing_index_is_also_a_migration_problem(self):
        self._cost()
        table = FakeCostsTable(migrated=False, missing_code="42P10")
        with self.assertLogs("modules.supabase_sync", level="WARNING") as logs:
            counts = self._mirror(table)
        self.assertEqual(counts["video_costs"], 0)
        self.assertTrue(any("0106" in line and "42P10" in line for line in logs.output), logs.output)

    def test_history_is_sent_in_chunks_and_a_rerun_adds_nothing(self):
        for i in range(5):
            self._cost(quantity=float(i + 1))
        table = FakeCostsTable()
        with patch("modules.supabase_sync._VIDEO_COSTS_CHUNK", 2):
            first = self._mirror(table)
            self._mirror(table)
        sizes = [p["n"] for p in table.posts if p["url"].endswith("/video_costs")]
        self.assertEqual(sizes, [2, 2, 1, 2, 2, 1])
        self.assertEqual((first["video_costs"], len(table.rows)), (5, 5))

    def test_a_failed_chunk_is_not_called_a_missing_migration_and_the_next_run_finishes(self):
        for i in range(5):
            self._cost(quantity=float(i + 1))
        table = FakeCostsTable(fail_after=1)
        with patch("modules.supabase_sync._VIDEO_COSTS_CHUNK", 2):
            with self.assertLogs("modules.supabase_sync", level="WARNING") as logs:
                counts = self._mirror(table)
            self.assertEqual(counts["video_costs"], 2, "only the chunk that went through is counted")
            self.assertEqual(len(table.rows), 2)
            text = " ".join(logs.output)
            self.assertIn("stopped after 2 of 5", text)
            self.assertIn("not a missing migration", text)
            self.assertNotIn("0106", text)
            table.fail_after = None
            self._mirror(table)
        self.assertEqual(len(table.rows), 5)

    def test_a_timeout_is_not_called_a_missing_migration(self):
        self._cost()
        with patch("modules.supabase_sync.requests.post", side_effect=TimeoutError("slow")):
            with self.assertLogs("modules.supabase_sync", level="WARNING") as logs:
                self.sync.mirror_from_store(self.store)
        text = " ".join(logs.output)
        self.assertIn("not a missing migration", text)
        self.assertNotIn("0106", text)

    def test_a_network_error_sends_nothing_and_does_not_raise(self):
        self._cost()
        with patch("modules.supabase_sync.requests.post", side_effect=RuntimeError("down")):
            counts = self.sync.mirror_from_store(self.store)
        self.assertEqual(counts["video_costs"], 0)

    def test_no_costs_means_no_request_for_the_table(self):
        table = FakeCostsTable()
        counts = self._mirror(table)
        self.assertEqual(counts["video_costs"], 0)
        self.assertFalse([p for p in table.posts if p["url"].endswith("/video_costs")])


class VideoCostRowKeyTestCase(unittest.TestCase):
    BASE = {"channel_id": "default", "video_id": "v1", "slug": "rome", "unit": "tts_characters",
            "stage": "tts", "recorded_at": "2026-09-01T10:00:00+00:00", "quantity": 1200.0}

    def key(self, **over):
        return video_cost_row_key({**self.BASE, **over})

    def test_key_is_stable(self):
        self.assertEqual(self.key(), self.key())
        # the local id and the estimate are not part of the identity
        self.assertEqual(self.key(), video_cost_row_key({**self.BASE, "id": 99, "estimated_usd": 0.5}))
        # pinned value: changing it re-keys history, which would duplicate every row once
        self.assertEqual(
            self.key(),
            "v1:" + hashlib.sha256(
                "default\x1fv1\x1frome\x1ftts_characters\x1ftts\x1f2026-09-01T10:00:00+00:00\x1f1200\x1f0".encode()
            ).hexdigest(),
        )

    def test_key_differs_when_any_keyed_field_differs(self):
        keys = {self.key()}
        for over in ({"channel_id": "other"}, {"video_id": "v2"}, {"slug": "paris"}, {"unit": "render_seconds"},
                     {"stage": "voice"}, {"recorded_at": "2026-09-01T10:00:01+00:00"}, {"quantity": 1200.5}):
            keys.add(self.key(**over))
        self.assertEqual(len(keys), 8)

    def test_key_differs_by_occurrence(self):
        self.assertNotEqual(video_cost_row_key(self.BASE, 0), video_cost_row_key(self.BASE, 1))

    def test_equal_quantities_read_the_same_however_they_are_written(self):
        self.assertEqual(self.key(quantity=1200), self.key(quantity=1200.0))
        self.assertEqual(self.key(quantity="1200"), self.key(quantity=1200.0))
        self.assertEqual(self.key(quantity=1e-05), self.key(quantity=0.00001))

    def test_canonical_quantity(self):
        for value, text in ((1200.0, "1200"), (0, "0"), (2.5, "2.5"), (0.00001, "0.00001"), (1e20, "100000000000000000000"),
                            (0.1, "0.1"), (123456.789, "123456.789")):
            self.assertEqual(_canonical_quantity(value), text)

    def test_null_and_empty_read_the_same(self):
        self.assertEqual(self.key(stage=None), self.key(stage=""))

    def test_fields_cannot_run_into_each_other(self):
        self.assertNotEqual(self.key(slug="a", unit="bc"), self.key(slug="ab", unit="c"))

    def test_shared_vectors_match_what_the_owner_sql_script_writes(self):
        # tests/security/test_sec_provider_spend.py runs docs/sql/dedupe-video-costs.sql
        # against the same file and requires the same keys: one definition, two implementations.
        vectors = json.loads((Path(__file__).parent / "fixtures" / "video_cost_keys.txt").read_text("utf-8"))
        self.assertGreaterEqual(len(vectors), 15)
        for v in vectors:
            self.assertEqual(video_cost_row_key(v["row"], 0), v["row_key"], v["row"])
        self.assertEqual(len({v["row_key"] for v in vectors}), len(vectors))

    def test_occurrence_index_follows_local_id_order(self):
        a = dict(self.BASE, id=7)
        b = dict(self.BASE, id=3)
        other = dict(self.BASE, id=5, unit="render_seconds")
        out = video_cost_rows_with_keys([a, other, b])
        by_id = {}
        for src, row in zip(sorted([a, other, b], key=lambda r: r["id"]), out):
            by_id[src["id"]] = row["row_key"]
        self.assertEqual(by_id[3], video_cost_row_key(self.BASE, 0))
        self.assertEqual(by_id[7], video_cost_row_key(self.BASE, 1))
        self.assertEqual(by_id[5], video_cost_row_key(other, 0))
        # same keys whatever order the store hands the rows over in
        again = video_cost_rows_with_keys([b, a, other])
        self.assertEqual({r["row_key"] for r in out}, {r["row_key"] for r in again})
        self.assertTrue(all("id" not in r for r in out))


if __name__ == "__main__":
    unittest.main()


class MirrorPlannerAndRunsTestCase(unittest.TestCase):
    """The Phase 4 step-1 observability mirror: ContentPlanner's queue and
    PipelineStateMachine's runs. Uses the real classes against tempdir JSON so
    the row shaping is exercised end to end; requests.post is mocked."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.sync = SupabaseSync(url="https://demo.supabase.co", service_key="service-key-123")

    def tearDown(self):
        self._tmpdir.cleanup()

    def _ok_response(self):
        resp = MagicMock()
        resp.status_code = 201
        resp.text = ""
        return resp

    def _planner(self):
        from modules.content_planner import ContentPlanner

        return ContentPlanner(store_path=self.tmp / "content_calendar.json")

    def _machine(self):
        from modules.pipeline_stages import PipelineStateMachine

        return PipelineStateMachine(store_path=self.tmp / "pipeline_runs.json")

    def test_disabled_returns_empty(self):
        sync = SupabaseSync(url="", service_key="")
        self.assertEqual(sync.mirror_planner_and_runs(), {})

    def test_mirrors_queue_and_runs(self):
        planner = self._planner()
        planner.enqueue("Ancient Egypt", source="manual", rationale="operator pick")
        machine = self._machine()
        machine.start_run("Ancient Egypt")

        with patch("modules.supabase_sync.requests.post", return_value=self._ok_response()) as post:
            counts = self.sync.mirror_planner_and_runs(planner=planner, machine=machine)

        self.assertEqual(counts.get("content_queue"), 1)
        self.assertEqual(counts.get("pipeline_runs"), 1)

        posted = {}
        for call in post.call_args_list:
            url = call.args[0] if call.args else call.kwargs.get("url", "")
            posted[url.rsplit("/", 1)[-1]] = call.kwargs["json"]

        queue_row = posted["content_queue"][0]
        self.assertEqual(queue_row["topic"], "Ancient Egypt")
        self.assertEqual(queue_row["status"], "queued")
        self.assertEqual(queue_row["source"], "manual")

        run_row = posted["pipeline_runs"][0]
        self.assertEqual(run_row["topic"], "Ancient Egypt")
        # The audit-trail flag is mirrored as-is; nothing gates publishing on it.
        self.assertFalse(run_row["human_approved"])
        # started_at / updated_at come from real transitions, not a fresh clock.
        self.assertIsNotNone(run_row["started_at"])
        self.assertEqual(run_row["started_at"], run_row["history"][0]["timestamp"])

    def test_approved_run_carries_its_audit_fields(self):
        from modules.pipeline_stages import PipelineStage

        machine = self._machine()
        run = machine.start_run("Roman Empire")
        # approve() is only legal at HUMAN_APPROVAL, so walk the real stages.
        for stage in (
            PipelineStage.RESEARCH,
            PipelineStage.SCRIPT,
            PipelineStage.FACT_CHECK,
            PipelineStage.HUMAN_APPROVAL,
        ):
            machine.advance(run.run_id, stage)
        machine.approve(run.run_id, approved_by="ruslan")

        with patch("modules.supabase_sync.requests.post", return_value=self._ok_response()) as post:
            self.sync.mirror_planner_and_runs(planner=self._planner(), machine=machine)

        run_rows = [
            call.kwargs["json"]
            for call in post.call_args_list
            if (call.args[0] if call.args else "").endswith("pipeline_runs")
        ][0]
        self.assertTrue(run_rows[0]["human_approved"])
        self.assertEqual(run_rows[0]["approved_by"], "ruslan")
        self.assertIsNotNone(run_rows[0]["approved_at"])

    def test_planner_failure_does_not_block_runs_mirror(self):
        broken = MagicMock()
        broken.list_entries.side_effect = RuntimeError("disk gone")
        machine = self._machine()
        machine.start_run("Topic")

        with patch("modules.supabase_sync.requests.post", return_value=self._ok_response()):
            counts = self.sync.mirror_planner_and_runs(planner=broken, machine=machine)

        # The queue read failed, but the runs still mirrored — and nothing raised.
        self.assertNotIn("content_queue", counts)
        self.assertEqual(counts.get("pipeline_runs"), 1)

    def test_empty_state_mirrors_nothing_without_error(self):
        with patch("modules.supabase_sync.requests.post") as post:
            counts = self.sync.mirror_planner_and_runs(planner=self._planner(), machine=self._machine())
        post.assert_not_called()
        self.assertEqual(counts.get("content_queue"), 0)
        self.assertEqual(counts.get("pipeline_runs"), 0)


class RpcStrictTestCase(unittest.TestCase):
    """rpc_strict: one database function with the service key, for the operator bot's read of the poster (0109)."""

    def _sync(self):
        return SupabaseSync(url="https://x.supabase.test", service_key="service-key-value")

    def test_it_posts_to_the_function_with_the_service_key_and_returns_the_json(self):
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"ok": True}
        with patch("modules.supabase_sync.requests.post", return_value=resp) as post:
            self.assertEqual(self._sync().rpc_strict("operator_marketing_summary"), {"ok": True})
        url = post.call_args.args[0]
        self.assertEqual(url, "https://x.supabase.test/rest/v1/rpc/operator_marketing_summary")
        self.assertEqual(post.call_args.kwargs["json"], {})
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer service-key-value")

    def test_a_function_the_database_does_not_have_yet_is_told_apart_from_an_outage(self):
        from modules.supabase_sync import SupabaseReadError

        for status, code, missing in ((404, "PGRST202", True), (404, "42883", True), (500, "XX000", False), (401, "", False)):
            resp = MagicMock(status_code=status)
            resp.json.return_value = {"code": code, "message": "service-key-value leaked"}
            with patch("modules.supabase_sync.requests.post", return_value=resp):
                with self.assertRaises(SupabaseReadError) as e:
                    self._sync().rpc_strict("operator_marketing_summary")
            self.assertEqual(e.exception.function_missing, missing, (status, code))
            self.assertFalse(e.exception.table_missing)
            self.assertNotIn("service-key-value", str(e.exception))
            self.assertNotIn("leaked", str(e.exception))

    def test_a_network_error_or_an_unreadable_answer_raises_a_read_error_without_the_text(self):
        from modules.supabase_sync import SupabaseReadError

        with patch("modules.supabase_sync.requests.post", side_effect=RuntimeError("https://x.supabase.test?key=service-key-value")):
            with self.assertRaises(SupabaseReadError) as e:
                self._sync().rpc_strict("operator_marketing_summary")
        self.assertNotIn("service-key-value", str(e.exception) + e.exception.detail)
        resp = MagicMock(status_code=200)
        resp.json.side_effect = ValueError("not json")
        with patch("modules.supabase_sync.requests.post", return_value=resp):
            with self.assertRaises(SupabaseReadError):
                self._sync().rpc_strict("operator_marketing_summary")

    def test_a_name_that_is_not_a_plain_function_name_is_refused_before_any_request(self):
        for name in ("", "Op", "a-b", "a/b", "../rest/v1/x", "a?b=1", "1a", None):
            with patch("modules.supabase_sync.requests.post") as post:
                with self.assertRaises(ValueError, msg=name):
                    self._sync().rpc_strict(name)
            post.assert_not_called()

    def test_disabled_makes_no_call(self):
        with patch("modules.supabase_sync.requests.post") as post:
            self.assertIsNone(SupabaseSync(url="", service_key="").rpc_strict("operator_marketing_summary"))
        post.assert_not_called()
