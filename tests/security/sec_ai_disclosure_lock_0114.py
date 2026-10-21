"""Security-lab contract for migration 0114 (the AI-disclosure settings that lower the platform label are a platform
administrator's). One hook wires it in, at the bottom of sec_expectations.py:

    import sec_ai_disclosure_lock_0114; sec_ai_disclosure_lock_0114.extend(TABLES, FUNCTIONS)

No table is added. The attacks are in test_sec_ai_disclosure_lock.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        # Pure functions of their argument, run by channels_config_guard() as the CALLER (the browser roles).
        "ai_disclosure_norm": USER,
        "channel_label_lowering": USER,
    })
