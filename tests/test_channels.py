"""Multi-channel isolation tests.

These are the tests the Phase 5 brief asks for by name, and they are written as
*negative* assertions wherever possible: the interesting property is not that
channel A works, it is that channel A cannot reach channel B's voice, style,
credentials, queue, analytics or learning.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from modules.channels import (
    DEFAULT_CHANNEL_ID,
    AgentConfig,
    ChannelContext,
    ChannelRegistry,
    CredentialRef,
    ScheduleConfig,
    legacy_default_channel,
    new_channel,
    normalize_status,
    validate_channel_id,
)


def finance() -> ChannelContext:
    return ChannelContext(
        channel_id=validate_channel_id("chronos-finance"),
        name="Nightshift Finance",
        niche="Finance & Investing",
        status="ACTIVE",
        agent=AgentConfig(
            edge_tts_voice="en-US-GuyNeural",
            target_duration_seconds=480,
            visual_style_prompt="Clean modern documentary",
            system_prompt="One financial idea per video.",
        ),
        schedule=ScheduleConfig(publish_hour_utc=15),
        credential=CredentialRef(ref="finance", youtube_channel_id="UCfinance",
                                 verified_at="2026-01-01T00:00:00Z"),
    )


def history() -> ChannelContext:
    return ChannelContext(
        channel_id=validate_channel_id("extinct-world"),
        name="Extinct World",
        niche="Prehistoric History",
        status="ACTIVE",
        agent=AgentConfig(
            edge_tts_voice="en-GB-RyanNeural",
            target_duration_seconds=600,
            visual_style_prompt="Cinematic prehistoric documentary",
        ),
        schedule=ScheduleConfig(publish_hour_utc=19),
        credential=CredentialRef(ref="extinct", youtube_channel_id="UCextinct",
                                 verified_at="2026-01-01T00:00:00Z"),
    )


class ChannelIdTestCase(unittest.TestCase):
    def test_valid_ids_are_slugs(self):
        self.assertEqual(validate_channel_id("extinct-world"), "extinct-world")

    def test_invalid_ids_are_rejected(self):
        for bad in ("-leading", "Upper", "a", "has space", "", "x" * 40):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    validate_channel_id(bad)

    def test_unknown_status_reads_as_paused(self):
        # The safe direction: an unrecognised status must never make a channel
        # start publishing on its own.
        self.assertEqual(normalize_status("nonsense"), "PAUSED")
        self.assertEqual(normalize_status(None), "PAUSED")
        self.assertEqual(normalize_status("active"), "ACTIVE")

    def test_state_store_default_matches_the_channel_model(self):
        from modules.state_store import DEFAULT_CHANNEL_ID as store_default

        self.assertEqual(store_default, DEFAULT_CHANNEL_ID)


class RegistryTestCase(unittest.TestCase):
    def test_no_configuration_yields_the_legacy_single_channel(self):
        # The backward-compatibility guarantee: with nothing configured, the
        # registry hands back exactly the channel the bot has always been.
        registry = ChannelRegistry(file_path=Path("/nonexistent/channels.json"), sync=None)
        with patch("modules.supabase_sync.SupabaseSync") as fake_sync:
            fake_sync.return_value.enabled = False
            channels = registry.list()
        self.assertEqual([str(c.channel_id) for c in channels], [DEFAULT_CHANNEL_ID])
        self.assertEqual(channels[0].status, "ACTIVE")

    def test_reads_channels_from_a_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.json"
            path.write_text(json.dumps({"channels": [finance().to_dict(), history().to_dict()]}))
            registry = ChannelRegistry(file_path=path)
            with patch("modules.supabase_sync.SupabaseSync") as fake_sync:
                fake_sync.return_value.enabled = False
                ids = [str(i) for i in registry.ids()]
        # Default first, then alphabetical — and the default is synthesized
        # because the file did not define it.
        self.assertEqual(ids, ["default", "chronos-finance", "extinct-world"])

    def test_one_malformed_row_does_not_hide_the_others(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.json"
            path.write_text(json.dumps({"channels": [{"name": "no id"}, finance().to_dict()]}))
            registry = ChannelRegistry(file_path=path)
            with patch("modules.supabase_sync.SupabaseSync") as fake_sync:
                fake_sync.return_value.enabled = False
                ids = [str(i) for i in registry.ids()]
        self.assertIn("chronos-finance", ids)

    def test_unreadable_file_falls_back_instead_of_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "channels.json"
            path.write_text("{ not json")
            registry = ChannelRegistry(file_path=path)
            with patch("modules.supabase_sync.SupabaseSync") as fake_sync:
                fake_sync.return_value.enabled = False
                ids = [str(i) for i in registry.ids()]
        self.assertEqual(ids, [DEFAULT_CHANNEL_ID])

    def test_unknown_channel_raises_rather_than_guessing(self):
        registry = ChannelRegistry(channels=[legacy_default_channel(), finance()])
        with self.assertRaises(KeyError):
            registry.get("does-not-exist")

    def test_active_excludes_paused_and_schedule_disabled(self):
        paused = ChannelContext(
            channel_id=validate_channel_id("paused-one"), name="P", niche="", status="PAUSED"
        )
        disabled = ChannelContext(
            channel_id=validate_channel_id("disabled-one"),
            name="D",
            niche="",
            status="ACTIVE",
            schedule=ScheduleConfig(enabled=False),
        )
        registry = ChannelRegistry(channels=[legacy_default_channel(), finance(), paused, disabled])
        self.assertEqual(
            sorted(str(c.channel_id) for c in registry.active()), ["chronos-finance", "default"]
        )

    def test_a_new_channel_starts_paused(self):
        # Creating a channel must never start publishing.
        ch = new_channel("brand-new", "Brand New", "Something")
        self.assertEqual(ch.status, "PAUSED")


class CredentialIsolationTestCase(unittest.TestCase):
    def test_each_channel_has_its_own_token_path_and_env_var(self):
        from modules.channel_credentials import env_var_name, token_path

        self.assertNotEqual(token_path(finance()), token_path(history()))
        self.assertEqual(env_var_name(finance()), "CHRONOS_YT_TOKEN_FINANCE")
        self.assertEqual(env_var_name(history()), "CHRONOS_YT_TOKEN_EXTINCT")

    def test_default_channel_keeps_the_legacy_token_path(self):
        from config import YOUTUBE_TOKEN_FILE
        from modules.channel_credentials import token_path

        self.assertEqual(token_path(legacy_default_channel()), Path(YOUTUBE_TOKEN_FILE))

    def test_the_unsuffixed_token_the_workflows_write_is_still_found(self):
        """The CI failure this fallback exists for.

        config.YOUTUBE_TOKEN_FILE gains a _<YOUTUBE_CHANNEL_ID> suffix whenever
        that env var is set, but both workflows restore the YOUTUBE_TOKEN_JSON
        secret to the plain `youtube_token.json` — and export YOUTUBE_CHANNEL_ID
        in the same job. Without the fallback the token is written under one
        name, looked for under another, and the run dies claiming there is no
        token at all.
        """
        from modules.channel_credentials import LEGACY_TOKEN_NAME, token_path

        with tempfile.TemporaryDirectory() as tmp:
            suffixed = Path(tmp) / "youtube_token_UCabc123.json"
            plain = Path(tmp) / LEGACY_TOKEN_NAME
            plain.write_text(json.dumps({"token": "x", "refresh_token": "r"}))
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), patch(
                "modules.channel_credentials.cfg.YOUTUBE_TOKEN_FILE", suffixed
            ):
                self.assertEqual(token_path(legacy_default_channel()), plain)

    def test_a_caller_with_no_channel_finds_the_same_token(self):
        """The half of the fallback the first fix missed.

        tools/run_intelligence_poll.py constructs its first poller as
        IntelligencePoller() — no channel — and every client's channel-is-None
        branch read config.YOUTUBE_TOKEN_FILE directly, so it never reached the
        fallback. The poll then looked for the suffixed name, missed the file
        the workflow had written, and reported "no usable token" while the token
        sat right there. Both doors must give the same answer.
        """
        from modules.analytics_client import AnalyticsClient
        from modules.channel_credentials import LEGACY_TOKEN_NAME, token_path
        from modules.comment_fetcher import CommentFetcher
        from modules.youtube_uploader import YouTubeUploader

        with tempfile.TemporaryDirectory() as tmp:
            suffixed = Path(tmp) / "youtube_token_UCabc123.json"
            plain = Path(tmp) / LEGACY_TOKEN_NAME
            plain.write_text(json.dumps({"token": "x", "refresh_token": "r"}))
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), patch(
                "modules.channel_credentials.cfg.YOUTUBE_TOKEN_FILE", suffixed
            ):
                with_channel = token_path(legacy_default_channel())
                for client in (AnalyticsClient, CommentFetcher, YouTubeUploader):
                    with self.subTest(client=client.__name__):
                        self.assertEqual(
                            Path(client._resolve_token_file(None)), with_channel
                        )
                self.assertEqual(with_channel, plain)

    def test_the_fallback_never_shadows_a_real_suffixed_token(self):
        # Both files present: the configured one wins. The fallback may only
        # ever find a token, never replace the one this deployment configured.
        from modules.channel_credentials import LEGACY_TOKEN_NAME, token_path

        with tempfile.TemporaryDirectory() as tmp:
            suffixed = Path(tmp) / "youtube_token_UCabc123.json"
            suffixed.write_text(json.dumps({"token": "configured"}))
            (Path(tmp) / LEGACY_TOKEN_NAME).write_text(json.dumps({"token": "stale"}))
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), patch(
                "modules.channel_credentials.cfg.YOUTUBE_TOKEN_FILE", suffixed
            ):
                self.assertEqual(token_path(legacy_default_channel()), suffixed)

    def test_with_no_token_at_all_a_new_one_is_written_where_config_expects(self):
        # Nothing exists yet: the configured (suffixed) path is returned, so a
        # freshly minted token lands where this deployment will look for it.
        from modules.channel_credentials import token_path

        with tempfile.TemporaryDirectory() as tmp:
            suffixed = Path(tmp) / "youtube_token_UCabc123.json"
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), patch(
                "modules.channel_credentials.cfg.YOUTUBE_TOKEN_FILE", suffixed
            ):
                self.assertEqual(token_path(legacy_default_channel()), suffixed)

    def test_a_named_channel_is_unaffected_by_the_fallback(self):
        # The fallback is only for the legacy default channel. A named channel
        # must never pick up the default channel's token — that would publish
        # one channel's video to another's.
        from modules.channel_credentials import LEGACY_TOKEN_NAME, token_path

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / LEGACY_TOKEN_NAME).write_text(json.dumps({"token": "default"}))
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                self.assertNotEqual(
                    token_path(finance()), Path(tmp) / LEGACY_TOKEN_NAME
                )

    def test_the_diagnosis_names_which_of_the_four_causes_it_is(self):
        """"No usable token" has four causes needing four different fixes.

        Reporting them as one sentence cost a debugging round-trip every time
        this came up, which is exactly what these assertions are here to stop.
        """
        from modules.channel_credentials import token_diagnosis

        scopes = ["scope.a", "scope.b"]
        complete = {
            "refresh_token": "r", "client_id": "c", "client_secret": "s",
            "scopes": list(scopes),
        }
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "youtube_token.json"
            self.assertIn("no token file", token_diagnosis(missing, scopes))

            missing.write_text("{ truncated")
            self.assertIn("not valid JSON", token_diagnosis(missing, scopes))

            no_refresh = dict(complete, refresh_token="")
            missing.write_text(json.dumps(no_refresh))
            self.assertIn("refresh_token", token_diagnosis(missing, scopes))

            thin = dict(complete, scopes=["scope.a"])
            missing.write_text(json.dumps(thin))
            diagnosis = token_diagnosis(missing, scopes)
            self.assertIn("missing", diagnosis)
            self.assertIn("scope.b", diagnosis)

            missing.write_text(json.dumps(complete))
            self.assertIn("looks complete", token_diagnosis(missing, scopes))

    def test_the_diagnosis_never_echoes_the_token_itself(self):
        # This string reaches CI logs and an exception message, so it may carry
        # facts ABOUT the token and never any part of it.
        from modules.channel_credentials import token_diagnosis

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "youtube_token.json"
            path.write_text(json.dumps({
                "token": "ACCESS-SECRET-VALUE",
                "refresh_token": "REFRESH-SECRET-VALUE",
                "client_id": "ID-SECRET-VALUE",
                "client_secret": "CLIENT-SECRET-VALUE",
                "scopes": ["scope.a"],
            }))
            for text in (
                token_diagnosis(path, ["scope.a"]),
                token_diagnosis(path, ["scope.a", "scope.b"]),
            ):
                for secret in (
                    "ACCESS-SECRET-VALUE", "REFRESH-SECRET-VALUE",
                    "ID-SECRET-VALUE", "CLIENT-SECRET-VALUE",
                ):
                    self.assertNotIn(secret, text)

    def test_missing_token_reports_not_connected_not_error(self):
        from modules.channel_credentials import NOT_CONNECTED, credential_status

        with tempfile.TemporaryDirectory() as tmp:
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                status = credential_status(finance())
        self.assertEqual(status.status, NOT_CONNECTED)

    def test_status_never_carries_a_secret(self):
        from modules.channel_credentials import credential_status

        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "youtube_token_finance.json"
            token.write_text(
                json.dumps({"token": "SECRET-ACCESS", "refresh_token": "SECRET-REFRESH",
                            "expiry": "2099-01-01T00:00:00Z"})
            )
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                status = credential_status(finance())

        payload = json.dumps(status.to_dict())
        self.assertNotIn("SECRET-ACCESS", payload)
        self.assertNotIn("SECRET-REFRESH", payload)
        self.assertNotIn("refresh_token", payload)
        self.assertEqual(status.status, "connected")

    def test_expired_without_refresh_token_needs_reconnecting(self):
        from modules.channel_credentials import EXPIRED, credential_status

        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "youtube_token_finance.json"
            token.write_text(json.dumps({"token": "x", "expiry": "2000-01-01T00:00:00Z"}))
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                status = credential_status(finance())
        self.assertEqual(status.status, EXPIRED)

    def test_expired_with_a_refresh_token_is_still_connected(self):
        # google-auth refreshes it on next use — flagging this as broken would
        # send an operator chasing a non-problem.
        from modules.channel_credentials import CONNECTED, credential_status

        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "youtube_token_finance.json"
            token.write_text(
                json.dumps({"token": "x", "refresh_token": "r", "expiry": "2000-01-01T00:00:00Z"})
            )
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                status = credential_status(finance())
        self.assertEqual(status.status, CONNECTED)

    def test_materialize_writes_only_its_own_channels_token(self):
        from modules.channel_credentials import materialize_token, token_path

        with tempfile.TemporaryDirectory() as tmp:
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)), patch.dict(
                os.environ, {"CHRONOS_YT_TOKEN_FINANCE": json.dumps({"token": "fin"})}, clear=False
            ):
                materialize_token(finance())
                materialize_token(history())
                self.assertTrue(token_path(finance()).exists())
                # History's env var is unset, so nothing is written for it —
                # it must NOT inherit Finance's token.
                self.assertFalse(token_path(history()).exists())


class ClientSecretDiagnosticsTestCase(unittest.TestCase):
    """The workflows write the client secret with `echo '<secret>' > file`, so an
    unset secret leaves an EMPTY file that passes an exists() check. Handing that
    to InstalledAppFlow produced the bare JSONDecodeError every scheduled poll
    was actually failing with — naming neither the file nor the fix."""

    def _problem(self, contents=None):
        from modules.channel_credentials import client_secret_problem

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client_secret.json"
            if contents is not None:
                path.write_text(contents, encoding="utf-8")
            return client_secret_problem(path)

    def test_an_empty_file_is_reported_as_empty_not_as_bad_json(self):
        problem = self._problem("\n")
        self.assertIsNotNone(problem)
        self.assertIn("empty", problem)
        self.assertIn("YOUTUBE_CLIENT_SECRET_JSON", problem)

    def test_a_missing_file_names_the_secret_to_set(self):
        problem = self._problem(None)
        self.assertIsNotNone(problem)
        self.assertIn("not found", problem)

    def test_malformed_json_is_reported_as_such(self):
        self.assertIn("not valid JSON", self._problem("{oops"))

    def test_json_without_an_oauth_section_is_rejected(self):
        # Valid JSON is not the same as a usable OAuth client file.
        self.assertIn("installed", self._problem(json.dumps({"hello": "world"})))

    def test_a_real_client_file_has_no_problem(self):
        self.assertIsNone(self._problem(json.dumps({"installed": {"client_id": "x"}})))

    def test_ci_refuses_interactive_consent_instead_of_hanging(self):
        # run_local_server() opens a browser and waits for a human. On a runner
        # there is neither, so it hangs until the job times out.
        from modules.channel_credentials import require_interactive_consent_possible

        with patch.dict(os.environ, {"CI": "true"}, clear=False):
            with self.assertRaises(RuntimeError) as ctx:
                require_interactive_consent_possible("[channel: finance] ")
        message = str(ctx.exception)
        self.assertIn("connect_channel.py", message)
        self.assertIn("finance", message)

    def test_off_ci_the_interactive_flow_is_allowed(self):
        from modules.channel_credentials import require_interactive_consent_possible

        env = {k: v for k, v in os.environ.items() if k != "CI"}
        with patch.dict(os.environ, env, clear=True):
            require_interactive_consent_possible()  # must not raise


class UploaderIsolationTestCase(unittest.TestCase):
    def test_a_non_default_channel_never_inherits_the_env_target(self):
        from modules.youtube_uploader import YouTubeUploader

        blank = ChannelContext(
            channel_id=validate_channel_id("blank-channel"), name="B", niche="",
            credential=CredentialRef(ref="blank"),
        )
        with patch("modules.youtube_uploader.YOUTUBE_CHANNEL_ID", "UCdefaultchannel"):
            # Publishing this channel's video to the default channel because a
            # field was blank would be worse than failing.
            self.assertEqual(YouTubeUploader._resolve_target_channel(blank), "")
            self.assertEqual(YouTubeUploader._resolve_target_channel(finance()), "UCfinance")

    def test_no_channel_means_exactly_the_legacy_behaviour(self):
        from modules.youtube_uploader import YouTubeUploader

        with patch("modules.youtube_uploader.YOUTUBE_CHANNEL_ID", "UCdefaultchannel"):
            self.assertEqual(YouTubeUploader._resolve_target_channel(None), "UCdefaultchannel")

    def test_channels_do_not_share_a_token_file(self):
        from modules.youtube_uploader import YouTubeUploader

        with tempfile.TemporaryDirectory() as tmp:
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                a = YouTubeUploader._resolve_token_file(finance())
                b = YouTubeUploader._resolve_token_file(history())
        self.assertNotEqual(a, b)


class GenerationIsolationTestCase(unittest.TestCase):
    def test_script_prompt_carries_only_its_own_channels_strategy(self):
        from modules.script_engine import ScriptEngine

        fin = ScriptEngine._build_prompt("Topic", channel=finance())
        hist = ScriptEngine._build_prompt("Topic", channel=history())
        self.assertIn("One financial idea per video.", fin)
        self.assertNotIn("One financial idea per video.", hist)
        self.assertIn("Clean modern documentary", fin)
        self.assertNotIn("Clean modern documentary", hist)
        self.assertIn("480 seconds", fin)
        self.assertIn("600 seconds", hist)

    def test_prompt_without_a_channel_is_unchanged(self):
        from config import SCRIPT_LANGUAGE, VIDEO_DURATION_TARGET
        from modules.script_engine import ScriptEngine

        prompt = ScriptEngine._build_prompt("Topic")
        self.assertIn(f"Language: {SCRIPT_LANGUAGE}", prompt)
        self.assertIn(f"Target duration: {VIDEO_DURATION_TARGET} seconds", prompt)
        self.assertNotIn("Channel:", prompt)

    def test_each_channel_gets_its_own_voice(self):
        from modules.audio_mixer import AudioMixer

        with tempfile.TemporaryDirectory() as tmp:
            with patch("modules.audio_mixer.OUTPUT_DIR", Path(tmp)):
                fin = AudioMixer("slug-a", channel=finance())
                hist = AudioMixer("slug-b", channel=history())
        self.assertEqual(fin.main_edge_voice, "en-US-GuyNeural")
        self.assertEqual(hist.main_edge_voice, "en-GB-RyanNeural")
        self.assertNotEqual(fin.main_edge_voice, hist.main_edge_voice)

    def test_mixer_without_a_channel_uses_config(self):
        from config import EDGE_TTS_VOICE
        from modules.audio_mixer import AudioMixer

        with tempfile.TemporaryDirectory() as tmp:
            with patch("modules.audio_mixer.OUTPUT_DIR", Path(tmp)):
                mixer = AudioMixer("slug-c")
        self.assertEqual(mixer.main_edge_voice, EDGE_TTS_VOICE)


class QueueIsolationTestCase(unittest.TestCase):
    def test_queue_entries_do_not_cross_channels(self):
        from modules.content_planner import ContentPlanner

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "calendar.json"
            fin = ContentPlanner(store_path=store, channel_id="chronos-finance")
            hist = ContentPlanner(store_path=store, channel_id="extinct-world")
            fin.enqueue("Inflation explained")
            hist.enqueue("The Permian extinction")

            self.assertEqual([e.topic for e in fin.list_entries()], ["Inflation explained"])
            self.assertEqual([e.topic for e in hist.list_entries()], ["The Permian extinction"])
            self.assertEqual(fin.next_topic().topic, "Inflation explained")
            # Both channels' entries are in one file; the filter is what isolates.
            self.assertEqual(len(fin.list_entries(channel_id=None)), 2)

    def test_the_same_topic_may_be_queued_by_two_channels(self):
        from modules.content_planner import ContentPlanner

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "calendar.json"
            a = ContentPlanner(store_path=store, channel_id="chronos-finance")
            b = ContentPlanner(store_path=store, channel_id="extinct-world")
            first = a.enqueue("The Fall of Rome")
            second = b.enqueue("The Fall of Rome")
        # Different videos on different channels — not a duplicate.
        self.assertNotEqual(first.entry_id, second.entry_id)

    def test_dedup_still_applies_within_one_channel(self):
        from modules.content_planner import ContentPlanner

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "calendar.json"
            a = ContentPlanner(store_path=store, channel_id="chronos-finance")
            first = a.enqueue("The Fall of Rome")
            second = a.enqueue("The Fall of Rome")
        self.assertEqual(first.entry_id, second.entry_id)

    def test_entries_written_before_phase_5_read_as_the_default_channel(self):
        from modules.content_planner import ContentPlanner

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "calendar.json"
            store.write_text(json.dumps({
                "abc123": {"entry_id": "abc123", "topic": "Legacy", "added_at": "2026-01-01T00:00:00+00:00",
                           "source": "manual", "rationale": "", "status": "queued"}
            }))
            planner = ContentPlanner(store_path=store)
            entries = planner.list_entries()
        self.assertEqual([e.topic for e in entries], ["Legacy"])
        self.assertEqual(entries[0].channel_id, DEFAULT_CHANNEL_ID)


class RunIsolationTestCase(unittest.TestCase):
    def test_runs_are_listed_per_channel(self):
        from modules.pipeline_stages import PipelineStateMachine

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "runs.json"
            fin = PipelineStateMachine(store_path=store, channel_id="chronos-finance")
            hist = PipelineStateMachine(store_path=store, channel_id="extinct-world")
            fin.start_run("Inflation")
            hist.start_run("Permian")

            self.assertEqual([r.topic for r in fin.list_runs(channel_id="chronos-finance")], ["Inflation"])
            self.assertEqual([r.topic for r in hist.list_runs(channel_id="extinct-world")], ["Permian"])
            # Unfiltered stays unfiltered — the mirror wants every run.
            self.assertEqual(len(fin.list_runs()), 2)

    def test_runs_written_before_phase_5_read_as_the_default_channel(self):
        from modules.pipeline_stages import PipelineStateMachine

        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "runs.json"
            store.write_text(json.dumps({
                "r1": {"run_id": "r1", "topic": "Legacy", "current_stage": "topic",
                       "history": [], "human_approved": False, "approved_by": None, "approved_at": None}
            }))
            runs = PipelineStateMachine(store_path=store).list_runs()
        self.assertEqual(runs[0].channel_id, DEFAULT_CHANNEL_ID)


class StoreIsolationTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        from modules.state_store import StateStore

        self.store = StateStore(db_path=Path(self.tmp.name) / "chronos.db")
        self.addCleanup(self.store.close)

    def test_videos_are_listed_per_channel(self):
        self.store.record_video(video_id="v1", topic="A", channel_id="chronos-finance")
        self.store.record_video(video_id="v2", topic="B", channel_id="extinct-world")

        fin = self.store.list_videos(channel_id="chronos-finance")
        self.assertEqual([v["video_id"] for v in fin], ["v1"])
        self.assertEqual(len(self.store.list_videos()), 2)

    def test_a_video_recorded_without_a_channel_is_the_default_channel(self):
        self.store.record_video(video_id="v1", topic="A")
        self.assertEqual(self.store.get_video("v1")["channel_id"], DEFAULT_CHANNEL_ID)

    def test_two_channels_hold_independent_scores_for_one_topic(self):
        # The whole point of the (channel_id, topic) key: a topic that works for
        # Finance and flops for History is two verdicts, not one.
        self.store.upsert_channel_topic_performance(
            channel_id="chronos-finance", topic="Rome", score=80.0, videos_analyzed=5,
            updated_at="2026-09-01",
        )
        self.store.upsert_channel_topic_performance(
            channel_id="extinct-world", topic="Rome", score=20.0, videos_analyzed=5,
            updated_at="2026-09-01",
        )
        self.assertEqual(self.store.get_channel_topic_performance("chronos-finance", "Rome")["score"], 80.0)
        self.assertEqual(self.store.get_channel_topic_performance("extinct-world", "Rome")["score"], 20.0)

    def test_events_can_be_global_or_channel_scoped(self):
        self.store.record_event(event="system.heartbeat", ts="2026-09-01T00:00:00")
        self.store.record_event(event="video.published", ts="2026-09-01T00:01:00", channel_id="chronos-finance")
        self.store.record_event(event="video.published", ts="2026-09-01T00:02:00", channel_id="extinct-world")

        scoped = self.store.list_events(channel_id="chronos-finance")
        events = {e["event"] for e in scoped}
        # Its own event plus the global heartbeat — an operator watching one
        # channel still needs to see infrastructure problems.
        self.assertEqual(events, {"video.published", "system.heartbeat"})
        self.assertEqual(len(scoped), 2)

        strict = self.store.list_events(channel_id="chronos-finance", include_global=False)
        self.assertEqual(len(strict), 1)

    def test_feedback_signals_are_listed_per_channel(self):
        self.store.record_feedback_signal(
            video_id="v1", signal="strong", analyzed_date="2026-09-01", channel_id="chronos-finance"
        )
        self.store.record_feedback_signal(
            video_id="v2", signal="weak", analyzed_date="2026-09-01", channel_id="extinct-world"
        )
        rows = self.store.list_feedback_signals(channel_id="chronos-finance")
        self.assertEqual([r["video_id"] for r in rows], ["v1"])


class LearningIsolationTestCase(unittest.TestCase):
    def test_one_channels_metrics_do_not_score_anothers_topics(self):
        """Finance's numbers must never move a History topic score."""
        from modules.feedback_engine import FeedbackEngine
        from modules.state_store import StateStore

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(db_path=Path(tmp) / "chronos.db")
            try:
                for i, (channel, topic, views) in enumerate(
                    [
                        ("chronos-finance", "Rome", 1000),
                        ("chronos-finance", "Rome", 1200),
                        ("extinct-world", "Rome", 10),
                        ("extinct-world", "Rome", 12),
                    ]
                ):
                    vid = f"v{i}"
                    store.record_video(
                        video_id=vid, topic=topic, channel_id=channel,
                        published_at="2026-08-01T00:00:00",
                    )
                    store.record_metrics_snapshot(
                        video_id=vid, snapshot_date="2026-09-01", views=views,
                        likes=10, comment_count=1,
                    )

                FeedbackEngine(state_store=store, channel_id="chronos-finance").run()
                FeedbackEngine(state_store=store, channel_id="extinct-world").run()

                fin = store.get_channel_topic_performance("chronos-finance", "Rome")
                hist = store.get_channel_topic_performance("extinct-world", "Rome")
            finally:
                store.close()

        self.assertIsNotNone(fin)
        self.assertIsNotNone(hist)
        # Each channel scored against its OWN baseline, so both land near the
        # neutral 50 — neither is dragged by the other's very different views.
        self.assertEqual(fin["videos_analyzed"], 2)
        self.assertEqual(hist["videos_analyzed"], 2)

    def test_a_non_default_channel_never_writes_the_shared_table(self):
        # topic_performance is keyed on `topic` alone, so a second channel
        # writing there would overwrite the first channel's verdict.
        from modules.feedback_engine import FeedbackEngine
        from modules.state_store import StateStore

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(db_path=Path(tmp) / "chronos.db")
            try:
                for i in range(2):
                    vid = f"v{i}"
                    store.record_video(
                        video_id=vid, topic="Rome", channel_id="extinct-world",
                        published_at="2026-08-01T00:00:00",
                    )
                    store.record_metrics_snapshot(
                        video_id=vid, snapshot_date="2026-09-01", views=100 + i, likes=1, comment_count=1
                    )
                FeedbackEngine(state_store=store, channel_id="extinct-world").run()
                self.assertIsNone(store.get_topic_performance("Rome"))
                self.assertIsNotNone(store.get_channel_topic_performance("extinct-world", "Rome"))
            finally:
                store.close()


class AudienceIsolationTestCase(unittest.TestCase):
    """Competitors and audience demand are the two most channel-specific inputs
    there are — one channel's rivals and one channel's viewers must never steer
    another channel's topics."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        from modules.state_store import StateStore

        self.store = StateStore(db_path=Path(self.tmp.name) / "chronos.db")
        self.addCleanup(self.store.close)

    def test_each_channel_carries_its_own_competitor_list(self):
        fin = finance()
        hist = ChannelContext(
            channel_id=validate_channel_id("extinct-world"), name="E", niche="",
            agent=AgentConfig.from_dict({"competitor_channel_ids": ["UChistory"]}),
        )
        with patch.dict(os.environ, {"COMPETITOR_CHANNEL_IDS": "UCenvdefault"}, clear=False):
            watched_fin = AgentConfig.from_dict({"competitor_channel_ids": ["UCfin1", "UCfin2"]})
            self.assertEqual(watched_fin.competitor_channel_ids, ("UCfin1", "UCfin2"))
            self.assertEqual(hist.agent.competitor_channel_ids, ("UChistory",))
            # No cross-channel bleed, and no silent fallback to the env var for a
            # channel that named its own.
            self.assertNotIn("UCenvdefault", watched_fin.competitor_channel_ids)
            self.assertNotIn("UCfin1", hist.agent.competitor_channel_ids)
        self.assertEqual(fin.agent.competitor_channel_ids, ())

    def test_an_absent_list_inherits_the_env_var_but_an_empty_one_does_not(self):
        # These are different intents: "not configured" keeps the legacy
        # deployment working; "configured as empty" means watch nobody.
        with patch.dict(os.environ, {"COMPETITOR_CHANNEL_IDS": "UCa,UCb"}, clear=False):
            self.assertEqual(AgentConfig.from_dict({}).competitor_channel_ids, ("UCa", "UCb"))
            self.assertEqual(
                AgentConfig.from_dict({"competitor_channel_ids": []}).competitor_channel_ids, ()
            )

    def test_poll_reads_competitor_ids_from_the_channel_not_the_env(self):
        from tools.run_intelligence_poll import _competitor_channel_ids

        channel = ChannelContext(
            channel_id=validate_channel_id("chronos-finance"), name="F", niche="",
            agent=AgentConfig.from_dict({"competitor_channel_ids": ["UCmine"]}),
        )
        with patch.dict(os.environ, {"COMPETITOR_CHANNEL_IDS": "UCsomeoneelse"}, clear=False):
            self.assertEqual(_competitor_channel_ids(channel), ["UCmine"])
            # No channel at all is the legacy path, which still reads the env.
            self.assertEqual(_competitor_channel_ids(None), ["UCsomeoneelse"])

    def test_demand_signals_are_listed_per_channel(self):
        self.store.record_demand_signal(
            topic_phrase="more charts", mention_count=5, polled_date="2026-09-01",
            channel_id="chronos-finance",
        )
        self.store.record_demand_signal(
            topic_phrase="more dinosaurs", mention_count=7, polled_date="2026-09-01",
            channel_id="extinct-world",
        )
        fin = self.store.list_demand_signals(channel_id="chronos-finance")
        self.assertEqual([r["topic_phrase"] for r in fin], ["more charts"])
        self.assertEqual(len(self.store.list_demand_signals()), 2)

    def test_competitor_snapshots_are_listed_by_the_watching_channel(self):
        self.store.record_competitor_snapshot(
            video_id="cv1", channel_id="UCrival", polled_date="2026-09-01",
            chronos_channel_id="chronos-finance",
        )
        self.store.record_competitor_snapshot(
            video_id="cv2", channel_id="UCotherrival", polled_date="2026-09-01",
            chronos_channel_id="extinct-world",
        )
        mine = self.store.list_competitor_snapshots(chronos_channel_id="chronos-finance")
        self.assertEqual([r["video_id"] for r in mine], ["cv1"])
        # The other id still filters by the COMPETITOR's channel, as it always did.
        by_rival = self.store.list_competitor_snapshots(channel_id="UCotherrival")
        self.assertEqual([r["video_id"] for r in by_rival], ["cv2"])

    def test_recommender_sees_only_its_own_channels_demand_and_rivals(self):
        from modules.topic_recommender import TopicRecommender

        self.store.record_demand_signal(
            topic_phrase="finance thing", mention_count=9, polled_date="2026-09-01",
            channel_id="chronos-finance",
        )
        self.store.record_demand_signal(
            topic_phrase="history thing", mention_count=9, polled_date="2026-09-01",
            channel_id="extinct-world",
        )
        rec = TopicRecommender(state_store=self.store, channel_id="chronos-finance")
        suggestions = rec.suggest_topics(limit=10)
        topics = " ".join(s.topic.lower() for s in suggestions)
        self.assertIn("finance thing", topics)
        self.assertNotIn("history thing", topics)

    def test_comment_fetcher_binds_to_its_own_channels_token(self):
        from modules.comment_fetcher import CommentFetcher

        with tempfile.TemporaryDirectory() as tmp:
            with patch("modules.channel_credentials.cfg.BASE_DIR", Path(tmp)):
                a = CommentFetcher._resolve_token_file(finance())
                b = CommentFetcher._resolve_token_file(history())
        self.assertNotEqual(a, b)

    def test_active_channels_falls_back_rather_than_skipping(self):
        from tools import run_intelligence_poll as poll

        with patch.object(poll, "ChannelRegistry", side_effect=RuntimeError("boom")):
            channels = poll._active_channels()
        # [None] means "run the legacy single-channel pass" — degraded
        # attribution, never lost coverage.
        self.assertEqual(channels, [None])


class SchedulerIsolationTestCase(unittest.TestCase):
    def test_only_channels_due_this_hour_are_returned(self):
        from tools.list_channels import due_channels

        registry = ChannelRegistry(channels=[finance(), history()])
        at15 = [c["channel_id"] for c in due_channels(15, registry=registry)]
        at19 = [c["channel_id"] for c in due_channels(19, registry=registry)]
        # The default channel is always resolvable and is due at 15:00, which is
        # the hour the workflow has always run — so it rides along at 15 and
        # must not appear at 19.
        self.assertIn("chronos-finance", at15)
        self.assertNotIn("extinct-world", at15)
        self.assertEqual(at19, ["extinct-world"])

    def test_paused_channels_are_never_scheduled(self):
        from tools.list_channels import due_channels

        paused = ChannelContext(
            channel_id=validate_channel_id("paused-one"), name="P", niche="", status="PAUSED",
            schedule=ScheduleConfig(publish_hour_utc=15),
        )
        registry = ChannelRegistry(channels=[paused])
        # No active channel at all -> falls back to the default rather than
        # emitting an empty matrix; the paused channel is still not in it.
        ids = [c["channel_id"] for c in due_channels(15, registry=registry)]
        self.assertNotIn("paused-one", ids)

    def test_a_broken_registry_falls_back_to_the_default_channel(self):
        from tools.list_channels import due_channels

        class Broken:
            def active(self):
                raise RuntimeError("registry unavailable")

        # Failing open with an empty matrix would silently stop production.
        ids = [c["channel_id"] for c in due_channels(None, registry=Broken())]
        self.assertEqual(ids, [DEFAULT_CHANNEL_ID])


if __name__ == "__main__":
    unittest.main()


class VerificationIsWhatMakesAChannelReal(unittest.TestCase):
    """A row nobody confirmed against YouTube is a draft, not an account.

    The `ruslanjurakulov` channel was created from the site with a typed name,
    a typed niche and an ElevenLabs voice id of "16516516145" — a number, not a
    voice. Nothing required a confirmation, so the scheduler dispatched it a job
    on every manual run. These tests pin the rule that replaced that.
    """

    def row(self, channel_id, *, verified=True, status="ACTIVE", enabled=True, agent=None):
        credential = {"provider": "youtube"}
        if verified:
            credential.update(
                youtube_channel_id="UC_real",
                verified_at="2026-09-06T09:00:00Z",
                youtube_title="Extinct World",
                youtube_thumbnail="https://yt3.example/avatar.jpg",
            )
        return {
            "channel_id": channel_id,
            "name": channel_id,
            "niche": "n",
            "status": status,
            "agent_config": agent or {},
            "schedule_config": {"publish_hour_utc": 15, "enabled": enabled},
            "credential_ref": credential,
        }

    def test_a_confirmed_channel_is_verified(self):
        c = ChannelContext.from_dict(self.row("extinct-world"))
        self.assertTrue(c.is_verified)
        self.assertTrue(c.is_runnable)

    def test_a_draft_is_not_verified_however_active_it_says_it_is(self):
        c = ChannelContext.from_dict(self.row("draft", verified=False))
        self.assertFalse(c.is_verified)
        self.assertFalse(c.is_runnable)
        self.assertTrue(c.is_active, "the status is untouched — only the running is refused")

    def test_a_timestamp_without_a_channel_id_is_not_proof(self):
        """Half a record could be written by hand. Both halves say a lookup happened."""
        row = self.row("half")
        row["credential_ref"]["youtube_channel_id"] = ""
        self.assertFalse(ChannelContext.from_dict(row).is_verified)

    def test_a_channel_id_without_a_timestamp_is_not_proof(self):
        row = self.row("half", verified=False)
        row["credential_ref"]["youtube_channel_id"] = "UC_typo"
        self.assertFalse(ChannelContext.from_dict(row).is_verified)

    def test_the_default_channel_is_exempt(self):
        """It predates the registry and never passed through a form."""
        c = ChannelContext.from_dict(self.row("default", verified=False))
        self.assertTrue(c.is_verified)
        self.assertTrue(c.is_runnable)

    def test_the_scheduler_skips_a_draft(self):
        registry = ChannelRegistry(channels=[
            ChannelContext.from_dict(self.row("real")),
            ChannelContext.from_dict(self.row("draft", verified=False)),
        ])
        # `default` is always synthesized by the registry and always exempt.
        self.assertEqual(
            sorted(str(c.channel_id) for c in registry.active()), ["default", "real"]
        )

    def test_a_paused_schedule_still_wins(self):
        registry = ChannelRegistry(channels=[
            ChannelContext.from_dict(self.row("real", enabled=False)),
        ])
        self.assertNotIn("real", [str(c.channel_id) for c in registry.active()])

    def test_verification_survives_a_round_trip(self):
        c = ChannelContext.from_dict(self.row("extinct-world"))
        self.assertTrue(ChannelContext.from_dict(c.to_dict()).is_verified)


class OneVoicePerChannel(unittest.TestCase):
    """Two channels in one voice sound like one channel with two names."""

    def channel(self, channel_id, voice, provider="elevenlabs"):
        return ChannelContext.from_dict({
            "channel_id": channel_id,
            "name": channel_id,
            "niche": "n",
            "agent_config": {"tts_provider": provider, "elevenlabs_voice_id": voice},
            "credential_ref": {"youtube_channel_id": "UC1", "verified_at": "2026-09-06T09:00:00Z"},
        })

    def test_a_shared_voice_is_reported(self):
        registry = ChannelRegistry(channels=[
            self.channel("alpha", "voice-1"),
            self.channel("bravo", "voice-1"),
            self.channel("delta", "voice-2"),
        ])
        self.assertEqual(registry.voice_collisions(), {"voice-1": ["alpha", "bravo"]})

    def test_distinct_voices_collide_with_nothing(self):
        registry = ChannelRegistry(channels=[
            self.channel("alpha", "voice-1"),
            self.channel("bravo", "voice-2"),
        ])
        self.assertEqual(registry.voice_collisions(), {})

    def test_edge_channels_are_not_counted(self):
        """They do not use an ElevenLabs voice at all; the field is inherited noise."""
        registry = ChannelRegistry(channels=[
            self.channel("alpha", "voice-1", provider="edge"),
            self.channel("bravo", "voice-1", provider="edge"),
        ])
        self.assertEqual(registry.voice_collisions(), {})


class EachChannelUploadsToItsOwnAccount(unittest.TestCase):
    """The matrix names each channel's own token secret.

    Before this, every job in the matrix restored `YOUTUBE_TOKEN_JSON` — the
    default channel's token — so a video made for a new channel would have
    uploaded to somebody else's account. The workflow now indexes
    `secrets[matrix.token_secret]`, and these pin that the name it gets is the
    one the publishing side reads.
    """

    def channel(self, ref):
        return ChannelContext.from_dict({
            "channel_id": "extinct-world",
            "name": "Extinct World",
            "niche": "n",
            "credential_ref": {"ref": ref, "youtube_channel_id": "UC1",
                               "verified_at": "2026-09-06T09:00:00Z"},
        })

    def test_the_matrix_carries_the_secret_name_the_uploader_reads(self):
        from modules.channel_credentials import env_var_name
        from tools.list_channels import _row

        c = self.channel("extinct")
        self.assertEqual(_row(c)["token_secret"], env_var_name(c))
        self.assertEqual(_row(c)["token_secret"], "CHRONOS_YT_TOKEN_EXTINCT")

    def test_a_blank_ref_falls_back_to_the_channel_id(self):
        from tools.list_channels import _row

        self.assertEqual(_row(self.channel(""))["token_secret"], "CHRONOS_YT_TOKEN_EXTINCT_WORLD")

    def test_the_row_carries_no_secret_value(self):
        """This output is printed into the workflow log. Names only."""
        from tools.list_channels import _row

        self.assertEqual(
            set(_row(self.channel("extinct"))),
            {"channel_id", "name", "niche", "is_default", "is_operators", "token_secret"},
        )

    def test_the_default_channel_is_marked_so_the_legacy_step_can_run(self):
        from tools.list_channels import _row

        self.assertTrue(_row(legacy_default_channel())["is_default"])
