"""Stage 8: State Store — persists video records and metrics snapshots in SQLite."""

import logging
import os
import sqlite3
from pathlib import Path

from config import HISTORY_DIR

logger = logging.getLogger(__name__)

DEFAULT_DB_PATH = HISTORY_DIR / "chronos.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    video_id     TEXT PRIMARY KEY,
    topic        TEXT,
    title        TEXT,
    slug         TEXT,
    published_at TEXT,
    privacy      TEXT,
    category_id  TEXT,
    local_path   TEXT
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id                             INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id                       TEXT NOT NULL,
    snapshot_date                  TEXT NOT NULL,
    views                          INTEGER,
    likes                          INTEGER,
    comment_count                  INTEGER,
    watch_time_minutes             REAL,
    average_view_duration_seconds  REAL,
    FOREIGN KEY (video_id) REFERENCES videos (video_id),
    UNIQUE (video_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_metrics_video_date
    ON metrics_snapshots (video_id, snapshot_date);

CREATE TABLE IF NOT EXISTS competitor_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id       TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    title          TEXT,
    view_count     INTEGER,
    like_count     INTEGER,
    comment_count  INTEGER,
    published_at   TEXT,
    polled_date    TEXT NOT NULL,
    view_velocity  REAL,
    UNIQUE (video_id, polled_date)
);

CREATE INDEX IF NOT EXISTS idx_competitor_channel_date
    ON competitor_snapshots (channel_id, polled_date);

CREATE TABLE IF NOT EXISTS trending_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id       TEXT NOT NULL,
    title          TEXT,
    view_count     INTEGER,
    like_count     INTEGER,
    comment_count  INTEGER,
    published_at   TEXT,
    region_code    TEXT,
    category_id    TEXT,
    polled_date    TEXT NOT NULL,
    UNIQUE (video_id, polled_date, region_code)
);

CREATE INDEX IF NOT EXISTS idx_trending_date
    ON trending_snapshots (polled_date);

CREATE TABLE IF NOT EXISTS demand_signals (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_phrase          TEXT NOT NULL,
    mention_count         INTEGER NOT NULL,
    example_comment_ids   TEXT,
    polled_date           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demand_date
    ON demand_signals (polled_date);

CREATE TABLE IF NOT EXISTS feedback_signals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id         TEXT NOT NULL,
    topic            TEXT,
    signal           TEXT NOT NULL,
    metric_value     REAL,
    channel_baseline REAL,
    detail           TEXT,
    analyzed_date    TEXT NOT NULL,
    UNIQUE (video_id, signal, analyzed_date)
);

CREATE INDEX IF NOT EXISTS idx_feedback_date
    ON feedback_signals (analyzed_date);

CREATE TABLE IF NOT EXISTS topic_performance (
    topic            TEXT PRIMARY KEY,
    score            REAL NOT NULL,
    videos_analyzed  INTEGER NOT NULL,
    avg_views_per_day REAL,
    reason           TEXT,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event        TEXT NOT NULL,
    ts           TEXT NOT NULL,
    video_id     TEXT,
    job_id       TEXT,
    agent        TEXT,
    status       TEXT,
    duration_ms  REAL,
    metadata     TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON system_events (ts);
CREATE INDEX IF NOT EXISTS idx_events_video ON system_events (video_id);

-- Channel-scoped topic scores (Phase 5). `topic_performance` above is keyed on
-- `topic` alone and therefore structurally cannot hold two channels' verdicts
-- on the same topic string. Rather than rebuild that table (a destructive
-- migration, for a value that is recomputed from metrics anyway), channel-aware
-- scores live here, keyed on (channel_id, topic). The old table stays exactly
-- as it is and keeps being written for the default channel, so every existing
-- reader — including the Command Center's single-channel views — is unaffected.
CREATE TABLE IF NOT EXISTS channel_topic_performance (
    channel_id        TEXT NOT NULL,
    topic             TEXT NOT NULL,
    score             REAL NOT NULL,
    videos_analyzed   INTEGER NOT NULL,
    avg_views_per_day REAL,
    reason            TEXT,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (channel_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_ctp_channel_score
    ON channel_topic_performance (channel_id, score DESC);

-- What each video actually consumed (Phase 6). Quantities are facts the
-- pipeline observes; `estimated_usd` is NULL unless the operator configured a
-- rate for that unit, because an invented price quietly becomes "the cost".
-- See modules/cost_ledger.py.
CREATE TABLE IF NOT EXISTS video_costs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      TEXT,
    channel_id    TEXT NOT NULL DEFAULT 'default',
    slug          TEXT,
    unit          TEXT NOT NULL,
    quantity      REAL NOT NULL,
    stage         TEXT,
    estimated_usd REAL,
    recorded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_costs_video ON video_costs (video_id);
CREATE INDEX IF NOT EXISTS idx_costs_channel_date
    ON video_costs (channel_id, recorded_at DESC);

-- Audience-retention curve: one row per measured point of a video, where
-- `elapsed_ratio` is 0.0-1.0 through the video and `watch_ratio` is the share
-- of viewers still watching there. This is the strongest signal for improving
-- hooks, and nothing recorded it before.
CREATE TABLE IF NOT EXISTS retention_points (
    video_id      TEXT NOT NULL,
    elapsed_ratio REAL NOT NULL,
    watch_ratio   REAL,
    measured_date TEXT NOT NULL,
    UNIQUE (video_id, elapsed_ratio, measured_date)
);

CREATE INDEX IF NOT EXISTS idx_retention_video
    ON retention_points (video_id, elapsed_ratio);
"""

# Additive column migrations for databases created before Phase 5. Each entry is
# (table, column, DDL) and is applied only when the column is missing, so this is
# safe to run on every open and never touches existing data. SQLite backfills the
# DEFAULT into existing rows as part of ADD COLUMN — that is the "existing
# records belong to the default channel" backfill, done in one statement.
#
# `system_events.channel_id` is deliberately nullable with no default: null means
# "global" there (a system heartbeat is not any one channel's doing), while a
# channel's own work carries its id.
_COLUMN_MIGRATIONS = (
    ("videos", "channel_id", "TEXT NOT NULL DEFAULT 'default'"),
    ("feedback_signals", "channel_id", "TEXT NOT NULL DEFAULT 'default'"),
    # NOTE the name: competitor_snapshots.channel_id already exists and means
    # the *competitor's* YouTube channel. The Nightshift channel that is watching
    # them needs its own column, hence the prefix.
    ("competitor_snapshots", "chronos_channel_id", "TEXT NOT NULL DEFAULT 'default'"),
    ("demand_signals", "channel_id", "TEXT NOT NULL DEFAULT 'default'"),
    ("system_events", "channel_id", "TEXT"),
    # Phase 6: which thumbnail/title variant this video actually shipped with,
    # so the CTR read back later can be attributed to something.
    ("videos", "thumbnail_variant", "TEXT"),
    ("videos", "title_variant", "TEXT"),
    # First-30-seconds (hook) A/B (roadmap #60): which opening this video
    # shipped, so the retention read back later can be attributed to a hook.
    ("videos", "hook_variant", "TEXT"),
    # CTR as YouTube reports it. Nullable and NOT defaulted to 0: an unpolled
    # video has *unknown* click-through, which is not the same as none.
    ("metrics_snapshots", "impressions", "INTEGER"),
    ("metrics_snapshots", "impression_ctr", "REAL"),
    # Shorts: which format a row is, and which long video a Short was cut from.
    # Defaulted to 'long' because every existing row is one — that is a fact
    # about the history, not an assumption.
    ("videos", "video_format", "TEXT NOT NULL DEFAULT 'long'"),
    ("videos", "parent_video_id", "TEXT"),
)

# Kept as a literal rather than imported from modules.channels so the storage
# layer keeps no dependency on the channel model. The two must agree; a test
# asserts they do.
DEFAULT_CHANNEL_ID = "default"


def _resolve_db_path() -> Path:
    """DB path is overridable via CHRONOS_STATE_DB, defaulting under HISTORY_DIR."""
    override = os.getenv("CHRONOS_STATE_DB")
    return Path(override) if override else DEFAULT_DB_PATH


class StateStore:
    """SQLite-backed persistence for uploaded videos and their metrics history.

    Used as a context manager, or opened/closed manually:

        with StateStore() as store:
            store.record_video(video_id="abc123", topic="...", ...)
    """

    def __init__(self, db_path: Path | str | None = None):
        self.db_path = Path(db_path) if db_path is not None else _resolve_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        with self.conn:
            self.conn.executescript(_SCHEMA)
        self._apply_column_migrations()
        logger.info("State store ready at %s", self.db_path)

    def _apply_column_migrations(self):
        """Add any missing Phase 5 `channel_id` columns. Additive only — no
        drop, no rewrite, no data touched beyond SQLite's own DEFAULT backfill.
        A failure here is logged and swallowed: an older database that cannot
        take a new column must still serve the pipeline it already serves."""
        for table, column, ddl in _COLUMN_MIGRATIONS:
            try:
                existing = {
                    row["name"] for row in self.conn.execute(f"PRAGMA table_info({table})")
                }
                if not existing or column in existing:
                    continue
                with self.conn:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
                logger.debug("Added column %s.%s", table, column)
            except Exception as e:
                logger.warning(
                    "Could not add %s.%s (%s: %s) — continuing without it",
                    table, column, type(e).__name__, e,
                )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def close(self):
        self.conn.close()

    # -- videos ------------------------------------------------------------

    def record_video(
        self,
        video_id: str,
        topic: str = "",
        title: str = "",
        slug: str = "",
        published_at: str = "",
        privacy: str = "",
        category_id: str = "",
        local_path: str = "",
        channel_id: str = DEFAULT_CHANNEL_ID,
        thumbnail_variant: str = "",
        title_variant: str = "",
        hook_variant: str = "",
        video_format: str = "long",
        parent_video_id: str = "",
    ):
        """Insert a video row, or overwrite it if video_id already exists.

        `channel_id` defaults to the default channel, so an existing caller that
        does not know about channels records exactly what it recorded before.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO videos
                    (video_id, topic, title, slug, published_at, privacy, category_id,
                     local_path, channel_id, thumbnail_variant, title_variant,
                     hook_variant, video_format, parent_video_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                    topic=excluded.topic,
                    title=excluded.title,
                    slug=excluded.slug,
                    published_at=excluded.published_at,
                    privacy=excluded.privacy,
                    category_id=excluded.category_id,
                    local_path=excluded.local_path,
                    channel_id=excluded.channel_id,
                    thumbnail_variant=excluded.thumbnail_variant,
                    title_variant=excluded.title_variant,
                    hook_variant=excluded.hook_variant,
                    video_format=excluded.video_format,
                    parent_video_id=excluded.parent_video_id
                """,
                (video_id, topic, title, slug, published_at, privacy, category_id,
                 local_path, channel_id, thumbnail_variant, title_variant,
                 hook_variant, video_format or "long", parent_video_id),
            )
        logger.info("Recorded video: %s (%s)", video_id, title or topic)

    def get_video(self, video_id: str) -> dict | None:
        """Return the video row as a dict, or None if it doesn't exist."""
        row = self.conn.execute(
            "SELECT * FROM videos WHERE video_id = ?", (video_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_videos(
        self, limit: int = 100, since: str | None = None, channel_id: str | None = None
    ) -> list[dict]:
        """List videos, most recently published first.

        `since` (ISO8601) restricts to videos published on or after that
        timestamp. `channel_id` restricts to one channel; None means every
        channel, which is what a caller that predates multi-channel gets.
        """
        clauses, params = [], []
        if since:
            clauses.append("published_at >= ?")
            params.append(since)
        if channel_id is not None:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM videos{where} ORDER BY published_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- metrics -------------------------------------------------------------

    def record_metrics_snapshot(
        self,
        video_id: str,
        snapshot_date: str,
        views: int = 0,
        likes: int = 0,
        comment_count: int = 0,
        watch_time_minutes: float = 0.0,
        average_view_duration_seconds: float = 0.0,
        impressions: int | None = None,
        impression_ctr: float | None = None,
    ):
        """Insert or replace a metrics snapshot for a video on a given date.

        One row per (video_id, snapshot_date) — a re-poll for the same date
        overwrites the earlier snapshot rather than accumulating duplicates.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO metrics_snapshots
                    (video_id, snapshot_date, views, likes, comment_count,
                     watch_time_minutes, average_view_duration_seconds,
                     impressions, impression_ctr)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id, snapshot_date) DO UPDATE SET
                    views=excluded.views,
                    likes=excluded.likes,
                    comment_count=excluded.comment_count,
                    watch_time_minutes=excluded.watch_time_minutes,
                    average_view_duration_seconds=excluded.average_view_duration_seconds,
                    -- Keep a previously measured CTR when this poll did not
                    -- return one: null here means "not measured this time",
                    -- not "no clicks".
                    impressions=COALESCE(excluded.impressions, metrics_snapshots.impressions),
                    impression_ctr=COALESCE(excluded.impression_ctr, metrics_snapshots.impression_ctr)
                """,
                (
                    video_id,
                    snapshot_date,
                    views,
                    likes,
                    comment_count,
                    watch_time_minutes,
                    average_view_duration_seconds,
                    impressions,
                    impression_ctr,
                ),
            )
        logger.info("Recorded metrics snapshot: %s @ %s", video_id, snapshot_date)

    def latest_metrics(self, video_id: str) -> dict | None:
        """Return the most recent metrics snapshot for a video, or None."""
        row = self.conn.execute(
            """
            SELECT * FROM metrics_snapshots
            WHERE video_id = ?
            ORDER BY snapshot_date DESC
            LIMIT 1
            """,
            (video_id,),
        ).fetchone()
        return dict(row) if row else None

    def metrics_history(self, video_id: str) -> list[dict]:
        """Return all metrics snapshots for a video, ordered oldest to newest."""
        rows = self.conn.execute(
            """
            SELECT * FROM metrics_snapshots
            WHERE video_id = ?
            ORDER BY snapshot_date ASC
            """,
            (video_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- competitor snapshots -------------------------------------------------

    def record_competitor_snapshot(
        self,
        video_id: str,
        channel_id: str,
        polled_date: str,
        title: str = "",
        view_count: int = 0,
        like_count: int = 0,
        comment_count: int = 0,
        published_at: str = "",
        view_velocity: float = 0.0,
        chronos_channel_id: str = DEFAULT_CHANNEL_ID,
    ):
        """Insert or replace a competitor video's snapshot for a given poll date.

        One row per (video_id, polled_date) — a re-poll for the same date
        overwrites rather than accumulating duplicates, same pattern as
        record_metrics_snapshot.

        Two channel ids meet here and they are not the same thing: `channel_id`
        is the COMPETITOR's YouTube channel (it has always meant that), while
        `chronos_channel_id` is which of OUR channels is monitoring them.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO competitor_snapshots
                    (video_id, channel_id, title, view_count, like_count,
                     comment_count, published_at, polled_date, view_velocity, chronos_channel_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id, polled_date) DO UPDATE SET
                    channel_id=excluded.channel_id,
                    chronos_channel_id=excluded.chronos_channel_id,
                    title=excluded.title,
                    view_count=excluded.view_count,
                    like_count=excluded.like_count,
                    comment_count=excluded.comment_count,
                    published_at=excluded.published_at,
                    view_velocity=excluded.view_velocity
                """,
                (video_id, channel_id, title, view_count, like_count,
                 comment_count, published_at, polled_date, view_velocity, chronos_channel_id),
            )

    def list_competitor_snapshots(
        self,
        channel_id: str | None = None,
        since: str | None = None,
        limit: int = 200,
        chronos_channel_id: str | None = None,
    ) -> list[dict]:
        """List competitor snapshots, most recently polled first.

        Mind the two ids: `channel_id` filters by the COMPETITOR's YouTube
        channel (it always has), while `chronos_channel_id` filters by which of
        OUR channels is watching them. `since` (ISO date) restricts to snapshots
        polled on or after that date.
        """
        clauses, params = [], []
        if channel_id:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        if chronos_channel_id is not None:
            clauses.append("chronos_channel_id = ?")
            params.append(chronos_channel_id)
        if since:
            clauses.append("polled_date >= ?")
            params.append(since)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM competitor_snapshots {where} ORDER BY polled_date DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- trending snapshots -----------------------------------------------------

    def record_trending_snapshot(
        self,
        video_id: str,
        polled_date: str,
        title: str = "",
        view_count: int = 0,
        like_count: int = 0,
        comment_count: int = 0,
        published_at: str = "",
        region_code: str = "",
        category_id: str = "",
    ):
        """Insert or replace a trending-video snapshot for a given poll date.

        One row per (video_id, polled_date, region_code) — the same video can
        legitimately trend in more than one region on the same day.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO trending_snapshots
                    (video_id, title, view_count, like_count, comment_count,
                     published_at, region_code, category_id, polled_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id, polled_date, region_code) DO UPDATE SET
                    title=excluded.title,
                    view_count=excluded.view_count,
                    like_count=excluded.like_count,
                    comment_count=excluded.comment_count,
                    published_at=excluded.published_at,
                    category_id=excluded.category_id
                """,
                (video_id, title, view_count, like_count, comment_count,
                 published_at, region_code, category_id, polled_date),
            )

    def list_trending_snapshots(self, since: str | None = None, limit: int = 200) -> list[dict]:
        """List trending-video snapshots, most recently polled first."""
        if since:
            rows = self.conn.execute(
                "SELECT * FROM trending_snapshots WHERE polled_date >= ? "
                "ORDER BY polled_date DESC LIMIT ?",
                (since, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM trending_snapshots ORDER BY polled_date DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    # -- audience demand signals ------------------------------------------------

    def record_demand_signal(
        self,
        topic_phrase: str,
        mention_count: int,
        polled_date: str,
        example_comment_ids: str = "",
        channel_id: str = DEFAULT_CHANNEL_ID,
    ):
        """Append one audience-demand signal from a poll run.

        Unlike the snapshot tables above, this is a plain append log (no
        upsert) — each poll run's clustering can legitimately produce a
        different representative phrase for a similar underlying request,
        and collapsing that here would lose signal a downstream reader might
        want (e.g. trending phrasing over time).
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO demand_signals
                    (topic_phrase, mention_count, example_comment_ids, polled_date, channel_id)
                VALUES (?, ?, ?, ?, ?)
                """,
                (topic_phrase, mention_count, example_comment_ids, polled_date, channel_id),
            )

    def list_demand_signals(
        self, since: str | None = None, limit: int = 200, channel_id: str | None = None
    ) -> list[dict]:
        """List audience-demand signals, most recently polled first.

        `channel_id` restricts to what one channel's own audience asked for —
        a Finance viewer's request must never steer a history channel's topics.
        """
        clauses, params = [], []
        if since:
            clauses.append("polled_date >= ?")
            params.append(since)
        if channel_id is not None:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM demand_signals{where} ORDER BY polled_date DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- feedback signals --------------------------------------------------

    def record_feedback_signal(
        self,
        video_id: str,
        signal: str,
        analyzed_date: str,
        topic: str = "",
        metric_value: float | None = None,
        channel_baseline: float | None = None,
        detail: str = "",
        channel_id: str = DEFAULT_CHANNEL_ID,
    ):
        """Record a discrete learning signal for a video on a given analysis date.

        One row per (video_id, signal, analyzed_date) — re-running the feedback
        analysis on the same day overwrites rather than accumulating duplicates,
        so the signal history reflects one verdict per video per analysis run.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO feedback_signals
                    (video_id, topic, signal, metric_value, channel_baseline, detail,
                     analyzed_date, channel_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id, signal, analyzed_date) DO UPDATE SET
                    topic=excluded.topic,
                    metric_value=excluded.metric_value,
                    channel_baseline=excluded.channel_baseline,
                    detail=excluded.detail,
                    channel_id=excluded.channel_id
                """,
                (video_id, topic, signal, metric_value, channel_baseline, detail,
                 analyzed_date, channel_id),
            )

    def list_feedback_signals(
        self, since: str | None = None, limit: int = 200, channel_id: str | None = None
    ) -> list[dict]:
        """List feedback/learning signals, most recently analyzed first.
        `channel_id` restricts to one channel; None means every channel."""
        clauses, params = [], []
        if since:
            clauses.append("analyzed_date >= ?")
            params.append(since)
        if channel_id is not None:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM feedback_signals{where} ORDER BY analyzed_date DESC, id DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- topic performance -------------------------------------------------

    def upsert_topic_performance(
        self,
        topic: str,
        score: float,
        videos_analyzed: int,
        updated_at: str,
        avg_views_per_day: float | None = None,
        reason: str = "",
    ):
        """Insert or update the learned performance score for a topic.

        One row per topic — the latest feedback analysis replaces the earlier
        score, keeping a single current verdict per topic that Topic Manager
        can read when choosing what to make next.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO topic_performance
                    (topic, score, videos_analyzed, avg_views_per_day, reason, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(topic) DO UPDATE SET
                    score=excluded.score,
                    videos_analyzed=excluded.videos_analyzed,
                    avg_views_per_day=excluded.avg_views_per_day,
                    reason=excluded.reason,
                    updated_at=excluded.updated_at
                """,
                (topic, score, videos_analyzed, avg_views_per_day, reason, updated_at),
            )

    def get_topic_performance(self, topic: str) -> dict | None:
        """Return the learned performance row for one topic, or None."""
        row = self.conn.execute(
            "SELECT * FROM topic_performance WHERE topic = ?", (topic,)
        ).fetchone()
        return dict(row) if row else None

    def list_topic_performance(self, limit: int = 200) -> list[dict]:
        """List learned topic-performance rows, highest score first."""
        rows = self.conn.execute(
            "SELECT * FROM topic_performance ORDER BY score DESC, videos_analyzed DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- costs -------------------------------------------------------------

    def record_video_cost(
        self,
        unit: str,
        quantity: float,
        recorded_at: str,
        video_id: str = "",
        channel_id: str = DEFAULT_CHANNEL_ID,
        slug: str = "",
        stage: str = "",
        estimated_usd: float | None = None,
    ):
        """Append one measured cost. Append-only: a run that was retried cost
        real money twice, and collapsing that would understate it."""
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO video_costs
                    (video_id, channel_id, slug, unit, quantity, stage, estimated_usd, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (video_id, channel_id, slug, unit, quantity, stage, estimated_usd, recorded_at),
            )

    def list_video_costs(
        self, video_id: str | None = None, channel_id: str | None = None, limit: int = 1000
    ) -> list[dict]:
        """Recorded costs, most recent first."""
        clauses, params = [], []
        if video_id is not None:
            clauses.append("video_id = ?")
            params.append(video_id)
        if channel_id is not None:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM video_costs{where} ORDER BY recorded_at DESC, id DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- retention ---------------------------------------------------------

    def record_retention_point(
        self,
        video_id: str,
        elapsed_ratio: float,
        measured_date: str,
        watch_ratio: float | None = None,
    ):
        """Insert or replace one point of a video's retention curve for a date."""
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO retention_points (video_id, elapsed_ratio, watch_ratio, measured_date)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(video_id, elapsed_ratio, measured_date) DO UPDATE SET
                    watch_ratio=excluded.watch_ratio
                """,
                (video_id, elapsed_ratio, watch_ratio, measured_date),
            )

    def retention_curve(self, video_id: str) -> list[dict]:
        """A video's most recently measured curve, ordered through the video."""
        rows = self.conn.execute(
            """
            SELECT * FROM retention_points
            WHERE video_id = ?
              AND measured_date = (
                  SELECT MAX(measured_date) FROM retention_points WHERE video_id = ?
              )
            ORDER BY elapsed_ratio ASC
            """,
            (video_id, video_id),
        ).fetchall()
        return [dict(row) for row in rows]

    # -- channel-scoped topic performance ----------------------------------

    def upsert_channel_topic_performance(
        self,
        channel_id: str,
        topic: str,
        score: float,
        videos_analyzed: int,
        updated_at: str,
        avg_views_per_day: float | None = None,
        reason: str = "",
    ):
        """Insert or update one channel's learned score for a topic.

        Keyed on (channel_id, topic), so a topic that works for Finance and
        flops for History holds two independent verdicts — the isolation the
        single-key `topic_performance` table cannot express.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO channel_topic_performance
                    (channel_id, topic, score, videos_analyzed, avg_views_per_day, reason, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id, topic) DO UPDATE SET
                    score=excluded.score,
                    videos_analyzed=excluded.videos_analyzed,
                    avg_views_per_day=excluded.avg_views_per_day,
                    reason=excluded.reason,
                    updated_at=excluded.updated_at
                """,
                (channel_id, topic, score, videos_analyzed, avg_views_per_day, reason, updated_at),
            )

    def get_channel_topic_performance(self, channel_id: str, topic: str) -> dict | None:
        """One channel's learned row for one topic, or None."""
        row = self.conn.execute(
            "SELECT * FROM channel_topic_performance WHERE channel_id = ? AND topic = ?",
            (channel_id, topic),
        ).fetchone()
        return dict(row) if row else None

    def list_channel_topic_performance(
        self, channel_id: str | None = None, limit: int = 200
    ) -> list[dict]:
        """Learned topic rows, highest score first. `channel_id` restricts to
        one channel; None returns every channel's rows (each still carrying its
        own channel_id, so a caller can group them without them being mixed)."""
        if channel_id is not None:
            rows = self.conn.execute(
                "SELECT * FROM channel_topic_performance WHERE channel_id = ? "
                "ORDER BY score DESC, videos_analyzed DESC LIMIT ?",
                (channel_id, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM channel_topic_performance "
                "ORDER BY channel_id ASC, score DESC, videos_analyzed DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    # -- system events -----------------------------------------------------

    def record_event(
        self,
        event: str,
        ts: str,
        video_id: str | None = None,
        job_id: str | None = None,
        agent: str | None = None,
        status: str | None = None,
        duration_ms: float | None = None,
        metadata: str | None = None,
        channel_id: str | None = None,
    ):
        """Append one observability event (append-only — the event stream is a
        log, never deduplicated). `metadata` is an already-serialized JSON string
        (see modules/event_log.py, which sanitizes it first).

        `channel_id` is None for genuinely global events (system heartbeat,
        infrastructure) and set for a channel's own work — the distinction the
        Command Center needs to avoid showing one channel another's activity.
        """
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO system_events
                    (event, ts, video_id, job_id, agent, status, duration_ms, metadata, channel_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (event, ts, video_id, job_id, agent, status, duration_ms, metadata, channel_id),
            )

    def list_events(
        self,
        since: str | None = None,
        limit: int = 200,
        video_id: str | None = None,
        channel_id: str | None = None,
        include_global: bool = True,
    ) -> list[dict]:
        """List observability events, most recent first, optionally filtered by
        `since` (ISO8601 lower bound on ts), `video_id` and/or `channel_id`.

        With `channel_id` set, `include_global` decides whether events that
        belong to no channel (null channel_id — system heartbeats and other
        infrastructure) come along. They usually should: an operator looking at
        one channel still needs to know the database is down.
        """
        clauses: list[str] = []
        params: list = []
        if since:
            clauses.append("ts >= ?")
            params.append(since)
        if video_id:
            clauses.append("video_id = ?")
            params.append(video_id)
        if channel_id is not None:
            if include_global:
                clauses.append("(channel_id = ? OR channel_id IS NULL)")
            else:
                clauses.append("channel_id = ?")
            params.append(channel_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(limit)
        rows = self.conn.execute(
            f"SELECT * FROM system_events{where} ORDER BY ts DESC, id DESC LIMIT ?",
            params,
        ).fetchall()
        return [dict(row) for row in rows]
