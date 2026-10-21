"""modules/visibility_publish.py — the worker that makes an APPROVED, uploaded, private YouTube video public, with the
transport mocked (no real YouTube call, no token, no money).

What would break without these:

  * the worker acts on a request the database would now refuse (the cut changed after the approval, the approval ran out, the
    channel's switch was turned off, the gate verdict is not an allowed one): it must ask again, with the cut hash recorded at
    approval, BEFORE any YouTube call, and the database asks once more, for good, in the step that sets the marker right before
    the write (mark_visibility_submitting); a word ends the request;
  * the switch is turned off while the write may be on its way and the worker records nothing, or records "applied" in its log
    when the database did not take it;
  * the update is sent from a read that lacked the made-for-kids declaration (it would reset it);
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
ORG = "11111111-1111-4111-8111-111111111111"


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
                 update="ok", update_errors=(), list_errors=(), found=True, lands_on_error=False, drop_status=()):
        self.privacy = privacy
        self.upload_status = upload_status
        self.channel = channel
        self.extra = {"embeddable": True, "license": "youtube", "publicStatsViewable": True, "selfDeclaredMadeForKids": False,
                      "madeForKids": False, **(status_extra or {})}
        for k in drop_status:
            self.extra.pop(k, None)
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
    """The database's side of the contract, in memory: the same rules the SQL functions of 0116 enforce."""

    def __init__(self, *, video_refusals=(), request_refusals=(), ceiling_units=None, gap=None, org_units=None):
        self.video_refusals = list(video_refusals)       # one answer per call; the last repeats
        self.request_refusals = list(request_refusals)
        self.gap = gap                                   # what changed between the early check and the marker (mark's answer)
        self.used = 0
        self.used_org = 0
        self.ceiling_units = ceiling_units
        self.org_units = org_units
        self.refund_fails = False
        self.mirror = None                               # videos.privacy as the database would have it
        self.on_mark = None                              # something that happens right after the marker is set
        self.calls = []
        self.request = {"id": 7, "video_id": VID, "channel_id": "chan", "org_id": ORG, "approved_cut_sha256": CUT, "attempts": 1, "reconcile": False,
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
        return {"id": r["id"], "video_id": r["video_id"], "channel_id": r["channel_id"], "org_id": r["org_id"],
                "approved_cut_sha256": r["approved_cut_sha256"], "attempts": r["attempts"],
                "reconcile": r["submitting_at"] is not None, "read_only": bool(r.get("read_only"))}

    def video_refusal(self, video_id, cut):
        self.calls.append(("video_refusal", video_id, cut))
        return self._answer(self.video_refusals)

    def request_refusal(self, rid):
        self.calls.append(("request_refusal", rid))
        return self._answer(self.request_refusals)

    def mark_submitting(self, rid, worker):
        """The database's last check and the marker in one step: 'ok', 'not_holder', or the closed word that says no."""
        self.calls.append(("mark_submitting", rid))
        if self.request["claimed_by"] != worker or self.request["status"] != "queued":
            return "not_holder"
        if self.gap:
            return self.gap
        self.request["submitting_at"] = "now"
        if self.on_mark:
            self.on_mark()
        return "ok"

    def quota_take(self, project, units, ceiling, org, org_ceiling):
        self.calls.append(("quota", units, ceiling, org, org_ceiling))
        cap = ceiling if self.ceiling_units is None else min(ceiling, self.ceiling_units)
        ocap = org_ceiling if self.org_units is None else min(org_ceiling, self.org_units)
        if units > cap or self.used + units > cap or self.used_org + units > ocap:
            return False
        self.used += units
        self.used_org += units
        return True

    def quota_refund(self, project, units, org):
        self.calls.append(("refund", units, org))
        if self.refund_fails:
            raise RuntimeError("youtube_quota_refund: HTTP 503")
        self.used = max(self.used - units, 0)
        self.used_org = max(self.used_org - units, 0)
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
        if after in ("private", "unlisted", "public"):
            self.mirror = after
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
        self.assertEqual(store.mirror, "public")

    def test_the_database_is_asked_early_with_the_cut_recorded_at_approval_and_the_last_check_is_the_marker_itself(self):
        store, yt = MemoryStore(), wrap()
        run(store, yt)
        names = [c[0] for c in store.calls]
        # early (a cheap filter): the video-level and request-level questions once, before YouTube is touched ...
        self.assertEqual(names.count("video_refusal"), 1)
        self.assertEqual(names.count("request_refusal"), 1)
        for c in store.calls:
            if c[0] == "video_refusal":
                self.assertEqual(c[1:], (VID, CUT))
        # ... and the last check is not a call of the worker's at all: it is the database's, inside the marker's own step, so
        # nothing sits between "asked again" and "marked": budget for the write, then the marker, then the write
        self.assertEqual(names[names.index("mark_submitting") - 1], "quota")
        self.assertEqual([c[1] for c in store.calls if c[0] == "quota"], [2, 50, 1])
        self.assertLess(max(i for i, n in enumerate(names) if n in ("video_refusal", "request_refusal")), names.index("mark_submitting"))
        self.assertEqual(len(yt.updates), 1)


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
        # a channel that requires a second person: one approver's act never makes a video public (refused, not retried, not failed)
        store, yt = MemoryStore(request_refusals=["two_person_required"]), wrap()
        self.assert_not_called(yt, store, run(store, yt)[0], "refused", "two_person_required")
        store, yt = MemoryStore(request_refusals=["channel_not_connected"]), wrap()
        self.assert_not_called(yt, store, run(store, yt)[0], "failed", "channel_not_connected")

    def test_a_change_between_the_early_check_and_the_marker_stops_the_write_because_the_marker_asks_again(self):
        # the early pair passes; YouTube is read; the video changed meanwhile: the database's answer in the marker's own step says no
        for word, end_status in (("cut_changed", "refused"), ("not_approved", "refused"), ("not_enabled", "refused"),
                                 ("approval_superseded", "refused"), ("already_public", "refused"), ("gate_blocked", "refused"), ("two_person_required", "refused"),
                                 ("approval_expired", "expired"), ("channel_not_connected", "failed")):
            store, yt = MemoryStore(gap=word), wrap()
            out, _ = run(store, yt)
            self.assertEqual((out, store.finishes[-1][:2]), (end_status, (end_status, word)), word)
            self.assertEqual(yt.updates, [], word)
            self.assertGreaterEqual(yt.lists, 1)
            self.assertIn("mark_submitting", [c[0] for c in store.calls])
            self.assertIsNone(store.request["submitting_at"], word)      # nothing was marked: no write may be on its way
            # the 50 units taken for the write that will not be sent were given back: the refusal cost the budget the 2 reads only
            self.assertEqual((store.used, store.used_org), (2, 2), word)
            self.assertEqual([c[:2] for c in store.calls if c[0] == "refund"], [("refund", 50)], word)
            self.assertEqual(store.finishes[-1][4], 2, word)
            names = [c[0] for c in store.calls]
            self.assertLess(names.index("quota", names.index("quota") + 1), names.index("mark_submitting"))   # still taken BEFORE the marker
        # a word the worker does not know is ours, never the text it came in
        store, yt = MemoryStore(gap="drop table;"), wrap()
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][:2], yt.updates), ("failed", ("failed", "worker_error"), []))
        # the early checks still end it before YouTube is read
        store, yt = MemoryStore(request_refusals=[None]), wrap()
        self.assertEqual(run(store, yt)[0], "applied")

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
        with self.assertLogs("modules.visibility_publish", level="WARNING") as logs:
            out, _ = run(store, yt)
        self.assertEqual(out, "unrecorded")             # the database did not take it: nothing says "applied"
        self.assertTrue(any("did NOT record applied" in m for m in logs.output), logs.output)
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
        store.mark_submitting = lambda rid, worker: "not_holder"        # another worker holds it now
        out, _ = run(store, yt)
        self.assertEqual((out, yt.updates, store.finishes), ("queued", [], []))


class TheSwitchIsTurnedOffWhileTheWriteIsOnItsWay(unittest.TestCase):
    """Claim -> marker -> an administrator switches the channel off -> YouTube makes the video public -> the worker finishes.
    The database must say what YouTube says (the switch is not a reason to leave a public video recorded as not published)."""

    def switch_off(self, store):
        store.request_refusals[:] = ["not_enabled"]
        store.video_refusals[:] = [None]

    def test_the_read_back_is_recorded_as_applied_with_the_mirror_even_though_the_switch_is_off_now(self):
        store, yt = MemoryStore(), wrap()
        store.on_mark = lambda: self.switch_off(store)
        with self.assertLogs("modules.visibility_publish", level="INFO") as logs:
            out, _ = run(store, yt)
        self.assertEqual(out, "applied")
        self.assertEqual(store.finishes[-1][:2], ("applied", None))
        self.assertEqual((store.request["status"], store.request["after"], store.mirror), ("applied", "public", "public"))
        self.assertTrue(any("applied" in m and "did NOT" not in m for m in logs.output))

    def test_nothing_is_logged_as_applied_when_the_database_says_it_did_not_take_it(self):
        # the lease went to another worker (or the switch ended the request before the marker) while YouTube was being written
        store, yt = MemoryStore(), wrap()

        def lose():
            store.request["claimed_by"] = "w2"

        store.on_mark = lose
        with self.assertLogs("modules.visibility_publish", level="INFO") as logs:
            out, _ = run(store, yt)
        self.assertEqual(out, "unrecorded")
        self.assertEqual(store.request["status"], "queued")
        self.assertEqual(yt.privacy, "public")           # it IS public: that is why the log must be loud, not quiet
        text = "\n".join(logs.output)
        self.assertIn("did NOT record applied", text)
        self.assertIn("not_holder", text)
        self.assertIn("ERROR", logs.output[-1])
        self.assertNotIn("INFO:modules.visibility_publish:visibility request 7: applied", text)
        # an answer that is not an ok is not a record either, whatever its shape
        for odd in (None, {"ok": False, "error": "not_holder"}, {"status": "applied"}, "ok"):
            store, yt = MemoryStore(), wrap()
            store.finish = lambda *a, odd=odd: odd
            with self.assertLogs("modules.visibility_publish", level="WARNING") as logs:
                self.assertEqual(run(store, yt)[0], "unrecorded")
            self.assertTrue(any("did NOT record applied" in m for m in logs.output))

    def test_a_refusal_the_database_does_not_take_is_logged_too_but_less_loudly(self):
        store, yt = MemoryStore(video_refusals=["cut_changed"]), wrap()
        store.finish = lambda *a: {"ok": False, "error": "not_holder", "status": "refused"}
        with self.assertLogs("modules.visibility_publish", level="WARNING") as logs:
            out, _ = run(store, yt)
        self.assertEqual(out, "unrecorded")
        self.assertIn("WARNING", logs.output[0])
        self.assertIn("did NOT record refused (cut_changed)", logs.output[0])

    def test_the_next_claim_after_a_crash_reads_youtube_even_though_the_database_now_says_no(self):
        # w1 marked, wrote, died. Meanwhile: the switch was turned off (not_enabled) / the approval ran out (approval_expired).
        for refusal_kind, words in (("request", ["not_enabled"]), ("video", ["approval_expired"]), ("video", ["cut_changed"])):
            store = MemoryStore(**{f"{refusal_kind}_refusals": words})
            store.request.update(submitting_at="then", claimed_by=None)
            req = store.claim("w2")
            self.assertTrue(req["reconcile"])
            # YouTube says public: the write landed (or a person did it): that is recorded, whatever the database says now
            yt = wrap(privacy="public")
            out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w2",
                                     sleep=lambda s: None)
            self.assertEqual((out, store.request["status"], store.mirror), ("applied", "applied", "public"), words)
            self.assertEqual(yt.updates, [])
            # YouTube says private: the write did not land, and the database's word stands; YouTube is never written to
            store = MemoryStore(**{f"{refusal_kind}_refusals": words})
            store.request.update(submitting_at="then", claimed_by=None)
            req = store.claim("w2")
            yt = wrap()
            out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w2",
                                     sleep=lambda s: None)
            self.assertEqual(out, vp.status_of(words[0]))
            self.assertEqual(store.finishes[-1][1], words[0])
            self.assertEqual(yt.updates, [])
            self.assertNotEqual(store.request["status"], "applied")

    def test_a_read_that_fails_on_that_claim_is_a_retry_not_a_refusal(self):
        # nothing is known about what YouTube says: ending the request as "not published" could be a lie
        for kw in (dict(list_errors=[HttpError(503)]), dict(list_errors=[HttpError(401, "authError")])):
            store = MemoryStore(request_refusals=["not_enabled"])
            store.request.update(submitting_at="then", claimed_by=None)
            req = store.claim("w2")
            yt = wrap(**kw)
            out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w2",
                                     sleep=lambda s: None)
            self.assertEqual(out, "queued", kw)
            self.assertEqual(store.request["status"], "queued")
            self.assertEqual(yt.updates, [])
        store = MemoryStore(request_refusals=["not_enabled"])
        store.request.update(submitting_at="then", claimed_by=None)
        req = store.claim("w2")
        out = vp.process_request(req, store=store, credentials=lambda cid: ("", None), service_factory=lambda t, c: wrap(), worker_id="w2",
                                 sleep=lambda s: None)
        self.assertEqual((out, store.request["status"]), ("queued", "queued"))

    def test_without_a_marker_the_database_says_no_and_youtube_is_not_even_read(self):
        store, yt = MemoryStore(request_refusals=["not_enabled"]), wrap()
        out, built = run(store, yt)
        self.assertEqual((out, yt.lists, built), ("refused", 0, []))


class TheLastLookOfAMarkedRequest(unittest.TestCase):
    def last_claim(self, store):
        store.request.update(submitting_at="then", claimed_by=None, read_only=True)
        req = store.claim("w9")
        self.assertTrue(req["read_only"] and req["reconcile"])
        return req

    def go(self, store, yt, req):
        return vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w9",
                                  sleep=lambda s: None)

    def test_it_records_public_as_applied(self):
        store, yt = MemoryStore(), wrap(privacy="public")
        self.assertEqual(self.go(store, yt, self.last_claim(store)), "applied")
        self.assertEqual((yt.updates, store.mirror), ([], "public"))

    def test_it_never_writes_whatever_it_finds_and_ends_the_request_as_interrupted(self):
        store, yt = MemoryStore(), wrap()                    # private: a normal claim would write here
        req = self.last_claim(store)
        self.assertEqual(self.go(store, yt, req), "failed")
        self.assertEqual(store.finishes[-1][:2], ("failed", "interrupted"))
        self.assertEqual(yt.updates, [])
        self.assertNotIn("mark_submitting", [c[0] for c in store.calls])
        # the database's own word for it, when it has one, stands
        store, yt = MemoryStore(request_refusals=["not_enabled"]), wrap()
        self.assertEqual(self.go(store, yt, self.last_claim(store)), "refused")
        self.assertEqual((store.finishes[-1][1], yt.updates), ("not_enabled", []))

    def test_a_read_that_fails_is_not_a_final_answer_either(self):
        store, yt = MemoryStore(), wrap(list_errors=[HttpError(503)])
        self.assertEqual(self.go(store, yt, self.last_claim(store)), "queued")
        self.assertEqual(yt.updates, [])


class TheBudgetIsGivenBackWhenTheWriteIsNotSent(unittest.TestCase):
    def test_a_refusing_marker_costs_only_the_reads_and_a_lost_lease_too(self):
        store, yt = MemoryStore(gap="cut_changed"), wrap()
        out, _ = run(store, yt)
        self.assertEqual((out, store.used), ("refused", 2))
        store, yt = MemoryStore(), wrap()
        store.mark_submitting = lambda rid, worker: "not_holder"
        self.assertEqual(run(store, yt)[0], "queued")
        self.assertEqual(store.used, 2)
        self.assertEqual([c[1] for c in store.calls if c[0] == "refund"], [50])

    def test_a_refund_that_fails_does_not_hide_the_refusal(self):
        store, yt = MemoryStore(gap="cut_changed"), wrap()
        store.refund_fails = True
        with self.assertLogs("modules.visibility_publish", level="WARNING") as logs:
            out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][:2]), ("refused", ("refused", "cut_changed")))
        self.assertTrue(any("could not give the quota back" in m for m in logs.output))
        self.assertEqual(store.finishes[-1][4], 52)           # what was spent is still what is recorded

    def test_a_successful_write_is_never_refunded(self):
        store, yt = MemoryStore(), wrap()
        self.assertEqual(run(store, yt)[0], "applied")
        self.assertNotIn("refund", [c[0] for c in store.calls])


class StatusFieldsArePreserved(unittest.TestCase):
    def test_a_read_without_the_made_for_kids_declaration_is_never_written_over(self):
        store, yt = MemoryStore(), wrap(drop_status=("selfDeclaredMadeForKids",))
        out, _ = run(store, yt)
        self.assertEqual((out, store.finishes[-1][:2], yt.updates), ("refused", ("refused", "status_unreadable"), []))
        self.assertNotIn("mark_submitting", [c[0] for c in store.calls])      # nothing was marked: nothing was sent
        # a value that is not a yes/no is not a declaration either
        for bad in (None, "false", 0):
            store, yt = MemoryStore(), wrap(status_extra={"selfDeclaredMadeForKids": bad})
            out, _ = run(store, yt)
            self.assertEqual((out, store.finishes[-1][1], yt.updates), ("refused", "status_unreadable", []), bad)

    def test_the_declaration_and_the_other_fields_that_were_read_go_back_and_the_ones_that_were_not_read_are_not_invented(self):
        store, yt = MemoryStore(), wrap(drop_status=("embeddable", "license", "publicStatsViewable"), status_extra={"selfDeclaredMadeForKids": True})
        self.assertEqual(run(store, yt)[0], "applied")
        self.assertEqual(yt.updates[0]["body"]["status"], {"selfDeclaredMadeForKids": True, "privacyStatus": "public"})

    def test_the_body_builder_itself_refuses_an_unread_status(self):
        with self.assertRaises(ValueError):
            vp.writable_status({"privacyStatus": "private", "embeddable": True})
        with self.assertRaises(ValueError):
            vp.writable_status({"selfDeclaredMadeForKids": False})
        with self.assertRaises(ValueError):
            vp.writable_status(None)
        self.assertEqual(vp.writable_status({"privacyStatus": "private", "selfDeclaredMadeForKids": False, "publishAt": "x", "madeForKids": False}),
                         {"selfDeclaredMadeForKids": False, "privacyStatus": "public"})


class ChannelIdentityAndFairness(unittest.TestCase):
    def test_a_token_whose_channel_cannot_be_compared_is_not_a_yes(self):
        store, yt = MemoryStore(), wrap()
        ctx = SimpleNamespace(credential=SimpleNamespace(youtube_channel_id=""))
        out, built = run(store, yt, credentials=lambda cid: (token_json(), ctx))
        self.assertEqual((out, store.finishes[-1][:2], yt.updates, built), ("failed", ("failed", "channel_not_connected"), [], []))
        for ctx in (SimpleNamespace(credential=None), SimpleNamespace(), None):
            store, yt = MemoryStore(), wrap()
            out, _ = run(store, yt, credentials=lambda cid, c=ctx: (token_json(), c))
            self.assertEqual((out, store.finishes[-1][1], yt.updates), ("failed", "channel_not_connected", []))

    def test_every_spend_is_booked_to_the_requests_organization_with_its_share_of_the_day(self):
        store, yt = MemoryStore(), wrap()
        out, _ = run(store, yt, ceiling=1000)
        self.assertEqual(out, "applied")
        quota = [c for c in store.calls if c[0] == "quota"]
        self.assertEqual([c[1] for c in quota], [2, 50, 1])
        # the checks and the write are held to the organization's share (default 50%); the read-back is recorded, never withheld
        self.assertEqual([(c[3], c[4]) for c in quota], [(ORG, 500), (ORG, 500), (ORG, vp.PROJECT_POOL)])
        self.assertEqual([c[2] for c in quota], [1000, 1000, vp.PROJECT_POOL])

    def test_one_organization_that_has_used_its_share_is_stopped_while_the_day_has_room(self):
        store, yt = MemoryStore(org_units=51), wrap()      # 2 for the checks, then 50 more would pass the organization's 51
        out, _ = run(store, yt, ceiling=1000)
        self.assertEqual((out, store.finishes[-1][1], yt.updates), ("failed", "quota_exceeded", []))
        self.assertNotIn("mark_submitting", [c[0] for c in store.calls])
        store, yt = MemoryStore(), wrap()
        out, _ = run(store, yt, ceiling=1000, org_ceiling=40)
        self.assertEqual((out, store.finishes[-1][1]), ("failed", "quota_exceeded"))

    def test_the_share_is_a_bounded_percent_of_the_ceiling_and_the_default_is_half(self):
        self.assertEqual(vp.DEFAULT_ORG_PERCENT, 50)
        self.assertEqual((vp.org_share(1000), vp.org_share(1001), vp.org_share(0), vp.org_share(1000, 100), vp.org_share(1000, 10)),
                         (500, 501, 0, 1000, 100))
        self.assertEqual([vp._org_percent(x) for x in ("", "x", "0", "-4", "150", "25", " 75 ")], [50, 50, 1, 1, 100, 25, 75])
        store, yt = MemoryStore(), wrap()
        svc = vp.VisibilityService("u", "k", worker_id="w1", credentials=good_credentials, service_factory=lambda t, c: yt, store=store,
                                   project="p", env={"NIGHTSHIFT_VISIBILITY_DAILY_UNITS": "400", "NIGHTSHIFT_VISIBILITY_ORG_PERCENT": "25"})
        self.assertTrue(svc.run_once())
        self.assertEqual([c[4] for c in store.calls if c[0] == "quota"][:2], [100, 100])

    def test_a_request_without_an_organization_is_not_acted_on(self):
        store, yt = MemoryStore(), wrap()
        req = dict(store.claim("w1"), org_id="")
        out = vp.process_request(req, store=store, credentials=good_credentials, service_factory=lambda t, c: yt, worker_id="w1",
                                 sleep=lambda s: None)
        self.assertEqual((out, yt.updates, store.finishes[-1][:2]), ("failed", [], ("failed", "worker_error")))


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
        sql = (REPO / "supabase" / "migrations" / "0116_visibility_requests.sql").read_text(encoding="utf-8")
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
        s._http = Session(Resp(200, "ok"))
        self.assertEqual(s.mark_submitting(3, "w1"), "ok")
        s._http = Session(Resp(200, "cut_changed"))
        self.assertEqual(s.mark_submitting(3, "w1"), "cut_changed")
        for odd in (None, True, "", 5):                 # anything that is not a word is not an "ok"
            s._http = Session(Resp(200, odd))
            self.assertEqual(s.mark_submitting(3, "w1"), "worker_error")
        s._http = Session(Resp(200, True))
        self.assertTrue(s.quota_refund("p", 50, ORG))
        self.assertEqual(calls[-1][0], "https://x.supabase.co/rest/v1/rpc/youtube_quota_refund")
        self.assertEqual(calls[-1][1], {"p_project": "p", "p_units": 50, "p_org": ORG})
        s._http = Session(Resp(200, True))
        self.assertTrue(s.quota_take("p", 50, 1000, ORG, 500))
        self.assertEqual(calls[-1][1], {"p_project": "p", "p_units": 50, "p_ceiling": 1000, "p_org": ORG, "p_org_ceiling": 500})
        s._http = Session(Resp(200, False))
        self.assertFalse(s.quota_take("p", 50, 1000, ORG, 500))
        s._http = Session(Resp(200, {"ok": True, "status": "applied"}))
        self.assertEqual(s.finish(3, "w1", "applied", None, "private", "public", 53, None)["status"], "applied")
        self.assertEqual(calls[-1][1], {"p_request_id": 3, "p_worker": "w1", "p_status": "applied", "p_reason": None,
                                        "p_before": "private", "p_after": "public", "p_units": 53, "p_retry_seconds": None})
        s._http = Session(Resp(404, {"message": f"no function {TOKEN}"}))
        with self.assertLogs("modules.visibility_publish", level="WARNING") as logs:
            self.assertIsNone(s.claim("w1"))                  # 0116 not applied: nothing to do, and not silently
            self.assertIsNone(s.claim("w1"))
        self.assertEqual(len(logs.output), 1)                 # once per function, so the loop does not fill the log
        self.assertIn("claim_visibility_request", logs.output[0])
        self.assertIn("404", logs.output[0])
        self.assertNotIn(TOKEN, logs.output[0])
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
