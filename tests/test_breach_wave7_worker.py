"""Breach wave 7 (lane G): what the shared render worker believes about a customer.

The database half of these findings is in tests/security/test_sec_breach_channel_config.py
and tests/security/test_sec_breach_leaks.py. This is the worker half, run by the
ordinary unit suite (`python -m unittest discover tests`).

What held (a passing test, the control that keeps the open ones honest):
  * a channel with no Vault connection that names no other reference uses its OWN
    CHRONOS_YT_TOKEN_<ID> secret, and never the default channel's token.

Fixed (patch-breach7, now ordinary tests):
  * BR-G-002  a customer-organization channel never reads an environment token:
    its only token is its own Vault connection, whatever its member-writable
    ``credential_ref.ref`` names (the operator's own channels keep the
    environment path).
  * BR-G-007  a run's directory and checkpoint are keyed by the channel for every
    organization but the operator's (modules/run_slug.py), a second organization
    never adopts another's checkpoint, and a run begun before the key is still
    found.
  * BR-G-006 (= BR-L-040, migration 0085): the worker still hands the raw text of a
    regeneration's refusal to finish_scene_regeneration, which now keeps it off the row
    every member reads (RegenerationRefusalReachesMembers below pins the contract).
"""

import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import channel_credentials, run_checkpoint, run_slug, scene_regenerate as sr, scene_repair
from modules.channels import ChannelContext, CredentialRef
from tools import list_channels, restore_channel_token
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
        return self.resolve_with(channel, self.ENV)

    def resolve_with(self, channel: ChannelContext, env):
        row = list_channels._row(channel)
        return row, qw.channel_token(row, env, None)

    def test_a_customer_channel_that_names_no_other_reference_has_only_its_own_secret(self):
        row, got = self.resolve(customer_channel("cust-chan"))
        self.assertEqual(row["token_secret"], "", "a customer channel has no secret name")
        self.assertFalse(got.found, "a channel with no token of its own must publish nothing, "
                                    "never with another channel's")

    def test_BR_G_002_a_customer_channel_cannot_name_the_operators_token_secret(self):
        """credential_ref.ref is written by an editor of the customer's organization
        (the channels table's own UPDATE policy, before 0086). The worker used to
        turn it into the name of the secret it reads, so a customer who knew or
        guessed an operator channel's id published with the operator's YouTube
        token. A customer channel now has no environment path at all."""
        row, got = self.resolve(customer_channel("cust-chan", ref="extinct-world"))
        self.assertEqual(row["token_secret"], "", "the row's reference chose the secret")
        self.assertFalse(got.found, "a customer channel resolved the operator's token from the worker's "
                                    f"environment ({OPERATORS_SECRET}) because its own row named it")

    def test_BR_G_002_that_token_is_handed_to_the_customers_run(self):
        row = list_channels._row(customer_channel("cust-chan", ref="extinct-world"))
        with tempfile.TemporaryDirectory() as repo:
            child = qw.prepare_credentials(row, self.ENV, Path(repo))
        self.assertNotIn(OPERATORS_SECRET, child,
                         "the customer's run was started with the operator's token in its environment")
        self.assertFalse([k for k in child if k.startswith(qw.TOKEN_PREFIX)], sorted(child))

    def test_BR_G_002_a_customer_channel_never_reads_the_environment_even_under_its_own_name(self):
        """Channel ids may differ only in punctuation ('extinct-world' and
        'extinct--world' name the same secret), so a customer's own-id name can
        collide with an operator's. The environment is not consulted for a
        customer channel at all."""
        env = dict(self.ENV)
        env["CHRONOS_YT_TOKEN_EXTINCT_WORLD"] = OPERATORS_TOKEN
        row, got = self.resolve_with(customer_channel("extinct--world"), env)
        self.assertEqual(row["token_secret"], "", "a name equal to the operator's was emitted")
        self.assertFalse(got.found)

    def test_a_row_without_the_operator_flag_is_treated_as_someone_elses(self):
        row = {"channel_id": "x-chan", "token_secret": OPERATORS_SECRET, "is_default": False}
        self.assertFalse(qw.channel_token(row, self.ENV, None).found)

    def test_the_operators_own_channel_still_reads_its_environment_token(self):
        operator = ChannelContext(channel_id="extinct-world", name="Extinct World", niche="history",
                                  credential=CredentialRef(ref="extinct-world", youtube_channel_id=YT,
                                                           verified_at=STAMP))
        row, got = self.resolve(operator)
        self.assertTrue(row["is_operators"])
        self.assertEqual(row["token_secret"], OPERATORS_SECRET)
        self.assertTrue(got.found)
        with tempfile.TemporaryDirectory() as repo:
            child = qw.prepare_credentials(row, self.ENV, Path(repo))
        self.assertEqual(child[OPERATORS_SECRET], OPERATORS_TOKEN)

    def test_an_operator_channel_may_still_name_a_reference_other_than_its_id(self):
        operator = ChannelContext(channel_id="chan-one", name="One", niche="n",
                                  credential=CredentialRef(ref="extinct-world", youtube_channel_id=YT,
                                                           verified_at=STAMP))
        self.assertEqual(channel_credentials.env_var_name(operator), OPERATORS_SECRET)

    def test_a_customer_channels_token_file_is_its_own_not_a_name_it_chose(self):
        c = customer_channel("cust-chan", ref="extinct-world")
        self.assertEqual(channel_credentials.token_path(c).name, "youtube_token__cust-chan.json")
        # No operator reference can produce a customer's file name.
        operator = ChannelContext(channel_id="chan-one", name="One", niche="n",
                                  credential=CredentialRef(ref="_cust-chan", youtube_channel_id=YT, verified_at=STAMP))
        self.assertNotEqual(channel_credentials.token_path(operator).name,
                            channel_credentials.token_path(c).name)

    def test_a_customer_channel_with_a_vault_connection_gets_exactly_that(self):
        class Vault:
            configured = True

            def read(self, channel_id):
                return qw.channel_tokens.VaultToken(refresh_token="rt-1234567890", scopes=(), oauth_client_id="cid",
                                                    youtube_channel_id=YT)

        env = dict(self.ENV, GOOGLE_OAUTH_CLIENT_ID="cid", GOOGLE_OAUTH_CLIENT_SECRET="csec")
        row = list_channels._row(customer_channel("cust-chan", ref="extinct-world"))
        got = qw.channel_token(row, env, Vault())
        self.assertEqual(got.source, qw.channel_tokens.SOURCE_VAULT)
        with tempfile.TemporaryDirectory() as repo:
            child = qw.prepare_credentials(row, env, Path(repo), Vault())
            wrote = sorted(p.name for p in Path(repo).glob("youtube_token*.json"))
            body = (Path(repo) / "youtube_token__cust-chan.json").read_text()
        # Handed over as the file its uploader reads, never as an environment variable.
        self.assertEqual(wrote, ["youtube_token__cust-chan.json"])
        self.assertIn("rt-1234567890", body)
        self.assertFalse([k for k in child if k.startswith(qw.TOKEN_PREFIX)], sorted(child))


class HyphenCollidingIds(unittest.TestCase):
    """BR-L-080. Channel ids that differ only in punctuation normalise to one
    secret name ('extinct-world', 'extinct-world-', 'extinct--world'), and the
    operator's secrets sit in the environment of every runner. With the
    operator's secret in the environment, a customer channel of such an id gets
    no token and no secret name on EVERY path that could read it: the queue
    worker, the Actions matrix row, tools/restore_channel_token, and
    materialize_token (the uploader, the analytics client and the comment
    fetcher, so the intelligence poll too)."""

    IDS = ("extinct-world-", "extinct--world", "extinct-world--", "extinct-world")
    ENV = {OPERATORS_SECRET: OPERATORS_TOKEN, "YOUTUBE_TOKEN_JSON": '{"refresh_token": "default-token"}'}

    def test_the_secret_name_function_answers_the_table_the_lab_holds_sql_to(self):
        """BR-L-080: SQL's channel_secret_name (migration 0086, which create_channel
        uses to refuse colliding ids) and secret_name_for are one function."""
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parent / "security"))
        from secret_name_corpus import EXPECTED

        for key, want in EXPECTED.items():
            self.assertEqual(channel_credentials.secret_name_for(key), want, repr(key))

    def test_the_matrix_row_and_the_queue_worker_hand_such_a_channel_nothing(self):
        for cid in self.IDS:
            c = customer_channel(cid)
            row = list_channels._row(c)
            self.assertEqual((row["is_operators"], row["token_secret"]), (False, ""), cid)
            self.assertFalse(qw.channel_token(row, self.ENV, None).found, cid)
            with tempfile.TemporaryDirectory() as repo:
                child = qw.prepare_credentials(row, self.ENV, Path(repo))
                self.assertEqual(list(Path(repo).glob("youtube_token*.json")), [], cid)
            self.assertFalse([k for k in child if k.startswith(qw.TOKEN_PREFIX)], cid)

    def test_materialize_token_never_reads_the_environment_for_such_a_channel(self):
        for cid in self.IDS:
            with tempfile.TemporaryDirectory() as tmp, \
                    mock.patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), \
                    mock.patch.dict("os.environ", {OPERATORS_SECRET: OPERATORS_TOKEN}):
                got = channel_credentials.materialize_token(customer_channel(cid))
                self.assertIsNone(got, cid)
                self.assertEqual(list(Path(tmp).glob("*.json")), [], cid)

    def test_materialize_token_still_returns_the_file_the_worker_wrote_for_a_customer(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
            c = customer_channel("cust-chan")
            path = Path(tmp) / channel_credentials.customer_token_filename("cust-chan")
            path.write_text('{"refresh_token": "x"}')
            self.assertEqual(channel_credentials.materialize_token(c), path)

    def test_materialize_token_still_reads_the_operators_environment(self):
        operator = ChannelContext(channel_id="extinct-world", name="E", niche="n",
                                  credential=CredentialRef(ref="extinct-world", youtube_channel_id=YT, verified_at=STAMP))
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), \
                mock.patch.dict("os.environ", {OPERATORS_SECRET: OPERATORS_TOKEN}):
            got = channel_credentials.materialize_token(operator)
            self.assertIsNotNone(got)
            self.assertIn("operator-refresh-token", got.read_text())

    def test_the_restore_step_gives_such_a_channel_no_token_and_exports_nothing(self):
        for cid in self.IDS[:-1]:
            for client in (None, "unconfigured", "empty"):
                out = io.StringIO()

                class Vault:
                    configured = client != "unconfigured"

                    def read(self, channel_id):
                        return None

                with tempfile.TemporaryDirectory() as tmp, \
                        mock.patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                    gh_env = Path(tmp) / "github_env"
                    gh_env.write_text("")
                    env = dict(self.ENV, CHANNEL_ID=cid, GITHUB_ENV=str(gh_env))
                    code = restore_channel_token.main(env, load_channel=lambda _id, c=cid: customer_channel(c),
                                                      client=Vault(), out=out)
                    self.assertEqual(code, 0, (cid, out.getvalue()))
                    self.assertEqual(list(Path(tmp).glob("youtube_token*.json")), [], cid)
                    self.assertEqual(gh_env.read_text(), "")
                self.assertNotIn(OPERATORS_SECRET, out.getvalue())
                self.assertNotIn("using CHRONOS", out.getvalue())

    def test_the_restore_step_writes_a_customers_vault_token_to_its_own_file(self):
        class Vault:
            configured = True

            def read(self, channel_id):
                return qw.channel_tokens.VaultToken(refresh_token="rt-1234567890", scopes=(), oauth_client_id="cid",
                                                    youtube_channel_id=YT)

        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, mock.patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
            env = dict(self.ENV, CHANNEL_ID="cust-chan", GOOGLE_OAUTH_CLIENT_ID="cid", GOOGLE_OAUTH_CLIENT_SECRET="csec")
            self.assertEqual(restore_channel_token.main(env, load_channel=lambda _id: customer_channel("cust-chan"),
                                                        client=Vault(), out=out), 0)
            self.assertEqual([p.name for p in Path(tmp).glob("youtube_token*.json")], ["youtube_token__cust-chan.json"])

    def test_the_workflow_step_that_exports_a_secret_runs_only_for_the_operators_channels(self):
        text = (Path(__file__).resolve().parent.parent / ".github" / "workflows" / "daily_video.yml").read_text()
        step = text.split("- name: Restore YouTube token (this channel)", 1)[1].split("- name:", 1)[0]
        self.assertIn("if: ${{ !matrix.is_default && matrix.is_operators }}", step)
        # Every workflow that evaluates a secret by a matrix-provided name is gated the same way.
        for path in (Path(__file__).resolve().parent.parent / ".github" / "workflows").glob("*.yml"):
            body = path.read_text()
            for m in re.finditer(r"secrets\[matrix\.\w+\]", body):
                head = body[:m.start()].rsplit("- name:", 1)[1]
                self.assertIn("matrix.is_operators", head, f"{path.name}: {m.group(0)} is not gated")


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

    def keyed(self, channel: str) -> str:
        return run_slug.run_slug(self.TOPIC, channel, operators=False)

    def test_BR_G_007_two_organizations_running_one_topic_each_find_their_own_run(self):
        """output/<slug>/ and its checkpoint used to be named by the topic only,
        and ``record_stage`` keeps the FIRST writer's channel. Organization B's
        run of the same topic then landed in A's directory under A's checkpoint.
        The slug a customer channel's run is written under now carries the
        channel (modules/run_slug.py), as main.py computes it."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertNotEqual(self.keyed("chan-a"), self.keyed("chan-b"))
            for channel in ("chan-a", "chan-b"):
                run_checkpoint.record_stage(self.keyed(channel), run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                            channel_id=channel, root=root)
            for channel in ("chan-a", "chan-b"):
                try:
                    found = scene_repair.find_run(channel, topic=self.TOPIC, root=root)
                except scene_repair.RepairUnavailable as e:
                    self.fail(f"{channel} cannot find its own run of the topic: {e}")
                self.assertEqual(found.channel_id, channel)
                self.assertEqual(found.slug, self.keyed(channel))

    def test_a_slug_fits_every_database_check_and_never_leaves_the_output_folder(self):
        for topic in (self.TOPIC, "x", "../../etc/passwd", "ü" * 200, "a" * 300, "!!!"):
            for channel in ("chan-a", "a" * 39):
                slug = run_slug.keyed_slug(topic, channel)
                self.assertRegex(slug, r"^[a-z0-9][a-z0-9-]{0,49}$", (topic, slug))
                self.assertLessEqual(len(slug), 50)

    def test_the_operators_own_channel_keeps_the_topic_slug_so_existing_runs_are_found(self):
        self.assertEqual(run_slug.run_slug(self.TOPIC, "extinct-world", operators=True),
                         "the-lost-city-of-atlantis-ten-theories")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slug = scene_repair._slugify(self.TOPIC)
            run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                        channel_id="extinct-world", root=root)
            self.assertEqual(scene_repair.find_run("extinct-world", topic=self.TOPIC, root=root).slug, slug)

    def test_a_customer_run_begun_before_the_key_is_still_found_by_its_own_channel_only(self):
        legacy = scene_repair._slugify(self.TOPIC)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_checkpoint.record_stage(legacy, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                        channel_id="chan-a", root=root)
            self.assertEqual(scene_repair.find_run("chan-a", topic=self.TOPIC, root=root).slug, legacy)
            with self.assertRaises(scene_repair.RepairUnavailable) as raised:
                scene_repair.find_run("chan-b", topic=self.TOPIC, root=root)
            self.assertIn("belongs to channel 'chan-a'", str(raised.exception))

    def test_a_regeneration_names_the_run_by_its_slug_and_finds_it(self):
        """scene_regenerate passes the run's stored slug as --topic."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slug = self.keyed("chan-a")
            run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                        channel_id="chan-a", root=root)
            self.assertEqual(scene_repair.find_run("chan-a", topic=slug, root=root).slug, slug)

    def test_a_checkpoint_of_another_channel_is_never_adopted_or_written_to(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slug = scene_repair._slugify(self.TOPIC)
            run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                        channel_id="chan-a", root=root)
            refused = run_checkpoint.record_stage(slug, run_checkpoint.STAGE_VOICE, topic=self.TOPIC,
                                                  channel_id="chan-b", root=root)
            self.assertIsNone(refused)
            cp = run_checkpoint.load(slug, root)
            self.assertEqual((cp.channel_id, list(cp.stages)), ("chan-a", [run_checkpoint.STAGE_SCRIPT]))

    def test_a_directory_held_by_another_channel_is_not_reused_the_keyed_name_is(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plain = scene_repair._slugify(self.TOPIC)
            run_checkpoint.record_stage(plain, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                        channel_id="chan-a", root=root)
            # An operator channel that would take the plain name takes its keyed one instead.
            self.assertEqual(run_slug.resolve(self.TOPIC, "chan-b", operators=True, root=root), self.keyed("chan-b"))
            # Its own directory (or none) is just the plain name.
            self.assertEqual(run_slug.resolve(self.TOPIC, "chan-a", operators=True, root=root), plain)
            # And a keyed name held by someone else stops the run before it spends.
            run_checkpoint.record_stage(self.keyed("chan-b"), run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC,
                                        channel_id="chan-c", root=root)
            with self.assertRaises(run_slug.RunDirectoryConflict):
                run_slug.resolve(self.TOPIC, "chan-b", operators=True, root=root)

    def test_a_bare_resume_continues_only_the_channels_own_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_checkpoint.record_stage("topic-a", run_checkpoint.STAGE_SCRIPT, topic="a", channel_id="chan-a", root=root)
            run_checkpoint.record_stage("topic-b", run_checkpoint.STAGE_SCRIPT, topic="b", channel_id="chan-b", root=root)
            self.assertEqual(run_checkpoint.latest_incomplete(root, channel_id="chan-a").slug, "topic-a")
            self.assertIsNone(run_checkpoint.latest_incomplete(root, channel_id="chan-z"))

    def test_the_worker_resumes_a_requeued_run_by_its_keyed_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slug = self.keyed("chan-a")
            script = root / slug / "script.json"
            script.parent.mkdir(parents=True)
            script.write_text("{}")
            run_checkpoint.record_stage(slug, run_checkpoint.STAGE_SCRIPT, topic=self.TOPIC, channel_id="chan-a",
                                        artifacts={"script_json": script}, root=root)
            job = {"attempts": 2, "kind": "daily", "channel_id": "chan-a", "created_at": "2000-01-01T00:00:00+00:00"}
            self.assertEqual(qw.resume_target(job, {"topic": self.TOPIC}, root), self.TOPIC)
            # Another channel's job for the same topic does not pick it up.
            other = dict(job, channel_id="chan-b")
            self.assertIsNone(qw.resume_target(other, {"topic": self.TOPIC}, root))


if __name__ == "__main__":
    unittest.main()
