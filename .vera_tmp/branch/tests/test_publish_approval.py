"""Two-person publish approval — the pipeline guard (modules/publish_approval).

These are written as the guard's safety contract: it authorises a public run
ONLY on a genuine, matching approval, and every other case — including any
failure — resolves to "not approved" so a check can never let a video go public.
"""

import unittest

from modules import publish_approval
from modules.channels import AgentConfig


class FakeSync:
    """A stand-in SupabaseSync: `enabled` and a `select` that returns canned
    rows (or raises, to prove the guard fails safe)."""

    def __init__(self, rows, enabled=True, raise_on_select=False):
        self._rows = rows
        self.enabled = enabled
        self._raise = raise_on_select
        self.calls = []

    def select(self, table, params=None):
        self.calls.append((table, params))
        if self._raise:
            raise RuntimeError("boom")
        return self._rows


def _row(video_ref="my-slug", decided_by="admin-2", requested_by="admin-1"):
    return {
        "video_ref": video_ref,
        "decided_by": decided_by,
        "requested_by": requested_by,
    }


class TestHasApproved(unittest.TestCase):
    def test_disabled_sync_is_not_approved(self):
        sync = FakeSync([_row()], enabled=False)
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_no_rows_is_not_approved(self):
        sync = FakeSync([])
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_matching_slug_is_approved(self):
        sync = FakeSync([_row(video_ref="my-slug")])
        self.assertTrue(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_matching_topic_is_approved_case_insensitively(self):
        sync = FakeSync([_row(video_ref="The Lost City")])
        self.assertTrue(
            publish_approval.has_approved("ch", slug="unrelated", topic="the lost city", sync=sync)
        )

    def test_null_video_ref_is_not_a_blanket_approval(self):
        # A null ref must never authorise every future public run.
        sync = FakeSync([_row(video_ref=None)])
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_non_matching_ref_is_not_approved(self):
        sync = FakeSync([_row(video_ref="some-other-video")])
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_same_person_decided_and_requested_is_rejected(self):
        # Defence in depth: the DB RLS already forbids it, but the guard also
        # refuses an approval whose decider is the requester.
        sync = FakeSync([_row(video_ref="my-slug", decided_by="x", requested_by="x")])
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_missing_decider_is_rejected(self):
        sync = FakeSync([_row(video_ref="my-slug", decided_by=None)])
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_no_slug_or_topic_is_not_approved(self):
        sync = FakeSync([_row(video_ref="my-slug")])
        self.assertFalse(publish_approval.has_approved("ch", sync=sync))

    def test_select_failure_fails_safe(self):
        sync = FakeSync([], raise_on_select=True)
        self.assertFalse(publish_approval.has_approved("ch", slug="my-slug", sync=sync))

    def test_query_scopes_to_channel_and_approved(self):
        sync = FakeSync([_row()])
        publish_approval.has_approved("chan-42", slug="my-slug", sync=sync)
        _, params = sync.calls[0]
        self.assertEqual(params.get("channel_id"), "eq.chan-42")
        self.assertEqual(params.get("status"), "eq.approved")


class TestAgentConfigFlag(unittest.TestCase):
    def test_absent_defaults_to_false(self):
        self.assertFalse(AgentConfig.from_dict({}).require_two_person_publish)

    def test_only_explicit_true_opts_in(self):
        self.assertTrue(AgentConfig.from_dict({"require_two_person_publish": True}).require_two_person_publish)
        for falsey in (False, None, "true", 1, 0):
            self.assertFalse(
                AgentConfig.from_dict({"require_two_person_publish": falsey}).require_two_person_publish,
                msg=f"{falsey!r} must not opt in",
            )

    def test_round_trips_through_to_dict(self):
        cfg = AgentConfig(require_two_person_publish=True)
        self.assertTrue(AgentConfig.from_dict(cfg.to_dict()).require_two_person_publish)


if __name__ == "__main__":
    unittest.main()
