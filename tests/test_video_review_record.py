"""The first-pass upload's review write must land whether or not the row exists.

On a normal first-pass upload the Supabase ``videos`` row does not exist yet —
the mirror (``supabase_sync.mirror_from_store``) creates it later, in another
job. ``VideoReview.record`` used to PATCH that row, which matches nothing, so
the preview, script, scenes and manifest were silently lost. It now upserts on
``video_id``. What must hold:

* row missing -> it is created with the review columns, on the right channel,
  reading as an uploaded (not held) video;
* row present -> only the columns ``record`` sends change; everything another
  writer owns (privacy, publish_state, hold_detail, ...) is left as it was;
* an un-migrated database (no ``manifest`` column) is retried without it;
* a failure never raises, and the service key is never logged;
* the promoted-held-row path still ends with exactly one row for the run;
* the mirror's later upsert does not blank the review columns.
"""

import copy
import json
import logging
import unittest
from pathlib import Path
from unittest import mock

from modules import held_video
from modules.held_video import HeldVideos, held_video_id
from modules.supabase_sync import SupabaseSync
from modules.video_review import VideoReview

KEY = "service-key-do-not-log"
URL = "https://x.supabase.co"
MANIFEST = {"version": 1, "scenes": [{"id": "s000", "start_s": 0.0, "end_s": 9.5}]}
SCENES = [{"name": "Hook", "duration_hint": 15}]
UPLOAD = dict(published_at="2026-09-26T08:00:00", title="The Lost City",
              topic="The lost city", slug="the-lost-city")


class Resp:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data
        self.text = text or (json.dumps(data) if data is not None else "")

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSupabase:
    """Enough of PostgREST's ``/rest/v1/videos`` (and the storage API) to tell
    a PATCH from an upsert: a PATCH on a missing row changes nothing, a plain
    POST onto an existing key is a 409, and only ``on_conflict=video_id`` with
    ``resolution=merge-duplicates`` merges — the columns sent, and no others.
    Inserts take the table's defaults (``channel_id`` 'default',
    ``review_state`` 'pending')."""

    DEFAULTS = {"channel_id": "default", "review_state": "pending"}

    def __init__(self, missing_columns=(), fail=False):
        self.rows = {}
        self.calls = []
        self.missing = set(missing_columns)
        self.fail = fail

    def _refuse(self, body):
        rows = body if isinstance(body, list) else [body or {}]
        bad = [k for r in rows for k in r if k in self.missing]
        if bad:
            return Resp(400, text=json.dumps({"code": "PGRST204",
                                              "message": f"Could not find the '{bad[0]}' column"}))
        return None

    def _match(self, params):
        out = []
        for vid, row in self.rows.items():
            ok = True
            for k, v in (params or {}).items():
                if k in ("select", "on_conflict", "order", "offset", "limit"):
                    continue
                if v == "not.is.null":
                    ok = ok and row.get(k) is not None
                elif not v.startswith("eq.") or str(row.get(k)) != v[3:]:
                    ok = False
            if ok:
                out.append(vid)
        return out

    def post(self, url, params=None, json=None, headers=None, timeout=None, data=None):
        self.calls.append(("post", url, params, copy.deepcopy(json), headers))
        if self.fail:
            raise ConnectionError("supabase down")
        if "/storage/" in url:
            return Resp(200)
        refused = self._refuse(json)
        if refused:
            return refused
        prefer = (headers or {}).get("Prefer", "")
        merge = "merge-duplicates" in prefer and (params or {}).get("on_conflict") == "video_id"
        rows = json if isinstance(json, list) else [json]
        for r in rows:
            if r["video_id"] in self.rows:
                if not merge:
                    return Resp(409, text='{"code":"23505"}')
                self.rows[r["video_id"]].update(r)
            else:
                self.rows[r["video_id"]] = {**self.DEFAULTS, **r}
        return Resp(201)

    def patch(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("patch", url, params, copy.deepcopy(json), headers))
        if self.fail:
            raise ConnectionError("supabase down")
        refused = self._refuse(json)
        if refused:
            return refused
        hits = self._match(params)
        new_id = (json or {}).get("video_id")
        if new_id and any(new_id != h for h in hits) and new_id in self.rows:
            return Resp(409, text='{"code":"23505"}')
        out = []
        for h in hits:
            row = self.rows.pop(h)
            row.update(json)
            self.rows[row["video_id"]] = row
            out.append(row)
        return Resp(200, data=out)

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("get", url, params, None, headers))
        if self.fail:
            raise ConnectionError("supabase down")
        hits = [dict(self.rows[v]) for v in self._match(params)]
        return Resp(200, data=hits[int((params or {}).get("offset", 0)):])

    def delete(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("delete", url, params, json, headers))
        for h in self._match(params):
            self.rows.pop(h)
        return Resp(204)


def _review():
    r = VideoReview(url=URL, service_key=KEY)
    r.upload_preview = mock.MagicMock(return_value="news/dQw4w9WgXcQ.mp4")
    return r


def _record(review, **kw):
    args = dict(video_id="dQw4w9WgXcQ", channel_id="news", video_path=Path("/x.mp4"),
                script_text="the narration", auto_publish=False, scenes=SCENES,
                manifest=MANIFEST, **UPLOAD)
    args.update(kw)
    review.record(**args)


def _patched(fake):
    """Route both modules' ``requests`` calls into the fake."""
    return mock.patch.multiple("requests", post=fake.post, patch=fake.patch,
                               get=fake.get, delete=fake.delete)


class RowMissing(unittest.TestCase):
    def test_the_row_is_created_with_the_review_columns(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review())
        self.assertEqual(list(fake.rows), ["dQw4w9WgXcQ"])
        row = fake.rows["dQw4w9WgXcQ"]
        self.assertEqual(row["channel_id"], "news")  # not the 'default' channel
        self.assertEqual(row["preview_path"], "news/dQw4w9WgXcQ.mp4")
        self.assertEqual(row["script_text"], "the narration")
        self.assertEqual(row["review_state"], "pending")
        self.assertEqual(row["manifest"], MANIFEST)
        self.assertEqual(row["scenes"][0]["id"], "s000")
        self.assertEqual(row["scenes"][0]["end_s"], 9.5)
        # Reads as uploaded, not held (published_at set), and the upload's
        # identity is there for the dashboard and the repair lookup.
        self.assertEqual(row["published_at"], UPLOAD["published_at"])
        self.assertEqual(row["slug"], "the-lost-city")
        self.assertEqual(row["title"], "The Lost City")

    def test_it_is_an_upsert_on_video_id_not_a_patch(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review())
        writes = [c for c in fake.calls if "/rest/v1/videos" in c[1] and c[0] in ("post", "patch")]
        self.assertEqual(len(writes), 1)
        method, _, params, _, headers = writes[0]
        self.assertEqual(method, "post")
        self.assertEqual(params, {"on_conflict": "video_id"})
        self.assertIn("resolution=merge-duplicates", headers["Prefer"])

    def test_privacy_and_publish_state_are_never_sent(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review(), auto_publish=True)
        body = [c for c in fake.calls if c[0] == "post" and "/rest/v1/videos" in c[1]][0][3]
        for key in ("privacy", "publish_state", "held_at", "hold_detail", "category_id"):
            self.assertNotIn(key, body)
        self.assertNotIn(None, [v for k, v in body.items() if k != "script_text"])

    def test_recording_twice_is_idempotent(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review())
            first = dict(fake.rows["dQw4w9WgXcQ"])
            _record(_review())
        self.assertEqual(list(fake.rows), ["dQw4w9WgXcQ"])
        self.assertEqual(fake.rows["dQw4w9WgXcQ"], first)


class RowExists(unittest.TestCase):
    MIRRORED = {"video_id": "dQw4w9WgXcQ", "channel_id": "news", "title": "The Lost City",
                "topic": "The lost city", "slug": "the-lost-city",
                "published_at": "2026-09-26T08:00:00", "privacy": "private",
                "category_id": "27", "local_path": "/out/final.mp4",
                "thumbnail_variant": "B", "title_variant": "A", "review_state": "pending"}

    def test_only_the_review_columns_change(self):
        fake = FakeSupabase()
        fake.rows["dQw4w9WgXcQ"] = dict(self.MIRRORED)
        with _patched(fake):
            _record(_review())
        row = fake.rows["dQw4w9WgXcQ"]
        for key in ("privacy", "category_id", "local_path", "thumbnail_variant", "title_variant",
                    "title", "topic", "slug", "published_at", "channel_id"):
            self.assertEqual(row[key], self.MIRRORED[key], key)
        self.assertEqual(row["script_text"], "the narration")
        self.assertEqual(row["manifest"], MANIFEST)
        self.assertEqual(row["preview_path"], "news/dQw4w9WgXcQ.mp4")

    def test_absent_upload_facts_never_blank_existing_ones(self):
        """A caller that does not pass title/slug/... sends nothing for them."""
        fake = FakeSupabase()
        fake.rows["dQw4w9WgXcQ"] = dict(self.MIRRORED)
        with _patched(fake):
            _record(_review(), published_at=None, title=None, topic=None, slug=None)
        row = fake.rows["dQw4w9WgXcQ"]
        for key in ("title", "topic", "slug", "published_at"):
            self.assertEqual(row[key], self.MIRRORED[key], key)

    def test_the_mirror_running_later_does_not_blank_the_review_columns(self):
        fake = FakeSupabase()
        with _patched(fake):
            _record(_review())
            local = {k: v for k, v in self.MIRRORED.items() if k != "review_state"}
            SupabaseSync(url=URL, service_key=KEY).upsert("videos", [local], on_conflict="video_id")
        row = fake.rows["dQw4w9WgXcQ"]
        self.assertEqual(row["script_text"], "the narration")
        self.assertEqual(row["manifest"], MANIFEST)
        self.assertEqual(row["preview_path"], "news/dQw4w9WgXcQ.mp4")
        self.assertEqual(row["privacy"], "private")


class UnmigratedDatabase(unittest.TestCase):
    def test_without_0013_it_retries_without_the_manifest(self):
        fake = FakeSupabase(missing_columns={"manifest"})
        with _patched(fake):
            _record(_review())
        writes = [c for c in fake.calls if c[0] == "post" and "/rest/v1/videos" in c[1]]
        self.assertEqual(len(writes), 2)
        self.assertIn("manifest", writes[0][3])
        self.assertNotIn("manifest", writes[1][3])
        row = fake.rows["dQw4w9WgXcQ"]
        self.assertNotIn("manifest", row)
        self.assertEqual(row["script_text"], "the narration")
        self.assertEqual(row["scenes"][0]["end_s"], 9.5)  # timed scenes still land


class Failure(unittest.TestCase):
    def test_supabase_down_never_raises_and_never_logs_the_key(self):
        fake = FakeSupabase(fail=True)
        with _patched(fake), self.assertLogs("modules.video_review", level="WARNING") as logs:
            _record(_review())  # must not raise
        self.assertNotIn(KEY, "\n".join(logs.output))

    def test_a_refused_write_never_raises(self):
        r = _review()
        with mock.patch("requests.post", return_value=Resp(500, text=f"boom {KEY}")), \
                self.assertLogs("modules.video_review", level="WARNING") as logs:
            _record(r)
        self.assertNotIn(KEY, "\n".join(logs.output))

    def test_an_unexpected_error_inside_record_is_swallowed(self):
        r = _review()
        r.upload_preview = mock.MagicMock(side_effect=RuntimeError("bug"))
        _record(r)  # must not raise


class PromotedHeldRow(unittest.TestCase):
    """promote re-keys the held row first; record then merges into THAT row."""

    def _hold_then_upload(self, fake):
        slug = UPLOAD["slug"]
        HeldVideos(url=URL, service_key=KEY).record_held(
            channel_id="news", slug=slug, state=held_video.STATE_AWAITING_APPROVAL,
            topic="The lost city", title="The Lost City", script_text="held narration",
            scenes=SCENES, manifest=MANIFEST, local_path="/out/final.mp4",
            detail={"reason": "awaiting_approval"}, now="2026-09-25T10:00:00+00:00")
        self.assertTrue(HeldVideos(url=URL, service_key=KEY).promote(
            channel_id="news", slug=slug, youtube_id="dQw4w9WgXcQ",
            published_at=UPLOAD["published_at"], privacy="private",
            title="The Lost City", topic="The lost city"))

    def test_one_row_and_the_held_columns_survive(self):
        fake = FakeSupabase()
        with _patched(fake):
            self._hold_then_upload(fake)
            _record(_review(), script_text="final narration")
        self.assertEqual(list(fake.rows), ["dQw4w9WgXcQ"])
        self.assertNotIn(held_video_id("news", UPLOAD["slug"]), fake.rows)
        row = fake.rows["dQw4w9WgXcQ"]
        self.assertEqual(row["publish_state"], "uploaded")
        self.assertEqual(row["privacy"], "private")
        self.assertEqual(row["hold_detail"], {"reason": "awaiting_approval"})
        self.assertEqual(row["held_at"], "2026-09-25T10:00:00+00:00")
        self.assertEqual(row["local_path"], "/out/final.mp4")
        self.assertEqual(row["script_text"], "final narration")
        self.assertEqual(row["preview_path"], "news/dQw4w9WgXcQ.mp4")
        self.assertEqual(row["manifest"], MANIFEST)

    def test_promote_calls_are_unchanged(self):
        """The held path still re-keys with a filtered PATCH; record adds one upsert."""
        fake = FakeSupabase()
        with _patched(fake):
            self._hold_then_upload(fake)
            before = len(fake.calls)
            _record(_review())
        patches = [c for c in fake.calls[:before] if c[0] == "patch"]
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0][2], {"video_id": f"eq.{held_video_id('news', UPLOAD['slug'])}",
                                         "channel_id": "eq.news"})
        review_writes = [c for c in fake.calls[before:]
                         if c[0] in ("post", "patch") and "/rest/v1/videos" in c[1]]
        self.assertEqual([c[0] for c in review_writes], ["post"])


class MainWiring(unittest.TestCase):
    def test_main_passes_the_upload_facts_but_not_privacy(self):
        src = (Path(__file__).resolve().parent.parent / "main.py").read_text()
        call = src[src.index("review.record("):]
        call = call[:call.index("except Exception")]
        for arg in ("published_at=_published_at", "title=published_title",
                    "topic=topic", "slug=slug"):
            self.assertIn(arg, call)
        self.assertNotIn("privacy=", call)


if __name__ == "__main__":
    logging.basicConfig()
    unittest.main()
