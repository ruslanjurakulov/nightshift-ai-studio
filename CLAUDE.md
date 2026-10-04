# Nightshift — how to work in this repository

Nightshift is an autonomous YouTube channel operator: a Python pipeline that
researches, writes, narrates, renders and uploads a video, and a Next.js
"Command Center" (`command-center/`) that a human uses to watch it and decide.
Supabase holds the state, our own server (Docker behind Caddy) serves the app and
the site, and GitHub Actions or a queue worker runs the bot.

This file is the standing brief. It exists because every rule below was learned
from something that actually broke, and a rule that lives only in one person's
head is a rule until they are busy.

## The non-negotiables

These are the owner's, they are not defaults, and no local convention or
generated file overrides them.

**1. Never expose, print, commit, or log a secret, or any part of one.**
Not its length, not its prefix, not a redacted-looking fragment. Keys typed
into the Command Center are sealed to the repository's public key, PUT to
GitHub Actions secrets, and dropped — they never touch Supabase, an event, or
a log line. `modules/channel_credentials.py` is the only place that turns a
credential *reference* into a usable token, and it does so server-side.

**2. Do not change publishing behaviour, video privacy, or the publish gate.**
`config.YOUTUBE_PRIVACY` defaults to `private`, and so do the schedule and the
manual dispatch: this bot has never published anything publicly on its own.
Auto publish is a per-channel switch that defaults to off, and the publish gate
(`modules/publish_gate.py`) runs in front of both paths. Nothing you write may
make the bot publish more autonomously, on any path, by any default.

**3. Nothing in a browser may publish, re-render, or spend.**
A dashboard button writes a row to `review_intents` and stops; the next
pipeline run reads it and acts. That row is also the record of *who asked*,
which is why intents can be inserted and read but never edited or deleted. The
dashboard uses the Supabase ANON key only — never the service key.

**4. No silent quality fallback.**
When a channel is configured for a particular voice, model or source and that
is unavailable, the run stops. It does not quietly substitute something worse.

> A channel is set to ElevenLabs *for the voice*. With auto publish on, nobody
> hears the result before the audience does — a video that goes out in the
> wrong voice is the moment a viewer notices the channel is a machine. **No
> video is the better failure.**

`modules/audio_mixer.verify_voice()` encodes this: it raises, and there is
deliberately no return value that could be read as "use the free one instead".
Apply the same standard to visuals, captions, titles and thumbnails.

**5. Never render an unknown as a number, or a default as a measurement.**
A hidden subscriber count reads "hidden". A gate verdict with no event reads
"unknown", never "passed". A fact-check that did not run reads "did not run".
A recommendation with no data behind it says so. The difference between "we
measured this" and "we assumed this" must survive all the way into the output.

**6. Fail early, and say what the fix is.**
By the time the audio stage is reached, a run has already paid for topic
selection, research, a script and a fact-check pass. Check what a run needs
before it spends anything, and when it fails, name the remedy rather than the
symptom — `invalid_api_key` and `quota_exceeded` are the same HTTP status and
need opposite responses.

**7. A channel is an account only once YouTube says so.**
A row created from a typed name and a guessed id is a draft. It stays in the
registry, visible and editable, and it never runs. Enforced in three places
that agree — the wizard, a database constraint (migration 0005), and
`ChannelRegistry.active()` — because a rule that lives only in a form is a rule
until someone uses the API.

**8. Diagnose before you fix.**
A render fix was once pushed on a plausible theory, and it failed. Measurement
is its own deliverable and its own PR. State the evidence, then the diagnosis,
then the change — in that order, and only in that order.

## Known ceilings

Real limits, discovered the hard way. Check against these before designing.

| Ceiling | Value | Consequence |
| :-- | :-- | :-- |
| Supabase free tier, per object | **50 MB** | The previews bucket holds a 480p review copy, never the master render |
| Supabase free tier, total storage | 1 GB | Five review copies per channel, pruned |
| YouTube Data API | 10,000 units/day | `videos.insert` ~1600, `captions.insert` ~400 — count what you add |
| GitHub Actions runner | 2 cores, ~7.9 GB | One render at a time (`max-parallel: 1`); the render has died at `exit 143` here |
| Actions cache | evicted after 7 days unused | `history/` is not durable storage |
| ElevenLabs voice ids | 20 alphanumeric chars | A number is not a voice id — pick from the account's list, never type one |

## Layout

```
main.py                  the pipeline, one run for one channel
modules/                 one stage per file; ChannelContext flows as an argument
tools/                   scripts the workflows call (list_channels.py builds the matrix)
command-center/          Next.js App Router dashboard
supabase/migrations/     additive only, applied by hand
.github/workflows/       daily_video.yml (bot), tests.yml (Python), frontend.yml (dashboard)
docs/                    ARCHITECTURE, MULTI_CHANNEL, MEASUREMENT, AUTONOMY, SUPABASE …
```

Per-channel settings live on `ChannelContext` (`modules/channels.py`) and are
passed down, never read from a global. Two channels running in the same process
must not be able to see each other's voice, style, credentials or history.

The Command Center's URLs carry the channel: `/{channel}/{section}`, with
`all-channels` as the aggregate. `middleware.ts` puts the channel into request
headers, which is the only way a shared server helper can see it.

## Verifying a change

Run these yourself before pushing; CI runs the same ones.

```bash
python3 -m unittest discover -s tests          # bot
cd command-center && npx tsc --noEmit && npx next lint && npx vitest run && npx next build
```

`test_compositor_readers` and `test_compositor_subtitles` fail to import in a
container without `moviepy` installed. That is pre-existing and identical on
`main`; everything else must pass.

`next build` is not redundant with `tsc`: a server/client boundary violation, a
bad route export, or a `"use client"` module importing something server-only
all typecheck cleanly and fail the build.

Every user-visible string in the dashboard goes in all three of
`lib/i18n/{en,ru,uz}.ts` — never inline.

## Definition of Done

A feature is not done because its page renders. It is done when the whole
chain actually works: UI → server route → authorization (RLS / security-definer
SQL) → credits (quote, hold, capture, refund) → job → provider → result →
storage → project/editor → render → export/publish. And when it survives:
refresh mid-job, provider timeout or outage, insufficient credits, duplicate
submit, concurrent requests, expired session, malformed input, mobile width.

Every screen shows loading, empty, success, error, retry, disabled and
insufficient-credits states; none is a dead end. Nothing is shown as available
that is not: a model appears only after a real call through its adapter has
succeeded, and a price only when the backend computes it.

## The team

Work is done by named project subagents (`.claude/agents/`), coordinated by
the main session (**Atlas**), one feature per draft PR:

| Agent | Role |
|---|---|
| **Scout** | verifies an external provider/API from official docs before anything is built on it |
| **Forge** | builds the feature in its own worktree and branch |
| **Lens** | reviews the diff for bugs, regressions and rule violations (read-only) |
| **Probe** | writes and runs tests, including browser E2E and edge cases |
| **Breach** | attacks the change inside the isolated security lab only — never production |
| **Sentinel** | triages Breach/Lens findings, root cause, severity, the regression test |
| **Pixel** | audits UI states, responsive layout, accessibility and en/ru/uz copy |

Pipeline per PR: Scout (when a provider is involved) → Forge → Lens → Probe →
Breach → Sentinel → Forge fixes → Pixel (when there is UI) → Atlas final check
→ CI green → the owner is told it is ready. Every confirmed vulnerability
becomes a permanent failing-then-passing test in `tests/security/`. Critical
and high findings block "ready". Independent PRs run in parallel, each in its
own worktree; the shared checkout's branch is never changed.

## Writing code here

Comments explain **why**, not what. The reasoning that made a line necessary is
the part a reader cannot reconstruct, and most comments in this codebase name
the failure that produced the line. Match that; do not narrate mechanics.

Tests pin behaviour that matters, and their names say what would break. Prefer
a test that describes a real failure mode over one that restates the code.

Additive migrations only, numbered, and the app degrades honestly when one has
not been applied yet.

## Working with the owner

The owner speaks Uzbek; reply in Uzbek. Code, comments, commits and PRs are in
English.

Analyse, build, verify, *then* say it is ready — never before the push. When a
diagnosis turns out to be wrong, say so plainly and move on. Open a **draft**
PR and let the owner merge; several small reviewable PRs beat one large one.
