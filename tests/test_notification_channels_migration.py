"""supabase/migrations/0102_notification_channels.sql — the database half of
Telegram notifications, pinned as text (the security lab runs the attacks:
tests/security/test_sec_notify_channels.py)."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0102_notification_channels.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())

NEW_FUNCTIONS = (
    "notification_pref_event_ok", "notification_pref_default", "notification_pref_enabled", "notification_fanout",
    "notification_link_start", "notification_channel_disconnect", "notification_channel_set_locale",
    "notification_channel_set_paused", "notification_pref_set", "notification_pref_effective",
    "notification_test_send", "notify_telegram_update_claim", "notification_link_peek",
    "notification_link_consume", "notification_channel_mark", "claim_notification_outbox",
    "complete_notification_outbox")
DEFINER = tuple(f for f in NEW_FUNCTIONS if f not in ("notification_pref_event_ok", "notification_pref_default"))
BROWSER = ("notification_link_start", "notification_channel_disconnect", "notification_channel_set_locale",
           "notification_channel_set_paused", "notification_pref_set", "notification_pref_effective",
           "notification_test_send")
SERVICE = ("notify_telegram_update_claim", "notification_link_peek", "notification_link_consume",
           "notification_channel_mark", "claim_notification_outbox", "complete_notification_outbox")
TABLES = ("notification_channels", "notification_link_tokens", "notification_preferences", "notification_outbox",
          "notify_telegram_updates")


def head(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$", 1)[0]


def body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$", 2)[1]


def grantees(name):
    return sorted(r.strip() for m in re.finditer(rf"grant execute on function public\.{name}\([^)]*\) to ([a-z_, ]+);", CODE)
                  for r in m.group(1).split(","))


class NotificationChannelsMigration(unittest.TestCase):
    def test_number_is_the_next_free_one_and_unique(self):
        names = sorted(p.name for p in (ROOT / "supabase" / "migrations").glob("0102_*.sql"))
        self.assertEqual(names, ["0102_notification_channels.sql"])

    def test_is_additive_and_replaces_no_existing_function(self):
        self.assertNotRegex(CODE, r"\bdrop (table|column|function)\b")
        self.assertNotRegex(CODE, r"\balter table public\.(?!notification_|notify_)")
        created = re.findall(r"create or replace function public\.(\w+)\(", CODE)
        self.assertEqual(sorted(created), sorted(NEW_FUNCTIONS))
        for t in TABLES:
            self.assertIn(f"create table if not exists public.{t} ", CODE)
        self.assertIn("drop trigger if exists notifications_fanout on public.notifications;", CODE)

    def test_the_warning_that_merging_applies_it_is_in_the_file(self):
        self.assertIn("APPLYING THIS FILE CHANGES THE LIVE DATABASE", SQL)

    def test_security_definer_functions_pin_the_search_path(self):
        for name in DEFINER:
            self.assertIn("security definer set search_path = public, pg_temp", head(name), name)

    def test_every_table_has_rls_and_no_api_role_can_write(self):
        for t in TABLES:
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
            self.assertIn(f"revoke all on public.{t} from public, anon, authenticated, service_role;", CODE)
        self.assertNotRegex(CODE, r"grant (insert|update|delete|all)")
        self.assertNotRegex(CODE, r"create policy \w+ on public\.\w+\s+for (insert|update|delete|all)")
        self.assertNotRegex(CODE, r"grant [^;]* to (public|anon)\b")

    def test_the_chat_id_is_not_in_the_browsers_column_list(self):
        m = re.search(r"grant select \(([^)]*)\)\s+on public\.notification_channels to authenticated", CODE)
        self.assertIsNotNone(m)
        self.assertNotIn("external_id", m.group(1))
        self.assertNotIn("grant select on public.notification_channels", CODE)

    def test_grants_split_browser_from_webhook_and_worker(self):
        for name in BROWSER:
            self.assertEqual(grantees(name), ["authenticated"], name)
        for name in SERVICE:
            self.assertEqual(grantees(name), ["service_role"], name)
        for name in ("notification_fanout", "notification_pref_enabled", "notification_pref_default"):
            self.assertEqual(grantees(name), [], name)
            self.assertIn(f"revoke all on function public.{name}(", CODE)

    def test_the_token_is_stored_hashed_single_use_and_short_lived(self):
        self.assertIn("token_hash bytea not null", CODE)
        self.assertNotRegex(CODE, r"\btoken\s+text\b.*not null")
        self.assertIn("octet_length(token_hash) = 32", CODE)
        self.assertIn("interval '10 minutes'", body("notification_link_start"))
        consume = body("notification_link_consume")
        for must in ("for update", "used_at is not null", "expires_at <= now()", "'private'",
                     "p_ext_user_id is distinct from p_external_id", "set used_at = now()"):
            self.assertIn(must, consume)
        self.assertIn("take_web_rate('notify.link', 5, 3600)", body("notification_link_start"))
        self.assertIn(">= 3", body("notification_link_start"))

    def test_the_token_alphabet_fits_telegrams_start_parameter(self):
        self.assertIn("left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 56)", body("notification_link_start"))
        self.assertEqual(CODE.count("'^[0-9a-f]{56}$'"), 2)

    def test_the_fanout_is_idempotent_capped_and_never_breaks_the_bell(self):
        f = body("notification_fanout")
        self.assertIn("on conflict (idempotency_key) do nothing", f)
        self.assertIn("exception when others then", f)
        self.assertIn("raise warning", f)
        self.assertIn("recent >= 30", f)
        self.assertIn("c.status = 'active'", f)
        self.assertIn("create unique index if not exists notification_outbox_idempotency_key", CODE)

    def test_a_lost_claim_is_never_resent_and_blocked_is_final(self):
        claim = body("claim_notification_outbox")
        self.assertIn("for update skip locked", claim)
        self.assertIn("'unconfirmed'", claim)
        self.assertIn("interval '24 hours'", claim)
        done = body("complete_notification_outbox")
        self.assertIn("x.claimed_by = p_worker", done)
        self.assertIn("status = 'blocked'", done)
        self.assertIn("least(30 * power(2,", done)

    def test_language_is_a_code_not_a_fixed_triple(self):
        self.assertNotIn("('en', 'ru', 'uz')", CODE)
        self.assertEqual(CODE.count("'^[a-z]{2,3}$'"), 5)

    def test_the_verify_query_is_at_the_end(self):
        tail = SQL.split("-- Verify", 1)[1]
        for word in ("rls_on", "tables_scoped", "functions_scoped", "definer_functions_pin_search_path", "fanout_on"):
            self.assertIn(word, tail)


if __name__ == "__main__":
    unittest.main()
