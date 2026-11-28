"""Migration 0238: a model with a country list may go on sale only with its vendor's allow-list, and only behind 0230's gate.

0142 kept every row with blocked_countries off sale because the database did not know the country. Since 0208 (the gate on
creative_jobs) and 0230 (it reads the allow-list) it does, for a row with an allow-list; a deny-list alone still lets a code on
neither list through (BR-S6-04). What would break, and which test says so:

  a row with both lists (Google's shape) still cannot go on sale                 test_a_row_with_both_lists_can_be_put_on_sale
  a deny-list-only row (grounded-image-1.0's shape) can go on sale               test_a_deny_list_only_row_still_cannot
  an allow-list that is empty, null or not an array counts as one                 test_an_allow_list_of_another_shape_is_no_allow_list
  a sync that drops the allow-list of a row on sale goes through                  test_a_sync_that_drops_the_allow_list_on_sale_is_refused_whole
  0238 lands on a gate nobody read, a disabled or missing trigger, a new claim    test_the_file_refuses_*
  0238 lands where a deny-list-only row is already on sale                        test_the_file_names_a_deny_list_only_row_already_on_sale
  a replay drifts                                                                 test_a_replay_changes_nothing
  the rollback leaves another CHECK than 0142's, or takes a row's gate away        test_the_rollback_*
  0230's or 0208's rollback takes the gate away under a model on sale             test_the_gates_rollbacks_refuse_while_a_listed_row_is_on_sale
  a size-priced operator preview runs (why the cleared rows are not marked one)  test_a_size_priced_operator_preview_is_quoted_unpriced

Everything runs inside transactions that are rolled back. Nothing calls a provider.
"""

from __future__ import annotations

import json
import re

import sec_db
from sec_db import SERVICE, as_superuser
from test_sec_country_block import become, state, sync
from sec_scenario import MODEL_SOLD

MIGRATION = sec_db.MIGRATIONS / "0238_country_list_sale_needs_allow_list.sql"
ROLLBACK = sec_db.REPO / "docs" / "sql" / "rollback_0238_country_list_sale_needs_allow_list.sql"
M0142 = sec_db.MIGRATIONS / "0142_country_block_before_sale.sql"
RB0142 = sec_db.REPO / "docs" / "sql" / "rollback_0142_country_block_before_sale.sql"
RB0230 = sec_db.REPO / "docs" / "sql" / "rollback_0230_geo_gate_allow_list.sql"
M0230 = sec_db.MIGRATIONS / "0230_geo_gate_allow_list.sql"
CHECK = "model_registry_countries_before_sale"
GATE = "public.creative_jobs_geo_gate()"

REGISTRY = {m["id"]: m for m in json.loads((sec_db.REPO / "schemas" / "model_registry.json").read_text(encoding="utf-8"))["models"]}
#: The lists that ship on the row the owner cleared (gemini-3-pro-image): Google's own list and its complement.
GOOGLE = REGISTRY["gemini-3-pro-image"]
BOTH = {"blocked_countries": GOOGLE["blocked_countries"], "available_countries": GOOGLE["available_countries"]}
DENY_ONLY = {"blocked_countries": ["RU", "BY"]}

DEF_Q = ("select pg_get_constraintdef(oid) from pg_constraint "
         "where conrelid = 'public.model_registry'::regclass and conname = %s")


def body(path) -> str:
    return "\n".join(ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))


def the_check(s):
    become(s, None)
    return s.rows(DEF_Q, [CHECK])


def off_sale_with(s, spec):
    """MODEL_SOLD as the worst case (verified by a real probe, priced, no terms_gate): off sale, then given the lists in `spec`."""
    become(s, None)
    s.rows("update public.model_registry set availability = 'hidden' where id = %s returning 1", [MODEL_SOLD])
    out = sync(s, sold_spec=spec)
    assert out.ok, out
    assert state(s, MODEL_SOLD)["availability"] == "hidden"


def put_on_sale(s, who, level="beta"):
    become(s, who)
    return s.run("update public.model_registry set availability = %s where id = %s", [level, MODEL_SOLD])


def test_the_lab_has_0238(conn, sc):
    with as_superuser(conn, commit=False) as s:
        assert sec_db.has_0238(s)
        (d,), = the_check(s)
        assert "available_countries" in d and "blocked_countries" in d, d


def test_a_row_with_both_lists_can_be_put_on_sale(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with(s, BOTH)
        for who in (sc.operator, SERVICE):
            for level in ("beta", "ga"):
                out = put_on_sale(s, who, level)
                assert out.ok and out.rowcount == 1, (who, level, out)
                assert put_on_sale(s, who, "hidden").ok


def test_a_deny_list_only_row_still_cannot(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with(s, DENY_ONLY)
        for who in (sc.operator, SERVICE, None):
            for level in ("beta", "ga"):
                out = put_on_sale(s, who, level)
                assert not out.ok and out.sqlstate == "23514" and CHECK in out.error, (who, level, out)
        # And Google's complement alone, as a registry synced before 0230 holds it.
        off_sale_with(s, {"blocked_countries": GOOGLE["blocked_countries"]})
        out = put_on_sale(s, sc.operator)
        assert not out.ok and out.sqlstate == "23514", out
        assert state(s, MODEL_SOLD)["availability"] == "hidden"


def test_an_allow_list_of_another_shape_is_no_allow_list(conn, sc):
    with as_superuser(conn, commit=False) as s:
        for allow in ([], None, "UZ", {"UZ": True}):
            off_sale_with(s, {"blocked_countries": ["RU"], "available_countries": allow})
            out = put_on_sale(s, sc.operator)
            assert not out.ok and out.sqlstate == "23514", (allow, out)


def test_a_sync_that_drops_the_allow_list_on_sale_is_refused_whole(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with(s, BOTH)
        assert put_on_sale(s, sc.operator).ok
        out = sync(s, sold_spec=DENY_ONLY)
        assert not out.ok and out.sqlstate == "23514" and CHECK in out.error, out
        become(s, None)
        assert s.value("select spec -> 'available_countries' from public.model_registry where id = %s",
                       [MODEL_SOLD]) == GOOGLE["available_countries"]


def test_the_file_refuses_a_gate_that_is_not_0230s(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(body(RB0230))                                   # 0208's gate body back
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "0238 found a creative_jobs_geo_gate() that is not 0230's body" in out.error, out
        assert sec_db.has_0238(s)                                      # nothing of the failed apply was written


def test_the_file_refuses_0230s_body_with_a_line_swallowed_or_a_comment_changed(conn, sc):
    with as_superuser(conn, commit=False) as s:
        src = s.value("select prosrc from pg_proc where oid = %s::regprocedure", [GATE])
        start = src.index("  -- A list of any other shape")
        end = src.index("  -- 0230 (BR-S6-04)")
        swallowed = src[:start] + " ".join(src[start:end].split()) + "\n" + src[end:]   # the deny-list refusal is now a comment
        for planted in (swallowed, src.replace("begin\n", "begin\n  -- planted\n", 1)):
            assert planted != src
            s.conn.execute("create or replace function public.creative_jobs_geo_gate() returns trigger language plpgsql "
                           "security definer set search_path = public, pg_temp as $body$" + planted + "$body$")
            out = s.run(MIGRATION.read_text(encoding="utf-8"))
            assert not out.ok and "0238 found a creative_jobs_geo_gate()" in out.error, out
        s.conn.execute("create or replace function public.creative_jobs_geo_gate() returns trigger language plpgsql "
                       "security definer set search_path = public, pg_temp as $body$" + src + "$body$")
        assert s.run(MIGRATION.read_text(encoding="utf-8")).ok      # the control: 0230's body itself is accepted


def test_the_file_refuses_a_disabled_or_missing_trigger(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("alter table public.creative_jobs disable trigger creative_jobs_geo_gate")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "no enabled BEFORE INSERT OR UPDATE row trigger" in out.error, out
        s.conn.execute("alter table public.creative_jobs enable trigger creative_jobs_geo_gate")
        s.conn.execute("drop trigger creative_jobs_geo_gate on public.creative_jobs")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "no enabled BEFORE INSERT OR UPDATE row trigger" in out.error, out
        # An AFTER trigger on the same function is no gate: the row is already written.
        s.conn.execute("create trigger creative_jobs_geo_gate after insert or update of routed_model on public.creative_jobs "
                       "for each row execute function public.creative_jobs_geo_gate()")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "no enabled BEFORE INSERT OR UPDATE row trigger" in out.error, out


def test_the_file_refuses_without_the_gate_or_with_another_claim_reader(conn, sc):
    with as_superuser(conn, commit=False) as s:
        src = s.value("select prosrc from pg_proc where oid = 'public.geo_claim_country()'::regprocedure")
        s.conn.execute("create or replace function public.geo_claim_country() returns text language plpgsql stable "
                       "security definer set search_path = public, pg_temp as $body$ begin return 'UZ'; end $body$")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "0238 found a geo_claim_country()" in out.error, out
        assert src
    with as_superuser(conn, commit=False) as s:
        s.conn.execute("drop trigger creative_jobs_geo_gate on public.creative_jobs")
        s.conn.execute("drop function public.creative_jobs_geo_gate()")
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "0238 needs the database country gate" in out.error, out


def test_the_file_names_a_deny_list_only_row_already_on_sale(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(body(RB0142))                                   # no CHECK at all: the sync goes through
        assert sync(s, sold_spec=DENY_ONLY).ok
        become(s, None)
        out = s.run(MIGRATION.read_text(encoding="utf-8"))
        assert not out.ok and "0238" in out.error and f"{MODEL_SOLD} (beta)" in out.error, out
        assert s.value("select count(*) from pg_constraint where conname = %s", [CHECK]) == 0
        # With both lists the same row is accepted, and the CHECK comes back.
        assert sync(s, sold_spec=BOTH).ok
        become(s, None)
        assert s.run(MIGRATION.read_text(encoding="utf-8")).ok
        assert sec_db.has_0238(s)


def test_a_replay_changes_nothing(conn, sc):
    with as_superuser(conn, commit=False) as s:
        q = ("select conname, pg_get_constraintdef(oid), convalidated from pg_constraint "
             "where conrelid = 'public.model_registry'::regclass order by conname")
        before = s.rows(q)
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert s.rows(q) == before
        assert s.value("select count(*) from pg_constraint where conname = %s", [CHECK]) == 1


def test_the_rollback_puts_0142s_exact_check_back(conn, sc):
    with as_superuser(conn, commit=False) as s:
        s.conn.execute(M0142.read_text(encoding="utf-8"))             # a replay of 0142 is 0142's definition
        d142 = the_check(s)
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        d238 = the_check(s)
        assert d238 != d142 and "available_countries" not in d142[0][0]
        s.conn.execute(body(ROLLBACK))
        assert the_check(s) == d142
        s.conn.execute(body(ROLLBACK))                                 # twice: harmless
        assert the_check(s) == d142
        assert not sec_db.has_0238(s)
        # 0142's rule is back: both lists are refused beta again.
        off_sale_with(s, BOTH)
        out = put_on_sale(s, sc.operator)
        assert not out.ok and out.sqlstate == "23514", out
        # And 0238 applies again on it.
        become(s, None)
        s.conn.execute(MIGRATION.read_text(encoding="utf-8"))
        assert the_check(s) == d238
        assert put_on_sale(s, sc.operator).ok


def test_the_rollback_refuses_while_a_listed_row_is_on_sale(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with(s, BOTH)
        assert put_on_sale(s, sc.operator).ok
        before = the_check(s)
        out = s.run(body(ROLLBACK))
        assert not out.ok and "rollback 0238" in out.error and f"{MODEL_SOLD} (beta)" in out.error, out
        assert the_check(s) == before                                  # nothing changed
        assert state(s, MODEL_SOLD)["availability"] == "beta"
        # Off sale first, then the rollback goes through.
        assert put_on_sale(s, sc.operator, "hidden").ok
        become(s, None)
        assert s.run(body(ROLLBACK)).ok
        assert not sec_db.has_0238(s)


def test_the_gates_rollbacks_refuse_while_a_listed_row_is_on_sale(conn, sc):
    with as_superuser(conn, commit=False) as s:
        off_sale_with(s, BOTH)
        assert put_on_sale(s, sc.operator).ok
        become(s, None)
        md5 = s.value("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = %s::regprocedure", [GATE])
        assert md5 == sec_db.GEO_GATE_0230
        out = s.run(body(RB0230))
        assert not out.ok and "rollback 0230: these models are on sale with a country list" in out.error, out
        assert f"{MODEL_SOLD} (beta)" in out.error and "rollback_0238" in out.error, out
        out = s.run(body(sec_db.ROLLBACK_0208))
        assert not out.ok and "rollback 0208: these models are on sale with a country list" in out.error, out
        # The gate is untouched by both refusals.
        assert s.value("select md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) from pg_proc where oid = %s::regprocedure",
                       [GATE]) == sec_db.GEO_GATE_0230
        assert s.value("select count(*) from pg_trigger where tgrelid = 'public.creative_jobs'::regclass "
                       "and tgname = 'creative_jobs_geo_gate'") == 1


def test_the_lab_chain_puts_0238_back_after_0230(conn, sc):
    for name in ("ON_0156", "ON_0139", "ON_0125", "ON_0124"):
        seq = list(getattr(sec_db, name))
        assert seq[-1] == MIGRATION.name, name
        assert seq.index(M0230.name) < seq.index(MIGRATION.name), name
    with as_superuser(conn, commit=False) as s:
        sec_db.take_off_0208(s)                                        # 0238's rollback first, then the gate goes
        assert not sec_db.has_0238(s)
        assert s.value("select to_regprocedure(%s) is null", [GATE])
        sec_db.put_back_0208(s)                                        # 0208, 0230, then 0238 again
        assert sec_db.has_0238(s)
        assert re.search(r"available_countries", the_check(s)[0][0])


def test_a_size_priced_operator_preview_is_quoted_unpriced(conn, sc):
    # Why the two cleared Google rows are NOT marked operator_preview (docs/MIGRATIONS.md, 0238): both are priced by image_size, and
    # creative_price quotes a size-priced preview with no per-size credit_prices row as unpriced (0139's vendor-cost fallback reads
    # no size). Measured on the shipped specs with the mark added: the preview path accepts them (not model_not_sellable) and then
    # refuses the quote. When a migration teaches the fallback sizes, or the owner prices one, this is the test that changes.
    from modules import model_registry as reg
    from sec_scenario import DEFAULT_ORG
    from test_sec_operator_preview import _quote

    rows = {r["id"]: r for r in reg.sync_rows(list(reg.load().values()))}
    with as_superuser(conn, commit=False) as s:
        c = s.conn
        for mid in ("gemini-3-pro-image", "gemini-nano-banana-2.1"):
            r = rows[mid]
            assert r["spec"]["terms_gate"] is None and "operator_preview" not in r["spec"], mid
            assert r["spec"]["pricing"]["variants"]["by"] == "image_size", mid
            spec = {**r["spec"], "operator_preview": True}
            c.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, "
                      "entitlement) values (%s, %s, %s, %s, %s, %s::jsonb, %s, %s) on conflict (id) do update set spec = excluded.spec",
                      [r["id"], r["display_name"], r["provider"], r["adapter"], r["capabilities"], json.dumps(spec),
                       r["credit_unit"], r["entitlement"]])
            c.execute("select public.record_model_probe(%s, %s, %s, 't2i', true, null, null, 900, 1234, 'security-lab')",
                      [mid, r["adapter"], r["spec"]["vendor_model"]])
            assert c.execute("select availability from public.model_registry where id = %s", [mid]).fetchone()[0] == "hidden"
            got = _quote(c, sc.operator, DEFAULT_ORG, mid, {"prompt": "a red apple", "image_size": "1K", "aspect_ratio": "1:1"})
            assert got == ("NS400", "unpriced"), (mid, got)
            got = _quote(c, sc.alice.actor, sc.alice.org, mid, {"prompt": "a red apple", "image_size": "1K", "aspect_ratio": "1:1"})
            assert got[0] != "ok", (mid, got)
