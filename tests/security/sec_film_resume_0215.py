"""Security-lab contract for migration 0215 (Film Studio: archive a paused or cancelled film, resume a paused one; the worker's id
kept out of what members read).

Kept in its own module, like sec_film_worker_0198. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_film_resume_0215; sec_film_resume_0215.extend(TABLES, FUNCTIONS)

No new table (0215 adds columns to film_segments, film_takes and film_quotes, whose expectations 0171 already declares). No seed:
the paths are attacked in a scratch database of their own, tests/security/test_sec_film_resume_0215.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # The browser's two resume calls: a signed-in admin's (each refuses anyone else by role inside).
        "quote_film_resume": USER,
        "start_film_resume": USER,
        # A failed assembly made again (every take made): the same caller rules, then start_film_resume.
        "rerun_film_assembly": USER,
        # Internal: the retryable assembly failure words, read by the quote and the start.
        "film_assembly_retryable": SERVICE,
        # Internal and standalone (0226 reuses it): a seat in org_members of the role, or platform staff in the exempt organization.
        "is_org_spender": SERVICE,
        # Internal: called only inside the two above.
        "film_resume_price": SERVICE,
        "film_resume_precheck": SERVICE,
        "film_resume_done": SERVICE,
    })
