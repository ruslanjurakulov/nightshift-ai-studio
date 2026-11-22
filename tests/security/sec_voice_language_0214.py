"""Security-lab contract for migration 0214 (does a film's voice model speak the film's language).

Wired in at the bottom of sec_expectations.py, like the other per-migration files. One new function, no table:

  voice_language_problem  service_role only. quote_film (security definer) calls it from inside; neither API role may probe the
                          registry with it one model id at a time. test_sec_voice_language.py exercises its answers.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({"voice_language_problem": SERVICE})
