"""Security-lab contract for migration 0133 (Ads Factory, Phase 2: the brand scan: domains proven by DNS TXT, priced scans, accepting fields).

Wired in like the other per-migration files:

  * sec_expectations.py, at the bottom:
        import sec_brand_scan_0133; sec_brand_scan_0133.extend(TABLES, FUNCTIONS)
  * sec_scenario.build_scenario(), after 0131's seed (the logo is sec_style_0047's picture):
        sec_brand_scan_0133.seed(conn, sc)

Three content tables, all Org(): a member reads the rows of THEIR organization, and no API role writes any of them directly. The settings
table is Service(): no API role reads or writes it. The five member functions are USER (each checks sign-in, membership and the editor role
itself), the five worker functions and the seven internal helpers SERVICE (no signed-in user; the worker's are granted to service_role
alone, the helpers to nobody, which the migration's own end state and test_sec_brand_scan.py pin). The two trigger functions are not listed.

The seed goes the way production does: a member asks for a domain, the worker checks it and finds the record, the member asks for a scan
(priced 0 for the seed, then the price goes back to NULL, the shipped state), the worker claims it and reports a result.
"""

from __future__ import annotations

import json
import uuid
from typing import Dict

#: Per tenant key ('a' / 'b'): ids the attacks aim at.
DOMAIN: Dict[str, str] = {}
CHECK: Dict[str, str] = {}
SCAN: Dict[str, str] = {}
HOST: Dict[str, str] = {}

WORKER = "brand-scan-lab-01"

REQUEST_DOMAIN = "select public.request_domain_verification(%s, %s)"
CHECK_DOMAIN = "select public.check_domain_verification(%s)"
REQUEST_SCAN = "select public.request_brand_scan(%s, %s, %s, %s)"
ACCEPT = "select public.accept_brand_scan_fields(%s, %s, %s::text[])"


def field(value, url, where):
    return {"value": value, "source": {"url": url, "where": where}}


def result(url: str, *, logo=None, products=(), **over) -> dict:
    """A result of the shape brand_scan_result_ok accepts: the fields a real scan of ``url`` proposes."""
    fields = {
        "name": field("Brand Shop", url, "og_site_name"),
        "description": field("Plain goods, made well.", url, "meta_description"),
        "palette": field(["#112233", "#aabbcc"], url, "logo_palette"),
        "fonts": field(["Inter", "Playfair Display"], url, "css"),
        "theme_color": field("#ff6600", url, "theme_color"),
    }
    if logo:
        fields["logo"] = field(logo, url, "jsonld_organization")
    out = {"v": 1, "pages": [url], "fields": fields, "products": list(products), "notes": [{"code": "svg_logo", "url": url}]}
    out.update(over)
    return out


def product(url, title="Mug", *, description="A stoneware mug.", price="$12", image=None) -> dict:
    p = {"title": field(title, url, "jsonld_product")}
    if description is not None:
        p["description"] = field(description, url, "jsonld_product")
    if price is not None:
        p["price"] = field(price, url, "jsonld_product")
    if image:
        p["image"] = field(image, url, "jsonld_product")
    return p


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE, USER, Org, Service

    tables.update({
        "brand_domains": Org(),
        "brand_domain_checks": Org(),
        "brand_scans": Org(),
        "brand_scan_settings": Service(),
    })
    functions.update({
        "request_domain_verification": USER,
        "check_domain_verification": USER,
        "quote_brand_scan": USER,
        "request_brand_scan": USER,
        "accept_brand_scan_fields": USER,
        # the worker's (service_role only)
        "claim_domain_check": SERVICE,
        "finish_domain_check": SERVICE,
        "claim_brand_scan": SERVICE,
        "finish_brand_scan": SERVICE,
        "fail_brand_scan": SERVICE,
        # internal: no API role at all
        "ads_hosting_parent": SERVICE,
        "ads_scan_host_ok": SERVICE,
        "ads_scan_url_ok": SERVICE,
        "brand_scan_field_ok": SERVICE,
        "brand_scan_result_ok": SERVICE,
        "brand_scan_price": SERVICE,
        "brand_scan_fail_locked": SERVICE,
    })


def seed(conn, sc) -> None:
    """Each tenant: one verified domain (one finished check), and one READY scan of it with a logo and one product (free for the seed).
    The price goes back to NULL afterwards: the shipped state, which the tests start from."""
    from sec_db import SERVICE as SERVICE_ACTOR, acting, as_superuser
    from sec_style_0047 import IMAGES

    with as_superuser(conn) as su:
        su.rows("update public.brand_scan_settings set price_credits = 0 returning 1")
    try:
        for t in sc.tenants():
            k = t.key
            HOST[k] = f"brand-{k}.example.com"
            with acting(conn, t.actor, commit=True) as s:
                DOMAIN[k] = s.value(REQUEST_DOMAIN, [t.org, HOST[k]])["id"]
                CHECK[k] = s.value(CHECK_DOMAIN, [DOMAIN[k]])["check_id"]
            with acting(conn, SERVICE_ACTOR, commit=True) as s:
                got = s.value("select public.claim_domain_check(%s)", [WORKER])
                assert got["check_id"] == CHECK[k], got
                s.value("select public.finish_domain_check(%s, %s, true, null)", [CHECK[k], WORKER])
            url = f"https://www.{HOST[k]}/"
            with acting(conn, t.actor, commit=True) as s:
                SCAN[k] = s.value(REQUEST_SCAN, [t.org, url, f"seed-scan-{k}-{uuid.uuid4().hex[:8]}", 0])["id"]
            with acting(conn, SERVICE_ACTOR, commit=True) as s:
                got = s.value("select public.claim_brand_scan(%s)", [WORKER])
                assert got["scan_id"] == SCAN[k], got
                s.value("select public.finish_brand_scan(%s, %s, %s::jsonb)",
                        [SCAN[k], WORKER, json.dumps(result(url, logo=IMAGES[k][0], products=[product(url, image=IMAGES[k][1])]))])
    finally:
        with as_superuser(conn) as su:
            su.rows("update public.brand_scan_settings set price_credits = null returning 1")
