"""Security-lab contract for migration 0073 (workflow apps).

Kept in its own module, like sec_editor_0054. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_workflows_0073; sec_workflows_0073.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_workflows_0073.seed(conn, sc)

The seed writes what production writes: each tenant's workflow through
save_workflow() in the member's own session. The run and its steps are
written by the database owner, as the scenario does for creative_jobs: starting
a run holds credits, and the shared scenario's balances and holds are asserted
exactly by other tests. The named attacks, which run a full lifecycle in a
scratch database of their own, are in test_sec_workflows.py.
"""

from __future__ import annotations

import hashlib
import json
from typing import Dict

#: Per tenant key ('a' / 'b'): ids the isolation tests aim at.
WORKFLOW: Dict[str, str] = {}
RUN: Dict[str, str] = {}

STEPS = [
    {"capability": "t2i", "model": "img-x", "params": {"prompt": {"$input": "idea"}}},
    {"capability": "t2i", "model": "img-x", "params": {"prompt": "a poster"}},
]
INPUTS = [{"name": "idea", "kind": "text"}]


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org

    tables.update({
        # Members read; nobody inserts, updates or deletes directly — the
        # functions below are the only write path.
        "workflows": Org(),
        "workflow_runs": Org(),
        "workflow_run_steps": Org(),
    })
    functions.update({
        "save_workflow": USER,
        "delete_workflow": USER,
        "quote_workflow": USER,
        "start_workflow_run": USER,
        "advance_workflow_run": USER,
        "cancel_workflow_run": USER,
        # Internal: called only inside the functions above.
        "workflow_makes_picture": SERVICE,
        "workflow_takes_picture": SERVICE,
        "workflow_definition_problem": SERVICE,
        "workflow_bind_inputs": SERVICE,
        "workflow_fill_params": SERVICE,
        "workflow_quote_steps": SERVICE,
        "workflow_run_json": SERVICE,
        "workflow_advance_locked": SERVICE,
        # 0074 (LENS-2, BR-L-006): may a run's confirmer still spend? Internal.
        "workflow_confirmer_may_spend": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import acting, as_superuser

    for t in sc.tenants():
        k = t.key
        with acting(conn, t.actor, commit=True) as s:
            WORKFLOW[k] = str(s.value(
                "select public.save_workflow(%s, null, %s, %s::jsonb, %s::jsonb) ->> 'id'",
                [t.org, f"Flow {k.upper()}", json.dumps(INPUTS), json.dumps(STEPS)]))
        with as_superuser(conn) as s:
            RUN[k] = str(s.value(
                "insert into public.workflow_runs (id, org_id, workflow_id, workflow_name, workflow_version, status, "
                "inputs, max_credits, charged_credits, request_hash, started_by, error_code, finished_at) "
                "values (gen_random_uuid(), %s, %s, %s, 1, 'failed', '{\"idea\": \"x\"}', 8, 4, %s, %s, 'step_failed', now()) "
                "returning id", [t.org, WORKFLOW[k], f"Flow {k.upper()}", hashlib.md5(k.encode()).hexdigest(),
                                 t.actor.uid]))
            s.rows("insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, "
                   "status, quoted_credits, job_id, charged_credits) "
                   "values (%s, 0, %s, 't2i', 'img-x', '{\"prompt\": \"x\"}', 'completed', 4, %s, 4) returning 1",
                   [RUN[k], t.org, t.creative_job])
            s.rows("insert into public.workflow_run_steps (run_id, step_index, org_id, capability, model, params, "
                   "status, quoted_credits) "
                   "values (%s, 1, %s, 't2i', 'img-x', '{\"prompt\": \"a poster\"}', 'skipped', 4) returning 1",
                   [RUN[k], t.org])
