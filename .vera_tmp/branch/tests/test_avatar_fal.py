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

import errno
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
CDN = "https://v3.fal.media/files"
CHARACTER = "a friendly cartoon fox in a blue scarf"


class Resp:
    def __init__(self, status=200, body=None, text="", chunks=(), headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
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
        self.submit_exc = None
        self.result_script = []
        self.video_script = []
        self.uploads = 0
        self.submits = 0

    # session surface used by the provider
    def post(self, url, **kw):
        self.calls.append(("post", url, kw))
        if "/storage/upload/initiate" in url:
            self.uploads += 1
            name = kw["json"]["file_name"]
            return Resp(200, {"upload_url": f"https://v3.fal.media/upload/{self.uploads}", "file_url": f"{CDN}/{name}"})
        self.submits += 1
        if self.submit_exc is not None:
            raise self.submit_exc
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
            if self.result_script:
                return self.result_script.pop(0)
            if self.result_override is not None:
                return self.result_override
            body = {"video": {"url": "https://v3.fal.media/files/out.mp4"}}
            if self.duration is not None:
                body["duration"] = self.duration
            return Resp(200, body)
        if url.endswith("out.mp4"):
            if self.video_script:
                return self.video_script.pop(0)
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
        self.assertEqual(kw["headers"]["Authorization"], f"Key {KEY}")
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
        puts = [kw for m, u, kw in self.fal.calls if m == "put" and u.startswith("https://v3.fal.media/upload/")]
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
        # fal: follow-up URLs use only owner/app; the endpoint path in them returns 405
        self.assertIn("https://queue.fal.run/fal-ai/kling-video/requests/req-1/status", self.fal.urls("get"))
        self.assertIn("https://queue.fal.run/fal-ai/kling-video/requests/req-1", self.fal.urls("get"))
        self.assertFalse([u for u in self.fal.urls("get") if "/ai-avatar/" in u])

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

    def test_a_result_without_a_video_url_stops_the_run(self):
        self.fal.result_override = Resp(200, {"duration": 15})
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("no video url", str(caught.exception))

    def test_an_empty_download_is_not_shipped(self):
        self.fal.video = b""
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertFalse((self.dir / "presenter_intro.mp4").exists())

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
    def test_the_slice_seconds_are_recorded_as_an_estimate_at_the_configured_price(self):
        self.run_it(**{avatar_fal.PRICE_ENV: "0.0562"})
        video = [x for x in self.spent if x[0] == AVATAR_SECONDS]
        self.assertEqual(video, [(AVATAR_SECONDS, 15.0, "avatar:fal", round(15.0 * 0.0562, 6))] * 2)

    def test_a_huge_or_missing_duration_from_fal_cannot_inflate_the_ledger(self):
        for duration in (9999, None, -3, "x"):
            with self.subTest(duration=duration):
                self.setUp()
                self.fal.duration = duration
                self.run_it()
                self.assertEqual([x[1] for x in self.spent if x[0] == AVATAR_SECONDS], [15.0, 15.0])
                self.assertEqual(sum(x[3] for x in self.spent if x[0] == AVATAR_SECONDS), 1.8)

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


class PaidWorkIsNeverLostOrRepaid(Case):
    """B1: money fal already took must reach the ledger, and a rerun must pick the request up."""

    def avatar_entries(self, stage="avatar:fal"):
        return [x for x in self.spent if x[0] == AVATAR_SECONDS and x[2] == stage]

    def test_a_failing_result_fetch_still_leaves_the_spend_in_the_ledger(self):
        self.fal.result_override = Resp(500, text="boom")
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertEqual(self.avatar_entries(), [(AVATAR_SECONDS, 15.0, "avatar:fal", 0.9)])
        self.assertIn("resumes it without paying again", str(caught.exception))
        self.assertEqual(self.fal.submits, 1)

    def test_a_failing_download_still_leaves_the_spend_in_the_ledger(self):
        self.fal.video_script = [Resp(503, text="down")] * 3
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(len(self.avatar_entries()), 1)

    def test_the_rerun_after_a_failed_result_resumes_the_same_request_and_pays_nothing_more(self):
        self.fal.result_override = Resp(500, text="boom")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.fal.result_override = None
        submits = self.fal.submits
        segments = self.run_it()
        self.assertEqual(self.fal.submits, submits + 1, "only the OUTRO is submitted; the intro resumed")
        self.assertEqual(len(self.avatar_entries()), 2, "intro once, outro once")
        self.assertEqual(segments[0].path.read_bytes(), b"MP4DATA")

    def test_the_rerun_after_a_failed_download_does_not_resubmit_or_double_ledger(self):
        self.fal.video_script = [Resp(503, text="down")] * 3
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(self.fal.submits, 1)
        self.run_it()
        # one submit for the intro (resumed), one for the outro; each ledgered exactly once
        self.assertEqual(self.fal.submits, 2)
        self.assertEqual([x[1] for x in self.avatar_entries()], [15.0, 15.0])

    def test_the_request_is_saved_before_polling_begins(self):
        seen = {}
        real_get = self.fal.get

        def get(url, **kw):
            if url.endswith("/status") and "side" not in seen:
                side = self.dir / "presenter_intro.json"
                seen["side"] = json.loads(side.read_text())
            return real_get(url, **kw)

        self.fal.get = get
        self.run_it()
        self.assertEqual(seen["side"]["request"]["id"], "req-1")
        self.assertFalse(seen["side"]["ledgered"])
        self.assertTrue(seen["side"]["request"]["status_url"].startswith("https://queue.fal.run/"))

    def test_a_finished_clip_whose_file_was_deleted_is_fetched_again_without_resubmitting(self):
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        clip = self.dir / "presenter_intro.mp4"
        clip.unlink()
        segments = self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertTrue(segments[0].path.exists())
        self.assertEqual(self.fal.submits, 1)
        self.assertEqual(len(self.avatar_entries()), 1)

    def test_a_crash_while_polling_is_resumed_not_resubmitted(self):
        self.fal.status_error = Resp(404, text="hmm")
        real = self.fal.get
        calls = {"n": 0}

        def get(url, **kw):
            if url.endswith("/status"):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise KeyboardInterrupt()  # the process dies mid-poll
            return real(url, **kw)

        self.fal.status_error = None
        self.fal.get = get
        with self.assertRaises(KeyboardInterrupt):
            self.run_it()
        self.fal.get = real
        self.run_it()
        self.assertEqual(self.fal.submits, 2, "intro submitted once (resumed after the crash), plus the outro")

    def test_a_result_that_is_transiently_down_is_retried_with_a_backoff(self):
        self.fal.result_script = [Resp(503, text="x"), Resp(502, text="x")]
        self.fal.statuses = ["COMPLETED"]  # no poll waits, so the clock only moves for the backoff
        segments = self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(len(segments), 1)
        self.assertEqual(self.fal.submits, 1)
        self.assertEqual(self.clock.now, 2.0 + 4.0)

    def test_a_download_that_is_transiently_down_is_retried(self):
        self.fal.video_script = [Resp(503, text="x")]
        segments = self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(segments[0].path.read_bytes(), b"MP4DATA")
        self.assertEqual(len(self.avatar_entries()), 1)

    def test_a_dropped_download_connection_is_retried(self):
        import requests

        real = self.fal.get
        state = {"dropped": False}

        def get(url, **kw):
            if url.endswith("out.mp4") and not state["dropped"]:
                state["dropped"] = True
                raise requests.ConnectionError("reset")
            return real(url, **kw)

        self.fal.get = get
        self.assertEqual(len(self.run_it(**{avatar_fal.OUTRO_ENV: "0"})), 1)

    def test_a_result_that_says_the_request_is_unusable_makes_the_rerun_submit_afresh(self):
        self.fal.result_override = Resp(422, {"detail": "bad"})
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(len(self.avatar_entries()), 1)  # recorded once: fal had said COMPLETED
        self.fal.result_override = None
        self.run_it()
        self.assertEqual(self.fal.submits, 3, "a fresh intro request, then the outro")

    def test_a_lost_submit_answer_is_said_to_be_possibly_billed_and_recorded_as_unconfirmed(self):
        import requests

        self.fal.submit_exc = requests.ReadTimeout("slow")
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("MAY HAVE BEEN ACCEPTED AND BILLED", str(caught.exception))
        self.assertEqual(self.avatar_entries("avatar:fal:unconfirmed"),
                         [(AVATAR_SECONDS, 15.0, "avatar:fal:unconfirmed", 0.9)])
        self.assertEqual(self.avatar_entries(), [])
        self.assertEqual(self.fal.submits, 1, "the outro must not be submitted after a lost intro")

    def test_a_submit_server_error_is_unconfirmed_but_a_refusal_is_not(self):
        self.fal.submit_override = Resp(502, text="bad gateway")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(len(self.avatar_entries("avatar:fal:unconfirmed")), 1)
        self.setUp()
        self.fal.submit_override = Resp(422, text='{"detail": "bad"}')
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(self.avatar_entries("avatar:fal:unconfirmed"), [])

    def test_a_2xx_submit_answer_with_no_usable_request_id_is_unconfirmed(self):
        self.fal.submit_override = Resp(200, {"status": "IN_QUEUE"})
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(len(self.avatar_entries("avatar:fal:unconfirmed")), 1)

    def test_a_poll_timeout_after_the_job_started_is_cancelled_and_recorded_as_unconfirmed(self):
        self.fal.statuses = ["IN_PROGRESS"]
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("MAY STILL BE BILLED", str(caught.exception))
        self.assertIn("https://queue.fal.run/x/requests/req-1/cancel", self.fal.urls("put"))
        self.assertEqual(self.avatar_entries("avatar:fal:unconfirmed"),
                         [(AVATAR_SECONDS, 15.0, "avatar:fal:unconfirmed", 0.9)])
        self.assertEqual(self.avatar_entries(), [])

    def test_a_poll_timeout_while_still_queued_was_never_started_so_nothing_is_recorded(self):
        self.fal.statuses = ["IN_QUEUE"]
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertNotIn("MAY STILL BE BILLED", str(caught.exception))
        self.assertEqual(self.avatar_entries("avatar:fal:unconfirmed"), [])
        self.assertIn("https://queue.fal.run/x/requests/req-1/cancel", self.fal.urls("put"))

    def test_after_a_cancelled_timeout_the_rerun_starts_a_new_request(self):
        self.fal.statuses = ["IN_PROGRESS"]
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.fal.statuses = ["COMPLETED"]
        self.run_it()
        self.assertEqual(self.fal.submits, 3)

    def test_a_request_fal_no_longer_knows_is_forgotten_not_polled_forever(self):
        self.fal.result_override = Resp(500, text="boom")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.fal.result_override = None
        self.fal.status_error = Resp(404, text="gone")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.fal.status_error = None
        self.run_it()
        self.assertGreaterEqual(self.fal.submits, 3, "a fresh request after the old one was gone")

    def test_a_sidecar_for_other_words_is_never_resumed(self):
        self.fal.result_override = Resp(500, text="boom")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.fal.result_override = None

        def other_words(path, start, end, dest):
            Path(dest).write_bytes(b"DIFFERENT")
            return Path(dest)

        self.audio.cut = other_words
        submits = self.fal.submits
        self.run_it()
        self.assertEqual(self.fal.submits, submits + 2)


class Hardening(Case):
    def test_a_server_url_off_the_fal_hosts_is_refused_and_the_key_never_follows_it(self):
        for field in ("status_url", "response_url", "cancel_url"):
            with self.subTest(field=field):
                self.setUp()
                answer = {"request_id": "req-1", "status_url": "https://queue.fal.run/x/requests/req-1/status",
                          "response_url": "https://queue.fal.run/x/requests/req-1",
                          "cancel_url": "https://queue.fal.run/x/requests/req-1/cancel"}
                answer[field] = "https://evil.example/steal"
                self.fal.submit_override = Resp(200, answer)
                with self.assertRaises(AvatarUnavailable):
                    self.run_it()
                self.assertFalse([u for u in self.fal.urls() if "evil.example" in u])

    def test_checked_url_accepts_only_https_fal_hosts_without_credentials(self):
        ok = ["https://queue.fal.run/a", "https://v3.fal.media/files/x.mp4", "https://v3b.fal.media/f",
              "https://rest.fal.ai/s", "https://fal.media/f"]
        for url in ok:
            avatar_fal.checked_url(url, "x")
        bad = ["http://queue.fal.run/a", "https://queue.fal.run.evil.com/a", "https://evilfal.media/a",
               "https://fal.media.evil.com/a", "https://user:pw@queue.fal.run/a", "https://queue.fal.run:8443/a",
               "ftp://queue.fal.run/a", "//queue.fal.run/a", "", None, 5, "https://storage.googleapis.com/x"]
        for url in bad:
            with self.assertRaises(AvatarUnavailable, msg=repr(url)):
                avatar_fal.checked_url(url, "x")

    def test_the_key_goes_only_to_the_queue_and_rest_hosts(self):
        with self.assertRaises(AvatarUnavailable):
            avatar_fal.checked_url("https://v3.fal.media/x", "status_url", key_host=True)
        with self.assertRaises(AvatarUnavailable):
            avatar_fal.checked_url("https://sub.queue.fal.run/x", "status_url", key_host=True)
        avatar_fal.checked_url("https://queue.fal.run/x", "status_url", key_host=True)
        self.run_it()
        for method, url, kw in self.fal.calls:
            has_key = "Authorization" in (kw.get("headers") or {})
            host = url.split("/")[2]
            self.assertEqual(has_key, host in ("queue.fal.run", "rest.fal.ai"), (method, url))

    def test_an_upload_or_video_address_off_the_fal_hosts_is_refused(self):
        original = self.fal.post

        def post(url, **kw):
            resp = original(url, **kw)
            if "storage/upload" in url:
                return Resp(200, {"upload_url": "https://evil.example/put", "file_url": f"{CDN}/x"})
            return resp

        self.fal.post = post
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertFalse([u for u in self.fal.urls() if "evil.example" in u])
        self.setUp()
        self.fal.result_override = Resp(200, {"video": {"url": "https://evil.example/v.mp4"}})
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertFalse([u for u in self.fal.urls("get") if "evil.example" in u])

    def test_redirects_are_never_followed(self):
        self.run_it()
        for method, url, kw in self.fal.calls:
            self.assertIs(kw.get("allow_redirects"), False, (method, url))

    def test_a_redirect_answer_is_an_error_not_a_destination(self):
        self.fal.submit_override = Resp(302, text="moved", headers={"Location": "https://evil.example"})
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertFalse([u for u in self.fal.urls() if "evil.example" in u])

    def test_a_video_over_the_size_cap_is_refused_streamed_and_not_kept(self):
        with mock.patch.object(avatar_fal, "MAX_VIDEO_BYTES", 10):
            self.fal.video = b"x" * 11
            with self.assertRaises(AvatarUnavailable) as caught:
                self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertIn("limit", str(caught.exception))
        self.assertFalse((self.dir / "presenter_intro.mp4").exists())
        self.assertFalse((self.dir / "presenter_intro.mp4.part").exists())

    def test_a_declared_size_over_the_cap_is_refused_before_reading(self):
        with mock.patch.object(avatar_fal, "MAX_VIDEO_BYTES", 10):
            self.fal.video_script = [Resp(200, chunks=[b"x"], headers={"Content-Length": "11"})]
            with self.assertRaises(AvatarUnavailable):
                self.run_it(**{avatar_fal.OUTRO_ENV: "0"})

    def test_the_cap_is_200_mb(self):
        self.assertEqual(avatar_fal.MAX_VIDEO_BYTES, 200 * 1024 * 1024)

    def test_a_video_exactly_at_the_cap_is_kept(self):
        with mock.patch.object(avatar_fal, "MAX_VIDEO_BYTES", 10):
            self.fal.video = b"x" * 10
            self.assertEqual(len(self.run_it(**{avatar_fal.OUTRO_ENV: "0"})), 1)

    def test_a_non_json_status_answer_is_an_avatar_error_with_a_cancel(self):
        self.fal.status_error = Resp(200, text="<html>proxy page</html>")
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("not a JSON", str(caught.exception))
        self.assertIn("https://queue.fal.run/x/requests/req-1/cancel", self.fal.urls("put"))

    def test_a_status_answer_whose_json_raises_valueerror_is_an_avatar_error_too(self):
        class Bad(Resp):
            def json(self):
                raise ValueError("Expecting value")

        self.fal.status_error = Bad(200, text="<html>")
        with self.assertRaises(AvatarUnavailable):
            self.run_it()

    def test_uploads_ask_fal_to_expire_the_narration_and_the_portrait(self):
        self.run_it()
        initiates = [kw for m, u, kw in self.fal.calls if "storage/upload/initiate" in u]
        self.assertTrue(initiates)
        for kw in initiates:
            self.assertEqual(json.loads(kw["headers"]["X-Fal-Object-Lifecycle-Preference"]),
                             {"expiration_duration_seconds": 3600})
        submit = [kw for m, u, kw in self.fal.calls if "queue.fal.run/fal-ai" in u and m == "post"][0]
        self.assertEqual(json.loads(submit["headers"]["X-Fal-Object-Lifecycle-Preference"]),
                         {"expiration_duration_seconds": 86400})

    def test_a_changed_character_gets_a_new_portrait_the_same_one_is_reused(self):
        self.run_it(prompt="a friendly fox")
        self.run_it(prompt="a friendly fox")
        self.assertEqual(len(self.portrait.calls), 1)
        self.run_it(prompt="a grumpy robot")
        self.assertEqual(len(self.portrait.calls), 2)
        self.assertIn("a grumpy robot", self.portrait.calls[1]["prompt"])
        self.run_it(prompt="a grumpy robot", **{avatar_fal.IMAGE_MODEL_ENV: "fal-ai/flux/dev"})
        self.assertEqual(len(self.portrait.calls), 3)

    def test_the_portrait_is_regenerated_when_the_frame_shape_changes(self):
        self.run_it()
        self.provider().generate_segments(CHARACTER, None, self.out, narration_path=self.narration,
                                          frame_size=(720, 1280))
        self.assertEqual([c["size"] for c in self.portrait.calls], [(1280, 720), (720, 1280)])


class PriceFloor(unittest.TestCase):
    def setUp(self):
        avatar_fal._WARNED.clear()

    def test_the_default_model_never_prices_below_its_published_price(self):
        s = FalAvatarSettings.from_env({avatar_fal.PRICE_ENV: "0.02"})
        self.assertEqual(s.usd_per_second, 0.0562)

    def test_a_higher_price_for_the_default_model_is_kept(self):
        self.assertEqual(FalAvatarSettings.from_env({avatar_fal.PRICE_ENV: "0.09"}).usd_per_second, 0.09)

    def test_a_price_below_the_floor_is_raised_and_warned_about(self):
        with self.assertLogs("modules.avatar_fal", "WARNING") as logs:
            s = FalAvatarSettings.from_env({avatar_fal.PRICE_ENV: "0.001", avatar_fal.MODEL_ENV: "fal-ai/x/y"})
        self.assertEqual(s.usd_per_second, 0.01)
        self.assertIn("understate", "\n".join(logs.output))

    def test_another_model_without_a_price_override_warns_that_the_caps_may_understate(self):
        with self.assertLogs("modules.avatar_fal", "WARNING") as logs:
            s = FalAvatarSettings.from_env({avatar_fal.MODEL_ENV: "fal-ai/kling-video/ai-avatar/v2/pro"})
        self.assertIn("understate", "\n".join(logs.output))
        self.assertIn(avatar_fal.PRICE_ENV, "\n".join(logs.output))
        self.assertEqual(s.usd_per_second, 0.06)

    def test_another_model_with_its_own_price_does_not_warn_and_uses_it(self):
        with self.assertNoLogs("modules.avatar_fal", "WARNING"):
            s = FalAvatarSettings.from_env({avatar_fal.MODEL_ENV: "fal-ai/x/y", avatar_fal.PRICE_ENV: "0.11"})
        self.assertEqual(s.usd_per_second, 0.11)

    def test_the_default_model_at_the_default_price_is_quiet(self):
        with self.assertNoLogs("modules.avatar_fal", "WARNING"):
            FalAvatarSettings.from_env({})

    def test_the_warning_is_not_repeated_on_every_read(self):
        env = {avatar_fal.MODEL_ENV: "fal-ai/x/y"}
        with self.assertLogs("modules.avatar_fal", "WARNING") as logs:
            for _ in range(5):
                FalAvatarSettings.from_env(env)
        self.assertEqual(len(logs.output), 1)

    def test_the_usd_ceiling_follows_the_floored_price(self):
        s = FalAvatarSettings.from_env({avatar_fal.PRICE_ENV: "0.02"})
        self.assertEqual(s.max_usd, round(30 * 0.0562 + 0.01, 6))


class PollToleranceBoundary(Case):
    def test_a_status_endpoint_is_given_exactly_three_retries_not_more(self):
        self.fal.status_error = Resp(503, text="down")
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(len([u for u in self.fal.urls("get") if u.endswith("/status")]), 4)

    def test_dropped_connections_get_the_same_three_retries(self):
        import requests

        def get(url, **kw):
            self.fal.calls.append(("get", url, kw))
            raise requests.ConnectionError("down")

        self.fal.get = get
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(len([u for u in self.fal.urls("get") if u.endswith("/status")]), 4)


class NarrationChoice(unittest.TestCase):
    def test_the_clean_narration_is_used_when_the_mixer_saved_it_else_the_mix(self):
        with tempfile.TemporaryDirectory() as tmp:
            slug = Path(tmp)
            mix = slug / "audio" / "final_audio.mp3"
            self.assertEqual(avatar.presenter_narration(slug, mix), mix)
            (slug / "audio").mkdir()
            (slug / "audio" / "narration.mp3").write_bytes(b"x")
            self.assertEqual(avatar.presenter_narration(slug, mix), slug / "audio" / "narration.mp3")

    def test_main_uses_that_choice(self):
        text = (Path(__file__).resolve().parent.parent / "main.py").read_text()
        self.assertIn("narration_path=presenter_narration(OUTPUT_DIR / slug, audio_path),", text)


class UrlParsersMustAgree(Case):
    """R1: a URL the allow-list reads one way and the HTTP library another is how bytes leave."""

    SMUGGLED = [
        "https://evil.com\\.fal.media/a",
        "https://evil.com%5c.fal.media/a",
        "https://evil.com%5C.fal.media/a",
        "https://a.fal.media\\@evil.com/x",
        "https://a.fal.media\t.evil.com/x",
        "https://a.fal.media\n.evil.com/x",
        "https://a.fal.media /x",
        "https://a.fal.media/x y",
        "https://a.fal.media/x\x00",
        "https://a.fal.media/\u00e9",
        "https://\u00e9vil.fal.media/x",
        "https://a..fal.media/x",
        "https://-a.fal.media/x",
        "https://a.fal.media./x",
        "https://.fal.media/x",
    ]

    def test_every_smuggled_form_is_refused(self):
        for url in self.SMUGGLED:
            for key_host in (False, True):
                with self.assertRaises(AvatarUnavailable, msg=repr(url)):
                    avatar_fal.checked_url(url, "x", key_host=key_host)

    def test_a_backslash_anywhere_in_the_url_is_refused(self):
        for url in ("https://v3.fal.media/files\\x.mp4", "https://v3.fal.media/x?a=\\b", "https://v3.fal.media/#\\"):
            with self.assertRaises(AvatarUnavailable, msg=url):
                avatar_fal.checked_url(url, "x")

    def test_mixed_case_hosts_are_judged_by_their_lowercase_form(self):
        avatar_fal.checked_url("https://V3.FAL.Media/files/x.mp4", "x")
        avatar_fal.checked_url("https://Queue.FAL.run/x", "x", key_host=True)
        with self.assertRaises(AvatarUnavailable):
            avatar_fal.checked_url("https://EVIL.Example/x", "x")
        with self.assertRaises(AvatarUnavailable):
            avatar_fal.checked_url("https://Queue.FAL.run.EVIL.com/x", "x", key_host=True)

    def test_the_earlier_host_cases_still_hold(self):
        for url in ("https://queue.fal.run/a", "https://v3.fal.media/files/x.mp4", "https://v3b.fal.media/f",
                    "https://rest.fal.ai/s", "https://fal.media/f"):
            avatar_fal.checked_url(url, "x")
        for url in ("http://queue.fal.run/a", "https://queue.fal.run.evil.com/a", "https://evilfal.media/a",
                    "https://fal.media.evil.com/a", "https://user:pw@queue.fal.run/a",
                    "https://queue.fal.run:8443/a", "ftp://queue.fal.run/a", "//queue.fal.run/a", "", None, 5,
                    "https://storage.googleapis.com/x"):
            with self.assertRaises(AvatarUnavailable, msg=repr(url)):
                avatar_fal.checked_url(url, "x")

    def test_a_host_the_http_library_would_read_differently_is_refused_even_if_it_looks_fine(self):
        with mock.patch.object(avatar_fal, "_urllib3_host", return_value="evil.example"):
            with self.assertRaises(AvatarUnavailable):
                avatar_fal.checked_url("https://v3.fal.media/x", "x")
        with mock.patch.object(avatar_fal, "_urllib3_host", return_value=None):
            with self.assertRaises(AvatarUnavailable):
                avatar_fal.checked_url("https://v3.fal.media/x", "x")

    def test_the_two_parsers_really_do_agree_on_a_good_url(self):
        self.assertEqual(avatar_fal._urllib3_host("https://V3.FAL.media/x"), "v3.fal.media")

    def test_a_smuggled_upload_address_never_receives_the_bytes(self):
        original = self.fal.post

        def post(url, **kw):
            if "storage/upload" in url:
                self.fal.calls.append(("post", url, kw))
                return Resp(200, {"upload_url": "https://evil.com\\.fal.media/put", "file_url": f"{CDN}/x"})
            return original(url, **kw)

        self.fal.post = post
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(self.fal.urls("put"), [])

    def test_a_smuggled_video_address_is_never_fetched(self):
        self.fal.result_override = Resp(200, {"video": {"url": "https://evil.com\\.fal.media/v.mp4"}})
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertFalse([u for u in self.fal.urls("get") if "evil" in u])


class TheDiskCanFillUp(Case):
    """R2: a sidecar that cannot be written must stop the run before money moves, or be paid for loudly."""

    def failing_save(self, when):
        real = avatar_fal._save_state

        def save(path, state):
            if when(path, state):
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(path, state)

        return mock.patch.object(avatar_fal, "_save_state", side_effect=save)

    def test_a_full_disk_before_the_submit_stops_the_run_before_any_upload_or_request(self):
        with self.failing_save(lambda path, state: path.name == "presenter_intro.mp4"):
            with self.assertRaises(AvatarUnavailable) as caught:
                self.run_it()
        self.assertIn("No space left", str(caught.exception))
        self.assertEqual(self.fal.calls, [])
        self.assertEqual(self.spent[-1][0], "image_generations")  # only the portrait, bought earlier

    def test_a_full_disk_after_the_submit_is_ledgered_as_unconfirmed_cancelled_and_not_a_raw_oserror(self):
        with self.failing_save(lambda path, state: "request" in state):
            with self.assertRaises(AvatarUnavailable) as caught:
                self.run_it()
        self.assertIn("could not be saved", str(caught.exception))
        self.assertIn("MAY STILL BE BILLED", str(caught.exception))
        self.assertEqual([x for x in self.spent if x[0] == AVATAR_SECONDS],
                         [(AVATAR_SECONDS, 15.0, "avatar:fal:unconfirmed", 0.9)])
        self.assertIn("https://queue.fal.run/x/requests/req-1/cancel", self.fal.urls("put"))
        self.assertEqual(self.fal.submits, 1)
        self.assertNotIn(KEY, str(caught.exception))

    def test_a_failed_save_of_the_ledgered_note_is_an_avatar_error_with_the_spend_recorded(self):
        with self.failing_save(lambda path, state: state.get("ledgered") is True):
            with self.assertRaises(AvatarUnavailable):
                self.run_it()
        self.assertEqual([x[3] for x in self.spent if x[0] == AVATAR_SECONDS and x[2] == "avatar:fal"], [0.9])

    def test_a_failed_save_of_the_finished_note_is_an_avatar_error(self):
        with self.failing_save(lambda path, state: path.name == "presenter_intro.mp4" and state.get("done") is True):
            with self.assertRaises(AvatarUnavailable):
                self.run_it()
        self.assertEqual(self.fal.submits, 1, "the failure must come at the very end, after the work")
        self.assertTrue((self.dir / "presenter_intro.mp4").exists())

    def test_a_note_that_cannot_be_updated_while_dropping_a_dead_request_does_not_hide_the_real_error(self):
        self.fal.result_override = Resp(422, {"detail": "bad"})
        forgetting = lambda path, state: (path.name == "presenter_intro.mp4" and state.get("ledgered") is False
                                          and "request" not in state)
        with self.failing_save(forgetting):
            with self.assertRaises(AvatarUnavailable) as caught:
                self.run_it()
        self.assertIn("422", str(caught.exception))

    def test_a_full_disk_for_the_portrait_note_is_an_avatar_error(self):
        with self.failing_save(lambda path, state: path.name == "presenter_portrait.png"):
            with self.assertRaises(AvatarUnavailable):
                self.run_it()
        self.assertEqual(self.fal.submits, 0)

    def test_a_read_only_output_folder_stops_before_the_portrait_is_bought(self):
        with mock.patch("pathlib.Path.write_bytes", side_effect=OSError(errno.EROFS, "Read-only file system")):
            with self.assertRaises(AvatarUnavailable) as caught:
                self.run_it()
        self.assertIn("Read-only", str(caught.exception))
        self.assertIn("nothing was sent or spent", str(caught.exception))
        self.assertNothingSent()

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "root ignores directory permissions")
    def test_a_really_read_only_folder_stops_before_anything_is_bought(self):
        os.chmod(self.dir, 0o555)
        self.addCleanup(os.chmod, self.dir, 0o755)
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertNothingSent()

    def test_an_audio_slice_that_cannot_be_written_is_an_avatar_error(self):
        def cut(path, start, end, dest):
            raise OSError(errno.ENOSPC, "No space left on device")

        self.audio.cut = cut
        with self.assertRaises(AvatarUnavailable) as caught:
            self.run_it()
        self.assertIn("audio slice", str(caught.exception))
        self.assertEqual(self.fal.calls, [])

    def test_a_portrait_that_cannot_be_written_is_an_avatar_error(self):
        def portrait(*a, **k):
            raise PermissionError(errno.EACCES, "Permission denied")

        self.portrait = portrait
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        self.assertEqual(self.fal.calls, [])

    def test_once_the_disk_is_fixed_the_run_goes_through(self):
        with self.failing_save(lambda path, state: path.name == "presenter_intro.mp4"):
            with self.assertRaises(AvatarUnavailable):
                self.run_it()
        self.assertEqual(len(self.run_it()), 2)


class MalformedSidecars(Case):
    """R6: a damaged or hand-edited sidecar is treated as no request at all."""

    def leave_a_resumable_sidecar(self):
        self.fal.result_override = Resp(500, text="boom")
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.fal.result_override = None
        side = self.dir / "presenter_intro.json"
        return side, json.loads(side.read_text())

    def rewrite(self, side, data):
        side.write_text(json.dumps(data))

    GOOD = {"id": "req-1", "status_url": "https://queue.fal.run/x/requests/req-1/status",
            "response_url": "https://queue.fal.run/x/requests/req-1",
            "cancel_url": "https://queue.fal.run/x/requests/req-1/cancel"}

    def test_a_valid_saved_request_is_still_resumed(self):
        side, data = self.leave_a_resumable_sidecar()
        self.assertEqual(data["request"], self.GOOD)
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(self.fal.submits, 1)

    def test_malformed_requests_are_resubmitted_not_crashed_on(self):
        shapes = [
            {"id": "x"},
            "a string",
            ["a", "list"],
            5,
            None,
            {},
            {**self.GOOD, "id": 7},
            {**self.GOOD, "id": ""},
            {**self.GOOD, "status_url": None},
            {**self.GOOD, "cancel_url": ["x"]},
            {**self.GOOD, "response_url": "https://evil.example/r"},
            {**self.GOOD, "status_url": "https://evil.com\\.fal.media/s"},
        ]
        for shape in shapes:
            with self.subTest(shape=shape):
                self.setUp()
                side, data = self.leave_a_resumable_sidecar()
                data["request"] = shape
                self.rewrite(side, data)
                before = self.fal.submits
                self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
                self.assertEqual(self.fal.submits, before + 1, "a fresh request was not submitted")
                self.assertFalse([u for u in self.fal.urls() if "evil" in u])

    def test_the_log_line_for_a_malformed_request_carries_no_secret_and_no_content(self):
        side, data = self.leave_a_resumable_sidecar()
        data["request"] = {"id": "SECRET-ID", "status_url": "https://evil.example/TOKEN"}
        self.rewrite(side, data)
        with self.assertLogs("modules.avatar_fal", "WARNING") as logs:
            self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        text = "\n".join(logs.output)
        self.assertIn("malformed saved fal.ai request", text)
        for secret in (KEY, "SECRET-ID", "TOKEN", "evil.example"):
            self.assertNotIn(secret, text)

    def test_a_ledgered_flag_that_is_not_exactly_true_does_not_count(self):
        side, data = self.leave_a_resumable_sidecar()
        data["ledgered"] = "yes"
        self.rewrite(side, data)
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(len([x for x in self.spent if x[0] == AVATAR_SECONDS]), 2)

    def test_a_done_flag_that_is_not_exactly_true_does_not_skip_the_work(self):
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        side = self.dir / "presenter_intro.json"
        data = json.loads(side.read_text())
        data["done"] = "yes"
        self.rewrite(side, data)
        calls = len(self.fal.calls)
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertGreater(len(self.fal.calls), calls, "a 'yes' is not done: the work is picked up again")
        self.assertEqual(self.fal.submits, 1, "the request is resumed, not resubmitted")
        self.assertEqual(len([x for x in self.spent if x[0] == AVATAR_SECONDS]), 1)

    def test_a_sidecar_that_is_not_json_or_not_an_object_is_ignored(self):
        self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        side = self.dir / "presenter_intro.json"
        for junk in ("not json at all", "[1, 2]", "\"s\"", ""):
            with self.subTest(junk=junk):
                side.write_text(junk)
                self.run_it(**{avatar_fal.OUTRO_ENV: "0"})


class SmallGaps(Case):
    def test_the_cancel_call_does_not_follow_redirects(self):
        self.fal.statuses = ["IN_PROGRESS"]
        with self.assertRaises(AvatarUnavailable):
            self.run_it()
        cancels = [kw for m, u, kw in self.fal.calls if m == "put" and u.endswith("/cancel")]
        self.assertTrue(cancels)
        for kw in cancels:
            self.assertIs(kw.get("allow_redirects"), False)

    def test_an_empty_download_leaves_no_part_file_behind(self):
        self.fal.video = b""
        with self.assertRaises(AvatarUnavailable):
            self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(sorted(p.name for p in self.dir.glob("*.part")), [])
        self.assertFalse((self.dir / "presenter_intro.mp4").exists())

    def test_an_oversize_download_leaves_no_part_file_behind(self):
        with mock.patch.object(avatar_fal, "MAX_VIDEO_BYTES", 10):
            self.fal.video = b"x" * 11
            with self.assertRaises(AvatarUnavailable):
                self.run_it(**{avatar_fal.OUTRO_ENV: "0"})
        self.assertEqual(sorted(p.name for p in self.dir.glob("*.part")), [])


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

    def test_a_segment_that_starts_after_the_video_ends_stops_the_render(self):
        # Asked for and paid for, so not "left out": the run stops (CLAUDE.md #4).
        with self.assertRaises(AvatarUnavailable):
            self.comp._build_presenter_clips([PresenterSegment(self.clip_path, 100.0, 3.0)], 100.0)

    def test_an_unreadable_segment_stops_the_render_instead_of_leaving_a_half_presenter(self):
        bad = Path(self._tmp.name) / "bad.mp4"
        bad.write_bytes(b"not a video")
        with self.assertRaises(AvatarUnavailable) as cm:
            self.comp._build_presenter_clips(
                [PresenterSegment(bad, 0.0, 3.0), PresenterSegment(self.clip_path, 50.0, 3.0)], 100.0)
        self.assertIn("bad.mp4", str(cm.exception))
        self.assertNotIn("p.mp4", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
