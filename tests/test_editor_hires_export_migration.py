"""Migration 0132 (1440p and 4K exports, sold by the started minute), pinned from the file; and the caps of the three halves.

SQL does not run in this suite; the security lab runs it (tests/security/test_sec_editor_hires_export.py). What this pins is what a lab
cannot see, or what must agree across files:

  * the four-argument request_editor_export() is 0129's three-argument body BYTE FOR BYTE except for the lines marked 0132: additions,
    plus ONE replaced line whose original is written next to it (the credit columns): no gate of 0054 / 0129 moved, and the locks are
    taken in 0054's order (the project's row FOR UPDATE, then the organization's advisory lock), the same as the two older overloads,
    so a paid and a free request of one project never deadlock;
  * the two- and three-argument functions are 0054's / 0129's bodies BYTE FOR BYTE plus only the marked lines that refuse above 1080p
    (hires_needs_paid_export); they are not dropped or re-granted here, and the rollback puts the old bodies back;
  * the charge is the price x the started minutes with NO job_minimum floor, the hold is the charge raised to job_minimum, and the
    caller's number is compared with the charge;
  * the database's closed list is schemas/export_presets.json, id for id and pixel for pixel, and its first five rows are 0129's;
  * the prices are seeded NULL (nothing is sold on apply), the price table is closed to every API role, and no number in this file
    sets a price;
  * the tiers, the length caps and the 4K rate cap are the same numbers in the SQL function, the SQL CHECK, modules/hires_export.py and
    command-center/lib/hiresExport/limits.ts;
  * the hashes the file, its rollback and its header carry are the hashes of the bodies; the drift guard runs before any change;
  * the switch has one name in the worker, the Command Center, both env examples and the deploy workflow.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

from modules import editor_export, export_presets, hires_export

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0132_editor_hires_export.sql").read_text(encoding="utf-8")
SQL129 = (MIG / "0129_editor_export_frame.sql").read_text(encoding="utf-8")
SQL054 = (MIG / "0054_editor_projects.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0132_editor_hires_export.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
CC = ROOT / "command-center"

REQ2 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer) returns uuid"
REQ3 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text) returns uuid"
REQ4 = ("create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text, p_max_credits numeric) "
        "returns uuid")
LIST = "create or replace function public.editor_export_frame(p_frame text)"
HEADS = {
    "req2": (REQ2, "language plpgsql"),
    "req3": (REQ3, "language plpgsql"),
    "req4": (REQ4, "language plpgsql"),
    "quote": ("create or replace function public.quote_editor_export(", "language plpgsql"),
    "list": (LIST, "language sql"),
    "terms": ("create or replace function public.editor_export_hires_terms(", "language plpgsql"),
    "money": ("create or replace function public.editor_export_money(", "language plpgsql"),
    "settle": ("create or replace function public.editor_export_settle(", "language plpgsql"),
    "guard": ("create or replace function public.editor_export_hires_prices_guard(", "language plpgsql"),
    "trail": ("create or replace function public.editor_export_hires_prices_trail(", "language plpgsql"),
}
REQ2_HASH = "6d37b4d75092708981c28a56879c89b4"
REQ3_HASH = "83456b3c70d9433ce0e21da1339198ad"
LIST129_HASH = "1bcfdbfab6526ce7d0ba07e167f5740c"
MARK = "0132"
REPLACES = "-- 0132 replaces: "


def func(text: str, head: str, language: str = "language plpgsql") -> str:
    i = text.index(head)
    return text[i:text.index("$$;", text.index(language, i)) + 3]


def body(fn: str) -> str:
    a = fn.index("$$") + 2
    return fn[a:fn.rindex("$$")]


def md5_of_body(fn: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


def hashes() -> dict:
    return {k: md5_of_body(func(SQL, h, lang)) for k, (h, lang) in HEADS.items()}


def without_the_marked_lines(mine: str) -> str:
    kept = []
    for line in mine.splitlines():
        if REPLACES in line:
            indent = line[:len(line) - len(line.lstrip())]
            kept.append(indent + line.split(REPLACES, 1)[1])
        elif MARK not in line:
            kept.append(line)
    return "\n".join(kept)


class TheOverloadIs0129sFunctionPlusTheHold(unittest.TestCase):
    def test_the_body_is_0129s_plus_only_the_marked_lines(self):
        mine = body(func(SQL, REQ4))
        self.assertEqual(without_the_marked_lines(mine).splitlines(), body(func(SQL129, REQ3)).splitlines())
        self.assertNotEqual(mine.splitlines(), body(func(SQL129, REQ3)).splitlines())

    def test_exactly_these_lines_were_added_and_one_was_replaced(self):
        mine = body(func(SQL, REQ4))
        marked = [ln.strip() for ln in mine.splitlines() if MARK in ln]
        code = [ln for ln in marked if not ln.startswith("--")]
        self.assertEqual(code, [
            "terms    jsonb;   -- 0132",
            "price    numeric;   -- 0132",
            "hold_c   numeric;   -- 0132",
            "ref      text;   -- 0132",
            "held     jsonb;   -- 0132",
            "why      text;   -- 0132",
            "if frame_w::bigint * frame_h <= 2073600 then   -- 0132",
            "raise exception 'invalid_frame' using errcode = 'NS400', detail = 'not a paid frame';   -- 0132",
            "end if;   -- 0132",
            "if not public.is_org_member(p.org_id, 'editor') or (public.credits_exempt(p.org_id) and not public.is_platform_admin()) then   -- 0132",
            "raise exception 'forbidden' using errcode = '42501', detail = 'a paid export is asked by an editor or above';   -- 0132",
            "end if;   -- 0132",
            "if jsonb_path_exists(p.doc, 'lax $.tracks[*].clips[*].speed_curve') then   -- 0132",
            "raise exception 'hires_speed_curve' using errcode = 'NS400';   -- 0132",
            "end if;   -- 0132",
            "terms := public.editor_export_hires_terms(frame_w, frame_h, round(total, 3));   -- 0132",
            "if round(total, 3) > (terms ->> 'max_s')::numeric then   -- 0132",
            "raise exception 'hires_too_long' using errcode = 'NS400', detail = format('max_s=%s', terms ->> 'max_s');   -- 0132",
            "end if;   -- 0132",
            "if jsonb_typeof(p.doc -> 'fps') = 'number' and (p.doc ->> 'fps')::numeric > (terms ->> 'max_fps')::numeric then   -- 0132",
            "raise exception 'hires_fps' using errcode = 'NS400', detail = format('max_fps=%s', terms ->> 'max_fps');   -- 0132",
            "end if;   -- 0132",
            "price := (terms ->> 'credits')::numeric;   -- 0132",
            "hold_c := (terms ->> 'hold')::numeric;   -- 0132",
            "if price is null then   -- 0132",
            "raise exception 'not_on_sale' using errcode = 'NS403';   -- 0132",
            "end if;   -- 0132",
            "if p_max_credits is null or not (p_max_credits between 0 and 100000000) or price > p_max_credits then   -- 0132",
            "raise exception 'price_changed' using errcode = 'NS409', detail = format('price=%s confirmed=%s', price, p_max_credits);   -- 0132",
            "end if;   -- 0132",
            "if hold_c is null or hold_c < price then   -- 0132",
            "raise exception '0132: the hold % is below the charge %', hold_c, price;   -- 0132",
            "end if;   -- 0132",
            "ref := 'ee:' || e.id::text;   -- 0132",
            "begin   -- 0132",
            "held := public.creative_platform_reserve(p.org_id, ref, hold_c);   -- 0132",
            "exception when sqlstate 'NS402' then   -- 0132",
            "get stacked diagnostics why = pg_exception_detail;   -- 0132",
            "raise exception 'insufficient_credits' using errcode = 'NS402', detail = format('hold=%s charge=%s %s', hold_c, price, why);   -- 0132",
            "when sqlstate 'NS429' then   -- 0132",
            "get stacked diagnostics why = pg_exception_detail;   -- 0132",
            "raise exception 'parallel_runs' using errcode = 'NS429', detail = why;   -- 0132",
            "end;   -- 0132",
            "if coalesce((held ->> 'exempt')::boolean, false) then   -- 0132",
            "ref := null;   -- 0132",
            "else   -- 0132",
            "perform public.editor_export_money('start', ref, null);   -- 0132",
            "end if;   -- 0132",
            "set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h, quoted_credits = price, "
            "held_credits = case when ref is null then null else hold_c end, credit_ref = ref   "
            "-- 0132 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129",
        ])
        self.assertEqual(sum(REPLACES in ln for ln in marked), 1)
        for ln in marked:
            if ln not in code:
                self.assertTrue(ln.startswith("-- 0132 "), ln)

    def test_the_gates_are_in_this_order(self):
        fn = " ".join(body(func(CODE, REQ4)).split())
        gates = ["auth.uid() is null", "select * into p from public.editor_projects where id = p_project for update;",
                 "not public.is_org_member(p.org_id)", "public.editor_export_frame(p_frame)",
                 "raise exception 'invalid_frame' using errcode = 'NS400';", "frame_w::bigint * frame_h <= 2073600",
                 "public.is_org_member(p.org_id, 'editor')", "p_rev <> p.rev", "public.editor_doc_problem(p.org_id, p.doc)",
                 "total > 1800", "raise exception 'hires_speed_curve'", "raise exception 'hires_too_long'", "raise exception 'hires_fps'",
                 "raise exception 'not_on_sale'", "raise exception 'price_changed'", "hold_c < price",
                 "pg_advisory_xact_lock", ">= 3", ">= 20", "insert into public.editor_exports",
                 "public.creative_platform_reserve(p.org_id, ref, hold_c)", "public.editor_export_money('start', ref, null)",
                 "update public.editor_exports set frame_preset = frame_id"]
        at = [fn.index(g) for g in gates]
        self.assertEqual(at, sorted(at), "a gate moved")
        # The price is refused before the organization's lock and limits: a request that is not on sale holds nothing and counts nothing.
        self.assertLess(fn.index("raise exception 'not_on_sale'"), fn.index("pg_advisory_xact_lock"))
        # The hold comes after every limit, and the credit columns are written in the same statement as the frame (the CHECK sees both).
        self.assertLess(fn.index(">= 20"), fn.index("creative_platform_reserve"))
        self.assertIn("frame_height = frame_h, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, "
                      "credit_ref = ref", fn)
        # The caller's number is only ever compared, with the CHARGE: the hold is the database's charge raised to job_minimum.
        self.assertEqual(fn.count("p_max_credits"), 4)   # the null check, the finite range, the comparison, and the refusal's detail
        self.assertIn("price > p_max_credits", fn)
        self.assertNotIn("hold_c > p_max_credits", fn)
        self.assertNotRegex(fn, r"reserve\([^)]*(p_max_credits|price)")
        # One lock order in all three overloads (0054's): the project's row, then the organization's advisory lock. A paid request
        # that took them the other way round deadlocked against a free one of the same project (40P01, reproduced in review).
        self.assertNotIn("for no key update", fn)
        for head in (REQ2, REQ3, REQ4):
            f = " ".join(body(func(CODE, head)).split())
            self.assertEqual(f.count("from public.editor_projects where id = p_project for update;"), 1, head)
            self.assertEqual(f.count("pg_advisory_xact_lock("), 1, head)
            self.assertLess(f.index("for update;"), f.index("pg_advisory_xact_lock("), head)
            # The revision is checked under the row lock (after it, before the advisory lock and the insert).
            self.assertLess(f.index("for update;"), f.index("p_rev <> p.rev"), head)
            self.assertLess(f.index("p_rev <> p.rev"), f.index("pg_advisory_xact_lock("), head)

    def test_the_overload_has_no_defaults_and_a_fixed_search_path(self):
        fn = func(CODE, REQ4)
        self.assertNotIn(" default ", fn.split("language", 1)[0])
        self.assertIn("language plpgsql volatile security definer set search_path = public, pg_temp as $$", fn)

    def test_the_older_functions_are_their_bodies_plus_only_the_refusal_above_1080p(self):
        for head, older, added in (
                (REQ2, SQL054, [
                    "if jsonb_typeof(p.doc -> 'width') = 'number' and jsonb_typeof(p.doc -> 'height') = 'number'   -- 0132",
                    "and (p.doc ->> 'width')::numeric * (p.doc ->> 'height')::numeric > 2073600 then   -- 0132",
                    "raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0132",
                    "end if;   -- 0132"]),
                (REQ3, SQL129, [
                    "if frame_w::bigint * frame_h > 2073600 then   -- 0132",
                    "raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0132",
                    "end if;   -- 0132"])):
            mine = body(func(SQL, head))
            self.assertEqual(without_the_marked_lines(mine).splitlines(), body(func(older, head)).splitlines(), head)
            code = [ln.strip() for ln in mine.splitlines() if MARK in ln and not ln.strip().startswith("--")]
            self.assertEqual(code, added, head)
            # The refusal comes before the organization's lock and its limits: a refused export counts nothing.
            fn = " ".join(body(func(CODE, head)).split())
            self.assertLess(fn.index("raise exception 'hires_needs_paid_export'"), fn.index("pg_advisory_xact_lock"))
            # The rollback puts the older body back, byte for byte.
            self.assertEqual(func(ROLLBACK, head), func(older, head), head)
        self.assertNotRegex(CODE, r"(revoke|grant)[^;]*request_editor_export\(uuid, integer(, text)?\)")
        self.assertNotRegex(CODE, r"drop function")
        for name in ("claim_editor_export", "finish_editor_export", "editor_export_assets", "editor_export_heartbeat",
                     "delete_editor_project", "save_editor_project", "create_editor_project", "editor_doc_problem", "editor_doc_duration",
                     "reserve_credits", "capture_credits", "release_credits", "start_credit_reservation", "creative_platform_reserve"):
            self.assertNotRegex(CODE, rf"create or replace function public\.{name}\(", name)


class TheMoney(unittest.TestCase):
    def test_the_prices_are_seeded_null_and_no_number_in_the_file_sets_one(self):
        self.assertIn("insert into public.editor_export_hires_prices (id) values (true) on conflict (id) do nothing;", CODE)
        self.assertEqual(CODE.count("insert into public.editor_export_hires_prices"), 1)
        self.assertNotRegex(CODE, r"update public\.editor_export_hires_prices")
        for col in ("credits_per_minute_1440p", "credits_per_minute_2160p"):
            self.assertRegex(CODE, rf"{col}\s+numeric\(10,2\),")    # nullable, no default
            self.assertNotRegex(CODE, rf"{col}\s+numeric\(10,2\)\s+(not null|default)")

    def test_the_price_table_is_closed_to_every_api_role_and_its_changes_leave_a_mark(self):
        self.assertIn("alter table public.editor_export_hires_prices enable row level security;", CODE)
        self.assertIn("revoke all on public.editor_export_hires_prices from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant [a-z, ]+ on (table )?public\.editor_export_hires_prices")
        self.assertNotRegex(CODE, r"create policy")
        trail = body(func(SQL, *HEADS["trail"]))
        self.assertIn("public.security_event_log('editor.export.hires_price', 'warning'", trail)
        self.assertIn("exception when others then", trail)   # a failing trail never blocks the owner from stopping sales

    def test_only_the_quote_and_the_paid_overload_are_granted_and_only_to_authenticated(self):
        grants = re.findall(r"grant execute on function public\.(\w+)\(([^)]*)\) to ([a-z_, ]+);", CODE)
        self.assertEqual(sorted((n, a.replace(" ", ""), r) for n, a, r in grants),
                         [("quote_editor_export", "uuid,integer,text", "authenticated"),
                          ("request_editor_export", "uuid,integer,text,numeric", "authenticated")])
        for fn in ("editor_export_frame(text)", "editor_export_hires_terms(integer, integer, numeric)", "editor_export_money(text, text, numeric)",
                   "editor_export_settle()", "editor_export_hires_prices_guard()", "editor_export_hires_prices_trail()",
                   "quote_editor_export(uuid, integer, text)", "request_editor_export(uuid, integer, text, numeric)"):
            self.assertIn(f"revoke all on function public.{fn} from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant (select|insert|update|delete|all)\b")
        self.assertNotRegex(CODE, r"\bto (anon|public|service_role)\b")

    def test_every_ending_settles_through_the_one_trigger(self):
        settle = " ".join(body(func(CODE, *HEADS["settle"])).split())
        self.assertIn("if new.credit_ref is null or new.status is not distinct from old.status then return new;", settle)
        self.assertIn("if old.status = 'queued' and new.status = 'rendering' then", settle)
        self.assertIn("new.reason := 'credits_released';", settle)
        self.assertIn("new.charged_credits := public.editor_export_money('capture', new.credit_ref, new.quoted_credits);", settle)
        self.assertIn("perform public.editor_export_money('release', new.credit_ref, null);", settle)
        # A done row marked failed by hand keeps its charge (the hold was captured; nothing is released).
        self.assertIn("if old.status = 'done' then new.charged_credits := old.charged_credits; else perform", settle)
        self.assertIn("create trigger editor_exports_settle before update of status on public.editor_exports for each row execute function "
                      "public.editor_export_settle();", " ".join(CODE.split()))
        money = " ".join(body(func(CODE, *HEADS["money"])).split())
        # As the platform, and the caller's claims always put back.
        self.assertEqual(money.count("perform set_config('request.jwt.claims', coalesce(saved, ''), true);"), 2)
        self.assertIn("perform set_config('request.jwt.claims', '', true);", money)
        for call in ("public.start_credit_reservation(p_ref, org)", "public.capture_credits(p_ref, p_amount, false)", "public.release_credits(p_ref)"):
            self.assertIn(call, money)

    def test_the_check_holds_a_paid_frame_to_its_quote_its_cap_and_its_rate(self):
        check = " ".join(CODE.split("add constraint editor_exports_hires_terms check (", 1)[1].split(";", 1)[0].split())
        self.assertIn(f"frame_width * frame_height <= {hires_export.FREE_MAX_PX}", check)
        self.assertIn(f"duration_s <= case when frame_width * frame_height <= {hires_export.TIER_1440P_MAX_PX} then "
                      f"{hires_export.MAX_S['1440p']:g} else {hires_export.MAX_S['2160p']:g} end", check)
        self.assertIn("credit_ref = 'ee:' || id::text", check)
        self.assertIn(f"when jsonb_typeof(doc -> 'fps') = 'number' then (doc ->> 'fps')::numeric <= {hires_export.MAX_FPS['2160p']}", check)
        self.assertIn("charged_credits <= quoted_credits", check)
        self.assertIn("(credit_ref is null or held_credits is not null)", check)
        self.assertIn("(held_credits is null or (credit_ref is not null and held_credits >= quoted_credits))", check)
        shape = " ".join(CODE.split("add constraint editor_exports_frame_shape check (", 1)[1].split(";", 1)[0].split())
        self.assertIn(f"frame_width * frame_height <= {hires_export.TIER_2160P_MAX_PX}", shape)


class TheClosedListAndTheCaps(unittest.TestCase):
    def rows(self, text):
        fn = func(text, LIST, "language sql")
        return [(i, int(w), int(h)) for i, w, h in re.findall(r"\('([a-z0-9_]+)', (\d+), (\d+)\)", body(fn))]

    def test_it_is_the_presets_file_id_for_id_and_its_first_five_are_0129s(self):
        data = json.loads((ROOT / "schemas" / "export_presets.json").read_text(encoding="utf-8"))
        self.assertEqual(self.rows(CODE), [(p["id"], p["width"], p["height"]) for p in data["presets"]])
        self.assertEqual(self.rows(CODE), [(p.id, p.width, p.height) for p in export_presets.load().values()])
        self.assertEqual(self.rows(CODE)[:5], self.rows("\n".join(ln.split("--", 1)[0] for ln in SQL129.splitlines())))
        self.assertEqual([r[0] for r in self.rows(CODE)[5:]], ["youtube_1440p", "vertical_1440p", "youtube_2160p", "vertical_2160p"])
        # The rollback puts 0129's five back, byte for byte.
        self.assertEqual(func(ROLLBACK, LIST, "language sql"), func(SQL129, LIST, "language sql"))

    def test_the_tiers_and_caps_are_one_set_of_numbers_in_sql_python_and_typescript(self):
        terms = " ".join(body(func(CODE, *HEADS["terms"])).split())
        self.assertIn(f"if px is null or px <= {hires_export.FREE_MAX_PX} then", terms)
        self.assertIn(f"if px <= {hires_export.TIER_1440P_MAX_PX} then tier := '1440p'; max_s := {hires_export.MAX_S['1440p']:g}; "
                      f"max_fps := {hires_export.MAX_FPS['1440p']};", terms)
        self.assertIn(f"tier := '2160p'; max_s := {hires_export.MAX_S['2160p']:g}; max_fps := {hires_export.MAX_FPS['2160p']};", terms)
        self.assertIn("ceil(greatest(coalesce(p_duration, 0), 0) / 60.0)", terms)   # a STARTED minute
        # The charge has no floor; the hold is the charge raised to job_minimum (0133's rule).
        self.assertIn("credits := public.credits_round_up(cpm * minutes);", terms)
        self.assertIn("hold := greatest(credits, coalesce(public.credits_round_up(floor_c), 0));", terms)
        self.assertNotRegex(terms, r"credits := [^;]*floor_c")
        ts = (CC / "lib" / "hiresExport" / "limits.ts").read_text(encoding="utf-8")
        self.assertIn("export const FREE_MAX_PX = 1920 * 1080;", ts)
        self.assertEqual(hires_export.FREE_MAX_PX, 1920 * 1080)
        self.assertIn("export const TIER_1440P_MAX_PX = 2560 * 1440;", ts)
        self.assertEqual(hires_export.TIER_1440P_MAX_PX, 2560 * 1440)
        self.assertIn("export const TIER_2160P_MAX_PX = 3840 * 2160;", ts)
        self.assertEqual(hires_export.TIER_2160P_MAX_PX, 3840 * 2160)
        fps = re.search(r"HIRES_MAX_FPS: Readonly<Record<HiresTier, number>> = \{ \"1440p\": (\d+), \"2160p\": (\d+) \}", ts)
        self.assertEqual((int(fps.group(1)), int(fps.group(2))), (hires_export.MAX_FPS["1440p"], hires_export.MAX_FPS["2160p"]))
        caps = re.search(r"HIRES_MAX_S: Readonly<Record<HiresTier, number>> = \{ \"1440p\": (\d+), \"2160p\": (\d+) \}", ts)
        self.assertEqual((float(caps.group(1)), float(caps.group(2))), (hires_export.MAX_S["1440p"], hires_export.MAX_S["2160p"]))
        ts_presets = re.findall(r'\{ id: "([a-z0-9_]+)", width: (\d+), height: (\d+), fps: (\d+), maxDurationS: (\d+) \}',
                                ts.split("HIRES_EXPORT_PRESETS", 1)[1].split("] as const", 1)[0])
        self.assertEqual([(i, int(w), int(h), int(f), float(m)) for i, w, h, f, m in ts_presets],
                         [(p.id, p.width, p.height, p.fps, p.max_duration_s) for p in export_presets.load().values() if export_presets.is_paid(p)])

    def test_the_cap_holds_under_the_export_and_the_time_budget_holds_under_its_ceiling(self):
        for t, cap in hires_export.MAX_S.items():
            self.assertLessEqual(cap, editor_export.EXPORT_MAX_S)
            self.assertLess(hires_export.RENDER_TIMEOUT_PER_S[t] * cap + hires_export.RENDER_TIMEOUT_BASE_S, hires_export.RENDER_TIMEOUT_MAX_S)


class TheFile(unittest.TestCase):
    def test_the_hashes_in_the_files_are_the_bodies(self):
        h = hashes()
        self.assertEqual(len(set(h.values())), len(h))
        found = set(re.findall(r"'([0-9a-f]{32})'", CODE))
        self.assertEqual(found, set(h.values()) | {REQ2_HASH, REQ3_HASH, LIST129_HASH})
        # The drift guard and the end state each carry every new body (the replaced ones in the guard's pair with their older body).
        for k, v in h.items():
            self.assertEqual(CODE.count(f"'{v}'"), 2, k)
        for old in (REQ2_HASH, REQ3_HASH, LIST129_HASH):
            self.assertEqual(CODE.count(f"'{old}'"), 1, old)
        for k in ("req2", "req3", "list"):
            self.assertIn(h[k], SQL.split("set local lock_timeout", 1)[0], k)          # the header's "expected AFTER"
        self.assertEqual(set(re.findall(r"'([0-9a-f]{32})'", ROLLBACK)), set(h.values()) | {REQ2_HASH, REQ3_HASH, LIST129_HASH})

    def test_the_older_hashes_are_the_older_files_bodies(self):
        self.assertEqual(md5_of_body(func(SQL054, REQ2)), REQ2_HASH)
        self.assertEqual(md5_of_body(func(SQL129, REQ3)), REQ3_HASH)
        self.assertEqual(md5_of_body(func(SQL129, LIST, "language sql")), LIST129_HASH)

    def test_it_refuses_a_body_it_has_not_seen_before_it_changes_anything(self):
        guard = CODE.split("alter table public.editor_exports add column", 1)[0]
        self.assertIn(f"if h <> all (array['{REQ2_HASH}', '{hashes()['req2']}']) then", guard)
        self.assertIn(f"if h <> all (array['{REQ3_HASH}', '{hashes()['req3']}']) then", guard)
        self.assertIn(f"if h <> all (array['{LIST129_HASH}', '{hashes()['list']}']) then", guard)
        self.assertIn("if h is not null and h <> want then", guard)
        self.assertNotIn("create or replace", guard)
        self.assertNotRegex(guard, r"\b(alter|drop|insert|update|grant|revoke)\b")

    def test_it_is_one_transaction_idempotent_and_asserts_its_end(self):
        self.assertNotRegex(CODE, r"(?m)^(begin|commit);")
        self.assertIn("set local lock_timeout = '5s';", CODE)
        for marker in ("APPLY AS ONE TRANSACTION", "WHAT TO VERIFY BEFORE YOU APPLY", "-- Verify (run after applying; every column should read true)"):
            self.assertIn(marker, SQL)
        for col in ("quoted_credits numeric(12,2)", "held_credits numeric(12,2)", "credit_ref text", "charged_credits numeric(12,2)"):
            self.assertIn(f"alter table public.editor_exports add column if not exists {col};", CODE)
        end = CODE.rsplit("do $$", 1)[1]
        self.assertGreaterEqual(end.count("raise exception '0132 end state:"), 15)
        for word in ("<> 3 then", "has_function_privilege(role_name, req4, 'EXECUTE')", "relrowsecurity", "pg_policy",
                     "editor_exports_settle", "'vertical_2160p'", "convalidated"):
            self.assertIn(word, end, word)

    def test_it_is_the_next_number_and_nothing_after_it_redefines_its_functions(self):
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0132"), 1)
        self.assertEqual(max(n for n in numbers if n < "0132"), "0131")
        for p in sorted(MIG.glob("*.sql")):
            if p.name[:4] > "0132":
                text = p.read_text(encoding="utf-8")
                for name in ("request_editor_export(", "editor_export_frame(", "quote_editor_export(", "editor_export_settle("):
                    self.assertNotIn(f"function public.{name}", text, p.name)

    def test_the_rollback_refuses_before_it_changes_anything_and_is_one_transaction(self):
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)
        guard = ROLLBACK.split("-- 1. What 0132 added.", 1)[0]
        self.assertIn("a paid export is still queued or rendering and holds credits", guard)
        self.assertIn("lock table public.editor_exports in share row exclusive mode;", guard)
        self.assertNotRegex(guard.split("begin;", 1)[1], r"\bdrop\b")
        rest = ROLLBACK.split("-- 1. What 0132 added.", 1)[1].split("-- 4. End state.", 1)[0]
        # The statements the rollback runs, without the bodies of the functions it puts back (0129's has its own update of its own row).
        statements = re.sub(r"create or replace function .*?\n\$\$;", "", rest, flags=re.S)
        for never in ("media_assets", "delete from", "truncate", "update public.editor_exports", "credit_transactions"):
            self.assertNotIn(never, statements, never)


class TheSwitchHasOneName(unittest.TestCase):
    def test_worker_web_env_examples_and_the_workflow_agree(self):
        self.assertEqual(hires_export.FLAG, "NIGHTSHIFT_HIRES_EXPORT")
        flag = (CC / "lib" / "hiresExport" / "flag.ts").read_text(encoding="utf-8")
        self.assertIn('export const HIRES_EXPORT_FLAG = "NIGHTSHIFT_HIRES_EXPORT";', flag)
        self.assertIn("process.env.NIGHTSHIFT_HIRES_EXPORT", flag)
        self.assertNotIn("NEXT_PUBLIC", flag.split("*/", 1)[1])
        for example in ("deploy/.env.web.example", "deploy/.env.worker.example"):
            self.assertRegex((ROOT / example).read_text(encoding="utf-8"), r"(?m)^NIGHTSHIFT_HIRES_EXPORT=$", "empty must mean off")
        flow = (ROOT / ".github" / "workflows" / "deploy_web.yml").read_text(encoding="utf-8")
        self.assertIn("WEBENV_NIGHTSHIFT_HIRES_EXPORT: ${{ vars.NIGHTSHIFT_HIRES_EXPORT }}", flow)
        self.assertIn("WORKERENV_NIGHTSHIFT_HIRES_EXPORT: ${{ vars.NIGHTSHIFT_HIRES_EXPORT }}", flow)

    def test_the_command_center_sends_a_confirmed_number_only_to_the_paid_overload(self):
        route = (CC / "app" / "api" / "editor" / "projects" / "[id]" / "exports" / "route.ts").read_text(encoding="utf-8")
        calls = re.findall(r'rpc\(\s*"request_editor_export",\s*\{(.*?)\}\s*,?\s*\)', route, re.S)
        names = sorted(sorted(re.findall(r"\b(p_[a-z_]+)\b", c)) for c in calls)
        self.assertEqual(names, [["p_frame", "p_max_credits", "p_project", "p_rev"], ["p_frame", "p_project", "p_rev"],
                                 ["p_project", "p_rev"], ["p_project", "p_rev"]])
        quote = (CC / "app" / "api" / "editor" / "projects" / "[id]" / "exports" / "quote" / "route.ts").read_text(encoding="utf-8")
        self.assertIn('supabase.rpc("quote_editor_export"', quote)
        for text in (route, quote):
            for word in ("SERVICE_ROLE", "service_role", "reserve_credits", "capture_credits", "release_credits", "NEXT_PUBLIC_"):
                self.assertNotIn(word, text)

    def test_every_new_reason_and_refusal_has_a_sentence_in_three_languages(self):
        editor = (CC / "lib" / "editor.ts").read_text(encoding="utf-8")
        for word in editor_export.REASONS:
            self.assertIn(f'"{word}"', editor.split("export const EXPORT_REASONS", 1)[1].split("] as const", 1)[0])
        for word in ("not_on_sale", "price_changed", "insufficient_credits", "hires_too_long", "quote_required", "parallel_runs", "hires_fps",
                     "hires_speed_curve", "hires_needs_paid_export"):
            self.assertIn(f'"{word}"', editor.split("export const EDITOR_ERRORS", 1)[1].split("] as const", 1)[0])
        for lang in ("en", "ru", "uz"):
            text = (CC / "lib" / "i18n" / f"{lang}.ts").read_text(encoding="utf-8")
            reasons = text.split("exportReasons: {", 1)[1].split("},", 1)[0]
            for word in ("hires_off", "credits_released", "hires_fps", "hires_needs_paid_export", "hires_speed_curve", "hires_length_mismatch"):
                self.assertRegex(reasons, rf'(?m)^\s+{word}:\s*\n?\s*"', f"{lang}: {word}")
            self.assertIn(f"exportHires: exportHires{lang.capitalize()},", text)


if __name__ == "__main__":
    unittest.main()
