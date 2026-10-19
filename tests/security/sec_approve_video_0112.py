"""Security-lab contract for migration 0112 (the review panel's Approve is a decision bound to the exact cut).

Wired in at the bottom of sec_expectations.py, like the other per-migration files:

    import sec_approve_video_0112; sec_approve_video_0112.extend(TABLES, FUNCTIONS)

No new table. Three new functions:

  approve_video_publish    USER: a signed-in caller; the function reads the organization from the VIDEO row and requires an
                           administrator of that organization who is a real member of it (a platform admin is not one of a
                           customer's). anon and the service key may not call it.
  video_publish_refusal    SERVICE: the rule a worker applies right before it would act on an approval (Phase 1b).
  video_approve_refusal    SERVICE: the eligibility half of the two; no API role may execute it at all (the migration
                           revokes all four), only the definer functions that call it do.

review_intents keeps its declaration (own_insert: an editor still files regenerate requests directly); only the action
'approve' is closed, which test_sec_approve_video.py proves. The seeded intent of the scenario is a 'regenerate' request
for that reason (the isolation tests clone it through the browser's own policy).
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        "approve_video_publish": USER,
        "video_publish_refusal": SERVICE,
        "video_approve_refusal": SERVICE,
    })
