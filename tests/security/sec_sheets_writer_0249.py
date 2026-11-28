"""Security-lab contract for migration 0249 (the one writer of a Nightshift AI conversation's character sheets and film link).

Wired in at the bottom of sec_expectations.py. 0249 adds no table: ai_chat_save_sheets is the author's own call (it asks auth.uid()
and 0199's editor rule itself), ai_chat_sheet_problem is internal, and the trigger function ai_chat_sessions_keep_sheets is not
listed (trigger functions never are). Behaviour: tests/security/test_sec_sheets_writer_0249.py.

GUARD is the one list the tests and the drift pins read: the body 0249 relies on, unchanged (whitespace runs read as one space, the
way the file's own guard reads them).
"""

from __future__ import annotations

#: (signature, the md5 0249 is written on). 0249 replaces no body.
GUARD = (
    ("public.ai_chat_save_brief(uuid, jsonb, text)", "16f6ce5d2815675860bbce0a1a1810ac"),
)


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        "ai_chat_save_sheets": USER,
        # The shape rule of one stored sheet: internal, read by ai_chat_save_sheets only.
        "ai_chat_sheet_problem": SERVICE,
    })
