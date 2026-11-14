"""Migration 0161 (ChatGPT keeps the client it registered), pinned as text.

What would break, and which test says so:

* the collector drifting from 0147's (a branch of 0093's or 0147's silently dropped while adding the ChatGPT exception):
  0161's oauth_gc must be 0147's body plus exactly the two hunks listed here, byte for byte;
* the exception reaching other vendors or growing unbounded: it names only ChatGPT's two callbacks, keeps 30 days and 3 a
  person, and only for a grant that was redeemed;
* md5 pins that no longer describe the files, a rollback that does not put 0147's body back verbatim, a helper an API
  role may call, the number not reviewed.

The lab (tests/security/test_sec_mcp_chatgpt_client.py) runs the same file on a real PostgreSQL; this test needs none.
"""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"
M0147 = (MIG / "0147_mcp_free_tier.sql").read_text(encoding="utf-8")
M0161 = (MIG / "0161_mcp_chatgpt_client.sql").read_text(encoding="utf-8")
ROLLBACK = (ROOT / "docs" / "sql" / "rollback_0161_mcp_chatgpt_client.sql").read_text(encoding="utf-8")
MIGRATIONS_DOC = (ROOT / "docs" / "MIGRATIONS.md").read_text(encoding="utf-8")


def definition(text: str, name: str) -> str:
    m = re.search(rf"^create or replace function public\.{re.escape(name)}\(.*?^\$\$;$", text, re.S | re.M)
    assert m, name
    return m.group(0)


def pg_md5(defn: str) -> str:
    """md5(regexp_replace(prosrc, '\\s+', ' ', 'g')), the hash every drift guard in this repository uses."""
    body = defn.split("as $$", 1)[1].rsplit("$$;", 1)[0]
    return hashlib.md5(re.sub(r"\s+", " ", body).encode()).hexdigest()


def code(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


GC_0147 = "b5d0423a7df82812106021e05488d9ad"
LIFETIME = "max(least(coalesce(g.revoked_at, 'infinity'::timestamptz), g.absolute_expires_at))"
HUNKS = [
    ("  v_ended := array(\n    select c.client_id from public.oauth_clients c\n     where c.created_at < now() - interval '24 hours'\n",
     "  -- 0161: ChatGPT registers ONE client per MCP server connection and signs in with it again after a disconnect or the\n"
     "  -- 90-day cap (OpenAI's auth guide: delete it and the person gets invalid_client and must re-create the plugin). So a\n"
     "  -- ChatGPT-only client (oauth_clients.chatgpt) is not taken here for 30 days after the person's last connection with it\n"
     "  -- ended, 0093's own retention of an ended grant (after that the grant goes, and the last delete below takes the client).\n"
     "  -- At most 3 such clients a person, newest ended first, so approve-redeem-revoke cannot pin more than 3 rows an account.\n"
     "  -- A left anti-join over the stored flag, not a per-row helper call and not an array test per candidate: both made a\n"
     "  -- collection under a ChatGPT-class flood ten times slower than 0147's (Breach on #744).\n"
     "  v_ended := array(\n"
     "    with kept as (\n"
     "      select k.client_id from (\n"
     "        select g.client_id,\n"
     f"               row_number() over (partition by g.user_id order by {LIFETIME} desc, g.client_id) as n\n"
     "          from public.oauth_grants g\n"
     "          join public.oauth_clients kc on kc.client_id = g.client_id\n"
     "         where kc.chatgpt and g.activated_at is not null\n"
     "         group by g.user_id, g.client_id\n"
     f"        having {LIFETIME} < now()\n"
     f"           and {LIFETIME} >= now() - interval '30 days'\n"
     "      ) k where k.n <= 3)\n"
     "    select c.client_id from public.oauth_clients c\n"
     "      left join kept on kept.client_id = c.client_id\n"
     "     where c.created_at < now() - interval '24 hours'\n"
     "       and kept.client_id is null\n"),
]


def rebuilt() -> str:
    out = definition(M0147, "oauth_gc")
    for old, new in HUNKS:
        assert out.count(old) == 1, old
        out = out.replace(old, new)
    return out


class BuiltOn0147(unittest.TestCase):
    def test_the_collector_is_0147s_body_plus_the_two_hunks(self):
        self.assertEqual(definition(M0161, "oauth_gc"), rebuilt())

    def test_no_migration_between_0147_and_0161_redefines_the_collector(self):
        later = [p.name for p in sorted(MIG.glob("*.sql"))
                 if "0147" < p.name[:4] < "0161" and re.search(r"create or replace function public\.oauth_gc\(", p.read_text(encoding="utf-8"))]
        self.assertEqual(later, [], "oauth_gc was redefined after 0147: rebuild 0161 on the newer body")

    def test_it_defines_exactly_the_collector_and_the_helper(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", code(M0161))),
                         ["oauth_chatgpt_callbacks_only", "oauth_gc"])
        # Besides the two functions: exactly the stored flag and its partial index (the collector's cost fix), nothing else.
        self.assertNotRegex(code(M0161), r"(?i)\b(create\s+table|create\s+policy|create\s+trigger|drop\s+\w+)\b")
        self.assertEqual(re.findall(r"(?i)\balter\s+table\s+(\S+)", code(M0161)), ["public.oauth_clients"])
        self.assertIn("add column if not exists chatgpt boolean generated always as (public.oauth_chatgpt_callbacks_only(redirect_uris)) stored;", M0161)
        self.assertEqual(re.findall(r"(?i)create\s+index\s+if\s+not\s+exists\s+(\w+)", code(M0161)), ["oauth_clients_chatgpt_idx"])
        self.assertIn("on public.oauth_clients (client_id) where chatgpt;", M0161)

    def test_the_md5_pins_describe_the_bodies(self):
        self.assertEqual(pg_md5(definition(M0147, "oauth_gc")), GC_0147)
        self.assertIn(GC_0147, M0161)
        gc, helper = pg_md5(definition(M0161, "oauth_gc")), pg_md5(definition(M0161, "oauth_chatgpt_callbacks_only"))
        self.assertGreaterEqual(M0161.count(gc), 3, "drift guard, end state and Verify name 0161's collector")
        self.assertGreaterEqual(M0161.count(helper), 2, "drift guard and end state name the helper")
        self.assertIn(gc, ROLLBACK)


class TheExceptionIsChatGPTsAndSmall(unittest.TestCase):
    def test_the_helper_names_only_chatgpts_two_callbacks_exactly(self):
        helper = definition(M0161, "oauth_chatgpt_callbacks_only")
        self.assertIn("u = 'https://chatgpt.com/connector_platform_oauth_redirect'", helper)
        self.assertIn(r"u ~ '^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]{1,64}$'", helper)
        self.assertEqual(re.findall(r"https://[a-z.]+", helper), ["https://chatgpt.com", "https://chatgpt"])
        self.assertIn("language sql immutable set search_path = public, pg_temp", helper)
        self.assertIn("revoke all on function public.oauth_chatgpt_callbacks_only(text[]) from public, anon, authenticated, service_role;", M0161)
        self.assertNotRegex(code(M0161), r"grant execute on function public\.oauth_(gc|chatgpt_callbacks_only)")

    def test_both_chatgpt_shapes_are_inside_0147s_vendor_class(self):
        vendor = definition(M0147, "oauth_vendor_callbacks_only")
        self.assertIn("'https://chatgpt.com/connector_platform_oauth_redirect'", vendor)
        self.assertIn(r"u ~ '^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]{1,64}$'", vendor)

    def test_kept_means_30_days_3_a_person_redeemed_grants_only(self):
        gc = code(definition(M0161, "oauth_gc"))
        self.assertIn("interval '30 days'", gc.split("with kept as (", 1)[1].split("left join kept", 1)[0])
        self.assertIn("k.n <= 3", gc)
        # The cost fix (Breach on #744): the kept set reads the stored flag, never the helper per row, and is an anti-join.
        self.assertNotIn("oauth_chatgpt_callbacks_only", gc)
        self.assertIn("kc.chatgpt", gc)
        self.assertNotIn("v_kept", gc)
        self.assertNotRegex(gc, r"<>\s*all\s*\(")
        self.assertIn("g.activated_at is not null", gc)
        # 0093's 30-day retention of an ended grant is what ends a kept client; it must still be there, unchanged.
        self.assertIn("or (revoked_at is not null and revoked_at < now() - interval '30 days')", gc)
        self.assertIn("or absolute_expires_at < now() - interval '30 days'", gc)


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_puts_0147s_body_back_verbatim_and_drops_the_helper(self):
        self.assertEqual(definition(ROLLBACK, "oauth_gc"), definition(M0147, "oauth_gc"))
        self.assertIn("drop function if exists public.oauth_chatgpt_callbacks_only(text[]);", ROLLBACK)
        # The column depends on the helper, so it (and its index) go first.
        order = [ROLLBACK.index(s) for s in ("drop index if exists public.oauth_clients_chatgpt_idx;",
                                             "alter table public.oauth_clients drop column if exists chatgpt;",
                                             "drop function if exists public.oauth_chatgpt_callbacks_only(text[]);")]
        self.assertEqual(order, sorted(order))
        self.assertIn(GC_0147, ROLLBACK)
        self.assertTrue(ROLLBACK.rstrip().endswith("commit;") and "\nbegin;\n" in ROLLBACK)

    def test_the_file_says_how_to_apply_verify_and_undo(self):
        self.assertIn("APPLY AS ONE TRANSACTION", M0161)
        self.assertIn("-- Verify (run after applying", M0161)
        self.assertIn("rollback_0161_mcp_chatgpt_client.sql", M0161)
        self.assertIn("0161, assigned to this branch", M0161)

    def test_the_migration_is_documented(self):
        self.assertIn("(0161)", MIGRATIONS_DOC)
        self.assertIn("0161_mcp_chatgpt_client.sql", MIGRATIONS_DOC)


if __name__ == "__main__":
    unittest.main()
