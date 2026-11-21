"""Security-lab contract for migration 0136 (exports up to 1080p sold by the started minute). One hook wires it in, at the bottom of
sec_expectations.py:

    import sec_editor_export_paid_0136; sec_editor_export_paid_0136.extend(TABLES, FUNCTIONS)

No new table (the 1080p price is a column of 0132's closed price row). One new function, internal. The attacks, the money and the file's own
refusals are in test_sec_editor_export_paid_1080p.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        # Internal: the 1080p price, read only inside the export functions.
        "editor_export_price_1080p": SERVICE,
        # Internal: the renderer's length of a document (and its two helpers), read only inside the quote and the paid request.
        "editor_doc_rendered_length": SERVICE,
        "editor_ms": SERVICE,
        "editor_jnum": SERVICE,
    })
