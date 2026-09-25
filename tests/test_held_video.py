"""A run that did not upload gets a videos row — and never a fake upload.

What must hold:

* a held run (gate blocked, awaiting two-person approval, auto-publish off,
  repaired awaiting review) is upserted with published_at, privacy and the
  YouTube id all NULL — a held video was not published;
* every hold of the same run lands on the same row, and when that run later
  uploads, THAT row becomes the uploaded video's row: one run, one row;
* a Supabase outage, an un-migrated database or a refused write never raises
  into the pipeline;
* nothing here uploads or touches the gate, and main.py only records a held row
  on the branches that did not upload.
"""

import ast
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from modules import held_video
from modules.held_video import HeldVideos, held_video_id

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "main.py"

MANIFEST = {"scenes": [{"id": "s000", "start_s": 0.0, "end_s": 4.0},
                       {"id": "s001", "start_s": 4.0, "end_s": 9.5}]}
SCENES = [{"name": "Hook", "narration": "a"}, {"name": "Body", "narration": "b"}]


class Resp:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data
        self.text = text or (json.dumps(data) if data is not None else "")

    def json(self):
        return self._data


class FakePostgrest:
    """Just enough of PostgREST's /rest/v1/videos to hold rows by video_id:
    upsert (merge), filtered PATCH (returning rows), GET and DELETE, and the
    primary-key conflict a rename onto an existing id raises."""

    def __init__(self, missing_columns=()):
        self.rows = {}
        self.calls = []
        self.missing = set(missing_columns)

    def _refuse(self, body):
        bad = [k for k in (body or {}) if k in self.missing]
        if bad:
            return Resp(400, text=json.dumps({"code": "PGRST204",
                                              "message": f"Could not find the '{bad[0]}' column"}))
        return None

    def _match(self, params):
        out = []
        for vid, row in self.rows.items():
            ok = True
            for k, v in (params or {}).items():
                if k in ("select", "on_conflict"):
                    continue
                if not v.startswith("eq.") or str(row.get(k)) != v[3:]:
                    ok = False
            if ok:
                out.append(vid)
        return out

    def post(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("post", params, json))
        refused = self._refuse(json)
        if refused:
            return refused
        rows = json if isinstance(json, list) else [json]
        for r in rows:
            self.rows.setdefault(r["video_id"], {}).update(r)
        return Resp(201)

    def patch(self, url, params=None, json=None, headers=None, timeout=None):
        self.calls.append(("patch", params, json))
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
        self.calls.append(("get", params, None))
        return Resp(200, data=[{"video_id": v} for v in self._match(params)])

    def delete(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("delete", params, None))
        for h in self._match(params):
            self.rows.pop(h)
        return Resp(204)


def _client():
    return HeldVideos(url="https://x.supabase.co", service_key="service-key")


def _hold(client, state=held_video.STATE_BLOCKED, **kw):
    args = dict(channel_id="news", slug="the-lost-city", state=state, topic="The lost city",
                title="The Lost City", script_text="a\n\nb", scenes=SCENES, manifest=MANIFEST,
                local_path="/out/the-lost-city/final_video.mp4",
                detail=held_video.gate_detail(state, {"allowed": False, "blocks": ["fact_check"]}),
                now="2026-09-25T10:00:00+00:00")
    args.update(kw)
    return client.record_held(**args)


class TheKey(unittest.TestCase):
    def test_the_same_run_always_gets_the_same_id(self):
        self.assertEqual(held_video_id("news", "the-lost-city"), held_video_id("news", "the-lost-city"))

    def test_the_same_topic_on_two_channels_is_two_rows(self):
        self.assertNotEqual(held_video_id("news", "the-lost-city"), held_video_id("history", "the-lost-city"))

    def test_the_id_can_never_be_mistaken_for_a_youtube_id(self):
        vid = held_video_id("news", "x" * 50)
        self.assertTrue(vid.startswith("run-"))
        self.assertNotEqual(len(vid), 11)  # YouTube ids are exactly 11 characters

    def test_the_id_passes_the_repair_modules_video_id_pattern(self):
        """scene_repair.invalidate_approvals drops ids outside this pattern —
        a held row it cannot see is a held row whose approval survives a repair."""
        from modules.scene_repair import _VIDEO_ID_RE

        self.assertTrue(_VIDEO_ID_RE.match(held_video_id("chan with spaces/ü", "s" * 50)))


class HeldRow(unittest.TestCase):
    def test_disabled_without_keys_and_sends_nothing(self):
        with mock.patch("modules.held_video.requests") as req:
            self.assertIsNone(_hold(HeldVideos(url="", service_key="")))
            req.post.assert_not_called()

    def test_held_row_is_upserted_with_nulls_never_a_fake_upload(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            vid = _hold(_client())
        self.assertEqual(vid, held_video_id("news", "the-lost-city"))
        row = fake.rows[vid]
        self.assertIsNone(row["published_at"])
        self.assertIsNone(row["privacy"])
        self.assertEqual(row["publish_state"], "blocked")
        self.assertEqual(row["review_state"], "pending")
        self.assertEqual(row["channel_id"], "news")
        self.assertEqual(row["slug"], "the-lost-city")
        self.assertEqual(row["manifest"], MANIFEST)
        self.assertEqual(row["hold_detail"]["gate"]["blocks"], ["fact_check"])
        # The Storyboard's repair button needs the IR scene ids on the scenes.
        self.assertEqual([s["id"] for s in row["scenes"]], ["s000", "s001"])
        self.assertEqual(row["scenes"][1]["end_s"], 9.5)
        _, params, _ = fake.calls[0]
        self.assertEqual(params, {"on_conflict": "video_id"})

    def test_a_second_hold_of_the_same_run_updates_the_same_row(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client(), state=held_video.STATE_HELD)
            _hold(_client(), state=held_video.STATE_AWAITING_APPROVAL, title=None)
        self.assertEqual(len(fake.rows), 1)
        row = next(iter(fake.rows.values()))
        self.assertEqual(row["publish_state"], "awaiting_approval")
        self.assertEqual(row["title"], "The Lost City")  # None never blanks a field

    def test_an_unknown_or_uploaded_state_is_refused(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            self.assertIsNone(_hold(_client(), state="uploaded"))
            self.assertIsNone(_hold(_client(), state="published"))
        self.assertEqual(fake.rows, {})

    def test_supabase_failure_never_raises(self):
        with mock.patch("modules.held_video.requests") as req:
            req.post.side_effect = OSError("network down")
            req.get.side_effect = OSError("network down")
            self.assertIsNone(_hold(_client()))

    def test_a_refused_write_is_not_retried_blindly(self):
        with mock.patch("modules.held_video.requests") as req:
            req.post.return_value = Resp(500, text="boom")
            self.assertIsNone(_hold(_client()))
            self.assertEqual(req.post.call_count, 1)

    def test_without_migration_0016_the_row_still_lands(self):
        fake = FakePostgrest(missing_columns=held_video._COLUMNS_0016)
        with mock.patch("modules.held_video.requests", fake):
            vid = _hold(_client())
        row = fake.rows[vid]
        self.assertNotIn("publish_state", row)
        self.assertIsNone(row["published_at"])
        self.assertEqual(row["manifest"], MANIFEST)

    def test_without_0011_and_0013_the_bare_row_still_lands(self):
        fake = FakePostgrest(missing_columns=held_video._COLUMNS_0016 + ("manifest",))
        with mock.patch("modules.held_video.requests", fake):
            vid = _hold(_client())
        self.assertIn(vid, fake.rows)
        self.assertNotIn("manifest", fake.rows[vid])

    def test_the_service_key_is_never_logged(self):
        with mock.patch("modules.held_video.requests") as req, \
                self.assertLogs("modules.held_video", level="INFO") as logs:
            req.post.side_effect = OSError("service-key")  # even if an error echoes it
            req.get.side_effect = OSError("service-key")
            _hold(_client())
        self.assertFalse(any("service-key" in line for line in logs.output))


class FillIfNew(unittest.TestCase):
    """A repair knows the saved script, not the chosen title or the
    claim-annotated scenes the first hold wrote — and must not overwrite them."""

    def test_existing_row_keeps_its_title_and_scenes(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client(), state=held_video.STATE_BLOCKED)
            _hold(_client(), state=held_video.STATE_REPAIRED, title=None, scenes=None, script_text=None,
                  fill_if_new={"title": "Script title", "scenes": [{"name": "x"}], "script_text": "z"})
        row = next(iter(fake.rows.values()))
        self.assertEqual(row["title"], "The Lost City")
        self.assertEqual(row["scenes"][0]["name"], "Hook")
        self.assertEqual(row["publish_state"], "repaired_awaiting_review")

    def test_a_new_row_is_filled_from_the_saved_script(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client(), state=held_video.STATE_REPAIRED, title=None, scenes=None, script_text=None,
                  fill_if_new={"title": "Script title", "scenes": SCENES, "script_text": "z"})
        row = next(iter(fake.rows.values()))
        self.assertEqual(row["title"], "Script title")
        self.assertEqual(row["scenes"][0]["id"], "s000")


class Promote(unittest.TestCase):
    UPLOAD = dict(channel_id="news", slug="the-lost-city", youtube_id="dQw4w9WgXcQ",
                  published_at="2026-09-26T08:00:00", privacy="private", title="The Lost City",
                  topic="The lost city")

    def test_a_later_upload_updates_the_same_row_no_duplicate(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client())
            self.assertTrue(_client().promote(**self.UPLOAD))
        self.assertEqual(list(fake.rows), ["dQw4w9WgXcQ"])
        row = fake.rows["dQw4w9WgXcQ"]
        self.assertEqual(row["published_at"], "2026-09-26T08:00:00")
        self.assertEqual(row["privacy"], "private")
        self.assertEqual(row["publish_state"], "uploaded")
        # What the held row carried survives onto the uploaded video.
        self.assertEqual(row["manifest"], MANIFEST)
        self.assertEqual(row["script_text"], "a\n\nb")
        _, params, _ = [c for c in fake.calls if c[0] == "patch"][0]
        self.assertEqual(params, {"video_id": f"eq.{held_video_id('news', 'the-lost-city')}",
                                  "channel_id": "eq.news"})

    def test_no_held_row_is_a_no_op(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            self.assertFalse(_client().promote(**self.UPLOAD))
        self.assertEqual(fake.rows, {})
        self.assertFalse(any(c[0] in ("post", "delete") for c in fake.calls))

    def test_when_the_uploaded_row_already_exists_the_stand_in_is_removed(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client())
            fake.rows["dQw4w9WgXcQ"] = {"video_id": "dQw4w9WgXcQ", "channel_id": "news"}
            self.assertTrue(_client().promote(**self.UPLOAD))
        self.assertEqual(list(fake.rows), ["dQw4w9WgXcQ"])

    def test_without_migration_0016_promote_still_rekeys(self):
        fake = FakePostgrest(missing_columns=held_video._COLUMNS_0016)
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client())
            self.assertTrue(_client().promote(**self.UPLOAD))
        self.assertEqual(list(fake.rows), ["dQw4w9WgXcQ"])
        self.assertNotIn("publish_state", fake.rows["dQw4w9WgXcQ"])

    def test_supabase_failure_never_raises(self):
        with mock.patch("modules.held_video.requests") as req:
            req.patch.side_effect = OSError("down")
            self.assertFalse(_client().promote(**self.UPLOAD))
        self.assertFalse(held_video.promote(**{**self.UPLOAD, "youtube_id": ""}))

    def test_another_channels_run_is_never_promoted(self):
        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client(), channel_id="history")
            self.assertFalse(_client().promote(**self.UPLOAD))
        self.assertEqual(list(fake.rows), [held_video_id("history", "the-lost-city")])


class GateDetail(unittest.TestCase):
    def test_keeps_the_verdict_not_the_reports(self):
        d = held_video.gate_detail("blocked", {"allowed": False, "blocks": ["qc"], "warnings": [],
                                               "checks_run": ["qc"], "video_qc": {"big": "report"}})
        self.assertEqual(d, {"reason": "blocked", "gate": {"allowed": False, "blocks": ["qc"],
                                                           "warnings": [], "checks_run": ["qc"]}})


# ── wiring ──────────────────────────────────────────────────────────────────

def _src():
    return MAIN.read_text()


class MainWiring(unittest.TestCase):
    def test_every_non_uploading_branch_records_a_held_row(self):
        src = _src()
        for state in ("STATE_BLOCKED", "STATE_AWAITING_APPROVAL", "STATE_HELD"):
            self.assertIn(f"_record_held_run(held_video.{state}", src)

    def test_the_held_row_is_recorded_outside_the_upload_branch(self):
        """The upload `if` must never contain a held-row write: a run that
        uploaded is not held."""
        tree = ast.parse(_src())
        for node in ast.walk(tree):
            if isinstance(node, ast.If) and "UPLOAD_STARTED" in ast.unparse(node.body[0]):
                body = "\n".join(ast.unparse(n) for n in node.body)
                self.assertNotIn("_record_held_run", body)
                self.assertNotIn("record_held(", body)
                self.assertIn("held_video.promote(", body)
                break
        else:
            self.fail("upload branch not found")

    def test_promote_follows_the_recorded_upload_and_precedes_the_review_patch(self):
        src = _src()
        i_record = src.index("store.record_video(\n                    video_id=video_id,")
        i_promote = src.index("held_video.promote(")
        i_review = src.index("review.record(")
        self.assertLess(i_record, i_promote)
        self.assertLess(i_promote, i_review)

    def test_promote_uses_the_same_published_at_as_the_local_row(self):
        src = _src()
        self.assertIn("published_at=_published_at,\n                    privacy=privacy,", src)
        self.assertRegex(src, re.compile(r"record_video\([^)]*published_at=_published_at", re.S))


class RepairWiring(unittest.TestCase):
    def test_repair_cli_records_the_repaired_cut_as_held(self):
        from modules import scene_repair

        plan = SimpleNamespace(channel_id="news", slug="the-lost-city", topic="The lost city",
                               run_dir=Path("/nonexistent"), script={"title": "T", "sections": []},
                               scene_ids=("s001",))
        result = SimpleNamespace(video_path=Path("/nonexistent/final_video.mp4"),
                                 repaired_at="2026-09-25T10:00:00+00:00")
        with mock.patch("modules.held_video.record_held") as rec:
            scene_repair._record_repaired_row(plan, result)
        kw = rec.call_args.kwargs
        self.assertEqual(kw["state"], "repaired_awaiting_review")
        self.assertEqual((kw["channel_id"], kw["slug"]), ("news", "the-lost-city"))
        self.assertNotIn("title", kw)  # never overwrites the first hold's title

    def test_repair_row_failure_never_raises(self):
        from modules import scene_repair

        with mock.patch("modules.held_video.record_held", side_effect=RuntimeError("x")):
            scene_repair._record_repaired_row(SimpleNamespace(run_dir=Path("/x"), script={}, topic="",
                                                              channel_id="c", slug="s", scene_ids=()),
                                              SimpleNamespace(video_path=Path("/x"), repaired_at=""))


class MigrationShape(unittest.TestCase):
    def test_0016_is_additive_and_matches_the_module(self):
        sql = (ROOT / "supabase" / "migrations" / "0016_held_videos.sql").read_text().lower()
        self.assertNotIn("drop table", sql)
        self.assertNotIn("drop column", sql)
        for col in held_video._COLUMNS_0016:
            self.assertIn(f"add column if not exists {col}", sql)
        for state in held_video.ALL_STATES:
            self.assertIn(f"'{state}'", sql)


if __name__ == "__main__":
    unittest.main()
