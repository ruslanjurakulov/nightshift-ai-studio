"""Security-lab contract for migration 0196 (brain_org_facts: the customer's Nightshift Brain dashboard).

Wired in at the bottom of sec_expectations.py, like the other per-migration files.

One new function, no table:

  brain_org_facts  a signed-in member of p_org only (anyone else: null). Credits charged by tool, a 14-day
                   series, usage_summary, the org's videos and memory counts. Never another org's rows, a
                   vendor cost, a price list or a margin. test_sec_brain_org_facts.py proves it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({"brain_org_facts": USER})
