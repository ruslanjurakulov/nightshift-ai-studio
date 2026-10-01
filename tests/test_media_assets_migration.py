"""supabase/migrations/0038_media_assets.sql — the media library's database half.

SQL does not run in this suite, so these pin what matters (the scenarios were
also run against a real Postgres 16 while building it): a browser can only
read its own organization's rows and cannot write any table; anon gets
nothing; the path of a file is a generated column of the id; uploads check
membership, type, size and quota under the quota row lock; a ticket can be
received once and only by the person who asked; registering, claiming and
purging are service-role only; deleting another org's asset reads as
"not found"; and nothing depends on 0035-0037."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = (ROOT / "supabase" / "migrations" / "0038_media_assets.sql").read_text()
CODE = "\n".join(line.split("--", 1)[0] for line in SQL.splitlines())
TABLES = ("media_assets", "media_uploads", "org_storage_quota", "media_storage_settings")
AUTHENTICATED_FNS = ("request_upload", "begin_upload_receive", "finish_upload_receive", "soft_delete_asset")
SERVICE_FNS = ("claim_media_upload", "reject_media_upload", "register_asset", "claim_media_purge",
               "mark_asset_purged")


def fn_body(name):
    return CODE.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


def grants(name):
    return [r.strip() for m in re.finditer(rf"grant execute on function public\.{name}\([^)]*\) to ([a-z_, ]+);",
                                           CODE)
            for r in m.group(1).split(",")]


class MediaAssetsMigration(unittest.TestCase):
    def test_rls_on_and_browser_reads_only(self):
        for t in TABLES:
            self.assertIn(f"alter table public.{t} enable row level security;", CODE)
            self.assertIn(f"revoke all on public.{t} from public, anon, authenticated, service_role;", CODE)
            self.assertIn(f"grant select on public.{t} to authenticated, service_role;", CODE)
            policies = re.findall(rf"create policy \w+ on public\.{t}\s+for (\w+)", CODE)
            self.assertEqual(policies, ["select"], t)
        self.assertNotRegex(CODE, r"grant [^;]*\b(insert|update|delete)\b[^;]* to [^;]*\b(authenticated|anon)\b")
        self.assertNotRegex(CODE, r"\bto anon\b")
        # The service role writes nothing directly except the heartbeat.
        self.assertEqual(re.findall(r"grant (insert|update|delete)[^;]*;", CODE), ["update"])
        self.assertIn("grant update (heartbeat_at, updated_at) on public.media_uploads to service_role;", CODE)

    def test_members_read_their_own_org_only(self):
        self.assertRegex(CODE, r"create policy media_assets_select on public\.media_assets\s+for select to authenticated\s+"
                               r"using \(deleted_at is null and org_id in \(select public\.accessible_org_ids\(\)\)\);")
        for t in ("media_uploads", "org_storage_quota"):
            self.assertRegex(CODE, rf"create policy {t}_select on public\.{t}\s+for select to authenticated\s+"
                                   r"using \(org_id in \(select public\.accessible_org_ids\(\)\)\);")

    def test_storage_key_is_derived_from_the_id(self):
        self.assertIn("storage_key     text generated always as (substr(id::text, 1, 2) || '/' || id::text) stored",
                      CODE)
        # No function takes a path or key from its caller.
        self.assertNotRegex(CODE, r"p_(storage_key|path|file)\b")

    def test_function_grants(self):
        for fn in AUTHENTICATED_FNS:
            self.assertEqual(grants(fn), ["authenticated"], fn)
        for fn in SERVICE_FNS:
            self.assertEqual(grants(fn), ["service_role"], fn)
            self.assertIn("if not public.credits_trusted_caller() then", fn_body(fn), fn)
        for fn in re.findall(r"create or replace function public\.(\w+)\(", CODE):
            self.assertRegex(CODE, rf"revoke all on function public\.{fn}\([^)]*\) from public, anon, authenticated, "
                                   r"service_role;", fn)
            if fn not in AUTHENTICATED_FNS + SERVICE_FNS:
                self.assertEqual(grants(fn), [], fn)

    def test_every_function_pins_its_search_path(self):
        headers = re.findall(r"create or replace function public\.\w+\([\s\S]*?\$\$", CODE)
        self.assertTrue(headers)
        for h in headers:
            self.assertIn("set search_path = public, pg_temp", h)

    def test_request_upload_checks_member_type_size_and_quota_under_lock(self):
        body = fn_body("request_upload")
        self.assertIn("if auth.uid() is null then", body)
        self.assertIn("not public.is_org_member(p_org)", body)
        self.assertIn("kind_ := public.media_mime_kind(mime_);", body)
        self.assertIn("errcode = 'NS415'", body)
        self.assertIn("public.media_mime_kind(ext_mime) <> kind_", body)
        self.assertIn("p_bytes > cfg.max_upload_bytes", body)
        self.assertIn("errcode = 'NS413'", body)
        self.assertIn("errcode = 'NS429'", body)
        lock = body.index("q := public.media_quota_lock(p_org);")
        check = body.index("if q.used_bytes + pending + p_bytes > lim then")
        insert = body.index("insert into public.media_uploads")
        self.assertLess(lock, check)
        self.assertLess(check, insert)
        self.assertIn("errcode = 'NS507'", body)
        self.assertIn("select * into q from public.org_storage_quota where org_id = p_org for update;",
                      fn_body("media_quota_lock"))
        # The name is a label: cleaned, never used as a path.
        self.assertIn("name_    text := public.media_clean_name(p_filename);", body)
        clean = fn_body("media_clean_name")
        self.assertIn("'^.*[/\\\\]'", clean)
        self.assertIn("'[[:cntrl:]]'", clean)

    def test_ticket_received_once_by_its_requester(self):
        body = fn_body("begin_upload_receive")
        self.assertIn("t.created_by <> auth.uid()", body)
        self.assertIn("not public.is_org_member(t.org_id)", body)
        self.assertIn("for update", body)
        self.assertIn("if t.status <> 'requested' then", body)
        fin = fn_body("finish_upload_receive")
        self.assertIn("t.created_by <> auth.uid()", fin)
        self.assertIn("p_bytes <= t.declared_bytes", fin)

    def test_register_takes_org_and_creator_from_the_ticket(self):
        body = fn_body("register_asset")
        self.assertIn("org := t.org_id;", body)
        self.assertIn("creator := t.created_by;", body)
        self.assertIn("if p_org is not null and p_org <> t.org_id then", body)
        self.assertIn("if p_bytes > t.declared_bytes then", body)
        self.assertIn("if not found or parent.org_id <> org then", body)
        self.assertIn("set used_bytes = used_bytes + a.bytes + a.derived_bytes", body)

    def test_soft_delete_is_member_only_and_hides_other_orgs(self):
        body = fn_body("soft_delete_asset")
        self.assertIn("if not found or not public.is_org_member(a.org_id) then", body)
        self.assertIn("errcode = 'P0002'", body)
        self.assertIn("set deleted_at = now(), deleted_by = auth.uid()", body)
        self.assertNotIn("delete from", body)
        # Bytes come back only when the files are gone.
        self.assertNotIn("used_bytes", body)
        self.assertIn("greatest(used_bytes - a.bytes - a.derived_bytes, 0)", fn_body("mark_asset_purged"))

    def test_independent_of_the_parallel_creative_migrations(self):
        for word in ("creative_jobs", "model_registry", "creative_projects", "creative_job_costs"):
            self.assertNotIn(word, CODE)
        self.assertNotRegex(CODE, r"project_id\s+uuid\s+references")
        self.assertIn("to_regprocedure('public.is_org_member(uuid, text)')", CODE)

    def test_no_customer_roles(self):
        # Access is "member of this org"; no owner/editor/viewer distinctions.
        self.assertNotRegex(CODE, r"is_org_member\([^)]*,\s*'")
        self.assertNotRegex(CODE, r"accessible_org_ids\('")


SQL44 = (ROOT / "supabase" / "migrations" / "0044_media_heic.sql").read_text()
CODE44 = "\n".join(line.split("--", 1)[0] for line in SQL44.splitlines())
HEIC_FNS = ("media_mime_kind", "media_ext_mime", "media_normalize_mime", "request_upload")


def fn_body44(name):
    return CODE44.split(f"function public.{name}(", 1)[1].split("$$;", 1)[0]


def pairs(body):
    return dict(re.findall(r"when '([^']+)' then '([^']+)'", body))


class MediaHeicMigration(unittest.TestCase):
    """0044: iPhone photos. It adds no table and no function, so the security
    lab's declarations are untouched; these pin that it only widens the type
    allowlist and the variants list, and keeps every 0038 check."""

    def test_applies_on_top_of_0038_only(self):
        self.assertIn("apply 0038_media_assets.sql first", CODE44)
        self.assertIn("to_regclass('public.media_assets') is null", CODE44)

    def test_adds_nothing_and_removes_nothing(self):
        self.assertEqual(sorted(re.findall(r"create or replace function public\.(\w+)\(", CODE44)), sorted(HEIC_FNS))
        self.assertNotRegex(CODE44, r"create (table|policy|index|trigger|extension|schema|type)")
        self.assertNotRegex(CODE44, r"drop (table|function|policy|column|index|schema|type)")
        # request_upload's own insert of a ticket is 0038's; nothing else writes rows.
        outside = CODE44.replace(fn_body44("request_upload"), "")
        self.assertIsNone(re.search(r"\b(insert into|delete from|truncate)\b|\bupdate\s+public\.", outside))
        self.assertIsNone(re.search(r"\bto anon\b", CODE44))
        self.assertIsNone(re.search(r"alter table public\.(?!media_assets\b)", CODE44))
        # Quotas, credits, the publish gate and privacy are not this migration's business:
        # the quota tables appear only inside request_upload, which is 0038's body.
        for word in ("credit", "publish", "privacy", "org_storage_quota", "media_storage_settings"):
            self.assertNotIn(word, outside, word)

    def test_the_type_allowlist_only_grows_by_heic_and_heif(self):
        old, new = pairs(fn_body("media_mime_kind")), pairs(fn_body44("media_mime_kind"))
        self.assertEqual({k: v for k, v in new.items() if k not in old}, {"image/heic": "image", "image/heif": "image"})
        self.assertEqual({k: v for k, v in old.items() if new.get(k) != v}, {})
        old, new = pairs(fn_body("media_ext_mime")), pairs(fn_body44("media_ext_mime"))
        self.assertEqual({k: v for k, v in new.items() if k not in old}, {"heic": "image/heic", "heif": "image/heif"})
        self.assertEqual({k: v for k, v in old.items() if new.get(k) != v}, {})
        # Not AVIF, not an image sequence, nothing a browser would run.
        for word in ("avif", "heic-sequence", "heif-sequence", "svg", "html"):
            self.assertNotIn(word, "".join(pairs(fn_body44("media_mime_kind"))))

    def test_aliases_are_folded_to_the_canonical_types(self):
        old, new = pairs(fn_body("media_normalize_mime")), pairs(fn_body44("media_normalize_mime"))
        self.assertEqual({k: v for k, v in new.items() if k not in old},
                         {"image/x-heic": "image/heic", "image/x-heif": "image/heif"})
        self.assertEqual({k: v for k, v in old.items() if new.get(k) != v}, {})
        # Both fold into types that media_mime_kind knows.
        for target in ("image/heic", "image/heif"):
            self.assertIn(target, pairs(fn_body44("media_mime_kind")))
        # An empty or generic type still comes from the extension (Windows sends '').
        self.assertIn("when '' then public.media_ext_mime(", fn_body44("media_normalize_mime"))

    def test_request_upload_is_0038s_with_only_the_hint_changed(self):
        new = fn_body44("request_upload")
        old = fn_body("request_upload")
        self.assertEqual(new.replace("Images (JPEG, PNG, WebP, GIF, HEIC, HEIF)", "Images (JPEG, PNG, WebP, GIF)"), old)
        self.assertIn("HEIC, HEIF", new)
        # Every 0038 check is still there.
        for needle in ("if auth.uid() is null then", "not public.is_org_member(p_org)",
                       "kind_ := public.media_mime_kind(mime_);", "errcode = 'NS415'",
                       "public.media_mime_kind(ext_mime) <> kind_", "p_bytes > cfg.max_upload_bytes",
                       "errcode = 'NS413'", "errcode = 'NS429'", "errcode = 'NS507'",
                       "q := public.media_quota_lock(p_org);", "if q.used_bytes + pending + p_bytes > lim then",
                       "reason=server_full", "kind_ = 'caption' and p_bytes > 2097152"):
            self.assertIn(needle, new)

    def test_search_path_pinned_and_privileges_are_0038s(self):
        headers = re.findall(r"create or replace function public\.\w+\([\s\S]*?\$\$", CODE44)
        self.assertEqual(len(headers), len(HEIC_FNS))
        for h in headers:
            self.assertIn("set search_path = public, pg_temp", h)
        for fn in HEIC_FNS:
            self.assertRegex(CODE44, rf"revoke all on function public\.{fn}\([^)]*\) from public, anon, authenticated, "
                                     r"service_role;")
        granted = re.findall(r"grant execute on function public\.(\w+)\([^)]*\) to ([a-z_, ]+);", CODE44)
        self.assertEqual(granted, [("request_upload", "authenticated")])

    def test_variants_check_is_replaced_idempotently_with_display(self):
        self.assertIn("pg_get_constraintdef(oid) like '%variants%'", CODE44)
        self.assertIn("alter table public.media_assets drop constraint %I", CODE44)
        self.assertIn("check (variants <@ array['thumb', 'proxy', 'display']::text[]);", CODE44)
        # 0038's was inline and named by Postgres; the new one has a name of its own.
        self.assertIn("check (variants <@ array['thumb', 'proxy']::text[])", SQL)
        self.assertIn("add constraint media_assets_variants_check", CODE44)
        self.assertLess(CODE44.index("drop constraint"), CODE44.index("add constraint media_assets_variants_check"))


if __name__ == "__main__":
    unittest.main()
