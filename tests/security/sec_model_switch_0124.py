"""Security-lab contract for migration 0124 (the owner's per-model and per-provider ON/OFF switch). One hook wires it in, at the bottom of
sec_expectations.py:

    import sec_model_switch_0124; sec_model_switch_0124.extend(TABLES, FUNCTIONS)

Four tables, all Service(): no API role reads or writes any of them (the isolation tests then prove that a tenant, an anon caller and the
operator read nothing and cannot insert). Every function is declared:

  * model_is_available and models_switched_off are USER: a signed-in reader needs them (the RLS policy on model_registry evaluates the first as
    the reader; the Studio asks the second). They answer an id and a boolean, never a reason;
  * owner_model_switches, owner_model_switch_preview, owner_set_model_switch and owner_model_alert_dismiss are USER because the FUNCTION decides
    (platform owner only): test_sec_model_switch.py attacks that from every other role;
  * model_switch_state is SERVICE (the queue worker's pre-spend gate);
  * the helpers are SERVICE too (no API role at all): called only inside the definer functions above.
The attacks and the in-flight rule are in test_sec_model_switch.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        "model_availability_settings": Service(),
        "model_availability": Service(),
        "model_availability_log": Service(),
        "model_availability_alerts": Service(),
    })
    functions.update({
        "model_is_available": USER,
        "models_switched_off": USER,
        "model_switch_state": SERVICE,
        "model_switch_job_model": SERVICE,
        "model_switch_target_models": SERVICE,
        "model_switch_counts": SERVICE,
        "model_switch_stop_jobs": SERVICE,
        "owner_model_switches": USER,
        "owner_model_switch_preview": USER,
        "owner_set_model_switch": USER,
        "owner_model_alert_dismiss": USER,
    })


def seed(conn, sc) -> None:
    """One row in each table the isolation tests clone, so that the tests are not vacuous: an inert switch (a provider no model belongs to,
    enabled), one log row and one dismissed alert. Written by the database owner. The settings row is the one the migration made
    (enforced = false), which the named tests turn on and off inside a scratch database of their own."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        s.rows("insert into public.model_availability (scope, target, enabled) values ('provider', 'seed-provider', true) returning 1")
        s.rows("insert into public.model_availability_log (kind, scope, target, enabled, detail) "
               "values ('switch', 'provider', 'seed-provider', true, '{}'::jsonb) returning 1")
        s.rows("insert into public.model_availability_alerts (provider, failures, window_minutes, status, dismissed_at) "
               "values ('seed-provider', 3, 60, 'dismissed', now()) returning 1")
