"""Security-lab contract for migration 0151 (the Studio's progress seed from the platform's own probe of a model).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_model_probe_seconds_0151; sec_model_probe_seconds_0151.extend(TABLES, FUNCTIONS)

No new table. One new function:

  model_probe_seconds  USER (text[]: at most 50 model ids): a signed-in caller; it returns the newest successful probe's seconds,
                       capability, clip length and time for models on sale (or any model for a platform admin), and nothing of any
                       organization. anon and the service key may not call it. test_sec_model_probe_seconds.py attacks it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "model_probe_seconds": USER,
    })
