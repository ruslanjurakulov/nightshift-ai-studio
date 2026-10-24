"""Characterization of ``social_publish.process_request`` for Instagram, TikTok and YouTube: the whole
conversation of one request, recorded and compared with a recording made BEFORE the platform adapters were moved
behind the publisher registry (modules/publishers.py).

For every scenario below the test records: every call on the store (name and arguments, in order), every row written
to ``publish_requests``, every HTTP request the adapters make, every call on the fake YouTube uploader, every token
read, every probe. The recording must equal ``tests/fixtures/publisher_transcripts.json``, which was GENERATED FROM THE
OLD CODE (the if-platform branches of ``process_request``, main at 2171b27, before the registry) with
``python3 -m tests.test_publisher_transcripts --regen``, not by the code under test, and was re-verified against the
newer main that had no registry yet. A
change that reorders a read, drops a field, adds a call or alters a refusal word fails here. Regenerating the file
after a deliberate behaviour change is a decision to review, not a way to make this pass.

No platform is called: HTTP, the store, the tokens and the uploader are fakes.
"""

import dataclasses
import hashlib
import json
import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from modules import social_probe as pr
from modules import social_publish as sp
from tests.test_social_disclosure import DStore, event, ig_http
from tests.test_social_publish import TOKEN, Base, FakeHTTP, FakeTokens, FakeUploader, HttpErr, Resp

GOLDEN = Path(__file__).parent / "fixtures" / "publisher_transcripts.json"
LABELLED = [event(generated_clips=2)]   # an AI-generated clip: the decision labels the video
CLEAN = [event()]                       # stock only: it does not
IG, TT = sp.IG_GRAPH, sp.TT_API
NO_VIDEO = object()
_CLOCK = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")  # the worker's own clock stamps


def _plain(value):
    """JSON-safe and deterministic: bytes become their length and a digest, paths their file name."""
    if isinstance(value, bytes):
        return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()[:16]}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, Path):
        return value.name
    if isinstance(value, str):
        # The tests' made-up access token stays out of the recording (it still has to match: the placeholder
        # appears wherever the code sent it).
        return _CLOCK.sub("<ts>", value.replace(TOKEN, "<access-token>"))
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return f"<{type(value).__name__}>"


class Spy:
    """Wraps a store and records every method call, in order."""

    def __init__(self, inner, log):
        self._inner, self._log = inner, log

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if not callable(attr):
            return attr

        def call(*args, **kw):
            self._log.append(["store." + name, _plain(list(args)), _plain(kw)])
            return attr(*args, **kw)
        return call


class SpyTokens(FakeTokens):
    def __init__(self, platform, log, *, expired=False, **kw):
        super().__init__(platform, **kw)
        self._log, self._expired = log, expired

    def read(self, account_id):
        self._log.append(["tokens.read", account_id])
        tok = super().read(account_id)
        if tok is not None and self._expired:
            tok = dataclasses.replace(tok, access_expires_at=datetime.now(timezone.utc) - timedelta(days=1))
        return tok

    def set_status(self, account_id, status):
        self._log.append(["tokens.set_status", account_id, status])


class SpyUploader(FakeUploader):
    def __init__(self, log, exc=None):
        super().__init__(exc)
        self._log = log

    def upload(self, path, script, privacy=None, **kwargs):
        decision = kwargs.get("ai_disclosure")
        self._log.append(["uploader.upload", path.name,
                          {"title": script.title, "description": script.description, "tags": script.tags,
                           "sections": script.sections},
                          privacy, sorted(kwargs),
                          None if decision is None else [decision.label, decision.line, list(decision.reasons)]])
        return super().upload(path, script, privacy, **kwargs)


class _YtDStore(DStore):
    def __init__(self, *, status="ACTIVE", connected=True, **kw):
        super().__init__(**kw)
        self._status, self._connected = status, connected

    def channel(self, channel_id):
        row = super().channel(channel_id)
        row["status"] = self._status
        return row

    def channel_connected(self, channel_id):
        return self._connected


def _stamps(rows):
    for row in rows:
        if isinstance(row, dict):
            for k in ("finished_at", "updated_at", "heartbeat_at"):
                if k in row:
                    row[k] = "<ts>"
    return rows


class Scenario(Base):
    """One process_request, recorded. ``run_scenario`` returns (outcome, transcript, store, http, uploader)."""

    def run_scenario(self, platform, *, events=LABELLED, http=None, refusal=None, info=None, facts=None,
                     missing_token=False, token_expired=False, token_platform=None, master=True, short=None, agent=None,
                     request=None, yt_exc=None, yt_target="finance", yt_status="ACTIVE", yt_connected=True,
                     yt_token=None, yt_cred_exc=None, yt_factory_exc=None, no_youtube=False, video=None):
        log = []
        if not master:
            self.master.unlink()
        http = http if http is not None else FakeHTTP({})
        stored = None if video is NO_VIDEO else (video or self.video)
        if platform == "youtube":
            store = _YtDStore(status=yt_status, connected=yt_connected, video=stored, http=http,
                              refusal=refusal, events=events, agent_config=agent)
        else:
            store = DStore(video=stored, http=http, events=events, refusal=refusal, short=short, agent_config=agent)
        spy = Spy(store, log)
        tokens = SpyTokens(token_platform or (platform if platform != "youtube" else "instagram"), log,
                           missing=missing_token or platform == "youtube", expired=token_expired)
        info = info or sp.VideoInfo(60.0, 1080, 1920, 2048)
        facts = facts or self.GOOD_FACTS

        def probe_fn(p):
            log.append(["probe_fn", p.name])
            return info

        def media_fn(p):
            log.append(["media_fn", p.name])
            return facts

        uploader = SpyUploader(log, yt_exc)
        adapter = None
        if platform == "youtube" and not no_youtube:
            def creds(cid):
                log.append(["youtube.credentials", cid])
                if yt_cred_exc:
                    raise yt_cred_exc
                return (json.dumps({"refresh_token": "x"}) if yt_token is None else yt_token), {"channel": cid}

            def factory(tok, ctx):
                log.append(["youtube.factory", _plain(ctx)])
                if yt_factory_exc:
                    raise yt_factory_exc
                return uploader
            adapter = sp.YoutubeAdapter(creds, uploader_factory=factory)
        r = dict(request or {"id": 7, "org_id": "org", "video_id": "vid1", "account_id": "acc1",
                             "platform": platform})
        if platform == "youtube":
            r.update({"id": 9, "account_id": None, "target_channel_id": yt_target})
        kw = {"youtube": adapter} if platform == "youtube" else {}
        out = sp.process_request(r, store=spy, tokens=tokens, worker_id="w1", output_dir=self.out, http=http,
                                 env={}, sleep=lambda s: log.append(["sleep", s]), probe_fn=probe_fn,
                                 media_fn=media_fn, **kw)
        transcript = {
            "outcome": out,
            "calls": _stamps(_plain(log)),
            "rows": _stamps(_plain(store.updates)),
            "http": _plain([[m, u, dict(k)] for m, u, k in http.calls]),
            "staged": store.staged, "unstaged": store.unstaged,
        }
        return out, transcript, store, http, uploader


def tt_flow(creator=None, init=None, status=None):
    return FakeHTTP({
        ("POST", f"{TT}/creator_info/query/"): [creator or Resp(200, {
            "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 600},
            "error": {"code": "ok"}})],
        ("POST", f"{TT}/video/init/"): [init or Resp(200, {
            "data": {"publish_id": "p1", "upload_url": "https://open-upload.tiktokapis.com/x"},
            "error": {"code": "ok"}})],
        ("PUT", "https://open-upload.tiktokapis.com/x"): [Resp(201)],
        ("POST", f"{TT}/status/fetch/"): status or [
            Resp(200, {"data": {"status": "PROCESSING_UPLOAD"}, "error": {"code": "ok"}}),
            Resp(200, {"data": {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": [42]},
                       "error": {"code": "ok"}})],
    })


def scenarios():
    """name -> kwargs for run_scenario: every refusal and failure word each flow can reach, plus the successes.
    Built fresh per call: the fake HTTP queues are single use."""
    no_faststart = pr.MediaFacts("h264", "aac", True, 1080, 1920, 30.0, False)
    return {
        # Instagram
        "ig_published_labelled": dict(platform="instagram", http=ig_http()),
        "ig_published_clean": dict(platform="instagram", http=ig_http(), events=CLEAN),
        "ig_published_never_label": dict(platform="instagram", http=ig_http(), agent={"ai_disclosure": "never"}),
        "ig_in_progress_then_finished": dict(platform="instagram", http=FakeHTTP({
            ("POST", f"{IG}/17841400000/media_publish"): [Resp(200, {"id": "M2"})],
            ("POST", f"{IG}/17841400000/media"): [Resp(200, {"id": "C2"})],
            ("GET", f"{IG}/C2"): [Resp(200, {"status_code": "IN_PROGRESS"}), Resp(200, {"status_code": "FINISHED"})],
            ("GET", f"{IG}/M2"): [Resp(500)]})),
        "ig_gate_refusal": dict(platform="instagram", refusal="not_approved"),
        "ig_video_missing": dict(platform="instagram", video=NO_VIDEO),
        "ig_account_missing": dict(platform="instagram", missing_token=True),
        "ig_token_expired": dict(platform="instagram", token_expired=True),
        "ig_account_platform_changed": dict(platform="instagram", token_platform="tiktok"),
        "ig_master_missing": dict(platform="instagram", master=False),
        "ig_too_long_names_the_short": dict(platform="instagram", short="short123",
                                            info=sp.VideoInfo(1200.0, 1920, 1080, 2048)),
        "ig_not_faststart": dict(platform="instagram", facts=no_faststart),
        "ig_container_rejected_token": dict(platform="instagram", http=FakeHTTP({
            ("POST", f"{IG}/17841400000/media"): [Resp(400, {"error": {"code": 190}})]})),
        "ig_processing_error": dict(platform="instagram", http=FakeHTTP({
            ("POST", f"{IG}/17841400000/media"): [Resp(200, {"id": "C3"})],
            ("GET", f"{IG}/C3"): [Resp(200, {"status_code": "ERROR"})]})),
        # TikTok
        "tt_published_labelled": dict(platform="tiktok", http=tt_flow()),
        "tt_published_clean": dict(platform="tiktok", http=tt_flow(), events=CLEAN),
        "tt_creator_limit_too_long": dict(platform="tiktok", http=tt_flow(creator=Resp(200, {
            "data": {"privacy_level_options": ["SELF_ONLY"], "max_video_post_duration_sec": 30},
            "error": {"code": "ok"}}))),
        "tt_privacy_unavailable": dict(platform="tiktok", http=tt_flow(creator=Resp(200, {
            "data": {"privacy_level_options": ["PUBLIC_TO_EVERYONE"], "max_video_post_duration_sec": 600},
            "error": {"code": "ok"}}))),
        "tt_creator_info_error": dict(platform="tiktok", http=tt_flow(creator=Resp(401, {
            "error": {"code": "access_token_invalid"}}))),
        "tt_unaudited": dict(platform="tiktok", http=tt_flow(init=Resp(403, {
            "error": {"code": sp.TT_UNAUDITED_CODE}}))),
        "tt_processing_failed": dict(platform="tiktok", http=tt_flow(status=[Resp(200, {
            "data": {"status": "FAILED", "fail_reason": "file_format_check_failed"}, "error": {"code": "ok"}})])),
        "tt_gate_refusal": dict(platform="tiktok", refusal="gate_blocked"),
        "tt_token_expired_cannot_refresh": dict(platform="tiktok", token_expired=True),
        "tt_account_missing": dict(platform="tiktok", missing_token=True),
        "tt_master_missing": dict(platform="tiktok", master=False),
        "tt_bad_media": dict(platform="tiktok", http=tt_flow(), facts=pr.MediaFacts("mpeg2video", "aac", True, 1080, 1920, 30.0, True)),
        # YouTube (another channel of the organization)
        "yt_published_labelled": dict(platform="youtube"),
        "yt_published_clean": dict(platform="youtube", events=CLEAN),
        "yt_published_never_label": dict(platform="youtube", agent={"ai_disclosure": "never"}),
        "yt_own_channel": dict(platform="youtube", yt_target="news"),
        "yt_no_target": dict(platform="youtube", yt_target=""),
        "yt_paused": dict(platform="youtube", yt_status="PAUSED"),
        "yt_not_connected": dict(platform="youtube", yt_connected=False),
        "yt_gate_refusal": dict(platform="youtube", refusal="not_approved"),
        "yt_worker_without_youtube": dict(platform="youtube", no_youtube=True),
        "yt_no_token": dict(platform="youtube", yt_token=""),
        "yt_unverified_channel": dict(platform="youtube", yt_cred_exc=ValueError("unverified")),
        "yt_unreachable_channel": dict(platform="youtube", yt_factory_exc=ValueError("not reachable")),
        "yt_master_missing": dict(platform="youtube", master=False),
        "yt_quota": dict(platform="youtube", yt_exc=HttpErr(403, "quotaExceeded")),
        "yt_ambiguous": dict(platform="youtube", yt_exc=HttpErr(503, "backendError")),
        # not a platform we publish to
        "unknown_facebook": dict(platform="facebook"),
        "unknown_empty": dict(platform="", request={"id": 7, "org_id": "org", "video_id": "vid1", "platform": ""}),
        "unknown_case": dict(platform="Instagram"),
    }


def record(case: Scenario, name: str) -> dict:
    case.setUp()
    try:
        _, transcript, *_ = case.run_scenario(**scenarios()[name])
    finally:
        case.tearDown()
    return json.loads(json.dumps(transcript))


class Transcripts(Scenario):
    maxDiff = None

    def test_the_scenarios_are_the_ones_recorded(self):
        self.assertEqual(sorted(json.loads(GOLDEN.read_text())), sorted(scenarios()),
                         "a scenario was added or removed: regenerate the recording on main, not here")

    def test_every_scenario_matches_the_recording_made_before_the_refactor(self):
        golden = json.loads(GOLDEN.read_text())
        for name in scenarios():
            with self.subTest(name):
                self.assertEqual(record(self, name), golden[name])

    def test_the_recording_covers_each_outcome_each_platform_can_reach(self):
        """Guards the guard: a recording that only held successes would prove little."""
        golden = json.loads(GOLDEN.read_text())
        for prefix in ("ig_", "tt_", "yt_"):
            outcomes = {v["outcome"] for k, v in golden.items() if k.startswith(prefix)}
            self.assertEqual(outcomes, {"published", "refused", "failed"}, prefix)
        self.assertEqual({golden[k]["outcome"] for k in golden if k.startswith("unknown_")}, {"refused"})


def regen():  # pragma: no cover - run by hand, on main, to record the transcripts
    case = Scenario("run_scenario")
    out = {name: record(case, name) for name in scenarios()}
    GOLDEN.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    print(f"wrote {len(out)} transcripts to {GOLDEN}")


if __name__ == "__main__":
    if "--regen" in sys.argv:
        regen()
    else:
        unittest.main()
