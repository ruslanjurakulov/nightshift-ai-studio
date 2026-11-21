"""Security-lab contract for migration 0107 (owner safety: the second-factor gate, the audited owner
actions and the security trail).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_owner_safety_0107; sec_owner_safety_0107.extend(TABLES, FUNCTIONS)

Three tables, none readable or writable by an API role except the one SELECT policy noted below:

  owner_security_settings  Service: the gate flag and the caps. Definer functions and the SQL editor only.
  security_events          Service: the append-only trail. Platform admins read it through
                           owner_security_events(); the service key may SELECT.
  credit_price_history     Platform: a platform admin may SELECT (one policy); nobody writes it.

Every function is declared: the owner actions and the gate's readers are USER (a signed-in caller; the
function itself raises 42501 for anyone who is not a platform owner/admin, which
test_sec_owner_safety.py proves), the rest are internal (SERVICE: no API role may execute them).
The named attacks and behaviours are in test_sec_owner_safety.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import HELPER, SERVICE, USER, Platform, Service

    tables.update({
        "owner_security_settings": Service(),
        "security_events": Service(),
        "credit_price_history": Platform(),
    })

    functions.update({
        # reports whether the caller passes the gate (their own state only)
        "admin_aal_ok": HELPER,
        # the Security page and the owner actions (each checks platform owner/admin itself)
        "owner_security_get": USER,
        "owner_security_events": USER,
        "enable_admin_mfa": USER,
        "disable_admin_mfa": USER,
        "owner_grant_credits": USER,
        "owner_reverse_grant": USER,
        "owner_set_credit_price": USER,
        "owner_delete_credit_price": USER,
        "owner_restore_credit_price": USER,
        "owner_add_member": USER,
        "owner_set_member_role": USER,
        "owner_remove_member": USER,
        # internal: only the functions above (running as the owner) reach them
        "admin_mfa_state": SERVICE,
        "owner_guard": SERVICE,
        "owner_admin_factors": SERVICE,
        "owner_price_write": SERVICE,
        "owner_audit": SERVICE,
        "security_event_log": SERVICE,
        "owner_err": SERVICE,
    })
