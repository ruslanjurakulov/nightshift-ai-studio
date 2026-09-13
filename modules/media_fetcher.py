"""Stage 4: Media Fetcher — Pexels HD Videos + Ken Burns Images."""

import logging
import random
import time
from pathlib import Path

import requests

from config import (
    OUTPUT_DIR,
    PEXELS_API_KEY,
    PEXELS_PER_PAGE,
    PEXELS_VIDEO_ORIENTATION,
    VIDEO_WIDTH,
)

logger = logging.getLogger(__name__)

PEXELS_VIDEO_API = "https://api.pexels.com/videos/search"
PEXELS_PHOTO_API = "https://api.pexels.com/v1/search"
PIXABAY_VIDEO_API = "https://pixabay.com/api/videos/"

# Pexels quality priority order
QUALITY_PRIORITY = ["uhd", "hd", "sd"]


class MediaFetcher:
    def __init__(self, topic_slug: str):
        self.slug = topic_slug
        self.video_dir = OUTPUT_DIR / topic_slug / "media" / "videos"
        self.image_dir = OUTPUT_DIR / topic_slug / "media" / "images"
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.session = requests.Session()
        self.session.headers.update({"Authorization": PEXELS_API_KEY})
        #: Pexels API searches issued by this fetcher. Counted for the cost
        #: ledger (modules/cost_ledger.py) — searches are what the API quota is
        #: spent on, so this is the number that matters, not bytes downloaded.
        self.searches_made = 0
        #: Which search keyword fetched each downloaded video, keyed by str(path).
        #: The compositor uses this to place footage under the section whose
        #: keywords it actually matches (modules/broll_match.py), instead of at
        #: random. Empty until fetch_videos runs; a clip with no recorded term
        #: simply doesn't match, it is never dropped.
        self.video_terms: dict[str, str] = {}

    # ------------------------------------------------------------------ Pexels Videos

    def _pexels_video_search(self, query: str, page: int = 1) -> list[dict]:
        params = {
            "query": query,
            "orientation": PEXELS_VIDEO_ORIENTATION,
            "size": "large",
            "per_page": PEXELS_PER_PAGE,
            "page": page,
        }
        self.searches_made += 1
        resp = self.session.get(PEXELS_VIDEO_API, params=params, timeout=15)
        resp.raise_for_status()
        return resp.json().get("videos", [])

    def _best_video_file(self, video: dict) -> str | None:
        files = video.get("video_files", [])
        for quality in QUALITY_PRIORITY:
            for f in files:
                if f.get("quality") == quality and f.get("width", 0) >= VIDEO_WIDTH:
                    return f["link"]
        # Fallback: largest resolution
        files_sorted = sorted(files, key=lambda f: f.get("width", 0), reverse=True)
        return files_sorted[0]["link"] if files_sorted else None

    def _download(self, url: str, dest: Path) -> bool:
        if dest.exists():
            return True
        try:
            resp = requests.get(url, stream=True, timeout=60)
            resp.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    f.write(chunk)
            return True
        except Exception as e:
            logger.warning("Download failed %s: %s", url, e)
            dest.unlink(missing_ok=True)
            return False

    def fetch_videos(self, keywords: list[str], count: int = 10) -> list[Path]:
        """Fetch `count` unique HD videos for the given keywords."""
        paths: list[Path] = []
        used_ids: set[int] = set()

        for keyword in keywords:
            if len(paths) >= count:
                break
            try:
                videos = self._pexels_video_search(keyword)
                random.shuffle(videos)
                for v in videos:
                    if len(paths) >= count:
                        break
                    vid_id = v["id"]
                    if vid_id in used_ids:
                        continue
                    link = self._best_video_file(v)
                    if not link:
                        continue
                    ext = "mp4"
                    dest = self.video_dir / f"{vid_id}.{ext}"
                    if self._download(link, dest):
                        paths.append(dest)
                        used_ids.add(vid_id)
                        self.video_terms[str(dest)] = keyword
                        logger.debug("Video: %s", dest.name)
                time.sleep(0.3)
            except Exception as e:
                logger.warning("Pexels video error for '%s': %s", keyword, e)

        logger.info("Fetched %d videos", len(paths))
        return paths

    # --------------------------------------------------------------- AI b-roll

    def generate_broll(self, sections: list, topic: str, *, client=None):
        """Generate on-topic b-roll for a few sections with MiniMax H3, when the
        feature is enabled and configured. Returns a
        ``minimax_broll.GenerationResult``.

        Off by default: with no key / the flag unset this makes no request and
        returns an empty result, so b-roll comes from Pexels exactly as before.
        Each generated clip is recorded in ``video_terms`` under its section
        keyword, so the compositor places it via broll_match like any other clip.
        A per-clip failure is swallowed — that section simply falls back to
        stock. Never raises."""
        import config
        from modules import minimax_broll

        result = minimax_broll.GenerationResult(model=getattr(config, "MINIMAX_H3_MODEL", ""))
        if not getattr(config, "MINIMAX_BROLL_ENABLED", False):
            return result

        specs = minimax_broll.select_specs(
            sections, topic, max_clips=getattr(config, "MINIMAX_BROLL_MAX_CLIPS", 2))
        if not specs:
            return result

        if client is None:
            from modules.minimax_client import MiniMaxClient
            client = MiniMaxClient()

        by_section: dict = {}
        generated = 0
        for spec in specs:
            dest = self.video_dir / f"gen_{spec.section_index}.mp4"
            try:
                path = client.generate(spec, dest)
            except Exception as e:   # a broken clip must never sink the render
                logger.warning("MiniMax generation error for section %d (%s: %s)",
                               spec.section_index, type(e).__name__, e)
                path = None
            if path is not None:
                self.video_terms[str(path)] = spec.keyword
                by_section[spec.section_index] = str(path)
                generated += 1

        logger.info("MiniMax b-roll: %d/%d clip(s) generated", generated, len(specs))
        return minimax_broll.GenerationResult(
            attempted=len(specs), generated=generated,
            model=result.model, by_section=by_section,
        )

    # ------------------------------------------------------------------ Pexels Images

    def _pexels_photo_search(self, query: str, page: int = 1) -> list[dict]:
        self.searches_made += 1
        resp = self.session.get(
            PEXELS_PHOTO_API,
            params={"query": query, "per_page": PEXELS_PER_PAGE, "page": page},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get("photos", [])

    def fetch_images(self, keywords: list[str], count: int = 8) -> list[Path]:
        """Fetch high-res images; they'll get Ken Burns treatment in compositor."""
        paths: list[Path] = []
        used_ids: set[int] = set()

        for keyword in keywords:
            if len(paths) >= count:
                break
            try:
                photos = self._pexels_photo_search(keyword)
                for p in photos:
                    if len(paths) >= count:
                        break
                    pid = p["id"]
                    if pid in used_ids:
                        continue
                    url = p.get("src", {}).get("original") or p.get("src", {}).get("large2x")
                    if not url:
                        continue
                    dest = self.image_dir / f"{pid}.jpg"
                    if self._download(url, dest):
                        paths.append(dest)
                        used_ids.add(pid)
                time.sleep(0.3)
            except Exception as e:
                logger.warning("Pexels photo error for '%s': %s", keyword, e)

        logger.info("Fetched %d images", len(paths))
        return paths

    # ------------------------------------------------------------------ Keyword extraction

    @staticmethod
    def extract_keywords(topic: str, n: int = 8) -> list[str]:
        """Last-resort keywords when the script carried none for any section."""
        words = [w for w in topic.lower().split() if len(w) > 3]
        cinematic = ["cinematic", "documentary", "historical", "dramatic", "ancient"]
        return (words + cinematic)[:n]
