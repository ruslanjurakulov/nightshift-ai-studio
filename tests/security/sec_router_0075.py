"""Security-lab contract for migration 0075 (Model Router v1).

Kept in its own module, like sec_captions_0072. One hook wires it in:

  * sec_expectations.py, at the bottom:
        import sec_router_0075; sec_router_0075.extend(TABLES, FUNCTIONS)

No table is added (two columns on creative_jobs, read like the row). The named
attacks are in test_sec_model_router.py, in a scratch database of their own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import API, SERVICE, USER

    functions.update({
        # A member's quote of a routed mode (the Studio's "Auto").
        "quote_creative_route": USER,
        # The worker's failover, routed modes only.
        "reroute_creative_job": SERVICE,
        # Internal: called only inside the definer functions above; no API role.
        "route_model": SERVICE,
        "creative_route_quote": SERVICE,
        # api_creative_quote gains a six-argument overload (p_mode): the same
        # declaration covers both (anon, the key checked by api_begin first).
        "api_creative_quote": API,
    })
