"""Security-lab contract for migration 0193 (the public names of the models on sale, for the landing page).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_public_models_0193; sec_public_models_0193.extend(TABLES, FUNCTIONS)

One new function, no table:

  public_models_on_sale  anon and authenticated: display_name, capability codes and 0192's adults-only mark of what
                         sellable_models(null, 'web') lists, and
                         nothing else (no id, provider, price, unit, margin or spec). test_sec_public_models.py proves it, and that
                         sellable_models itself stays closed to anon.
"""

from __future__ import annotations

#: Anyone may call it, signed in or not: it hands out names only.
PUBLIC_READ = (True, True)


def extend(tables: dict, functions: dict) -> None:
    functions.update({"public_models_on_sale": PUBLIC_READ})
