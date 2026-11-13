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
    ("declare\n  v_ended uuid[];\nbegin\n", "declare\n  v_ended uuid[];\n  v_kept  uuid[];\nbegin\n"),
    ("  v_ended := array(\n    select c.client_id from public.oauth_clients c\n     where c.created_at < now() - interval '24 hours'\n",
     "  -- 0161: ChatGPT registers ONE client per MCP server connection and signs in with it again after a disconnect or the\n"
     "  -- 90-day cap (OpenAI's auth guide: delete it and the person gets invalid_client and must re-create the plugin). So a\n"
     "  -- ChatGPT-only client is not taken here for 30 days after the person's last connection with it ended, 0093's own\n"
     "  -- retention of an ended grant (after that the grant goes, and the last delete below takes the client). At most 3 such\n"
     "  -- clients a person, newest ended first, so approve-redeem-revoke cannot pin more rows than 0147 allowed.\n"
     "  v_kept := array(\n"
     "    select k.client_id from (\n"
     "      select g.client_id,\n"
     "             row_number() over (partition by g.user_id\n"
     f"                                order by {LIFETIME} desc,\n"
     "                                         g.client_id) as n\n"
     "        from public.oauth_grants g\n"
     "        join public.oauth_clients c on c.client_id = g.client_id\n"
     "       where c.vendor and public.oauth_chatgpt_callbacks_only(c.redirect_uris) and g.activated_at is not null\n"
     "       group by g.user_id, g.client_id\n"
     f"      having {LIFETIME} < now()\n"
     f"         and {LIFETIME} >= now() - interval '30 days'\n"
     "    ) k where k.n <= 3);\n"
     "  v_ended := array(\n    select c.client_id from public.oauth_clients c\n     where c.created_at < now() - interval '24 hours'\n"
     "       and c.client_id <> all (v_kept)\n"),
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
        self.assertNotRegex(code(M0161), r"(?i)\b(create|alter|drop)\s+(table|policy|trigger|index)\b")

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
        self.assertIn("interval '30 days'", gc.split("v_kept := array(", 1)[1].split("v_ended := array(", 1)[0])
        self.assertIn("k.n <= 3", gc)
        self.assertIn("g.activated_at is not null", gc)
        # 0093's 30-day retention of an ended grant is what ends a kept client; it must still be there, unchanged.
        self.assertIn("or (revoked_at is not null and revoked_at < now() - interval '30 days')", gc)
        self.assertIn("or absolute_expires_at < now() - interval '30 days'", gc)


class TheRollbackAndTheDoc(unittest.TestCase):
    def test_the_rollback_puts_0147s_body_back_verbatim_and_drops_the_helper(self):
        self.assertEqual(definition(ROLLBACK, "oauth_gc"), definition(M0147, "oauth_gc"))
        self.assertIn("drop function if exists public.oauth_chatgpt_callbacks_only(text[]);", ROLLBACK)
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
