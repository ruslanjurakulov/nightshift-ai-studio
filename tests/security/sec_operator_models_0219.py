"""Security-lab contract for migration 0219 (the operator route for connected assistants, the ByteDance refusal, the recorded exposure).

Wired in at the bottom of sec_expectations.py. 0219 adds no table (two columns on 0191's closed tables, which stay Service()), and
replaces three of 0191's doors (still anon's only). Its three helpers are internal: called only inside the definer doors. The named
attacks are in test_sec_oauth_creative_operator.py, in a scratch database of its own.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        "oauth_creative_operator_org": SERVICE,
        "oauth_creative_bytedance": SERVICE,
        "oauth_creative_org_model_state": SERVICE,
    })
