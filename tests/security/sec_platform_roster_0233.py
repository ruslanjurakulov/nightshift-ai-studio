"""Security-lab contract for migration 0233 (nobody changes the platform roster from a browser; BR-L-213).

Wired in at the bottom of sec_expectations.py. 0233 adds no table and no function: it revokes EXECUTE on 0107's three roster
functions from every API role (0107 had already revoked it from service_role), and INSERT, UPDATE, DELETE on app_members from anon
and authenticated. app_members keeps its Platform() entry (only the operator reads it). The named attacks are in
test_sec_roster_closed_0233.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        "owner_add_member": SERVICE,
        "owner_set_member_role": SERVICE,
        "owner_remove_member": SERVICE,
    })
