"""Trend templates (0181), attacked in the shared lab.

What would break, and which test says so:
  * a draft template leaks to the gallery before it is finished          test_a_draft_is_invisible_to_every_api_role
  * a browser (anon or a customer) writes, edits or deletes a template   test_no_api_role_writes_a_template
  * a customer turns a template on, or points its media somewhere        test_the_owner_function_refuses_a_customer
  * the anon key reaches the owner function at all                       test_anon_cannot_execute_the_owner_function
  * a stored media path builds a URL to someone else's host              test_a_media_path_cannot_leave_the_bucket
  * the media bucket accepts an upload from a browser                    test_the_media_bucket_has_no_api_write_policy
"""
import pytest

from sec_creative_templates_0181 import DRAFT_SLUG, PUBLISHED_SLUG
from sec_db import ANON, acting, as_superuser


def _slugs(conn, who):
    with acting(conn, who) as s:
        return {r[0] for r in s.rows("select slug from public.creative_templates")}


def test_a_draft_is_invisible_to_every_api_role(conn, sc):
    for who in (ANON, sc.bob.actor, sc.stranger):
        slugs = _slugs(conn, who)
        assert PUBLISHED_SLUG in slugs, f"{who.name} cannot read a published template — the check would be vacuous"
        assert DRAFT_SLUG not in slugs, f"{who.name} reads a draft template"


@pytest.mark.parametrize("statement", [
    "insert into public.creative_templates (slug, title, description, category, kind, prompt_template, model_id, aspect) "
    "select 'attack-x', title, description, category, kind, prompt_template, model_id, aspect "
    "from public.creative_templates where slug = 'lab-published'",
    "update public.creative_templates set prompt_template = 'pwned' where slug = 'lab-published'",
    "update public.creative_templates set published = true where slug = 'lab-draft'",
    "delete from public.creative_templates where slug = 'lab-published'",
])
def test_no_api_role_writes_a_template(conn, sc, statement):
    for who in (ANON, sc.bob.actor, sc.alice.actor):
        with acting(conn, who) as s:
            out = s.run(statement)
            assert (not out.ok) or out.rowcount == 0, f"{who.name}: {statement} -> {out!r}"
    with as_superuser(conn, commit=False) as s:
        assert s.value("select prompt_template from public.creative_templates where slug = %s", [PUBLISHED_SLUG]) != "pwned"
        assert s.value("select published from public.creative_templates where slug = %s", [DRAFT_SLUG]) is False


def test_the_owner_function_refuses_a_customer(conn, sc):
    for who in (sc.bob.actor, sc.alice.actor, sc.stranger):
        with acting(conn, who) as s:
            out = s.run("select public.set_creative_template_media(%s, true, null, null)", [DRAFT_SLUG])
            assert not out.ok and out.sqlstate == "42501", f"{who.name}: {out!r}"
    with as_superuser(conn, commit=False) as s:
        assert s.value("select published from public.creative_templates where slug = %s", [DRAFT_SLUG]) is False


def test_anon_cannot_execute_the_owner_function(conn):
    with acting(conn, ANON) as s:
        out = s.run("select public.set_creative_template_media(%s, true, null, null)", [DRAFT_SLUG])
        assert not out.ok and out.sqlstate == "42501", out


@pytest.mark.parametrize("path", [
    "https://evil.example/x.mp4", "//evil.example/x.mp4", "../other-bucket/x.mp4", "a/../../x.mp4",
    "a//b.mp4", "/abs/x.mp4", "x.html", "x.mp4?y=1",
])
def test_a_media_path_cannot_leave_the_bucket(conn, path):
    with as_superuser(conn, commit=False) as s:
        out = s.run("update public.creative_templates set preview_asset_path = %s where slug = %s", [path, PUBLISHED_SLUG])
        assert not out.ok and out.sqlstate == "23514", f"{path}: {out!r}"


def test_the_editor_sets_media_and_writes_one_event(conn):
    with as_superuser(conn, commit=False) as s:
        before = s.value("select count(*) from public.security_events where kind = 'creative_template.media'")
        res = s.value("select public.set_creative_template_media(%s, true, %s, %s)",
                      [DRAFT_SLUG, "lab-draft/preview.mp4", "lab-draft/poster.webp"])
        assert res["ok"] is True
        row = s.rows("select published, preview_asset_path, poster_path from public.creative_templates where slug = %s",
                     [DRAFT_SLUG])[0]
        assert row == (True, "lab-draft/preview.mp4", "lab-draft/poster.webp")
        after = s.value("select count(*) from public.security_events where kind = 'creative_template.media'")
        assert after == before + 1


def test_the_media_bucket_has_no_api_write_policy(conn):
    with as_superuser(conn, commit=False) as s:
        assert s.value("select public from storage.buckets where id = 'template-media'") is True
        policies = s.rows(
            "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' "
            "and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and (qual like '%%template-media%%' or with_check like '%%template-media%%')")
        assert policies == [], f"an API role may write the template-media bucket: {policies}"


def test_unpublishing_keeps_the_media_and_a_repeat_writes_no_event(conn):
    with as_superuser(conn, commit=False) as s:
        s.value("select public.set_creative_template_media(%s, true, %s, %s)",
                [DRAFT_SLUG, "lab-draft/preview.mp4", "lab-draft/poster.webp"])
        res = s.value("select public.set_creative_template_media(%s, false)", [DRAFT_SLUG])
        assert res["changed"] is True
        row = s.rows("select published, preview_asset_path, poster_path from public.creative_templates where slug = %s",
                     [DRAFT_SLUG])[0]
        assert row == (False, "lab-draft/preview.mp4", "lab-draft/poster.webp"), "unpublishing wiped the media"
        before = s.value("select count(*) from public.security_events where kind = 'creative_template.media'")
        again = s.value("select public.set_creative_template_media(%s, false)", [DRAFT_SLUG])
        assert again["changed"] is False
        assert s.value("select count(*) from public.security_events where kind = 'creative_template.media'") == before
        s.value("select public.set_creative_template_media(%s, false, '', '')", [DRAFT_SLUG])
        assert s.rows("select preview_asset_path, poster_path from public.creative_templates where slug = %s",
                      [DRAFT_SLUG])[0] == (None, None)
