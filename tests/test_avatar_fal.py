"""The fal.ai presenter (modules/avatar_fal.py).

The load-bearing guarantees, each pinned by a test that names what would break:

* nothing is ever sent before the safety guard and the seconds / USD ceilings have
  passed, so a refused request costs exactly nothing;
* the request is the one fal.ai publishes (host, auth header, model id, fields);
* what fal billed reaches the cost ledger, and the run's USD caps see it;
* the presenter is off unless NIGHTSHIFT_AVATAR_ENABLED says so.

No test makes a network call: the HTTP layer, the audio tools and the portrait
maker are fakes, and ``requests.Session`` is patched to explode wherever a real one
could have been built.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from modules import avatar, avatar_fal, spend_guard
from modules.avatar import (
    AvatarConfig,
    AvatarUnavailable,
    PresenterSegment,
    UnsafeAvatarRequest,
    avatar_provider,
    describe_presenter,
    maybe_generate_presenter,
    planned_presenter_usd,
    preflight_avatar,
    presenter_segments,
    resolve_avatar_config,
)
from modules.avatar_fal import (
    AVATAR_SECONDS,
    DEFAULT_MODEL,
    FalAvatarProvider,
    FalAvatarSettings,
    check_ceilings,
    plan_slices,
)
from modules.cost_ledger import CostLedger

KEY = "fal-test-key-not-real"
CDN = "https://cdn.example/files"
CHARACTER = "a friendly cartoon fox in a blue scarf"


class Resp:
    def __init__(self, status=200, body=None, text="", chunks=()):
        self.status_code = status
        self._body = body
        self.text = text or (json.dumps(body) if body is not None else "")
        self.content = self.text.encode() if (body is not None or text) else b""
        self._chunks = list(chunks)

    def json(self):
        return self._body

    def iter_content(self, chunk_size=0):
        return iter(self._chunks)


class Clock:
    def __init__(self):
        self.now = 0.0

    def sleep(self, seconds):
        self.now += seconds

    def monotonic(self):
        return self.now


class FakeFal:
    """fal.ai as the published schema describes it: a CDN upload, a queue, a result."""

    def __init__(self, statuses=("IN_QUEUE", "IN_PROGRESS", "COMPLETED"), duration=15.0, video=b"MP4DATA"):
        self.calls = []
        self.statuses = list(statuses)
        self.duration = duration
        self.video = video
        self.submit_override = None
        self.result_override = None
        self.status_error = None
        self.uploads = 0
        self.submits = 0

    # session surface used by the provider
    def post(self, url, **kw):
        self.calls.append(("post", url, kw))
        if "/storage/upload/initiate" in url:
            self.uploads += 1
            name = kw["json"]["file_name"]
            return Resp(200, {"upload_url": f"https://upload.example/{self.uploads}", "file_url": f"{CDN}/{name}"})
        self.submits += 1
        if self.submit_override is not None:
            return self.submit_override
        return Resp(200, {"request_id": "req-1", "status": "IN_QUEUE",
                          "status_url": "https://queue.fal.run/x/requests/req-1/status",
                          "response_url": "https://queue.fal.run/x/requests/req-1",
                          "cancel_url": "https://queue.fal.run/x/requests/req-1/cancel"})

    def put(self, url, **kw):
        self.calls.append(("put", url, kw))
        return Resp(200, {"success": True}, text="{}")

    def get(self, url, **kw):
        self.calls.append(("get", url, kw))
        if url.endswith("/status"):
            if self.status_error is not None:
                return self.status_error
            status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
            return Resp(200, {"status": status, "request_id": "req-1"})
        if url.endswith("/requests/req-1"):
            if self.result_override is not None:
                return self.result_override
            body = {"video": {"url": "https://v3.fal.media/files/out.mp4"}}
            if self.duration is not None:
                body["duration"] = self.duration
            return Resp(200, body)
        if url.endswith("out.mp4"):
            return Resp(200, chunks=[self.video] if self.video else [])
        raise AssertionError(f"unexpected GET {url}")

    def urls(self, method=None):
        return [u for m, u, _ in self.calls if method in (None, m)]


class FakeAudio:
    def __init__(self, seconds=120.0):
        self.seconds = seconds
        self.cuts = []

    def length_s(self, path):
        return self.seconds

    def cut(self, path, start_s, end_s, dest):
        self.cuts.append((start_s, end_s))
        Path(dest).write_bytes(f"AUDIO:{start_s}-{end_s}".encode())
        return Path(dest)


class FakePortrait:
    def __init__(self, result="png"):
        self.calls = []
        self.result = result

    def __call__(self, prompt, dest, width, height, image_model, api_key):
        self.calls.append({"prompt": prompt, "dest": dest, "size": (width, height), "model": image_model,
                           "key": api_key})
        if self.result is None:
            return None
        Path(dest).write_bytes(b"PNGDATA")
        return Path(dest)


def env(**kw):
    base = {"FAL_KEY": KEY}
    base.update(kw)
    return base


class Case(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.narration = self.dir / "narration.mp3"
        self.narration.write_bytes(b"x")
        self.out = self.dir / "presenter.mp4"
        self.fal = FakeFal()
        self.audio = FakeAudio()
        self.portrait = FakePortrait()
        self.clock = Clock()
        self.spent = []

    def provider(self, **environment):
        return FalAvatarProvider(session=self.fal, audio=self.audio, portrait=self.portrait,
                                 sleep=self.clock.sleep, monotonic=self.clock.monotonic,
                                 env=env(**environment))

    def run_it(self, prompt=CHARACTER, ref=None, **environment):
        return self.provider(**environment).generate_segments(
            prompt, ref, self.out, narration_path=self.narration, frame_size=(1280, 720),
            on_spend=lambda *a: self.spent.append(a))

    def assertNothingSent(self):
        self.assertEqual(self.fal.calls, [], "a request was made")
        self.assertEqual(self.portrait.calls, [], "the portrait was generated")
        self.assertEqual(self.audio.cuts, [], "audio was cut")


class Settings(unittest.TestCase):
    def test_defaults_are_cheap_and_the_cheaper_model(self):
        s = FalAvatarSettings.from_env({})
        self.assertEqual(s.model, "fal-ai/kling-video/ai-avatar/v2/standard")
        self.assertEqual((s.intro_seconds, s.outro_seconds, s.max_seconds), (15.0, 15.0, 30.0))
        self.assertEqual(s.usd_per_second, 0.06)
        self.assertEqual(s.max_usd, 1.81)  # 30 s x 0.06 + the portrait allowance

    def test_the_model_is_overridable_and_a_blank_means_the_default(self):
        self.assertEqual(FalAvatarSettings.from_env({avatar_fal.MODEL_ENV: " fal-ai/other/model/ "}).model,
                         "fal-ai/other/model")
        self.assertEqual(FalAvatarSettings.from_env({avatar_fal.MODEL_ENV: "  "}).model, DEFAULT_MODEL)

    def test_segment_and_run_hard_caps_cannot_be_raised_by_a_variable(self):
        s = FalAvatarSettings.from_env({avatar_fal.INTRO_ENV: "99", avatar_fal.OUTRO_ENV: "31",
                                        avatar_fal.MAX_SECONDS_ENV: "500"})
        self.assertEqual((s.intro_seconds, s.outro_seconds, s.max_seconds), (30.0, 30.0, 60.0))

    def test_a_typo_never_removes_a_brake(self):
        for bad in ("abc", "-5", "nan", "inf", "0"):
            s = FalAvatarSettings.from_env({avatar_fal.MAX_SECONDS_ENV: bad, avatar_fal.PRICE_ENV: bad})
            self.assertEqual((s.max_seconds, s.usd_per_second), (30.0, 0.06), bad)

    def test_a_zero_segment_switches_that_segment_off(self):
        s = FalAvatarSettings.from_env({avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual((s.intro_seconds, s.outro_seconds), (15.0, 0.0))

    def test_the_usd_cap_follows_the_price_unless_pinned(self):
        self.assertEqual(FalAvatarSettings.from_env({avatar_fal.PRICE_ENV: "0.1"}).max_usd, 3.01)
        self.assertEqual(FalAvatarSettings.from_env({avatar_fal.MAX_USD_ENV: "0.5"}).max_usd, 0.5)


class Slicing(unittest.TestCase):
    S = FalAvatarSettings.from_env({})

    def test_intro_from_the_start_and_outro_ending_where_the_narration_ends(self):
        self.assertEqual(plan_slices(120.0, self.S), [("intro", 0.0, 15.0), ("outro", 105.0, 15.0)])

    def test_slices_never_overlap_on_a_short_narration(self):
        plan = plan_slices(20.0, self.S)
        self.assertEqual(plan, [("intro", 0.0, 15.0), ("outro", 15.0, 5.0)])

    def test_a_sliver_is_skipped_not_paid_for(self):
        self.assertEqual(plan_slices(16.0, self.S), [("intro", 0.0, 15.0)])
        self.assertEqual(plan_slices(1.5, self.S), [])

    def test_an_outro_only_setup_keeps_its_label_and_position(self):
        s = FalAvatarSettings.from_env({avatar_fal.INTRO_ENV: "0"})
        self.assertEqual(plan_slices(60.0, s), [("outro", 45.0, 15.0)])


class Ceilings(Case):
    def test_seconds_over_the_cap_refuse_with_the_variable_to_change(self):
        s = FalAvatarSettings.from_env({avatar_fal.MAX_SECONDS_ENV: "20"})
        with self.assertRaises(AvatarUnavailable) as caught:
            check_ceilings(s, 30.0)
        self.assertIn("NIGHTSHIFT_AVATAR_MAX_SECONDS", str(caught.exception))
        check_ceilings(s, 20.0)  # exactly at the cap is allowed

    def test_usd_over_the_cap_refuses(self):
        s = FalAvatarSettings.from_env({avatar_fal.MAX_USD_ENV: "1.00"})
        with self.assertRaises(AvatarUnavailable) as caught:
            check_ceilings(s, 20.0)  # 20 x 0.06 + 0.01 = 1.21
        self.assertIn("NIGHTSHIFT_AVATAR_MAX_USD", str(caught.exception))
        check_ceilings(s, 16.0)  # 0.97

    def test_a_configured_presenter_over_the_seconds_cap_sends_nothing(self):
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.MAX_SECONDS_ENV: "20"})  # 15 + 15 > 20
        self.assertNothingSent()

    def test_a_configured_presenter_over_the_usd_cap_sends_nothing(self):
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.MAX_USD_ENV: "0.50"})
        self.assertNothingSent()

    def test_the_ceiling_is_checked_before_the_portrait_which_is_also_billed(self):
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.MAX_USD_ENV: "0.02"})
        self.assertEqual(self.portrait.calls, [])

    def test_both_segments_off_is_a_loud_misconfiguration(self):
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it(**{avatar_fal.INTRO_ENV: "0", avatar_fal.OUTRO_ENV: "0"})
        self.assertIn("nothing to render", str(caught.exception))
        self.assertNothingSent()

    def test_a_narration_too_short_for_any_slice_sends_nothing(self):
        self.audio.seconds = 1.5
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(self.fal.calls, [])
        self.assertEqual(self.portrait.calls, [])

    def test_the_run_cap_in_the_spend_guard_sees_the_presenter_before_it_is_bought(self):
        costs = CostLedger()
        with self.assertRaises(spend_guard.SpendLimitExceeded):
            spend_guard.check(costs, "generating the presenter", extra_usd=1.81,
                              env={"CHRONOS_MAX_RUN_USD": "1"})
        spend_guard.check(costs, "generating the presenter", extra_usd=0.0, env={"CHRONOS_MAX_RUN_USD": "1"})
        spend_guard.check(costs, "generating the presenter", extra_usd=0.9, env={"CHRONOS_MAX_RUN_USD": "1"})


class MissingKey(Case):
    def test_names_exactly_what_to_set_and_sends_nothing(self):
        with self.assertRaises(AvatarUnavailable) as caught:
            self.provider(FAL_KEY="").preflight()
        text = str(caught.exception)
        self.assertIn("FAL_KEY", text)
        self.assertIn("prepaid", text)
        self.assertIn(DEFAULT_MODEL, text)
        self.assertNotIn(KEY, text)
        with self.assertRaises(AvatarUnavailable):
            self.run_it(FAL_KEY="  ")
        self.assertNothingSent()


class Guard(Case):
    def test_a_real_person_description_never_reaches_the_network(self):
        for prompt in ("a photo of my neighbour", "a deepfake of a politician", "clone a celebrity"):
            with self.assertRaises(UnsafeAvatarRequest):
                self.run_it(prompt=prompt)
        self.assertNothingSent()

    def test_a_photo_url_reference_is_refused(self):
        with self.assertRaises(UnsafeAvatarRequest):
            self.run_it(ref="https://example.com/person.jpg")
        self.assertNothingSent()

    def test_the_guard_runs_before_the_key_check(self):
        with self.assertRaises(UnsafeAvatarRequest):
            self.run_it(prompt="a deepfake of an actor", FAL_KEY="")

    def test_the_guard_fires_through_the_pipeline_entry_point_too(self):
        cfg = AvatarConfig(enabled=True, provider="fal", character_prompt="impersonate the president")
        with mock.patch.dict(os.environ, {"FAL_KEY": KEY}), \
                mock.patch("requests.Session", side_effect=AssertionError("a session was opened")):
            with self.assertRaises(UnsafeAvatarRequest):
                maybe_generate_presenter(cfg, "", self.out, narration_path=self.narration)
            with self.assertRaises(UnsafeAvatarRequest):
                preflight_avatar(cfg)

    def test_the_generate_entry_point_of_the_protocol_also_guards(self):
        with self.assertRaises(UnsafeAvatarRequest):
            self.provider().generate("a lookalike of a singer", None, self.out)

    def test_the_portrait_prompt_describes_an_invented_character_and_does_not_trip_the_guard(self):
        self.run_it()
        prompt = self.portrait.calls[0]["prompt"]
        self.assertIn(CHARACTER, prompt)
        self.assertIn("invented", prompt)
        avatar.synthetic_only_guard(None, prompt)  # our own wrapper must pass the rule we enforce


class RequestShape(Case):
    def test_the_published_request_is_what_is_sent(self):
        self.run_it()
        submits = [(u, kw) for m, u, kw in self.fal.calls if m == "post" and "queue.fal.run" in u]
        self.assertEqual(len(submits), 2)  # intro and outro
        url, kw = submits[0]
        self.assertEqual(url, f"https://queue.fal.run/{DEFAULT_MODEL}")
        self.assertEqual(kw["headers"], {"Authorization": f"Key {KEY}"})
        self.assertEqual(set(kw["json"]), {"image_url", "audio_url", "prompt"})
        self.assertEqual(kw["json"]["image_url"], f"{CDN}/presenter_portrait.png")
        self.assertEqual(kw["json"]["audio_url"], f"{CDN}/presenter_intro.mp3")
        self.assertEqual(submits[1][1]["json"]["audio_url"], f"{CDN}/presenter_outro.mp3")

    def test_the_model_id_is_configurable_end_to_end(self):
        self.run_it(**{avatar_fal.MODEL_ENV: "fal-ai/kling-video/ai-avatar/v2/pro"})
        self.assertIn("https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/pro", self.fal.urls("post"))

    def test_files_go_up_through_the_documented_two_step_cdn_upload(self):
        self.run_it()
        initiates = [(u, kw) for m, u, kw in self.fal.calls if "storage/upload/initiate" in u]
        self.assertEqual(initiates[0][0], "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3")
        self.assertEqual(initiates[0][1]["json"], {"file_name": "presenter_portrait.png", "content_type": "image/png"})
        self.assertEqual(initiates[1][1]["json"]["content_type"], "audio/mpeg")
        puts = [kw for m, u, kw in self.fal.calls if m == "put" and u.startswith("https://upload.example")]
        self.assertEqual(puts[0]["data"], b"PNGDATA")
        self.assertEqual(puts[1]["data"], b"AUDIO:0.0-15.0")

    def test_the_portrait_is_uploaded_once_for_both_segments(self):
        self.run_it()
        names = [kw["json"]["file_name"] for m, u, kw in self.fal.calls if "storage/upload/initiate" in u]
        self.assertEqual(names.count("presenter_portrait.png"), 1)

    def test_the_audio_is_cut_at_the_intro_and_the_outro_of_the_narration(self):
        self.audio.seconds = 200.0
        segments = self.run_it(**{avatar_fal.INTRO_ENV: "10", avatar_fal.OUTRO_ENV: "12"})
        self.assertEqual(self.audio.cuts, [(0.0, 10.0), (188.0, 200.0)])
        self.assertEqual([(s.start, s.seconds) for s in segments], [(0.0, 10.0), (188.0, 12.0)])

    def test_the_portrait_is_made_from_the_character_at_the_frame_size_on_the_portrait_model(self):
        self.run_it(**{avatar_fal.IMAGE_MODEL_ENV: "fal-ai/flux/dev"})
        call = self.portrait.calls[0]
        self.assertEqual(call["size"], (1280, 720))
        self.assertEqual(call["model"], "fal-ai/flux/dev")
        self.assertEqual(call["key"], KEY)

    def test_the_default_portrait_model_is_the_cheap_one(self):
        self.run_it()
        self.assertEqual(self.portrait.calls[0]["model"], "fal-ai/flux/schnell")

    def test_a_blank_character_gets_a_neutral_invented_one(self):
        self.run_it(prompt="")
        self.assertIn(avatar_fal._DEFAULT_CHARACTER, self.portrait.calls[0]["prompt"])


class PollingAndResult(Case):
    def test_it_polls_until_completed_then_fetches_the_result_and_downloads(self):
        segments = self.run_it()
        self.assertEqual([s.path.name for s in segments], ["presenter_intro.mp4", "presenter_outro.mp4"])
        self.assertEqual(segments[0].path.read_bytes(), b"MP4DATA")
        gets = self.fal.urls("get")
        self.assertIn("https://queue.fal.run/x/requests/req-1/status", gets)
        self.assertIn("https://queue.fal.run/x/requests/req-1", gets)  # response_url from the submit answer
        self.assertIn("https://v3.fal.media/files/out.mp4", gets)
        # the result is fetched only after the status said COMPLETED
        self.assertLess(gets.index("https://queue.fal.run/x/requests/req-1/status"),
                        gets.index("https://queue.fal.run/x/requests/req-1"))
        self.assertGreaterEqual(self.clock.now, 10.0)  # slept between polls (2 waits x 2 segments x 5 s)

    def test_the_status_url_is_built_when_the_submit_answer_has_none(self):
        self.fal.submit_override = Resp(200, {"request_id": "req-1"})
        self.fal.calls.clear()
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertIn(f"https://queue.fal.run/{DEFAULT_MODEL}/requests/req-1/status", self.fal.urls("get"))

    def test_a_failed_request_is_completed_with_an_error_and_ships_nothing(self):
        failing = FakeFal()
        failing.get = lambda url, **kw: (failing.calls.append(("get", url, kw)) or
                                         Resp(200, {"status": "COMPLETED", "error": "audio too short"}))
        self.fal = failing
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("audio too short", str(caught.exception))
        self.assertEqual(self.spent[-1][0], "image_generations")  # only the portrait was paid for
        self.assertFalse((self.dir / "presenter_intro.mp4").exists())

    def test_an_error_answer_from_the_result_call_stops_the_run(self):
        self.fal.result_override = Resp(422, {"detail": "bad audio"})
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("422", str(caught.exception))
        self.assertFalse(any(unit == AVATAR_SECONDS for unit, *_ in self.spent))

    def test_a_result_without_a_video_url_stops_the_run(self):
        self.fal.result_override = Resp(200, {"duration": 15})
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("no video url", str(caught.exception))

    def test_an_empty_download_is_not_shipped(self):
        self.fal.video = b""
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertFalse(any(unit == AVATAR_SECONDS for unit, *_ in self.spent))

    def test_a_job_that_never_finishes_is_cancelled_and_reported(self):
        self.fal.statuses = ["IN_PROGRESS"]
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("did not finish", str(caught.exception))
        self.assertIn("https://queue.fal.run/x/requests/req-1/cancel", self.fal.urls("put"))
        self.assertGreaterEqual(self.clock.now, 600.0)
        self.assertEqual(self.fal.submits, 1, "the second segment must not be submitted after a timeout")

    def test_a_few_transient_status_errors_are_ridden_out(self):
        flaky = [Resp(503, text="busy")] * 3
        real_get = self.fal.get

        def get(url, **kw):
            if url.endswith("/status") and flaky:
                self.fal.calls.append(("get", url, kw))
                return flaky.pop()
            return real_get(url, **kw)

        self.fal.get = get
        self.assertEqual(len(self.run_it()), 2)  # three 503s, then the job completes

    def test_a_status_endpoint_that_stays_down_ends_the_wait(self):
        self.fal.status_error = Resp(503, text="down")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertLess(self.clock.now, 600.0, "it kept polling a dead endpoint until the deadline")

    def test_a_status_answer_that_is_not_transient_ends_the_wait_at_once(self):
        self.fal.status_error = Resp(404, text="no such request")
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("404", str(caught.exception))
        self.assertEqual(len([u for u in self.fal.urls("get") if u.endswith("/status")]), 1)

    def test_a_submit_without_a_request_id_is_refused(self):
        self.fal.submit_override = Resp(200, {"status": "IN_QUEUE"})
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("request_id", str(caught.exception))


class Refusals(Case):
    def test_an_exhausted_balance_says_to_top_up_and_never_prints_the_key(self):
        self.fal.submit_override = Resp(403, text='{"detail": "Exhausted balance. Top up your balance"}')
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        text = str(caught.exception)
        self.assertIn("top up", text.lower())
        self.assertIn("403", text)
        self.assertNotIn(KEY, text)

    def test_a_rejected_key_says_to_check_the_key(self):
        self.fal.submit_override = Resp(401, text='{"detail": "Invalid key"}')
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("credentials", str(caught.exception))

    def test_a_failed_upload_is_named_as_an_upload(self):
        original = self.fal.post
        self.fal.post = lambda url, **kw: (Resp(500, text="boom") if "storage/upload" in url else original(url, **kw))
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("upload", str(caught.exception))

    def test_a_dropped_connection_becomes_an_unavailable_presenter(self):
        import requests

        def post(url, **kw):
            raise requests.ConnectionError("no route")

        self.fal.post = post
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("ConnectionError", str(caught.exception))

    def test_a_portrait_the_image_model_would_not_make_stops_before_any_video_is_bought(self):
        self.portrait.result = None
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("portrait", str(caught.exception))
        self.assertEqual(self.fal.submits, 0)


class Ledger(Case):
    def test_the_billed_seconds_are_recorded_as_an_estimate_at_the_configured_price(self):
        self.fal.duration = 14.5
        self.run_it(**{avatar_fal.PRICE_ENV: "0.0562"})
        video = [s for s in self.spent if s[0] == AVATAR_SECONDS]
        self.assertEqual(video, [(AVATAR_SECONDS, 14.5, "avatar:fal", round(14.5 * 0.0562, 6))] * 2)

    def test_without_a_reported_duration_the_slice_length_is_recorded(self):
        self.fal.duration = None
        self.run_it()
        self.assertEqual([s[1] for s in self.spent if s[0] == AVATAR_SECONDS], [15.0, 15.0])

    def test_the_portrait_is_recorded_as_an_fal_image(self):
        self.run_it()
        self.assertEqual(self.spent[0], ("image_generations", 1.0, "image:fal", avatar_fal.PORTRAIT_USD))

    def test_a_cost_ledger_prices_the_entry_with_the_given_estimate_not_unpriced(self):
        costs = CostLedger()
        costs.add(AVATAR_SECONDS, 30, stage="avatar:fal", estimated_usd=1.8)
        entry = costs.entries[0]
        self.assertEqual((entry.unit, entry.quantity, entry.stage, entry.estimated_usd),
                         (AVATAR_SECONDS, 30.0, "avatar:fal", 1.8))
        self.assertEqual(costs.priced_usd(), 1.8)  # what the spend guard reads
        self.assertEqual(costs.unpriced_units(), [])

    def test_the_ledger_still_prices_by_operator_rate_when_no_estimate_is_given(self):
        costs = CostLedger()
        with mock.patch.dict(os.environ, {"CHRONOS_PRICE_TTS_CHARACTERS": "0.001"}):
            costs.add("tts_characters", 10)
        costs.add("tts_characters", 10)
        self.assertEqual([e.estimated_usd for e in costs.entries], [0.01, None])

    def test_a_nonsense_estimate_falls_back_instead_of_corrupting_the_ledger(self):
        costs = CostLedger()
        for bad in ("abc", -1, float("inf")):
            costs.add(AVATAR_SECONDS, 1, estimated_usd=bad)
        self.assertEqual([e.estimated_usd for e in costs.entries], [None, None, None])

    def test_what_was_spent_stays_recorded_when_a_later_step_fails(self):
        self.fal.result_override = Resp(500, text="boom")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual([s[0] for s in self.spent], ["image_generations"])


class Reuse(Case):
    def test_a_retry_of_the_same_run_buys_nothing_twice(self):
        self.run_it()
        calls, spent = len(self.fal.calls), len(self.spent)
        self.run_it()
        self.assertEqual(len(self.fal.calls), calls, "the second attempt called fal again")
        self.assertEqual(len(self.spent), spent, "the second attempt was billed again")
        self.assertEqual(len(self.portrait.calls), 1)

    def test_a_clip_made_for_other_words_is_never_reused(self):
        self.run_it()
        submits = self.fal.submits
        def other_words(path, start, end, dest):
            Path(dest).write_bytes(b"DIFFERENT")
            return Path(dest)

        self.audio.cut = other_words
        self.run_it()
        self.assertEqual(self.fal.submits, submits + 2)

    def test_a_clip_made_by_another_model_is_never_reused(self):
        self.run_it()
        submits = self.fal.submits
        self.run_it(**{avatar_fal.MODEL_ENV: "fal-ai/kling-video/ai-avatar/v2/pro"})
        self.assertEqual(self.fal.submits, submits + 2)


class SelectionAndOffByDefault(unittest.TestCase):
    def test_off_by_default_nothing_is_built_and_nothing_is_planned(self):
        with mock.patch.dict(os.environ, {"FAL_KEY": KEY}, clear=False):
            cfg = AvatarConfig(enabled=False, provider="fal")
            self.assertIsNone(avatar_provider(cfg))
            self.assertIsNone(maybe_generate_presenter(cfg, "x", Path("/nonexistent/p.mp4")))
            self.assertEqual(planned_presenter_usd(cfg), 0.0)
            preflight_avatar(cfg)  # a no-op, even though the key is there

    def test_the_provider_env_alone_does_not_turn_the_presenter_on(self):
        keep = {k: v for k, v in os.environ.items() if not k.startswith("NIGHTSHIFT_AVATAR")}
        with mock.patch.dict(os.environ, keep, clear=True), \
                mock.patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_PROVIDER": "fal", "FAL_KEY": KEY}):
            cfg = resolve_avatar_config()
        self.assertEqual(cfg.provider, "fal")
        self.assertFalse(cfg.enabled)

    def test_the_provider_name_selects_fal_in_any_case(self):
        for name in ("fal", "FAL", " Fal "):
            self.assertIsInstance(avatar_provider(AvatarConfig(enabled=True, provider=name)), FalAvatarProvider)

    def test_higgsfield_is_still_selected_and_an_unknown_name_still_fails(self):
        self.assertIsInstance(avatar_provider(AvatarConfig(enabled=True, provider="higgsfield")),
                              avatar.HiggsfieldAvatarProvider)
        with self.assertRaises(AvatarUnavailable) as caught:
            avatar_provider(AvatarConfig(enabled=True, provider="fall"))
        self.assertIn("fal", str(caught.exception))

    def test_preflight_for_fal_without_a_key_raises_before_any_request(self):
        cfg = AvatarConfig(enabled=True, provider="fal", character_prompt=CHARACTER)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}), \
                mock.patch("requests.Session", side_effect=AssertionError("a session was opened")), \
                mock.patch("requests.post", side_effect=AssertionError("a request was made")):
            with self.assertRaises(AvatarUnavailable) as caught:
                preflight_avatar(cfg)
        self.assertIn("FAL_KEY", str(caught.exception))

    def test_preflight_for_fal_with_a_key_and_default_settings_passes(self):
        cfg = AvatarConfig(enabled=True, provider="fal", character_prompt=CHARACTER)
        with mock.patch.dict(os.environ, {"FAL_KEY": KEY}):
            preflight_avatar(cfg)

    def test_the_fal_presenter_needs_the_narration(self):
        cfg = AvatarConfig(enabled=True, provider="fal", character_prompt=CHARACTER)
        with mock.patch.dict(os.environ, {"FAL_KEY": KEY}):
            with self.assertRaises(AvatarUnavailable) as caught:
                maybe_generate_presenter(cfg, "", Path("/nonexistent/p.mp4"))
        self.assertIn("narration", str(caught.exception))

    def test_the_planned_figure_is_the_worst_case_of_the_fal_settings(self):
        cfg = AvatarConfig(enabled=True, provider="fal")
        with mock.patch.dict(os.environ, {"NIGHTSHIFT_AVATAR_FAL_USD_PER_SECOND": ""}):
            self.assertEqual(planned_presenter_usd(cfg), 1.81)
        self.assertEqual(planned_presenter_usd(AvatarConfig(enabled=True, provider="higgsfield")), 0.0)

    def test_the_pipeline_entry_point_hands_the_provider_what_it_needs(self):
        seen = {}

        class Fake:
            def generate_segments(self, prompt, ref, out_path, **kw):
                seen.update(prompt=prompt, ref=ref, out=out_path, **kw)
                return ["segments"]

        with mock.patch.object(avatar, "avatar_provider", return_value=Fake()):
            hook = object()
            got = maybe_generate_presenter(AvatarConfig(enabled=True, provider="fal"), " a fox ", Path("/o/p.mp4"),
                                           narration_path="/o/n.mp3", frame_size=(720, 1280), on_spend=hook)
        self.assertEqual(got, ["segments"])
        self.assertEqual((seen["prompt"], seen["frame_size"], seen["on_spend"]), ("a fox", (720, 1280), hook))
        self.assertEqual(seen["narration_path"], Path("/o/n.mp3"))


class PresenterShapes(unittest.TestCase):
    def test_one_clip_plays_from_the_start_segments_keep_their_places(self):
        self.assertEqual(presenter_segments(None), [])
        self.assertEqual(presenter_segments(Path("a.mp4")), [PresenterSegment(Path("a.mp4"), 0.0, None)])
        segs = [PresenterSegment(Path("i.mp4"), 0.0, 15.0), PresenterSegment(Path("o.mp4"), 105.0, 15.0)]
        self.assertEqual(presenter_segments(segs), segs)
        self.assertEqual(describe_presenter(segs), ["i.mp4", "o.mp4"])
        self.assertEqual(describe_presenter(None), [])


class WiredLikeTheOthers(unittest.TestCase):
    """main.py imports the whole render stack, so its wiring is read, not run."""

    ROOT = Path(__file__).resolve().parent.parent

    def test_main_hands_the_presenter_the_narration_the_frame_and_the_ledger(self):
        import ast

        tree = ast.parse((self.ROOT / "main.py").read_text())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and getattr(n.func, "id", "") == "maybe_generate_presenter"]
        self.assertEqual(len(calls), 1)
        self.assertEqual({k.arg for k in calls[0].keywords}, {"narration_path", "frame_size", "on_spend"})

    def test_main_gates_the_presenter_with_its_planned_dollars(self):
        text = (self.ROOT / "main.py").read_text()
        self.assertIn('_guard_spend(ctx, costs, "generating the presenter", extra_usd=planned_presenter_usd(avatar_cfg))',
                      text)

    def test_every_new_setting_reaches_the_worker_and_the_actions_run(self):
        names = [avatar_fal.MODEL_ENV, avatar_fal.IMAGE_MODEL_ENV, avatar_fal.INTRO_ENV, avatar_fal.OUTRO_ENV,
                 avatar_fal.MAX_SECONDS_ENV, avatar_fal.PRICE_ENV, avatar_fal.MAX_USD_ENV,
                 "NIGHTSHIFT_AVATAR_PROVIDER"]
        example = (self.ROOT / "deploy" / ".env.worker.example").read_text()
        deploy = (self.ROOT / ".github" / "workflows" / "deploy_web.yml").read_text()
        daily = (self.ROOT / ".github" / "workflows" / "daily_video.yml").read_text()
        for name in names:
            self.assertIn(f"\n{name}=\n", example, name)
            self.assertIn(f"WORKERENV_{name}: ${{{{ vars.{name} }}}}", deploy, name)
            self.assertIn(f"{name}: ${{{{ vars.{name} }}}}", daily, name)
        self.assertNotIn("FAL_KEY: ${{ vars.", daily + deploy, "FAL_KEY is a secret, never a variable")

    def test_a_missing_fal_key_is_a_deploy_warning_when_the_fal_presenter_is_on(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("bwe", self.ROOT / "deploy" / "build-worker-env.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        example = (self.ROOT / "deploy" / ".env.worker.example").read_text()

        def warn(**values):
            raw = {k: "" for k in mod.example_keys(example)}
            raw.update(values)
            return "\n".join(mod.warnings(raw, example))

        text = warn(NIGHTSHIFT_AVATAR_ENABLED="true", NIGHTSHIFT_AVATAR_PROVIDER="fal")
        self.assertIn("NIGHTSHIFT_AVATAR_ENABLED is on for the avatar (fal.ai) but FAL_KEY is empty", text)
        self.assertNotIn("avatar (fal.ai)", warn(NIGHTSHIFT_AVATAR_ENABLED="true", NIGHTSHIFT_AVATAR_PROVIDER="fal",
                                                 FAL_KEY="k"))
        # the Higgsfield wording is unchanged for the default provider
        self.assertIn("HIGGSFIELD_API_KEY_ID+HIGGSFIELD_API_KEY_SECRET", warn(NIGHTSHIFT_AVATAR_ENABLED="true"))


class CompositorPlacesSegments(unittest.TestCase):
    def setUp(self):
        try:
            from moviepy.editor import ColorClip
            from modules.compositor import Compositor
        except Exception as e:  # pragma: no cover - the documented moviepy-less container
            self.skipTest(f"moviepy not importable: {e}")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.clip_path = Path(self._tmp.name) / "p.mp4"
        ColorClip((64, 36), color=(200, 0, 0), duration=3).set_fps(10).write_videofile(
            str(self.clip_path), codec="libx264", audio=False, logger=None)
        self.comp = object.__new__(Compositor)
        self.comp.width, self.comp.height, self.comp._readers = 1280, 720, {}
        self.addCleanup(lambda: [c.close() for c in self.comp._readers.values()])

    def test_the_outro_starts_where_its_slice_of_the_narration_started(self):
        clips = self.comp._build_presenter_clips(
            [PresenterSegment(self.clip_path, 0.0, 3.0), PresenterSegment(self.clip_path, 97.0, 3.0)], 100.0)
        self.assertEqual([(c.start, round(c.duration, 1)) for c in clips], [(0.0, 3.0), (97.0, 3.0)])

    def test_a_single_clip_still_plays_from_zero(self):
        clips = self.comp._build_presenter_clips(self.clip_path, 100.0)
        self.assertEqual([(c.start, round(c.duration, 1)) for c in clips], [(0.0, 3.0)])

    def test_a_segment_is_cut_to_the_video_that_remains(self):
        clips = self.comp._build_presenter_clips([PresenterSegment(self.clip_path, 98.5, 3.0)], 100.0)
        self.assertEqual([round(c.duration, 1) for c in clips], [1.5])

    def test_a_segment_that_starts_after_the_video_ends_is_left_out(self):
        self.assertEqual(self.comp._build_presenter_clips([PresenterSegment(self.clip_path, 100.0, 3.0)], 100.0), [])

    def test_an_unreadable_segment_is_left_out_on_its_own(self):
        bad = Path(self._tmp.name) / "bad.mp4"
        bad.write_bytes(b"not a video")
        clips = self.comp._build_presenter_clips(
            [PresenterSegment(bad, 0.0, 3.0), PresenterSegment(self.clip_path, 50.0, 3.0)], 100.0)
        self.assertEqual([c.start for c in clips], [50.0])


if __name__ == "__main__":
    unittest.main()
