"""Migration 0042 (web/API hardening), read as text.

0042 redefines every anon API entry point and api_begin to run their work
inside an exception block (P6). A redefinition that silently changed or
dropped a line of the work — an older body, a lost check — would be a
regression no behavioural test here would see, so this pins each body to
the latest earlier definition: 0040 for api_begin and api_auth, 0031 for the
rest, identical once the wrapper is taken away. The database-side behaviour
is attacked in tests/security/test_sec_web_api_hardening.py.
"""

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
M31 = (MIGRATIONS / "0031_public_api.sql").read_text()
M40 = (MIGRATIONS / "0040_api_keys_no_prefix.sql").read_text()
M42 = (MIGRATIONS / "0042_web_api_hardening.sql").read_text()

ENTRY_POINTS = [
    "api_auth", "api_balance", "api_create_video", "api_get_job", "api_list_videos", "api_get_video",
    "api_request_publish", "api_list_channels", "api_list_connected_accounts", "api_request_download",
    "api_get_download",
]
OK_CHECK = "begin\n  if not (ctx ->> 'ok')::boolean then\n    return ctx;\n  end if;\n"
HANDLER_RE = re.compile(
    r"\n  exception when others then\n    -- [^\n]*\n    return public\.api_finish\(ctx, public\.api_err\(500, 'internal_error',\n"
    r"      '[^']*'\)\);\n  end;\nend\n\$\$;\n$")


def definition(src: str, name: str) -> str:
    found = re.findall(r"^create or replace function public\.%s\(.*?^\$\$;\n" % name, src, re.S | re.M)
    assert found, f"{name} is not defined"
    return found[-1]


def unwrap(fn: str) -> str:
    head, rest = fn.split(OK_CHECK)
    assert rest.startswith("  begin\n"), "the work is not in a block"
    m = HANDLER_RE.search(rest)
    assert m, "the block does not end in the structured-500 handler"
    body = rest[len("  begin\n"): m.start()]
    lines = [l[2:] if l.startswith("  ") else l for l in body.split("\n")]
    return head + OK_CHECK + "\n".join(lines) + "\nend\n$$;\n"


class EntryPointBodiesTestCase(unittest.TestCase):
    def test_every_entry_point_is_redefined_with_its_latest_body(self):
        for name in ENTRY_POINTS:
            with self.subTest(name=name):
                latest = definition(M40 if name == "api_auth" else M31, name)
                self.assertEqual(unwrap(definition(M42, name)), latest)

    def test_api_begin_is_0040s_body_with_its_tail_guarded(self):
        new, old = definition(M42, "api_begin"), definition(M40, "api_begin")
        # Everything up to and including the count and the rate-limit refusal
        # is 0040's, byte for byte.
        cut = "  perform public.api_act_as(k.created_by);"
        self.assertEqual(new.split("  begin\n    perform public.api_act_as")[0], old.split(cut)[0])
        self.assertIn("exception when others then", new)
        self.assertNotIn("prefix", new)

    def test_every_entry_point_keeps_its_anon_grant(self):
        for name in ENTRY_POINTS:
            with self.subTest(name=name):
                self.assertRegex(M42, r"grant execute on function public\.%s\([^)]*\) to anon;" % name)


class ApiKeyMintingTestCase(unittest.TestCase):
    def test_the_client_hash_signatures_are_dropped(self):
        self.assertIn("drop function if exists public.create_api_key(uuid, text, text, bigint);", M42)
        self.assertIn("drop function if exists public.create_api_key(uuid, text, text, text, bigint);", M42)

    def test_the_key_is_returned_but_never_stored_or_audited(self):
        fn = definition(M42, "create_api_key")
        self.assertIn("'key', v_key", fn)
        insert_key = fn.split("insert into public.api_keys")[1].split(";")[0]
        self.assertIn("sha256(convert_to(v_key, 'UTF8'))", insert_key)
        audit = fn.split("insert into public.app_audit_log")[1].split(";")[0]
        self.assertNotIn("v_key", audit)
        self.assertNotIn("raise notice", fn.lower())


if __name__ == "__main__":
    unittest.main()
