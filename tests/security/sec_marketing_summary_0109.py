"""Security-lab contract for migration 0109 (the operator bot's read of the brand-channel poster).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_marketing_summary_0109; sec_marketing_summary_0109.extend(TABLES, FUNCTIONS)

One function, no table. operator_marketing_summary() is SERVICE: neither anon nor authenticated may execute it (the
poster's tables grant no API role anything the browser could use except the admin read of 0108, and the bot reads
through this function with the service key). What it returns, and that it returns no text, is proved in
test_sec_marketing_summary.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({"operator_marketing_summary": SERVICE})
