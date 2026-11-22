"""gemini-omni-1.1-flash is retired and can never be sold again by accident (migration 0222).

Google routes this id to gemini-omni-1.2-flash from 2026-12-03 and bills it as 1.2. Selling "Omni 1.1" after that would be a
substitute the vendor makes silently (CLAUDE.md rule 4). Today the row is terms-gated, so nothing sells it; these tests take the
worst case instead (the row verified, priced, on sale, its gate cleared, or marked as an operator preview) and show that after
0222 no surface lists it, no one is quoted it, a replay changes nothing, and only the owner's rollback brings it back, hidden.

Every row is made inside one rolled-back transaction, so no later test sees it.
"""

from __future__ import annotations

import json

import sec_db
from sec_scenario import _model_row
from test_sec_operator_preview import _become, _call

MID = "gemini-omni-1.1-flash"
UNIT = "model_gemini_omni_1_1_flash_lab"
MIGRATION = (sec_db.MIGRATIONS / "0222_retire_gemini_omni_1_1.sql").read_text(encoding="utf-8")
ROLLBACK = "\n".join(ln for ln in (sec_db.REPO / "docs" / "sql" / "rollback_0222_retire_gemini_omni_1_1.sql").read_text(
    encoding="utf-8").splitlines() if ln.strip() not in ("begin;", "commit;"))
SURFACES = ("web", "api", "mcp")
PROMPT = {"prompt": "a lighthouse at dawn"}


def _clear(conn):
    conn.execute("select set_config('request.jwt.claims', '', true)")


def _on_sale(conn, availability="beta", **spec):
    """The worst case: the id verified by a probe, priced, beta, no plan entitlement and (unless spec says otherwise) no terms gate."""
    _clear(conn)
    row = _model_row(MID, **spec)
    conn.execute("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
                 "values (%s, 'Gemini Omni Flash 1.1', 'google', 'image.openai', array['t2i'], %s::jsonb, %s, null) "
                 "on conflict (id) do update set provider = excluded.provider, adapter = excluded.adapter, "
                 "capabilities = excluded.capabilities, spec = excluded.spec, credit_unit = excluded.credit_unit, entitlement = null",
                 [MID, json.dumps(row["spec"]), UNIT])
    conn.execute("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, null, null, 900, 1234, 'security-lab')",
                 [MID])
    conn.execute("update public.model_registry set availability = %s where id = %s", [availability, MID])
    conn.execute("insert into public.credit_prices (unit, credits_per_unit) values (%s, 4) on conflict (unit) do nothing", [UNIT])


def _listed(conn, who):
    out = set()
    for s in SURFACES:
        _become(conn, who)
        if any(r[0] == MID for r in conn.execute("select id from public.sellable_models(null, %s)", [s]).fetchall()):
            out.add(s)
        _become(conn, None)
    return out


def _availability(conn):
    return conn.execute("select availability, updated_at from public.model_registry where id = %s", [MID]).fetchone()


def test_a_row_on_sale_is_taken_off_every_surface_and_refused_by_name(conn, sc):
    with conn.transaction(force_rollback=True):
        _on_sale(conn)
        assert _listed(conn, sc.alice.actor) == {"web", "api", "mcp"}, "the lab row must start on sale, or the test proves nothing"
        assert _call(conn, sc.alice.actor, "select public.quote_creative_job(%s, 't2i', %s, %s::jsonb)",
                     [sc.alice.org, MID, json.dumps(PROMPT)])[0] == "ok"

        conn.execute(MIGRATION)

        assert _availability(conn)[0] == "disabled"
        assert _listed(conn, sc.alice.actor) == set()
        state, msg = _call(conn, sc.alice.actor, "select public.quote_creative_job(%s, 't2i', %s, %s::jsonb)",
                           [sc.alice.org, MID, json.dumps(PROMPT)])
        assert state != "ok", msg


def test_an_operator_preview_of_the_retired_id_is_refused_too(conn, sc):
    # creative_operator_preview accepts only 'hidden' (0139); a disabled row is never previewed, whatever its spec says.
    with conn.transaction(force_rollback=True):
        _on_sale(conn, availability="hidden", operator_preview=True, terms_gate="terms_review_required",
                 pricing={"unit": "image", "provider_usd_per_unit": 0.01})
        org = conn.execute("select public.default_org_id()").fetchone()[0]
        q = "select coalesce(jsonb_agg(id), '[]'::jsonb) from public.operator_preview_models(%s)"
        before = _call(conn, sc.operator, q, [org])
        assert before[0] == "ok" and MID in before[1], f"the lab row must start as a preview, or the test proves nothing: {before}"

        conn.execute(MIGRATION)

        after = _call(conn, sc.operator, q, [org])
        assert after[0] == "ok" and MID not in after[1], after


def test_a_replay_changes_nothing_and_a_missing_row_is_only_a_notice(conn, sc):
    with conn.transaction(force_rollback=True):
        _on_sale(conn)
        conn.execute(MIGRATION)
        first = _availability(conn)
        conn.execute(MIGRATION)
        assert _availability(conn) == first, "a replay must not touch the row (updated_at included)"

        # Not synced yet (model_probe_runs is append-only, so the lab row cannot be deleted: the same file names an id with no row).
        conn.execute(MIGRATION.replace("'gemini-omni-1.1-flash'", "'lab-not-synced-0222'"))
        assert conn.execute("select count(*) from public.model_registry where id = 'lab-not-synced-0222'").fetchone()[0] == 0


def test_only_the_owners_rollback_brings_it_back_and_then_only_hidden(conn, sc):
    with conn.transaction(force_rollback=True):
        _on_sale(conn)
        conn.execute(MIGRATION)
        conn.execute(ROLLBACK)
        assert _availability(conn)[0] == "hidden"
        assert _listed(conn, sc.alice.actor) == set()
        conn.execute(MIGRATION)                                  # and the file retires it again
        assert _availability(conn)[0] == "disabled"


def test_no_api_role_can_undo_it(conn, sc):
    with conn.transaction(force_rollback=True):
        _on_sale(conn)
        conn.execute(MIGRATION)
        for who in (sc.alice.actor, sc.bob.actor):
            _call(conn, who, "update public.model_registry set availability = 'beta' where id = %s returning 1", [MID])
        assert _availability(conn)[0] == "disabled"
