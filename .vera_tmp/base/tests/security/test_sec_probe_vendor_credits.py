"""The probe log keeps the vendor's own bill for a probe (migration 0152), on a real Postgres.

What would break without these tests: a signed-in user (or anon) writing a probe row, and with it a model's verification, through the
new eleven-argument record_model_probe; a ten-argument call (the probe tool of the previous release, every other lab test) becoming
ambiguous; the new form forgetting to verify the model it probed; a negative, NaN or absurd figure reaching the column; a figure
being written later onto an existing row (the log is append-only); a customer reading the figure.

Every row is made inside one rolled-back transaction, so no later test sees it.
"""

from __future__ import annotations

import json

from sec_db import ANON, acting, as_superuser
from sec_scenario import _model_row

SIG = "public.record_model_probe(text,text,text,text,boolean,text,text,integer,bigint,text,numeric)"
ELEVEN = ("select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', %s, %s, %s, 900, 1234, 'security-lab', "
          "%s::numeric)")
TEN = "select public.record_model_probe(%s, 'image.openai', 'lab-model-1', 't2i', true, null, null, 900, 1234, 'security-lab')"


def _model(s, mid):
    row = _model_row(mid)
    s.rows("insert into public.model_registry (id, display_name, provider, adapter, capabilities, spec, credit_unit, entitlement) "
           "values (%s, %s, 'lab', 'image.openai', array['t2i'], %s::jsonb, %s, null) returning 1",
           [mid, mid, json.dumps(row["spec"]), row["credit_unit"]])


def test_the_figure_is_stored_with_the_row_and_the_probe_still_verifies_the_model(conn):
    with as_superuser(conn, commit=False) as s:
        _model(s, "lab-vc-1")
        run_id = s.value(ELEVEN, ["lab-vc-1", True, None, None, 60])
        assert s.rows("select vendor_credits::float8, ok from public.model_probe_runs where id = %s", [run_id]) == [(60.0, True)]
        # 0035's rule, unchanged in the new form: a success of the model as it is now verifies it.
        assert s.value("select verified_probe_id from public.model_registry where id = 'lab-vc-1'") == run_id


def test_a_ten_argument_call_still_reaches_0035s_form_and_stores_no_figure(conn):
    with as_superuser(conn, commit=False) as s:
        _model(s, "lab-vc-2")
        run_id = s.value(TEN, ["lab-vc-2"])
        assert s.value("select vendor_credits from public.model_probe_runs where id = %s", [run_id]) is None
        # A failed probe through the new form keeps its code, verifies nothing, and may carry no figure.
        failed = s.value(ELEVEN, ["lab-vc-2", False, "timeout", "no result after 900s", None])
        assert s.rows("select ok, error_code, vendor_credits from public.model_probe_runs where id = %s", [failed]) == [
            (False, "timeout", None)]


def test_only_the_service_role_may_execute_the_new_form(conn, sc):
    with as_superuser(conn, commit=False) as s:
        assert s.rows(f"select has_function_privilege('anon', '{SIG}', 'EXECUTE'), "
                      f"has_function_privilege('authenticated', '{SIG}', 'EXECUTE'), "
                      f"has_function_privilege('service_role', '{SIG}', 'EXECUTE')") == [(False, False, True)]
    for who in (ANON, sc.alice.actor, sc.operator):
        with acting(conn, who) as s:
            out = s.run(ELEVEN, ["lab-sold-1", True, None, None, 1])
            assert not out.ok and out.sqlstate == "42501", (who.name, out)


def test_a_figure_outside_the_rule_is_refused(conn):
    with as_superuser(conn, commit=False) as s:
        _model(s, "lab-vc-3")
        for bad in ("-1", "1000001", "NaN", "Infinity"):
            out = s.run(ELEVEN, ["lab-vc-3", True, None, None, bad])
            assert not out.ok and out.sqlstate == "23514", (bad, out)


def test_the_figure_cannot_be_added_to_an_existing_row(conn):
    with as_superuser(conn, commit=False) as s:
        _model(s, "lab-vc-4")
        run_id = s.value(TEN, ["lab-vc-4"])
        out = s.run("update public.model_probe_runs set vendor_credits = 5 where id = %s", [run_id])
        assert not out.ok and out.sqlstate == "42501", out


def test_the_operator_reads_the_figure_and_a_customer_reads_no_probe_row(conn, sc):
    with acting(conn, sc.operator) as s:
        assert s.run("select vendor_credits from public.model_probe_runs limit 1").ok
        assert s.value("select count(*) from public.model_probe_runs") > 0
    with acting(conn, sc.alice.actor) as s:
        out = s.run("select vendor_credits from public.model_probe_runs")
        assert out.ok and out.rows == [], out
