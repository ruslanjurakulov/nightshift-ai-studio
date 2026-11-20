"""Migration 0199 (the adult attestation: an append-only answer per person, and a gate on it), pinned as text.

What would break, and which test says so:

* a replaced body drifting from the one it was built on (a price, hold, route order or refusal silently altered): each of the
  five is the earlier body plus inserted, marked 0199 blocks, and nothing deleted or changed;
* the gate moving after the ceiling, the hold or the job row (rule 6), or before an idempotent replay is answered;
* the router refusing a whole route when another model remains, or ranking differently (only inserts, no ORDER BY changed);
* a requires_adult model hidden from the list instead of marked (we never pretend a model does not exist);
* the answer becoming editable, writable by an API role, readable by another person, or a second call flipping it;
* the record bound to anything but the session (auth.uid()), or given a foreign key that a deleted account would cascade;
* a flag of another shape read as "not required";
* md5 pins that no longer describe the files, a rollback that does not put the earlier bodies back verbatim or that drops the
  record.

The lab (tests/security/test_sec_adult_attestation.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M = (MIG / "0199_adult_attestation.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0199_adult_attestation.sql").read_text(encoding="utf-8")
SCHEMA = json.loads((ROOT / "schemas" / "model_registry.schema.json").read_text(encoding="utf-8"))

# name -> (the file it was built on, md5 before, md5 after, how many 0199 blocks are inserted)
REPLACED = {
    "quote_creative_job": ("0036_creative_jobs.sql", "8494b320cece395444edec700a2f1696", "ce54b243814e7e8205e8f2c200f05adc", 1),
    "route_model": ("0075_model_router.sql", "e4344e61983e7decb4b1eac73761fbf0", "446a8891a780d38237af38e46c24349a", 4),
    "sellable_models": ("0188_recraft_web_mcp.sql", "0ab9e7da07b4347010a887c5118d5150", "0e69dd8226d0ba7ee7f71b5481844488", 1),
    "create_creative_job": ("0174_rights_acknowledgement.sql", "88107b00b0a8c143606ed17f5898c98d", "5d373e69b2b33c9a461a245d46c0047f", 1),
    "api_creative_refusal": ("0174_rights_acknowledgement.sql", "e6ec45d0d912389a05eb2d40261c2c2a", "689a675e9ff2d1b6df46ccd89f351589", 1),
    "creative_platform_reserve": ("0036_creative_jobs.sql", "4a61076948e0dd8992d37de2a9016607", "8e8e0cc80de8f21793897af0223a7044", 1),
    "quote_film": ("0171_films_money.sql", "8839e2cb264663acf98c6f49aaaf89a5", "e67c0d25f9872b6e9ff19e9d06e95261", 2),
    "start_film": ("0187_rights_acknowledgement_inputs.sql", "5468183a8f24a48f708efcbbf9d2d22c", "45c36b8ebc8bd71bbf2ebc60243b718b", 1),
    "api_create_video": ("0147_mcp_free_tier.sql", "cba47be1a674f5cea3b5d7443bc31bab", "84477b7bff7fe4e2ec50376a4e5bb72e", 1),
}
NEW_FUNCTIONS = ["adult_attestations_append_only", "model_requires_adult", "adult_attestation_state", "adult_attestation_missing",
                 "adult_attestation_gate", "film_adult_refusals", "adult_attestation_refuse_minor", "record_adult_attestation",
                 "my_adult_attestation"]
GATE_TRIGGERS = [("adult_attestation_hold_gate", "credit_reservations", None)]
AGE_TS = (ROOT / "command-center" / "lib" / "age.ts").read_text(encoding="utf-8")
METHODS = ["email_signup", "google", "welcome", "create"]


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def pg_md5(defn: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    body = defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]
    return hashlib.md5(re.sub(r"[ \t\n\r\f\v]+", " ", body).encode()).hexdigest()


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def latest(name: str, before: str = "0199") -> tuple:
    out = None
    for p in sorted(MIG.glob("*.sql")):
        if p.name[:4] >= before:
            continue
        text = p.read_text(encoding="utf-8")
        if re.search(rf"create or replace function public\.{re.escape(name)}\(", text):
            out = (p.name, definition(text, name))
    return out


class BuiltOnTheEarlierBodies(unittest.TestCase):
    def test_each_replaced_body_is_the_earlier_one_plus_inserted_marked_blocks_only(self):
        for name, (src, _old, _new, blocks) in REPLACED.items():
            old = definition((MIG / src).read_text(encoding="utf-8"), name).splitlines()
            new = definition(M, name).splitlines()
            ops = [op for op in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes() if op[0] != "equal"]
            self.assertEqual([op[0] for op in ops], ["insert"] * blocks, name)
            for _tag, _i1, _i2, j1, j2 in ops:
                self.assertIn("0199", "\n".join(new[j1:j2]), f"{name}: an inserted block names 0199")

    def test_the_earlier_body_is_the_latest_one_before_0199(self):
        for name, (src, *_rest) in REPLACED.items():
            self.assertEqual(latest(name)[0], src, f"{name} was redefined after {src}: rebuild 0199 on the newer body")

    def test_the_md5_pins_describe_the_bodies(self):
        for name, (src, old, new, _b) in REPLACED.items():
            self.assertEqual(pg_md5(definition((MIG / src).read_text(encoding="utf-8"), name)), old, name)
            self.assertEqual(pg_md5(definition(M, name)), new, name)
            self.assertGreaterEqual(M.count(old), 2, f"{name}: header and drift guard")
            self.assertGreaterEqual(M.count(new), 4, f"{name}: header, drift guard, end state and Verify")
        for name in NEW_FUNCTIONS:
            self.assertIn(f"'{pg_md5(definition(M, name))}'", M, f"the drift guard pins {name}")

    def test_it_defines_exactly_these_functions(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", code(M))),
                         sorted([*NEW_FUNCTIONS, *REPLACED]))

    def test_the_grants(self):
        self.assertEqual(sorted(re.findall(r"grant execute on function (.*?);", code(M))), sorted([
            "public.quote_creative_job(uuid, text, text, jsonb) to authenticated",
            "public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated",
            "public.sellable_models(text, text) to authenticated, service_role",
            "public.record_adult_attestation(boolean, text, text) to authenticated",
            "public.my_adult_attestation() to authenticated",
            "public.quote_film(uuid, integer) to authenticated",
            "public.start_film(uuid, text, text) to authenticated",
            "public.api_create_video(text, text, jsonb, text, text, text) to anon",
        ]))
        for name in [*NEW_FUNCTIONS, *REPLACED]:
            self.assertRegex(M, rf"revoke all on function public\.{name}\([^)]*\) from public, anon")
        for name in ("record_adult_attestation", "my_adult_attestation", "adult_attestation_state", "adult_attestation_missing",
                     "adult_attestation_gate", "film_adult_refusals", "adult_attestation_refuse_minor"):
            self.assertIn("security definer set search_path = public, pg_temp as $$", definition(M, name), name)


class TheGate(unittest.TestCase):
    def test_the_job_asks_after_the_price_and_before_the_acknowledgement_the_ceiling_the_hold_and_the_job(self):
        body = definition(M, "create_creative_job")
        gate = body.index("perform public.adult_attestation_gate(uid, q ->> 'model');")
        for earlier in ("'replay', true", "q := public.creative_price(", "price := (q ->> 'credits')::numeric;"):
            self.assertLess(body.index(earlier), gate, earlier)
        for later in ("ack := public.rights_acknowledgement_missing(", "if p_max_credits is not null and price > p_max_credits then",
                      "public.creative_platform_reserve(", "insert into public.creative_jobs"):
            self.assertLess(gate, body.index(later), later)

    def test_the_quote_asks_after_the_price_and_before_it_is_answered(self):
        body = definition(M, "quote_creative_job")
        gate = body.index("perform public.adult_attestation_gate(auth.uid(), q ->> 'model');")
        self.assertLess(body.index("q := public.creative_price("), gate)
        self.assertLess(gate, body.index("return q ||"))

    def test_the_gate_refuses_a_minor_everything_and_an_unattested_person_the_flagged_models(self):
        gate = definition(M, "adult_attestation_gate")
        self.assertLess(gate.index("'adult_only_service'"), gate.index("'adult_attestation_required'"))
        self.assertIn("if public.adult_attestation_state(p_user) = 'minor' then", gate)
        missing = definition(M, "adult_attestation_missing")
        self.assertIn("return public.adult_attestation_state(p_user) <> 'adult';", missing)
        self.assertIn("not public.model_requires_adult(sp)", missing)

    def test_the_router_excludes_rather_than_refuses_and_keeps_its_order(self):
        body = definition(M, "route_model")
        old = definition((MIG / "0075_model_router.sql").read_text(encoding="utf-8"), "route_model")
        self.assertEqual(re.findall(r"order by[^\n]*", body), re.findall(r"order by[^\n]*", old))
        skip = body.index("if public.adult_attestation_missing(auth.uid(), m) then")
        self.assertLess(body.index("q := public.creative_price(p_org, cap, m, p_params);"), skip, "priced candidates only")
        self.assertLess(skip, body.index("cands := cands || jsonb_build_array("))
        refuse = body.index("if jsonb_array_length(cands) = 0 and adult_skipped > 0 then")
        self.assertLess(refuse, body.index("perform public.creative_refuse('no_model_available',"))
        self.assertLess(body.index("'adult_only_service'"), body.index("problem := public.creative_params_problem(cap, p_params);"))

    def test_a_flag_of_another_shape_fails_closed(self):
        f = definition(M, "model_requires_adult")
        self.assertIn("when 'null' then\n      return false;", f)
        self.assertIn("when 'boolean' then\n      return (p_spec -> 'requires_adult')::boolean;", f)
        self.assertIn("else\n      return true;", f)
        self.assertEqual(SCHEMA["$defs"]["model"]["properties"]["requires_adult"]["type"], "boolean")

    def test_the_model_stays_listed_and_is_marked(self):
        body = definition(M, "sellable_models")
        self.assertIn("'requires_adult', case when public.model_requires_adult(m.spec) then true end,", body)
        self.assertNotIn("requires_adult", code(body.split("from public.model_registry m", 1)[1]),
                         "the flag never filters the list")
        self.assertIn("and not public.model_past_shutdown(m.spec)", body)

    def test_the_api_maps_both_words_with_the_remedy(self):
        body = definition(M, "api_creative_refusal")
        self.assertIn("when 'adult_attestation_required' then public.api_err(428, 'adult_attestation_required',", body)
        self.assertIn("Confirm you are 18 or older in the app", body)
        self.assertIn("when 'adult_only_service' then public.api_err(403, 'adult_only_service',", body)


class TheRecord(unittest.TestCase):
    def test_the_table_matches_the_contract(self):
        t = re.search(r"create table if not exists public\.adult_attestations \((.*?)\n\);", M, re.S).group(1)
        c = code(t)
        self.assertRegex(c, r"user_id\s+uuid primary key,")
        self.assertRegex(c, r"adult\s+boolean not null,")
        self.assertRegex(c, r"terms_version text not null,")
        self.assertRegex(c, r"method\s+text not null,")
        self.assertRegex(c, r"created_at\s+timestamptz not null default now\(\),")
        self.assertIn("check (terms_version ~ '^[a-z0-9._-]{1,40}$')", c)
        self.assertIn("check (method in ('email_signup', 'google', 'welcome', 'create'))", c)
        # No foreign key: a deleted account neither cascades into the record nor is blocked by it.
        self.assertNotIn("references", c)

    def test_the_record_is_append_only_and_each_person_reads_only_their_own(self):
        c = code(M)
        self.assertIn("before update or delete on public.adult_attestations", c)
        self.assertIn("before truncate on public.adult_attestations", c)
        self.assertIn("revoke all on public.adult_attestations from public, anon, authenticated, service_role;", c)
        self.assertEqual(re.findall(r"grant (\w+) on public\.adult_attestations to ([a-z_, ]+);", c),
                         [("select", "authenticated, service_role")])
        self.assertNotRegex(c, r"create policy \w+ on public\.adult_attestations\s+for (insert|update|delete|all)")
        self.assertIn("using (user_id = (select auth.uid()));", c)

    def test_the_write_is_bound_to_the_session_and_the_first_answer_stands(self):
        body = definition(M, "record_adult_attestation")
        self.assertIn("uid     uuid := auth.uid();", body)
        self.assertIn("raise exception 'not_signed_in' using errcode = 'NS401'", body)
        self.assertIn("values (uid, p_adult, p_terms_version, case when google_ then 'google' else p_method end)\n"
                      "  on conflict (user_id) do nothing", body)
        self.assertNotIn("on conflict (user_id) do update", body)
        self.assertIn("'recorded', ins", body)
        self.assertIn(f"p_method not in ({', '.join(repr(m) for m in METHODS)})", body)
        self.assertNotRegex(code(body), r"\bupdate\s+public\.adult_attestations")


class TheRollbackAndTheFile(unittest.TestCase):
    def test_the_rollback_puts_the_earlier_bodies_back_verbatim_and_keeps_the_record(self):
        for name, (src, old, new, _b) in REPLACED.items():
            self.assertEqual(definition(ROLLBACK, name), definition((MIG / src).read_text(encoding="utf-8"), name), name)
            self.assertIn(old, ROLLBACK)
            self.assertIn(new, ROLLBACK)
        self.assertEqual(sorted(re.findall(r"grant execute on function (.*?);", code(ROLLBACK))), sorted([
            "public.quote_creative_job(uuid, text, text, jsonb) to authenticated",
            "public.create_creative_job(uuid, text, text, jsonb, text, text, numeric) to authenticated",
            "public.sellable_models(text, text) to authenticated, service_role",
            "public.quote_film(uuid, integer) to authenticated",
            "public.start_film(uuid, text, text) to authenticated",
            "public.api_create_video(text, text, jsonb, text, text, text) to anon"]))
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;") and "\nbegin;\n" in ROLLBACK)
        # Outside the earlier bodies it puts back verbatim (0171's quote_film prunes its own old quotes), it deletes nothing.
        own = ROLLBACK
        for name in REPLACED:
            own = own.replace(definition(ROLLBACK, name), "")
        self.assertNotRegex(code(own), r"(?i)drop table|drop column|delete from|truncate")
        # The only triggers it drops are the three gates; the record's append-only triggers stay.
        self.assertEqual(sorted(re.findall(r"drop trigger if exists (\w+) on public\.(\w+);", code(ROLLBACK))),
                         sorted((n, tbl) for n, tbl, _w in GATE_TRIGGERS))

    def test_the_file_says_how_to_apply_verify_and_undo_and_what_replay_does(self):
        self.assertIn("APPLY AS ONE TRANSACTION", M)
        self.assertIn("set local lock_timeout = '5s';", M)
        self.assertIn("-- Verify (run after applying, AND after any manual replay of 0036 or 0075", M)
        self.assertIn("rollback_0199_adult_attestation.sql", M)
        self.assertIn("A DELETED ACCOUNT", M)
        self.assertIn("It KEEPS the record", M)

    def test_nothing_is_opened_and_no_economics_are_named(self):
        c = code(M)
        self.assertNotRegex(c, r"(?i)\bset\s+availability\s*=")
        self.assertNotIn("insert into public.credit_prices", c)
        self.assertNotRegex(c, r"update public\.model_registry\b")
        # What this file writes itself (the header and its own functions; the replaced bodies keep their earlier lines) names no
        # margin, cost or price figure.
        own = M.split("set local lock_timeout", 1)[0] + "\n".join(definition(M, n) for n in NEW_FUNCTIONS)
        self.assertNotRegex(own, r"(?i)\bmargin|\bcosts?\b|\$[0-9]|credits_per_unit")


class TheOtherPaidPaths(unittest.TestCase):
    """Breach on PR #832: a film, the video API and every creative hold made paid work for a minor without the gate."""

    def test_the_hold_gate_is_before_insert_on_the_credit_holds_only(self):
        c = code(M)
        for name, table, when in GATE_TRIGGERS:
            clause = f"for each row when ({when}) execute" if when else "for each row execute"
            self.assertRegex(c, rf"create trigger {name}\s+before insert on public\.{table}\s+{re.escape(clause)} "
                                rf"function public\.adult_attestation_refuse_minor\(\);", table)
        self.assertEqual(len(re.findall(r"create trigger adult_attestation_", c)), 1)
        # Never on an update, a delete or the ledger: capturing, releasing, refunding or expiring a hold that exists is never refused.
        self.assertNotRegex(c, r"(?i)create trigger adult_attestation_\w+\s+(after|before)\s+(update|delete)")
        self.assertNotRegex(c, r"(?i)create trigger \w+\s+before insert on public\.(credit_transactions|api_holds)")
        body = definition(M, "adult_attestation_refuse_minor")
        self.assertIn("if public.adult_attestation_state(auth.uid()) = 'minor' then", body)
        self.assertIn("'adult_only_service'", body)

    def test_the_creative_helper_asks_before_it_clears_the_session(self):
        body = definition(M, "creative_platform_reserve")
        ask = body.index("if public.adult_attestation_state(auth.uid()) = 'minor' then")
        self.assertLess(ask, body.index("perform set_config('request.jwt.claims', '', true);"))

    def test_the_film_quote_names_the_refusal_and_cannot_be_started(self):
        body = definition(M, "quote_film")
        ask = body.index("adult_ := public.film_adult_refusals(f.id, auth.uid());")
        self.assertLess(body.index("q := public.film_price(f);"), ask)
        self.assertLess(ask, body.index("insert into public.film_quotes"), "an adult-refused quote is never stored")
        self.assertIn("q := q || jsonb_build_object('priced', false, 'total', null, 'quote_id', null,", body)

    def test_the_film_start_refuses_right_after_the_admin_check_and_before_anything_else(self):
        body = definition(M, "start_film")
        ask = body.index("bad := public.film_adult_refusals(p_film, uid) -> 0;")
        self.assertLess(body.index("if not public.is_org_member(org, 'admin') or (exempt_ and not public.is_platform_admin()) then"), ask)
        for later in ("if p_idempotency_key is null", "if p_quote_id is null", "select * into s from public.film_segments",
                      "perform public.film_take_rate('start'", "q := public.film_price(f);", "perform public.reserve_credits(",
                      "insert into public.film_segments", "insert into public.film_takes"):
            self.assertLess(ask, body.index(later), later)

    def test_the_film_reads_every_model_it_would_use(self):
        body = definition(M, "film_adult_refusals")
        for model in ("coalesce(s.keyframe_model, f.keyframe_model)", "coalesce(s.clip_model, f.clip_model)", "f.voice ->> 'model'"):
            self.assertIn(model, body)
        self.assertLess(body.index("'adult_only_service'"), body.index("'adult_attestation_required'"))
        self.assertIn("public.adult_attestation_missing(p_user, m)", body)
        self.assertNotIn("film_segments", body, "0171's rollback refuses while a later function reads film_segments")

    def test_the_video_api_answers_a_minor_with_a_403_before_the_price_and_the_hold(self):
        body = definition(M, "api_create_video")
        ask = body.index("if public.adult_attestation_state(auth.uid()) = 'minor' then")
        self.assertLess(body.index("v_res := public.api_idem_begin(ctx, p_idem_key, p_fingerprint);"), ask)
        for later in ("v_price := public.api_video_price(v_secs);", "insert into public.api_holds", "insert into public.render_jobs"):
            self.assertLess(ask, body.index(later), later)
        self.assertIn("public.api_err(403, 'adult_only_service',", body)

    def test_the_header_lists_what_is_not_covered(self):
        for words in ("NOT COVERED", "oauth_create_video", "EXEMPT organization", "Paid DOWNLOADS", "DORMANT requests"):
            self.assertIn(words, M)


class TheRecordedWords(unittest.TestCase):
    def test_only_the_apps_current_terms_version_is_accepted(self):
        version = re.search(r'export const AGE_TERMS_VERSION = "([^"]+)";', AGE_TS).group(1)
        body = definition(M, "record_adult_attestation")
        self.assertIn(f"if p_terms_version is distinct from '{version}' then", body,
                      "lib/age.ts AGE_TERMS_VERSION and record_adult_attestation must name the same version")
        self.assertIn("command-center/lib/age.ts AGE_TERMS_VERSION", body)
        self.assertIn("record_adult_attestation", AGE_TS.split("AGE_TERMS_VERSION", 1)[0].rsplit("/**", 1)[1],
                      "the app side names the coupling too")

    def test_the_session_decides_google(self):
        body = definition(M, "record_adult_attestation")
        self.assertIn("google_ boolean := coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google';", body)
        self.assertIn("if p_method = 'google' and not google_ then", body)
        self.assertNotIn("user_metadata' ->>", code(body), "user_metadata is the user's to edit")


if __name__ == "__main__":
    unittest.main()
