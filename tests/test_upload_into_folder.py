"""Uploading into a folder — migration 0051 and the media worker's side.

SQL does not run in this suite (the security lab runs it: tests/security/
test_sec_upload_folder.py), so the migration's text is pinned for what
matters: the folder is checked against the uploader's own organization and
role when the ticket is asked for, stored on the ticket, and re-checked when
the worker registers the file — a folder that is gone means All files, never
a failure — while every older check and privilege stays as it was.

The worker half: it never names a folder (register_asset has no argument for
one), and its log says where the file landed without guessing.
"""

import re
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path

from modules import media_library as ml

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0051_upload_into_folder.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
CODE38 = "\n".join(line.split("--", 1)[0] for line in (MIG / "0038_media_assets.sql").read_text().splitlines())
CODE44 = "\n".join(line.split("--", 1)[0] for line in (MIG / "0044_media_heic.sql").read_text().splitlines())

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                    "0000000d49444154789c6360000002000154a24f0f0000000049454e44ae426082")


def body(code: str, head: str) -> str:
    return code.split(head, 1)[1].split("$$;", 1)[0]


SIX = "function public.request_upload(\n  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid, p_folder_id uuid\n)"
FIVE = "function public.request_upload(\n  p_org uuid, p_filename text, p_mime text, p_bytes bigint, p_project_id uuid default null\n)"


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


class UploadIntoFolderMigration(unittest.TestCase):
    def test_is_additive_nothing_dropped(self):
        self.assertNotRegex(CODE, r"\bdrop\s+(function|table|column|policy|trigger|index)\b")
        self.assertNotRegex(CODE, r"alter\s+table[^;]*\bdrop\b")
        self.assertIn("add column if not exists folder_id uuid", CODE)
        self.assertRegex(norm(CODE), r"foreign key \(folder_id\) references public\.media_folders \(id\) on delete set null")

    def test_the_six_argument_call_has_no_defaults_so_no_call_matches_both(self):
        self.assertIn(SIX, CODE)
        self.assertIn(FIVE, CODE)
        # A default on the six-argument one would make every five-argument
        # call ambiguous in PostgREST and in SQL.
        self.assertNotRegex(CODE, r"p_folder_id uuid default")
        self.assertEqual(CODE.count("create or replace function public.request_upload("), 2)

    def test_the_five_argument_call_is_the_six_with_no_folder(self):
        five = body(CODE, FIVE)
        self.assertIn("select public.request_upload(p_org, p_filename, p_mime, p_bytes, p_project_id, null::uuid)", five)
        self.assertIn("security definer set search_path = public, pg_temp", five)

    def test_the_folder_is_checked_against_the_callers_org_and_role_first(self):
        six = body(CODE, SIX)
        member = six.index("not public.is_org_member(p_org)")
        editor = six.index("public.is_org_member(p_org, 'editor')")
        lookup = six.index("from public.media_folders f where f.id = p_folder_id and f.org_id = p_org")
        insert = six.index("insert into public.media_uploads")
        # Signed in and a member, then an editor (before the folder is looked
        # up: a viewer learns nothing about folder ids), then the folder is
        # this organization's — all before anything is written.
        self.assertLess(member, editor)
        self.assertLess(editor, lookup)
        self.assertLess(lookup, insert)
        self.assertIn("detail = 'reason=folder_not_found'", six)
        self.assertIn("detail = 'reason=folder_forbidden'", six)
        self.assertIn("(p_org, p_project_id, p_folder_id, name_, mime_, p_bytes, 'requested'", six)

    def test_another_orgs_folder_and_a_made_up_one_share_one_refusal(self):
        six = body(CODE, SIX)
        # Exactly one place raises folder_not_found, after one lookup that
        # requires both the id and the org: no branch can tell them apart.
        self.assertEqual(six.count("reason=folder_not_found"), 1)
        self.assertEqual(six.count("from public.media_folders"), 1)

    def test_every_check_of_0044_is_still_in_the_request(self):
        old = norm(body(CODE44, "function public.request_upload("))
        new = norm(body(CODE, SIX))
        for line in (
            "if auth.uid() is null then",
            "raise exception 'this file type is not accepted'",
            "raise exception 'the file name''s extension does not match its type'",
            "if p_bytes > cfg.max_upload_bytes or (kind_ = 'caption' and p_bytes > 2097152) then",
            "q := public.media_quota_lock(p_org);",
            "perform public.media_uploads_sweep(p_org);",
            "if inflight >= cfg.max_pending_uploads then",
            "if q.used_bytes + pending + p_bytes > lim then",
            "raise exception 'the server''s media storage is full'",
        ):
            self.assertIn(line, old, line)
            self.assertIn(line, new, line)

    def test_register_asset_keeps_its_signature_and_takes_no_folder(self):
        sig = r"function public\.register_asset\(([^)]*)\)\s+returns jsonb"
        self.assertEqual(norm(re.search(sig, CODE).group(1)), norm(re.search(sig, CODE38).group(1)))
        self.assertNotIn("p_folder", body(CODE, "function public.register_asset("))

    def test_register_asset_rechecks_the_tickets_folder_and_falls_back_to_all_files(self):
        reg = norm(body(CODE, "function public.register_asset("))
        self.assertIn("select f.id into folder_ from public.media_folders f "
                      "where f.id = t.folder_id and f.org_id = t.org_id for key share;", reg)
        # The folder only ever comes from the ticket (the upload branch);
        # generated and rendered files keep landing in All files.
        upload_branch = reg.split("if p_source = 'upload' then", 1)[1].split("elsif p_upload_id is not null", 1)[0]
        self.assertIn("t.folder_id", upload_branch)
        self.assertEqual(reg.count("folder_ :="), 0)
        self.assertIn("upload_id, created_by, folder_id)", reg)
        self.assertIn("p_upload_id, creator, folder_)", reg)
        # A missing folder is not an error anywhere in registration.
        self.assertNotIn("folder_not_found", reg)

    def test_register_asset_is_0038s_body_otherwise(self):
        old = norm(body(CODE38, "function public.register_asset("))
        for line in (
            "if not public.credits_trusted_caller() then",
            "if p_org is not null and p_org <> t.org_id then",
            "if p_bytes > t.declared_bytes then",
            "if not found or parent.org_id <> org then",
            "perform public.media_quota_lock(org);",
            "set used_bytes = used_bytes + a.bytes + a.derived_bytes, updated_at = now()",
        ):
            self.assertIn(line, old, line)
            self.assertIn(line, norm(body(CODE, "function public.register_asset(")), line)

    def test_privileges_are_0038s(self):
        grants = re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to ([a-z_, ]+);", CODE)
        self.assertEqual(sorted((n, a.replace(" ", ""), r) for n, a, r in grants), [
            ("register_asset", "uuid,uuid,text,text,bigint,text,text,integer,integer,numeric,jsonb,bigint,text[],uuid,uuid,uuid,text,uuid",
             "service_role"),
            ("request_upload", "uuid,text,text,bigint,uuid", "authenticated"),
            ("request_upload", "uuid,text,text,bigint,uuid,uuid", "authenticated"),
        ])
        self.assertNotRegex(CODE, r"\bto anon\b")
        self.assertNotRegex(CODE, r"grant (insert|update|delete)")
        for n, a, _ in grants:
            self.assertIn(f"revoke all on function public.{n}({a}) from public, anon, authenticated, service_role;", CODE)

    def test_needs_its_predecessors_and_has_a_verify_query(self):
        self.assertIn("apply 0049_media_folders.sql first", CODE)
        self.assertIn("apply 0038_media_assets.sql and 0044_media_heic.sql first", CODE)
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)

    def test_no_later_migration_redefines_these_functions(self):
        later = [p for p in sorted(MIG.glob("*.sql")) if p.name[:4] > "0051"]
        for p in later:
            text = p.read_text()
            self.assertNotIn("function public.request_upload(", text, p.name)
            self.assertNotIn("function public.register_asset(", text, p.name)


class RecordingStore:
    def __init__(self, answer_folder="absent"):
        self.registered = []
        self.rejected = []
        self.answer_folder = answer_folder

    def heartbeat(self, *_a):
        pass

    def register(self, **kw):
        self.registered.append(kw)
        out = {"id": kw["asset_id"], "storage_key": ml.storage_key(kw["asset_id"]), "reused": False}
        if self.answer_folder != "absent":
            out["folder_id"] = self.answer_folder
        return out

    def reject(self, tid, worker, reason, detail):
        self.rejected.append((tid, reason))


class WorkerNeverNamesAFolder(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.staging = self.tmp / "staging"
        self.media = self.tmp / "media"
        self.staging.mkdir()
        self.media.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_caption(self, store, ticket_extra):
        data = b"WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n"
        tid = str(uuid.uuid4())
        ml.staged_path(self.staging, tid).write_bytes(data)
        ticket = {"id": tid, "declared_mime": "text/vtt", "original_name": "subs.vtt", "declared_bytes": len(data),
                  **ticket_extra}
        with self.assertLogs(ml.logger, level="INFO") as logs:
            outcome = ml.process_ticket(ticket, store=store, staging_root=self.staging, media_root=self.media,
                                        worker_id="w", tools=ml.Tools("ffprobe", "ffmpeg"))
        return outcome, "\n".join(logs.output)

    def test_a_ticket_with_a_folder_is_registered_without_one(self):
        folder = str(uuid.uuid4())
        store = RecordingStore(answer_folder=folder)
        outcome, log = self.run_caption(store, {"folder_id": folder, "org_id": str(uuid.uuid4())})
        self.assertEqual(outcome, "ingested")
        sent = store.registered[-1]
        # register_asset takes the folder (and org) from the ticket itself; a
        # folder argument would not even resolve there (no such parameter).
        self.assertFalse([k for k in sent if "folder" in k], sent)
        self.assertIsNone(sent["org"])
        self.assertEqual(sent["upload_id"], ml.canonical_id(sent["upload_id"]))
        self.assertIn(f"in folder {folder}", log)

    def test_the_log_says_all_files_when_the_folder_was_gone(self):
        store = RecordingStore(answer_folder=None)
        outcome, log = self.run_caption(store, {"folder_id": str(uuid.uuid4())})
        self.assertEqual(outcome, "ingested")
        self.assertIn("in All files", log)

    def test_before_0051_the_log_does_not_guess_a_place(self):
        store = RecordingStore()
        outcome, log = self.run_caption(store, {})
        self.assertEqual(outcome, "ingested")
        self.assertIn("folder not reported", log)
        self.assertNotIn("All files", log)

    def test_a_malformed_folder_in_the_answer_is_not_logged_as_one(self):
        store = RecordingStore(answer_folder="../../etc")
        _, log = self.run_caption(store, {})
        self.assertIn("folder not reported", log)
        self.assertNotIn("../", log)

    def test_png_fixture_is_still_refused_as_a_caption(self):
        # Guards the fixture above: the worker's content checks run before any
        # registration, folder or not.
        tid = str(uuid.uuid4())
        ml.staged_path(self.staging, tid).write_bytes(PNG)
        store = RecordingStore()
        ticket = {"id": tid, "declared_mime": "text/vtt", "original_name": "subs.vtt", "declared_bytes": len(PNG),
                  "folder_id": str(uuid.uuid4())}
        out = ml.process_ticket(ticket, store=store, staging_root=self.staging, media_root=self.media,
                                worker_id="w", tools=ml.Tools("ffprobe", "ffmpeg"))
        self.assertEqual(out, "rejected")
        self.assertEqual(store.registered, [])


if __name__ == "__main__":
    unittest.main()
