"""Security-lab contract for migrations 0086 (channel configuration lock), 0087
(audit trail and web rate counter) and 0088 (failover reason).

Kept in its own module, like sec_router_0075. One hook wires it in:

  * sec_expectations.py, at the bottom:
        import sec_channel_lock_0086; sec_channel_lock_0086.extend(TABLES, FUNCTIONS)

No table is added. The named attacks are in test_sec_breach_channel_config.py,
test_sec_breach_audit.py and test_sec_breach_leaks.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # The only way a browser creates a channel, writes its credential or
        # changes its status (the table's own INSERT / credential_ref / status
        # privileges are revoked). Each checks the organization role itself.
        "create_channel": USER,
        "set_channel_credential": USER,
        "set_channel_status": USER,
        # Internal: called only inside the functions and triggers above.
        "channel_admin_controls": SERVICE,
        "channel_controls_changed": SERVICE,
        "channel_verified_stamp": SERVICE,
        "channel_credential_build": SERVICE,
        "channel_may_stamp": SERVICE,
        "audit_action_allowed": SERVICE,
    })
