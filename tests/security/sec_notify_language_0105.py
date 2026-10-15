"""Security-lab contract for migration 0105 (a chosen language for the customer
notifications).

Wired in at the bottom of sec_expectations.py, like sec_notify_channels_0102:

    import sec_notify_language_0105; sec_notify_language_0105.extend(TABLES, FUNCTIONS)

No table is added and none gains a grant (the language is the existing
notification_channels.locale and a new column on the closed email_preferences),
so only the three new functions are declared. The named attacks are in
test_sec_notify_language.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER

    functions.update({
        # the Settings selector for the e-mail language: the caller's own row
        "email_prefs_set_language": USER,
        # the bot's /language and its language buttons (service key only)
        "notification_channel_set_locale_by_chat": SERVICE,
        # internal: the allow-list the locale CHECKs and every language argument use
        "notify_language_ok": SERVICE,
    })
