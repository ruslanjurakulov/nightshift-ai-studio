"""Security-lab contract for migration 0065 (the Style Library's add function).

Kept in its own module, like sec_style_0047. One hook wires it in:

  * sec_expectations.py, at the bottom:
        import sec_style_0065; sec_style_0065.extend(TABLES, FUNCTIONS)

No new table, and the seed needs nothing: the named attacks in
test_sec_style_library.py add their own library kits inside rolled-back
transactions. 0065 only adds a column to style_kits (already declared) and one
function: add_library_style_kit, callable by a signed-in user, who must be an
editor of the organization it names.
"""

from __future__ import annotations

ADD = "select public.add_library_style_kit(%s, %s, %s, %s)"


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "add_library_style_kit": USER,
    })
