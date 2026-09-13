import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Limit BLAS/OpenMP thread pools before numpy (and Whisper/Torch) load.
# Without this, OpenBLAS tries to allocate per-thread buffers for every core
# and dies with "Memory allocation still failed after 10 retries" on Windows.
# config is the first project import in main.py, so setting these here lands
# before any numpy import. Override with BLAS_THREADS in .env if needed.
_blas_threads = os.getenv("BLAS_THREADS", "1")
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, _blas_threads)

BASE_DIR = Path(__file__).parent

# API Keys
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
PEXELS_API_KEY = os.getenv("PEXELS_API_KEY", "")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
YOUTUBE_CLIENT_SECRET = os.getenv("YOUTUBE_CLIENT_SECRET_FILE", str(BASE_DIR / "client_secret.json"))

# Paths
HISTORY_DIR = BASE_DIR / "history"
OUTPUT_DIR = BASE_DIR / "output"
ASSETS_DIR = BASE_DIR / "assets"
SFX_DIR = ASSETS_DIR / "sfx"
MUSIC_DIR = ASSETS_DIR / "music"
LOGS_DIR = BASE_DIR / "logs"
TOPIC_HISTORY_FILE = HISTORY_DIR / "topics.json"

# Script Engine
# gemini-3.6-flash is the current model. Do NOT "correct" this to 2.0-flash:
# as of 2026-09 the API returns 404 for gemini-2.0-flash — "This model is no
# longer available. Please update your code to use models/gemini-3.6-flash" —
# so a run set to 2.0 dies at the first script call, before it renders anything.
# Override with the GEMINI_MODEL env var when Google ships the next one.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
# Transient 503/429 retries. Daily-quota 429s are not retried — see gemini_client.
GEMINI_MAX_RETRIES = int(os.getenv("GEMINI_MAX_RETRIES", "5"))
GEMINI_RETRY_MAX_DELAY = float(os.getenv("GEMINI_RETRY_MAX_DELAY", "60"))
SCRIPT_LANGUAGE = os.getenv("SCRIPT_LANGUAGE", "English")
VIDEO_DURATION_TARGET = int(os.getenv("VIDEO_DURATION_TARGET", "300"))  # seconds

# TTS
# ElevenLabs is the better narration and is now the default WHENEVER a key is
# configured — a natural voice is a real retention lever. It is not forced when
# no key is set: elevenlabs without credentials would fail verify_voice (which,
# by design, never falls back to edge — a wrong voice is worse than no video),
# so the default is edge until a key exists. An explicit TTS_PROVIDER always
# wins, so a channel can still choose edge on purpose.
TTS_PROVIDER = os.getenv("TTS_PROVIDER", "elevenlabs" if ELEVENLABS_API_KEY else "edge")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-US-ChristopherNeural")

# Audio
MUSIC_VOLUME = float(os.getenv("MUSIC_VOLUME", "0.08"))
SFX_VOLUME = float(os.getenv("SFX_VOLUME", "0.5"))
NARRATOR_VOLUME = float(os.getenv("NARRATOR_VOLUME", "1.0"))

# Media
PEXELS_VIDEO_ORIENTATION = "landscape"
PEXELS_VIDEO_QUALITY = "hd"
PEXELS_PER_PAGE = 15
KEN_BURNS_ZOOM_RATIO = 0.04  # zoom-in factor per second

# Video
VIDEO_WIDTH = 1920
VIDEO_HEIGHT = 1080
VIDEO_FPS = 30
SUBTITLE_FONT = "Arial-Bold"
SUBTITLE_FONT_SIZE = 60
SUBTITLE_COLOR = "white"
SUBTITLE_HIGHLIGHT_COLOR = os.getenv("SUBTITLE_HIGHLIGHT_COLOR", "#FFD700")  # spoken word
SUBTITLE_STROKE_COLOR = "black"
SUBTITLE_STROKE_WIDTH = 3
SUBTITLE_POSITION = ("center", 0.80)

# YouTube Upload
YOUTUBE_CATEGORY_ID = "28"  # Science & Technology
YOUTUBE_PRIVACY = os.getenv("YOUTUBE_PRIVACY", "private")  # private | unlisted | public
YOUTUBE_CHANNEL_ID = os.getenv("YOUTUBE_CHANNEL_ID", "")   # set this after running --list-channels
YOUTUBE_SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    # Writing a caption track counts as editing the video, so captions.insert
    # needs force-ssl — which also permits deleting videos. That is a real
    # trade for a caption track and it is the account owner's to make: dropping
    # this line loses the caption track and nothing else. Existing tokens do
    # not gain the scope by being listed here; they must be reconnected with
    # tools/connect_channel.py, and until they are, the uploader sees the scope
    # missing and skips captions instead of failing an upload.
    "https://www.googleapis.com/auth/youtube.force-ssl",
]

# Revenue tracking (roadmap #71) reads YouTube Analytics' estimatedRevenue,
# which needs the *monetary* Analytics scope AND is gated behind YPP (YouTube
# Partner Program) eligibility and an accepted revenue-share agreement.
#
# It is OFF by default and requested only when the operator opts in, because a
# scope is not gained by being listed: an existing token authorized under the
# narrower scopes above would fail the subset check in AnalyticsClient._auth
# and force a fresh browser consent — and until that consent happens, the
# ordinary analytics poll (views, CTR, retention) would be blocked too. Making
# the monetary scope opt-in keeps default behavior unchanged; without it, the
# revenue methods simply see the metric refused and record no revenue (never a
# fabricated $0 — see modules/revenue_tracker.py).
#
# To enable: set CHRONOS_ENABLE_REVENUE=1 and reconnect the channel
# (tools/connect_channel.py) so a token with the monetary scope is minted.
YOUTUBE_MONETARY_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
REVENUE_TRACKING_ENABLED = os.getenv("CHRONOS_ENABLE_REVENUE", "").strip().lower() in (
    "1", "true", "yes", "on",
)
if REVENUE_TRACKING_ENABLED:
    YOUTUBE_SCOPES.append(YOUTUBE_MONETARY_SCOPE)

# Separate token per channel so you can switch between two channels
_channel_suffix = f"_{YOUTUBE_CHANNEL_ID}" if YOUTUBE_CHANNEL_ID else ""
YOUTUBE_TOKEN_FILE = BASE_DIR / f"youtube_token{_channel_suffix}.json"
