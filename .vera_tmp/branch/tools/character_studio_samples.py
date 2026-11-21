"""Make one Character Studio gallery sample (docs/CHARACTER_STUDIO.md, "Samples") — A PAID VENDOR CALL. NOT RUN BY ANYTHING.

The gallery card shows, for each model, a short clip that model made from the card's own prompt. Making one is a real, billed call to
Kling or BytePlus, which the owner has not approved yet, so this script:

* prints the plan and the vendor's list price for the clip and does NOTHING else unless ``--run`` is given;
* with ``--run`` still refuses unless ``--approve-paid-call`` names the very model being run (one approval, one model, one card);
* never reads a key from anywhere but the environment the adapters read (KLING_API_KEY / SEEDANCE_API_KEY), and prints none.

What a run does, in order:
  1. uploads the source clip and the character pictures to the PRIVATE bucket and asks Supabase Storage for links valid one hour (the
     vendor fetches them; nothing is public);
  2. submits once, prints the vendor's task id before polling (if the script dies, poll that id: never run it again blindly), polls;
  3. downloads the result, keeps the ORIGINAL in the private bucket (``<private bucket>/<card>/<model>.mp4``), makes a 720p H.264 web
     copy with ffmpeg and puts it in the PUBLIC bucket that the CDN serves (``<public bucket>/<card>/<model>.mp4``);
  4. writes the card's sample row (0137 character_swap_template_samples: the CDN link, the private object path) with the service key.

The inputs are the owner's own: a clip with no real person in it, or (for Seedance) the account's own ModelArk output of the last 30 days,
and pictures the owner made or licensed. The consent declarations of 0137 apply to them as to any person's.

Usage (from the repository root):
  python tools/character_studio_samples.py --card two-characters --model kling-4.0-omni-edit --video clip.mp4 --image a.png --image b.png \\
      --cdn-base https://cdn.example.com/character-samples                    # the plan only
  ... --run --approve-paid-call kling-4.0-omni-edit                          # the paid call
Environment for --run: SUPABASE_URL, SUPABASE_SERVICE_KEY, the vendor's key; ffmpeg on PATH.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Optional, Sequence

import requests

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import character_swap as cs  # noqa: E402

PRIVATE_BUCKET = "character-samples-private"
PUBLIC_BUCKET = "character-samples"
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
_CDN = re.compile(r"^https://[a-z0-9.-]+(/[A-Za-z0-9._~-]+)*$")


def object_paths(card: str, model: str) -> dict:
    """Where the original and the web copy go. The private path is what 0137 stores (never a link); the public one is behind the CDN."""
    if not _SLUG.fullmatch(card) or model not in cs.MODELS:
        raise ValueError("not a card slug or not a Character Studio model")
    return {"original": f"{PRIVATE_BUCKET}/{card}/{model}.mp4", "web": f"{card}/{model}.mp4"}


def plan(card: str, model: str, video_seconds: float, resolution: str, cdn_base: str, entry) -> List[str]:
    paths = object_paths(card, model)
    usd = entry.raw["pricing"]["variants"]["prices"][resolution] * math.ceil(video_seconds)
    return [f"card {card}, model {model} ({entry.display_name}), {resolution}, {video_seconds:.1f} s",
            f"PAID: the vendor's list price for this clip is about ${usd:.2f} ({entry.raw['pricing']['source_url']})",
            f"terms gate: {entry.terms_gate}; the owner approves this one call with --run --approve-paid-call {model}",
            f"original -> {paths['original']} (private)", f"web copy -> {cdn_base.rstrip('/')}/{paths['web']} (public bucket {PUBLIC_BUCKET})"]


def probe_seconds(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True,
                         text=True, timeout=30, check=False)
    return float((out.stdout or "0").strip() or 0)


class Storage:
    """Supabase Storage and PostgREST with the service key (never printed)."""

    def __init__(self, url: str, key: str, session=None):
        self.url, self._key, self.s = url.rstrip("/"), key, session or requests.Session()

    def _h(self, extra=None):
        return {"apikey": self._key, "Authorization": f"Bearer {self._key}", **(extra or {})}

    def upload(self, bucket: str, path: str, data: bytes, mime: str) -> None:
        r = self.s.post(f"{self.url}/storage/v1/object/{bucket}/{path}", data=data, timeout=300,
                        headers=self._h({"Content-Type": mime, "x-upsert": "true"}))
        if r.status_code >= 300:
            raise SystemExit(f"upload to {bucket} failed: HTTP {r.status_code} (does the bucket exist? docs/CHARACTER_STUDIO.md)")

    def signed(self, bucket: str, path: str, seconds: int = 3600) -> str:
        r = self.s.post(f"{self.url}/storage/v1/object/sign/{bucket}/{path}", json={"expiresIn": seconds}, timeout=30, headers=self._h())
        if r.status_code >= 300:
            raise SystemExit(f"signing a link failed: HTTP {r.status_code}")
        return f"{self.url}/storage/v1{r.json()['signedURL']}"

    def save_sample(self, card: str, model: str, web_url: str, original: str) -> None:
        r = self.s.get(f"{self.url}/rest/v1/character_swap_templates", params={"slug": f"eq.{card}", "select": "id"}, timeout=30, headers=self._h())
        rows = r.json() if r.status_code < 300 else []
        if not rows:
            raise SystemExit(f"no card {card!r} in character_swap_templates (0137 applied?)")
        r = self.s.post(f"{self.url}/rest/v1/character_swap_template_samples", params={"on_conflict": "template_id,model_id"}, timeout=30,
                        json={"template_id": rows[0]["id"], "model_id": model, "web_url": web_url, "original_object": original,
                              "made_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
                        headers=self._h({"Prefer": "resolution=merge-duplicates,return=minimal"}))
        if r.status_code >= 300:
            raise SystemExit(f"saving the sample row failed: HTTP {r.status_code}")


def web_copy(src: Path, dest: Path) -> None:
    done = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "slow",
                           "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", str(dest)], capture_output=True, timeout=600, check=False)
    if done.returncode != 0:
        raise SystemExit("ffmpeg could not make the web copy")


def run(args, entry, storage: Storage, adapter=None) -> int:
    from modules.capabilities import build_adapter
    from modules.capabilities.base import FAILED, SUCCEEDED, CapabilityRequest

    paths = object_paths(args.card, args.model)
    stamp = time.strftime("%Y%m%d%H%M%S")
    inputs = [(args.video, "video/mp4")] + [(p, "image/png" if p.suffix.lower() == ".png" else "image/jpeg") for p in args.image]
    links = []
    for i, (p, mime) in enumerate(inputs):
        obj = f"inputs/{args.card}/{stamp}-{i}{p.suffix.lower()}"
        storage.upload(PRIVATE_BUCKET, obj, p.read_bytes(), mime)
        links.append(storage.signed(PRIVATE_BUCKET, obj))
    adapter = adapter or build_adapter(entry.adapter)
    request = CapabilityRequest(capability=cs.CAPABILITY, prompt=args.prompt, resolution=args.resolution, input_media=(links[0],),
                                input_images=tuple(links[1:]))
    bad = adapter.problems(request, entry)
    if bad:
        print("refused before the paid call: " + "; ".join(bad))
        return 2
    task = adapter.submit(request, entry.vendor_model_for(cs.CAPABILITY))
    print(f"vendor task {task.task_id} (if this script stops, poll this id; do not run it again)", flush=True)
    deadline = time.monotonic() + 45 * 60
    while True:
        result = adapter.poll(task)
        if result.state == SUCCEEDED:
            break
        if result.state == FAILED or time.monotonic() > deadline:
            print(f"the vendor did not finish: {result.error.code if result.error else 'timeout'}")
            return 1
        time.sleep(10)
    with tempfile.TemporaryDirectory() as tmp:
        original = adapter.fetch(result, tmp, stem="sample")[0]
        web = Path(tmp) / "web.mp4"
        web_copy(original, web)
        storage.upload(PRIVATE_BUCKET, paths["original"].split("/", 1)[1], original.read_bytes(), "video/mp4")
        storage.upload(PUBLIC_BUCKET, paths["web"], web.read_bytes(), "video/mp4")
    web_url = f"{args.cdn_base.rstrip('/')}/{paths['web']}"
    storage.save_sample(args.card, args.model, web_url, paths["original"])
    print(f"sample saved: {web_url}")
    return 0


def main(argv: Optional[Sequence[str]] = None, env=os.environ) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--card", required=True)
    ap.add_argument("--model", required=True, choices=cs.MODELS)
    ap.add_argument("--video", required=True, type=Path)
    ap.add_argument("--image", required=True, type=Path, action="append")
    ap.add_argument("--prompt", help="defaults to the card's own prompt; must pass 0137's screen")
    ap.add_argument("--resolution", default="720p", choices=("720p", "1080p"))
    ap.add_argument("--cdn-base", required=True)
    ap.add_argument("--run", action="store_true", help="make the PAID call (with --approve-paid-call)")
    ap.add_argument("--approve-paid-call", default="", help="the model id the owner approved one paid call for")
    args = ap.parse_args(argv)
    from modules import model_registry

    entry = model_registry.registry().get(args.model)
    if not _CDN.fullmatch(args.cdn_base.rstrip("/")):
        print("--cdn-base must be an https origin and path the CDN serves the public bucket from")
        return 2
    args.prompt = args.prompt or "Replace the person in @Video 1 with the character in @Image 1. Keep everything else in the video unchanged."
    problem = cs.prompt_problem(args.prompt)
    if problem:
        print(f"the prompt is refused: {problem}")
        return 2
    seconds = probe_seconds(args.video) if args.video.is_file() else 0.0
    for line in plan(args.card, args.model, seconds, args.resolution, args.cdn_base, entry):
        print(line)
    if not args.run:
        print("plan only: nothing was uploaded, called or paid for")
        return 0
    if args.approve_paid_call != args.model:
        print(f"refused: --approve-paid-call {args.model} is the owner's approval of this one paid call")
        return 2
    url, key = (env.get("SUPABASE_URL") or "").strip(), (env.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        print("set SUPABASE_URL and SUPABASE_SERVICE_KEY")
        return 2
    return run(args, entry, Storage(url, key))


if __name__ == "__main__":
    sys.exit(main())
