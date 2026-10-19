"""modules/visibility_publish.py — the worker that makes an APPROVED, uploaded, private YouTube video public, with the
transport mocked (no real YouTube call, no token, no money).

What would break without these:

  * the worker acts on a request the database would now refuse (the cut changed after the approval, the approval ran out, the
    channel's switch was turned off, the gate verdict is not an allowed one): it must ask again, with the cut hash recorded at
    approval, BEFORE any YouTube call and once more IMMEDIATELY before the write, and a word ends the request;
  * "applied" is recorded on the strength of the write's own answer: it is recorded only when a read-back says public, and a
    call that succeeded while YouTube kept the video private is refused with platform_kept_private;
  * a retry sends a second write blindly, or a crash after the write sent is not recognised (the next claim reads first);
  * a 4xx policy answer is retried, a quota answer is retried, a token problem is retried;
  * the update names ``snippet`` (that would overwrite the title and description), drops the video's other status fields,
    or schedules/overrides a person's own unlisted or scheduled choice;
  * a token, a response body or a provider's message reaches a log line or a stored word.
"""

import json
import logging
import re
import unittest
from pathlib import Path
from types import SimpleNamespace

from modules import channel_tokens
from modules import visibility_publish as vp

REPO = Path(__file__).resolve().parent.parent
CUT = "ab" * 32
OTHER = "cd" * 32
VID = "dQw4w9WgXcQ"
YT_CHANNEL = "UCchannel0000000000000001"
TOKEN = "ya29.A0ARrdaM-this-is-a-secret-access-token-value"
REFRESH = "1//0g-this-is-a-secret-refresh-token-value-xyz"
FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl"
UPLOAD = "https://www.googleapis.com/auth/youtube.upload"


def token_json(scopes=(UPLOAD, FORCE_SSL)):
    return json.dumps({"token": TOKEN, "refresh_token": REFRESH, "client_secret": "cs-secret", "scopes": list(scopes)})


class HttpError(Exception):
    """What googleapiclient raises: resp.status and a JSON body with the error reasons."""

    def __init__(self, status, reason=""):
        super().__init__(f"<HttpError {status} secret-body-text {TOKEN}>")
        self.resp = SimpleNamespace(status=status)
        self.content = json.dumps({"error": {"errors": [{"reason": reason}] if reason else []}}).encode()


class RefreshError(Exception):
    pass


class FakeYouTube:
    """A googleapiclient ``service`` over one video. ``update`` modes: ok (becomes public), kept_private (the call succeeds, the
    video stays private: an API project that has not passed YouTube's audit); ``update_errors`` are raised in order (None = succeed)."""

    def __init__(self, *, privacy="private", upload_status="processed", channel=YT_CHANNEL, status_extra=None,
                 update="ok", update_errors=(), list_errors=(), found=True, lands_on_error=False):
        self.privacy = privacy
        self.upload_status = upload_status
        self.channel = channel
        self.extra = {"embeddable": True, "license": "youtube", "publicStatsViewable": True, "selfDeclaredMadeForKids": False,
                      "madeForKids": False, **(status_extra or {})}
        self.mode = update
        self.update_errors = list(update_errors)
        self.list_errors = list(list_errors)
        self.found = found
        self.lands_on_error = lands_on_error
        self.updates = []
        self.lists = 0

    def videos(self):
        return self

    def list(self, part, id):
        self.lists += 1
        parent = self
        err = self.list_errors.pop(0) if self.list_errors else None

        class Req:
            def execute(self):
                if err:
                    raise err
                if not parent.found:
                    return {"items": []}
                st = {"privacyStatus": parent.privacy, "uploadStatus": parent.upload_status, **parent.extra}
                return {"items": [{"id": id, "status": st, "snippet": {"channelId": parent.channel, "title": "secret title"}}]}

        return Req()

    def update(self, part, body):
        self.updates.append({"part": part, "body": body})
        parent = self

        class Req:
            def execute(self):
                if parent.update_errors:
                    err = parent.update_errors.pop(0)
                    if err is not None:
                        if parent.lands_on_error:
                            parent.privacy = "public"
                        raise err
                if parent.mode == "ok":
                    parent.privacy = "public"
                return {"id": body["id"], "status": {"privacyStatus": "public"}}      # the answer always claims public

        return Req()


def wrap(**kw):
    return FakeYouTube(**kw)


class MemoryStore:
    """The database's side of the contract, in memory: the same rules the SQL functions of 0113 enforce."""

    def __init__(self, *, video_refusals=(), request_refusals=(), ceiling_units=None):
        self.video_refusals = list(video_refusals)       # one answer per call; the last repeats
        self.request_refusals = list(request_refusals)
        self.used = 0
        self.ceiling_units = ceiling_units
        self.calls = []
        self.request = {"id": 7, "video_id": VID, "channel_id": "chan", "approved_cut_sha256": CUT, "attempts": 1, "reconcile": False,
                        "status": "queued", "reason": None, "claimed_by": "w1", "submitting_at": None, "units": 0,
                        "before": None, "after": None, "next_attempt": None}
        self.finishes = []
        self.fail_finish = False

    def _answer(self, queue):
        return (queue.pop(0) if len(queue) > 1 else queue[0]) if queue else None

    # claim / re-checks
    def claim(self, worker):
        r = self.request
        if r["status"] != "queued" or r["claimed_by"] not in (None, worker):
            return None
        if r["attempts"] >= 3 and r.get("claimed"):
            return None
        r["claimed_by"] = worker
        if r.get("claimed"):
            r["attempts"] += 1
        r["claimed"] = True
        return {"id": r["id"], "video_id": r["video_id"], "channel_id": r["channel_id"], "approved_cut_sha256": r["approved_cut_sha256"],
                "attempts": r["attempts"], "reconcile": r["submitting_at"] is not None}

    def video_refusal(self, video_id, cut):
        self.calls.append(("video_refusal", video_id, cut))
        return self._answer(self.video_refusals)

    def request_refusal(self, rid):
        self.calls.append(("request_refusal", rid))
        return self._answer(self.request_refusals)

    def mark_submitting(self, rid, worker):
        self.calls.append(("mark_submitting", rid))
        if self.request["claimed_by"] != worker or self.request["status"] != "queued":
            return False
        self.request["submitting_at"] = "now"
        return True

    def quota_take(self, project, units, ceiling):
        self.calls.append(("quota", units, ceiling))
        cap = ceiling if self.ceiling_units is None else min(ceiling, self.ceiling_units)
        if units > cap or self.used + units > cap:
            return False
        self.used += units
        return True

    def finish(self, rid, worker, status, reason, before, after, units, retry):
        if self.fail_finish:
            raise RuntimeError("finish_visibility_request: HTTP 503")
        r = self.request
        self.finishes.append((status, reason, before, after, units, retry))
        if r["status"] != "queued" or r["claimed_by"] != worker:
            return {"ok": False, "error": "not_holder"}
        reason = reason if status == "applied" or reason in vp.REASONS else "worker_error"
        if status == "applied":
            reason = None
            if after != "public":
                raise ValueError("applied_needs_readback")
        if status == "queued" and r["attempts"] >= 3:
            status = "failed"
        r["units"] += units
        r["before"] = before or r["before"]
        if status == "queued":
            r.update(reason=reason, claimed_by=None, next_attempt=retry)
            return {"ok": True, "status": "queued", "reason": reason}
        r.update(status=status, reason=reason, after=after, claimed_by=None)
        return {"ok": True, "status": status, "reason": reason}


def good_credentials(channel_id):
    ctx = SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=YT_CHANNEL))
    return token_json(), ctx


def run(store, yt, *, credentials=good_credentials, claim=True, **kw):
    """Claim as w1 and process, the way VisibilityService.run_once does."""
    req = store.claim("w1") if claim else dict(store.request, reconcile=False)
    assert req, "nothing to claim"
    built = []

    def factory(tj, ctx):
        built.append(tj)
        return yt

    out = vp.process_request(req, store=store, credentials=credentials, service_factory=factory, worker_id="w1",
                             sleep=lambda s: None, **kw)
    return out, built


class HappyPath(unittest.TestCase):
    def test_private_to_public_is_applied_only_after_the_read_back_says_public(self):
        store, yt = MemoryStore(), wrap()
        out, _ = run(store, yt)
        self.assertEqual(out, "applied")
        self.assertEqual(store.finishes, [("applied", None, "private", "public", 53, None)])
        self.assertEqual(len(yt.updates), 1)
        # videos.update asks for the status part ONLY (snippet would overwrite the title, description and tags)
        sent = yt.updates[0]
        self.assertEqual(sent["part"], "status")
        self.assertEqual(set(sent["body"]), {"id", "status"})
        # and it sends back the video's own writable status fields, privacy set, nothing read-only, no schedule
        self.assertEqual(sent["body"]["status"], {"embeddable": True, "license": "youtube", "publicStatsViewable": True,
                                                  "selfDeclaredMadeForKids": False, "privacyStatus": "public"})
        self.assertNotIn("snippet", json.dumps(sent))
        # the 1 + 1 + 50 + 1 units are what the ledger was asked for (the day's budget for the write came first)
        self.assertEqual([c[1] for c in store.calls if c[0] == "quota"], [2, 50, 1])
        self.assertEqual(store.request["status"], "applied")

    def test_the_database_is_asked_twice_with_the_cut_recorded_at_approval_and_the_second_time_is_right_before_the_write(self):
        store, yt = MemoryStore(), wrap()
        run(store, yt)
        names = [c[0] for c in store.calls]
        # re-check pair, ... YouTube read ..., re-check pair, budget for the write, marker, write
        self.assertEqual(names.count("video_refusal"), 2)
        self.assertEqual(names.count("request_refusal"), 2)
        for c in store.calls:
            if c[0] == "video_refusal":
                self.assertEqual(c[1:], (VID, CUT))
        last_check = max(i for i, n in enumerate(names) if n in ("video_refusal", "request_refusal"))
        self.assertLess(last_check, names.index("mark_submitting"))
        self.assertEqual(names.index("mark_submitting") - last_check, 2)     # check, quota(50), mark: nothing in between
        self.assertEqual(names[last_check + 1], "quota")


class ReadBackTruth(unittest.TestCase):
    def test_a_successful_call_that_leaves_the_video_private_is_refused_never_applied(self):
        # an API project that has not passed YouTube's compliance audit: the write is accepted, the video stays private
        store, yt = MemoryStore(), wrap(update="kept_private")
        out, _ = run(store, yt)
        self.assertEqual(out, "refused")
        status, reason, before, after, units, _ = store.finishes[-1]
        self.assertEqual((status, reason, before, after), ("refused", "platform_kept_private", "private", "private"))
        self.assertEqual(len(yt.updates), 1)             # asked once, never repeated
        self.assertNotEqual(store.request["status"], "applied")

    def test_unlisted_after_the_call_is_not_called_public_either(self):
        store, yt = MemoryStore(), wrap(update="kept_private")
        yt.update = lambda part, body: SimpleNamespace(execute=lambda: (setattr(yt, "privacy", "unlisted"), {})[1])
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1], store.finishes[-1][3]), ("refused", "privacy_changed", "unlisted"))

    def test_a_read_back_that_cannot_be_read_is_never_a_success(self):
        store = MemoryStore()
        yt = wrap(list_errors=[None, HttpError(503), HttpError(503)])
        out, _ = run(store, yt)
        self.assertEqual(out, "queued")
        self.assertEqual(store.finishes[-1][:2], ("queued", "readback_failed"))
        self.assertNotIn("applied", [f[0] for f in store.finishes])
        # the next claim READS first: the write did land, and that is recognised as the answer to ours
        store.request.update(claimed_by=None)
        req = store.claim("w1")
        self.assertTrue(req["reconcile"])
        out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w1",
                                 sleep=lambda s: None)
        self.assertEqual(out, "applied")
        self.assertEqual(len(yt.updates), 1)             # no second write

    def test_the_database_itself_refuses_an_applied_that_was_not_read_back_public(self):
        store = MemoryStore()
        store.claim("w1")
        with self.assertRaises(ValueError):
            store.finish(7, "w1", "applied", None, "private", "private", 0, None)


class TheDatabaseSaysNo(unittest.TestCase):
    def assert_not_called(self, yt, store, out, status, reason):
        self.assertEqual(out, status)
        self.assertEqual(store.finishes[-1][:2], (status, reason))
        self.assertEqual(yt.updates, [])
        self.assertEqual(yt.lists, 0)                    # nothing was asked of YouTube at all

    def test_the_cut_changed_between_approval_and_run(self):
        store, yt = MemoryStore(video_refusals=["cut_changed"]), wrap()
        out, built = run(store, yt)
        self.assert_not_called(yt, store, out, "refused", "cut_changed")
        self.assertEqual(built, [])

    def test_the_approval_expired(self):
        store, yt = MemoryStore(video_refusals=["approval_expired"]), wrap()
        out, _ = run(store, yt)
        self.assert_not_called(yt, store, out, "expired", "approval_expired")

    def test_the_channels_switch_was_turned_off_in_between(self):
        store, yt = MemoryStore(request_refusals=["not_enabled"]), wrap()
        out, _ = run(store, yt)
        self.assert_not_called(yt, store, out, "refused", "not_enabled")

    def test_every_word_the_database_can_answer_ends_the_request_without_a_call(self):
        for word in ("video_not_found", "not_uploaded", "gate_blocked", "gate_unknown", "rejected", "already_public", "no_preview",
                     "cut_unknown", "cut_changed", "not_approved"):
            store, yt = MemoryStore(video_refusals=[word]), wrap()
            out, _ = run(store, yt)
            self.assert_not_called(yt, store, out, "refused", word)
        store, yt = MemoryStore(request_refusals=["approval_superseded"]), wrap()
        self.assert_not_called(yt, store, run(store, yt)[0], "refused", "approval_superseded")
        store, yt = MemoryStore(request_refusals=["channel_not_connected"]), wrap()
        self.assert_not_called(yt, store, run(store, yt)[0], "failed", "channel_not_connected")

    def test_a_change_between_the_first_check_and_the_write_stops_the_write(self):
        # the first pair of checks passes; YouTube is read; the video changed meanwhile: the check right before the write says no
        store, yt = MemoryStore(video_refusals=[None, "cut_changed"]), wrap()
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][:2]), ("refused", ("refused", "cut_changed")))
        self.assertEqual(yt.updates, [])
        self.assertGreaterEqual(yt.lists, 1)
        self.assertNotIn("mark_submitting", [c[0] for c in store.calls])
        store, yt = MemoryStore(request_refusals=[None, "not_enabled"]), wrap()
        out, _ = run(store, yt)
        self.assertEqual((out, yt.updates), ("refused", []))
        store, yt = MemoryStore(video_refusals=[None, "approval_expired"]), wrap()
        out, _ = run(store, yt)
        self.assertEqual((out, yt.updates), ("expired", []))

    def test_a_malformed_request_is_refused_before_anything_is_asked(self):
        store, yt = MemoryStore(), wrap()
        store.request["video_id"] = "not-an-id"
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1]), ("refused", "not_uploaded"))
        self.assertEqual(store.calls, [])


class Token(unittest.TestCase):
    def test_a_token_the_vault_cannot_give_is_token_expired_and_youtube_is_not_called(self):
        def broken(channel_id):
            raise channel_tokens.ChannelTokenError("the channel's token could not be read; reconnect the channel")

        store, yt = MemoryStore(), wrap()
        out, built = run(store, yt, credentials=broken)
        self.assertEqual((out, store.finishes[-1][:2], built), ("failed", ("failed", "token_expired"), []))

    def test_an_unconfirmed_or_unknown_channel_is_not_connected(self):
        for exc in (KeyError("x"), ValueError("x")):
            def broken(channel_id, exc=exc):
                raise exc

            store, yt = MemoryStore(), wrap()
            out, _ = run(store, yt, credentials=broken)
            self.assertEqual((out, store.finishes[-1][1]), ("failed", "channel_not_connected"))
        store, yt = MemoryStore(), wrap()
        out, _ = run(store, yt, credentials=lambda cid: ("", SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=YT_CHANNEL))))
        self.assertEqual((out, store.finishes[-1][1]), ("failed", "channel_not_connected"))

    def test_youtube_upload_alone_is_not_enough_to_change_a_videos_privacy(self):
        store, yt = MemoryStore(), wrap()
        out, built = run(store, yt, credentials=lambda cid: (token_json([UPLOAD, "https://www.googleapis.com/auth/youtube.readonly"]),
                                                              SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=YT_CHANNEL))))
        self.assertEqual((out, store.finishes[-1][1], built, store.used), ("failed", "scope_missing", [], 0))
        # a token with no scopes in it at all is the same: unknown is not a yes
        out, built = run(MemoryStore(), wrap(), credentials=lambda cid: (json.dumps({"refresh_token": REFRESH}),
                                                                          SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=YT_CHANNEL))))
        self.assertEqual((out, built), ("failed", []))
        for scope in ("https://www.googleapis.com/auth/youtube", FORCE_SSL, "https://www.googleapis.com/auth/youtubepartner"):
            store, yt = MemoryStore(), wrap()
            out, _ = run(store, yt, credentials=lambda cid, s=scope: (token_json([s]), SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=YT_CHANNEL))))
            self.assertEqual(out, "applied", scope)

    def test_a_refresh_failure_or_401_is_token_expired_and_never_retried_blindly(self):
        for exc_at in ("factory", "read"):
            store = MemoryStore()
            yt = wrap(list_errors=[HttpError(401, "authError")] if exc_at == "read" else [])
            req = store.claim("w1")

            def factory(tj, ctx, exc_at=exc_at, yt=yt):
                if exc_at == "factory":
                    raise RefreshError("invalid_grant: Token has been expired or revoked.")
                return yt

            out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=factory, worker_id="w1",
                                     sleep=lambda s: None)
            self.assertEqual((out, store.finishes[-1][1]), ("failed", "token_expired"), exc_at)
            self.assertEqual(yt.updates, [])

    def test_a_token_that_cannot_reach_the_channel_is_not_connected(self):
        store, yt = MemoryStore(), wrap()
        req = store.claim("w1")

        def factory(tj, ctx):
            raise ValueError("kanal ID not found in this token")

        out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=factory, worker_id="w1", sleep=lambda s: None)
        self.assertEqual((out, store.finishes[-1][1]), ("failed", "channel_not_connected"))


class Quota(unittest.TestCase):
    def test_no_budget_for_the_checks_means_no_youtube_call(self):
        store, yt = MemoryStore(ceiling_units=1), wrap()
        out, built = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1], built), ("failed", "quota_exceeded", []))
        self.assertEqual(yt.updates, [])

    def test_no_budget_for_the_write_means_no_write(self):
        store, yt = MemoryStore(ceiling_units=51), wrap()      # 2 for the checks, then 50 more would pass 51
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1]), ("failed", "quota_exceeded"))
        self.assertEqual(yt.updates, [])
        self.assertNotIn("mark_submitting", [c[0] for c in store.calls])
        # exactly enough is enough
        store, yt = MemoryStore(ceiling_units=52), wrap()
        self.assertEqual(run(store, yt)[0], "applied")

    def test_youtubes_own_quota_answer_ends_the_request_for_the_day(self):
        store = MemoryStore()
        yt = wrap(update_errors=[HttpError(403, "quotaExceeded")])
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1]), ("failed", "quota_exceeded"))
        self.assertEqual(len(yt.updates), 1)              # not retried


class Errors(unittest.TestCase):
    def test_a_4xx_policy_answer_is_never_retried(self):
        for status, reason in ((403, "forbidden"), (400, "invalidVideoMetadata"), (409, "conflict")):
            store = MemoryStore()
            yt = wrap(update_errors=[HttpError(status, reason)])
            out, _ = run(store, yt)
            self.assertEqual((out, store.finishes[-1][1]), ("refused", "platform_refused"), status)
            self.assertEqual(len(yt.updates), 1)
            self.assertEqual(store.request["status"], "refused")

    def test_a_403_that_names_a_missing_permission_is_the_token_to_fix_not_a_refusal(self):
        store = MemoryStore()
        out, _ = run(store, wrap(update_errors=[HttpError(403, "insufficientPermissions")]))
        self.assertEqual((out, store.finishes[-1][1]), ("failed", "scope_missing"))

    def test_a_video_that_is_gone_from_youtube(self):
        store = MemoryStore()
        out, _ = run(store, wrap(found=False))
        self.assertEqual((out, store.finishes[-1][1]), ("refused", "video_not_found_on_youtube"))
        store = MemoryStore()
        out, _ = run(store, wrap(list_errors=[HttpError(404, "videoNotFound")]))
        self.assertEqual((out, store.finishes[-1][1]), ("refused", "video_not_found_on_youtube"))

    def test_429_is_retried_with_backoff_and_succeeds_on_the_next_claim_without_a_second_write(self):
        store = MemoryStore()
        yt = wrap(update_errors=[HttpError(429, "rateLimitExceeded")])
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][:2]), ("queued", ("queued", "rate_limited")))
        self.assertEqual(store.request["next_attempt"], 30)
        self.assertEqual(store.request["status"], "queued")
        # the write was sent (marked) and refused: the next claim reads first and, the video being private, writes once more
        req = store.claim("w1")
        self.assertEqual((req["attempts"], req["reconcile"]), (2, True))
        out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w1",
                                 sleep=lambda s: None)
        self.assertEqual(out, "applied")
        self.assertEqual(len(yt.updates), 2)

    def test_a_5xx_that_landed_is_recognised_by_the_read_back_not_retried(self):
        store = MemoryStore()
        yt = wrap(update_errors=[HttpError(503)], lands_on_error=True)
        out, _ = run(store, yt)
        self.assertEqual(out, "applied")
        self.assertEqual(len(yt.updates), 1)

    def test_a_5xx_that_did_not_land_is_retried_and_ends_after_three_claims(self):
        store = MemoryStore()
        yt = wrap(update_errors=[HttpError(500), HttpError(502), HttpError(503)])
        waits = []
        for _ in range(3):
            req = store.claim("w1")
            self.assertIsNotNone(req)
            vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w1",
                               sleep=lambda s: None)
            waits.append(store.request["next_attempt"])
        self.assertEqual(waits[:2], [30, 120])
        self.assertEqual((store.request["status"], store.request["reason"]), ("failed", "platform_error"))
        self.assertIsNone(store.claim("w1"))
        self.assertEqual(len(yt.updates), 3)

    def test_a_transport_failure_is_ambiguous_and_read_back(self):
        store = MemoryStore()
        yt = wrap(update_errors=[ConnectionResetError("reset by peer")], lands_on_error=True)
        self.assertEqual(run(store, yt)[0], "applied")
        self.assertEqual(len(yt.updates), 1)

    def test_still_processing_waits_and_retries(self):
        store = MemoryStore()
        out, _ = run(store, wrap(upload_status="uploaded"))
        self.assertEqual((out, store.finishes[-1][:2]), ("queued", ("queued", "still_processing")))

    def test_an_unforeseen_error_goes_back_to_the_queue_with_its_type_only(self):
        store, yt = MemoryStore(), wrap()

        def broken(channel_id):
            raise RuntimeError(f"boom {TOKEN}")

        out, _ = run(store, yt, credentials=broken)
        self.assertEqual((out, store.finishes[-1][:2]), ("queued", ("queued", "worker_error")))
        self.assertNotIn(TOKEN, json.dumps(store.finishes))
        # an error of a kind we do not know, from YouTube's own calls, is a failure (a person may try again), not a guess
        store = MemoryStore()
        out, _ = run(store, wrap(list_errors=[KeyError(TOKEN)]))
        self.assertEqual((out, store.finishes[-1][:2]), ("failed", ("failed", "worker_error")))
        self.assertNotIn(TOKEN, json.dumps(store.finishes))


class WhatIsOnYouTube(unittest.TestCase):
    def test_a_persons_own_choice_is_never_overridden(self):
        for kw in ({"privacy": "unlisted"}, {"status_extra": {"publishAt": "2026-12-01T10:00:00Z"}}):
            store, yt = MemoryStore(), wrap(**kw)
            out, _ = run(store, yt)
            self.assertEqual((out, store.finishes[-1][1]), ("refused", "privacy_changed"), kw)
            self.assertEqual(yt.updates, [])

    def test_a_video_already_public_is_not_ours_to_claim_unless_our_own_write_may_have_made_it_so(self):
        store, yt = MemoryStore(), wrap(privacy="public")
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1:4]), ("refused", ("already_public", "public", "public")))
        self.assertEqual(yt.updates, [])
        # a crashed earlier claim marked "submitting": public now is the result of that write
        store, yt = MemoryStore(), wrap(privacy="public")
        store.request["submitting_at"] = "then"
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][:4]), ("applied", ("applied", None, None, "public")))
        self.assertEqual(yt.updates, [])

    def test_the_channel_that_owns_the_video_must_be_the_channel_of_the_request(self):
        store, yt = MemoryStore(), wrap(channel="UCsomeoneelse000000000001")
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1], yt.updates), ("refused", "channel_mismatch", []))

    def test_a_video_youtube_rejected_or_is_still_processing(self):
        for st in ("rejected", "failed", "deleted"):
            store, yt = MemoryStore(), wrap(upload_status=st)
            out, _ = run(store, yt)
            self.assertEqual((out, store.finishes[-1][1]), ("refused", "rejected_by_youtube"), st)
        store, yt = MemoryStore(), wrap(status_extra={"rejectionReason": "copyright"})
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][1]), ("refused", "rejected_by_youtube"))


class ReplayAndCrash(unittest.TestCase):
    def test_a_finished_request_is_never_claimed_again_and_a_stale_replay_writes_nothing(self):
        store, yt = MemoryStore(), wrap()
        self.assertEqual(run(store, yt)[0], "applied")
        self.assertIsNone(store.claim("w1"))
        self.assertIsNone(store.claim("w2"))
        # a stale copy of the claim processed again (a double delivery): YouTube already says public, so nothing is written, and
        # the finished row does not move
        run(store, yt, claim=False)
        self.assertEqual(len(yt.updates), 1)
        self.assertEqual(store.request["status"], "applied")
        self.assertEqual(store.request["after"], "public")

    def test_a_crash_after_the_write_was_sent_is_recognised_by_the_next_claim_and_not_repeated(self):
        store, yt = MemoryStore(), wrap()
        store.fail_finish = True              # the process dies (the database cannot be reached) after the write landed
        out, _ = run(store, yt)
        self.assertEqual(out, "queued")
        self.assertEqual(len(yt.updates), 1)
        self.assertEqual(yt.privacy, "public")
        self.assertEqual(store.request["status"], "queued")
        self.assertEqual(store.request["submitting_at"], "now")
        # restart: the lease runs out, a new worker claims it, READS first, finds public and finishes it
        store.fail_finish = False
        store.request["claimed_by"] = None
        req = store.claim("w2")
        self.assertTrue(req["reconcile"])
        yt2 = wrap(privacy="public")
        out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt2, worker_id="w2",
                                 sleep=lambda s: None)
        self.assertEqual(out, "applied")
        self.assertEqual(yt2.updates, [])
        self.assertEqual(store.request["status"], "applied")

    def test_a_crash_before_the_write_reaches_youtube_writes_it_once_on_the_next_claim(self):
        store = MemoryStore()
        yt = wrap(update_errors=[ConnectionResetError("reset")])       # the bytes never arrived: still private after
        self.assertEqual(run(store, yt)[0], "queued")
        self.assertEqual(yt.privacy, "private")
        req = store.claim("w1")
        self.assertTrue(req["reconcile"])
        out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w1",
                                 sleep=lambda s: None)
        self.assertEqual(out, "applied")
        self.assertEqual(len(yt.updates), 2)                       # one failed send, one that landed: never two landings

    def test_losing_the_lease_before_the_write_means_no_write(self):
        store, yt = MemoryStore(), wrap()
        store.mark_submitting = lambda rid, worker: False               # another worker holds it now
        out, _ = run(store, yt)
        self.assertEqual((out, yt.updates, store.finishes), ("queued", [], []))


class NothingSecretIsLoggedOrStored(unittest.TestCase):
    def test_no_token_body_or_provider_text_reaches_a_log_line_or_a_stored_word(self):
        records = []

        class Cap(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        h = Cap()
        root = logging.getLogger()
        old = root.level
        root.addHandler(h)
        root.setLevel(logging.DEBUG)
        try:
            scripts = [
                dict(update_errors=[HttpError(403, "forbidden")]),
                dict(update_errors=[HttpError(500)]),
                dict(list_errors=[HttpError(401, "authError")]),
                dict(list_errors=[KeyError(TOKEN)]),
                dict(update="kept_private"),
                dict(),
            ]
            stores = []
            for kw in scripts:
                store, yt = MemoryStore(), wrap(**kw)
                run(store, yt)
                stores.append(store)
        finally:
            root.removeHandler(h)
            root.setLevel(old)
        everything = "\n".join(records) + json.dumps([s.finishes for s in stores]) + json.dumps([s.calls for s in stores])
        for secret in (TOKEN, REFRESH, "cs-secret", "secret-body-text", "secret title"):
            self.assertNotIn(secret, everything)
        for s in stores:
            for status, reason, *_ in s.finishes:
                self.assertTrue(reason is None or reason in vp.REASONS, reason)
                self.assertIn(status, ("applied", "refused", "failed", "expired", "queued"))


class ClosedVocabulary(unittest.TestCase):
    def test_every_word_has_exactly_one_end_and_the_sql_and_the_panel_know_the_same_words(self):
        for w in vp.REASONS:
            self.assertEqual(sum([w in vp.EXPIRED, w in vp.FAILED, vp.status_of(w) == "refused"]), 1, w)
        self.assertEqual(len(vp.REASONS), len(set(vp.REASONS)))
        sql = (REPO / "supabase" / "migrations" / "0113_visibility_requests.sql").read_text(encoding="utf-8")
        fn = re.search(r"function public\.visibility_reason_words\(\).*?select array\[(.*?)\]::text\[\]", sql, re.S).group(1)
        words = re.findall(r"'([a-z_]+)'", "\n".join(ln.split("--", 1)[0] for ln in fn.splitlines()))
        self.assertEqual(sorted(words), sorted(vp.REASONS))
        ts = (REPO / "command-center" / "lib" / "visibilityRequest.ts").read_text(encoding="utf-8")
        block = re.search(r"VISIBILITY_REASONS = \[(.*?)\] as const", ts, re.S).group(1)
        self.assertEqual(sorted(re.findall(r'"([a-z_]+)"', block)), sorted(vp.REASONS))

    def test_the_budget_numbers_are_youtubes(self):
        self.assertEqual((vp.UNITS_UPDATE, vp.UNITS_LIST, vp.MAX_CLAIMS), (50, 1, 3))
        self.assertNotIn("https://www.googleapis.com/auth/youtube.upload", vp.UPDATE_SCOPES)

    def test_the_worker_is_off_unless_it_is_switched_on_and_the_settings_are_bounded(self):
        self.assertFalse(vp.enabled({}))
        self.assertFalse(vp.enabled({"NIGHTSHIFT_VISIBILITY_PUBLISH": "off"}))
        self.assertFalse(vp.enabled({"NIGHTSHIFT_VISIBILITY_PUBLISH": "maybe"}))
        self.assertTrue(vp.enabled({"NIGHTSHIFT_VISIBILITY_PUBLISH": "ON"}))
        self.assertEqual(vp._ceiling(""), vp.DEFAULT_DAILY_UNITS)
        self.assertEqual(vp._ceiling("99999"), vp.PROJECT_POOL)
        self.assertEqual(vp._ceiling("-5"), 0)
        self.assertEqual(vp._ceiling("abc"), vp.DEFAULT_DAILY_UNITS)
        self.assertEqual(vp._project("Bad Name!"), "default")
        self.assertEqual(vp._project("My-Project.1"), "my-project.1")


class Rest(unittest.TestCase):
    def test_the_store_calls_the_functions_with_the_service_key_and_never_echoes_a_body(self):
        calls = []

        class Resp:
            def __init__(self, status, body):
                self.status_code, self._b = status, body

            def json(self):
                return self._b

        class Session:
            def __init__(self, resp):
                self.resp = resp

            def post(self, url, json=None, headers=None, timeout=None):
                calls.append((url, json, headers))
                return self.resp

        s = vp.VisibilityStore("https://x.supabase.co/", "svc-key", session=Session(Resp(200, {"id": 3})))
        self.assertEqual(s.claim("w1"), {"id": 3})
        self.assertEqual(calls[0][0], "https://x.supabase.co/rest/v1/rpc/claim_visibility_request")
        self.assertEqual(calls[0][1], {"p_worker": "w1"})
        self.assertEqual(calls[0][2]["apikey"], "svc-key")
        s._http = Session(Resp(200, "gate_blocked"))
        self.assertEqual(s.video_refusal(VID, CUT), "gate_blocked")
        self.assertEqual(calls[-1][1], {"p_video_id": VID, "p_cut_sha256": CUT})
        s._http = Session(Resp(200, None))
        self.assertIsNone(s.video_refusal(VID, CUT))
        self.assertIsNone(s.request_refusal(3))
        s._http = Session(Resp(200, True))
        self.assertTrue(s.mark_submitting(3, "w1"))
        self.assertTrue(s.quota_take("p", 50, 1000))
        s._http = Session(Resp(200, False))
        self.assertFalse(s.quota_take("p", 50, 1000))
        s._http = Session(Resp(200, {"ok": True, "status": "applied"}))
        self.assertEqual(s.finish(3, "w1", "applied", None, "private", "public", 53, None)["status"], "applied")
        self.assertEqual(calls[-1][1], {"p_request_id": 3, "p_worker": "w1", "p_status": "applied", "p_reason": None,
                                        "p_before": "private", "p_after": "public", "p_units": 53, "p_retry_seconds": None})
        s._http = Session(Resp(404, {"message": "no function"}))
        self.assertIsNone(s.claim("w1"))                      # 0113 not applied: nothing to do
        s._http = Session(Resp(500, {"message": f"secret {TOKEN}"}))
        with self.assertRaises(RuntimeError) as ctx:
            s.claim("w1")
        self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertIn("HTTP 500", str(ctx.exception))

    def test_run_once_handles_at_most_one_request_and_never_raises(self):
        store, yt = MemoryStore(), wrap()
        svc = vp.VisibilityService("u", "k", worker_id="w1", credentials=good_credentials, service_factory=lambda t, c: yt,
                                   store=store, project="p", ceiling=1000)
        self.assertTrue(svc.run_once())
        self.assertEqual(store.request["status"], "applied")
        self.assertFalse(svc.run_once())                       # nothing left

        class Down:
            def claim(self, w):
                raise RuntimeError("claim_visibility_request: HTTP 503")

        svc = vp.VisibilityService("u", "k", worker_id="w1", credentials=good_credentials, store=Down())
        self.assertFalse(svc.run_once())
        self.assertFalse(svc.run_once())


class QueueWorkerWiring(unittest.TestCase):
    def test_it_is_off_unless_given_and_a_failure_in_it_never_stops_the_loop(self):
        from tools import queue_worker as qw

        w = qw.Worker(SimpleNamespace(claim=lambda *a: None), worker_id="w1", env={})
        self.assertIsNone(w.visibility)
        self.assertFalse(w._visibility_one())

        class Boom:
            def run_once(self):
                raise RuntimeError(f"boom {TOKEN}")

        w = qw.Worker(SimpleNamespace(claim=lambda *a: None), worker_id="w1", env={}, visibility=Boom())
        self.assertFalse(w._visibility_one())

        class Ran:
            n = 0

            def run_once(self):
                Ran.n += 1
                return True

        w = qw.Worker(SimpleNamespace(claim=lambda *a: None), worker_id="w1", env={}, visibility=Ran())
        self.assertTrue(w._visibility_one())
        self.assertEqual(Ran.n, 1)

    def test_main_builds_the_service_only_when_the_environment_says_on(self):
        src = (REPO / "tools" / "queue_worker.py").read_text(encoding="utf-8")
        self.assertIn("if visibility_publish.enabled():", src)
        self.assertIn("visibility=visibility)", src)
        # the loop runs it between render jobs, after the comment inbox, before it claims a render
        loop = src[src.index("def run_forever"):src.index("def _publish_one")]
        self.assertLess(loop.index("self._comments_one()"), loop.index("self._visibility_one()"))
        self.assertLess(loop.index("self._visibility_one()"), loop.index("self.client.claim("))


class OnlyOneWriterOfAnExistingVideosPrivacy(unittest.TestCase):
    """CLAUDE.md rule 2, as code: the only place in the pipeline's Python that changes an existing video's privacy is this module,
    and it is reached from exactly one caller, behind two switches."""

    def test_nothing_else_calls_videos_update_or_names_a_privacy_to_write(self):
        offenders = []
        for path in list((REPO / "modules").rglob("*.py")) + list((REPO / "tools").rglob("*.py")) + [REPO / "main.py"]:
            text = path.read_text(encoding="utf-8")
            if path.name == "visibility_publish.py":
                continue
            if re.search(r"videos\(\)\s*\.\s*update\(", text) or re.search(r"\.videos\(\)\.update", text):
                offenders.append(path.name)
        self.assertEqual(offenders, [])

    def test_the_module_is_called_from_the_queue_worker_alone(self):
        users = []
        for path in list((REPO / "modules").rglob("*.py")) + list((REPO / "tools").rglob("*.py")) + [REPO / "main.py"]:
            if path.name == "visibility_publish.py":
                continue
            if "visibility_publish" in path.read_text(encoding="utf-8"):
                users.append(path.name)
        self.assertEqual(users, ["queue_worker.py"])


if __name__ == "__main__":
    unittest.main()
