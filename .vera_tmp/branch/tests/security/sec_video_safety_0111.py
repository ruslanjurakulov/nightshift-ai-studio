"""Security-lab contract for migration 0111 (video safety: no customer provider choice, a coded job error, the hold sweep).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_video_safety_0111; sec_video_safety_0111.extend(TABLES, FUNCTIONS)

No new table. One new function:

  render_job_public_error   SERVICE: a pure helper that api_get_job and oauth_get_job call as their owner. No API role may
                            execute it, the service key included (the migration revokes all four); test_sec_video_safety.py
                            proves it. The three functions 0111 redefines (render_jobs_payment_guard, api_get_job,
                            oauth_get_job) keep the declarations they already have.

The named attacks and behaviours are in test_sec_video_safety.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        "render_job_public_error": SERVICE,
    })
