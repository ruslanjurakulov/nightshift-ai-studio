# Nightshift

Autonomous YouTube channel operator. A Python pipeline researches, writes,
narrates, renders and uploads a video; a Next.js Command Center is how a
human watches it and decides. Supabase holds the hosted state, Vercel serves
the dashboard, GitHub Actions runs the bot.

This repository is the **Grok working copy**. The original
[`ruslanjurakulov/nightshift-ai-studio`](https://github.com/ruslanjurakulov/nightshift-ai-studio)
is where Claude Code is active — the two trees are independent. Secrets are
not copied; they live in GitHub Actions and Vercel, not in git.

Default upload privacy is **private**. The bot has never published anything
publicly on its own.

## What it is

```
main.py                  one pipeline run, one channel
modules/                 one stage per file; ChannelContext is passed down
tools/                   scripts the workflows call
command-center/          Next.js App Router dashboard (own Vercel project)
supabase/migrations/     additive only, applied by hand
.github/workflows/       daily_video, intelligence_poll, tests, frontend
docs/                    ARCHITECTURE, MULTI_CHANNEL, MEASUREMENT, AUTONOMY…
```

**Generation** — topic → research → script → fact-check → TTS → stock media
→ Whisper captions → A/B thumbnails → MoviePy render → **publish gate** →
YouTube (captions + chapters). An optional Short is cut from the video that
actually published, never from the one that failed.

**Intelligence** — a separate job polls own-channel analytics, competitors,
trending, and comments, then queues ranked topic suggestions for the next
run.

**Command Center** — `/{channel}/{section}`. Browser buttons write a
`review_intents` row and stop; they cannot publish, re-render, or spend.

Studio, Series, Mission Control, Repurpose, and Calendar are a **draft board**
inside the Command Center (`command-center/`). A local agent crew (Scout,
Writer, Director, Critic, Clipper, Packager, Memory) writes scripts, scenes,
heuristic scores, and a private publish kit. They do not call paid APIs and
they do not upload. See [`docs/STUDIO.md`](docs/STUDIO.md).

**Live dashboard:** keep **[nightshift-studio.vercel.app](https://nightshift-studio.vercel.app)**.
The Vercel project named `command-center` (`command-center-neon-gamma.vercel.app`)
is a duplicate of the same Next.js app — delete that project in the Vercel
dashboard (Settings → General → Delete Project). Root Directory of
`nightshift-studio` must stay `command-center` (Framework: Next.js).

## Status

No production run has finished a render. GitHub Actions (2 cores, ~7.9 GB)
has killed the compositor at `exit 143` more than once: Python's own RSS
stayed under 1.4 GB while ffmpeg children ate the machine. Measurement is in
`modules/resource_monitor.py`. This copy adds an Actions profile
(`WHISPER_MODEL=tiny`, fewer stock clips) and restores `history/` from
Supabase when the 7-day Actions cache is empty. It does **not** claim the
OOM is gone — that still needs a run that lives long enough to say so.

## Non-negotiables

Standing brief: [`CLAUDE.md`](CLAUDE.md). The short version:

1. Never log, print, or commit a secret, or any part of one.
2. Do not loosen publishing, privacy, or the publish gate.
3. Nothing in a browser may publish, re-render, or spend.
4. No silent quality fallback (wrong voice → no video).
5. Unknown is not a number. Unmeasured is not zero.
6. Fail early, and name the fix.
7. A channel is an account only once YouTube says so.
8. Diagnose before you fix.

## Stack

| Layer | |
| --- | --- |
| Bot | Python 3.11, Gemini, Edge-TTS / ElevenLabs, Whisper, MoviePy 1.0.3, Pexels |
| Dashboard | Next.js 15, React 19, Tailwind 4, Vitest |
| State | SQLite under `history/` + JSON, mirrored to Supabase Postgres |
| Run | GitHub Actions (bot), Vercel (dashboard) |

## Quick start (local)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill GEMINI_API_KEY, PEXELS_API_KEY, …
cp channels.example.json channels.json   # or manage channels in the Command Center

# ffmpeg + ImageMagick on PATH
python tools/setup_check.py
python main.py --no-upload --channel default
```

Dashboard:

```bash
cd command-center
cp .env.example .env.local    # NEXT_PUBLIC_SUPABASE_URL + ANON key only
npm ci && npm run dev
```

## Verify a change

```bash
python3 -m unittest discover -s tests
cd command-center && npx tsc --noEmit && npx next lint && npx vitest run && npx next build
```

`test_compositor_readers` and `test_compositor_subtitles` need `moviepy`
installed. That is pre-existing.

Every user-visible dashboard string lives in all three of
`command-center/lib/i18n/{en,ru,uz}.ts`.

## Configuration

See `.env.example`. The ones this copy added:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WHISPER_MODEL` | `base` | Whisper size. Actions sets `tiny` so the weights are gone before render. |
| `MEDIA_VIDEO_COUNT` | `12` | Stock clips fetched. Actions sets `6` — each open file is an ffmpeg process. |
| `MEDIA_IMAGE_COUNT` | `8` | Stock stills for Ken Burns sections. |

Gemini defaults to `gemini-2.0-flash`. Do not point it at a model the API
does not serve — the first call of the run dies, after nothing useful.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — pipeline, intelligence, persistence
- [`docs/MEASUREMENT.md`](docs/MEASUREMENT.md) — cost ledger, A/B, retention, **publish gate**
- [`docs/MULTI_CHANNEL.md`](docs/MULTI_CHANNEL.md) — per-channel tokens, schedule, registry
- [`docs/AUTONOMY.md`](docs/AUTONOMY.md) — what is automatic, what is not
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Actions secrets, Vercel, Supabase
- [`docs/SUPABASE.md`](docs/SUPABASE.md) — schema, RLS, the anon vs service key
- [`docs/HISTORY.md`](docs/HISTORY.md) — why `history/` is not durable, and the hydrate
- [`docs/STUDIO.md`](docs/STUDIO.md) — Command Center draft board vs the Python pipeline

## License

Private working copy. All rights reserved.
# NightShift
