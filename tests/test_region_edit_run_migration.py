"""Migration 0125 (the region editor's run step), pinned from the file: what the security lab cannot see by running it.

* the three replaced functions are the latest bodies (0100 / 0099 / 0075) with only the marked additions, and the drift guard in the file
  carries exactly the md5 of the old and the new bodies (the header names the same hashes, so the person who applies it reads what the file checks);
* it grants nothing: the two new functions are revoked from every API role, the replaced ones keep their ledger of privileges, and no later
  statement grants anon anything;
* the closed numbers and words (1 to 5 regions, 2 to 8 feather, 16 px, 60 / 1000 characters, the outcome codes) are the same in the file, in
  modules/region_edit.py, in modules/creative_worker.py and in the TypeScript table;
* a migration numbered above 0125 that replaces one of these functions must carry the region lines too;
* the rollback restores the latest bodies byte for byte and refuses while a region edit is in flight.
"""

import difflib
import hashlib
import re
import unittest
from pathlib import Path

from modules import creative_worker, region_edit

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
FILE = MIG / "0125_region_edit_run.sql"
TEXT = FILE.read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0125_region_edit_run.sql").read_text(encoding="utf-8")

PP = "create or replace function public.creative_params_problem("
QQ = "create or replace function public.creative_quantity("
FF = "create or replace function public.finish_creative_job("
RP = "create or replace function public.creative_regions_problem("
RO = "create or replace function public.creative_region_outcomes("


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def body(sql: str, start: str) -> str:
    i = sql.index(start)
    a = sql.index("$$", i) + 2
    return sql[a:sql.index("$$", a)]


def whole(sql: str, start: str) -> str:
    i = sql.index(start)
    a = sql.index("$$", i) + 2
    return sql[i:sql.index("$$;", a) + 3]


def h(b: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", b).encode()).hexdigest()


def added_lines(old: str, new: str, allow_replaced: int = 0):
    """The lines of ``new`` that are not lines of ``old``, in order. Raises if more than ``allow_replaced`` old lines were changed or removed."""
    o, n = old.splitlines(), new.splitlines()
    out, lost = [], 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, o, n, autojunk=False).get_opcodes():
        if tag in ("insert", "replace"):
            out.extend(n[j1:j2])
        if tag in ("delete", "replace"):
            lost += i2 - i1
    assert lost <= allow_replaced, f"{lost} old line(s) were changed or removed"
    return out


def latest_before(name: str, number: str):
    found = None
    for path in sorted(MIG.glob("*.sql")):
        if path.name[:4] >= number:
            continue
        t = path.read_text(encoding="utf-8")
        for m in re.finditer(r"create or replace function public\.%s\(.*?\n\$\$;\n" % name, t, re.S):
            found = (path.name, m.group(0))
    assert found, name
    return found


OLD = {n: latest_before(n, "0125") for n in ("creative_params_problem", "creative_quantity", "finish_creative_job")}


class Numbering(unittest.TestCase):
    def test_the_number_is_unique(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0125"), 1)
        self.assertIn("0122", numbers)

    def test_the_bodies_it_replaces_are_the_latest_ones(self):
        self.assertEqual(OLD["creative_params_problem"][0], "0100_video_ai_ops.sql")
        self.assertEqual(OLD["creative_quantity"][0], "0099_image_ai_ops.sql")
        self.assertEqual(OLD["finish_creative_job"][0], "0075_model_router.sql")

    def test_the_file_says_it_is_applied_as_one_transaction_and_names_the_hashes_to_verify(self):
        self.assertIn("APPLY AS ONE TRANSACTION", TEXT)
        self.assertIn("WHAT TO VERIFY BEFORE YOU APPLY", TEXT)
        self.assertIn("LIVE ON APPLY", TEXT)
        self.assertIn("set local lock_timeout", code(TEXT))

    def test_the_rollback_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)


class Hashes(unittest.TestCase):
    """The guard, the header and the end-state assertion all name the md5 of the real bodies."""

    def test_the_guard_carries_the_md5_of_the_old_and_the_new_bodies(self):
        for name, start in (("creative_params_problem", PP), ("creative_quantity", QQ), ("finish_creative_job", FF)):
            old = h(body(OLD[name][1], start))
            new = h(body(TEXT, start))
            self.assertNotEqual(old, new, name)
            self.assertEqual(TEXT.count(old), 2, f"{name} before-hash: the header and the guard must both name it")
            self.assertGreaterEqual(TEXT.count(new), 3, name)
            self.assertIn(f"array['{old}', '{new}']", TEXT, name)
            self.assertIn(old, ROLLBACK)
            self.assertIn(new, ROLLBACK)

    def test_the_new_functions_are_pinned_too(self):
        for start in (RP, RO):
            digest = h(body(TEXT, start))
            self.assertGreaterEqual(TEXT.count(digest), 3, start)

    def test_the_rollback_puts_the_old_bodies_back_byte_for_byte(self):
        for name, start in (("creative_params_problem", PP), ("creative_quantity", QQ), ("finish_creative_job", FF)):
            self.assertEqual(whole(ROLLBACK, start), OLD[name][1].rstrip("\n"), name)

    def test_the_rollback_refuses_while_a_region_edit_is_in_flight_and_drops_the_two_new_functions(self):
        self.assertIn("a region edit is still in flight", ROLLBACK)
        self.assertIn("drop function if exists public.creative_regions_problem(jsonb);", ROLLBACK)
        self.assertIn("drop function if exists public.creative_region_outcomes(jsonb, jsonb);", ROLLBACK)
        # creative_params_problem calls the first one, so it is put back before it is dropped.
        self.assertLess(ROLLBACK.index(PP), ROLLBACK.index("drop function if exists public.creative_regions_problem"))
        self.assertLess(ROLLBACK.index(FF), ROLLBACK.index("drop function if exists public.creative_region_outcomes"))


class ReplacedBodies(unittest.TestCase):
    def test_creative_quantity_gains_exactly_one_branch(self):
        added = added_lines(body(OLD["creative_quantity"][1], QQ), body(TEXT, QQ))
        self.assertEqual(len(added), 2)
        self.assertTrue(added[0].lstrip().startswith("-- 0125:"))
        self.assertEqual(added[1].strip(),
                         "when p_capability = 'edit' and jsonb_typeof(p_params -> 'regions') = 'array' then jsonb_array_length(p_params -> 'regions')::numeric")
        # …before the generic edit = 1, so the count wins.
        new = body(TEXT, QQ)
        self.assertLess(new.index("jsonb_array_length"), new.index("when p_capability in ('t2i', 'edit', 'remove_bg') then 1::numeric"))

    def test_creative_params_problem_is_0100s_body_plus_the_marked_lines_and_two_changed_lines(self):
        old, new = body(OLD["creative_params_problem"][1], PP), body(TEXT, PP)
        changed = ["                 'target_resolution', 'end_asset_id', 'language', 'quality', 'audio', 'look') then",
                   "  if prompted or p_params ? 'prompt' then"]
        for line in changed:
            self.assertEqual(old.splitlines().count(line), 1, line)
        added = "\n".join(added_lines(old, new, allow_replaced=2))
        for needle in ("regioned boolean := coalesce(p_capability = 'edit' and p_params ? 'regions', false);",
                       "'regions', 'region_feather') then",
                       "return format('regions does not apply to %s', p_capability);",
                       "return format('region_feather does not apply to %s', p_capability);",
                       "problem := public.creative_regions_problem(p_params);",
                       "if (prompted and not regioned) or p_params ? 'prompt' then"):
            self.assertIn(needle, added)
        self.assertGreaterEqual(added.count("-- 0125"), 4)
        # Every string literal of the old body is still there: nothing was loosened.
        lit = lambda s: set(re.findall(r"'(?:[^']|'')*'", code(s)))
        self.assertTrue(lit(old) <= lit(new), lit(old) - lit(new))

    def test_creative_params_problem_keeps_the_unknown_key_refusal_ahead_of_the_region_rules(self):
        new = body(TEXT, PP)
        self.assertLess(new.index("unknown parameter %s"), new.index("public.creative_regions_problem(p_params)"))
        self.assertIn("format('unknown parameter %s', k)", new)

    def test_finish_creative_job_is_0075s_body_plus_the_settlement_block_only(self):
        old, new = body(OLD["finish_creative_job"][1], FF), body(TEXT, FF)
        added = "\n".join(added_lines(old, new))
        # nothing of the old body changed (allow_replaced = 0 above) — and the new block is where the header says
        for needle in ("if j.capability = 'edit' and jsonb_typeof(j.params -> 'regions') = 'array' then",
                       "n_regions := jsonb_array_length(j.params -> 'regions');",
                       "if j.quantity is distinct from n_regions then",
                       "perform public.creative_end_locked(p_job, 'failed', 'region_quote_mismatch',",
                       "p_result := public.creative_region_outcomes(j.params, p_result);",
                       "if n_applied = 0 then",
                       "perform public.creative_end_locked(p_job, 'failed', 'no_region_applied',",
                       "if cardinality(j.result_asset_ids) <> 1 then",
                       "p_charge := j.quoted_credits * n_applied / n_regions;"):
            self.assertIn(needle, added)
        # the block sits between the result-size check and the charge line, and the ordinary charge line is the one that rounds it up
        self.assertLess(new.index("result must be a JSON object of at most 16 KB"), new.index("n_regions := jsonb_array_length"))
        self.assertLess(new.index("p_charge := j.quoted_credits * n_applied / n_regions;"),
                        new.index("charge := public.credits_round_up(coalesce(p_charge, j.quoted_credits));"))
        # a failure report is still a plain full release for every job, region edit or not
        fail = new[new.index("if not coalesce(p_ok, false) then"):new.index("if j.provider_task_id is null then")]
        self.assertNotIn("regions", fail)
        self.assertIn("creative_end_locked(p_job, 'failed', code, coalesce(p_error, code))", fail)

    def test_the_old_routed_cap_and_capture_lines_survive(self):
        new = body(TEXT, FF)
        for needle in ("if j.routed_credits is not null and charge > j.routed_credits then",
                       "charged := coalesce(public.capture_credits(j.credit_ref, charge, false), 0);",
                       "raise exception 'a charge of % is not within the hold of %', charge, j.quoted_credits"):
            self.assertIn(needle, new)


class ClosedShapes(unittest.TestCase):
    def test_the_numbers_are_the_python_and_typescript_numbers(self):
        shape = body(TEXT, RP)
        self.assertIn("jsonb_array_length(p_params -> 'regions') not between 1 and 5", shape)
        self.assertEqual(region_edit.MAX_REGIONS, 5)
        self.assertIn("public.creative_json_int(p_params -> 'region_feather', 2, 8)", shape)
        self.assertEqual((region_edit.FEATHER_MIN, region_edit.FEATHER_MAX), (2, 8))
        self.assertIn("public.creative_json_int(c -> 'w', 16, 32768)", shape)
        self.assertEqual(region_edit.MIN_REGION_PX, 16)
        self.assertIn("char_length(r ->> 'name') > 60", shape)
        self.assertEqual(region_edit.MAX_NAME_CHARS, 60)
        self.assertIn("char_length(r ->> 'prompt') > 1000", shape)
        self.assertEqual(region_edit.MAX_PROMPT_CHARS, 1000)
        geometry = (ROOT / "command-center" / "lib" / "regionEdit" / "geometry.ts").read_text(encoding="utf-8")
        for name, value in (("MAX_REGIONS", 5), ("MIN_REGION_PX", 16), ("FEATHER_MIN", 2), ("FEATHER_MAX", 8), ("NAME_MAX", 60), ("PROMPT_MAX", 1000)):
            self.assertRegex(geometry, rf"export const {name} = {value};")

    def test_a_region_edit_takes_these_keys_and_no_others(self):
        shape = body(TEXT, RP)
        self.assertIn("if k not in ('source_asset_id', 'quality', 'regions', 'region_feather') then", shape)
        self.assertIn("if k not in ('id', 'name', 'rect', 'prompt') then", shape)
        self.assertIn("if k not in ('x', 'y', 'w', 'h') then", shape)
        self.assertNotIn("brush", code(shape))

    def test_the_outcome_codes_are_the_workers_and_the_files_closed_list(self):
        listed = re.search(r"codes constant text\[\] := array\[(.*?)\];", body(TEXT, RO), re.S).group(1)
        codes = tuple(re.findall(r"'([a-z_]+)'", listed))
        self.assertEqual(set(codes), set(creative_worker.REGION_CODES))
        self.assertEqual(len(codes), len(set(codes)))
        ts = (ROOT / "command-center" / "lib" / "regionEdit" / "run.ts").read_text(encoding="utf-8")
        self.assertEqual(set(re.findall(r'"([a-z_]+)"', re.search(r"REGION_REASONS = \[(.*?)\]", ts, re.S).group(1))), set(codes))

    def test_the_statuses_are_the_workers(self):
        self.assertIn("(e ->> 'status') not in ('applied', 'failed', 'refused')", body(TEXT, RO))
        self.assertEqual(set(creative_worker.REGION_STATUSES), {"applied", "failed", "refused"})


class Scope(unittest.TestCase):
    def test_it_replaces_exactly_these_functions_and_creates_exactly_these_two(self):
        names = re.findall(r"create or replace function public\.(\w+)\(", code(TEXT))
        self.assertEqual(sorted(names), sorted(["creative_params_problem", "creative_quantity", "finish_creative_job",
                                                 "creative_regions_problem", "creative_region_outcomes"]))

    def test_it_is_additive_and_writes_no_row(self):
        # What the file DOES when it is applied (outside every $$ body): no DDL on tables, no row written. The one DML in a body is
        # finish_creative_job writing the result of a job it is settling, which the 0036 body did already.
        outside = re.sub(r"\$\$.*?\$\$", "", code(TEXT), flags=re.S).lower()
        for word in ("drop table", "drop column", "drop function", "delete from", "truncate", "alter table", "create table", "create policy",
                     "create trigger", "insert into", "update ", "create index"):
            self.assertNotIn(word, outside)

    def test_it_grants_nothing_to_anon_or_authenticated(self):
        c = code(TEXT)
        for line in re.findall(r"(?im)^\s*grant .*$", c):
            self.assertRegex(line, r"to service_role;$", line)
        self.assertEqual(len(re.findall(r"(?im)^\s*grant ", c)), 1)
        for sig in ("public.creative_regions_problem(jsonb)", "public.creative_region_outcomes(jsonb, jsonb)",
                    "public.creative_params_problem(text, jsonb)", "public.creative_quantity(text, jsonb)",
                    "public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text)"):
            self.assertIn(f"revoke all on function {sig} from public, anon, authenticated, service_role;", c)
        # the two helpers are never granted to anyone; finish stays the worker's
        self.assertNotIn("grant execute on function public.creative_regions_problem", c)
        self.assertNotIn("grant execute on function public.creative_region_outcomes", c)
        self.assertIn("grant execute on function public.finish_creative_job(uuid, text, boolean, numeric, jsonb, text, text) to service_role;", c)

    def test_the_helpers_are_immutable_and_read_no_table(self):
        for start in (RP, RO):
            fn = whole(TEXT, start)
            self.assertIn("language plpgsql immutable set search_path = public, pg_temp as", fn)
            self.assertNotIn("security definer", fn)
            self.assertNotRegex(code(fn).lower(), r"\b(from|join)\s+public\.\w+")

    def test_no_later_migration_may_replace_these_functions_without_the_region_lines(self):
        for path in sorted(MIG.glob("*.sql")):
            if path.name[:4] <= "0125":
                continue
            for name, key in (("creative_params_problem", "creative_regions_problem"), ("creative_quantity", "'regions'"),
                              ("finish_creative_job", "creative_region_outcomes")):
                for m in re.finditer(r"create or replace function public\.%s\(.*?\n\$\$;\n" % name, path.read_text(encoding="utf-8"), re.S):
                    self.assertIn(key, m.group(0), f"{path.name} replaces {name} without the 0125 region lines")

    def test_the_header_states_the_overlap_check_with_the_open_migrations(self):
        self.assertIn("OVERLAP WITH 0123 / 0124, checked line by line: NONE", TEXT)
        self.assertIn("#616", TEXT)
        self.assertIn("#612", TEXT)


if __name__ == "__main__":
    unittest.main()
