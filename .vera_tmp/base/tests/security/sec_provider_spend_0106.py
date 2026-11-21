"""Security-lab contract for migration 0106 (idempotent video_costs mirror and the
owner's provider-spend aggregate).

No table is added and none gains a grant or a policy: 0106 adds a nullable
column and a unique index to video_costs, and one SECURITY DEFINER function,
owner_provider_spend(). Wired in from sec_expectations.py, at the bottom:

    import sec_provider_spend_0106; sec_provider_spend_0106.extend(TABLES, FUNCTIONS)

A signed-in user may EXECUTE it (the Command Center reads it with the operator's
own session), so USER here means "the function refuses non-operators itself" —
test_sec_provider_spend.py is the proof, with the arithmetic.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "owner_provider_spend": USER,
    })
