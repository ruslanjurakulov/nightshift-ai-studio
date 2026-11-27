"""Security-lab contract for migration 0231 (a workflow step's job is cancelled by the run's own rule, every cancel is recorded in the
database, and a browser writes no cancel row of its own). Breach 0226-R3-1 and 0226-R3-2.

Kept in its own module, like sec_org_spender_0226. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_cancel_audit_0231; sec_cancel_audit_0231.extend(TABLES, FUNCTIONS)

0231 adds no table and no function: it replaces cancel_creative_job (0198's body, same signature and grants) and adds a restrictive
insert policy on app_audit_log, whose table entry (0018/0087) stays as it is. So extend() adds nothing. No seed: the attacks run in
rolled-back transactions of the shared lab, tests/security/test_sec_cancel_audit_0231.py.
"""

from __future__ import annotations

#: The one replaced body: signature, the earlier file, its md5 and 0231's (whitespace runs read as one space).
BODIES = (("public.cancel_creative_job(uuid)", "0198", "2720d62c17ae26bce439a28280964575", "c210f8e4684e154d40f7029b5c94b893"),)
#: The policy 0231 adds.
POLICY = "app_audit_log_no_cancel_rows"


def extend(tables: dict, functions: dict) -> None:
    """Nothing to declare: cancel_creative_job keeps 0036's entry, app_audit_log its own."""
    return None
