"""Security-lab contract for migration 0058 (editing a storyboard before it
is approved, and re-opening one whose render failed).

No new table: 0058 adds columns to ``storyboards`` (0057) and functions. Wired
in from sec_expectations.py, at the bottom:

    import sec_storyboard_0058; sec_storyboard_0058.extend(TABLES, FUNCTIONS)

The named attacks are in test_sec_storyboard_edit.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # Each checks the Run now rule itself (storyboard_lock_for_runner).
        "save_storyboard_edits": USER,
        "approve_storyboard_at": USER,
        "reopen_storyboard": USER,
        "storyboard_reopen_check": USER,
        # Internal to the functions above; no API role calls them.
        "storyboard_reopen_blocker": SERVICE,
        "storyboard_squash": SERVICE,
        "storyboard_text_problem": SERVICE,
        "storyboard_spoken_seconds": SERVICE,
    })
