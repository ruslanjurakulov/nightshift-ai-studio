"""Breach wave 7 (lane G): what the shared render worker believes about a customer.

The database half of these findings is in tests/security/test_sec_breach_channel_config.py
and tests/security/test_sec_breach_leaks.py. This is the worker half, run by the
ordinary unit suite (`python -m unittest discover tests`).

What held (a passing test, the control that keeps the open ones honest):
  * a channel with no Vault connection that names no other reference uses its OWN
    CHRONOS_YT_TOKEN_<ID> secret, and never the default channel's token.

Fixed: BR-G-006 (= BR-L-040, migration 0085): the worker still hands the raw text of a
regeneration's refusal to finish_scene_regeneration, which now keeps it off the row
every member reads (RegenerationRefusalReachesMembers below pins the contract).

Open (``expectedFailure``: an unexpected success fails the suite, which forces
whoever closes the hole to drop the marker and update docs/security/LEDGER.md):
  * BR-G-002  a customer-organization channel publishes with whichever
    CHRONOS_YT_TOKEN_<REF> secret its member-writable ``credential_ref.ref`` names.
  * BR-G-007  a run's directory and checkpoint are keyed by the topic slug alone,
    so two organizations that run one topic on one worker share them.
"""

import tempfile
import unittest
from pathlib import Path

from modules import run_checkpoint, scene_regenerate as sr, scene_repair
from modules.channels import ChannelContext, CredentialRef
from tools import list_channels
from tools import queue_worker as qw

CUSTOMER_ORG = "22222222-2222-2222-2222-222222222222"
YT = "UCabcdefghijklmnopqrstuv"
STAMP = "2026-01-01T00:00:00+00:00"

#: The operator's other channel: its token lives in the worker's environment.
OPERATORS_SECRET = "CHRONOS_YT_TOKEN_EXTINCT_WORLD"
OPERATORS_TOKEN = '{"refresh_token": "operator-refresh-token", "client_id": "c", "client_secret": "s"}'


def customer_channel(channel_id: str, ref: str = "") -> ChannelContext:
    return ChannelContext(channel_id=channel_id, name="Customer", niche="travel", org_id=CUSTOMER_ORG,
                          credential=CredentialRef(ref=ref, youtube_channel_id=YT, verified_at=STAMP))


class CustomerChannelCredentials(unittest.TestCase):
    ENV = {OPERATORS_SECRET: OPERATORS_TOKEN, "YOUTUBE_TOKEN_JSON": '{"refresh_token": "default-token"}'}

    def resolve(self, channel: ChannelContext):
        row = list_channels._row(channel)
        return row, qw.channel_token(row, self.ENV, None)

    def test_a_customer_channel_that_names_no_other_reference_has_only_its_own_secret(self):
        row, got = self.resolve(customer_channel("cust-chan"))
        self.assertEqual(row["token_secret"], "CHRONOS_YT_TOKEN_CUST_CHAN")
        self.assertFalse(got.found, "a channel with no token of its own must publish nothing, "
                                    "never with another channel's")

    @unittest.expectedFailure
    def test_BR_G_002_a_customer_channel_cannot_name_the_operators_token_secret(self):
        """credential_ref.ref is written by an editor of the customer's organization
        (the channels table's own UPDATE policy). The worker turns it into the name
        of the secret it reads, so a customer who knows (the duplicate-key error on
        insert tells them which channel ids exist) or guesses an operator channel's
        id publishes with the operator's YouTube token."""
        _row, got = self.resolve(customer_channel("cust-chan", ref="extinct-world"))
        self.assertFalse(got.found, "a customer channel resolved the operator's token from the worker's "
                                    f"environment ({OPERATORS_SECRET}) because its own row named it")

    @unittest.expectedFailure
    def test_BR_G_002_that_token_is_handed_to_the_customers_run(self):
        row = list_channels._row(customer_channel("cust-chan", ref="extinct-world"))
        with tempfile.TemporaryDirectory() as repo:
            child = qw.prepare_credentials(row, self.ENV, Path(repo))
        self.assertNotIn(OPERATORS_SECRET, child,
                         "the customer's run was started with the operator's token in its environment")


class RegenerationRefusalReachesMembers(unittest.TestCase):
    """BR-G-006 (= BR-L-040). finish_scene_regeneration used to store ``error``
    on scene_regenerations, a table every member of the organization reads over
    PostgREST. The worker still passes the module's raw refusal text, so the
    contract is now the database's: migration 0085 keeps that text off the
    member-readable row (tests/security/test_sec_scene_regen_followups.py and
    test_sec_breach_leaks.py attack it in the lab)."""

    class Credits:
        def __init__(self):
            self.finished = []

        def scene_regen_finish(self, regen_id, job_id, *, ok, error_code=None, error=None, result=None):
            self.finished.append({"ok": ok, "error_code": error_code, "error": error})
            return {"status": "failed"}

    def refusal(self) -> str:
        req = sr.RegenRequest(regen_id="0b8f3c2e-5d4a-4e1f-9a7b-2c6d8e0f1a3b", scene_id="s000",
                              source_kind=sr.SOURCE_GENERATED, provider="kling", model="kling-v2-6",
                              previous_asset_ids=("a0",), generated_clips=1)

        class Client:  # the worker is configured for another model
            model = "kling-v2-5-internal"

        with self.assertRaises(sr.RegenUnavailable) as raised:
            sr.open_generator(req, get_client=lambda provider: Client())
        return str(raised.exception)

    def test_BR_G_006_the_workers_text_goes_only_to_the_function_that_keeps_it_off_the_member_row(self):
        w = qw.Worker.__new__(qw.Worker)
        w._secrets = []
        w.credits = self.Credits()
        text = self.refusal()
        w._settle_regeneration({"id": 7}, "0b8f3c2e-5d4a-4e1f-9a7b-2c6d8e0f1a3b", ok=False,
                               code="model_changed", error=text)
        sent = w.credits.finished[0]
        self.assertEqual(sent["error_code"], "model_changed")
        self.assertIn("kling-v2-5-internal", sent["error"] or "")
        finish = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "0085_scene_regen_followups.sql"
        body = finish.read_text().split("create or replace function public.finish_scene_regeneration(")[1].split("\n$$;")[0]
        self.assertNotIn("error = left(p_error", body)
        self.assertIn("insert into public.scene_regeneration_details", body)


class OneTopicTwoOrganizations(unittest.TestCase):
    TOPIC = "The lost city of Atlantis: ten theories"

    @unittest.expectedFailure
    def test_BR_G_007_two_organizations_running_one_topic_each_find_their_own_run(self):
        """output/<slug>/ and its checkpoint are named by the topic only (main.py
        OUTPUT_DIR / slugify(topic)), and ``record_stage`` keeps the FIRST writer's
        channel. Organization B's run of the same topic then lands in A's directory
        under A's checkpoint: B can no longer find its own run (a scene
        regeneration of B's video is refused as 'belongs to channel A'), and A's
        held cut, script and Video IR are the files B's run overwrites."""
        slug = scene_repair._slugify(self.TOPIC)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for channel in ("chan-a", "chan-b"):
                run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                            channel_id=channel, root=root)
            for channel in ("chan-a", "chan-b"):
                try:
                    found = scene_repair.find_run(channel, topic=self.TOPIC, root=root)
                except scene_repair.RepairUnavailable as e:
                    self.fail(f"{channel} cannot find its own run of the topic: {e}")
                self.assertEqual(found.channel_id, channel)


if __name__ == "__main__":
    unittest.main()
