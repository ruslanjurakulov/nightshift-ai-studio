"""Security-lab contract for migration 0141 (YouTube's "made for kids" declaration, per video).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_made_for_kids_0141; sec_made_for_kids_0141.extend(TABLES, FUNCTIONS)

No new table: seven columns on videos (covered row by row by the videos entry of TABLES). One new function:

  set_video_made_for_kids  USER (text, boolean, boolean, text: the video, the answer, the "not for kids" confirmation and the cut
                           the answer is about): a signed-in caller; the function reads the organization from the VIDEO row and requires an
                           administrator of it who is a real member (0112's video_approve_access). anon and the service key may
                           not call it. test_sec_made_for_kids.py attacks it.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import USER

    functions.update({
        "set_video_made_for_kids": USER,
    })
