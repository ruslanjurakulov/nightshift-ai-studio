"""YouTube's "made for kids" declaration (modules/made_for_kids.py, migration 0141).

Every upload used to send ``selfDeclaredMadeForKids: False``; a Kids story declared "not made for kids" breaks YouTube's
policy and COPPA. These tests pin what each path that builds a YouTube ``status`` body now sends, and what must never be
sent: a kids video declared "not for kids" with nobody's confirmation.
"""

import ast
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from modules import made_for_kids as mfk
from modules import publish_gate, run_request, social_captions, social_publish, visibility_publish
from modules.channels import AgentConfig
from tests.test_youtube_uploader import UploadWiringTestCase, script, uploader

ROOT = Path(__file__).resolve().parent.parent


def channel(made_for_kids=False):
    return SimpleNamespace(channel_id="kids" if made_for_kids else "news", agent=SimpleNamespace(made_for_kids=made_for_kids),
                           language="English")


KIDS_RUN = mfk.decide(channel(), run_made_for_kids=True)
PLAIN = mfk.decide(channel())
UNCONFIRMED = mfk.Decision(value=False, kids_content=True, sources=(mfk.SOURCE_RECORDED,))
CONFIRMED_OFF = mfk.Decision(value=False, kids_content=True, sources=(mfk.SOURCE_RECORDED,), confirmed_off=True)


class TheDecision(unittest.TestCase):
    def test_each_kids_source_makes_the_video_kids_content_declared_made_for_kids(self):
        cases = {
            mfk.SOURCE_RUN: mfk.decide(channel(), run_made_for_kids=True),
            mfk.SOURCE_SERIES: mfk.decide(channel(), series=SimpleNamespace(format="Kids stories, 3 min", content_type="long")),
            mfk.SOURCE_STYLE: mfk.decide(channel(), style_library_id="claymation-set"),
            mfk.SOURCE_CHANNEL: mfk.decide(channel(True)),
        }
        for source, d in cases.items():
            self.assertEqual((d.value, d.kids_content, d.sources), (True, True, (source,)), source)
            self.assertFalse(d.refused)

    def test_without_a_kids_source_the_channel_default_off_declares_not_for_kids(self):
        d = mfk.decide(channel(), series=SimpleNamespace(format="8-12 min documentary", content_type="long"),
                       style_library_id="blueprint-technical")
        self.assertEqual((d.value, d.kids_content, d.sources), (False, False, ()))
        self.assertFalse(d.refused)

    def test_each_kids_only_look_marks_the_video_made_for_kids(self):
        for look in ("cut-paper-collage", "claymation-set", "felt-and-wool", "gouache-storybook", "chalk-on-slate"):
            d = mfk.decide(channel(), style_library_id=look)
            self.assertEqual((d.value, d.kids_content, d.sources), (True, True, (mfk.SOURCE_STYLE,)), look)

    def test_a_look_tagged_kids_for_browsing_but_used_by_grown_up_films_does_not(self):
        # The owner's decision on PR #699: the "kids" tag is the library's filter ("good for kids"); these three looks carry
        # it and are also a travel film's or a history documentary's, whose comments must not be switched off for it.
        for look in ("tilt-shift-miniature", "oil-pastel", "central-asian-miniature"):
            self.assertFalse(mfk.style_is_kids(look), look)
            d = mfk.decide(channel(), style_library_id=look)
            self.assertEqual((d.value, d.kids_content, d.sources), (False, False, ()), look)
            # A kids channel is still made for kids, whatever its look.
            self.assertTrue(mfk.decide(channel(True), style_library_id=look).value, look)

    def test_a_series_format_matches_whole_words_only_in_three_languages(self):
        for text in ("Kids story", "for children", "Bolalar ertagi", "Детские сказки"):
            self.assertTrue(mfk.series_is_kids(SimpleNamespace(format=text, content_type="")), text)
        for text in ("kidnapping cases", "", "short", None):
            self.assertFalse(mfk.series_is_kids(SimpleNamespace(format=text, content_type="mixed")), text)

    def test_a_run_cannot_declare_kids_content_not_for_kids(self):
        # run_made_for_kids=False is "the run said nothing", never a "no" that beats the channel.
        self.assertTrue(mfk.decide(channel(True), run_made_for_kids=False).value)

    def test_only_an_explicit_true_turns_the_channel_default_on(self):
        for raw, want in ((True, True), ("true", False), (1, False), (None, False)):
            self.assertIs(AgentConfig.from_dict({"made_for_kids": raw}).made_for_kids, want, raw)
        self.assertIs(AgentConfig.from_dict({}).made_for_kids, False)
        self.assertIs(AgentConfig.from_dict({"made_for_kids": True}).to_dict()["made_for_kids"], True)

    def test_an_existing_video_declares_what_was_recorded(self):
        self.assertEqual(mfk.for_video({"made_for_kids": True, "kids_content": True}).value, True)
        off = mfk.for_video({"made_for_kids": False, "kids_content": True, "made_for_kids_off_by": "u-1"})
        self.assertEqual((off.value, off.confirmed_off, off.refused), (False, True, False))
        self.assertTrue(mfk.for_video({"made_for_kids": False, "kids_content": True}).refused)
        # Nothing recorded (before 0141): the channel decides, and a kids channel's copy is made for kids.
        self.assertEqual(mfk.for_video({}, channel()).value, False)
        self.assertEqual(mfk.for_video({}, channel(True)).value, True)
        self.assertTrue(mfk.for_video({"made_for_kids": False, "kids_content": False}, channel(True)).refused)

    def test_what_a_body_gets(self):
        self.assertIs(mfk.declared(KIDS_RUN), True)
        self.assertIs(mfk.declared(CONFIRMED_OFF), False)
        self.assertIs(mfk.declared(None, channel()), False)
        self.assertIs(mfk.declared(None, channel(True)), True)
        with self.assertRaises(mfk.MadeForKidsUnconfirmed):
            mfk.declared(UNCONFIRMED)
        with self.assertRaises(mfk.MadeForKidsUnconfirmed):
            mfk.declared(False, channel(True))


class TheStyleKitRead(unittest.TestCase):
    KIT = "11111111-2222-3333-4444-555555555555"
    ORG = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    def ctx(self, kit=KIT):
        return SimpleNamespace(dna=SimpleNamespace(style_kit_id=kit), org_id=self.ORG)

    def sync(self, rows=None, exc=None):
        calls = []

        class Sync:
            enabled = True

            def select_strict(self, table, params):
                calls.append((table, params))
                if exc:
                    raise exc
                return rows or []
        return Sync(), calls

    def test_no_kit_reads_nothing(self):
        s, calls = self.sync()
        self.assertEqual(mfk.style_kit_library_id(self.ctx(kit=""), s), "")
        self.assertEqual(calls, [])

    def test_the_kit_of_the_organization_gives_its_library_id(self):
        s, calls = self.sync(rows=[{"id": self.KIT, "org_id": self.ORG, "library_id": "Claymation-Set"}])
        self.assertEqual(mfk.style_kit_library_id(self.ctx(), s), "claymation-set")
        self.assertEqual(calls[0][1]["org_id"], f"eq.{self.ORG}")

    def test_a_kit_that_cannot_be_read_stops_the_run_rather_than_guess(self):
        from modules.supabase_sync import SupabaseReadError

        s, _ = self.sync(exc=SupabaseReadError("style_kits", 503))
        with self.assertRaises(mfk.MadeForKidsUnknown):
            mfk.style_kit_library_id(self.ctx(), s)
        with self.assertRaises(mfk.MadeForKidsUnknown):
            mfk.style_kit_library_id(self.ctx(), SimpleNamespace(enabled=False))


class ThePipelineUploadBody(unittest.TestCase):
    """modules/youtube_uploader.py: the long video and its Short go through upload() with the run's decision."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.video = Path(self._tmp.name) / "video.mp4"
        self.video.write_bytes(b"not really an mp4")
        self.sent = []

    def status(self, ch=None, **kw):
        self.sent.clear()
        up = uploader(channel=ch, service=UploadWiringTestCase()._service(self.sent))
        up.upload(self.video, script("A ship."), privacy="private", **kw)
        return self.sent[-1]["body"]["status"]

    def test_a_kids_video_is_declared_made_for_kids(self):
        self.assertEqual(self.status(made_for_kids=KIDS_RUN), {"privacyStatus": "private", "selfDeclaredMadeForKids": True})

    def test_a_video_that_is_not_kids_content_is_declared_not_for_kids_as_before(self):
        self.assertEqual(self.status(made_for_kids=PLAIN), {"privacyStatus": "private", "selfDeclaredMadeForKids": False})

    def test_a_caller_that_decided_nothing_gets_the_channel_default_never_a_constant(self):
        self.assertIs(self.status(channel(True))["selfDeclaredMadeForKids"], True)
        self.assertIs(self.status(channel(False))["selfDeclaredMadeForKids"], False)

    def test_a_confirmed_not_for_kids_is_sent_as_confirmed(self):
        self.assertIs(self.status(made_for_kids=CONFIRMED_OFF)["selfDeclaredMadeForKids"], False)

    def test_an_unconfirmed_not_for_kids_is_never_sent_and_nothing_is_uploaded(self):
        self.sent.clear()
        up = uploader(service=UploadWiringTestCase()._service(self.sent))
        with self.assertRaises(mfk.MadeForKidsUnconfirmed):
            up.upload(self.video, script("A ship."), privacy="private", made_for_kids=UNCONFIRMED)
        self.assertEqual(self.sent, [])

    def test_the_declaration_never_changes_the_privacy(self):
        for privacy in ("private", "unlisted"):
            self.sent.clear()
            up = uploader(service=UploadWiringTestCase()._service(self.sent))
            up.upload(self.video, script("A ship."), privacy=privacy, made_for_kids=KIDS_RUN)
            self.assertEqual(self.sent[-1]["body"]["status"]["privacyStatus"], privacy)


class EveryUploadCallCarriesADeclaration(unittest.TestCase):
    """No path may upload without saying who the video is for: every ``.upload(`` of a YouTube uploader names it."""

    def calls(self, path):
        tree = ast.parse((ROOT / path).read_text(encoding="utf-8"))
        return [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == "upload" and isinstance(n.func.value, ast.Name) and n.func.value.id == "uploader"]

    def test_main_and_the_cross_post_pass_made_for_kids(self):
        for path, expected in (("main.py", 2), ("modules/social_publish.py", 1)):
            calls = self.calls(path)
            self.assertEqual(len(calls), expected, path)
            for c in calls:
                self.assertIn("made_for_kids", [k.arg for k in c.keywords], f"{path}:{c.lineno}")

    def test_the_uploader_has_no_constant_declaration_left(self):
        text = (ROOT / "modules/youtube_uploader.py").read_text(encoding="utf-8")
        self.assertNotIn('"selfDeclaredMadeForKids": False', text)
        self.assertIn('"selfDeclaredMadeForKids": for_kids', text)

    def test_main_decides_before_the_gate_and_hands_the_same_decision_to_every_consumer(self):
        text = (ROOT / "main.py").read_text(encoding="utf-8")
        decided = text.index("kids_decision = mfk.decide(")
        self.assertLess(decided, text.index("gate = publish_gate.evaluate("))
        self.assertEqual(text.count("made_for_kids=kids_decision"), 5)   # gate, held review, upload, review, the Short


class TheCrossPost(unittest.TestCase):
    """modules/social_publish.py YoutubeAdapter: a copy on another of the organization's channels."""

    def publish(self, kids_row, target=None):
        calls = []

        class Up:
            def upload(self, path, script, privacy=None, **kwargs):
                calls.append(kwargs)
                return {"id": "dQw4w9WgXcQ"}

        adapter = social_publish.YoutubeAdapter(lambda cid: ("{}", target or channel()),
                                                uploader_factory=lambda tok, ctx: Up(), heartbeat_seconds=60)
        meta = social_captions.YouTubeMeta(title="T", description="D", tags=("a",))
        adapter.publish("finance", Path("/nonexistent.mp4"), meta, None, kids_row=kids_row)
        return calls

    def test_the_copy_declares_what_the_video_declared(self):
        (kw,) = self.publish({"made_for_kids": True, "kids_content": True})
        self.assertIs(mfk.declared(kw["made_for_kids"]), True)
        (kw,) = self.publish({"made_for_kids": False, "kids_content": False})
        self.assertIs(mfk.declared(kw["made_for_kids"]), False)

    def test_a_kids_target_channel_makes_an_unrecorded_video_made_for_kids(self):
        (kw,) = self.publish({}, target=channel(True))
        self.assertIs(mfk.declared(kw["made_for_kids"], channel(True)), True)

    def test_a_kids_video_unconfirmed_not_for_kids_is_refused_before_the_upload(self):
        with self.assertRaises(social_publish.PublishStop) as stop:
            self.publish({"made_for_kids": False, "kids_content": True})
        self.assertEqual((stop.exception.status, stop.exception.reason), ("refused", mfk.REFUSAL))

    def test_a_confirmed_not_for_kids_goes_as_confirmed(self):
        (kw,) = self.publish({"made_for_kids": False, "kids_content": True, "made_for_kids_off_by": "u-1"})
        self.assertIs(mfk.declared(kw["made_for_kids"]), False)

    def test_a_short_without_a_record_of_its_own_reads_the_long_videos(self):
        reads = []

        def read(vid):
            reads.append(vid)
            return {"made_for_kids": True, "kids_content": True} if vid == "long1" else {}

        ctx = SimpleNamespace(store=SimpleNamespace(kids_record=read),
                              video={"video_id": "short1", "parent_video_id": "long1", "video_format": "short"})
        pub = social_publish.YoutubePublisher.__new__(social_publish.YoutubePublisher)
        pub.ctx = ctx
        self.assertEqual(pub._kids_row(), {"made_for_kids": True, "kids_content": True})
        self.assertEqual(reads, ["short1", "long1"])


class MakingItPublic(unittest.TestCase):
    """modules/visibility_publish.py: videos.update sends the recorded declaration, never a guess."""

    READ = {"privacyStatus": "private", "selfDeclaredMadeForKids": False, "embeddable": True}

    def test_a_recorded_declaration_replaces_the_one_read(self):
        body = visibility_publish.writable_status(self.READ, "public", True)
        self.assertEqual(body, {"embeddable": True, "selfDeclaredMadeForKids": True, "privacyStatus": "public"})
        self.assertEqual(visibility_publish.writable_status(self.READ, "public", None)["selfDeclaredMadeForKids"], False)

    def store(self, row=None, exc=None):
        def read(vid):
            if exc:
                raise exc
            return row or {}
        return SimpleNamespace(kids_record=read)

    def test_what_the_worker_sends(self):
        d = visibility_publish.declared_for_kids
        self.assertIs(d(self.store({"made_for_kids": True, "kids_content": True}), "v", channel()), True)
        self.assertIs(d(self.store({"made_for_kids": False, "kids_content": True, "made_for_kids_off_by": "u"}), "v", channel()), False)
        # Nothing recorded (an upload before 0141) on a channel that is not for kids: what YouTube holds goes back, as before.
        self.assertIsNone(d(self.store({}), "v", channel()))
        self.assertIs(d(self.store({}), "v", channel(True)), True)
        # A store from before this change (no kids_record) behaves as nothing recorded.
        self.assertIsNone(d(SimpleNamespace(), "v", channel()))

    def test_an_unconfirmed_kids_video_is_not_made_public_and_an_unreadable_record_is_retried(self):
        with self.assertRaises(visibility_publish.Stop) as stop:
            visibility_publish.declared_for_kids(self.store({"made_for_kids": False, "kids_content": True}), "v", channel())
        self.assertEqual(stop.exception.reason, "gate_blocked")
        with self.assertRaises(visibility_publish.Retry):
            visibility_publish.declared_for_kids(self.store(exc=RuntimeError("HTTP 503")), "v", channel())


class TheGate(unittest.TestCase):
    def evaluate(self, decision, gate_config=None):
        ch = SimpleNamespace(agent=SimpleNamespace(publish_gate=gate_config or {}, made_for_kids=False))
        return publish_gate.evaluate(script=script("x"), channel=ch, made_for_kids=decision)

    def test_an_unconfirmed_kids_video_is_blocked_and_the_verdict_says_why(self):
        g = self.evaluate(UNCONFIRMED)
        self.assertIn("made_for_kids_unconfirmed", g.blocks)
        self.assertFalse(g.allowed)
        self.assertEqual(g.to_metadata()["made_for_kids"]["kids_content"], True)

    def test_a_channel_that_turned_the_gate_off_is_still_held_to_it(self):
        g = self.evaluate(UNCONFIRMED, {"enabled": False})
        self.assertEqual(g.blocks, ["made_for_kids_unconfirmed"])

    def test_a_declared_kids_video_or_a_confirmed_one_passes_this_check(self):
        for d in (KIDS_RUN, PLAIN, CONFIRMED_OFF):
            g = self.evaluate(d)
            self.assertNotIn("made_for_kids_unconfirmed", g.blocks)
            self.assertIn("made_for_kids", g.checks_run)

    def test_without_a_decision_nothing_changes(self):
        g = self.evaluate(None)
        self.assertNotIn("made_for_kids", g.checks_run)
        self.assertNotIn("made_for_kids", g.to_metadata())

    def test_something_that_is_not_a_decision_is_an_unknown_and_blocks(self):
        self.assertIn("made_for_kids_unknown", self.evaluate(object()).blocks)


class TheRunCarrier(unittest.TestCase):
    def test_true_becomes_the_flag(self):
        out = run_request.validate("news", "daily", {"topic": "t", "made_for_kids": True})
        self.assertIs(out["made_for_kids"], True)
        self.assertIn("--made-for-kids", run_request.build_main_args("news", out))
        self.assertNotIn("--made-for-kids", run_request.build_main_args("news", {"topic": "t"}))

    def test_anything_but_true_is_refused_never_read_as_not_for_kids(self):
        for value in (False, "true", 1, "yes"):
            with self.assertRaises(run_request.InvalidRunRequest):
                run_request.validate("news", "daily", {"made_for_kids": value})

    def test_a_repair_cannot_carry_it(self):
        with self.assertRaises(run_request.InvalidRunRequest):
            run_request.validate("news", "repair", {"repair_scenes": "s001", "made_for_kids": True})


class TheReviewRecord(unittest.TestCase):
    def test_a_runs_decision_is_its_two_columns_and_clears_a_person_s_old_confirmation_and_answer(self):
        from modules import video_review

        self.assertEqual(video_review.made_for_kids_columns(KIDS_RUN),
                         {"made_for_kids": True, "kids_content": True, "made_for_kids_off_by": None, "made_for_kids_off_at": None,
                          "made_for_kids_answered_by": None, "made_for_kids_answered_at": None,
                          "made_for_kids_answered_cut_sha256": None})
        self.assertEqual(set(video_review.COLUMNS_0141), set(video_review.made_for_kids_columns(PLAIN)))

    def test_the_decision_lands_on_the_row_and_a_database_without_0141_keeps_the_rest(self):
        from modules import video_review
        from tests.test_video_review_record import FakeSupabase, _patched, _record, _review

        fake = FakeSupabase()
        with _patched(fake):
            _record(_review(), made_for_kids=KIDS_RUN)
        row = fake.rows["dQw4w9WgXcQ"]
        self.assertEqual((row["made_for_kids"], row["kids_content"]), (True, True))
        old = FakeSupabase(missing_columns=video_review.COLUMNS_0141)
        with _patched(old):
            _record(_review(), made_for_kids=KIDS_RUN)
        row = old.rows["dQw4w9WgXcQ"]
        self.assertNotIn("made_for_kids", row)
        self.assertEqual((row["script_text"], row["preview_path"]), ("the narration", "news/dQw4w9WgXcQ.mp4"))

    def test_a_run_that_was_held_records_its_decision_too(self):
        # main.py's own _record_held_run closure, lifted as tests/test_video_visibility.py lifts it.
        from tests.test_video_visibility import _run

        fake = _run("held", {"allowed": True, "blocks": []}, kids_decision=KIDS_RUN)
        (row,) = fake.rows.values()
        self.assertEqual((row["made_for_kids"], row["kids_content"]), (True, True))


if __name__ == "__main__":
    unittest.main()


class TheAudienceAnswer(unittest.TestCase):
    """The owner's decision on PR #699: who a video is for is a person's explicit answer, asked before it goes public.

    The private upload carries the detection (selfDeclaredMadeForKids is set at insert); the answer is what counts before anything
    is watchable, and the publish-when-approved write corrects YouTube when the two differ."""

    def test_nothing_watchable_goes_up_before_a_person_answered(self):
        for asked in ("public", "unlisted", "PUBLIC"):
            self.assertEqual(mfk.privacy_until_answered(asked), "private", asked)
            self.assertEqual(mfk.privacy_until_answered(asked, answered=True), asked, asked)
        self.assertEqual(mfk.privacy_until_answered("private"), "private")

    def test_autopilot_holds_main_clamps_a_public_request_to_private(self):
        import main
        from modules.channels import ChannelContext

        ctx = ChannelContext.from_dict({"channel_id": "kids", "name": "Kids", "auto_publish": True})
        self.assertIs(ctx.ui_auto_publish, True)
        with self.assertLogs("chronos", "WARNING") as logs:
            self.assertEqual(main._effective_privacy(ctx, "public"), "private")
        self.assertIn("until a person answers who the video is for", "\n".join(logs.output))
        self.assertEqual(main._effective_privacy(ctx, "private"), "private")

    def test_the_gate_holds_anything_watchable_without_an_answer_on_every_channel(self):
        for config in ({}, {"enabled": False}):
            ch = SimpleNamespace(agent=SimpleNamespace(publish_gate=config, made_for_kids=False))
            for visibility in ("public", "unlisted"):
                g = publish_gate.evaluate(script=script("x"), channel=ch, visibility=visibility)
                self.assertIn("audience_unanswered", g.blocks, (config, visibility))
            ok = publish_gate.evaluate(script=script("x"), channel=ch, visibility="private")
            self.assertNotIn("audience_unanswered", ok.blocks)
            answered = publish_gate.evaluate(script=script("x"), channel=ch, visibility="public", audience_answered=True)
            self.assertNotIn("audience_unanswered", answered.blocks)
        text = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertIn("visibility=privacy,\n        audience_answered=False,", text)

    def test_a_new_cut_is_a_new_question(self):
        from modules import video_review

        cols = video_review.made_for_kids_columns(KIDS_RUN)
        self.assertEqual((cols["made_for_kids_answered_by"], cols["made_for_kids_answered_at"]), (None, None))

    def _publish(self, row, read_value):
        from tests import test_visibility_publish as tv

        store = tv.MemoryStore()
        store.kids_record = lambda vid: row
        yt = tv.wrap(status_extra={"selfDeclaredMadeForKids": read_value})
        out, _ = tv.run(store, yt)
        return out, yt, store

    def test_the_answer_corrects_youtube_when_it_differs_from_the_upload(self):
        # Uploaded with the detection (made for kids); the person answered "no" with the confirmation: the write sends "no".
        from tests.test_visibility_publish import CUT

        row = {"made_for_kids": False, "kids_content": True, "made_for_kids_off_by": "u-1", "made_for_kids_answered_by": "u-1",
               "made_for_kids_answered_cut_sha256": CUT}
        out, yt, _ = self._publish(row, True)
        self.assertEqual(out, "applied")
        self.assertEqual(yt.updates[0]["body"]["status"]["selfDeclaredMadeForKids"], False)
        self.assertEqual(yt.updates[0]["body"]["status"]["privacyStatus"], "public")
        # And the other way: uploaded "not for kids", answered "yes".
        out, yt, _ = self._publish({"made_for_kids": True, "kids_content": False, "made_for_kids_answered_by": "u-2",
                                    "made_for_kids_answered_cut_sha256": CUT}, False)
        self.assertEqual((out, yt.updates[0]["body"]["status"]["selfDeclaredMadeForKids"]), ("applied", True))

    def test_an_answer_about_another_cut_does_not_take_this_one_public(self):
        row = {"made_for_kids": True, "kids_content": True, "made_for_kids_answered_by": "u-1",
               "made_for_kids_answered_cut_sha256": "cd" * 32}
        out, yt, store = self._publish(row, True)
        self.assertEqual((out, yt.updates), ("refused", []))
        self.assertEqual(store.finishes[-1][:2], ("refused", "gate_blocked"))

    def test_an_auto_publish_upload_is_recorded_for_a_person_to_approve(self):
        # The review finding on PR #699: "approved with nobody behind it" left a private video nobody could approve. The review
        # record says approved only when the upload really went up watchable, which nothing does before an answer.
        text = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertIn("auto_publish=(review.fetch_auto_publish(channel_id)\n"
                      "                                  and str(recorded_privacy or \"\").lower() in mfk.WATCHABLE),", text)
        self.assertNotIn("auto_publish=review.fetch_auto_publish(channel_id),", text)

    def test_a_video_nobody_answered_for_does_not_go_public(self):
        out, yt, store = self._publish({"made_for_kids": True, "kids_content": True, "made_for_kids_answered_by": None}, True)
        self.assertEqual(out, "refused")
        self.assertEqual(yt.updates, [])
        self.assertEqual(store.finishes[-1][:2], ("refused", "gate_blocked"))


class EveryNewCutClearsTheAnswer(unittest.TestCase):
    """An answer is about one cut (made_for_kids_answered_cut_sha256, 0141). Every writer of a new cut_sha256 clears it."""

    ANSWER = ("made_for_kids_answered_by", "made_for_kids_answered_at", "made_for_kids_answered_cut_sha256")

    def test_the_review_record_clears_it_with_or_without_a_decision(self):
        from tests.test_video_review_record import FakeSupabase, _patched, _record, _review

        for kw in ({}, {"made_for_kids": KIDS_RUN}):
            fake = FakeSupabase()
            fake.rows["dQw4w9WgXcQ"] = {"video_id": "dQw4w9WgXcQ", "channel_id": "news", "made_for_kids_answered_by": "u-1",
                                        "made_for_kids_answered_at": "2026-11-12T10:00:00Z",
                                        "made_for_kids_answered_cut_sha256": "ab" * 32}
            with _patched(fake):
                _record(_review(), **kw)
            row = fake.rows["dQw4w9WgXcQ"]
            self.assertEqual({k: row.get(k) for k in self.ANSWER}, dict.fromkeys(self.ANSWER), kw)

    def test_a_held_cut_and_a_promoted_upload_clear_it(self):
        from unittest import mock
        from tests.test_held_video import FakePostgrest, Promote, _client, _hold

        fake = FakePostgrest()
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client())
            row = next(iter(fake.rows.values()))
            self.assertEqual({k: row.get(k, "absent") for k in self.ANSWER}, dict.fromkeys(self.ANSWER))
            row.update({"made_for_kids_answered_by": "u-1", "made_for_kids_answered_at": "x",
                        "made_for_kids_answered_cut_sha256": "ab" * 32})
            self.assertTrue(_client().promote(**Promote.UPLOAD))
        up = fake.rows["dQw4w9WgXcQ"]
        self.assertEqual({k: up.get(k) for k in self.ANSWER}, dict.fromkeys(self.ANSWER))

    def test_a_database_without_0141_keeps_the_0112_columns(self):
        from unittest import mock
        from modules import held_video
        from tests.test_held_video import FakePostgrest, _client, _hold

        fake = FakePostgrest(missing_columns=held_video.COLUMNS_0141_ANSWER)
        with mock.patch("modules.held_video.requests", fake):
            _hold(_client())
        row = next(iter(fake.rows.values()))
        self.assertIn("cut_sha256", row)
        self.assertNotIn("made_for_kids_answered_by", row)


class TheReviewRecordOnlyDropsTheDeclarationForAMissingColumn(unittest.TestCase):
    def test_a_refusal_that_is_not_a_missing_column_does_not_land_the_row_without_it(self):
        import json as _json
        from tests.test_video_review_record import FakeSupabase, Resp, _patched, _record, _review

        class Refuses(FakeSupabase):
            def _refuse(self, body):
                rows = body if isinstance(body, list) else [body or {}]
                if any("made_for_kids" in r for r in rows):
                    return Resp(400, text=_json.dumps({"code": "23514", "message": "violates check constraint"}))
                return None

        fake = Refuses()
        with _patched(fake):
            _record(_review(), made_for_kids=KIDS_RUN)
        self.assertNotIn("dQw4w9WgXcQ", fake.rows, "a check refusal is not 'retry without the declaration'")
        old = FakeSupabase(missing_columns=("made_for_kids",))
        with _patched(old):
            _record(_review(), made_for_kids=KIDS_RUN)
        self.assertIn("dQw4w9WgXcQ", old.rows, "a missing column (no 0141) still lets the rest of the row land")
