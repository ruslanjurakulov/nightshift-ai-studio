"""Security-lab contract for migration 0238 (a model with a country list may go on sale only with its vendor's allow-list, behind
0230's gate).

Wired in at the bottom of sec_expectations.py. 0238 adds no table and no callable function: it replaces one CHECK on model_registry
(0142's model_registry_countries_before_sale, same name). It relies on 0208's claim reader staying closed to every API role, restated
here. The named attacks are in test_sec_country_sale_0238.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    # Restated, not new: the gate 0238 opens sale behind reads this claim; no API role may call it (no oracle to test claims).
    functions.update({"geo_claim_country": SERVICE})
