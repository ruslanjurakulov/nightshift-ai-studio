"""Security-lab contract for migration 0123 (the owner's vendor API keys, kept in Vault). One hook wires it in, at the bottom of
sec_expectations.py:

    import sec_model_api_keys_0123; sec_model_api_keys_0123.extend(TABLES, FUNCTIONS)

and in sec_scenario.build_scenario(), after the tenants are seeded:

    sec_model_api_keys_0123.seed(conn, sc)

Two tables:

  model_api_key_status  Platform: the platform owner reads it (one select policy); nobody writes it directly. The scenario seeds one row (xai).
  model_api_key_refs    Service: the Vault secret id of each key. No API role reads or writes it.

Three functions are USER (a signed-in caller; each refuses everyone but the platform owner itself, which test_sec_model_api_keys.py proves),
two are internal (no API role may execute them). The attacks are in test_sec_model_api_keys.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Platform, Service

    tables.update({
        "model_api_key_status": Platform(),
        "model_api_key_refs": Service(),
    })
    functions.update({
        "owner_model_key_store": USER,
        "owner_model_key_remove": USER,
        "owner_model_key_status": USER,
        # internal: only the functions above (running as the owner) reach them
        "model_key_owner_gate": SERVICE,
        "model_key_provider_ok": SERVICE,
    })


#: The one vendor the scenario stores a key for. The attack tests use other vendors, so this row stays out of their way.
SEED_PROVIDER = "xai"


def seed(conn, sc) -> None:
    """One stored key, written by the database owner (the functions that write one need the owner's session and would add audit rows the
    other lab files count). The isolation tests clone a row of every declared table, so each table needs one; nothing here is a tenant's."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        sid = s.value("select vault.create_secret(%s, %s)", ["xai-lab-seed-key-0000-seed", f"nightshift_model_key:{SEED_PROVIDER}:lab-seed"])
        s.rows("insert into public.model_api_key_refs (provider, vault_secret_id) values (%s, %s) returning 1", [SEED_PROVIDER, sid])
        s.rows("insert into public.model_api_key_status (provider, status, last4, checked_by, checked_by_email) "
               "values (%s, 'verified', 'seed', %s, %s) returning 1", [SEED_PROVIDER, sc.operator.uid, sc.operator.email])
