"""Security-lab contract for migration 0175 (the failed-job cap: 5 failed or refused creative jobs per organization per 24 hours).

Kept in its own module, like sec_rights_acknowledgement_0174. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_failed_job_cap_0175; sec_failed_job_cap_0175.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_failed_job_cap_0175.seed(conn, sc)

0175 adds no table and writes no row: there is nothing for the isolation suite to aim at. The seed records that each tenant
starts BELOW the limit (a seeded scenario that was already refused would make every creative attack in the suite pass for the
wrong reason). The named attacks, which commit, run in a scratch database of their own: test_sec_failed_job_cap.py.
"""

from __future__ import annotations

from typing import Dict

#: Per tenant key ('a' / 'b'): the tenant's counted failures in the last 24 hours when the scenario was built.
COUNTED: Dict[str, int] = {}


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        # Internal: called only inside create_creative_job and start_workflow_run, under the org's account lock. No API role
        # may call the gate: it would answer another organization's count.
        "creative_failed_job_codes": SERVICE,
        "creative_failed_job_gate": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        for t in sc.tenants():
            n = s.value("select count(*) from public.creative_jobs where org_id = %s and status = 'failed' "
                        "and finished_at > now() - interval '24 hours' and error_code = any (public.creative_failed_job_codes())",
                        [t.org])
            assert n < 5, f"tenant {t.key} starts at the failed-job limit ({n}): every creative attack would be refused by 0175"
            COUNTED[t.key] = n
