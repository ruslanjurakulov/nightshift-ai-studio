"""Trend templates (0183), attacked in the shared lab.

What would break, and which test says so:
  * a draft template leaks to the gallery before it is finished          test_a_draft_is_invisible_to_every_api_role
  * a browser (anon or a customer) writes, edits or deletes a template   test_no_api_role_writes_a_template
  * a slug that could be read as a Studio starter id (they share ?template=)   test_a_slug_always_holds_a_hyphen
"""
import pytest

from sec_creative_templates_0183 import DRAFT_SLUG, PUBLISHED_SLUG
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


@pytest.mark.parametrize("slug", ["sharpen", "yt_thumbnail", "a", "-lead", "trail-", "Two-Words", "a--b"])
def test_a_slug_always_holds_a_hyphen(conn, slug):
    with as_superuser(conn, commit=False) as s:
        out = s.run("update public.creative_templates set slug = %s where slug = %s", [slug, PUBLISHED_SLUG])
        assert not out.ok and out.sqlstate == "23514", f"{slug!r}: {out!r}"
