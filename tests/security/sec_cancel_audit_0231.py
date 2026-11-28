"""Security-lab contract for migration 0231 (a workflow step's job is cancelled by the run's own rule, every cancel and every real stop
is recorded in the database, a browser writes no cancel row of its own, and no member takes a workflow step's idempotency key).
Breach 0226-R3-1, 0226-R3-2, 0231-R4-1 and 0231-R4-2.

Kept in its own module, like sec_org_spender_0226. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_cancel_audit_0231; sec_cancel_audit_0231.extend(TABLES, FUNCTIONS)

0231 adds no table and no function: it replaces four bodies (same signatures and grants) and adds a restrictive
insert policy on app_audit_log, whose table entry (0018/0087) stays as it is. So extend() adds nothing. No seed: the attacks run in
rolled-back transactions of the shared lab, tests/security/test_sec_cancel_audit_0231.py.
"""

from __future__ import annotations

#: The four replaced bodies: signature, the earlier file, its md5 and 0231's (whitespace runs read as one space).
BODIES = (
    ("public.cancel_creative_job(uuid)", "0198", "2720d62c17ae26bce439a28280964575", "c210f8e4684e154d40f7029b5c94b893"),
    ("public.create_creative_job(uuid, text, text, jsonb, text, text, numeric)", "0226",
     "ab939bb64ef626e30c1438c6030d8801", "88c83aa87050731c96ce8a0a5bb28b0a"),
    ("public.workflow_advance_locked(uuid, boolean)", "0192", "553dd9f65b62541fd3653ed55288ae46", "37fda6dc6caf182483f10314d166579c"),
    ("public.cancel_workflow_run(uuid)", "0226", "427ead0896b4881c0739b944997c6b50", "c09c0dbdd8207bab0fc6d3175276fbf2"),
)
#: The policy 0231 adds.
POLICY = "app_audit_log_no_cancel_rows"


def extend(tables: dict, functions: dict) -> None:
    """Nothing to declare: the four functions keep their entries, app_audit_log its own."""
    return None
