"""The scheduled matrix runs the operator's channels only.

A scheduled (or all-channels manual) run of daily_video.yml carries no credit
reservation: it is paid for by the operator. Before this change
tools/list_channels.py emitted every ACTIVE, schedule-enabled, verified
channel in the registry — which, read with the service key, is every
organization's. A customer can make their own verified channel ACTIVE from the
Channels page (or straight through PostgREST), and the operator's runner and
provider keys then produced a video for them every day without a credit being
charged. Customer channels run only when named explicitly (`--only`), which is
how the Command Center dispatches a paid run with its credit hold.
"""

import unittest

from modules.channels import DEFAULT_ORG_ID, ChannelContext, ChannelRegistry
from tools import list_channels

CUSTOMER_ORG = "8710f2b3-bcd6-4c90-a992-cbc329af93bb"


def _row(channel_id: str, org_id, hour: int = 15) -> dict:
    row = {
        "channel_id": channel_id,
        "name": channel_id,
        "niche": "tech",
        "status": "ACTIVE",
        "schedule_config": {"enabled": True, "publish_hour_utc": hour},
        "credential_ref": {"youtube_channel_id": f"UC{channel_id}", "verified_at": "2026-09-01T00:00:00Z"},
    }
    if org_id is not None:
        row["org_id"] = org_id
    return row


def _registry(*rows) -> ChannelRegistry:
    return ChannelRegistry([ChannelContext.from_dict(r) for r in rows])


class ScheduledMatrixIsTheOperatorsOnly(unittest.TestCase):
    def setUp(self):
        self.registry = _registry(
            _row("default", DEFAULT_ORG_ID),
            _row("operator-two", DEFAULT_ORG_ID),
            _row("customer-chan", CUSTOMER_ORG),
        )

    def test_a_customers_active_verified_channel_is_not_scheduled(self):
        ids = [r["channel_id"] for r in list_channels.due_channels(15, registry=self.registry)]
        self.assertEqual(ids, ["default", "operator-two"])

    def test_the_all_channels_manual_matrix_excludes_customers_too(self):
        ids = [r["channel_id"] for r in list_channels.due_channels(None, registry=self.registry)]
        self.assertNotIn("customer-chan", ids)

    def test_an_explicit_run_of_a_customer_channel_is_unchanged(self):
        # The Command Center's paid "Run now" names the channel (--only) and
        # carries its credit hold; that path is not the scheduler's.
        self.assertEqual(list_channels.resolve_only("customer-chan", registry=self.registry)["channel_id"],
                         "customer-chan")

    def test_a_customer_only_registry_falls_back_to_the_default_channel_not_to_the_customer(self):
        reg = _registry(_row("customer-chan", CUSTOMER_ORG))
        ids = [r["channel_id"] for r in list_channels.due_channels(None, registry=reg)]
        self.assertEqual(ids, ["default"])


class ChannelContextKnowsItsOrganization(unittest.TestCase):
    def test_org_id_is_read_from_the_row(self):
        self.assertEqual(ChannelContext.from_dict(_row("customer-chan", CUSTOMER_ORG)).org_id, CUSTOMER_ORG)

    def test_a_row_without_org_id_is_the_operators(self):
        # channels.json, and a database from before migration 0018: every
        # channel there is the operator's own.
        self.assertEqual(ChannelContext.from_dict(_row("local", None)).org_id, DEFAULT_ORG_ID)


if __name__ == "__main__":
    unittest.main()
