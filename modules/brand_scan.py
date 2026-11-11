"""The brand scan job (migration 0133, docs/ADS_FACTORY.md "Phase 2: brand scan"). Dark: ``tools/brand_scan_worker.py``
runs it only with ``NIGHTSHIFT_ADS_BRAND_SCAN=on``.

Two kinds of work, both claimed from the database with the service key and finished there:

* **A domain check** (``claim_domain_check`` / ``finish_domain_check``): read the TXT record ``_nightshift.<host>`` over
  DNS-over-HTTPS (``modules/dns_txt.py``) and say what it holds (``verified``, ``mismatch``, ``no_record``,
  ``dns_error``, ``timeout``).
* **A scan** (``claim_brand_scan`` / ``finish_brand_scan`` / ``fail_brand_scan``):
    1. the TXT record is read AGAIN: a domain whose record is gone (or cannot be read) fails the scan
       (``ownership_not_proven`` / ``ownership_unknown``) before a single request goes to the site; the hold is released;
    2. ``modules/brand_fetch.py`` reads robots.txt, the home page and up to five same-site pages (one budget of 30 s, the
       address and redirect rules, the byte caps), then up to four stylesheets for font names;
    3. ``modules/brand_extract.py`` proposes the fields (cleaned as 0131 stores text, each with the page and the place it
       came from); the logo is fetched (never SVG), its palette read in a child process, and the logo and up to four product
       pictures are STORED in the organization's media library (``media_library.store_generated``: the bytes sniffed,
       probed when ffprobe is here, ``register_asset`` with source ``pipeline`` and the scan in the provenance): the
       result names library assets, never a link to the site;
    4. ``finish_brand_scan`` checks the result again and captures the hold; any refusal fails the scan, which releases it.
  No model is called.

A failure is a closed word (0133 stores ``[a-z0-9_]{1,64}``): ``ownership_not_proven``, ``ownership_unknown``,
``fetch_<code>`` for the fetcher's refusal of the HOME page (``fetch_robots``, ``fetch_not_public``, ``fetch_timeout``,
``fetch_off_site`` ...), ``nothing_found``, ``invalid_result``, ``worker_error``. Nothing secret is logged: ids, codes and
exception types only.
"""

from __future__ import annotations

import logging
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from modules import brand_extract as bx
from modules import brand_fetch as bf
from modules import dns_txt

logger = logging.getLogger(__name__)

FLAG = "NIGHTSHIFT_ADS_BRAND_SCAN"
MAX_PRODUCT_IMAGES = 4
MAX_LOGO_TRIES = 3


class StoreUnavailable(Exception):
    """The database could not be reached: nothing can be recorded now (the claim's stale sweep finishes the job later)."""


class ScanStore:
    """0133's worker functions over Supabase REST (service key), as ``media_library.MediaStore`` does for 0038's."""

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout

    def http(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _rpc(self, name: str, payload: dict):
        try:
            r = self.http().post(f"{self.url}/rest/v1/rpc/{name}", json=payload, timeout=self._timeout,
                                 headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                                          "Content-Type": "application/json"})
        except Exception as e:  # noqa: BLE001 — the network, whatever its exception
            raise StoreUnavailable(f"{name}: {type(e).__name__}") from None
        if r.status_code == 404:
            return None                                   # 0133 not applied: nothing to do
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")
        try:
            return r.json()
        except ValueError:
            raise RuntimeError(f"{name}: unreadable response") from None

    def claim_check(self, worker: str) -> Optional[dict]:
        return self._rpc("claim_domain_check", {"p_worker": worker}) or None

    def finish_check(self, check_id: str, worker: str, ok: bool, code: str) -> Any:
        return self._rpc("finish_domain_check", {"p_check": check_id, "p_worker": worker, "p_ok": ok, "p_code": code})

    def claim_scan(self, worker: str) -> Optional[dict]:
        return self._rpc("claim_brand_scan", {"p_worker": worker}) or None

    def finish_scan(self, scan_id: str, worker: str, result: dict) -> Any:
        return self._rpc("finish_brand_scan", {"p_scan": scan_id, "p_worker": worker, "p_result": result})

    def fail_scan(self, scan_id: str, worker: str, code: str) -> Any:
        return self._rpc("fail_brand_scan", {"p_scan": scan_id, "p_worker": worker, "p_code": code})


@dataclass
class Library:
    """Where the scan's pictures become library assets: 0038's ``register_asset`` (``media_library.MediaStore``) and the
    media volume. ``tools`` (ffprobe / ffmpeg) add dimensions and a thumbnail when present."""

    store: Any
    media_root: Path
    tools: Optional[Any] = None


class _Failed(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _first(items):
    return items[0] if items else None


class BrandScanWorker:
    """Claims and runs domain checks and scans. Every dependency is passed in: the store, the TXT verifier, how a scan of
    a site is opened (``open_site``: ``brand_fetch.SiteScan`` in production), where pictures go, how a palette is read."""

    def __init__(self, store, *, worker_id: str, verifier: Optional[dns_txt.TxtVerifier] = None,
                 open_site: Callable[[str], bf.SiteScan] = bf.SiteScan, library: Optional[Library] = None,
                 palette: Callable[[bytes], List[str]] = bx.palette, scratch: Optional[Path] = None):
        self.store = store
        self.worker_id = worker_id
        self.verifier = verifier or dns_txt.TxtVerifier()
        self.open_site = open_site
        self.library = library
        self.palette = palette
        self.scratch = scratch

    # -- the loop --------------------------------------------------------------------------------------------------
    def run_once(self) -> bool:
        """One domain check, else one scan. False when there was nothing to do."""
        job = self.store.claim_check(self.worker_id)
        if job:
            self.process_check(job)
            return True
        job = self.store.claim_scan(self.worker_id)
        if job:
            self.process_scan(job)
            return True
        return False

    def process_check(self, job: Mapping[str, Any]) -> str:
        code = self.verifier.check(str(job.get("host") or ""), str(job.get("token") or ""))
        self.store.finish_check(str(job["check_id"]), self.worker_id, code == dns_txt.VERIFIED, code)
        logger.info("domain check %s: %s", job.get("check_id"), code)
        return code

    def process_scan(self, job: Mapping[str, Any]) -> str:
        scan_id = str(job["scan_id"])
        try:
            result = self._scan(job)
        except _Failed as f:
            return self._fail(scan_id, f.code)
        except StoreUnavailable as e:
            logger.warning("scan %s: %s; left for the stale sweep", scan_id, e)
            return "left"
        except Exception as e:  # noqa: BLE001 — the worker outlives any one scan
            logger.error("scan %s: unexpected %s", scan_id, type(e).__name__)
            return self._fail(scan_id, "worker_error")
        try:
            self.store.finish_scan(scan_id, self.worker_id, result)
        except StoreUnavailable as e:
            logger.warning("scan %s: %s; left for the stale sweep", scan_id, e)
            return "left"
        except Exception as e:  # noqa: BLE001 — the database refused the result (invalid_result): release the hold
            logger.error("scan %s: the result was refused (%s)", scan_id, type(e).__name__)
            return self._fail(scan_id, "invalid_result")
        logger.info("scan %s: ready", scan_id)
        return "ready"

    def _fail(self, scan_id: str, code: str) -> str:
        try:
            self.store.fail_scan(scan_id, self.worker_id, code)
        except Exception as e:  # noqa: BLE001 — the stale sweep fails it and releases the hold later
            logger.warning("scan %s: could not record %s (%s)", scan_id, code, type(e).__name__)
        logger.info("scan %s: failed %s", scan_id, code)
        return f"failed:{code}"

    # -- one scan --------------------------------------------------------------------------------------------------
    def _scan(self, job: Mapping[str, Any]) -> dict:
        url, org = str(job.get("url") or ""), str(job.get("org_id") or "")
        verdict = self.verifier.check(str(job.get("domain_host") or ""), str(job.get("token") or ""))
        if verdict in (dns_txt.MISMATCH, dns_txt.NO_RECORD):
            raise _Failed("ownership_not_proven")
        if verdict != dns_txt.VERIFIED:
            raise _Failed("ownership_unknown")
        try:
            site = self.open_site(url)
            pages, skipped = site.pages()
        except bf.BrandFetchError as e:
            raise _Failed(f"fetch_{e.code}") from None
        notes: List[Tuple[str, Optional[str]]] = [(f"page_{code}", u) for u, code in skipped]
        facts = [bx.read_page(p.body, p.url) for p in pages]
        home = facts[0]

        name = _first([p for f in facts[:1] for p in f.name]) or _first([p for f in facts for p in f.name if p.where != "title"])
        description = _first(home.description) or _first([p for f in facts for p in f.description])
        theme = home.theme_color or _first([f.theme_color for f in facts if f.theme_color])

        # Fonts: the home page's inline styles and up to four of its stylesheets; names only.
        counts: Dict[str, int] = {}
        font_src: Optional[str] = None
        for css_text, src in [(home.inline_css, home.url)] + self._stylesheets(site, home, notes):
            for n in bx.font_names(css_text):
                if n not in counts and font_src is None:
                    font_src = src
                counts[n] = counts.get(n, 0) + 1
        names = sorted(counts, key=lambda n: -counts[n])[:4]
        fonts = bx.Proposal(names, font_src or home.url, "css") if names else None

        # The logo: the first candidate the fetcher accepts (never SVG), stored in the library; its palette.
        logo = palette_ = None
        seen = set()
        candidates = [c for f in facts for c in f.logos if not (c[0] in seen or seen.add(c[0]))]
        for cand_url, where in candidates[:MAX_LOGO_TRIES]:
            try:
                img = site.image(cand_url)
            except bf.BrandFetchError as e:
                if e.code == bf.E_TIMEOUT:
                    notes.append(("logo_timeout", cand_url))
                    break
                notes.append((f"logo_{e.code}", cand_url))
                continue
            asset = self._store(img, org, job, "logo")
            colours = self.palette(img.body)
            if colours:
                palette_ = bx.Proposal(colours, img.url, "logo_palette")
            if asset:
                logo = bx.Proposal(asset, img.url, where)
            break

        products = self._products(site, facts, org, job, notes)
        if not any((name, description, logo, palette_, fonts, theme)) and not products:
            raise _Failed("nothing_found")
        return bx.build_result(pages=[p.url for p in pages], name=name, description=description, logo=logo,
                               palette_=palette_, fonts=fonts, theme_color=theme, products=products, notes=notes)

    def _stylesheets(self, site, home, notes) -> List[Tuple[str, str]]:
        out = []
        for u in home.stylesheets[:bx.MAX_STYLESHEETS]:
            try:
                got = site.css(u)
            except bf.BrandFetchError as e:
                notes.append((f"css_{e.code}", u))
                if e.code == bf.E_TIMEOUT:
                    break
                continue
            out.append((got.body.decode("utf-8", "replace"), got.url))
        return out

    def _products(self, site, facts, org, job, notes) -> List[dict]:
        out, titles, pictures = [], set(), 0
        for f in facts:
            for pr in f.products:
                if len(out) >= 8 or pr["title"].lower() in titles:
                    continue
                titles.add(pr["title"].lower())
                item = {"title": bx.Proposal(pr["title"], pr["url"], pr["where"])}
                if pr.get("description"):
                    item["description"] = bx.Proposal(pr["description"], pr["url"], pr["where"])
                if pr.get("price"):
                    item["price"] = bx.Proposal(pr["price"], pr["url"], pr["where"])
                if pr.get("image") and pictures < MAX_PRODUCT_IMAGES:
                    pictures += 1
                    try:
                        img = site.image(pr["image"])
                        asset = self._store(img, org, job, "product")
                        if asset:
                            item["image"] = bx.Proposal(asset, img.url, pr["where"])
                    except bf.BrandFetchError as e:
                        notes.append((f"image_{e.code}", pr["image"]))
                out.append(item)
        return out

    def _store(self, img: bf.Fetched, org: str, job: Mapping[str, Any], role: str) -> Optional[str]:
        """The picture as an asset of the organization's library, or None when there is no library here (the field is
        then not proposed: a result never links to the site)."""
        if self.library is None or not org:
            return None
        from modules import media_library  # noqa: PLC0415 — the worker image has it; tests pass a library

        asset_id = str(uuid.uuid4())
        with tempfile.TemporaryDirectory(dir=str(self.scratch) if self.scratch else None) as d:
            path = Path(d) / "picture"
            path.write_bytes(img.body)
            try:
                out = media_library.store_generated(
                    path, asset_id=asset_id, org_id=org, store=self.library.store, media_root=self.library.media_root,
                    tools=self.library.tools, expect_kind="image", source="pipeline",
                    provenance={"origin": "brand_scan", "scan_id": str(job.get("scan_id")), "role": role, "from_url": img.url})
            except media_library.IngestReject as e:
                logger.info("scan %s: a %s picture was not stored (%s)", job.get("scan_id"), role, e.args[0] if e.args else "rejected")
                return None
            except media_library.StoreUnavailable:
                raise StoreUnavailable("register_asset") from None
        return str(out.get("id")) if out else None
