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

    def generate_broll(self, sections: list, topic: str, *, client=None, style_for=None):
        """Generate on-topic b-roll for a few sections with the selected video
        provider, when generation is enabled and configured. Returns a
        ``minimax_broll.GenerationResult``.

        The provider is chosen by ``config.VIDEO_PROVIDER`` via
        modules/video_providers.py; the default (``minimax``) behaves exactly as
        before. Off by default: with no key / the flag unset this makes no
        request and returns an empty result, so b-roll comes from Pexels exactly
        as before. Each generated clip is recorded in ``video_terms`` under its
        section keyword, so the compositor places it via broll_match like any
        other clip. A per-clip failure is swallowed — that section simply falls
        back to stock. Never raises.

        ``style_for`` (optional) is an ``index -> style string`` map: when given,
        each generated clip's prompt carries that scene's style direction (a
        Director shot direction and/or a Character-Bible consistency directive).
        None keeps the default look."""
        import config
        from modules import minimax_broll, provider_tasks, video_providers

        result = minimax_broll.GenerationResult(model=video_providers.active_model())
        if not video_providers.is_enabled():
            return result

        specs = minimax_broll.select_specs(
            sections, topic, max_clips=getattr(config, "MINIMAX_BROLL_MAX_CLIPS", 2),
            style_for=style_for)
        if not specs:
            return result

        if client is None:
            client = video_providers.get_client()
            if client is None:   # selected provider unconfigured — stay on stock
                return result

        provider_name = video_providers.active_provider()
        # Crash-safe task tracking (modules/provider_tasks.py): a client that
        # splits submit/resume has every paid task id persisted before polling,
        # so a retry of this run polls it instead of paying again.
        ledger = None
        if provider_tasks.supports_resume(client):
            ledger = provider_tasks.TaskLedger.open(getattr(self, "slug", None))
        by_section: dict = {}
        task_ids: dict = {}
        generated = 0
        reused = 0
        for spec in specs:
            dest = self.video_dir / f"gen_{spec.section_index}.mp4"
            was_reused = False
            try:
                if ledger is not None:
                    path, task_id, was_reused = self._generate_tracked(
                        client, spec, dest, provider_name, result.model, ledger)
                    if task_id:
                        task_ids[spec.section_index] = task_id
                else:
                    path = client.generate(spec, dest)
            except Exception as e:   # a broken clip must never sink the render
                logger.warning("%s generation error for section %d (%s: %s)",
                               provider_name, spec.section_index, type(e).__name__, e)
                path = None
            if path is not None:
                self.video_terms[str(path)] = spec.keyword
                by_section[spec.section_index] = str(path)
                generated += 1
                reused += 1 if was_reused else 0

        logger.info("%s b-roll: %d/%d clip(s) generated (%d reused from an earlier attempt)",
                    provider_name, generated, len(specs), reused)
        return minimax_broll.GenerationResult(
            attempted=len(specs), generated=generated,
            model=result.model, by_section=by_section,
            reused=reused, task_ids=task_ids,
        )

    @staticmethod
    def _generate_tracked(client, spec, dest: Path, provider_name: str, model: str, ledger):
        """One clip through the provider task ledger. Returns
        ``(path_or_None, task_id_or_None, reused_without_request)``.

        * a task for this scene + prompt that already succeeded and whose clip
          is still on disk → reused, no request at all;
        * a task that was submitted but never settled (the run died while
          polling, or the poll timed out) → **polled**, never re-submitted;
        * otherwise (no task, or the provider reported it failed) → a fresh
          submit, recorded in the ledger *before* polling starts.
        """
        from modules import provider_tasks as pt

        phash = pt.prompt_hash(provider_name, model, spec)
        sid = pt.scene_id(spec.section_index)
        task = ledger.find(provider_name, sid, phash)

        if task is not None:
            on_disk = task.clip_on_disk()
            if on_disk is not None:
                logger.info("%s scene %s: reusing clip from task %s (no new request)",
                            provider_name, sid, task.task_id)
                return on_disk, task.task_id, True
            if task.status == pt.STATUS_FAILED:
                task = None   # the provider said no — a new attempt is a new job
            else:
                logger.info("%s scene %s: polling existing task %s instead of re-submitting",
                            provider_name, sid, task.task_id)

        if task is None:
            task_id = client.submit(spec)
            if not task_id:
                return None, None, False
            task = ledger.record_submitted(provider=provider_name, model=model,
                                           task_id=task_id,
                                           section_index=spec.section_index, phash=phash)

        outcome = client.resume(task.task_id, dest)
        if not isinstance(outcome, pt.TaskOutcome):   # a client that broke the contract
            outcome = pt.TaskOutcome(pt.OUTCOME_PENDING)
        ledger.record_outcome(task, outcome)
        if outcome.path is not None:
            logger.info("%s b-roll generated for scene %s (%s)", provider_name, sid, spec.keyword)
        return outcome.path, task.task_id, False

    # --------------------------------------------------------------- AI images

    def generate_images(self, sections: list, topic: str, *, client=None, max_images=None) -> list[Path]:
        """Optionally generate a few on-topic stills with the selected image
        provider (modules/image_providers.py), supplementing the Pexels stock
        above. Off by default: with no key / the flag unset this makes no request
        and returns ``[]``, so backgrounds come from stock exactly as before. A
        per-image failure is swallowed — that section simply falls back to stock.
        Never raises."""
        import config
        from modules import image_providers

        if not image_providers.is_enabled():
            return []
        if client is None:
            client = image_providers.get_client()
            if client is None:
                return []

        cap = max_images if max_images is not None else getattr(config, "LEONARDO_MAX_IMAGES", 2)
        if cap <= 0:
            return []

        # The sections worth a bespoke still: hook first, then any with keywords.
        eligible: list[tuple[int, list[str]]] = []
        for i, section in enumerate(sections or []):
            if section is None:
                continue
            kws = section.get("keywords") if isinstance(section, dict) else getattr(section, "keywords", None)
            if isinstance(kws, str):
                kws = [kws] if kws.strip() else []
            if isinstance(kws, (list, tuple)) and kws:
                eligible.append((i, [str(k) for k in kws]))
        if not eligible:
            return []
        eligible.sort(key=lambda it: (0 if it[0] == 0 else 1, it[0]))

        paths: list[Path] = []
        for i, kws in eligible[:cap]:
            subject = ", ".join(dict.fromkeys(k.strip() for k in kws if k.strip())) or (topic or "").strip()
            prompt = f"{subject} — {topic}. Cinematic, high-detail, dramatic lighting.".strip(" —")
            dest = self.image_dir / f"gen_img_{i}.jpg"
            try:
                path = client.generate(prompt, dest, width=1024, height=576)
            except Exception as e:   # a broken image must never sink the render
                logger.warning("Image generation error for section %d (%s: %s)",
                               i, type(e).__name__, e)
                path = None
            if path is not None:
                paths.append(path)

        logger.info("%s images: %d/%d generated", image_providers.active_provider(), len(paths), min(cap, len(eligible)))
        return paths

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
