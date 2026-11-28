"""Security-lab contract for migration 0214 (does a film's voice model speak the film's language).

Wired in at the bottom of sec_expectations.py, like the other per-migration files. One new function, no table:

  voice_language_problem  no API role at all (revoked from service_role too, like film_model_problem). quote_film runs as the
                          owner and calls it from inside. test_sec_voice_language.py exercises its answers and grants.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({"voice_language_problem": SERVICE})
