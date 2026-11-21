"""MediaStore._rpc keeps every transport failure visible and typed; long in.() filters are chunked."""
import math
import sys
import unittest
from datetime import timedelta
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from modules import media_library, postgrest_chunks, scene_repair  # noqa: E402
from modules.media_library import MediaStore, MediaStoreError  # noqa: E402
from operator_bot_fakes import NOW, make_ops  # noqa: E402

SECRET = "sb-service-key-DO-NOT-LEAK"
URL = "https://projectref123.supabase.co"


class _Resp:
    def __init__(self, status=200, body=None, text="[]"):
        self.status_code, self._body, self.text = status, body, text

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class _Session:
    def __init__(self, exc=None, resp=None):
        self.exc, self.resp = exc, resp

    def post(self, *a, **k):
        if self.exc:
            raise self.exc
        return self.resp


def _store(**kw):
    return MediaStore(URL, SECRET, session=_Session(**kw))


class RpcWrapsTransportFailures(unittest.TestCase):
    def assertTyped(self, store, code):
        with self.assertRaises(MediaStoreError) as cm:
            store._rpc("claim_media_upload", {})
        e = cm.exception
        self.assertEqual(e.code, code)
        self.assertTrue(e.remedy)
        self.assertIsInstance(e, RuntimeError)  # callers already catch this as "queue unavailable"
        self.assertIsInstance(e, media_library.StoreUnavailable)  # ingest maps it to "retry"
        self.assertNotIn(SECRET, str(e))
        self.assertNotIn("projectref123", str(e))  # the URL carries the project id
        return e

    def test_connection_error_is_typed_not_raw(self):
        self.assertTyped(_store(exc=requests.exceptions.ConnectionError(f"failed {URL}")), "unreachable")

    def test_timeout_is_typed_not_raw(self):
        self.assertTyped(_store(exc=requests.exceptions.ReadTimeout(f"slow {URL}")), "timeout")

    def test_http_error_is_typed_not_raw(self):
        resp = _Resp(401)
        e = self.assertTyped(_store(exc=requests.exceptions.HTTPError("x", response=resp)), "invalid_service_key")
        self.assertEqual(e.status, 401)

    def test_other_request_exception_is_typed(self):
        self.assertTyped(_store(exc=requests.exceptions.TooManyRedirects("x")), "request_failed")

    def test_bad_json_is_typed(self):
        self.assertTyped(_store(resp=_Resp(200, None, text="<html>")), "unreadable_response")

    def test_status_codes_name_different_remedies(self):
        remedies = {}
        for status in (401, 429, 503, 400):
            remedies[status] = self.assertTyped(_store(resp=_Resp(status)), {
                401: "invalid_service_key", 429: "rate_limited", 503: "server_error", 400: "http_error"}[status]).remedy
        self.assertEqual(len(set(remedies.values())), 4)

    def test_success_and_missing_migration_unchanged(self):
        self.assertEqual(_store(resp=_Resp(200, [{"a": 1}]))._rpc("x", {}), [{"a": 1}])
        self.assertIsNone(_store(resp=_Resp(404))._rpc("x", {}))

    def test_claim_still_raises_to_the_caller(self):
        with self.assertRaises(MediaStoreError):
            _store(exc=requests.exceptions.ConnectionError("x")).claim("w1")
        self.assertIn("MediaStoreError", media_library.__all__)


class ChunkHelper(unittest.TestCase):
    def test_requests_are_ceil_n_over_100_and_rows_merge_in_order(self):
        for n in (1, 100, 101, 250, 1000):
            ids = [f"id{i}" for i in range(n)]
            seen = []

            def read(flt):
                seen.append(flt)
                return [x for x in flt[4:-1].split(",")]

            rows = postgrest_chunks.select_in(ids, read)
            self.assertEqual(len(seen), math.ceil(n / 100))
            self.assertEqual(rows, ids)
            self.assertTrue(all(len(f[4:-1].split(",")) <= 100 for f in seen))

    def test_empty_list_sends_nothing(self):
        calls = []
        self.assertEqual(postgrest_chunks.select_in([], lambda f: calls.append(f)), [])
        self.assertFalse(postgrest_chunks.update_in([], lambda f: calls.append(f) or True))
        self.assertEqual(calls, [])

    def test_update_in_attempts_every_chunk_and_reports_a_failure(self):
        calls = []

        def upd(flt):
            calls.append(flt)
            return len(calls) != 1

        self.assertFalse(postgrest_chunks.update_in([str(i) for i in range(250)], upd))
        self.assertEqual(len(calls), 3)


class _Sync:
    enabled = True

    def __init__(self, vids):
        self.vids, self.updates = vids, []

    def select(self, table, params):
        return [{"video_id": v, "review_state": "approved"} for v in self.vids]

    def update(self, table, where, patch):
        self.updates.append((table, dict(where), dict(patch)))
        return True


class SceneRepairChunks(unittest.TestCase):
    def test_invalidate_approvals_never_sends_an_oversized_in_filter(self):
        vids = [f"v{i:05d}" for i in range(250)]
        sync = _Sync(vids)
        out = scene_repair.invalidate_approvals("chan", "slug", ["s001"], sync=sync)
        intents = [u for u in sync.updates if u[0] == "review_intents"]
        approve = [u for u in intents if u[1]["action"] == "eq.approve"]
        scene = [u for u in intents if u[1]["action"] == "eq.regenerate_scene"]
        self.assertEqual((len(approve), len(scene)), (3, 3))
        for _, where, _ in intents:
            self.assertLessEqual(len(where["video_id"][4:-1].split(",")), 100)
        sent = [v for _, w, _ in approve for v in w["video_id"][4:-1].split(",")]
        self.assertEqual(sent, vids)
        self.assertTrue(out["approve_intents_consumed"] and out["scene_intents_consumed"])

    def test_small_list_keeps_the_single_request(self):
        sync = _Sync(["vidA", "vidB"])
        scene_repair.invalidate_approvals("chan", "slug", ["s001", "s002"], sync=sync)
        intents = [u for u in sync.updates if u[0] == "review_intents"]
        self.assertEqual(len(intents), 2)
        self.assertEqual(intents[1][1]["scene_id"], "in.(s001,s002)")


class OperatorBotChunks(unittest.TestCase):
    def _channels(self, n):
        return [f"ch-{i:04d}" for i in range(n)]

    def test_run_events_reads_in_chunks_and_merges_newest_first(self):
        ids = self._channels(250)
        rows = [{"event": "run.started", "channel_id": c, "ts": f"2026-10-14T0{i % 10}:00:00Z"}
                for i, c in enumerate(ids)]
        ops, sync = make_ops({"system_events": rows})
        from modules.operator_bot import sources
        event = sources.RUN_EVENTS[0]
        for r in rows:
            r["event"] = event
        sec = ops.run_events(NOW - timedelta(days=1), ids)
        reads = [p for t, p in sync.reads if t == "system_events"]
        self.assertTrue(sec.ok)
        self.assertEqual(len(reads), 3)
        for p in reads:
            self.assertLessEqual(len(p["channel_id"][4:-1].split(",")), 100)
        stamps = [r["ts"] for r in sec.data]
        self.assertEqual(stamps, sorted(stamps, reverse=True))

    def test_no_channels_sends_no_request(self):
        ops, sync = make_ops({})
        self.assertTrue(ops.recent_storyboards(NOW, []).ok)
        self.assertTrue(ops.run_events(NOW, []).ok)
        self.assertEqual(sync.reads, [])

    def test_a_failed_chunk_fails_the_section_not_a_partial_answer(self):
        ops, _ = make_ops({}, fail=("storyboards",))
        self.assertFalse(ops.recent_storyboards(NOW, self._channels(250)).ok)


if __name__ == "__main__":
    unittest.main()
