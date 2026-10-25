"""Security-lab contract for migration 0127 (the per-person and platform-wide plan caps, finding F4). One hook wires it in, at the bottom of
sec_expectations.py:

    import sec_series_plan_caps_0127; sec_series_plan_caps_0127.extend(TABLES, FUNCTIONS)

One table, Service(): no API role reads or writes it (the isolation tests then prove that a tenant, an anon caller and the operator read nothing
and cannot insert). The migration makes the row itself (3 and 30), so there is nothing to seed. The table's two functions are trigger functions,
which the catalog test does not list (as for 0124's). request_series_plan keeps the SERVICE entry 0120 gave it: granted to nobody, before and after 0127.
The attacks, the races and the file's own refusals are in test_sec_series_plan_caps.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import Service

    tables.update({"series_plan_cap_settings": Service()})
