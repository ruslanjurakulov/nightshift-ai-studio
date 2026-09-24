"""Stage 1: Topic & History Manager — tracks used topics, picks fresh ones via Gemini."""

import json
import logging
from datetime import datetime
from pathlib import Path

from config import GEMINI_MODEL, TOPIC_HISTORY_FILE, SCRIPT_LANGUAGE
from modules.content_planner import ContentPlanner
from modules.feedback_engine import FeedbackEngine
from modules.gemini_client import generate_with_retry, make_client
from modules.originality_engine import OriginalityEngine
from modules.performance_analyzer import PerformanceAnalyzer
from modules.topic_recommender import TopicRecommender

logger = logging.getLogger(__name__)

MAX_TOPIC_ATTEMPTS = 3


class TopicManager:
    """Chooses what to make next.

    With a ``channel``, every input it consults is that channel's own: its
    queue, its past videos, its learned topic scores. Cross-channel
    contamination here would be the worst kind — it would pick History topics
    because Finance did well — so the channel id is passed down to each
    collaborator rather than left to a global.
    """

    def __init__(self, channel=None):
        TOPIC_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.channel = channel
        self.channel_id = str(channel.channel_id) if channel is not None else None
        # The content-planner entry this run picked, if the topic came off the
        # queue (None when Gemini generated it fresh). Held so the run can mark
        # it rendered / published at the real moments, rather than the queue
        # marking it "published" the instant it was picked. See
        # _try_queued_topic and mark_queue_entry_* below.
        self._reserved_entry = None
        self.history = self._load()
        self.client = make_client()
        self.originality = OriginalityEngine()
        self.recommender = self._safe_make_recommender()
        self.content_planner = self._safe_make_content_planner()
        self.performance_analyzer = self._safe_make_performance_analyzer()
        self.feedback_engine = self._safe_make_feedback_engine()

    def _safe_make_recommender(self) -> TopicRecommender | None:
        """TopicRecommender degrades gracefully on its own (empty DB, a
        broken store, etc. all return "" rather than raising), but its
        constructor is not exercised by that guarantee — so failing to
        construct it at all must not stop topic selection from working.

        Scoped to this channel like every other collaborator above: the
        recommender's competitor and audience-demand inputs are channel-owned,
        and feeding another channel's demand signals into this channel's topic
        prompt is exactly the cross-channel contamination this class exists to
        prevent. ``channel_id`` is None for a single-channel run, which keeps
        TopicRecommender's own pre-multi-channel (unscoped) behaviour.
        """
        try:
            return TopicRecommender(channel_id=self.channel_id)
        except Exception as e:
            logger.warning(
                "Failed to construct TopicRecommender (%s: %s) — proceeding without "
                "trend/demand suggestions in the topic prompt",
                type(e).__name__, e,
            )
            return None

    def _safe_make_content_planner(self) -> ContentPlanner | None:
        try:
            if self.channel_id is not None:
                return ContentPlanner(channel_id=self.channel_id)
            return ContentPlanner()
        except Exception as e:
            logger.warning(
                "Failed to construct ContentPlanner (%s: %s) — proceeding without "
                "the queued-topic check",
                type(e).__name__, e,
            )
            return None

    def _safe_make_performance_analyzer(self) -> PerformanceAnalyzer | None:
        """Same rationale as _safe_make_recommender: PerformanceAnalyzer's own
        methods already degrade to "" / [] on internal failure, but a
        construction failure isn't covered by that guarantee.
        """
        try:
            return PerformanceAnalyzer(channel_id=self.channel_id)
        except Exception as e:
            logger.warning(
                "Failed to construct PerformanceAnalyzer (%s: %s) — proceeding without "
                "past-performance context in the topic prompt",
                type(e).__name__, e,
            )
            return None

    def _safe_make_feedback_engine(self) -> FeedbackEngine | None:
        """FeedbackEngine reads the learned per-topic scores the feedback loop
        persisted (see modules/feedback_engine.py). Its own reads degrade to ""
        on failure, but constructing it opens a StateStore, so guard that too.
        """
        try:
            return FeedbackEngine(channel_id=self.channel_id)
        except Exception as e:
            logger.warning(
                "Failed to construct FeedbackEngine (%s: %s) — proceeding without "
                "learned topic scores in the prompt",
                type(e).__name__, e,
            )
            return None

    def _approved_learnings_text(self) -> str:
        """Approved topic learnings for this channel, or "" — never raises."""
        try:
            from modules import learning_memory

            return learning_memory.approved_learnings_as_prompt_text(
                self.channel_id or "default", learning_memory.TOPIC_PROMPT_KINDS
            )
        except Exception as e:
            logger.warning(
                "Approved learnings unavailable (%s: %s) — choosing the topic without them",
                type(e).__name__, e,
            )
            return ""

    def _load(self) -> dict:
        if TOPIC_HISTORY_FILE.exists():
            return json.loads(TOPIC_HISTORY_FILE.read_text())
        return {"used_topics": [], "sessions": []}

    def _save(self):
        TOPIC_HISTORY_FILE.write_text(json.dumps(self.history, indent=2, ensure_ascii=False))

    def _used_topics_str(self) -> str:
        topics = self.history["used_topics"]
        return "\n".join(f"- {t}" for t in topics[-80:]) if topics else "None yet."

    def _safe_originality_check(self, candidate: str):
        """OriginalityEngine's default embedder downloads model2vec weights from
        HuggingFace on first use — a transient network failure there must not
        crash topic selection (and with it the whole run). Returns None on
        failure, meaning "skip the check for this topic" rather than blocking.
        """
        try:
            return self.originality.check(candidate)
        except Exception as e:
            logger.warning(
                "OriginalityEngine.check failed (%s: %s) — skipping originality check for '%s'",
                type(e).__name__, e, candidate,
            )
            return None

    def _safe_originality_register(self, topic: str):
        try:
            self.originality.register(topic)
        except Exception as e:
            logger.warning(
                "OriginalityEngine.register failed (%s: %s) — '%s' still recorded in used_topics, "
                "just not in the originality vector store",
                type(e).__name__, e, topic,
            )

    def _generate_topic(self, niche: str) -> str:
        prompt = (
            f"You create viral YouTube Shorts scripts in the niche: '{niche}'.\n"
            f"Language: {SCRIPT_LANGUAGE}\n\n"
            f"Already used topics (DO NOT repeat these):\n{self._used_topics_str()}\n\n"
            "Pick ONE brand-new, highly engaging topic for a 5-minute YouTube video. "
            "Return ONLY the topic title — no explanation, no numbering."
        )
        # This is the feedback loop: real persisted trend/competitor/demand
        # data (when any exists — see TopicRecommender) offered as optional
        # inspiration, never as a directive. Gemini still makes the actual
        # call; this only gives it more to work with.
        if self.recommender is not None:
            suggestions = self.recommender.suggest_topics_as_prompt_text()
            if suggestions:
                prompt += f"\n\n{suggestions}"
        # Same feedback-loop spirit as the recommender block above, but for
        # what actually happened after publishing rather than what's
        # currently trending: real past-performance numbers, offered as
        # context, never as a directive (see PerformanceAnalyzer's own
        # "Honesty-preserving framing" docstring section).
        if self.performance_analyzer is not None:
            performance_context = self.performance_analyzer.analyze_videos_as_prompt_text()
            if performance_context:
                prompt += f"\n\n{performance_context}"
        # The closed feedback loop: the FeedbackEngine turned real published-
        # video metrics into persistent per-topic scores (see
        # modules/feedback_engine.py). Surfacing them here is what makes that
        # learning actually influence the next choice — framed as guidance from
        # this channel's own results, not a rule.
        if self.feedback_engine is not None:
            learned_scores = self.feedback_engine.topic_scores_as_prompt_text()
            if learned_scores:
                prompt += f"\n\n{learned_scores}"
        # Human-approved learnings (modules/learning_memory.py): only rows an
        # operator approved on the Learning page; "" when there are none.
        approved = self._approved_learnings_text()
        if approved:
            prompt += f"\n\n{approved}"
        response = generate_with_retry(self.client, GEMINI_MODEL, prompt)
        return response.text.strip().strip('"').strip("'")

    def _try_queued_topic(self) -> str | None:
        """Check modules/content_planner.py's queue before spending a Gemini
        call on a fresh topic. A queued entry (enqueued elsewhere — e.g. from
        TopicRecommender suggestions fed in by the intelligence poller) still
        goes through the same OriginalityEngine check as a Gemini-generated
        candidate would: real duplicate topics don't get a pass just because
        they came from the queue.

        A queued entry that's accepted is **reserved** in the planner, not
        marked published: the entry is only claimed by this run, and it is
        advanced to "rendered" and then "published" at the real moments those
        things happen (see mark_queue_entry_rendered / mark_queue_entry_published,
        which main.py calls). This is what closes the "marked published the
        instant it was picked" gap — a run that fails downstream leaves the
        entry honestly at "reserved" or "rendered", never a false "published".
        A hard-blocked duplicate is marked "skipped" (not left queued forever)
        and topic selection falls through to Gemini generation.

        Returns None (falls through to Gemini generation) if the planner is
        unavailable, the queue is empty, or the queued topic is hard-blocked.
        """
        if self.content_planner is None:
            return None

        entry = self.content_planner.next_topic()
        if entry is None:
            return None

        result = self._safe_originality_check(entry.topic)
        if result is not None and result.is_duplicate:
            logger.warning(
                "Queued topic '%s' (entry %s) hard-blocked as duplicate of '%s' — skipping it, falling back to Gemini",
                entry.topic, entry.entry_id, result.closest_match,
            )
            self.content_planner.mark_skipped(entry.entry_id, reason="hard-blocked as duplicate by originality check")
            return None

        if result is not None and result.needs_review:
            logger.warning(
                "Queued topic '%s' flagged for review as near-duplicate of '%s' — using anyway",
                entry.topic, result.closest_match,
            )

        self.content_planner.reserve(entry.entry_id)
        self._reserved_entry = entry
        logger.info("Reserved queued topic from content planner: '%s' (entry %s, source=%s)",
                    entry.topic, entry.entry_id, entry.source)
        return entry.topic

    def mark_queue_entry_rendered(self) -> None:
        """Advance this run's reserved queue entry to "rendered" — its video
        now exists on disk. No-op when the topic did not come off the queue, or
        when the planner is unavailable. Never raises: a bookkeeping update must
        not turn a run that produced a video into a failed one."""
        self._advance_queue_entry("mark_rendered", "rendered")

    def mark_queue_entry_published(self) -> None:
        """Advance this run's reserved queue entry to "published" — its upload
        actually succeeded. No-op when the topic did not come off the queue.
        Never raises (same reason as mark_queue_entry_rendered)."""
        self._advance_queue_entry("mark_published", "published")

    def _advance_queue_entry(self, method_name: str, status: str) -> None:
        if self._reserved_entry is None or self.content_planner is None:
            return
        try:
            getattr(self.content_planner, method_name)(self._reserved_entry.entry_id)
        except Exception as e:
            logger.warning(
                "Could not advance queue entry %s to '%s' (%s: %s) — the run itself is unaffected",
                self._reserved_entry.entry_id, status, type(e).__name__, e,
            )

    def pick_topic(self, niche: str = "history mysteries") -> str:
        """Pick a topic for the next video.

        Checks modules/content_planner.py's queue first (see
        _try_queued_topic) — a queued suggestion, once it clears the same
        originality check a fresh one would, is used directly and no Gemini
        call is spent picking a topic at all. Only when the queue is empty
        or its candidate is rejected does this fall through to asking
        Gemini for a fresh one.

        The exact-string exclusion list handles topics Gemini has already
        seen; OriginalityEngine additionally catches paraphrased/reworded
        repeats that string matching misses. A hard-blocked duplicate is
        regenerated (bounded retries) rather than silently accepted; a
        flagged-for-review near-duplicate is logged but still used, since
        the threshold is a starting point, not a validated cutoff.
        """
        queued_topic = self._try_queued_topic()
        if queued_topic is not None:
            logger.info("Selected topic: %s", queued_topic)
            return queued_topic

        topic = None
        for attempt in range(1, MAX_TOPIC_ATTEMPTS + 1):
            candidate = self._generate_topic(niche)
            result = self._safe_originality_check(candidate)
            if result is None:
                topic = candidate
                break
            if result.is_duplicate:
                logger.warning(
                    "Topic '%s' hard-blocked as duplicate of '%s' (semantic=%.2f, lexical=%.2f), attempt %d/%d",
                    candidate, result.closest_match, result.semantic_score, result.lexical_score,
                    attempt, MAX_TOPIC_ATTEMPTS,
                )
                continue
            if result.needs_review:
                logger.warning(
                    "Topic '%s' flagged for review as near-duplicate of '%s' (semantic=%.2f, lexical=%.2f) — using anyway",
                    candidate, result.closest_match, result.semantic_score, result.lexical_score,
                )
            topic = candidate
            break

        if topic is None:
            logger.warning("All %d topic attempts hard-blocked as duplicates; using the last one anyway", MAX_TOPIC_ATTEMPTS)
            topic = candidate

        logger.info("Selected topic: %s", topic)
        return topic

    def register_topic(
        self,
        topic: str,
        video_path: str = "",
        video_id: str | None = None,
        video_url: str | None = None,
    ):
        """Mark topic as used after successful video creation."""
        self.history["used_topics"].append(topic)
        self.history["sessions"].append({
            "topic": topic,
            "date": datetime.utcnow().isoformat(),
            "video": str(video_path),
            "video_id": video_id,
            "video_url": video_url,
        })
        self._save()
        self._safe_originality_register(topic)
        logger.info("Topic registered: %s (video_id=%s)", topic, video_id)
