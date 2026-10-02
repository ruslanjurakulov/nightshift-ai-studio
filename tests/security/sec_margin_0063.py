"""Security-lab contract for migration 0063 (the operator's margin report).

No table: 0063 adds one SECURITY DEFINER function, operator_margin_report().
Wired in from sec_expectations.py, at the bottom:

    import sec_margin_0063; sec_margin_0063.extend(TABLES, FUNCTIONS)

A signed-in user may EXECUTE it (the Command Center reads it with the
operator's own session, never the service key), so USER here means "the
function refuses non-operators itself" — test_sec_margin_report.py is the
proof. The named attacks and the arithmetic are there too.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "operator_margin_report": USER,
    })
