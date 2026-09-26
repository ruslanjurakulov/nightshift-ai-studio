"""The pipeline's first-run channel bootstrap and organizations (migration 0018).

The bot writes `channels` rows in exactly one place: SupabaseSync.mirror_channels
seeding an EMPTY table from the local registry. After 0018 every channel belongs
to an organization, so those rows must name the default org — and on a database
that has not applied 0018 yet (no org_id column) the bootstrap must still land
the rows rather than fail the whole batch over one unknown column.

No network: `requests` is mocked.
"""

import unittest
from unittest.mock import MagicMock, patch

from modules.channels import DEFAULT_ORG_ID, legacy_default_channel
from modules.supabase_sync import SupabaseSync


def _resp(status: int, payload=None):
    r = MagicMock()
    r.status_code = status
    r.text = ""
    r.json.return_value = payload if payload is not None else []
    return r


def _registry():
    reg = MagicMock()
    reg.list.return_value = [legacy_default_channel()]
    return reg


def _channel_posts(post):
    return [
        c.kwargs["json"]
        for c in post.call_args_list
        if (c.args[0] if c.args else "").endswith("/rest/v1/channels")
    ]


class ChannelBootstrapOrgTestCase(unittest.TestCase):
    def setUp(self):
        self.sync = SupabaseSync(url="https://demo.supabase.co", service_key="service-key-123")

    def test_default_org_id_matches_the_migration(self):
        # 0018 creates the default org with this fixed id; if they drift, every
        # bootstrapped channel would violate channels_org_id_fkey.
        with open("supabase/migrations/0018_organizations.sql", encoding="utf-8") as fh:
            self.assertIn(f"'{DEFAULT_ORG_ID}'::uuid", fh.read())

    def test_bootstrapped_channel_row_names_the_default_org(self):
        row = SupabaseSync._channel_row(legacy_default_channel())
        self.assertEqual(row["org_id"], DEFAULT_ORG_ID)

    def test_empty_table_is_seeded_with_org_id(self):
        with patch("modules.supabase_sync.requests.get", return_value=_resp(200, [])), \
             patch("modules.supabase_sync.requests.post", return_value=_resp(201)) as post, \
             patch("modules.channel_credentials.credential_status") as cred:
            cred.return_value.to_dict.return_value = {"channel_id": "default", "provider": "youtube"}
            counts = self.sync.mirror_channels(registry=_registry())

        batches = _channel_posts(post)
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0][0]["org_id"], DEFAULT_ORG_ID)
        self.assertEqual(counts["channels"], 1)

    def test_pre_0018_database_still_gets_its_channels(self):
        # First POST: PostgREST rejects the unknown org_id column. Second POST
        # (without it) succeeds — the pre-0018 behaviour, unchanged.
        responses = [_resp(400), _resp(201), _resp(201)]
        with patch("modules.supabase_sync.requests.get", return_value=_resp(200, [])), \
             patch("modules.supabase_sync.requests.post", side_effect=responses) as post, \
             patch("modules.channel_credentials.credential_status") as cred:
            cred.return_value.to_dict.return_value = {"channel_id": "default", "provider": "youtube"}
            counts = self.sync.mirror_channels(registry=_registry())

        batches = _channel_posts(post)
        self.assertEqual(len(batches), 2)
        self.assertIn("org_id", batches[0][0])
        self.assertNotIn("org_id", batches[1][0])
        self.assertEqual(counts["channels"], 1)

    def test_existing_channels_are_never_rewritten(self):
        # Once rows exist the Command Center owns them — including which org a
        # channel is in. The bot must not re-post and move it back.
        with patch("modules.supabase_sync.requests.get", return_value=_resp(200, [{"channel_id": "default"}])), \
             patch("modules.supabase_sync.requests.post", return_value=_resp(201)) as post, \
             patch("modules.channel_credentials.credential_status") as cred:
            cred.return_value.to_dict.return_value = {"channel_id": "default", "provider": "youtube"}
            counts = self.sync.mirror_channels(registry=_registry())

        self.assertEqual(_channel_posts(post), [])
        self.assertNotIn("channels", counts)


if __name__ == "__main__":
    unittest.main()
