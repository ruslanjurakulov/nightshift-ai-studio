"""Security-lab contract for migration 0117 (Custom Voice: voice_profiles, consents, the voice-samples bucket, ownership).

Wired in like the other per-migration files:

  * sec_expectations.py, at the bottom:
        import sec_voice_profiles_0117; sec_voice_profiles_0117.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the tenants are seeded:
        sec_voice_profiles_0117.seed(conn, sc)

Six tables, all declared Service() the way user_handles (0096) is: a person reads only THEIR OWN row (a policy no generic kind can
express, so test_sec_voice_profiles.py proves it), and no API role writes any of them, the service key included. The isolation tests
then prove that Bob reads none of Alice's rows and cannot insert, update or delete any. Alice has a voice; Bob has none.

Every function is declared: the owner's are USER (the function itself checks the owner and the organization), the worker's are
SERVICE (granted to service_role only), the pure helpers and the internal rule SERVICE (no API role at all), and
channel_voice_config_problem is a HELPER because the channels guard, a trigger that runs as the caller, asks it.
"""

from __future__ import annotations

SEED_VOICE_ID = "AliceSeedVoice000001"  # 20 letters and digits


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import HELPER, SERVICE, USER, Service

    tables.update({
        "user_voice_refs": Service(),
        "voice_profiles": Service(),
        "voice_consents": Service(),
        "voice_deletion_records": Service(),
        "voice_clone_jobs": Service(),
        "voice_channel_attachments": Service(),
    })
    functions.update({
        # the owner's own session
        "my_voice_ref": USER,
        # B1: granted to nobody until the migration that ships the worker and the UI (a server-side caller, or the grant, comes then)
        "request_voice_clone": SERVICE,
        "approve_voice": USER,
        "attach_voice_to_channel": USER,
        "detach_voice_from_channel": USER,
        "delete_voice": USER,
        "delete_voice_sample": USER,
        # the worker (service role only)
        "claim_voice_job": SERVICE,
        "finish_voice_clone": SERVICE,
        "finish_voice_task": SERVICE,
        "purge_voice_records": SERVICE,
        # asked by channels_config_guard(), which runs as the caller; takes no user
        "channel_voice_config_problem": HELPER,
        # asked by the storage insert policy, which runs as the caller (who cannot see storage.objects); takes no user
        "voice_sample_slot_free": HELPER,
        # internal: the rule and its pure helpers; no API role
        "voice_usable_by": SERVICE,
        "voice_owner_ref_for": SERVICE,
        "voice_user_org_admin": SERVICE,
        "voice_caller_member": SERVICE,
        "voice_name_problem": SERVICE,
        "voice_name_norm": SERVICE,
        "voice_real_person_patterns": SERVICE,
        "voice_declarations_problem": SERVICE,
        "voice_phrase_words": SERVICE,
        "voice_phrase_new": SERVICE,
        "voice_phrase_hash": SERVICE,
        "voice_id_norm": SERVICE,
    })


def seed(conn, sc) -> None:
    """Alice has one approved voice, its consent trail, a (finished) clone job, an attachment record and a deletion record of a
    voice that was deleted. Written by the database owner: the functions that write them need a worker and a recording. Bob has
    nothing, so the isolation tests have a row to aim at and a tenant that must not see it."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        uid = sc.alice.actor.uid
        ref = s.value("select public.voice_owner_ref_for(%s)", [uid])
        pid = s.value(
            "insert into public.voice_profiles (user_id, org_id, owner_ref, name, status, provider, provider_voice_id, "
            "approved_at) values (%s, %s, %s, 'Alice seed voice', 'approved', 'elevenlabs', %s, now()) returning id",
            [uid, sc.alice.org, ref, SEED_VOICE_ID])
        s.rows("insert into public.voice_consents (voice_profile_id, user_id, kind, consent_text_version, declarations, "
               "verification_result) values (%s, %s, 'accepted', 'v1', '{}', 'passed') returning 1", [pid, uid])
        s.rows("insert into public.voice_clone_jobs (profile_id, user_id, kind, status, finished_at) "
               "values (%s, %s, 'clone', 'succeeded', now()) returning 1", [pid, uid])
        s.rows("insert into public.voice_channel_attachments (voice_profile_id, user_id, org_id, channel_id, slot) "
               "values (%s, %s, %s, %s, 'narrator') returning 1", [pid, uid, sc.alice.org, sc.alice.channel])
        s.rows("insert into public.voice_deletion_records (voice_profile_id, owner_ref, event) "
               "values (gen_random_uuid(), %s, 'deleted') returning 1", [ref])
