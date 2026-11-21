"""Migration 0136 (exports up to 1080p sold by the started minute), pinned from the file. SQL does not run here; the security lab runs it
(tests/security/test_sec_editor_export_paid_1080p.py). What this pins:

  * the three request functions are 0132's bodies BYTE FOR BYTE except for the lines marked 0136 (additions, plus replaced lines whose
    originals are written next to them): no gate of 0054 / 0129 / 0132 moved, and every overload keeps 0054's lock order;
  * the two- and three-argument functions only ADD the refusal while the price is set (export_needs_quote), after every older gate and
    before the organization's lock;
  * the price is a nullable column of 0132's row, seeded by nobody (no number in the file sets it), and NULL means free;
  * the charge is the price x the started minutes with no floor and the hold is the charge raised to job_minimum (0132's formula, now also
    for the 1080p tier);
  * the hashes in the file and its rollback are the bodies; the drift guard accepts 0132's body or the file's own; the rollback puts
    0132's bodies back byte for byte;
  * the new refusal word has a sentence in three languages.
"""

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
SQL = (MIG / "0136_editor_export_paid_1080p.sql").read_text(encoding="utf-8")
SQL132 = (MIG / "0132_editor_hires_export.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0136_editor_export_paid_1080p.sql").read_text(encoding="utf-8")
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
CC = ROOT / "command-center"

REQ2 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer) returns uuid"
REQ3 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text) returns uuid"
REQ4 = "create or replace function public.request_editor_export(p_project uuid, p_rev integer, p_frame text, p_max_credits numeric) returns uuid"
QUOTE = "create or replace function public.quote_editor_export(p_project uuid, p_rev integer, p_frame text) returns jsonb"
TERMS = "create or replace function public.editor_export_hires_terms(p_width integer, p_height integer, p_duration numeric)"
TRAIL = "create or replace function public.editor_export_hires_prices_trail() returns trigger"
PRICE = "create or replace function public.editor_export_price_1080p() returns numeric"
MS = "create or replace function public.editor_ms(p double precision) returns double precision"
JNUM = "create or replace function public.editor_jnum(p jsonb) returns double precision"
LENGTH = "create or replace function public.editor_doc_rendered_length(p_doc jsonb) returns numeric"
MARK = "0136"
REPLACES = "-- 0136 replaces: "
NEEDS_QUOTE = [
    "if public.editor_export_price_1080p() is not null then   -- 0136",
    "raise exception 'export_needs_quote' using errcode = 'NS409', detail = 'exports up to 1080p are sold: ask the price and confirm it';   -- 0136",
    "end if;   -- 0136",
]


def func(text: str, head: str) -> str:
    assert text.count(head) == 1, head
    i = text.index(head)
    a = text.index("as $$", i)
    return text[i:text.index("\n$$;", a) + 4]


def body(fn: str) -> str:
    a = fn.index("$$") + 2
    return fn[a:fn.rindex("$$")]


def md5_of_body(fn: str) -> str:
    return hashlib.md5(re.sub(r"\s+", " ", body(fn)).encode()).hexdigest()


def without_the_marked_lines(mine: str) -> str:
    kept = []
    for line in mine.splitlines():
        if REPLACES in line:
            indent = line[:len(line) - len(line.lstrip())]
            kept.append(indent + line.split(REPLACES, 1)[1])
        elif MARK not in line:
            kept.append(line)
    return "\n".join(kept)


def code_lines(fn: str):
    return [ln.strip() for ln in body(fn).splitlines() if MARK in ln and not ln.strip().startswith("--")]


def pinned_132(name: str) -> str:
    return re.search(rf"oid = {name}\) <> '([0-9a-f]{{32}})'", SQL132).group(1)


class TheRequestFunctionsAre0132sPlusMarkedLines(unittest.TestCase):
    def test_each_body_is_0132s_once_the_marked_lines_are_taken_out(self):
        for head in (REQ2, REQ3, REQ4):
            mine = body(func(SQL, head))
            self.assertEqual(without_the_marked_lines(mine).splitlines(), body(func(SQL132, head)).splitlines(), head)
            self.assertNotEqual(mine.splitlines(), body(func(SQL132, head)).splitlines(), head)

    def test_the_two_older_ones_only_add_the_refusal_while_sold(self):
        for head in (REQ2, REQ3):
            self.assertEqual(code_lines(func(SQL, head)), NEEDS_QUOTE, head)
            fn = " ".join(body(func(CODE, head)).split())
            # After every older gate (membership, revision, the document, above 1080p), before the organization's lock and the insert.
            for earlier in ("p_rev <> p.rev", "raise exception 'hires_needs_paid_export'"):
                self.assertLess(fn.index(earlier), fn.index("raise exception 'export_needs_quote'"), (head, earlier))
            self.assertLess(fn.index("raise exception 'export_needs_quote'"), fn.index("pg_advisory_xact_lock"), head)
            self.assertNotIn("reserve", fn)

    def test_the_paid_overload_adds_the_own_frame_and_the_1080p_tier_only(self):
        code = code_lines(func(SQL, REQ4))
        self.assertEqual(code, [
            "own      boolean := p_frame = 'project';   -- 0136",
            "if own and jsonb_typeof(p.doc -> 'width') = 'number' and jsonb_typeof(p.doc -> 'height') = 'number'   -- 0136",
            "and p.doc ->> 'width' ~ '^[1-9][0-9]{0,4}$' and p.doc ->> 'height' ~ '^[1-9][0-9]{0,4}$' then   -- 0136",
            "frame_w := (p.doc ->> 'width')::integer;   -- 0136",
            "frame_h := (p.doc ->> 'height')::integer;   -- 0136",
            "if frame_w::bigint * frame_h > 2073600 then   -- 0136",
            "raise exception 'hires_needs_paid_export' using errcode = 'NS400', detail = 'max_px=2073600';   -- 0136",
            "end if;   -- 0136",
            "elsif frame_id is null then   -- 0136 replaces: if frame_id is null then   -- 0129",
            "if frame_w::bigint * frame_h <= 2073600 and public.editor_export_price_1080p() is null then   -- 0136 replaces: "
            "if frame_w::bigint * frame_h <= 2073600 then   -- 0132",
            "total := public.editor_doc_rendered_length(p.doc);   -- 0136 replaces: total := public.editor_doc_duration(p.doc);",
            "set frame_preset = frame_id, frame_width = case when own then null else frame_w end, frame_height = case when own then null "
            "else frame_h end, quoted_credits = price, held_credits = case when ref is null then null else hold_c end, credit_ref = ref   "
            "-- 0136 replaces: set frame_preset = frame_id, frame_width = frame_w, frame_height = frame_h, quoted_credits = price, "
            "held_credits = case when ref is null then null else hold_c end, credit_ref = ref   -- 0132 replaces: set frame_preset = "
            "frame_id, frame_width = frame_w, frame_height = frame_h   -- 0129",
        ])
        fn = " ".join(body(func(CODE, REQ4)).split())
        # A speed curve is sold at its rendered length: 0132's refusal is gone from the code (kept, commented, for this pin test).
        self.assertNotIn("hires_speed_curve", fn)
        self.assertNotIn("editor_doc_duration", fn)
        self.assertEqual(fn.count("public.editor_doc_rendered_length(p.doc)"), 1)
        # The caller's number is compared with the CHARGE; the hold is the database's (unchanged 0132 lines).
        self.assertIn("price > p_max_credits", fn)
        self.assertIn("public.creative_platform_reserve(p.org_id, ref, hold_c)", fn)

    def test_one_lock_order_in_every_overload(self):
        for head in (REQ2, REQ3, REQ4):
            fn = " ".join(body(func(CODE, head)).split())
            self.assertEqual(fn.count("from public.editor_projects where id = p_project for update;"), 1, head)
            self.assertEqual(fn.count("pg_advisory_xact_lock("), 1, head)
            self.assertNotIn("for no key update", fn)
            self.assertLess(fn.index("for update;"), fn.index("p_rev <> p.rev"), head)
            self.assertLess(fn.index("p_rev <> p.rev"), fn.index("pg_advisory_xact_lock("), head)


class ThePriceAndTheTerms(unittest.TestCase):
    def test_the_price_is_a_nullable_column_nobody_in_this_file_sets(self):
        self.assertIn("alter table public.editor_export_hires_prices add column if not exists credits_per_minute_1080p numeric(10,2);", CODE)
        self.assertNotRegex(CODE, r"update public\.editor_export_hires_prices")
        self.assertNotRegex(CODE, r"insert into public\.editor_export_hires_prices")
        self.assertIn("(credits_per_minute_1080p is null or credits_per_minute_1080p between 0.01 and 10000)", CODE)
        price = " ".join(body(func(CODE, PRICE)).split())
        self.assertEqual(price, "select s.credits_per_minute_1080p from public.editor_export_hires_prices s where s.id")
        self.assertIn("language sql stable set search_path = public, pg_temp as $$", func(CODE, PRICE))
        self.assertIn("revoke all on function public.editor_export_price_1080p() from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant [^;]*editor_export_price_1080p")

    def test_up_to_1080p_is_free_while_null_and_a_tier_with_0132s_charge_and_hold_while_set(self):
        terms = " ".join(body(func(CODE, TERMS)).split())
        self.assertIn("if px <= 2073600 then select s.credits_per_minute_1080p into cpm from public.editor_export_hires_prices s where s.id; "
                      "if cpm is null then return jsonb_build_object('paid', false); end if; tier := '1080p'; max_s := 1800;", terms)
        self.assertIn("credits := public.credits_round_up(cpm * minutes);", terms)
        self.assertIn("hold := greatest(credits, coalesce(public.credits_round_up(floor_c), 0));", terms)
        # Above 1080p: 0132's lines, unchanged.
        old = " ".join(body(func(SQL132, TERMS)).split())
        self.assertIn(old.split("if px <= 3686400 then", 1)[1], terms.split("elsif px <= 3686400 then", 1)[1])

    def test_the_quote_reads_the_own_frame_and_the_length_as_the_request_does(self):
        q = " ".join(body(func(CODE, QUOTE)).split())
        self.assertIn("total := public.editor_doc_rendered_length(p.doc);", q)
        self.assertIn("'curve_sold', true,", q)
        self.assertNotIn("editor_doc_duration", q)
        self.assertIn("own boolean := p_frame = 'project';", q)
        self.assertIn("frame_id := 'project';", q)
        self.assertIn("raise exception 'hires_needs_paid_export'", q)

    def test_the_trail_logs_all_three_prices(self):
        trail = body(func(CODE, TRAIL))
        for col in ("credits_per_minute_1440p", "credits_per_minute_2160p", "credits_per_minute_1080p"):
            self.assertIn(f"new.{col} is distinct from old.{col}", trail)
            self.assertIn(f"'{col}', jsonb_build_array(old.{col}, new.{col})", trail)


class TheRenderedLength(unittest.TestCase):
    """The parity itself runs in the lab (tests/security/test_sec_editor_rendered_length.py, 2000+ seeded documents). Pinned here:
    the pieces that must be the renderer's, written as the renderer writes them."""

    def test_it_mirrors_speed_ramp_and_timeline_piece_for_piece(self):
        ln = " ".join(body(func(CODE, LENGTH)).split())
        for piece in (
            "if abs(s1 - s0) <= 1e-7::double precision * least(s0, s1) then acc := acc + (t1 - t0) / s0;",   # speed_ramp._flat
            "else acc := acc + (t1 - t0) / (s1 - s0) * ln(s1 / s0);",                                          # speed_ramp._piece_length
            "t0 := public.editor_ms(ats[j]) * rng;", "s0 := public.editor_ms(sps[j]);",                           # normalise + absolute
            "len := public.editor_ms(acc);",                                                                    # clip_length_s
            "len := public.editor_ms(rng / sp);", "e := public.editor_ms(st + len);",                            # clip_end_s
            "rng := o_ - i_;",
        ):
            self.assertIn(piece, ln)
        from modules import speed_ramp
        self.assertEqual(speed_ramp._FLAT, 1e-7)
        ms = " ".join(body(func(CODE, MS)).split())
        # Half to even on the exact value (Python's round(x, 3)), and back through text (correctly rounded).
        self.assertIn("if r * 2 > d or (r * 2 = d and mod(q, 2) = 1) then q := q + 1; end if;", ms)
        self.assertIn("::text::double precision", ms)

    def test_the_renderers_curve_rules_are_the_refusal(self):
        from modules import timeline as tl
        ln = " ".join(body(func(CODE, LENGTH)).split())
        self.assertEqual((tl.RAMP_MIN_POINTS, tl.RAMP_MAX_POINTS, tl.RAMP_MIN_GAP), (2, 6, 0.01))
        self.assertEqual((tl.RAMP_SPEED_MIN, tl.RAMP_SPEED_MAX), (0.25, 4.0))
        self.assertIn("not between 2 and 6", ln)
        self.assertIn("s < 0.25 or s > 4.0", ln)
        self.assertIn("< 0.01::double precision - 1e-12::double precision", ln)
        self.assertGreaterEqual(ln.count("raise exception 'invalid_speed_curve' using errcode = 'NS400';"), 4)

    def test_the_renderer_adds_the_pieces_left_to_right(self):
        src = (ROOT / "modules" / "speed_ramp.py").read_text(encoding="utf-8")
        fn = src.split("def out_length", 1)[1].split("\ndef ", 1)[0]
        self.assertNotIn("sum(_piece_length", fn)
        self.assertNotIn("return sum", fn)
        self.assertIn("acc += _piece_length(a[0], a[1], b[0], b[1])", fn)


class TheFile(unittest.TestCase):
    HEADS = {"req2": REQ2, "req3": REQ3, "req4": REQ4, "quote": QUOTE, "terms": TERMS, "trail": TRAIL, "price": PRICE, "ms": MS,
             "jnum": JNUM, "length": LENGTH}

    def test_the_hashes_in_the_file_are_the_bodies_and_the_guard_knows_0132s(self):
        h = {k: md5_of_body(func(SQL, v)) for k, v in self.HEADS.items()}
        self.assertEqual(len(set(h.values())), len(h))
        guard = CODE.split("alter table public.editor_export_hires_prices add column", 1)[0]
        end = CODE.rsplit("do $$", 1)[1]
        for k in ("req2", "req3", "req4", "quote", "terms", "trail"):
            self.assertIn(f"'{pinned_132(k)}', '{h[k]}']", guard, k)
            self.assertIn(f"'{h[k]}']", end, k)
        for k in ("price", "ms", "jnum", "length"):
            self.assertIn(f"'{h[k]}', '']", guard, k)
            self.assertIn(f"'{h[k]}']", end, k)
        for k in ("money", "settle", "guard", "lst"):
            self.assertIn(f"'{pinned_132(k)}', '']", guard, k)
            self.assertIn(f"'{pinned_132(k)}']", end, k)
        self.assertNotIn("create or replace", guard)
        self.assertNotRegex(guard, r"\b(alter|drop|insert|update|grant|revoke)\b")

    def test_the_rollback_puts_0132s_bodies_back_byte_for_byte(self):
        for head in (REQ2, REQ3, REQ4, QUOTE, TERMS, TRAIL):
            self.assertEqual(func(ROLLBACK, head), func(SQL132, head), head)
        guard = ROLLBACK.split("-- 1. 0132's bodies", 1)[0]
        for k, head in self.HEADS.items():
            self.assertIn(f"'{md5_of_body(func(SQL, head))}']", guard, k)
        self.assertIn("drop function public.editor_export_price_1080p();", ROLLBACK)
        for fn in ("editor_doc_rendered_length(jsonb)", "editor_jnum(jsonb)", "editor_ms(double precision)"):
            self.assertIn(f"drop function public.{fn};", ROLLBACK)
        self.assertIn("drop column if exists credits_per_minute_1080p", ROLLBACK)
        self.assertRegex(ROLLBACK, r"(?m)^begin;$")
        self.assertEqual(len(re.findall(r"(?m)^commit;$", ROLLBACK)), 1)

    def test_it_is_one_transaction_and_its_number_is_its_own(self):
        self.assertNotRegex(CODE, r"(?m)^(begin|commit);")
        self.assertIn("set local lock_timeout = '5s';", CODE)
        self.assertIn("APPLY AS ONE TRANSACTION", SQL)
        numbers = sorted(p.name[:4] for p in MIG.glob("*.sql"))
        self.assertEqual(numbers.count("0136"), 1)
        for n in ("0134", "0135"):
            self.assertNotIn(f"{n}_editor", " ".join(p.name for p in MIG.glob("*.sql")))   # reserved by other work, not this file's
        for p in sorted(MIG.glob("*.sql")):
            if p.name[:4] > "0136":
                self.assertNotIn("function public.request_editor_export(", p.read_text(encoding="utf-8"), p.name)

    def test_the_new_word_has_a_sentence_in_three_languages(self):
        editor = (CC / "lib" / "editor.ts").read_text(encoding="utf-8")
        self.assertIn('"export_needs_quote"', editor.split("export const EDITOR_ERRORS", 1)[1].split("] as const", 1)[0])
        self.assertIn('export_needs_quote: "export_needs_quote"', editor)
        for lang in ("en", "ru", "uz"):
            text = (CC / "lib" / "i18n" / f"{lang}.ts").read_text(encoding="utf-8")
            self.assertRegex(text, r'(?m)^\s+export_needs_quote:\s*\n?\s*"', lang)


if __name__ == "__main__":
    unittest.main()
