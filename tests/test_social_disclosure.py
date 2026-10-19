"""Cross-posts and the AI-disclosure label: Instagram ``is_ai_generated``, TikTok ``is_aigc``, the caption line and
the YouTube target's flag, all from the ONE rule in modules/ai_disclosure.py. Adapters are tested against fakes; no
platform is called."""

import json
import unittest

from modules import ai_disclosure as ad
from modules import social_captions as sc
from modules import social_publish as sp
from tests.test_social_publish import (Base, FakeHTTP, FakeStore, FakeTokens, FakeUploader, Resp, YtStore,
                                       YoutubeFlowTests)

GEN_VIDEO = {"assets": [{"id": "a1", "kind": "video", "source": "generated"}]}
GEN_IMAGE = {"assets": [{"id": "a1", "kind": "image", "source": "generated"}]}
STOCK = {"assets": [{"id": "a1", "kind": "video", "source": "stock"}]}


def event(**signals):
    base = {"known": True, "generated_clips": 0, "generated_stills": 0, "presenter": False, "voice": "generic"}
    base.update(signals)
    return {"event": ad.EVENT, "ts": "2026-10-19T10:00:00", "metadata": {"signals": base}}


class DStore(FakeStore):
    """A store whose channel carries an agent_config and whose event record is scripted."""

    def __init__(self, *, agent_config=None, events=(), **kw):
        super().__init__(**kw)
        self._agent = agent_config or {}
        self._events = list(events)

    def channel(self, channel_id):
        return {"channel_id": channel_id, "niche": "history", "agent_config": self._agent}

    def disclosure_events(self, video_id):
        return list(self._events)


IG = sp.IG_GRAPH
TT = sp.TT_API


def ig_http():
    return FakeHTTP({
        ("POST", f"{IG}/17841400000/media_publish"): [Resp(200, {"id": "MEDIA1"})],
        ("POST", f"{IG}/17841400000/media"): [Resp(200, {"id": "CONT1"})],
        ("GET", f"{IG}/CONT1"): [Resp(200, {"status_code": "FINISHED"})],
        ("GET", f"{IG}/MEDIA1"): [Resp(200, {"permalink": "https://www.instagram.com/reel/abc/"})],
    })


def tt_http():
    return FakeHTTP({
        ("POST", f"{TT}/creator_info/query/"): [Resp(200, {
            "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 600},
            "error": {"code": "ok"}})],
        ("POST", f"{TT}/video/init/"): [Resp(200, {"data": {"publish_id": "p1",
                                                          "upload_url": "https://open-upload.tiktokapis.com/x"},
                                                 "error": {"code": "ok"}})],
        ("PUT", "https://open-upload.tiktokapis.com/x"): [Resp(201)],
        ("POST", f"{TT}/status/fetch/"): [Resp(200, {"data": {"status": "PUBLISH_COMPLETE",
                                                             "publicaly_available_post_id": [1]},
                                                    "error": {"code": "ok"}})],
    })


class InstagramLabel(Base):
    def run_ig(self, manifest, **store_kw):
        self.video["manifest"] = manifest
        http = ig_http()
        store = DStore(video=self.video, http=http, **store_kw)
        out = self.run_req(store, FakeTokens("instagram"), http=http)
        create = next(c for c in http.calls if c[1].endswith("/media"))
        return out, create[2]["data"], store

    def test_generated_clip_sets_is_ai_generated_and_adds_the_line(self):
        out, data, store = self.run_ig(GEN_VIDEO)
        self.assertEqual(out, "published")
        self.assertEqual(data["is_ai_generated"], "true")
        self.assertIn(ad.STANDARD_LINES["en"], data["caption"])
        self.assertIn(ad.STANDARD_LINES["en"], store.updates[0]["caption"])  # what the row records is what was sent

    def test_stock_only_sends_no_field_and_no_line(self):
        out, data, _ = self.run_ig(STOCK)
        self.assertEqual(out, "published")
        self.assertNotIn("is_ai_generated", data)
        self.assertNotIn(ad.STANDARD_LINES["en"], data["caption"])

    def test_never_overrides_generated_media(self):
        _, data, _ = self.run_ig(GEN_VIDEO, agent_config={"ai_disclosure": "never"})
        self.assertNotIn("is_ai_generated", data)

    def test_always_labels_stock_only(self):
        _, data, _ = self.run_ig(STOCK, agent_config={"ai_disclosure": "always"})
        self.assertEqual(data["is_ai_generated"], "true")

    def test_line_switched_off_keeps_the_flag_only(self):
        _, data, _ = self.run_ig(GEN_VIDEO, agent_config={"ai_disclosure_line": False})
        self.assertEqual(data["is_ai_generated"], "true")
        self.assertNotIn(ad.STANDARD_LINES["en"], data["caption"])

    def test_the_channels_language_and_own_wording_are_used(self):
        _, data, _ = self.run_ig(GEN_IMAGE, agent_config={"language": "russian"})
        self.assertIn(ad.STANDARD_LINES["ru"], data["caption"])
        _, data, _ = self.run_ig(GEN_IMAGE, agent_config={"ai_disclosure_text": "AI helped make this."})
        self.assertIn("AI helped make this.", data["caption"])

    def test_the_recorded_presenter_label_beats_a_stock_manifest(self):
        # The manifest cannot see an AI presenter; the event the run recorded can.
        _, data, _ = self.run_ig(STOCK, events=[event(presenter=True)])
        self.assertEqual(data["is_ai_generated"], "true")

    def test_never_still_wins_over_a_recorded_label(self):
        _, data, _ = self.run_ig(STOCK, events=[event(generated_clips=4)], agent_config={"ai_disclosure": "never"})
        self.assertNotIn("is_ai_generated", data)

    def test_a_video_with_no_manifest_and_no_record_is_labelled_not_assumed_clean(self):
        _, data, _ = self.run_ig(None)
        self.assertEqual(data["is_ai_generated"], "true")

    def test_an_unlabelled_post_is_the_post_it_always_was(self):
        _, data, _ = self.run_ig(STOCK)
        self.assertEqual(sorted(data), ["access_token", "caption", "media_type", "share_to_feed", "video_url"])


class TiktokLabel(Base):
    def run_tt(self, manifest, **store_kw):
        self.video["manifest"] = manifest
        http = tt_http()
        store = DStore(video=self.video, http=http, **store_kw)
        out = self.run_req(store, FakeTokens("tiktok"), platform="tiktok", http=http)
        init = next(c for c in http.calls if c[1].endswith("/video/init/"))
        return out, init[2]["json"]["post_info"], store

    def test_generated_media_sets_is_aigc_and_stays_private(self):
        out, post, store = self.run_tt(GEN_IMAGE)
        self.assertEqual(out, "published")
        self.assertIs(post["is_aigc"], True)
        self.assertEqual(post["privacy_level"], "SELF_ONLY")
        self.assertEqual(store.final["privacy"], "SELF_ONLY")
        self.assertIn(ad.STANDARD_LINES["en"], post["title"])

    def test_stock_only_sends_no_is_aigc(self):
        _, post, _ = self.run_tt(STOCK)
        self.assertNotIn("is_aigc", post)
        self.assertEqual(sorted(post), ["disable_comment", "disable_duet", "disable_stitch", "privacy_level",
                                        "title"])

    def test_never_and_always(self):
        _, post, _ = self.run_tt(GEN_VIDEO, agent_config={"ai_disclosure": "never"})
        self.assertNotIn("is_aigc", post)
        _, post, _ = self.run_tt(STOCK, agent_config={"ai_disclosure": "always"})
        self.assertIs(post["is_aigc"], True)

    def test_real_person_voice_setting_labels(self):
        _, post, _ = self.run_tt(STOCK, agent_config={"ai_disclosure_voice": "real_person"})
        self.assertIs(post["is_aigc"], True)

    def test_own_voice_clone_does_not(self):
        _, post, _ = self.run_tt(STOCK, agent_config={"ai_disclosure_voice": "own_clone"})
        self.assertNotIn("is_aigc", post)


class YoutubeTargetLabel(YoutubeFlowTests):
    def run_yt(self, manifest, **store_kw):
        self.video["manifest"] = manifest
        store = DStore(video=self.video, http=FakeHTTP({}), **store_kw)
        # DStore.channel has no status: give the target channel what the YouTube flow needs.
        orig = store.channel
        store.channel = lambda cid: {**orig(cid), "status": "ACTIVE"}
        store.channel_connected = lambda cid: True
        out, up = self.yt(store)
        return out, up, store

    def test_generated_media_is_passed_to_the_uploader_and_the_line_is_in_the_description(self):
        out, up, store = self.run_yt(GEN_VIDEO)
        self.assertEqual(out, "published")
        self.assertTrue(up.kwargs["ai_disclosure"].label)
        (_, script, privacy), = up.calls
        self.assertEqual(privacy, "private")
        self.assertTrue(script.description.endswith(ad.STANDARD_LINES["en"]))
        self.assertIn(ad.STANDARD_LINES["en"], store.updates[0]["caption"])

    def test_unlabelled_upload_calls_the_uploader_exactly_as_before(self):
        out, up, _ = self.run_yt(STOCK)
        self.assertEqual(out, "published")
        self.assertEqual(up.kwargs, {})
        self.assertNotIn(ad.STANDARD_LINES["en"], up.calls[0][1].description)


class RecordedEvents(unittest.TestCase):
    """PublishStore.disclosure_events: best-effort, never stops a publish."""

    class H:
        def __init__(self, status=200, body=None, exc=None):
            self.status, self.body, self.exc, self.calls = status, body, exc, []

        def get(self, url, **kw):
            self.calls.append((url, kw))
            if self.exc:
                raise self.exc
            return Resp(self.status, self.body)

    def store(self, h):
        return sp.PublishStore("https://x.supabase.co", "svc", session=h)

    def test_reads_the_video_ai_disclosure_events_newest_first(self):
        rows = [event(generated_clips=1)]
        h = self.H(body=rows)
        self.assertEqual(self.store(h).disclosure_events("vid1"), rows)
        params = h.calls[0][1]["params"]
        self.assertEqual((params["video_id"], params["event"], params["order"]),
                         ("eq.vid1", "eq.video.ai_disclosure", "ts.desc"))

    def test_an_error_or_a_missing_table_is_an_empty_record(self):
        self.assertEqual(self.store(self.H(status=404, body={"message": "x"})).disclosure_events("v"), [])
        self.assertEqual(self.store(self.H(exc=RuntimeError("boom"))).disclosure_events("v"), [])
        self.assertEqual(self.store(self.H(body={"not": "a list"})).disclosure_events("v"), [])

    def test_the_channel_read_asks_for_the_settings(self):
        h = self.H(body=[{"channel_id": "news"}])
        self.store(h).channel("news")
        self.assertIn("agent_config", h.calls[0][1]["params"]["select"])


class DisclosureFor(unittest.TestCase):
    def test_basis_event_manifest_unknown(self):
        video = {"video_id": "v", "manifest": GEN_VIDEO}
        self.assertEqual(sp.disclosure_for(video, {}, [event()])[1], "event")
        self.assertEqual(sp.disclosure_for(video, {})[1], "manifest")
        d, basis = sp.disclosure_for({"video_id": "v"}, {})
        self.assertEqual((basis, d.reasons), ("unknown", (ad.R_PROVENANCE_UNKNOWN,)))

    def test_a_garbage_agent_config_never_turns_the_label_off(self):
        d, _ = sp.disclosure_for({"manifest": GEN_VIDEO}, {"agent_config": {"ai_disclosure": ["never"]}})
        self.assertTrue(d.label)
        d, _ = sp.disclosure_for({"manifest": GEN_VIDEO}, {"agent_config": "junk"})
        self.assertTrue(d.label)


class CaptionRoom(unittest.TestCase):
    """The line is the one thing a limit never cuts."""

    LINE = ad.STANDARD_LINES["en"]

    def meta(self, n=6000):
        return sc.SourceMeta(title="The Fall of Rome", description=("word " * n).strip(), tags=("ancient rome", "history"),
                             niche="history")

    def test_instagram_caption_keeps_the_line_within_2200(self):
        c = sc.instagram_caption(self.meta(), disclosure=self.LINE)
        self.assertLessEqual(len(c), sc.IG_CAPTION_MAX)
        self.assertIn(self.LINE, c)
        self.assertIn("#AncientRome", c)

    def test_tiktok_caption_keeps_the_line_within_utf16_limit(self):
        ru = ad.STANDARD_LINES["ru"]
        c = sc.tiktok_caption(self.meta(), disclosure=ru)
        self.assertLessEqual(sc.utf16_len(c), sc.TT_CAPTION_MAX_UTF16)
        self.assertIn(ru, c)

    def test_youtube_description_keeps_the_line_within_5000_bytes(self):
        ru = ad.STANDARD_LINES["ru"]
        m = sc.SourceMeta(title="T", description="слово " * 3000)
        y = sc.youtube_metadata(m, disclosure=ru)
        self.assertLessEqual(len(y.description.encode("utf-8")), sc.YT_DESCRIPTION_MAX_BYTES)
        self.assertTrue(y.description.endswith(ru))

    def test_no_disclosure_changes_nothing(self):
        m = self.meta(40)
        self.assertEqual(sc.instagram_caption(m, disclosure=""), sc.instagram_caption(m))
        self.assertEqual(sc.tiktok_caption(m), sc.tiktok_caption(m, disclosure=""))
        self.assertEqual(sc.youtube_metadata(m), sc.youtube_metadata(m, disclosure=""))
        self.assertNotIn(self.LINE, sc.caption_for("instagram", m))

    def test_short_description_gets_the_line_after_it(self):
        m = sc.SourceMeta(title="T", description="Short text.")
        self.assertEqual(sc.youtube_metadata(m, disclosure=self.LINE).description, f"Short text.\n\n{self.LINE}")
        self.assertEqual(sc.youtube_metadata(sc.SourceMeta(title="T"), disclosure=self.LINE).description, self.LINE)

    def test_a_line_longer_than_the_limit_is_left_out_not_cut(self):
        c = sc.tiktok_caption(self.meta(10), disclosure="x" * 3000)
        self.assertNotIn("x" * 100, c)
        self.assertLessEqual(sc.utf16_len(c), sc.TT_CAPTION_MAX_UTF16)

    def test_angle_brackets_never_reach_a_youtube_description(self):
        y = sc.youtube_metadata(sc.SourceMeta(title="T", description="a"), disclosure="made <with> AI")
        self.assertNotIn("<", y.description)


if __name__ == "__main__":
    unittest.main()
