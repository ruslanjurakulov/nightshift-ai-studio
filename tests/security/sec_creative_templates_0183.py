"""Security-lab contract for migration 0183 (trend templates: the Trends gallery's ready formats).

Kept in its own module, like sec_films_0166. Two hooks wire it in:

  * sec_expectations.py, at the bottom:
        import sec_creative_templates_0183; sec_creative_templates_0183.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the models are seeded:
        sec_creative_templates_0183.seed(conn, sc)

The lab's registry holds no MiniMax or Ideogram rows, so 0183's own seed inserts nothing here. This seed writes, as the database
owner, one PUBLISHED template and one DRAFT on the lab's sold model, so the isolation suite has a public row to read and the named
attacks (test_sec_creative_templates.py) have a draft that must stay invisible.
"""

from __future__ import annotations

PUBLISHED_SLUG = "lab-published"
DRAFT_SLUG = "lab-draft"


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import Public

    tables.update({
        # Published rows: anon and signed in read them; nobody but the service key writes (no insert/update/delete grant).
        # Media are static app files (lib/templates/media-manifest.json): 0183 adds no bucket and no function.
        "creative_templates": Public(anon=True),
    })


def seed(conn, sc) -> None:
    from sec_db import as_superuser
    from sec_scenario import MODEL_SOLD

    rows = [(PUBLISHED_SLUG, True, 10), (DRAFT_SLUG, False, 20)]
    with as_superuser(conn) as s:
        for slug, published, sort in rows:
            s.rows(
                "insert into public.creative_templates (slug, title, description, category, kind, prompt_template, model_id, "
                "aspect, duration_s, quality, director, sort, published) values (%s, "
                "'{\"en\":\"Lab\",\"ru\":\"Lab\",\"uz\":\"Lab\"}', '{\"en\":\"Lab\",\"ru\":\"Lab\",\"uz\":\"Lab\"}', "
                "'business', 'image', 'A poster for {product}', %s, '1:1', null, null, '{}', %s, %s) returning 1",
                [slug, MODEL_SOLD, sort, published],
            )
