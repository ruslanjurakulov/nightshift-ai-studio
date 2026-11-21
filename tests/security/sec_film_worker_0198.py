"""Security-lab contract for migration 0198 (Film Studio P3: a switch per organization, and the take's creative job).

Kept in its own module, like sec_films_0171. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_film_worker_0198; sec_film_worker_0198.extend(TABLES, FUNCTIONS)

No seed: the shared lab's tenants stay switched off (0198's default), which is what the isolation tests should meet. The worker's
paths (two claims, the capture, the sweep, the switch) are attacked in a scratch database of their own: test_sec_film_worker.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # A signed-in caller reaches the setter, and owner_guard refuses everyone but a platform owner/admin (42501).
        "set_org_film_studio_enabled": USER,
        # The worker's: the service role only.
        "film_studio_on_for": SERVICE,
        "film_take_job": SERVICE,
        # Internal: called only inside film_take_job.
        "film_take_inputs": SERVICE,
    })
