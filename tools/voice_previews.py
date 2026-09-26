#!/usr/bin/env python3
"""Prepare the voice preview clips the Create page plays before a voice is chosen.

    python tools/voice_previews.py                 # every voice in command-center/lib/voices.json
    python tools/voice_previews.py --voice-id ID   # one voice (a custom id typed on the Create page)

Run by .github/workflows/voice_previews.yml, where the keys are: the ElevenLabs
key never reaches the Command Center, which only reads the finished clips.

For each voice:

* ElevenLabs' own ``preview_url`` (``GET /v1/voices/{id}``) is used when the
  voice has one — premade voices do, and fetching it costs no characters;
* otherwise one short sample sentence is synthesized (a cloned voice), about
  a hundred characters;
* the clip goes to the PRIVATE Storage bucket ``voice-previews`` as
  ``<voice id>.mp3`` (migration 0025). Signed-in users get a short-lived
  signed URL from the Command Center; nothing is public.

A voice that already has a clip is skipped unless ``--force``. The key and the
service key are only ever sent in headers and never printed; errors name the
voice id and the HTTP status.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Iterable, List, Optional

import requests

logger = logging.getLogger("voice_previews")

ROOT = Path(__file__).resolve().parent.parent
VOICES_FILE = ROOT / "command-center" / "lib" / "voices.json"
ELEVENLABS_API = "https://api.elevenlabs.io/v1"
BUCKET = "voice-previews"
VOICE_ID = re.compile(r"^[A-Za-z0-9]{20}$")
SAMPLE_TEXT = (
    "Tonight's story begins in a place history forgot. "
    "Stay with me until the end, because the ending changes everything."
)
SAMPLE_MODEL = "eleven_multilingual_v2"
MAX_BYTES = 5 * 1024 * 1024


class PreviewError(RuntimeError):
    """One voice's clip could not be prepared. The message never holds a key."""


def listed_voice_ids(path: Path = VOICES_FILE) -> List[str]:
    return [v["id"] for v in json.loads(path.read_text(encoding="utf-8")) if VOICE_ID.match(v.get("id", ""))]


class Previewer:
    def __init__(self, elevenlabs_key: str, supabase_url: str, service_key: str,
                 session: Optional[requests.Session] = None, timeout: float = 30.0):
        self.key = elevenlabs_key
        self.url = supabase_url.rstrip("/")
        self.service_key = service_key
        self.session = session or requests.Session()
        self.timeout = timeout

    # ── Supabase Storage ────────────────────────────────────────────────────
    def _storage_headers(self, extra: Optional[dict] = None) -> dict:
        headers = {"Authorization": f"Bearer {self.service_key}", "apikey": self.service_key}
        headers.update(extra or {})
        return headers

    def exists(self, voice_id: str) -> bool:
        resp = self.session.post(
            f"{self.url}/storage/v1/object/list/{BUCKET}",
            json={"prefix": "", "search": f"{voice_id}.mp3", "limit": 1},
            headers=self._storage_headers({"Content-Type": "application/json"}),
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise PreviewError(f"{voice_id}: listing the bucket failed (HTTP {resp.status_code}); is 0025 applied?")
        return any((o or {}).get("name") == f"{voice_id}.mp3" for o in resp.json() or [])

    def upload(self, voice_id: str, audio: bytes) -> None:
        resp = self.session.post(
            f"{self.url}/storage/v1/object/{BUCKET}/{voice_id}.mp3",
            data=audio,
            headers=self._storage_headers({"Content-Type": "audio/mpeg", "x-upsert": "true"}),
            timeout=self.timeout,
        )
        if resp.status_code not in (200, 201):
            raise PreviewError(f"{voice_id}: upload failed (HTTP {resp.status_code})")

    # ── ElevenLabs ──────────────────────────────────────────────────────────
    def clip(self, voice_id: str) -> bytes:
        headers = {"xi-api-key": self.key}
        resp = self.session.get(f"{ELEVENLABS_API}/voices/{voice_id}", headers=headers, timeout=self.timeout)
        if resp.status_code == 404:
            raise PreviewError(f"{voice_id}: ElevenLabs has no such voice for this account")
        if resp.status_code != 200:
            raise PreviewError(f"{voice_id}: ElevenLabs refused the voice lookup (HTTP {resp.status_code})")
        preview = (resp.json() or {}).get("preview_url") or ""
        if preview.startswith("https://"):
            got = self.session.get(preview, timeout=self.timeout)
            if got.status_code == 200 and got.content:
                return got.content[:MAX_BYTES]
        # No ready-made preview (a cloned voice): one short sample.
        resp = self.session.post(
            f"{ELEVENLABS_API}/text-to-speech/{voice_id}",
            json={"text": SAMPLE_TEXT, "model_id": SAMPLE_MODEL},
            headers={**headers, "Accept": "audio/mpeg"},
            timeout=self.timeout * 2,
        )
        if resp.status_code != 200 or not resp.content:
            raise PreviewError(f"{voice_id}: synthesizing a sample failed (HTTP {resp.status_code})")
        return resp.content[:MAX_BYTES]

    def prepare(self, voice_id: str, *, force: bool = False) -> str:
        if not VOICE_ID.match(voice_id):
            raise PreviewError("not an ElevenLabs voice id (20 letters and digits)")
        if not force and self.exists(voice_id):
            return "exists"
        self.upload(voice_id, self.clip(voice_id))
        return "prepared"


def run(ids: Iterable[str], previewer: Previewer, *, force: bool = False) -> int:
    failed = 0
    for voice_id in ids:
        try:
            outcome = previewer.prepare(voice_id, force=force)
            logger.info("%s: %s", voice_id, outcome)
        except PreviewError as e:
            failed += 1
            logger.error("%s", e)
        except requests.RequestException as e:
            failed += 1
            logger.error("%s: network error (%s)", voice_id, type(e).__name__)
    return 1 if failed else 0


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--voice-id", default="", help="one voice id; default: every listed voice")
    parser.add_argument("--force", action="store_true", help="replace clips that already exist")
    args = parser.parse_args(argv)

    missing = [n for n in ("ELEVENLABS_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(n, "").strip()]
    if missing:
        logger.error("not configured: %s", ", ".join(missing))
        return 2
    previewer = Previewer(os.environ["ELEVENLABS_API_KEY"].strip(), os.environ["SUPABASE_URL"].strip(),
                          os.environ["SUPABASE_SERVICE_KEY"].strip())
    ids = [args.voice_id.strip()] if args.voice_id.strip() else listed_voice_ids()
    return run(ids, previewer, force=args.force)


if __name__ == "__main__":
    sys.exit(main())
