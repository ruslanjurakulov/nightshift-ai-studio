"""Migration 0129 (an export in another frame, from a closed list), pinned from the file.

SQL does not run in this suite; the security lab runs it (tests/security/test_sec_editor_export_frame.py). What this pins is what a lab
cannot see:

  * the three-argument request_editor_export() is 0054's two-argument body BYTE FOR BYTE except for the lines marked 0129: pure
    additions, plus ONE replaced line whose original is written next to it (so no gate of 0054 moved, and the one rule that changed
    shape is the one the file says changed);
  * the two-argument function is not defined, dropped or re-granted by this file: an export without a frame is what it was;
  * the database's closed list is schemas/export_presets.json, id for id and pixel for pixel, and the column check carries the
    timeline's own limits;
  * the frame is looked at only AFTER sign-in and membership, and before anything is written;
  * the file adds no grant on a table, no policy, grants the overload to authenticated only and the list to nobody;
  * the hashes the file, its rollback and its header carry are the hashes of the bodies;
  * the worker's reason words, the Command Center's list and the three dictionaries agree, and the cap of frames per request is the
    organization's in-flight cap.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

from modules import editor_export, export_presets
from modules import timeline as tl

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0129_editor_export_frame.sql").read_text(encoding="utf-8")
SQL54 = (MIG / "0054_editor_projects.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0129_editor_export_frame.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
CC = ROOT / "command-center"

REQ2 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer) returns uuid"
REQ3 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text) returns uuid"
LIST = "create or replace function public.editor_export_frame(p_frame text)"
BEFORE = "6d37b4d75092708981c28a56879c89b4"
MARK = "0129"
REPLACES = "-- 0129 replaces: "


def func(text: str, head: str, language: str = "language plpgsql") -> str:
    i = text.index(head)
    return text[i:text.index("$$;", text.index(language, i)) + 3]


def body(fn: str) -> str:
    a = fn.index("$$") + 2
    return fn[a:fn.rindex("$$")]


def md5_of_body(fn: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


def without_the_marked_lines(mine: str) -> str:
    """The new body with every line marked 0129 taken out, and the ONE replaced line put back as the original the marker quotes."""
    kept = []
    for line in mine.splitlines():
        if REPLACES in line:
            indent = line[:len(line) - len(line.lstrip())]
            kept.append(indent + line.split(REPLACES, 1)[1])
        elif MARK not in line:
            kept.append(line)
    return "\n".join(kept)


class TheOverloadIs0054sFunctionPlusTheFrame(unittest.TestCase):
    def test_the_body_is_0054s_plus_only_the_marked_lines(self):
        mine = body(func(SQL, REQ3))
        self.assertEqual(without_the_marked_lines(mine).splitlines(), body(func(SQL54, REQ2)).splitlines())
        # Not vacuous: the marked lines are really there, and taking them out is what makes the two equal.
        self.assertNotEqual(mine.splitlines(), body(func(SQL54, REQ2)).splitlines())
        self.assertEqual(len(mine.splitlines()) - len(body(func(SQL54, REQ2)).splitlines()), 17)

    def test_exactly_these_lines_were_added_and_one_was_replaced(self):
        mine = body(func(SQL, REQ3))
        marked = [ln.strip() for ln in mine.splitlines() if MARK in ln]
        code = [ln for ln in marked if not ln.startswith("--")]
        self.assertEqual(code, [
            "frame_id text;   -- 0129",
            "frame_w  integer;   -- 0129",
            "frame_h  integer;   -- 0129",
            "select f.id, f.width, f.height into frame_id, frame_w, frame_h from public.editor_export_frame(p_frame) f;   -- 0129",
            "if frame_id is null then   -- 0129",
            "raise exception 'invalid_frame' using errcode = 'NS400';   -- 0129",
            "end if;   -- 0129",
            "where project_id = p.id and status in ('queued', 'rendering') and coalesce(to_jsonb(frame_width), doc -> 'width') = to_jsonb(frame_w) "
            "and coalesce(to_jsonb(frame_height), doc -> 'height') = to_jsonb(frame_h)) then   "
            "-- 0129 replaces: where project_id = p.id and status in ('queued', 'rendering')) then",
            "update public.editor_exports   -- 0129",
            "set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129",
            "where id = e.id;   -- 0129",
        ])
        self.assertEqual(sum(REPLACES in ln for ln in marked), 1, "one line of 0054 has a new shape, and only one")
        # The comments that are marked are comments, nothing hides behind a marker.
        for ln in marked:
            if ln not in code:
                self.assertTrue(ln.startswith("-- 0129 "), ln)
        # And the line that was replaced is a line of 0054's body, once.
        original = [ln.strip() for ln in body(func(SQL54, REQ2)).splitlines()]
        self.assertEqual(original.count("where project_id = p.id and status in ('queued', 'rendering')) then"), 1)

    def test_every_gate_of_0054_is_still_there_in_0054s_order(self):
        fn = " ".join(body(func(CODE, REQ3)).split())
        gates = ["auth.uid() is null", "not public.is_org_member(p.org_id)", "public.editor_export_frame(p_frame)",
                 "raise exception 'invalid_frame'", "p_rev <> p.rev", "public.editor_doc_problem(p.org_id, p.doc)",
                 "public.editor_doc_duration(p.doc)", "total <= 0", "total > 1800",
                 "pg_advisory_xact_lock(hashtextextended('editor_exports:' || p.org_id::text, 0))",
                 "coalesce(to_jsonb(frame_width), doc -> 'width') = to_jsonb(frame_w)", ">= 3", ">= 20", "insert into public.editor_exports",
                 "update public.editor_exports set frame_preset = frame_id"]
        at = [fn.index(g) for g in gates]
        self.assertEqual(at, sorted(at), "a gate moved")
        # The frame is refused after membership (a stranger learns nothing about the list) and before anything is written or locked.
        self.assertLess(fn.index("raise exception 'not_found'"), fn.index("public.editor_export_frame(p_frame)"))
        self.assertLess(fn.index("raise exception 'invalid_frame'"), fn.index("pg_advisory_xact_lock"))
        # Width and height on the row come from the list's answer, never from an argument: the function has no size argument at all.
        self.assertIn("(p_project uuid, p_rev integer, p_frame text) returns uuid", func(SQL, REQ3).split("language", 1)[0])
        self.assertEqual(fn.count("p_frame"), 1, "the caller's word is read once, by the list, and never stored as given")

    def test_the_three_limits_are_0054s_numbers(self):
        new, old = (" ".join(body(func(text, head)).split()) for text, head in ((CODE, REQ3), ("\n".join(
            line.split("--", 1)[0] for line in SQL54.splitlines()), REQ2)))
        for limit in ("where org_id = p.org_id and status in ('queued', 'rendering')) >= 3 then",
                      "where org_id = p.org_id and created_at > now() - interval '24 hours') >= 20 then",
                      "if total > 1800 then"):
            self.assertEqual((new.count(limit), old.count(limit)), (1, 1), limit)

    def test_the_overload_has_no_defaults_a_fixed_search_path_and_charges_nothing(self):
        fn = func(CODE, REQ3)
        self.assertNotIn(" default ", fn.split("language", 1)[0])
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp as $$", fn)
        for word in ("credit", "reserve", "publish", "videos", "approve"):
            self.assertNotIn(word, body(fn), word)

    def test_the_two_argument_function_is_not_touched(self):
        self.assertNotIn("function public.request_editor_export(p_project uuid, p_rev integer) ", CODE)
        self.assertNotRegex(CODE, r"(revoke|grant)[^;]*request_editor_export\(uuid, integer\)")
        self.assertNotRegex(CODE, r"drop function")
        for name in ("claim_editor_export", "finish_editor_export", "editor_export_assets", "editor_export_heartbeat",
                     "delete_editor_project", "save_editor_project", "create_editor_project", "editor_doc_problem", "editor_doc_duration"):
            self.assertNotRegex(CODE, rf"create or replace function public\.{name}\(", name)


class TheClosedList(unittest.TestCase):
    def rows(self):
        fn = func(CODE, LIST, "language sql")
        return [(i, int(w), int(h)) for i, w, h in re.findall(r"\('([a-z0-9_]+)', (\d+), (\d+)\)", body(fn))]

    def test_it_is_the_presets_file_id_for_id_and_pixel_for_pixel(self):
        # 0129's list was the whole file when it was written. 0132 replaced the list with the file's nine (the paid 1440p and 4K
        # frames after these five): its own pin test compares that one with the whole file.
        data = json.loads((ROOT / "schemas" / "export_presets.json").read_text(encoding="utf-8"))
        self.assertEqual(self.rows(), [(p["id"], p["width"], p["height"]) for p in data["presets"]][:5])
        self.assertEqual(self.rows(), [(p.id, p.width, p.height) for p in export_presets.free().values()])
        self.assertEqual(len(self.rows()), 5)

    def test_it_matches_exactly_and_is_internal(self):
        fn = func(CODE, LIST, "language sql")
        self.assertIn("where v.id = p_frame", " ".join(body(fn).split()))
        for fold in ("lower(", "upper(", "trim(", "btrim(", "ilike", "~*", " like "):
            self.assertNotIn(fold, body(fn), fold)
        self.assertIn("language sql immutable set search_path = public, pg_temp as $$", fn)
        self.assertNotIn("security definer", fn)
        self.assertIn("revoke all on function public.editor_export_frame(text) from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant[^;]*editor_export_frame")

    def test_the_column_check_carries_the_timelines_own_limits(self):
        check = " ".join(CODE.split("add constraint editor_exports_frame_shape check (", 1)[1].split(";", 1)[0].split())
        self.assertIn("(frame_preset is null and frame_width is null and frame_height is null)", check)
        self.assertIn("frame_preset is not null and frame_width is not null and frame_height is not null", check)
        self.assertIn(f"frame_width between {tl.MIN_SIDE} and {tl.MAX_SIDE} and frame_height between {tl.MIN_SIDE} and {tl.MAX_SIDE}", check)
        self.assertIn("frame_width % 2 = 0 and frame_height % 2 = 0", check)
        self.assertIn(f"frame_width * frame_height <= {tl.LARGE_FRAME_PX}", check)
        self.assertEqual(export_presets._ID.pattern, "^[a-z0-9_]{1,32}$")
        self.assertIn("frame_preset ~ '^[a-z0-9_]{1,32}$'", check)
        # Every entry of the list passes the check it will be stored under.
        for _, w, h in TheClosedList.rows(self):
            self.assertTrue(tl.MIN_SIDE <= w <= tl.MAX_SIDE and tl.MIN_SIDE <= h <= tl.MAX_SIDE and w % 2 == 0 and h % 2 == 0
                            and w * h <= tl.LARGE_FRAME_PX)


class TheFile(unittest.TestCase):
    def test_the_hashes_in_the_files_are_the_bodies(self):
        self.assertEqual(md5_of_body(func(SQL54, REQ2)), BEFORE)
        req3, lst = md5_of_body(func(SQL, REQ3)), md5_of_body(func(SQL, LIST, "language sql"))
        self.assertEqual(len({BEFORE, req3, lst}), 3)
        # The drift guard and the end state each carry all three; the header and the verify query carry BEFORE.
        self.assertEqual(CODE.count(f"'{BEFORE}'"), 2)
        self.assertEqual(CODE.count(f"'{req3}'"), 2)
        self.assertEqual(CODE.count(f"'{lst}'"), 2)
        self.assertEqual(SQL.count(BEFORE), 4)
        self.assertEqual(sorted(set(re.findall(r"'([0-9a-f]{32})'", CODE))), sorted([BEFORE, req3, lst]))
        for h in (BEFORE, req3, lst):
            self.assertIn(f"is distinct from '{h}'", ROLLBACK)
        self.assertEqual(sorted(set(re.findall(r"'([0-9a-f]{32})'", ROLLBACK))), sorted([BEFORE, req3, lst]))

    def test_it_refuses_a_body_it_has_not_seen_before_it_changes_anything(self):
        guard = CODE.split("alter table public.editor_exports add column", 1)[0]
        self.assertIn(f"if h <> '{BEFORE}' then", guard)
        self.assertEqual(guard.count("if h is not null and h <> '"), 2)
        self.assertEqual(guard.count("raise exception"), 4)
        self.assertIn("apply 0054_editor_projects.sql first", guard)
        self.assertNotIn("create or replace", guard)

    def test_it_grants_the_overload_to_authenticated_only_and_nothing_on_tables(self):
        grants = re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to ([a-z_, ]+);", CODE)
        self.assertEqual([(n, a.replace(" ", ""), r) for n, a, r in grants], [("request_editor_export", "uuid,integer,text", "authenticated")])
        self.assertIn("revoke all on function public.request_editor_export(uuid, integer, text) from public, anon, authenticated, service_role;", CODE)
        self.assertLess(CODE.index("revoke all on function public.request_editor_export(uuid, integer, text)"),
                        CODE.index("grant execute on function public.request_editor_export(uuid, integer, text)"))
        self.assertNotRegex(CODE, r"grant (select|insert|update|delete|all)\b")
        self.assertNotRegex(CODE, r"\bto (anon|public|service_role)\b")
        self.assertNotRegex(CODE, r"create policy|alter policy|drop policy|enable row level security|disable row level security")
        self.assertNotRegex(CODE, r"\bdrop\b")
        self.assertNotRegex(CODE, r"create (table|trigger|index)")

    def test_the_columns_are_nullable_without_a_default_and_the_file_is_idempotent(self):
        for col, typ in (("frame_preset", "text"), ("frame_width", "integer"), ("frame_height", "integer")):
            self.assertIn(f"alter table public.editor_exports add column if not exists {col} {typ};", CODE)
        self.assertIn("if not exists (select 1 from pg_constraint where conname = 'editor_exports_frame_shape'", CODE)
        # No explicit begin / commit: the runner (or the SQL editor) makes it one transaction, as for 0124-0128.
        self.assertNotRegex(CODE, r"(?m)^(begin|commit);")
        self.assertIn("set local lock_timeout = '5s';", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", SQL)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", SQL)
        self.assertIn("-- Verify (run after applying; every column should read true)", SQL)

    def test_the_end_state_is_asserted(self):
        end = CODE.rsplit("do $$", 1)[1]
        self.assertEqual(end.count("raise exception '0129 end state:"), 9)
        for word in ("has_function_privilege('authenticated', req3, 'EXECUTE')", "not has_function_privilege('anon', req3, 'EXECUTE')",
                     "not has_function_privilege('service_role', req3, 'EXECUTE')", "not has_function_privilege('authenticated', lst, 'EXECUTE')",
                     "a.grantee = 0", "search_path=public, pg_temp", "editor_exports_frame_shape", "has_table_privilege(role_name, 'public.editor_exports', priv)"):
            self.assertIn(word, end, word)

    def test_it_is_the_next_number_and_nothing_else_redefines_the_functions_after_it(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0129"), 1)
        self.assertEqual(max(n for n in numbers if n < "0129"), "0128")
        # 0132 (1440p and 4K) is the one later file that builds on 0129 on purpose: it replaces the list, adds a fourth overload, and
        # replaces this file's three-argument body with the same body plus only the marked lines that refuse a paid frame
        # (tests/test_editor_hires_export_migration.py strips them and compares the rest with this file's body). 0136 (exports up to 1080p
        # sold by the minute) replaces 0132's request bodies the same way and writes no frame of its own (the list stays 0132's).
        for p in sorted(MIG.glob("*.sql")):
            if p.name[:4] > "0054" and not p.name.startswith(("0129_", "0132_", "0136_")):
                text = p.read_text(encoding="utf-8")
                self.assertNotIn("function public.request_editor_export(", text, p.name)
                self.assertNotIn("function public.editor_export_frame(", text, p.name)
            if p.name[:4] > "0129" and not p.name.startswith(("0132_", "0136_")):
                self.assertNotIn("frame_preset", p.read_text(encoding="utf-8"), p.name)
        later = (MIG / "0132_editor_hires_export.sql").read_text(encoding="utf-8")
        self.assertEqual(later.count(REQ3), 1)

    def test_the_rollback_refuses_before_it_changes_anything_and_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        guard = ROLLBACK.split("-- 1. The overload and the closed list.", 1)[0]
        self.assertEqual(guard.count("a later change would be undone; read the live body first"), 2)   # the two functions of 0129
        self.assertIn("an export in flight carries a frame", guard)
        self.assertIn("where frame_preset is not null and status in ('queued', 'rendering')", guard)
        self.assertNotIn("drop ", guard.split("begin;", 1)[1])
        rest = ROLLBACK.split("-- 1. The overload and the closed list.", 1)[1]
        self.assertIn("drop function public.request_editor_export(uuid, integer, text);", rest)
        self.assertIn("drop function public.editor_export_frame(text);", rest)
        self.assertNotIn("drop function public.request_editor_export(uuid, integer);", ROLLBACK)
        # It never touches a finished file or a row's other columns.
        for never in ("media_assets", "delete from", "truncate", "update public.editor_exports"):
            self.assertNotIn(never, rest, never)


class TheThreeHalvesAgree(unittest.TestCase):
    """The database, the worker and the Command Center each hold a copy of a few words and numbers."""

    def ts(self, rel: str) -> str:
        return (CC / rel).read_text(encoding="utf-8")

    def test_the_switch_has_one_name(self):
        self.assertEqual(editor_export.FRAME_FLAG, "NIGHTSHIFT_MULTI_RATIO_EXPORT")
        flag = self.ts("lib/multiRatioExport/flag.ts")
        self.assertIn('export const MULTI_RATIO_EXPORT_FLAG = "NIGHTSHIFT_MULTI_RATIO_EXPORT";', flag)
        self.assertIn("process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT", flag)
        self.assertNotIn("NEXT_PUBLIC", flag.split("*/", 1)[1])
        web = (ROOT / "deploy" / ".env.web.example").read_text(encoding="utf-8")
        worker = (ROOT / "deploy" / ".env.worker.example").read_text(encoding="utf-8")
        self.assertRegex(web, r"(?m)^NIGHTSHIFT_MULTI_RATIO_EXPORT=$", "empty must mean off")
        self.assertRegex(worker, r"(?m)^NIGHTSHIFT_MULTI_RATIO_EXPORT=$", "empty must mean off")
        flow = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
        # ONE repository variable feeds both, so the page and the worker cannot be switched apart by a typo.
        self.assertIn("WEBENV_NIGHTSHIFT_MULTI_RATIO_EXPORT: ${{ vars.NIGHTSHIFT_MULTI_RATIO_EXPORT }}", flow)
        self.assertIn("WORKERENV_NIGHTSHIFT_MULTI_RATIO_EXPORT: ${{ vars.NIGHTSHIFT_MULTI_RATIO_EXPORT }}", flow)

    def test_every_reason_the_worker_can_give_has_a_sentence_in_three_languages(self):
        listed = re.search(r"export const EXPORT_REASONS = \[(.*?)\] as const;", self.ts("lib/editor.ts"), re.S).group(1)
        ts_reasons = re.findall(r'"([a-z_]+)"', listed)
        for word in editor_export.REASONS:
            self.assertIn(word, ts_reasons, word)
        for lang in ("en", "ru", "uz"):
            text = self.ts(f"lib/i18n/{lang}.ts")
            block = text.split("exportReasons: {", 1)[1].split("},", 1)[0]
            for word in ts_reasons:
                self.assertRegex(block, rf'(?m)^\s+{word}:\s*\n?\s*"', f"{lang}: {word}")

    def test_a_frame_failure_is_not_offered_as_try_again(self):
        # The same request would fail the same way: the row's frame, or the switch, is the problem, not a server hiccup.
        status = self.ts("lib/editorExportStatus.ts")
        block = status.split("const NOT_RETRYABLE", 1)[1].split("];", 1)[0]
        self.assertIn('"invalid_frame"', block)
        self.assertIn('"frame_off"', block)

    def test_the_most_frames_one_request_may_name_is_the_organizations_in_flight_cap(self):
        frames = self.ts("lib/multiRatioExport/frames.ts")
        cap = int(re.search(r"export const MAX_EXPORT_FRAMES = (\d+);", frames).group(1))
        fn = " ".join(body(func(CODE, REQ3)).split())
        self.assertIn(f"where org_id = p.org_id and status in ('queued', 'rendering')) >= {cap} then", fn)

    def test_the_command_center_never_sends_a_size(self):
        route = self.ts("app/api/editor/projects/[id]/exports/route.ts")
        calls = re.findall(r'rpc\(\s*"request_editor_export",\s*\{(.*?)\}\s*,?\s*\)', route, re.S)
        # The plain export (switch off, or no `frames`), the project's own frame among several, ONE call that names a free frame,
        # and (0132) one that names a paid frame with the number of credits the person confirmed.
        self.assertEqual(len(calls), 4)
        names = [sorted(re.findall(r"\b(p_[a-z_]+)\b", c)) for c in calls]
        self.assertEqual(sorted(names), [["p_frame", "p_max_credits", "p_project", "p_rev"], ["p_frame", "p_project", "p_rev"],
                                         ["p_project", "p_rev"], ["p_project", "p_rev"]])
        self.assertNotRegex(route, r"p_(width|height|w|h)\b")


if __name__ == "__main__":
    unittest.main()
