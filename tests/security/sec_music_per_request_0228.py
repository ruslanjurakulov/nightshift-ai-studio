"""Security-lab contract for migration 0228 (the database knows `music`; a model priced per request is quoted for one request).

Kept in its own module, like sec_film_resume_0215. One hook wires it in, at the bottom of sec_expectations.py:

        import sec_music_per_request_0228; sec_music_per_request_0228.extend(TABLES, FUNCTIONS)

No new table and no new function: 0228 replaces creative_params_problem (0218) and creative_price (0224) with one hunk each, and both
stay internal (no API role may call them; members reach a quote only through quote_creative_job and its doors). Restated here so a
later file that widened either grant fails this contract by name. Attacked in tests/security/test_sec_music_per_request_0228.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        "creative_params_problem": SERVICE,
        "creative_price": SERVICE,
    })
