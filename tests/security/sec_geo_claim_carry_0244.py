"""Security-lab contract for migration 0244 (a film take and a workflow step carry the country their start verified).

Wired in at the bottom of sec_expectations.py. One closed table: creative_geo_carry (row security on, no policy, nothing granted to
anon, authenticated or service_role; written only inside start_film, start_film_resume and start_workflow_run, never updated). Two
internal functions no API role may call, the service role included: creative_geo_refusal (0230's rule, moved out of the gate) and
creative_geo_carried (what a new creative_jobs row carries). creative_geo_carry_frozen is a trigger function (not listed). The five
bodies 0244 replaces keep their entries above. The named attacks are in test_sec_geo_claim_carry_0244.py, in a scratch database.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, Service

    tables.update({"creative_geo_carry": Service()})
    functions.update({"creative_geo_refusal": SERVICE, "creative_geo_carried": SERVICE})
