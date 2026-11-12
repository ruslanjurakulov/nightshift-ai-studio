"""Security-lab contract for migration 0135 (Character Studio: swap the people in a video for the characters in pictures).

Wired in like the other per-migration files:

  * sec_expectations.py, at the bottom:
        import sec_character_swap_0135; sec_character_swap_0135.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after 0133's seed:
        sec_character_swap_0135.seed(conn, sc)

The jobs and the consent trail are Org(): a member reads the rows of THEIR organization, and no API role writes either directly. The models
and the settings are Service(): no API role reads or writes them (the price is the owner's, in the SQL editor). The gallery's cards and
samples are Public(): any signed-in person reads them, nobody writes them through the API (the samples script's service key excepted,
which test_sec_character_swap.py pins). The four member functions are USER (each checks sign-in, membership and the role itself), the
four worker functions and the internal helpers SERVICE (no signed-in user; the worker's are granted to service_role alone, the helpers to
nobody, which the migration's own end state and test_sec_character_swap.py pin). The trigger functions are not listed.

The seed goes the way production does: a member uploads a video and a picture, declares the consent, asks for a swap (Kling, priced 0 for
the seed, then the price goes back to NULL, the shipped state), the worker claims it, records the vendor's task id, stores the output and
finishes it.
"""

from __future__ import annotations

import json
import uuid
from typing import Dict

#: Per tenant key ('a' / 'b'): ids the attacks aim at.
JOB: Dict[str, str] = {}
CONSENT: Dict[str, str] = {}
VIDEO: Dict[str, str] = {}
PICTURE: Dict[str, str] = {}
OUTPUT: Dict[str, str] = {}

WORKER = "character-swap-lab-01"
KLING = "kling-4.0-omni-edit"
SEEDANCE = "seedance-2.5-edit"
PROMPT = "Replace the person on the left with the character in @Image 1. Keep the scene."
DECLARATIONS = {"rights_to_video": True, "performers_consented": True, "no_minors": True, "references_owned_or_licensed": True,
                "data_to_provider": True}

QUOTE = "select public.quote_character_swap(%s, %s, %s)"
CONSENT_FN = "select public.record_character_swap_consent(%s, %s, %s, %s::uuid[], %s::jsonb, %s)"
REQUEST = "select public.request_character_swap(%s, %s, %s, %s::uuid[], %s, %s, %s, %s, %s, %s)"
CANCEL = "select public.cancel_character_swap(%s)"


def asset(s, org: str, kind: str = "video", *, mime: str = "", seconds=10, source: str = "pipeline", provenance=None, w=1280, h=720) -> str:
    """A library asset as the media worker registers it (the service key)."""
    from sec_db import SERVICE as SERVICE_ACTOR
    from test_sec_series_tables import become

    become(s, SERVICE_ACTOR)
    mime = mime or ("video/mp4" if kind == "video" else "image/png")
    return str(s.value("select public.register_asset(gen_random_uuid(), %s, %s, %s, 1000, %s, %s, p_width => %s::integer, "
                       "p_height => %s::integer, p_duration_s => %s::numeric, p_provenance => %s::jsonb) ->> 'id'",
                       [org, kind, mime, uuid.uuid4().hex * 2, source, w, h, seconds if kind == "video" else None,
                        json.dumps(provenance or {})]))


def output(s, org: str, job: str) -> str:
    """What the worker stores for a finished job: a generated video with the job in its provenance."""
    return asset(s, org, "video", source="generated", provenance={"origin": "character_swap", "job_id": job, "provider": "kling"})


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org, Public, Service

    tables.update({
        "character_swap_jobs": Org(),
        "character_swap_consents": Org(),
        "character_swap_models": Service(),
        "character_swap_settings": Service(),
        "character_swap_templates": Public(),
        "character_swap_template_samples": Public(),
    })
    functions.update({
        "quote_character_swap": USER,
        "record_character_swap_consent": USER,
        "request_character_swap": USER,
        "cancel_character_swap": USER,
        # the worker's (service_role only)
        "claim_character_swap": SERVICE,
        "record_character_swap_task": SERVICE,
        "finish_character_swap": SERVICE,
        "fail_character_swap": SERVICE,
        # internal: no API role at all
        "character_swap_prompt_patterns": SERVICE,
        "character_swap_norm": SERVICE,
        "character_swap_prompt_problem": SERVICE,
        "character_swap_declarations_problem": SERVICE,
        "character_swap_charge": SERVICE,
        "character_swap_hold": SERVICE,
        "character_swap_input_problem": SERVICE,
        "character_swap_end_locked": SERVICE,
        "character_swap_sweep": SERVICE,
    })


def seed(conn, sc) -> None:
    """Each tenant: one READY Kling swap (free for the seed) with its consent, and a sample on the first card. The price goes back to NULL
    afterwards: the shipped state, which the tests start from."""
    from sec_db import SERVICE as SERVICE_ACTOR, acting, as_superuser

    with as_superuser(conn) as su:
        su.rows("update public.character_swap_models set credits_per_usd = 0 where model_id = %s returning 1", [KLING])
    try:
        for t in sc.tenants():
            k = t.key
            with as_superuser(conn) as su:
                VIDEO[k] = asset(su, t.org, "video")
                PICTURE[k] = asset(su, t.org, "image")
            with acting(conn, t.actor, commit=True) as s:
                CONSENT[k] = s.value(CONSENT_FN, [t.org, KLING, VIDEO[k], [PICTURE[k]], json.dumps(DECLARATIONS), "v1"])["id"]
                JOB[k] = s.value(REQUEST, [t.org, None, VIDEO[k], [PICTURE[k]], PROMPT, KLING, "720p", CONSENT[k], 0,
                                           f"seed-swap-{k}-{uuid.uuid4().hex[:8]}"])["id"]
            with acting(conn, SERVICE_ACTOR, commit=True) as s:
                got = s.value("select public.claim_character_swap(%s)", [WORKER])
                assert got["job_id"] == JOB[k], got
                s.value("select public.record_character_swap_task(%s, %s, %s)", [JOB[k], WORKER, f"task-{k}-{uuid.uuid4().hex[:8]}"])
            with as_superuser(conn) as su:
                OUTPUT[k] = output(su, t.org, JOB[k])
            with acting(conn, SERVICE_ACTOR, commit=True) as s:
                s.value("select public.finish_character_swap(%s, %s, %s)", [JOB[k], WORKER, OUTPUT[k]])
        with as_superuser(conn) as su:
            su.rows("insert into public.character_swap_template_samples (template_id, model_id, web_url, original_object) "
                    "select id, %s, 'https://cdn.example.test/samples/two-characters/kling.mp4', "
                    "'character-samples/two-characters/kling.mp4' from public.character_swap_templates where slug = 'two-characters' "
                    "returning 1", [KLING])
    finally:
        with as_superuser(conn) as su:
            su.rows("update public.character_swap_models set credits_per_usd = null returning 1")
