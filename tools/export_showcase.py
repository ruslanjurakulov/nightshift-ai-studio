#!/usr/bin/env python3
"""Export one Studio generation of the operator's own organization to the public site's model samples (docs/SHOWCASE.md).

    python tools/export_showcase.py --job-id <uuid> [--slot SLOT] [--caption TEXT] [--card-line-en TEXT --card-line-ru TEXT
                                    --card-line-uz TEXT] [--summary PATH]

Run by .github/workflows/showcase_asset.yml, never by a browser. It reads the job, its output and its costs from the database
with the service key, and the output file itself from our own server through the same short-lived signed link the Library uses
(``/api/media/file/<asset>/original``, HMAC-signed with MEDIA_URL_SECRET, at most five minutes): the masters live on the server's
media volume (modules/media_library.py), not in Supabase Storage, so there is no other copy to read.

It REFUSES, before it downloads anything, unless:

* the id is a well-formed uuid and names a job, or the library file a job made (the Library shows files, not jobs);
* the job belongs to the operator's organization (``00000000-0000-0000-0000-000000000001``) and ``completed``;
* the job ran without a style kit (a kit's reference pictures are not ours to check here);
* the model that made it (the routed one on Auto) is in schemas/model_registry.json, its vendor terms are cleared for public
  display (no ``terms_gate``) and it is not past an announced ``shutdown.on``. An ``operator_preview`` model is allowed (the
  owner's decision): the entry records it, and the site then claims nothing about the model being on sale;
* its output is a library asset of the same organization, made by this job, not deleted, an image or a video;
* every input picture (``source_asset_id``, ``end_asset_id``) is OURS: one of the site's AI-generated pictures
  (components/site/art/, byte for byte by sha256), or the output of another completed job of the operator's organization, checked
  the same way back to its first picture. A stock photograph (components/site/media/, clips/) or any other upload is refused;
* the job is not already a sample (the same job twice is a no-op, not a duplicate).

Then it downloads the file, checks it is exactly the stored one (sha256), and writes web copies under
command-center/components/site/showcase/<job id>/ (a video: clip.mp4 / clip.webm at 1280 wide and clip-sm.* at 640, and a
poster.webp / poster-sm.webp of its first frame; a picture: the two posters), appends the entry to
command-center/lib/site/showcase.json and regenerates command-center/components/site/showcase-assets.ts. The output is not graded
or retouched: a sample is shown as the model made it.

Provenance (docs/AI_DISCLOSURE.md "Vendor watermarks and provenance", owner decision 2026-11-12): a maker's invisible label is
always kept, never stripped or replaced, on the site's copies too. MiniMax ships a format-level `AIGC` tag (its signed TC260
implicit label), and the copies carry the source's metadata as it is (`-map_metadata 0`, ffmpeg's default, stated so no one
"tidies" it away). The Matroska muxer writes every global tag, but the MP4 muxer silently drops a key it has no atom for unless
asked (measured with ffmpeg 6.1: without `-movflags use_metadata_tags` the AIGC tag is gone from clip.mp4), and losing it there
would be stripping by omission, so both MP4s ask. The MP4 copies exported before this flag had lost it; each was given back its
own WebM's exact value by a stream-copy remux (no re-encode), and tests/test_export_showcase.py pins that every MP4 carries its
WebM's label. scripts/media-bundle-check.mjs allows exactly that signed tag in
/_next/static/media/ and fails on a vendor name or id anywhere else.

Sound (the owner's decision of 2026-11-22: every video on the site is cinematic and has sound). When ffprobe finds an audio
stream in the downloaded clip, the two FULL copies keep it: AAC 128 kb/s stereo 48 kHz in clip.mp4, Opus 96 kb/s stereo 48 kHz
in clip.webm. The clip-sm.* copies stay silent (`-an`): they are the phone and grid files, which autoplay muted (a clip whose
sound a visitor turns on switches to its full file, LoopClip.tsx), and sound would add about a quarter to a median 640 px file
(345 KB). 128 kb/s is 16 KB a second, so ~80 KB on a 5 s clip and ~160 KB on a
10 s one; Opus at 96 kb/s ~60 / ~120 KB (measured against the site's clips in docs/SHOWCASE.md "Sound"). The entry records what
was found as `audio: true|false`, and the generated module marks the clip `audio: true`, so the site shows a sound toggle only
on a clip that has a track (CLAUDE.md #5: never imply sound that is not there). A probe that cannot say is a refusal, not a
silent copy (CLAUDE.md #4).

The card line (`cardLine`) is an optional short line per language (en, ru, uz) from the workflow's inputs: all three or none,
each at most 140 characters after invisible characters are stripped, one line (a line break or a tab is refused). Over the limit
is refused, never cut.

The cost is what creative_job_costs recorded (migration 0037): the dollar estimate summed over the job's rows, or null (unknown)
when there is no row or any row has no figure, never 0 for unknown; and the vendor's own measure (unit and quantity) per row.

Nothing secret is printed: not the service key, not the signing key, not the signed link (it is a bearer for the file). Errors name
the step and the HTTP status; a connection error or any other unexpected one is printed as its type name only, because its own
message (and its traceback) can hold the signed link.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
CC = ROOT / "command-center"
DATA_FILE = CC / "lib" / "site" / "showcase.json"
ASSETS_MODULE = CC / "components" / "site" / "showcase-assets.ts"
OUT_ROOT = CC / "components" / "site" / "showcase"
ART_DIR = CC / "components" / "site" / "art"
STOCK_DIRS = (CC / "components" / "site" / "media", CC / "components" / "site" / "clips")
SAMPLES_TSX = CC / "components" / "site" / "slots.ts"
REGISTRY_FILE = ROOT / "schemas" / "model_registry.json"

#: The operator's own organization (migration 0018 default_org_id; modules/credits.DEFAULT_ORG_ID).
OPERATOR_ORG = "00000000-0000-0000-0000-000000000001"

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,39}$")
SLOT_RE = re.compile(r"^[a-z][a-z0-9.-]{0,40}$")
#: Never part of a prompt, a note or a card line on purpose, and the same set as lib/creative/improve.ts (BR-1: the old list
#: let invisible characters through, e.g. tag characters past U+E007F that spell hidden text): C0 controls (not a tab or a line
#: break), DEL and C1; every format character (Unicode category Cf) except the visible prepended concatenation marks; the
#: fillers that render as nothing; and the whole tag / supplementary variation selector block U+E0000-E0FFF.
CONTROL_RE = re.compile(
    "[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f"
    "\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\uffa0\ufff0-\ufff8\U000e0000-\U000e0fff]"
)
#: Format characters that DO draw something (Arabic number sign, end of ayah, Syriac abbreviation mark, the Kaithi number signs
#: and the rest of the prepended concatenation marks): kept, because removing them changes visible text.
VISIBLE_CF = frozenset(chr(c) for c in (*range(0x0600, 0x0606), 0x06DD, 0x070F, 0x0890, 0x0891, 0x08E2, 0x110BD, 0x110CD))


def strip_invisible(raw: str) -> str:
    """`raw` without CONTROL_RE's characters and without any other Cf character (but VISIBLE_CF)."""
    return "".join(ch for ch in CONTROL_RE.sub("", raw) if ch in VISIBLE_CF or unicodedata.category(ch) != "Cf")


#: A variation selector alone is ordinary (U+FE0F after a symbol makes it an emoji); a run of them carries nothing visible.
VS_RUN_RE = re.compile("[\ufe00-\ufe0f]{2,}")

#: How far back an input picture's own inputs are followed before the chain is refused as too long to vouch for.
MAX_INPUT_DEPTH = 6
#: The longest file downloaded (a 10 s 1080p clip is ~20 MB) and the longest clip accepted on a landing page.
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
MAX_CLIP_SECONDS = 30.0
#: The signed link's life: long enough for one download, far under the route's own one-hour ceiling.
LINK_TTL_S = 300
MIN_SECRET_CHARS = 32

#: The output's type -> the demuxer ffmpeg is forced to (so a file cannot choose its own, modules/media_library.probe_command).
VIDEO_DEMUXER = {"video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska"}
IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
WIDTHS = {"": 1280, "-sm": 640}


class Refusal(Exception):
    """The export will not happen. ``code`` is a fixed word; the message says what to do instead."""

    def __init__(self, code: str, remedy: str):
        super().__init__(f"{code}: {remedy}")
        self.code = code
        self.remedy = remedy


class AlreadyThere(Exception):
    """The job is already a sample: nothing to do (the workflow then opens no PR)."""


# ── inputs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────


def parse_job_id(raw: Any) -> str:
    value = raw.strip().lower() if isinstance(raw, str) else ""
    if not UUID_RE.fullmatch(value):
        raise Refusal("bad_job_id", "give the Studio job's id or its library file's id (a uuid like 1b2c3d4e-...; docs/SHOWCASE.md)")
    return value


def utf16_len(s: str) -> int:
    """A string's length as JavaScript's `.length` counts it (lib/site/showcase.ts measures every limit that way)."""
    return len(s.encode("utf-16-le")) // 2


def clean_text(raw: Any, max_units: int) -> str:
    """Controls out, trimmed, then cut to `max_units` UTF-16 units on a whole character (the site's parser's own measure)."""
    if not isinstance(raw, str):
        return ""
    out: List[str] = []
    n = 0
    for ch in VS_RUN_RE.sub("", strip_invisible(raw)).strip():
        n += 2 if ord(ch) > 0xFFFF else 1
        if n > max_units:
            break
        out.append(ch)
    return "".join(out).strip()


#: The site parser's limits (lib/site/showcase.ts parseShowcaseEntry), in UTF-16 units: an entry over one would be dropped there
#: without a word, so the export refuses it here instead.
TEXT_LIMITS = {"modelName": 80, "prompt": 4000, "caption": 200}


#: A card line's longest text per language (UTF-16 units, as the site measures).
CARD_LINE_MAX = 140
CARD_LINE_LANGS = ("en", "ru", "uz")


def parse_card_line(raw: Mapping[str, Any]) -> Optional[Dict[str, str]]:
    """The card line in all three languages, or None when none was given. One or two languages only is refused: a card would
    then speak one language on a page in another, or fall back unseen to English. A line over the limit is refused, never cut
    (a cut line reads as a finished one)."""
    for lang in CARD_LINE_LANGS:
        # One line is one line: a break would start a forged line in the PR summary, and a card has no room for a second.
        value = raw.get(lang)
        if isinstance(value, str) and re.search(r"[\r\n\t]", value):
            raise Refusal("card_line_invalid", f"the {lang} card line holds a line break or a tab; give it as one line")
    lines = {lang: clean_text(raw.get(lang), 1 << 30) for lang in CARD_LINE_LANGS}
    given = [lang for lang, v in lines.items() if v]
    if not given:
        return None
    if len(given) != len(CARD_LINE_LANGS):
        missing = ", ".join(lang for lang in CARD_LINE_LANGS if lang not in given)
        raise Refusal("card_line_incomplete", f"give the card line in en, ru and uz, or in none; missing: {missing}")
    for lang, v in lines.items():
        if utf16_len(v) > CARD_LINE_MAX:
            raise Refusal("card_line_too_long", f"the {lang} card line is {utf16_len(v)} characters; at most {CARD_LINE_MAX}")
    return lines


def entry_problem(entry: Mapping[str, Any]) -> Optional[str]:
    """The first field the site's parser would refuse, or None."""
    for key, limit in TEXT_LIMITS.items():
        value = entry.get(key)
        if isinstance(value, str) and utf16_len(value) > limit:
            return key
    if not entry.get("modelName"):
        return "modelName"
    att = entry.get("attribution")
    if att is not None and (not att.get("text") or utf16_len(att["text"]) > 80 or not str(att.get("url", "")).startswith("https://")):
        return "attribution"
    cost = entry.get("cost") or {}
    if cost.get("priceSource") is not None and utf16_len(cost["priceSource"]) > 300:
        return "cost.priceSource"
    for v in cost.get("vendor") or []:
        if utf16_len(v["provider"]) > 40 or (v["vendorModel"] and utf16_len(v["vendorModel"]) > 200) or (v["unit"] and utf16_len(v["unit"]) > 40):
            return "cost.vendor"
    return None


def slot_names(path: Path = SAMPLES_TSX) -> List[str]:
    """The slot names of components/site/slots.ts SLOTS (the keys a later change may point at a sample)."""
    text = path.read_text(encoding="utf-8")
    start = text.index("export const SLOTS = {")
    end = text.index("} as const", start)
    return [a or b for a, b in re.findall(r'^\s{2}(?:"([^"]+)"|([A-Za-z0-9_]+)):\s*\{', text[start:end], flags=re.M)]


def parse_slot(raw: Any, known: Sequence[str]) -> Optional[str]:
    value = raw.strip() if isinstance(raw, str) else ""
    if not value:
        return None
    if not SLOT_RE.fullmatch(value) or value not in known:
        raise Refusal("bad_slot", f"leave the slot empty or use one of: {', '.join(known)}")
    return value


def load_registry(path: Path = REGISTRY_FILE) -> Dict[str, dict]:
    return {m["id"]: m for m in json.loads(path.read_text(encoding="utf-8"))["models"]}


def file_hashes(dirs: Sequence[Path]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for d in dirs:
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.is_file() and not f.is_symlink():
                out[hashlib.sha256(f.read_bytes()).hexdigest()] = f.name
    return out


def load_data(path: Path = DATA_FILE) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise Refusal("bad_data_file", f"{path.relative_to(ROOT)} must be an object with an `entries` list")
    return data


# ── the database (PostgREST, service key) ──────────────────────────────────────────────────────────────────────────────


class Rest:
    """Three reads. The key is only ever a header; an error names the table and the status, never a body."""

    JOB_COLUMNS = "id,org_id,kind,capability,status,requested_model,routed_model,params,result,result_asset_ids,created_at"
    ASSET_COLUMNS = "id,org_id,kind,mime,sha256,source,provenance,width,height,duration_s,bytes,deleted_at,purged_at"
    COST_COLUMNS = "provider,vendor_model,unit,quantity,usd_estimate,price_source"

    def __init__(self, url: str, key: str, session=None, timeout: float = 30.0):
        import requests

        self.url = url.rstrip("/")
        self.key = key
        self.session = session or requests.Session()
        self.timeout = timeout

    def _get(self, table: str, params: dict) -> List[dict]:
        r = self.session.get(
            f"{self.url}/rest/v1/{table}",
            params=params,
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Accept": "application/json"},
            timeout=self.timeout,
        )
        if r.status_code != 200:
            raise Refusal("database_read_failed", f"reading {table} answered HTTP {r.status_code}; check SUPABASE_URL and SUPABASE_SERVICE_KEY")
        rows = r.json()
        if not isinstance(rows, list):
            raise Refusal("database_read_failed", f"reading {table} did not return a list")
        return rows

    def job(self, job_id: str) -> Optional[dict]:
        rows = self._get("creative_jobs", {"select": self.JOB_COLUMNS, "id": f"eq.{job_id}"})
        return rows[0] if rows else None

    def asset(self, asset_id: str) -> Optional[dict]:
        rows = self._get("media_assets", {"select": self.ASSET_COLUMNS, "id": f"eq.{asset_id}"})
        return rows[0] if rows else None

    def costs(self, job_id: str) -> List[dict]:
        return self._get("creative_job_costs", {"select": self.COST_COLUMNS, "job_id": f"eq.{job_id}", "order": "id.asc"})


# ── the checks (no network beyond the reads; no file written) ──────────────────────────────────────────────────────────


def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) and f >= 0 else None


def summarize_costs(rows: Sequence[Mapping[str, Any]]) -> dict:
    """The job's cost as the data file records it. Unknown (null) unless every row carries a figure; never 0 for unknown."""
    vendor = [
        {
            "provider": str(r.get("provider") or "unknown"),
            "vendorModel": r.get("vendor_model") if isinstance(r.get("vendor_model"), str) and r.get("vendor_model") else None,
            "unit": r.get("unit") if isinstance(r.get("unit"), str) and r.get("unit") else None,
            "quantity": _num(r.get("quantity")),
        }
        for r in rows
    ]
    figures = [_num(r.get("usd_estimate")) for r in rows]
    sources = sorted({str(r["price_source"]) for r in rows if isinstance(r.get("price_source"), str) and r["price_source"]})
    # Known only when every row is priced and says from where (0037 requires the source beside a figure; one without is not trusted).
    known = bool(rows) and all(f is not None for f in figures) and all(r.get("price_source") for r in rows)
    if not known:
        return {"usdEstimate": None, "priceSource": None, "rows": len(rows), "vendor": vendor}
    usd = round(sum(f for f in figures if f is not None), 6)
    return {"usdEstimate": usd, "priceSource": clean_text("; ".join(sources), 300), "rows": len(rows), "vendor": vendor}


def _live_operator_asset(rest: Rest, asset_id: str, what: str) -> dict:
    asset = rest.asset(asset_id)
    if not asset:
        raise Refusal(f"{what}_missing", f"the {what} {asset_id} is not in the library")
    if asset.get("org_id") != OPERATOR_ORG:
        raise Refusal(f"{what}_not_operator", f"the {what} belongs to another organization; only the operator's own work can be shown")
    if asset.get("deleted_at") or asset.get("purged_at"):
        raise Refusal(f"{what}_deleted", f"the {what} was deleted from the library")
    return asset


def check_input(rest: Rest, asset_id: Any, art: Mapping[str, str], stock: Mapping[str, str], depth: int = 0) -> dict:
    """Where an input picture came from, or a refusal: ours means site art (byte for byte) or another operator job's output."""
    if depth > MAX_INPUT_DEPTH:
        raise Refusal("input_chain_too_long", f"the input picture was made from more than {MAX_INPUT_DEPTH} earlier pictures; use one nearer its first")
    aid = str(asset_id or "").lower()
    if not UUID_RE.fullmatch(aid):
        raise Refusal("input_malformed", "the job's input picture id is not a well-formed id")
    asset = _live_operator_asset(rest, aid, "input")
    sha = str(asset.get("sha256") or "")
    source = asset.get("source")
    if source == "upload":
        if sha in art:
            return {"kind": "site_art", "file": art[sha], "sha256": sha}
        if sha in stock:
            raise Refusal("input_is_stock", "the input picture is one of the site's stock photographs (Pexels); start from our own AI art or an AI-generated picture")
        raise Refusal("input_is_upload", "the input picture is an upload we cannot vouch for; upload one of components/site/art/*.webp unchanged, or start from a picture made in the Studio")
    if source != "generated":
        raise Refusal("input_not_ours", f"the input picture's source is {source!r}; only a Studio generation or the site's own AI art is accepted")
    prov = asset.get("provenance") if isinstance(asset.get("provenance"), dict) else {}
    parent_job = str(prov.get("job_id") or "").lower()
    if not UUID_RE.fullmatch(parent_job):
        raise Refusal("input_no_job", "the generated input picture does not record the job that made it")
    job = rest.job(parent_job)
    if not job or job.get("org_id") != OPERATOR_ORG or job.get("status") != "completed":
        raise Refusal("input_job_not_ours", "the job that made the input picture is not a completed job of the operator's organization")
    if aid not in [str(x).lower() for x in (job.get("result_asset_ids") or [])]:
        raise Refusal("input_job_mismatch", "the input picture is not among the outputs of the job it names")
    _refuse_style(job, "input_style_kit")
    params = job.get("params") if isinstance(job.get("params"), dict) else {}
    for key in ("source_asset_id", "end_asset_id"):
        if params.get(key):
            check_input(rest, params[key], art, stock, depth + 1)
    return {"kind": "operator_job", "jobId": parent_job, "assetId": aid}


def _refuse_style(job: Mapping[str, Any], code: str) -> None:
    params = job.get("params") if isinstance(job.get("params"), dict) else {}
    result = job.get("result") if isinstance(job.get("result"), dict) else {}
    if params.get("style_kit_id") or result.get("style"):
        raise Refusal(code, "the job used a style kit, whose reference pictures this export cannot vouch for; make the sample without one")


def resolve_job_id(rest: Rest, some_id: str) -> str:
    """The job for an id that is the job's own, or the library file it made (the Library shows files, not jobs): the file's
    provenance names its job (modules/creative_worker._to_library). Only an operator generation is followed."""
    if rest.job(some_id):
        return some_id
    asset = rest.asset(some_id)
    if not asset:
        raise Refusal("job_not_found", "no Studio job and no library file has this id; copy it again")
    if asset.get("org_id") != OPERATOR_ORG:
        raise Refusal("not_operator_org", "the file belongs to a customer's organization; only the operator's own work can be shown")
    prov = asset.get("provenance") if isinstance(asset.get("provenance"), dict) else {}
    job_id = str(prov.get("job_id") or "").lower()
    if asset.get("source") != "generated" or not UUID_RE.fullmatch(job_id):
        raise Refusal("not_a_generation", "the library file was not made by a Studio job (an upload or a render has no job to show)")
    return job_id


def plan_export(
    rest: Rest,
    job_id: str,
    *,
    registry: Mapping[str, dict],
    art: Mapping[str, str],
    stock: Mapping[str, str],
    existing: Sequence[Mapping[str, Any]],
    asset_hint: Optional[str] = None,
    today: Optional[date] = None,
) -> dict:
    """Every check, in order; returns what the entry will say (without files). Raises Refusal or AlreadyThere.
    ``asset_hint``: the library file the owner named, shown when it is one of the job's outputs (else the first output)."""
    if any(isinstance(e, dict) and e.get("jobId") == job_id for e in existing):
        raise AlreadyThere(job_id)
    job = rest.job(job_id)
    if not job:
        raise Refusal("job_not_found", "no Studio job has this id; copy it again (docs/SHOWCASE.md says where)")
    if job.get("org_id") != OPERATOR_ORG:
        raise Refusal("not_operator_org", "the job belongs to a customer's organization; only the operator's own work can be shown")
    if job.get("kind") != "generate":
        raise Refusal("not_a_generation", "the job is not a Studio generation")
    if job.get("status") != "completed":
        raise Refusal("not_succeeded", f"the job is {job.get('status')!r}, not completed; export one that finished")
    _refuse_style(job, "style_kit_used")
    model = str(job.get("routed_model") or job.get("requested_model") or "")
    spec = registry.get(model)
    if not MODEL_ID_RE.fullmatch(model) or not spec:
        raise Refusal("unknown_model", "the model that made it is not in schemas/model_registry.json")
    shutdown = spec.get("shutdown") if isinstance(spec.get("shutdown"), dict) else None
    if shutdown and str(shutdown.get("on") or "") <= (today or datetime.now(timezone.utc).date()).isoformat():
        raise Refusal("model_shut_down", f"the vendor shut the model down on {shutdown.get('on')}; a sample of a model nobody can use is not shown")
    if spec.get("terms_gate"):
        raise Refusal("model_terms_not_cleared", f"the model's vendor terms are not cleared ({spec.get('terms_gate')}), so its output is not shown in public")
    outputs =[str(x).lower() for x in (job.get("result_asset_ids") or [])]
    if not outputs:
        raise Refusal("output_not_in_library", "the job's output was never added to the library, so there is no stored file to show")
    out_id = asset_hint if asset_hint in outputs else outputs[0]
    asset = _live_operator_asset(rest, out_id, "output")
    prov = asset.get("provenance") if isinstance(asset.get("provenance"), dict) else {}
    if asset.get("source") != "generated" or str(prov.get("job_id") or "").lower() != job_id:
        raise Refusal("output_mismatch", "the library file is not recorded as this job's generation")
    kind = asset.get("kind")
    mime = str(asset.get("mime") or "")
    if (kind == "video" and mime not in VIDEO_DEMUXER) or (kind == "image" and mime not in IMAGE_MIMES) or kind not in ("video", "image"):
        raise Refusal("unsupported_output", f"a {kind} of type {mime!r} cannot be shown as a sample")
    if not SHA_RE.match(str(asset.get("sha256") or "")):
        raise Refusal("output_no_hash", "the library file has no sha256 to check the download against")
    duration = _num(asset.get("duration_s"))
    if kind == "video" and duration is not None and duration > MAX_CLIP_SECONDS:
        raise Refusal("clip_too_long", f"the clip is {duration:.0f} s; a sample is at most {MAX_CLIP_SECONDS:.0f} s")
    params = job.get("params") if isinstance(job.get("params"), dict) else {}
    source = check_input(rest, params["source_asset_id"], art, stock) if params.get("source_asset_id") else {"kind": "none"}
    end = check_input(rest, params["end_asset_id"], art, stock) if params.get("end_asset_id") else None
    if job.get("capability") in ("i2v", "edit", "upscale") and source == {"kind": "none"}:
        raise Refusal("input_missing", "the job's tool starts from a picture, but none is recorded")
    attribution = spec.get("attribution") if isinstance(spec.get("attribution"), dict) else None
    created = str(job.get("created_at") or "")
    plan = {
        "jobId": job_id,
        "assetId": out_id,
        "sha256": str(asset["sha256"]),
        "mime": mime,
        "modelId": model,
        "modelName": str(spec.get("display_name") or model),
        "provider": str(spec.get("provider") or "unknown"),
        # Not on sale yet (the operator may try it): the card then claims nothing about the Studio offering it, and Try it opens
        # the tool without naming the model. tests/site-showcase.test.tsx keeps this equal to the registry's flag.
        "operatorPreview": spec.get("operator_preview") is True,
        # The vendor's announced shutdown (or None): from that day the site's card stops naming the model in its link and says
        # it is no longer in the Studio (lib/site/showcase.ts modelLeftOut).
        "shutdownOn": str(shutdown["on"]) if shutdown and re.match(r"^\d{4}-\d{2}-\d{2}$", str(shutdown.get("on") or "")) else None,
        "attribution": {"text": attribution["text"], "url": attribution["url"]} if attribution and str(attribution.get("url", "")).startswith("https://") else None,
        "capability": str(job.get("capability")),
        "kind": kind,
        # Never cut: a prompt the site would not take is refused below, not shortened into words the model was never given.
        "prompt": clean_text(params.get("prompt"), 1 << 30),
        "createdAt": _iso(created),
        "input": source,
        "endFrame": end,
        "cost": summarize_costs(rest.costs(job_id)),
    }
    bad = entry_problem(plan)
    if bad:
        raise Refusal("entry_invalid", f"the entry's {bad} is longer or other than the site accepts, so it would never be shown")
    return plan


def _iso(raw: str) -> str:
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise Refusal("bad_job_date", "the job's creation time could not be read")
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── the download (the Library's own signed link) ───────────────────────────────────────────────────────────────────────


def sign_media(secret: str, asset_id: str, variant: str, mime: str, exp: int) -> str:
    """command-center/lib/server/media.ts signMedia, byte for byte (base64url, no padding)."""
    payload = f"nightshift-media-v1\n{asset_id}\n{variant}\n{mime}\n{exp}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def site_origin(raw: str) -> str:
    value = (raw or "").strip().rstrip("/")
    if not re.match(r"^https://[a-z0-9.-]+(?::\d{1,5})?$", value):
        raise Refusal("bad_site_origin", "SITE_ORIGIN must be the site's https origin, for example https://new.nightshift-ai.studio")
    return value


def download(session, origin: str, secret: str, asset_id: str, mime: str, want_sha: str, dest: Path, now: Optional[int] = None) -> int:
    if len(secret) < MIN_SECRET_CHARS:
        raise Refusal("media_secret_missing", "the MEDIA_URL_SECRET repository secret is not set (it is the one deploy_web.yml gives the server)")
    from urllib.parse import urlencode

    exp = int(now if now is not None else time.time()) + LINK_TTL_S
    query = urlencode({"t": mime, "exp": str(exp), "sig": sign_media(secret, asset_id, "original", mime, exp)})
    url = f"{origin}/api/media/file/{asset_id}/original?{query}"
    digest = hashlib.sha256()
    n = 0
    # The link is a bearer for the file: it is never printed, and an error says only the status. A connection error's own text
    # names the URL (signature included), so it is replaced by its type alone, and its traceback is cut (`from None`).
    try:
        with session.get(url, stream=True, timeout=60, allow_redirects=False) as r:
            if r.status_code != 200:
                raise Refusal("download_failed", f"the site answered HTTP {r.status_code} for the file (503: the server has no media volume or key; 410: the file is gone; 403: MEDIA_URL_SECRET differs from the server's)")
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1 << 16):
                    n += len(chunk)
                    if n > MAX_DOWNLOAD_BYTES:
                        raise Refusal("download_too_large", "the file is larger than a sample may be")
                    digest.update(chunk)
                    f.write(chunk)
    except Refusal:
        raise
    except Exception as e:  # requests.RequestException and anything under it; never its message
        raise Refusal("download_failed", f"the site could not be reached ({type(e).__name__})") from None
    if digest.hexdigest() != want_sha:
        raise Refusal("hash_mismatch", "the downloaded file is not the one the library stored; nothing was written")
    return n


# ── the web copies ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _run(argv: Sequence[str]) -> None:
    proc = subprocess.run(list(argv), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no message"]
        raise Refusal("transcode_failed", f"{Path(argv[0]).name} exited {proc.returncode}: {tail[0][:200]}")


#: Keep the source's tags (the maker's provenance label among them) in every copy: the default, written out (module docstring,
#: "Provenance"). The MP4 muxer needs use_metadata_tags to write a custom key at all.
KEEP_METADATA = ["-map_metadata", "0"]

#: The full copies' sound when the source has one (owner decision 2026-11-22). Stereo 48 kHz: what both browsers' decoders expect,
#: and a mono or 44.1 kHz source is upmixed / resampled rather than refused.
AAC_AUDIO = ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]
OPUS_AUDIO = ["-c:a", "libopus", "-b:a", "96k", "-ac", "2", "-ar", "48000"]


def video_commands(ffmpeg: str, src: Path, mime: str, out: Path, audio: bool = False, seconds: Optional[float] = None) -> List[List[str]]:
    """The four renditions (the site's clip conventions, scripts/make-site-media.py) and the first frame, from one forced demuxer.
    With `audio`, the 1280 copies keep the first audio stream (AAC in the MP4, Opus in the WebM); the 640 ones never do."""
    # -t: a backstop only (the length was measured first, clip_seconds); never more than a sample may run.
    base = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-f", VIDEO_DEMUXER[mime], "-t", str(int(MAX_CLIP_SECONDS)), "-i", str(src)]
    cmds: List[List[str]] = []
    for suffix, w in WIDTHS.items():
        scale = f"scale={w}:-2:flags=lanczos,format=yuv420p"
        # Explicit maps: one video and exactly one audio stream, never a second track or a data stream a source might carry.
        keep = audio and suffix == ""
        # The copy ends with its picture. A track longer than the picture would otherwise stretch clip.mp4 to the audio's length, a
        # frozen last frame for most of the loop, while clip-sm.mp4 kept the picture's length. -shortest alone does not hold
        # through a filter graph (measured: a 2 s picture with 25 s of audio came out 15 s), so the output is also cut at the
        # picture's measured length.
        cut = ["-shortest"] + (["-t", f"{seconds:.3f}"] if seconds and seconds > 0 else [])
        mp4_audio = ["-map", "0:v:0", "-map", "0:a:0"] + cut + AAC_AUDIO if keep else ["-an"]
        webm_audio = ["-map", "0:v:0", "-map", "0:a:0"] + cut + OPUS_AUDIO if keep else ["-an"]
        cmds.append(base + mp4_audio + ["-vf", scale, "-c:v", "libx264", "-preset", "slow", "-crf", "26" if suffix == "" else "28", "-profile:v", "main", "-movflags", "+faststart+use_metadata_tags"] + KEEP_METADATA + [str(out / f"clip{suffix}.mp4")])
        cmds.append(base + webm_audio + ["-vf", scale, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36" if suffix == "" else "38", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1"] + KEEP_METADATA + [str(out / f"clip{suffix}.webm")])
    cmds.append(base + ["-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos", str(out / "frame0.png")])
    return cmds


def write_posters(still: Path, out: Path) -> Tuple[int, int]:
    from PIL import Image

    # Only the three types a sample is (and ffmpeg's PNG frame): Pillow never guesses another decoder from the bytes.
    with Image.open(still, formats=["PNG", "JPEG", "WEBP"]) as im:
        im = im.convert("RGB")
        size = (0, 0)
        for suffix, w in WIDTHS.items():
            h = max(1, round(im.height * w / im.width))
            copy = im.resize((w, h), Image.LANCZOS)
            copy.save(out / f"poster{suffix}.webp", "WEBP", quality=74 if suffix == "" else 70, method=6)
            if suffix == "":
                size = (w, h)
    return size


def probe_command(ffprobe: str, src: Path, mime: str) -> List[str]:
    # The VIDEO stream's length, not the container's: a file whose audio runs past its picture reports the audio's length as the
    # format's, and the picture is what the limit and the loop are about. MP4 gives `duration`; Matroska / WebM only a tag.
    return [ffprobe, "-v", "error", "-protocol_whitelist", "file", "-f", VIDEO_DEMUXER[mime], "-select_streams", "v:0",
            "-show_entries", "stream=duration:stream_tags=DURATION", "-of", "csv=p=0", str(src)]


def _parse_seconds(text: str) -> float:
    """The first line's first readable length: a number of seconds, or an `HH:MM:SS.fff` tag. NaN when neither."""
    lines = text.strip().splitlines()
    for field in (lines[0].split(",") if lines else []):
        field = field.strip()
        try:
            return float(field)
        except ValueError:
            pass
        m = re.fullmatch(r"(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)", field)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return float("nan")


def audio_probe_command(ffprobe: str, src: Path, mime: str) -> List[str]:
    # One line per audio stream ("audio"), nothing for none; the same forced demuxer and file-only protocol as the length probe.
    return [ffprobe, "-v", "error", "-protocol_whitelist", "file", "-f", VIDEO_DEMUXER[mime], "-select_streams", "a",
            "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(src)]


def has_audio(ffprobe: str, src: Path, mime: str, run: Callable[..., "subprocess.CompletedProcess"] = subprocess.run) -> bool:
    """Whether the downloaded clip carries an audio stream, read from the file (never the row's claim). A probe that fails is a
    refusal: writing silent copies of a clip that has sound would quietly ship a worse sample (CLAUDE.md #4), and writing
    `audio: false` without knowing would be a default shown as a measurement (CLAUDE.md #5)."""
    try:
        proc = run(audio_probe_command(ffprobe, src, mime), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
    except (OSError, subprocess.SubprocessError):
        proc = None
    if proc is None or proc.returncode != 0:
        raise Refusal("audio_unknown", "ffprobe could not say whether the clip has sound; install ffprobe (FFPROBE) and run again")
    return any(line.strip() == "audio" for line in proc.stdout.decode("ascii", "replace").splitlines())


#: Below this peak a track is silence (digital silence reads -inf; a generator's padding a little above it), not sound.
SILENT_PEAK_DB = -60.0
#: A track that covers less of the picture than this is a blip, not the clip's sound.
MIN_AUDIO_COVER = 0.8
#: The measuring pass resamples to this rate, so the sample count it reports is a length in seconds.
MEASURE_RATE = 48000


def sound_measure_command(ffmpeg: str, src: Path, mime: str) -> List[str]:
    """Decode the first audio stream once and report its peak and its sample count (astats), from the same forced demuxer and
    file-only protocol as every other read of the download, never past a sample's longest length."""
    return [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "info", "-protocol_whitelist", "file", "-f", VIDEO_DEMUXER[mime],
            "-t", str(int(MAX_CLIP_SECONDS)), "-i", str(src), "-map", "0:a:0", "-vn",
            "-af", f"aresample={MEASURE_RATE},astats=measure_perchannel=none", "-f", "null", "-"]


def audio_is_sound(ffmpeg: str, ffprobe: str, src: Path, mime: str, video_seconds: float,
                   run: Callable[..., "subprocess.CompletedProcess"] = subprocess.run) -> bool:
    """Whether the clip has sound a visitor will hear: an audio stream (has_audio) whose peak is above SILENT_PEAK_DB and which
    covers at least MIN_AUDIO_COVER of the picture. A stream of digital silence (generators pad with one) or a blip a few
    milliseconds long is recorded as no sound, because `audio: true` puts a speaker toggle on the public site (CLAUDE.md #5). A
    measurement that cannot be read refuses (audio_unknown), never guesses either way."""
    if not has_audio(ffprobe, src, mime, run=run):
        return False
    try:
        proc = run(sound_measure_command(ffmpeg, src, mime), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        text = proc.stderr.decode("utf-8", "replace") if proc.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        text = ""
    # astats prints the Overall section last; its values are the ones read (the last match of each).
    peaks = re.findall(r"Peak level dB:\s*(-?inf|-?\d+(?:\.\d+)?)", text)
    samples = re.findall(r"Number of samples:\s*(\d+)", text)
    if not peaks or not samples or not (video_seconds == video_seconds and video_seconds > 0):
        raise Refusal("audio_unknown", "the clip's sound could not be measured (ffmpeg astats); install ffmpeg (FFMPEG) and run again")
    peak = float("-inf") if peaks[-1].endswith("inf") else float(peaks[-1])
    audio_seconds = int(samples[-1]) / MEASURE_RATE
    return peak > SILENT_PEAK_DB and audio_seconds >= MIN_AUDIO_COVER * video_seconds


def clip_seconds(ffprobe: str, src: Path, mime: str, run: Callable[..., "subprocess.CompletedProcess"] = subprocess.run) -> float:
    """The downloaded clip's own length, measured, never the row's claim (duration_s may be null). A length that cannot be read is
    a refusal: the site would otherwise show a clip cut short at the 30 s backstop without saying so."""
    try:
        proc = run(probe_command(ffprobe, src, mime), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        seconds = _parse_seconds(proc.stdout.decode("ascii", "replace")) if proc.returncode == 0 else float("nan")
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        seconds = float("nan")
    if not (seconds == seconds and 0 < seconds < float("inf")):
        raise Refusal("clip_length_unknown", "the clip's length could not be measured, so it is not shown (it could be cut short unseen)")
    if seconds > MAX_CLIP_SECONDS:
        raise Refusal("clip_too_long", f"the clip is {seconds:.1f} s; a sample is at most {MAX_CLIP_SECONDS:.0f} s")
    return seconds


def make_derivatives(src: Path, kind: str, mime: str, out: Path, ffmpeg: str = "ffmpeg", run: Callable[[Sequence[str]], None] = _run,
                     ffprobe: str = "ffprobe", measure: Callable[[str, Path, str], float] = clip_seconds,
                     sound: Callable[[str, str, Path, str, float], bool] = audio_is_sound) -> Tuple[int, int, bool]:
    """The web copies; returns the 1280 copy's (width, height) and whether the full copies carry sound (False for a picture)."""
    audio = False
    if kind == "video":
        # Measured before anything is written; `-t` in the commands is only a backstop.
        seconds = measure(ffprobe, src, mime)
        audio = sound(ffmpeg, ffprobe, src, mime, seconds)
    out.mkdir(parents=True, exist_ok=True)
    if kind == "video":
        for cmd in video_commands(ffmpeg, src, mime, out, audio=audio, seconds=seconds):
            run(cmd)
        frame = out / "frame0.png"
        try:
            w, h = write_posters(frame, out)
        finally:
            frame.unlink(missing_ok=True)
        return (w, h, audio)
    w, h = write_posters(src, out)
    return (w, h, False)


# ── the data file and the generated module ─────────────────────────────────────────────────────────────────────────────

ASSETS_HEADER = '''// GENERATED by tools/export_showcase.py from lib/site/showcase.json. Do not edit by hand: run the "Showcase asset" workflow.
/**
 * The model samples' files, imported (so each is a hashed file served from this origin) in a module the browser bundle includes:
 * ShowcaseClip, a Client Component, reads the clips from here, for the same reason as clip-assets.ts (a video imported only by
 * Server Components is never copied to /_next/static/media/).
 *
 * SHOWCASE_CARDS is the client-safe slice of the data file: only what client code places, sizes and links a sample with. The
 * full manifest (lib/site/showcase.ts) is server-only, because it carries each job's vendor, vendor model, cost, maker credit and
 * file hash, and it shipped in public JavaScript on every page that drew a slot or an effect.
 */
import type { ShowcaseFiles } from "@/lib/site/showcase";
import type { ShowcaseCard } from "@/lib/site/showcase-card";
'''

def render_assets_module(entries: Sequence[Mapping[str, Any]]) -> str:
    imports: List[str] = []
    rows: List[str] = []
    for i, e in enumerate(entries):
        jid = str(e["jobId"])
        if not UUID_RE.fullmatch(jid):
            raise Refusal("bad_data_file", "an entry's jobId is not a uuid")
        at = f"@/components/site/showcase/{jid}"
        imports.append(f'import s{i}Poster from "{at}/poster.webp";')
        imports.append(f'import s{i}PosterSm from "{at}/poster-sm.webp";')
        if e.get("kind") == "video":
            for name, file in (("Mp4", "clip.mp4"), ("Webm", "clip.webm"), ("SmMp4", "clip-sm.mp4"), ("SmWebm", "clip-sm.webm")):
                imports.append(f'import s{i}{name} from "{at}/{file}";')
            # `audio: true` only on a clip whose full copies have a track (the entry's measured `audio`); absent means silent, so
            # every entry exported before sound existed generates exactly the module it did.
            sound = ", audio: true" if e.get("audio") is True else ""
            clip = f"{{ mp4: s{i}Mp4, webm: s{i}Webm, smMp4: s{i}SmMp4, smWebm: s{i}SmWebm{sound} }}"
        else:
            clip = "null"
        rows.append(f'  "{jid}": {{ poster: s{i}Poster.src, posterSm: s{i}PosterSm.src, clip: {clip} }},')
    body = "\n".join(imports) + ("\n" if imports else "")
    table = "{}" if not rows else "{\n" + "\n".join(rows) + "\n}"
    cards = [render_card(c) for c in showcase_cards(entries)]
    card_list = "[]" if not cards else "[\n" + "\n".join(cards) + "\n]"
    return (
        f"{ASSETS_HEADER}{body}\nexport const SHOWCASE_FILES: Readonly<Record<string, ShowcaseFiles>> = {table};\n"
        f"\nexport const SHOWCASE_CARDS: readonly ShowcaseCard[] = {card_list};\n"
    )


#: The card fields' shapes, as lib/site/showcase.ts parseShowcaseEntry accepts them (matched with fullmatch: `$` alone lets a
#: trailing newline through, and these values are written into TypeScript). An entry that fails any is not a card, as the
#: site's parser drops it; command-center/tests/showcase-cards.test.ts pins that the slice equals what that parser makes.
CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def _size(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 16384


def _created_ms(raw: Any) -> Optional[int]:
    """`createdAt` in whole milliseconds, as JavaScript's Date.parse reads it (the site sorts on that), or None."""
    if not isinstance(raw, str) or not re.match(r"^\d{4}-\d{2}-\d{2}T", raw):
        return None
    try:
        when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        return None
    return int(when.timestamp() * 1000)


def showcase_cards(entries: Sequence[Mapping[str, Any]]) -> List[dict]:
    """The client-safe slice: per entry only its key (the job id, which SHOWCASE_FILES is keyed by), the model id a link and an
    effect match on, the tool, the kind, the size, the slot and, for an animation, the sample picture it was made from. Never the
    vendor, the vendor's model, the cost, the maker's credit, the operator-preview flag or a hash: those stay in the server-only
    manifest. Each job once and newest first, the order lib/site/showcase.ts parseShowcase gives the full entries."""
    seen = set()
    out: List[Tuple[int, dict]] = []
    for e in entries:
        if not isinstance(e, Mapping):
            continue
        jid, model, cap, kind = e.get("jobId"), e.get("modelId"), e.get("capability"), e.get("kind")
        when = _created_ms(e.get("createdAt"))
        if not (isinstance(jid, str) and UUID_RE.fullmatch(jid) and isinstance(model, str) and MODEL_ID_RE.fullmatch(model)):
            continue
        if not (isinstance(cap, str) and CAPABILITY_RE.fullmatch(cap) and kind in ("video", "image") and when is not None):
            continue
        if not (_size(e.get("width")) and _size(e.get("height"))) or jid in seen:
            continue
        slot = e.get("slot")
        if not (slot is None or (isinstance(slot, str) and SLOT_RE.fullmatch(slot))):
            continue
        src = e.get("input") if isinstance(e.get("input"), Mapping) else {}
        if src.get("kind") == "operator_job" and isinstance(src.get("jobId"), str) and UUID_RE.fullmatch(src["jobId"]):
            inp: dict = {"kind": "operator_job", "jobId": src["jobId"]}
        elif src.get("kind") in ("none", "site_art"):
            inp = {"kind": src["kind"]}
        else:
            continue
        seen.add(jid)
        card = {"jobId": jid, "modelId": model, "capability": cap, "kind": kind, "width": e["width"], "height": e["height"], "slot": slot, "input": inp}
        out.append((when, card))
    # Stable, newest first: equal times keep the data file's order, as Array.prototype.sort does.
    return [c for _, c in sorted(out, key=lambda t: -t[0])]


def render_card(c: Mapping[str, Any]) -> str:
    inp = c["input"]
    src = f'{{ kind: "operator_job", jobId: "{inp["jobId"]}" }}' if inp["kind"] == "operator_job" else f'{{ kind: "{inp["kind"]}" }}'
    slot = "null" if c["slot"] is None else f'"{c["slot"]}"'
    return (
        f'  {{ jobId: "{c["jobId"]}", modelId: "{c["modelId"]}", capability: "{c["capability"]}", kind: "{c["kind"]}", '
        f'width: {c["width"]}, height: {c["height"]}, slot: {slot}, input: {src} }},'
    )


def dump_data(data: Mapping[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def entry_from_plan(plan: Mapping[str, Any], size: Tuple[int, int], slot: Optional[str], caption: str, now: datetime, *, audio: bool = False,
                    card_line: Optional[Mapping[str, str]] = None) -> dict:
    keep = ("jobId", "assetId", "sha256", "modelId", "modelName", "provider", "operatorPreview", "shutdownOn", "attribution", "capability", "kind", "prompt", "createdAt", "input", "endFrame", "cost")
    entry = {k: plan[k] for k in keep}
    entry.update({"width": size[0], "height": size[1], "slot": slot, "caption": caption or None, "exportedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ")})
    # What the probe found in the file; a picture has no sound. The site reads only `true` as sound.
    entry["audio"] = bool(audio) and plan["kind"] == "video"
    entry["cardLine"] = dict(card_line) if card_line else None
    bad = entry_problem(entry)
    if bad:
        raise Refusal("entry_invalid", f"the entry's {bad} is longer or other than the site accepts, so it would never be shown")
    return entry


def _code(text: str) -> str:
    """`text` as one inline code span, fenced longer than any backtick run in it, so a value can neither end the span nor
    `@mention` anyone in the PR body (GitHub notifies a bare @name, never one inside code)."""
    fence = "`" * (max((len(r) for r in re.findall(r"`+", text)), default=0) + 1)
    return f"{fence} {text} {fence}"


def summary_markdown(entry: Mapping[str, Any]) -> str:
    cost = entry["cost"]
    usd = "unknown" if cost["usdEstimate"] is None else f"${cost['usdEstimate']:.4f} ({cost['priceSource']})"
    if cost["rows"] == 0:
        usd += " (no cost row was recorded for this job)"
    vendor = "; ".join(
        f"{v['provider']}{' ' + v['vendorModel'] if v['vendorModel'] else ''}: "
        + ("unknown" if v["quantity"] is None else f"{v['quantity']:g} {v['unit'] or 'units'}")
        for v in cost["vendor"]
    ) or "none recorded"
    src = entry["input"]
    origin = {"none": "none (text only)", "site_art": f"site AI art `{src.get('file')}`", "operator_job": f"operator job `{src.get('jobId')}`"}[src["kind"]]
    card = entry.get("cardLine")
    lines = [
        f"- Job: `{entry['jobId']}` ({entry['capability']}, {entry['kind']}), created {entry['createdAt']}",
        f"- Model: {entry['modelName']} (`{entry['modelId']}`)" + (f", attribution: [{entry['attribution']['text']}]({entry['attribution']['url']})" if entry["attribution"] else ", no attribution required"),
        "- In the Studio: " + ("not on sale yet (operator preview): the card says it is coming, and Try it opens the tool without it" if entry.get("operatorPreview") else "not an operator preview: Try it names this model (the Studio keeps it only if it offers it to that workspace)")
        + (f"; the vendor announced its shutdown for {entry['shutdownOn']}, from when the card stops naming it" if entry.get("shutdownOn") else ""),
        f"- Input picture: {origin}" + (f"; end frame: {entry['endFrame']['kind']}" if entry.get("endFrame") else ""),
        f"- Provider cost (creative_job_costs): {usd}",
        f"- Vendor's own figure: {vendor}",
        f"- Output asset `{entry['assetId']}`, sha256 `{entry['sha256']}` (the download matched it)",
        f"- Prompt: {json.dumps(entry['prompt'], ensure_ascii=False)}",
        "- Sound: " + ("a picture" if entry["kind"] != "video" else "yes: the 1280 copies keep the clip's audio (AAC / Opus); the 640 copies are silent" if entry.get("audio") else "none (the clip has no audio track)"),
        "- Card line: " + ("; ".join(f"{lang}: {_code(json.dumps(card[lang], ensure_ascii=False))}" for lang in CARD_LINE_LANGS) if card else "none"),
    ]
    return "\n".join(lines) + "\n"


# ── the hand-over between the workflow's two jobs ──────────────────────────────────────────────────────────────────────

VIDEO_FILES = ("clip.mp4", "clip.webm", "clip-sm.mp4", "clip-sm.webm", "poster.webp", "poster-sm.webp")
IMAGE_FILES = ("poster.webp", "poster-sm.webp")


def stage_export(job_id: str, kind: str, summary: Path, dest: Path, cc: Path = CC) -> None:
    """Copy exactly what the PR will carry into `dest` (the artifact the publish job receives), laid out as in the repository."""
    rel = [Path("lib/site/showcase.json"), Path("components/site/showcase-assets.ts")]
    rel += [Path("components/site/showcase") / job_id / f for f in (VIDEO_FILES if kind == "video" else IMAGE_FILES)]
    for r in rel:
        target = dest / "command-center" / r
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cc / r, target)
    shutil.copyfile(summary, dest / "summary.md")


def verify_export(root: Path, job_id: str) -> str:
    """The publish job's check of what it was handed (it holds the write token, so it trusts nothing in the artifact):
    exactly the sample's files and the two data files, no link, no other path; the data file names this job once and parses;
    the generated module is exactly what the data file makes. Returns the entry's kind."""
    job_id = parse_job_id(job_id)
    files = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() or p.is_symlink())
    if any(p.is_symlink() for p in root.rglob("*")):
        raise Refusal("export_has_link", "the export holds a symbolic link")
    data_path = root / "command-center/lib/site/showcase.json"
    if not data_path.is_file():
        raise Refusal("export_incomplete", "the export has no data file")
    data = load_data(data_path)
    mine = [e for e in data["entries"] if isinstance(e, dict) and e.get("jobId") == job_id]
    if len(mine) != 1 or len({e.get("jobId") for e in data["entries"] if isinstance(e, dict)}) != len(data["entries"]):
        raise Refusal("export_bad_entry", "the data file must hold this job exactly once and no job twice")
    kind = mine[0].get("kind")
    if kind not in ("video", "image"):
        raise Refusal("export_bad_entry", "the entry's kind is neither video nor image")
    want = sorted(
        ["summary.md", "command-center/lib/site/showcase.json", "command-center/components/site/showcase-assets.ts"]
        + [f"command-center/components/site/showcase/{job_id}/{f}" for f in (VIDEO_FILES if kind == "video" else IMAGE_FILES)]
    )
    if files != want:
        raise Refusal("export_unexpected_files", "the export holds other files than the sample's own")
    if (root / "summary.md").stat().st_size > 20_000:
        raise Refusal("export_bad_file", "the summary is longer than a PR description needs")
    module = (root / "command-center/components/site/showcase-assets.ts").read_text(encoding="utf-8")
    if module != render_assets_module(data["entries"]):
        raise Refusal("export_module_mismatch", "showcase-assets.ts is not the module the data file generates")
    for name in VIDEO_FILES if kind == "video" else IMAGE_FILES:
        head = (root / "command-center/components/site/showcase" / job_id / name).read_bytes()[:16]
        ok = {
            ".webp": head[:4] == b"RIFF" and head[8:12] == b"WEBP",
            ".mp4": head[4:8] == b"ftyp",
            ".webm": head[:4] == b"\x1a\x45\xdf\xa3",
        }[Path(name).suffix]
        if not ok:
            raise Refusal("export_bad_file", f"{name} is not the type its name says")
    return str(kind)


# ── the whole run ──────────────────────────────────────────────────────────────────────────────────────────────────────


def export(
    job_raw: Any,
    *,
    rest: Rest,
    fetch: Callable[[str, str, str, Path], int],
    slot_raw: Any = None,
    caption_raw: Any = None,
    card_line_raw: Optional[Mapping[str, Any]] = None,
    derive: Callable[..., Tuple[int, int, bool]] = make_derivatives,
    data_file: Path = DATA_FILE,
    assets_module: Path = ASSETS_MODULE,
    out_root: Path = OUT_ROOT,
    now: Optional[datetime] = None,
) -> dict:
    given = parse_job_id(job_raw)
    slot = parse_slot(slot_raw, slot_names())
    caption = clean_text(caption_raw, 200)
    # Checked with the other inputs, before the database or the download: a bad line costs nothing.
    card_line = parse_card_line(card_line_raw or {})
    data = load_data(data_file)
    # The same sample asked for by its file's id is the same sample.
    if any(isinstance(e, dict) and given in (e.get("jobId"), e.get("assetId")) for e in data["entries"]):
        raise AlreadyThere(given)
    job_id = resolve_job_id(rest, given)
    plan = plan_export(
        rest, job_id, registry=load_registry(), art=file_hashes([ART_DIR]), stock=file_hashes(STOCK_DIRS), existing=data["entries"],
        asset_hint=given if given != job_id else None,
    )
    out = out_root / job_id
    with tempfile.TemporaryDirectory(prefix="showcase-") as tmp:
        src = Path(tmp) / "original"
        fetch(plan["assetId"], plan["mime"], plan["sha256"], src)
        if out.exists():
            shutil.rmtree(out)
        try:
            width, height, audio = derive(src, plan["kind"], plan["mime"], out)
        except BaseException:
            shutil.rmtree(out, ignore_errors=True)
            raise
    entry = entry_from_plan(plan, (width, height), slot, caption, now or datetime.now(timezone.utc), audio=audio, card_line=card_line)
    data["entries"].append(entry)
    data_file.write_text(dump_data(data), encoding="utf-8")
    assets_module.write_text(render_assets_module(data["entries"]), encoding="utf-8")
    return entry


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--slot", default="")
    ap.add_argument("--caption", default="")
    for lang in CARD_LINE_LANGS:
        ap.add_argument(f"--card-line-{lang}", default="", help=f"the card's short line in {lang} (all three languages or none)")
    ap.add_argument("--summary", type=Path, help="write a Markdown summary of the entry here (for the PR body)")
    ap.add_argument("--outcome", type=Path, help="write exported / already_there / refused here (for the workflow)")
    ap.add_argument("--job-out", type=Path, help="write the job id the export resolved to here (the given id may be its file's)")
    ap.add_argument("--stage", type=Path, help="after exporting, copy exactly the PR's files here (the workflow's artifact)")
    ap.add_argument("--verify-export", type=Path, help="check a staged export for --job-id and exit (the publish job; no network)")
    args = ap.parse_args(argv)

    if args.verify_export:
        try:
            kind = verify_export(args.verify_export, args.job_id)
        except Refusal as e:
            print(f"refused: {e.code}: {e.remedy}", file=sys.stderr)
            return 2
        print(f"export checked: one {kind} sample, only its own files")
        return 0

    def outcome(word: str) -> None:
        if args.outcome:
            args.outcome.write_text(word + "\n", encoding="utf-8")

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    try:
        if not url or not key:
            raise Refusal("database_not_configured", "set the SUPABASE_URL and SUPABASE_SERVICE_KEY repository secrets")
        rest = Rest(url, key)
        origin = site_origin(os.environ.get("SITE_ORIGIN", ""))
        secret = os.environ.get("MEDIA_URL_SECRET", "")
        ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
        ffprobe = os.environ.get("FFPROBE", "ffprobe")

        def fetch(asset_id: str, mime: str, sha: str, dest: Path) -> int:
            return download(rest.session, origin, secret, asset_id, mime, sha, dest)

        entry = export(
            args.job_id, rest=rest, fetch=fetch, slot_raw=args.slot, caption_raw=args.caption,
            card_line_raw={lang: getattr(args, f"card_line_{lang}") for lang in CARD_LINE_LANGS},
            derive=lambda src, kind, mime, out: make_derivatives(src, kind, mime, out, ffmpeg=ffmpeg, ffprobe=ffprobe),
        )
    except AlreadyThere as e:
        print(f"already a sample: job {e.args[0]} is in command-center/lib/site/showcase.json; nothing to do")
        outcome("already_there")
        return 0
    except Refusal as e:
        print(f"refused: {e.code}: {e.remedy}", file=sys.stderr)
        outcome("refused")
        return 2
    except Exception as e:
        # Anything else: its type only. A message or a traceback can carry a URL with a signature, a header or a key.
        print(f"failed: {type(e).__name__} (no detail is printed: it could carry a signed link or a key)", file=sys.stderr)
        outcome("failed")
        return 1
    summary =args.summary or Path(tempfile.gettempdir()) / f"showcase-{entry['jobId']}.md"
    summary.write_text(summary_markdown(entry), encoding="utf-8")
    if args.stage:
        stage_export(entry["jobId"], entry["kind"], summary, args.stage)
    if args.job_out:
        args.job_out.write_text(entry["jobId"] + "\n", encoding="utf-8")
    print(f"exported job {entry['jobId']} ({entry['modelId']}, {entry['kind']})")
    outcome("exported")
    return 0


if __name__ == "__main__":
    sys.exit(main())
