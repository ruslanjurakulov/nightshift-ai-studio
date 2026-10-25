"""modules/publishers.py: what the registry promises. (That the three adapters behave exactly as before the move
is tests/test_publisher_transcripts.py; the adapters' own flows are tests/test_social_publish.py.)

* an unknown platform is refused before anything is read, and there is no default;
* the four platforms are registered (X is DARK: registered, but nothing can reach it), each with the Protocol's shape;
* each adapter maps ``PostSpec.ai_generated`` to its platform's field, and sends it only when true, while the
  decision itself still comes from modules/ai_disclosure.py.

No platform is called."""

import dataclasses
import unittest

from modules import ai_disclosure as ad
from modules import publishers
from modules import social_captions
from modules import social_publish as sp
from tests.test_publisher_transcripts import CLEAN, LABELLED, Scenario, Spy, SpyTokens, tt_flow
from tests.test_social_disclosure import DStore, ig_http
from tests.test_social_publish import FakeHTTP


class RegistryTests(Scenario):
    def ctx(self, **over):
        base = dict(request={"id": 1, "org_id": "org", "video_id": "vid1", "account_id": "acc1",
                             "target_channel_id": "finance"},
                    video=self.video, store=DStore(video=self.video, http=FakeHTTP({})),
                    tokens=SpyTokens("instagram", []), worker_id="w1", output_dir=self.out, http=FakeHTTP({}),
                    env={}, sleep=lambda s: None, heartbeat=lambda: None,
                    probe_fn=lambda p: sp.VideoInfo(60.0, 1080, 1920, 1), media_fn=lambda p: self.GOOD_FACTS)
        base.update(over)
        return publishers.PublishContext(**base)

    def test_the_four_platforms_are_registered_and_nothing_else(self):
        self.assertEqual(publishers.platforms(), ("instagram", "tiktok", "x", "youtube"))

    def test_every_registered_publisher_has_the_protocols_shape_and_its_own_name(self):
        for platform in publishers.platforms():
            pub = publishers.factory_for(platform)(self.ctx())
            self.assertIsInstance(pub, publishers.Publisher, platform)
            self.assertEqual(pub.platform, platform)

    def test_an_unknown_platform_is_refused_before_anything_is_read(self):
        """CLAUDE.md #4: no silent fallback to another platform, and no database read for a word we do not know."""
        for platform in ("facebook", "snapchat", "", "Instagram", "X", "tiktok ", "YOUTUBE", None):
            http = FakeHTTP({})
            store = DStore(video=self.video, http=http)
            log = []
            out = sp.process_request({"id": 7, "org_id": "org", "video_id": "vid1", "account_id": "a",
                                      "platform": platform}, store=Spy(store, log),
                                     tokens=SpyTokens("instagram", log), worker_id="w1", output_dir=self.out,
                                     http=http, env={})
            self.assertEqual(out, "refused", repr(platform))
            self.assertEqual((store.final["status"], store.final["reason"]), ("refused", "unknown_platform"))
            self.assertEqual([c[0] for c in log], ["store.update"], repr(platform))  # only the row saying "refused"
            self.assertEqual(http.calls, [])

    def test_a_platform_registered_by_a_test_is_reachable_and_one_that_is_not_registered_is_not(self):
        """The dispatch is the registry and nothing else: a name that is registered runs ITS publisher."""
        seen = []

        class Probe:
            platform = "probe"

            def __init__(self, ctx):
                seen.append(ctx.request["platform"])

            def connect(self):
                raise sp.refused("account_not_connected", "probe publisher reached")

        publishers.register("probe", Probe)
        try:
            store = DStore(video=self.video, http=FakeHTTP({}))
            out = sp.process_request({"id": 7, "video_id": "vid1", "platform": "probe"}, store=store,
                                     tokens=SpyTokens("instagram", []), worker_id="w1", output_dir=self.out,
                                     http=FakeHTTP({}), env={})
        finally:
            publishers._FACTORIES.pop("probe")
        self.assertEqual((out, seen, store.final["error"]), ("refused", ["probe"], "probe publisher reached"))
        self.assertEqual(publishers.platforms(), ("instagram", "tiktok", "x", "youtube"))

    def test_the_registry_has_no_default_and_refuses_a_second_claim(self):
        self.assertIsNone(publishers.factory_for("facebook"))
        self.assertIsNone(publishers.factory_for(""))
        self.assertIsNone(publishers.factory_for(None))
        with self.assertRaises(ValueError):
            publishers.register("instagram", lambda ctx: None)  # replacing a publisher silently is a bug
        for bad in ("", "Facebook", " x", "X", None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                publishers.register(bad, lambda ctx: None)
        self.assertEqual(publishers.platforms(), ("instagram", "tiktok", "x", "youtube"))

    def test_the_context_never_prints_the_environment_a_store_a_token_or_a_client(self):
        """A log line or traceback that prints the context must show no secret: ``env`` is the worker's whole
        environment, the store and the HTTP session carry the service key, tokens read platform tokens."""
        secret = "sk-live-env-secret-value"
        ctx = self.ctx(env={"SUPABASE_SERVICE_KEY": secret}, tokens=SpyTokens("instagram", []),
                       http=FakeHTTP({}), youtube=object())
        text = repr(ctx) + str(ctx)
        self.assertNotIn(secret, text)
        self.assertNotIn("SUPABASE_SERVICE_KEY", text)
        for hidden in ("DStore", "SpyTokens", "FakeHTTP", "object object"):
            self.assertNotIn(hidden, text)
        self.assertIn("worker_id='w1'", text)  # it still says which request this is

    def test_a_post_spec_cannot_be_edited_after_the_decision(self):
        spec = publishers.PostSpec(caption="c", ai_generated=True)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            spec.ai_generated = False

    def test_compose_carries_the_decisions_label_and_line_and_nothing_else_decides(self):
        meta = sp.load_source_meta(self.video, None, self.out)
        for label in (True, False):
            decision = ad.Decision(label, "auto", ("generated_media",) if label else (), "AI line." if label else "")
            for platform in publishers.platforms():
                spec = publishers.factory_for(platform)(self.ctx()).compose(meta, decision)
                self.assertIs(spec.ai_generated, label, platform)
                self.assertEqual("AI line." in spec.caption, label, platform)
        yt = publishers.factory_for("youtube")(self.ctx()).compose(meta, ad.Decision(False, "auto", (), ""))
        self.assertEqual(yt.privacy, "private")  # YouTube's privacy is known before the upload
        for platform in ("instagram", "tiktok"):
            self.assertIsNone(publishers.factory_for(platform)(self.ctx()).compose(meta, ad.Decision(False, "auto", (), "")).privacy)
        self.assertEqual(social_captions.caption_for("instagram", meta, disclosure=""),
                         publishers.factory_for("instagram")(self.ctx()).compose(meta, ad.Decision(False, "auto", (), "")).caption)


class AiFlagMapping(Scenario):
    """Each adapter maps PostSpec.ai_generated to its platform's field and sends it only when true; the decision
    itself comes from modules/ai_disclosure.py (tests/test_social_disclosure.py covers its rules)."""

    def test_instagram_sends_is_ai_generated_only_when_labelled(self):
        for events, sent in ((LABELLED, True), (CLEAN, False)):
            self.setUp()
            _, _, _, http, _ = self.run_scenario("instagram", http=ig_http(), events=events)
            data = next(c for c in http.calls if c[1].endswith("/media"))[2]["data"]
            self.assertEqual("is_ai_generated" in data, sent)
            if sent:
                self.assertEqual(data["is_ai_generated"], "true")
            self.tearDown()

    def test_tiktok_sends_is_aigc_only_when_labelled(self):
        for events, sent in ((LABELLED, True), (CLEAN, False)):
            self.setUp()
            _, _, _, http, _ = self.run_scenario("tiktok", http=tt_flow(), events=events)
            post_info = next(c for c in http.calls if c[1].endswith("/video/init/"))[2]["json"]["post_info"]
            self.assertEqual("is_aigc" in post_info, sent)
            if sent:
                self.assertIs(post_info["is_aigc"], True)
            self.tearDown()

    def test_youtube_hands_the_uploader_the_decision_only_when_labelled(self):
        for events, sent in ((LABELLED, True), (CLEAN, False)):
            self.setUp()
            _, _, _, _, uploader = self.run_scenario("youtube", events=events)
            self.assertEqual("ai_disclosure" in uploader.kwargs, sent)
            if sent:
                self.assertTrue(uploader.kwargs["ai_disclosure"].label)
            self.tearDown()

    def test_the_youtube_publish_step_reads_the_spec_not_the_decision_object(self):
        """A spec that says not-AI sends no decision even when the payload still carries one."""
        calls = []

        class Adapter:
            def publish(self, channel_id, path, meta, decision=None):
                calls.append(decision)
                return {"result_id": "x", "result_url": None, "privacy": "whatever the adapter said"}

        ctx = RegistryTests.ctx(self, request={"id": 1, "target_channel_id": "finance"}, youtube=Adapter())
        pub = sp.YoutubePublisher(ctx)
        decision = ad.Decision(True, "auto", ("generated_media",), "line")
        out = pub.publish(self.master, publishers.PostSpec(caption="c", ai_generated=False, payload=("meta", decision)))
        pub.publish(self.master, publishers.PostSpec(caption="c", ai_generated=True, payload=("meta", decision)))
        self.assertEqual(calls, [None, decision])
        self.assertEqual(out["privacy"], "private")  # what is recorded is what we asked for, always private


class WhatTheWorkerSays(Scenario):
    """The two things the transcripts cannot see: the worker's log line and the YouTube adapter's heartbeat."""

    def test_the_log_line_says_where_it_went(self):
        cases = (("instagram", ig_http(), "published to instagram account acc1"),
                 ("tiktok", tt_flow(), "published to tiktok account acc1"),
                 ("youtube", None, "uploaded privately to YouTube channel finance"))
        for platform, http, line in cases:
            self.setUp()
            with self.assertLogs("modules.social_publish", level="INFO") as logs:
                out, *_ = self.run_scenario(platform, http=http)
            self.assertEqual(out, "published")
            self.assertIn(f"publish request {7 if platform != 'youtube' else 9}: {line}", logs.output[-1])
            self.tearDown()

    def test_the_youtube_adapter_beats_the_requests_heartbeat_while_it_uploads(self):
        beats = []
        seen = []

        class Adapter:
            heartbeat = None

            def publish(self, channel_id, path, meta, decision=None):
                seen.append(self.heartbeat)
                return {"result_id": "x", "result_url": None, "privacy": "private"}

        ctx = RegistryTests.ctx(self, request={"id": 1, "target_channel_id": "finance"}, youtube=Adapter(),
                                heartbeat=lambda: beats.append(1))
        sp.YoutubePublisher(ctx).publish(self.master, publishers.PostSpec("c", False, payload=("meta", None)))
        seen[0]()
        self.assertEqual(beats, [1])


if __name__ == "__main__":
    unittest.main()
