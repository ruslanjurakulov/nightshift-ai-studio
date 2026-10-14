"""Captions and chapters: metadata the pipeline already had and never shipped.

Two properties are load-bearing here, and both are about refusing to ship
something plausible-but-wrong:

  * chapters are emitted only when they satisfy every rule YouTube enforces,
    because a list that breaks one is silently ignored in full;
  * a caption track is uploaded only when its language can be named and the
    token was actually granted the scope for it — and never at the cost of the
    video, which is already published by the time captions are attempted.
"""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from modules.script_engine import Script, ScriptSection
from modules import youtube_uploader
from modules.youtube_uploader import (
    CAPTION_SCOPE,
    MAX_DESCRIPTION,
    YouTubeUploader,
    build_chapters,
    caption_language,
    compose_description,
    content_language,
    strip_timestamp_lines,
)


def section(name, narration="", cut_interval=5.0):
    return ScriptSection(name=name, narration=narration, duration_hint=45,
                         cut_interval=cut_interval)


def timeline(*spans):
    """[(name, start_s, end_s), ...] as the audio mixer would report it."""
    return [
        {"section": name, "start_ms": int(start * 1000), "end_ms": int(end * 1000)}
        for name, start, end in spans
    ]


def script(description="", sections=None):
    return Script(
        topic="A sunken ship", title="T", title_ab="", description=description,
        tags=["a"], hook_sentence="", sections=sections or [],
        thumbnail_prompt_a="", thumbnail_prompt_b="", thumbnail_overlay_text="",
        open_loops=[],
    )


def uploader(channel=None, token_file=None, service=None):
    """An uploader with no OAuth behind it.

    __init__ authenticates against Google, which no unit test may do, so the
    three attributes the methods under test actually read are set directly.
    """
    obj = object.__new__(YouTubeUploader)
    obj.channel = channel
    obj.token_file = token_file or Path("nonexistent-token.json")
    obj.target_channel_id = ""
    obj.service = service
    return obj


class ChapterRulesTestCase(unittest.TestCase):
    def test_the_first_chapter_is_zero_even_if_the_audio_starts_late(self):
        # YouTube ignores the whole list unless the first mark is 0:00, and
        # nothing precedes the first section anyway.
        lines = build_chapters(timeline(("hook", 0.4, 20), ("story", 20, 60), ("end", 60, 120)))
        self.assertTrue(lines[0].startswith("0:00 "))

    def test_a_section_shorter_than_ten_seconds_folds_into_the_one_before_it(self):
        # A six-second chapter is one YouTube rejects and one nobody can click.
        lines = build_chapters(timeline(
            ("hook", 0, 12), ("sting", 12, 18), ("story", 18, 60), ("end", 60, 120),
        ))
        self.assertEqual([line.split(" ")[0] for line in lines], ["0:00", "0:18", "1:00"])

    def test_fewer_than_three_usable_marks_emits_nothing(self):
        # Two chapters is not a chapter list; better to ship none than a list
        # YouTube will drop without saying so.
        self.assertEqual(build_chapters(timeline(("hook", 0, 30), ("story", 30, 90))), [])
        self.assertEqual(
            build_chapters(timeline(("a", 0, 4), ("b", 4, 8), ("c", 8, 12), ("d", 12, 16))),
            [],
        )

    def test_a_final_section_too_short_to_be_a_chapter_is_dropped(self):
        lines = build_chapters(timeline(
            ("hook", 0, 15), ("story", 15, 40), ("mid", 40, 70), ("outro", 70, 73),
        ))
        self.assertEqual([line.split(" ")[0] for line in lines], ["0:00", "0:15", "0:40"])

    def test_dropping_the_last_mark_below_three_emits_nothing(self):
        self.assertEqual(
            build_chapters(timeline(("a", 0, 15), ("b", 15, 30), ("c", 30, 33))),
            [],
        )

    def test_a_timeline_that_cannot_be_read_is_not_guessed_at(self):
        broken = [{"section": "a", "start_ms": 0, "end_ms": "soon"},
                  {"section": "b", "start_ms": 15000, "end_ms": 30000},
                  {"section": "c", "start_ms": 30000, "end_ms": 60000}]
        self.assertEqual(build_chapters(broken), [])
        self.assertEqual(build_chapters([{"no": "keys"}] * 3), [])
        self.assertEqual(build_chapters(None), [])

    def test_an_hour_long_video_gets_hour_stamps(self):
        lines = build_chapters(timeline(
            ("a", 0, 30), ("b", 30, 3700), ("c", 3700, 3800),
        ))
        self.assertEqual([line.split(" ")[0] for line in lines], ["0:00", "0:30", "1:01:40"])


class ChapterTitleTestCase(unittest.TestCase):
    def test_a_chapter_is_named_by_what_the_section_actually_says(self):
        # "open_loop_plant" is the script format's vocabulary, not a viewer's.
        sections = [
            section("hook", "[SFX:deep_boom] They found the treasure. Then it sank."),
            section("open_loop_plant", "But who hid it? We answer that at the end."),
            section("payoff", "The name was on the manifest all along."),
        ]
        lines = build_chapters(
            timeline(("hook", 0, 15), ("open_loop_plant", 15, 45), ("payoff", 45, 90)),
            sections,
        )
        self.assertEqual(lines[0], "0:00 They found the treasure")
        self.assertEqual(lines[1], "0:15 But who hid it?")

    def test_a_section_with_no_narration_falls_back_to_its_name(self):
        lines = build_chapters(
            timeline(("hook", 0, 15), ("open_loop_plant", 15, 45), ("payoff", 45, 90)),
            [section("hook"), section("open_loop_plant"), section("payoff")],
        )
        self.assertEqual(lines[1], "0:15 Open Loop Plant")

    def test_a_long_first_sentence_is_cut_on_a_word(self):
        long_line = "The ship carried more gold than any vessel had ever carried before it sank"
        lines = build_chapters(
            timeline(("hook", 0, 15), ("b", 15, 45), ("c", 45, 90)),
            [section("hook", long_line), section("b", "Second."), section("c", "Third.")],
        )
        title = lines[0][len("0:00 "):]
        self.assertLessEqual(len(title), 56)
        self.assertTrue(title.endswith("…"))
        self.assertTrue(long_line.startswith(title[:-1].rstrip()))


class DescriptionTestCase(unittest.TestCase):
    def test_the_timestamps_gemini_invented_are_removed(self):
        # They were written before the video existed, and YouTube reads the
        # first list it finds — so leaving them in means shipping the wrong one.
        text = "The story of a ship.\n\n0:00 Intro\n1:30 The storm\n- 4:12 The wreck\n\n#history"
        self.assertEqual(strip_timestamp_lines(text), "The story of a ship.\n\n\n#history")

    def test_prose_is_left_alone(self):
        text = "Nobody survived.\nThe wreck was found in 1971.\n#history"
        self.assertEqual(strip_timestamp_lines(text), text)

    def test_real_chapters_replace_invented_ones(self):
        composed = compose_description(
            "A ship.\n\n0:00 Intro\n2:00 Made up",
            ["0:00 They found the treasure", "0:15 But who hid it?", "0:45 The manifest"],
        )
        self.assertNotIn("Made up", composed)
        self.assertIn("Chapters:\n0:00 They found the treasure", composed)
        self.assertTrue(composed.startswith("A ship."))

    def test_no_real_chapters_still_means_no_invented_ones(self):
        # Knowing the true timings and finding them unusable is exactly the case
        # where the invented ones must not survive.
        composed = compose_description("A ship.\n0:00 Intro\n2:00 Made up", [])
        self.assertEqual(composed, "A ship.")

    def test_the_description_wins_when_the_block_will_not_fit(self):
        base = "x" * (MAX_DESCRIPTION - 10)
        composed = compose_description(base, ["0:00 One", "0:15 Two", "0:45 Three"])
        self.assertEqual(composed, base)


class CaptionLanguageTestCase(unittest.TestCase):
    def test_the_default_channel_narrates_in_english(self):
        self.assertEqual(caption_language(None), "en")

    def test_a_channels_own_language_is_used(self):
        channel = SimpleNamespace(agent=SimpleNamespace(language="Russian"))
        self.assertEqual(caption_language(channel), "ru")

    def test_a_code_is_taken_as_given(self):
        for code in ("en", "en-US", "pt-BR"):
            channel = SimpleNamespace(agent=SimpleNamespace(language=code))
            self.assertEqual(caption_language(channel), code)

    def test_a_language_this_code_cannot_name_yields_none(self):
        # A track labelled with the wrong language is the caption equivalent of
        # narrating in the wrong voice: no track is the better failure.
        channel = SimpleNamespace(agent=SimpleNamespace(language="Klingon"))
        self.assertIsNone(caption_language(channel))


class FakeCaptions:
    def __init__(self, raises=None):
        self.calls = []
        self.raises = raises

    def insert(self, **kwargs):
        self.calls.append(kwargs)
        captions = self

        class Request:
            def execute(self):
                if captions.raises:
                    raise captions.raises
                return {"id": "caption-1"}

        return Request()


class FakeService:
    def __init__(self, captions=None):
        self._captions = captions or FakeCaptions()

    def captions(self):
        return self._captions


class CaptionUploadTestCase(unittest.TestCase):
    def _srt(self, tmp, body="1\n00:00:00,000 --> 00:00:02,000\nHello\n"):
        path = Path(tmp) / "subtitles.srt"
        path.write_text(body, encoding="utf-8")
        return path

    def _token(self, tmp, scopes):
        path = Path(tmp) / "token.json"
        path.write_text(json.dumps({"token": "x", "refresh_token": "r", "scopes": scopes}))
        return path

    def test_the_srt_is_offered_to_youtube_with_its_language(self):
        with tempfile.TemporaryDirectory() as tmp:
            captions = FakeCaptions()
            up = uploader(token_file=self._token(tmp, [CAPTION_SCOPE]),
                          service=FakeService(captions))
            self.assertTrue(up.upload_captions("vid1", self._srt(tmp)))
            snippet = captions.calls[0]["body"]["snippet"]
            self.assertEqual(snippet["videoId"], "vid1")
            self.assertEqual(snippet["language"], "en")
            self.assertFalse(snippet["isDraft"])

    def test_an_empty_transcript_is_not_uploaded_as_a_caption_track(self):
        with tempfile.TemporaryDirectory() as tmp:
            captions = FakeCaptions()
            up = uploader(token_file=self._token(tmp, [CAPTION_SCOPE]),
                          service=FakeService(captions))
            self.assertFalse(up.upload_captions("vid1", self._srt(tmp, body="")))
            self.assertFalse(up.upload_captions("vid1", Path(tmp) / "missing.srt"))
            self.assertEqual(captions.calls, [])

    def test_a_token_without_the_scope_does_not_try(self):
        # The call would 403; saying which scope is missing is more use than
        # making the request to find out again every run.
        with tempfile.TemporaryDirectory() as tmp:
            captions = FakeCaptions()
            up = uploader(token_file=self._token(tmp, ["https://www.googleapis.com/auth/youtube.upload"]),
                          service=FakeService(captions))
            self.assertFalse(up.upload_captions("vid1", self._srt(tmp)))
            self.assertEqual(captions.calls, [])

    def test_a_token_that_lists_no_scopes_is_still_attempted(self):
        # Absent scope information is not evidence of a missing scope.
        with tempfile.TemporaryDirectory() as tmp:
            captions = FakeCaptions()
            path = Path(tmp) / "token.json"
            path.write_text(json.dumps({"token": "x"}))
            up = uploader(token_file=path, service=FakeService(captions))
            self.assertTrue(up.upload_captions("vid1", self._srt(tmp)))

    def test_a_caption_failure_never_reaches_the_caller(self):
        # The video is already published when this runs.
        with tempfile.TemporaryDirectory() as tmp:
            captions = FakeCaptions(raises=RuntimeError("quota"))
            up = uploader(token_file=self._token(tmp, [CAPTION_SCOPE]),
                          service=FakeService(captions))
            self.assertFalse(up.upload_captions("vid1", self._srt(tmp)))

    def test_an_unnameable_language_uploads_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            captions = FakeCaptions()
            channel = SimpleNamespace(channel_id="x", agent=SimpleNamespace(language="Klingon"))
            up = uploader(channel=channel, token_file=self._token(tmp, [CAPTION_SCOPE]),
                          service=FakeService(captions))
            self.assertFalse(up.upload_captions("vid1", self._srt(tmp)))
            self.assertEqual(captions.calls, [])


class UploadWiringTestCase(unittest.TestCase):
    """What reaches videos.insert, and what a caller that opts into neither gets."""

    class _Insert:
        def __init__(self, recorder):
            self.recorder = recorder

        def next_chunk(self):
            return None, {"id": "vid1"}

    def _service(self, recorder):
        insert = self._Insert(recorder)
        parent = self

        class Videos:
            def insert(self, **kwargs):
                recorder.append(kwargs)
                return insert

        class Service:
            def videos(self_inner):
                return Videos()

            def captions(self_inner):
                raise AssertionError("captions must not be touched without a path")

        return Service()

    def setUp(self):
        # MediaFileUpload opens the file, so the video has to exist on disk.
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.video = Path(self._tmp.name) / "video.mp4"
        self.video.write_bytes(b"not really an mp4")

    def test_a_timeline_puts_measured_chapters_in_the_description(self):
        recorder = []
        sections = [section("hook", "They found it."), section("story", "Then this."),
                    section("end", "And that.")]
        up = uploader(service=self._service(recorder))
        with patch.object(YouTubeUploader, "upload_captions") as captions:
            up.upload(
                self.video,
                script("A ship.\n0:00 Invented", sections),
                section_timeline=timeline(("hook", 0, 15), ("story", 15, 45), ("end", 45, 90)),
            )
        description = recorder[0]["body"]["snippet"]["description"]
        self.assertIn("Chapters:", description)
        self.assertNotIn("Invented", description)
        captions.assert_not_called()

    def test_without_a_timeline_the_description_is_untouched(self):
        # A Short passes its own description and no timeline; it must arrive
        # exactly as the caller wrote it.
        recorder = []
        up = uploader(service=self._service(recorder))
        up.upload(self.video, script("A ship.\n0:00 Invented"),
                  description_override="Full video: https://youtu.be/x")
        self.assertEqual(recorder[0]["body"]["snippet"]["description"],
                         "Full video: https://youtu.be/x")

    def test_captions_are_attempted_only_when_a_path_is_given(self):
        recorder = []
        up = uploader(service=self._service(recorder))
        with patch.object(YouTubeUploader, "upload_captions", return_value=True) as captions:
            up.upload(self.video, script("A ship."), captions_path=Path("subs.srt"))
        captions.assert_called_once_with("vid1", Path("subs.srt"))


class MetadataLanguageTestCase(unittest.TestCase):
    """snippet.defaultLanguage follows the channel; it was hard-coded to "en"."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.video = Path(self._tmp.name) / "video.mp4"
        self.video.write_bytes(b"not really an mp4")
        self.sent = []

    def _upload(self, channel):
        helper = UploadWiringTestCase()
        up = uploader(channel=channel, service=helper._service(self.sent))
        up.upload(self.video, script("A ship."))
        return self.sent[-1]["body"]

    @staticmethod
    def _channel(language):
        return SimpleNamespace(channel_id="x", agent=SimpleNamespace(language=language))

    def test_english_russian_and_uzbek_channels_are_labelled_as_such(self):
        for language, code in (("English", "en"), ("Russian", "ru"), ("Uzbek", "uz"),
                               ("ru", "ru"), ("uz", "uz")):
            body = self._upload(self._channel(language))
            self.assertEqual(body["snippet"]["defaultLanguage"], code, language)

    def test_an_unknown_language_sends_no_label_at_all(self):
        # Neither a guess ("en") nor a typo'd code may reach videos.insert.
        for language in ("Klingon", "zz", "zz-Latn"):
            snippet = self._upload(self._channel(language))["snippet"]
            self.assertNotIn("defaultLanguage", snippet, language)

    def test_caption_track_and_metadata_cannot_disagree(self):
        for language in ("English", "Russian", "Uzbek", "Spanish", "pt-BR", "Klingon", "zz"):
            channel = self._channel(language)
            sent_language = self._upload(channel)["snippet"].get("defaultLanguage")
            self.assertEqual(sent_language, caption_language(channel), language)
            self.assertEqual(sent_language, content_language(channel), language)

    def test_the_caption_track_for_a_russian_video_says_russian(self):
        captions = FakeCaptions()
        srt = Path(self._tmp.name) / "subtitles.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:02,000\nПривет\n", encoding="utf-8")
        up = uploader(channel=self._channel("Russian"), service=FakeService(captions))
        with patch.object(YouTubeUploader, "_granted_scopes", return_value=set()):
            self.assertTrue(up.upload_captions("vid1", srt))
        self.assertEqual(captions.calls[0]["body"]["snippet"]["language"], "ru")

    def test_an_english_channel_request_is_identical_to_before_the_fix(self):
        # The whole body, not one key: nothing but the language label may move.
        expected = {
            "snippet": {
                "title": "T",
                "description": "A ship.",
                "tags": ["a"],
                "categoryId": youtube_uploader.YOUTUBE_CATEGORY_ID,
                "defaultLanguage": "en",
            },
            "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False},
        }
        for channel in (None, self._channel("English")):
            self.sent.clear()
            with patch.object(youtube_uploader, "YOUTUBE_PRIVACY", "private"):
                self.assertEqual(self._upload(channel), expected)

    def test_other_languages_change_only_the_label(self):
        english = self._upload(self._channel("English"))
        english_without = {**english, "snippet": {k: v for k, v in english["snippet"].items()
                                                  if k != "defaultLanguage"}}
        for language, code in (("Russian", "ru"), ("Uzbek", "uz")):
            body = self._upload(self._channel(language))
            self.assertEqual(body["snippet"].pop("defaultLanguage"), code)
            self.assertEqual(body, english_without)


class ClosedLanguageTableTestCase(unittest.TestCase):
    def test_a_code_is_taken_only_if_its_language_is_in_the_table(self):
        for code in ("en", "ru", "uz", "pt-BR", "en-US"):
            channel = SimpleNamespace(agent=SimpleNamespace(language=code))
            self.assertEqual(content_language(channel), code)
        for code in ("zz", "xx-YY", "ja"):
            channel = SimpleNamespace(agent=SimpleNamespace(language=code))
            self.assertIsNone(content_language(channel), code)


if __name__ == "__main__":
    unittest.main()
