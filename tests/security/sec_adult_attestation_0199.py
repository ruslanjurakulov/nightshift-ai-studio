"""Security-lab contract for migration 0199 (the adult attestation: an append-only, one-row-per-person record of who confirmed
they are 18 or older, and a gate in front of every quote and job).

Kept in its own module, like sec_rights_acknowledgement_0174. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_adult_attestation_0199; sec_adult_attestation_0199.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_adult_attestation_0199.seed(conn, sc)

The seed writes what production writes: each tenant's member confirms they are an adult through record_adult_attestation(), in
their own session. The isolation suite then has one row per person to aim at (Person: nobody else reads it, the platform admin
included). The named attacks, which commit, run in a scratch database of their own: test_sec_adult_attestation.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Person

    tables.update({
        # One person's own answer: they read it, nobody else does, and no API role (the service key included) writes it:
        # record_adult_attestation() is the only write path, and a trigger refuses UPDATE / DELETE / TRUNCATE even for the owner.
        "adult_attestations": Person("user_id"),
    })
    functions.update({
        "record_adult_attestation": USER,
        "my_adult_attestation": USER,
        # Internal: called only inside the quote, route and job functions (security definer, as their owner).
        "model_requires_adult": SERVICE,
        "adult_attestation_state": SERVICE,
        "adult_attestation_missing": SERVICE,
        "adult_attestation_gate": SERVICE,
        # Internal: quote_film and start_film read the film's adult refusals through it.
        "film_adult_refusals": SERVICE,
    })


def seed(conn, sc) -> None:
    from sec_db import acting

    for t in sc.tenants():
        with acting(conn, t.actor, commit=True) as s:
            out = s.value("select public.record_adult_attestation(true, '2026-11-20', 'email_signup')")
            assert out["state"] == "adult" and out["recorded"] is True, out
