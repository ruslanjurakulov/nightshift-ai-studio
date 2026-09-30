"""The Telegram panel's load-bearing guarantees: it is off (a no-op) unless
configured, only the admin chat's commands are honoured, and an action is only
ever an INTENT — this module never uploads and can never bypass the gate."""

import unittest

from modules.telegram_control import (
    TelegramControl,
    format_notification,
    route_command,
)


class _FakeDeps:
    def status_summary(self):
        return "All systems nominal. 3 channels active."

    def list_channels(self):
        return [
            {"channel_id": "default", "status": "ACTIVE", "auto_publish": True},
            {"channel_id": "finance", "status": "PAUSED", "auto_publish": False},
        ]

    def pending_review(self):
        return [{"video_id": "v1", "title": "The Fall of Rome"}]


class ControlConfigTestCase(unittest.TestCase):
    def test_disabled_when_unconfigured(self):
        self.assertFalse(TelegramControl(token="", chat_id="").enabled)
        self.assertFalse(TelegramControl(token="t", chat_id="").enabled)

    def test_notify_is_noop_when_disabled(self):
        # Returns False, does not raise, makes no network call.
        self.assertFalse(TelegramControl(token="", chat_id="").notify("hi"))

    def test_authorized_only_for_admin_chat(self):
        # A private chat with the bot: its id is the admin's own user id.
        c = TelegramControl(token="t", chat_id="42", admin_user_ids="")
        self.assertTrue(c.authorized("42", 42))
        self.assertTrue(c.authorized(42, "42"))
        self.assertFalse(c.authorized("99", 99))

    def test_unset_admin_authorizes_nobody(self):
        c = TelegramControl(token="t", chat_id="", admin_user_ids="")
        self.assertFalse(c.authorized("42", 42))
        self.assertFalse(c.authorized("", ""))

    # P8: in a group every member shares the chat id; authorising by chat
    # would let any member (or anyone an admin adds) publish and pause.
    def test_group_chat_authorises_the_sender_not_the_chat(self):
        c = TelegramControl(token="t", chat_id="-100123", admin_user_ids="42, 43")
        self.assertTrue(c.authorized("-100123", 42))
        self.assertTrue(c.authorized(-100123, "43"))
        self.assertFalse(c.authorized("-100123", 77), "a group member not on the allow-list was authorised")
        self.assertFalse(c.authorized("-100123", None), "a message with no sender was authorised")
        self.assertFalse(c.authorized("42", 42), "the allow-list authorised a chat other than the admin chat")

    def test_group_chat_without_an_allow_list_authorises_nobody(self):
        c = TelegramControl(token="t", chat_id="-100123", admin_user_ids="")
        self.assertFalse(c.authorized("-100123", 42))
        self.assertFalse(c.authorized("-100123", 100123))

    def test_allow_list_ignores_junk_and_negative_ids(self):
        c = TelegramControl(token="t", chat_id="-5", admin_user_ids="abc, -7, 8 ,")
        self.assertTrue(c.authorized("-5", 8))
        self.assertFalse(c.authorized("-5", -7))
        self.assertFalse(c.authorized("-5", "abc"))

    def test_allow_list_comes_from_the_environment(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {"TELEGRAM_ADMIN_USER_IDS": "55"}):
            c = TelegramControl(token="t", chat_id="-9")
        self.assertTrue(c.authorized("-9", 55))


class NotificationFormatTestCase(unittest.TestCase):
    def test_known_events_render(self):
        self.assertIn("Published", format_notification("video.published", {"title": "T", "url": "u"}))
        self.assertIn("Blocked", format_notification("publish.blocked", {"title": "T", "blocks": "originality"}))
        self.assertIn("held", format_notification("publish.held", {"title": "T"}).lower())

    def test_unknown_event_is_none(self):
        self.assertIsNone(format_notification("something.else", {}))

    def test_missing_field_does_not_crash(self):
        msg = format_notification("video.published", {})  # no title/url
        self.assertIn("?", msg)


class RouteCommandTestCase(unittest.TestCase):
    def setUp(self):
        self.control = TelegramControl(token="t", chat_id="42", admin_user_ids="")
        self.deps = _FakeDeps()

    def test_help_needs_no_auth(self):
        r = route_command("/help", "999", self.control, self.deps)
        self.assertIn("/status", r.reply)
        self.assertTrue(r.authorized)

    def test_query_refused_for_non_admin(self):
        r = route_command("/status", "999", self.control, self.deps)
        self.assertFalse(r.authorized)
        self.assertIn("Not authorized", r.reply)

    def test_status_for_admin(self):
        r = route_command("/status", "42", self.control, self.deps, user_id=42)
        self.assertIn("nominal", r.reply)

    def test_channels_lists_auto_manual(self):
        r = route_command("/channels", "42", self.control, self.deps, user_id=42)
        self.assertIn("default", r.reply)
        self.assertIn("auto", r.reply)
        self.assertIn("manual", r.reply)

    def test_pending_lists_held(self):
        r = route_command("/pending", "42", self.control, self.deps, user_id=42)
        self.assertIn("v1", r.reply)
        self.assertIn("Rome", r.reply)

    def test_publish_action_returns_intent_not_execution(self):
        r = route_command("/publish v1", "42", self.control, self.deps, user_id=42)
        self.assertEqual(r.intent, {"action": "publish", "target": "v1"})
        # The reply makes the gate invariant explicit.
        self.assertIn("gate", r.reply.lower())

    def test_action_refused_for_non_admin(self):
        r = route_command("/pause finance", "999", self.control, self.deps)
        self.assertFalse(r.authorized)
        self.assertIsNone(r.intent)  # no intent produced for an unauthorized chat

    def test_action_in_admin_group_refused_for_a_member_off_the_list(self):
        control = TelegramControl(token="t", chat_id="-100", admin_user_ids="42")
        r = route_command("/publish v1", "-100", control, self.deps, user_id=77)
        self.assertFalse(r.authorized)
        self.assertIsNone(r.intent)
        ok = route_command("/publish v1", "-100", control, self.deps, user_id=42)
        self.assertEqual(ok.intent, {"action": "publish", "target": "v1"})

    def test_query_without_a_sender_is_refused(self):
        r = route_command("/status", "42", self.control, self.deps)
        self.assertFalse(r.authorized)

    def test_action_usage_when_missing_arg(self):
        r = route_command("/publish", "42", self.control, self.deps, user_id=42)
        self.assertIn("Usage", r.reply)
        self.assertIsNone(r.intent)

    def test_botname_suffix_is_stripped(self):
        r = route_command("/status@nightshift_bot", "42", self.control, self.deps, user_id=42)
        self.assertIn("nominal", r.reply)

    def test_non_command_text(self):
        r = route_command("hello there", "42", self.control, self.deps, user_id=42)
        self.assertIn("/help", r.reply)

    def test_unknown_command(self):
        r = route_command("/frobnicate", "42", self.control, self.deps, user_id=42)
        self.assertIn("Unknown", r.reply)


if __name__ == "__main__":
    unittest.main()
