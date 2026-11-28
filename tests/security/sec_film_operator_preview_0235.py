"""Security-lab contract for migration 0235 (Film Studio lets the platform operator use an operator-preview model in the operator's
own organization).

Wired in at the bottom of sec_expectations.py. 0235 adds no table. Its two functions are four-argument overloads of names 0166 and 0171
already declared (film_check_model, film_model_problem): the catalog keys functions by name, so the entry below restates their contract
for every overload. Both are internal (called only inside the security-definer Film functions, which run them as their owner): no API
role may execute them, service_role included (the service role has no JWT, so creative_operator_preview would refuse it anyway, and a
direct call would only be a way to probe the registry). tests/security/test_sec_film_operator_preview_0235.py checks every role on the
four-argument signatures themselves, and the named attacks.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({"film_check_model": SERVICE, "film_model_problem": SERVICE})
