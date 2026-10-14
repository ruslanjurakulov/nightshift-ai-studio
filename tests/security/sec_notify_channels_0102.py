"""Security-lab contract for migration 0102 (Telegram notification channels).

Hooked in like sec_user_handles_0096:

  * sec_expectations.py, at the bottom:
        import sec_notify_channels_0102; sec_notify_channels_0102.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario():
        sec_notify_channels_0102.seed(conn, sc)

Every table is declared Service(): the isolation tests then prove that a
customer, a stranger and the anon key read none of ANOTHER person's row and
cannot insert, update or delete any. That a person reads their OWN channel and
preference rows, and never the chat id, is proven in test_sec_notify_channels.py.
"""

from __future__ import annotations

CHAT_ALICE = "7001001"


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Service

    tables.update({
        "notification_channels": Service(),
        "notification_link_tokens": Service(),
        "notification_preferences": Service(),
        "notification_outbox": Service(),
        "notify_telegram_updates": Service(),
    })
    functions.update({
        # the signed-in person, on their own rows
        "notification_link_start": USER,
        "notification_channel_disconnect": USER,
        "notification_channel_set_locale": USER,
        "notification_channel_set_paused": USER,
        "notification_pref_set": USER,
        "notification_pref_effective": USER,
        "notification_test_send": USER,
        # the customer bot's webhook and the notify worker (service key only)
        "notification_link_peek": SERVICE,
        "notification_link_consume": SERVICE,
        "notification_channel_mark": SERVICE,
        "notify_telegram_update_claim": SERVICE,
        "claim_notification_outbox": SERVICE,
        "complete_notification_outbox": SERVICE,
        # internal: the trigger and the preference defaults
        "notification_pref_event_ok": SERVICE,
        "notification_pref_default": SERVICE,
        "notification_pref_enabled": SERVICE,
    })


def seed(conn, sc) -> None:
    """Alice has a linked chat, one preference row and one queued message,
    written by the database owner (as only the functions may write). Bob and the
    stranger have none: the isolation tests then prove a customer reads none of
    ANOTHER person's rows (own rows are read through the person's own policy,
    which the generic kinds cannot express; test_sec_notify_channels.py does)."""
    from sec_db import as_superuser

    with as_superuser(conn) as s:
        ch = s.value(
            "insert into public.notification_channels (user_id, kind, external_id, label, locale) "
            "values (%s, 'telegram', %s, 'Lab', 'en') returning id",
            [sc.alice.actor.uid, CHAT_ALICE])
        s.rows("insert into public.notification_preferences (user_id, event_kind, channel_kind, enabled) "
               "values (%s, 'credits_low', 'telegram', false) returning 1", [sc.alice.actor.uid])
        s.rows("insert into public.notification_outbox (user_id, channel_id, channel_kind, event_kind, locale, "
               "idempotency_key, status, last_error_code) values (%s, %s, 'telegram', 'test', 'en', %s, 'skipped', 'capped') "
               "returning 1", [sc.alice.actor.uid, ch, f"seed:{sc.alice.actor.uid}"])
        # A pending link of Alice's (the hash of a made-up token) and a handled update.
        s.rows("insert into public.notification_link_tokens (user_id, kind, token_hash, expires_at) "
               "values (%s, 'telegram', sha256(convert_to(%s, 'UTF8')), now() + interval '10 minutes') returning 1",
               [sc.alice.actor.uid, "f" * 56])
        s.rows("insert into public.notify_telegram_updates (update_id) values (1) returning 1")
