"""Security-lab contract for migration 0230 (the country gate reads an allow-list vendor's own list; BR-S6-04).

Wired in at the bottom of sec_expectations.py. 0230 adds no table and no callable function: it replaces 0208's creative_jobs_geo_gate
(a trigger function, which no API role may call, service_role included) in place. geo_claim_country keeps 0208's contract (SERVICE in
this map: not callable by anon or authenticated, and revoked from service_role too, which tests/test_geo_gate_image_size_migration.py
pins). The named attacks are in test_sec_geo_allowlist_0230.py, in a scratch database of its own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    # Restated, not new: 0230 must leave 0208's claim reader exactly as closed as it was.
    functions.update({"geo_claim_country": SERVICE})
