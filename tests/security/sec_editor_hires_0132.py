"""Security-lab contract for migration 0132 (1440p and 4K editor exports, sold by the started minute). One hook wires it in, at the bottom of
sec_expectations.py:

    import sec_editor_hires_0132; sec_editor_hires_0132.extend(TABLES, FUNCTIONS)

One table, Service(): no API role reads or writes the owner's prices (the isolation tests then prove that a tenant, an anon caller and the
operator read nothing and cannot insert). The migration makes the row itself (both prices NULL), so there is nothing to seed. The settling
trigger and the price table's two triggers are trigger functions, which the catalog test does not list. request_editor_export keeps 0054's
USER entry (the four-argument overload is granted like the others: to authenticated only). The attacks, the money and the file's own
refusals are in test_sec_editor_hires_export.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({"editor_export_hires_prices": Service()})
    functions.update({
        # The price a member sees before confirming: membership-checked inside, signed-in only.
        "quote_editor_export": USER,
        # Internal: called only inside the export functions and the settling trigger.
        "editor_export_hires_terms": SERVICE,
        "editor_export_money": SERVICE,
    })
