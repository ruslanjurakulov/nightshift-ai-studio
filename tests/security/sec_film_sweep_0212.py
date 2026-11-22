"""Security-lab contract for migration 0212 (the recorded film sweep: film_sweep_runs, film_sweep, film_sweep_status).

Kept in its own module, like sec_film_worker_0198. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_film_sweep_0212; sec_film_sweep_0212.extend(TABLES, FUNCTIONS)

The table records when each runner last swept (counts and a SQLSTATE only): no API role reads or writes it, only the service key
through film_sweep. Both functions are the service role's alone. The attacks are in test_sec_film_sweep_0212.py and
test_sec_breach_film_sweep_0212.py, each in a scratch database of its own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, Service

    tables.update({
        "film_sweep_runs": Service(),
    })
    functions.update({
        "film_sweep": SERVICE,
        "film_sweep_status": SERVICE,
    })
