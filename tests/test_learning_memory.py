"""Learning memory (modules/learning_memory.py) — proposals and the approval gate.

The contract these tests pin:

* a proposal is made only from a real signal past its source's own evidence
  floor, and carries that evidence;
* the bot never overwrites a row a human decided (insert ignores duplicates,
  refresh is filtered on status=pending);
* ONLY approved learnings reach a prompt — pending, rejected and another
  channel's rows never do, even if a query filter were to let them through;
* nothing here raises into the poll or the pipeline.
"""

import unittest
from unittest.mock import MagicMock, patch

from modules import learning_memory as lm
from modules import experiments as ex
from modules.retention_analyzer import RetentionInsight


class FakeSync:
    """In-memory stand-in for SupabaseSync's select / upsert / update."""

    def __init__(self, rows=None, enabled=True, raise_on=()):
        self.rows = list(rows or [])
        self.enabled = enabled
        self.raise_on = set(raise_on)
        self.selects, self.upserts, self.updates = [], [], []

    def select(self, table, params=None):
        self.selects.append((table, params))
        if "select" in self.raise_on:
            raise RuntimeError("network down")
        return [dict(r) for r in self.rows]

    def upsert(self, table, rows, on_conflict=None, ignore_duplicates=False):
        self.upserts.append((table, rows, on_conflict, ignore_duplicates))
        return len(rows)

    def update(self, table, filters, values):
        self.updates.append((table, filters, values))
        return True


def _topic_row(topic, score, videos=2, reason="2 video(s); view velocity 1.60x channel avg"):
    return {"topic": topic, "score": score, "videos_analyzed": videos, "reason": reason,
            "avg_views_per_day": 120.0, "updated_at": "2026-09-20"}


def _insight(vid, hook, cliff_at=None, cliff_drop=None):
    return RetentionInsight(video_id=vid, hook_retention=hook, cliff_at=cliff_at,
                            cliff_drop=cliff_drop, points=20)


class TopicProposalTests(unittest.TestCase):
    def test_strong_and_weak_topics_are_proposed_average_ones_are_not(self):
        props = lm.topic_proposals([
            _topic_row("Roman roads", 80),
            _topic_row("Bronze age trade", 50),
            _topic_row("Medieval tax law", 25),
        ])
        keys = {p.dedup_key for p in props}
        self.assertEqual(keys, {"topic:strong:roman roads", "topic:weak:medieval tax law"})
        strong = next(p for p in props if "strong" in p.dedup_key)
        self.assertEqual(strong.kind, lm.KIND_TOPIC)
        self.assertEqual(strong.evidence["score"], 80.0)
        self.assertEqual(strong.evidence["source"], "channel_topic_performance")
        self.assertIn("Roman roads", strong.observation)

    def test_direction_is_part_of_the_key_so_a_flip_is_a_new_proposal(self):
        [a] = lm.topic_proposals([_topic_row("Rome", 90)])
        [b] = lm.topic_proposals([_topic_row("Rome", 10)])
        self.assertNotEqual(a.dedup_key, b.dedup_key)

    def test_unknown_sample_size_gives_unknown_confidence_not_zero(self):
        [p] = lm.topic_proposals([_topic_row("Rome", 90, videos=None)])
        self.assertIsNone(p.confidence)
        [q] = lm.topic_proposals([_topic_row("Rome", 90, videos=3)])
        self.assertEqual(q.confidence, 0.5)

    def test_rows_without_a_score_or_topic_are_skipped(self):
        self.assertEqual(lm.topic_proposals([{"topic": "X", "score": None}, {"score": 99}, None]), [])


class RetentionProposalTests(unittest.TestCase):
    def test_below_the_curve_floor_nothing_is_proposed(self):
        self.assertEqual(lm.retention_proposals([_insight("a", 0.3), _insight("b", 0.3)]), [])

    def test_weak_hook_is_proposed_with_its_videos_as_evidence(self):
        props = lm.retention_proposals([_insight("a", 0.5), _insight("b", 0.6), _insight("c", 0.55)])
        [hook] = [p for p in props if p.kind == lm.KIND_HOOK]
        self.assertEqual(hook.dedup_key, "hook:weak")
        self.assertEqual([v["video_id"] for v in hook.evidence["videos"]], ["a", "b", "c"])

    def test_strong_hook_is_not_a_learning(self):
        props = lm.retention_proposals([_insight("a", 0.9), _insight("b", 0.85), _insight("c", 0.8)])
        self.assertEqual([p for p in props if p.kind == lm.KIND_HOOK], [])

    def test_a_clustered_cliff_is_proposed_scattered_ones_are_not(self):
        clustered = lm.retention_proposals([
            _insight("a", 0.9, 0.42, 0.15),
            _insight("b", 0.9, 0.47, 0.12),
            _insight("c", 0.9, 0.81, 0.10),
        ])
        [cliff] = [p for p in clustered if p.kind == lm.KIND_RETENTION]
        self.assertEqual(cliff.dedup_key, "retention:cliff:40")
        self.assertEqual(cliff.evidence["window"], [0.4, 0.5])

        # 0.3 / 0.1 is 2.999... in floating point; a cliff at exactly 30% must
        # still land in the 30-40% window.
        edge = lm.retention_proposals([
            _insight("a", 0.9, 0.3, 0.15),
            _insight("b", 0.9, 0.3, 0.12),
            _insight("c", 0.9, 0.9, 0.10),
        ])
        [cliff] = [p for p in edge if p.kind == lm.KIND_RETENTION]
        self.assertEqual(cliff.dedup_key, "retention:cliff:30")

        scattered = lm.retention_proposals([
            _insight("a", 0.9, 0.12, 0.15),
            _insight("b", 0.9, 0.47, 0.12),
            _insight("c", 0.9, 0.81, 0.10),
        ])
        self.assertEqual([p for p in scattered if p.kind == lm.KIND_RETENTION], [])


class ExperimentProposalTests(unittest.TestCase):
    """Decided experiments (modules/experiments.py) become pending learnings."""

    def _thumb_rows(self, ctr_a, ctr_b, extra_c=0):
        videos, snaps = [], []
        for arm, ctr, n in (("A", ctr_a, 6), ("B", ctr_b, 7), ("C", 0.02, extra_c)):
            for i in range(n):
                vid = f"{arm}{i}"
                videos.append({"video_id": vid, "thumbnail_variant": arm})
                snaps.append({"video_id": vid, "snapshot_date": "2026-09-01",
                              "impression_ctr": ctr, "impressions": 100})
        return videos, snaps

    def _hook_rows(self, sec_a, sec_b):
        videos, snaps = [], []
        for arm, sec, n in (("A", sec_a, 5), ("B", sec_b, 6)):
            for i in range(n):
                vid = f"h{arm}{i}"
                videos.append({"video_id": vid, "hook_variant": arm})
                snaps.append({"video_id": vid, "snapshot_date": "2026-09-01",
                              "average_view_duration_seconds": sec})
        return videos, snaps

    def test_running_and_inconclusive_experiments_propose_nothing(self):
        tv, ts = self._thumb_rows(0.050, 0.051)            # under the lift floor
        hv, hs = self._hook_rows(100.0, 150.0)
        hv = hv[:3]                                        # hook still running
        exps = [ex.thumbnail_experiment(tv, ts), ex.hook_experiment(hv, hs)]
        self.assertEqual([e.status for e in exps], [ex.STATUS_INCONCLUSIVE, ex.STATUS_RUNNING])
        self.assertEqual(lm.experiment_proposals(exps), [])

    def test_decided_experiments_are_proposed_under_the_existing_keys(self):
        tv, ts = self._thumb_rows(0.05, 0.06, extra_c=1)
        hv, hs = self._hook_rows(100.0, 130.0)
        props = lm.experiment_proposals([
            ex.thumbnail_experiment(tv, ts, ("A", "B", "C")),
            ex.hook_experiment(hv, hs),
        ])
        # Same key shape as before the Experiment view existed, so a learning
        # already decided on is not proposed again.
        self.assertEqual({p.dedup_key for p in props}, {"experiment:thumbnail:b", "experiment:hook:b"})
        thumb = next(p for p in props if "thumbnail" in p.dedup_key)
        # Confidence is weighed on the arms the verdict used — C (1 video)
        # took no part in it and must not drag it down.
        self.assertEqual(thumb.confidence, lm.sample_confidence(6))
        self.assertEqual(len(thumb.evidence["variants"]), 3)
        self.assertEqual(thumb.evidence["metric"], "impression_ctr")
        hook = next(p for p in props if "hook" in p.dedup_key)
        self.assertIn("alternate opening", hook.observation)
        self.assertAlmostEqual(hook.evidence["effect"], 0.3, places=4)


class SaveProposalTests(unittest.TestCase):
    def _props(self):
        return [
            lm.Proposal(lm.KIND_TOPIC, "topic:strong:rome", "Rome did well", {"score": 80}, 0.5),
            lm.Proposal(lm.KIND_TOPIC, "topic:weak:tax", "Tax did badly", {"score": 20}, 0.5),
            lm.Proposal(lm.KIND_HOOK, "hook:weak", "Hook is weak", {"mean": 0.5}, 0.5),
            lm.Proposal(lm.KIND_RETENTION, "retention:cliff:40", "Cliff at 40%", {}, 0.5),
        ]

    def test_decided_rows_are_never_reinserted_or_patched(self):
        sync = FakeSync(rows=[
            {"dedup_key": "topic:strong:rome", "status": "approved"},
            {"dedup_key": "topic:weak:tax", "status": "rejected"},
            {"dedup_key": "hook:weak", "status": "pending"},
        ])
        summary = lm.save_proposals("history", self._props(), sync=sync)

        [(table, rows, conflict, ignore)] = sync.upserts
        self.assertEqual(table, "learnings")
        self.assertTrue(ignore, "the insert must ignore duplicates, never merge over a decision")
        self.assertEqual(conflict, "channel_id,dedup_key")
        self.assertEqual([r["dedup_key"] for r in rows], ["retention:cliff:40"])
        self.assertTrue(all(r["status"] == "pending" and r["channel_id"] == "history" for r in rows))

        # Only the still-pending row is refreshed, and the PATCH itself is
        # filtered on status=pending so a decision made meanwhile survives.
        [(_, filters, values)] = sync.updates
        self.assertEqual(filters["dedup_key"], "eq.hook:weak")
        self.assertEqual(filters["status"], "eq.pending")
        self.assertEqual(filters["channel_id"], "eq.history")
        self.assertNotIn("status", values)
        self.assertEqual(summary, {"proposed": 1, "refreshed": 1})

    def test_disabled_sync_is_a_no_op(self):
        sync = FakeSync(enabled=False)
        self.assertEqual(lm.save_proposals("history", self._props(), sync=sync), {"proposed": 0, "refreshed": 0})
        self.assertEqual(sync.upserts, [])

    def test_a_failing_read_never_raises(self):
        sync = FakeSync(raise_on={"select"})
        self.assertEqual(lm.save_proposals("history", self._props(), sync=sync), {"proposed": 0, "refreshed": 0})

    def test_propose_survives_a_broken_store(self):
        store = MagicMock()
        store.list_channel_topic_performance.side_effect = RuntimeError("db locked")
        store.list_videos.side_effect = RuntimeError("db locked")
        summary = lm.propose("history", store=store, sync=FakeSync())
        self.assertEqual(summary["candidates"], 0)


class ApprovedPromptTests(unittest.TestCase):
    def _rows(self):
        return [
            {"kind": "hook", "observation": "Approved hook lesson", "status": "approved", "channel_id": "history"},
            {"kind": "hook", "observation": "Pending hook lesson", "status": "pending", "channel_id": "history"},
            {"kind": "hook", "observation": "Rejected hook lesson", "status": "rejected", "channel_id": "history"},
            {"kind": "hook", "observation": "Other channel lesson", "status": "approved", "channel_id": "finance"},
            {"kind": "topic", "observation": "Approved topic lesson", "status": "approved", "channel_id": "history"},
        ]

    def test_only_approved_rows_of_this_channel_and_kind_reach_the_prompt(self):
        # The fake returns every row regardless of filters — the belt-and-braces
        # re-check must still keep everything but the approved one out.
        sync = FakeSync(rows=self._rows())
        text = lm.approved_learnings_as_prompt_text("history", lm.SCRIPT_PROMPT_KINDS, sync=sync)
        self.assertIn("Approved hook lesson", text)
        for absent in ("Pending", "Rejected", "Other channel", "Approved topic lesson"):
            self.assertNotIn(absent, text)
        [(_, params)] = sync.selects
        self.assertEqual(params["status"], "eq.approved")
        self.assertEqual(params["channel_id"], "eq.history")

    def test_nothing_approved_means_no_prompt_text(self):
        sync = FakeSync(rows=[r for r in self._rows() if r["status"] != "approved"])
        self.assertEqual(lm.approved_learnings_as_prompt_text("history", sync=sync), "")

    def test_failures_and_disabled_sync_give_empty_text(self):
        self.assertEqual(lm.approved_learnings_as_prompt_text("history", sync=FakeSync(enabled=False)), "")
        self.assertEqual(lm.approved_learnings_as_prompt_text("history", sync=FakeSync(raise_on={"select"})), "")
        self.assertEqual(lm.approved_learnings_as_prompt_text("", sync=FakeSync(rows=self._rows())), "")


class PromptWiringTests(unittest.TestCase):
    """The approved block reaches the script prompt; a pending one does not."""

    _PAYLOAD = (
        '{"title": "T", "title_ab": "TA", "description": "D", "tags": [], '
        '"hook_sentence": "H", "thumbnail_prompt_a": "A", "thumbnail_prompt_b": "B", '
        '"thumbnail_overlay_text": "O", "open_loops": [], "sections": []}'
    )

    def _script_prompt(self, rows):
        from modules.script_engine import ScriptEngine

        response = MagicMock()
        response.text = self._PAYLOAD
        quiet = MagicMock()
        quiet.analyze_videos_as_prompt_text.return_value = ""
        quiet.as_prompt_text.return_value = ""
        with patch("modules.script_engine.make_client", return_value=MagicMock()), \
             patch("modules.script_engine.PerformanceAnalyzer", return_value=quiet), \
             patch("modules.retention_analyzer.RetentionAnalyzer", return_value=quiet), \
             patch("modules.supabase_sync.SupabaseSync", return_value=FakeSync(rows=rows)), \
             patch("modules.script_engine.generate_with_retry", return_value=response) as gen:
            ScriptEngine().generate("The Fall of Constantinople")
        return gen.call_args[0][2]

    def test_approved_learning_is_in_the_script_prompt(self):
        prompt = self._script_prompt([
            {"kind": "retention", "observation": "Put a reveal at 40%", "status": "approved", "channel_id": "default"},
        ])
        self.assertIn("Approved learnings for this channel", prompt)
        self.assertIn("Put a reveal at 40%", prompt)

    def test_pending_learning_changes_nothing(self):
        prompt = self._script_prompt([
            {"kind": "retention", "observation": "Put a reveal at 40%", "status": "pending", "channel_id": "default"},
        ])
        self.assertNotIn("Put a reveal at 40%", prompt)
        self.assertNotIn("Approved learnings", prompt)


if __name__ == "__main__":
    unittest.main()
