"""Security-lab contract for migration 0131 (Ads Factory, Phase 1: brand kits, brand products, ad campaigns, ad concepts and their caps).

Wired in like the other per-migration files:

  * sec_expectations.py, at the bottom:
        import sec_ads_factory_0131; sec_ads_factory_0131.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after the style kits are seeded (the pictures are sec_style_0047's):
        sec_ads_factory_0131.seed(conn, sc)

Six content tables, all Org(): a member reads the rows of THEIR organization, and no API role writes any of them directly (the isolation
tests then prove that Bob reads none of Alice's rows and cannot insert, update, delete or move any). The settings table is Service(): no
API role reads or writes it. The ten member functions are USER (each checks sign-in, membership and the editor role itself); the eight
internal helpers are SERVICE, which here means "no API role at all" (the migration's own end state refuses a grant to service_role too).
The four trigger functions are not listed: the catalog test does not list trigger functions (as for 0124's and 0127's).

The seed writes everything the way production does: through the member functions, in the member's own session. The named attacks, the
caps, the races and the file's own refusals are in test_sec_ads_factory.py.
"""

from __future__ import annotations

import json
from typing import Dict, List

#: Per tenant key ('a' / 'b'): ids the attacks aim at.
KIT: Dict[str, str] = {}
PRODUCTS: Dict[str, List[str]] = {}
CAMPAIGN: Dict[str, str] = {}
CONCEPTS: Dict[str, List[str]] = {}

SAVE_KIT = "select public.save_brand_kit(%s, %s, %s, %s, %s, %s::text[], %s::text[], %s)"
SAVE_PRODUCT = "select public.save_brand_product(%s, %s, %s, %s, %s, %s::uuid[])"
SAVE_CAMPAIGN = "select public.save_ad_campaign(%s, %s, %s, %s, %s, %s::text[], %s::text[], %s::uuid[])"
ADD_CONCEPTS = "select public.add_ad_concepts(%s, %s, %s::jsonb)"


def concept(product=None, *, fmt="1:1", direction="spotlight", kind="image", headline="Headline", body="Body", cta="Shop now",
            brief="A product on a plain table.", storyboard=None) -> dict:
    out = {"product_id": product, "format": fmt, "direction": direction, "kind": kind, "headline": headline, "body": body, "cta": cta,
           "visual_brief": brief, "storyboard": storyboard}
    if kind == "video" and storyboard is None:
        out["storyboard"] = [{"visual": "The product, close up.", "line": "Meet it."}, {"visual": "The logo.", "line": ""}]
    return out


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org, Service

    tables.update({
        # Members read; nobody inserts, updates or deletes directly: the functions are the only write path.
        "brand_kits": Org(),
        "brand_products": Org(),
        "brand_product_images": Org(),
        "ad_campaigns": Org(),
        "ad_campaign_products": Org(),
        "ad_concepts": Org(),
        # The owner's caps: one row, no API role reads or writes it.
        "ads_factory_cap_settings": Service(),
    })
    functions.update({
        "save_brand_kit": USER,
        "delete_brand_kit": USER,
        "save_brand_product": USER,
        "delete_brand_product": USER,
        "save_ad_campaign": USER,
        "delete_ad_campaign": USER,
        "add_ad_concepts": USER,
        "update_ad_concept": USER,
        "set_ad_concept_status": USER,
        "delete_ad_concept": USER,
        # internal: called only inside the functions above and by the checks on the tables
        "ads_clean_text": SERVICE,
        "ads_text_ok": SERVICE,
        "ads_text_list_ok": SERVICE,
        "ads_palette_ok": SERVICE,
        "ads_closed_list_ok": SERVICE,
        "ads_site_url_ok": SERVICE,
        "ads_storyboard_ok": SERVICE,
        "ads_check_images": SERVICE,
    })


def seed(conn, sc) -> None:
    """Each tenant has one kit with a logo, two products (the first with two pictures), one campaign over both products and two concepts
    (one image, one video; the image one approved), all written by the tenant through the member functions."""
    from sec_db import acting
    from sec_style_0047 import IMAGES

    for t in sc.tenants():
        k = t.key
        with acting(conn, t.actor, commit=True) as s:
            KIT[k] = str(s.value(SAVE_KIT, [t.org, None, f"Brand {k.upper()}", f"https://brand-{k}.example.com/", IMAGES[k][0],
                                            ["#112233", "#aabbcc"], ["Inter"], "Calm and plain."]))
            PRODUCTS[k] = [
                str(s.value(SAVE_PRODUCT, [KIT[k], None, f"Product {k.upper()}1", "A first product.", "$12", IMAGES[k][1:3]])),
                str(s.value(SAVE_PRODUCT, [KIT[k], None, f"Product {k.upper()}2", "", "", []])),
            ]
            CAMPAIGN[k] = str(s.value(SAVE_CAMPAIGN, [KIT[k], None, f"Launch {k.upper()}", "launch", "en", ["1:1", "9:16"],
                                                      ["spotlight", "minimal"], PRODUCTS[k]]))
            out = s.value(ADD_CONCEPTS, [CAMPAIGN[k], f"seed-batch-{k}-0001", json.dumps([
                concept(PRODUCTS[k][0], headline=f"Seed image {k}"),
                concept(PRODUCTS[k][1], fmt="9:16", direction="minimal", kind="video", headline=f"Seed video {k}"),
            ])])
            CONCEPTS[k] = [str(x) for x in out["ids"]]
            s.value("select public.set_ad_concept_status(%s, 'approved')", [CONCEPTS[k][0]])
