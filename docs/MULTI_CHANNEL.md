# Multi-channel architecture (Phase 5)

Nightshift runs several independent YouTube channels from one Command Center. This
document describes what a channel *is*, what is scoped to it and what stays
global, how credentials are kept out of the browser, and exactly what a
single-channel deployment does and does not have to change.

**Short version for an existing deployment: nothing.** With no channel
configured anywhere, the registry resolves one channel — `default` — built from
the same `.env` values the bot has always read, and every stage behaves exactly
as it did before. The migration is additive and backfills existing rows to that
channel. Multi-channel is opt-in.

---

## 1. What a channel is

`modules/channels.py`

| Field | Meaning |
| --- | --- |
| `channel_id` | A validated slug (`^[a-z0-9][a-z0-9-]{1,38}$`). Permanent — it keys every row. |
| `name`, `niche` | Identity. `niche` is the default topic area for its runs. |
| `status` | `ACTIVE` or `PAUSED`. Anything unrecognised reads as `PAUSED`. |
| `agent` (`AgentConfig`) | Language, target duration, TTS provider, narrator voice, content strategy, niche rules, visual style, which competitors it watches, which pre-publish checks are live (`publish_gate`), and whether it publishes Shorts (`shorts`). The last two are Phase 6 — see `docs/MEASUREMENT.md`. |
| `schedule` (`ScheduleConfig`) | `publish_hour_utc`, `enabled`. |
| `credential` (`CredentialRef`) | Provider, the *reference* to a secret, and the public YouTube channel id. **Never a token.** |

`ChannelContext` bundles these and is **frozen**. It is passed down the pipeline
as an argument, never read from a global, so a worker handling channel A cannot
pick up channel B's settings.

### Where configuration comes from

`ChannelRegistry.load()` resolves, in order:

1. **Supabase** `channels` table — what the Command Center's Channels page writes.
2. **`channels.json`** at the repo root (or `CHRONOS_CHANNELS_FILE`). See
   `channels.example.json`.
3. **The legacy default channel**, built from `config.py`.

Step 3 is the backward-compatibility guarantee. A failure at any level is logged
and falls through to the next; a malformed row is skipped rather than raised, so
one broken Finance row cannot stop History from running.

---

## 2. Global vs channel data

**Channel-scoped** — added by `supabase/migrations/0001_multi_channel.sql`:

| Table | Column |
| --- | --- |
| `videos`, `feedback_signals`, `demand_signals`, `content_queue`, `pipeline_runs` | `channel_id` (NOT NULL DEFAULT `'default'`) |
| `competitor_snapshots` | `chronos_channel_id` — **not** `channel_id`, which already exists and means the *competitor's* YouTube channel |
| `system_events` | `channel_id`, **nullable** |
| `channel_topic_performance` | new table, PK `(channel_id, topic)` |

**Global on purpose:**

- `trending_snapshots` — region-wide YouTube data, not any channel's.
- `metrics_snapshots` — reached through its video's `channel_id`; duplicating it
  would give two places to disagree.
- `system_events` with a **null** `channel_id`. Null here means *global*, not
  *unknown*: a system heartbeat or an infrastructure failure is not any one
  channel's doing, and a default would attribute it to whichever channel ran
  last. Scoped views show "mine OR global", because an operator watching Finance
  still needs to know the database is down.

### Why `topic_performance` was left alone

Its primary key is `topic` alone, so it structurally cannot hold two channels'
verdicts on the same topic string. Changing a primary key means dropping one,
which is a destructive migration. Instead:

- `channel_topic_performance` (PK `(channel_id, topic)`) holds the isolated
  per-channel score, and every channel writes there.
- `topic_performance` is still written **for the default channel only**, so it
  stays correct for a single-channel deployment and for historical data. A
  non-default channel never writes it — that write would overwrite another
  channel's verdict, which is exactly the contamination this phase prevents.
- The Command Center reads the channel table when scoped and the shared table in
  the all-channels view, and says so on the Topics page. Per-channel verdicts
  are never averaged together: that number would describe neither channel.

---

## 3. Credentials

**The rule: a refresh token never reaches the browser, a database column, a log
line or an event.**

- The secret lives where this project's secrets already live — a GitHub Actions
  secret, materialized into a token file for the life of one job. That is
  exactly what the workflow already did for the single channel.
- `channel_credentials` in Supabase stores **status only**: connected /
  not_connected / expired / error, the public YouTube channel id, expiry, when
  it was last verified, and a human-readable detail. There is no column that
  could hold a token, and there never will be.
- `credential_ref` on `channels` is a *reference*: which secret, which public
  channel. Also not a secret.

### Naming

For credential ref `finance`, the token is read from:

```
CHRONOS_YT_TOKEN_FINANCE
```

and written to `youtube_token_finance.json` on the runner. The default channel
with a blank ref keeps the existing `YOUTUBE_TOKEN_JSON` / `youtube_token.json`
path, so nothing about the production channel changes.

### Connecting a channel

```bash
python tools/connect_channel.py --channel extinct-world
python tools/connect_channel.py --list      # status of every channel
```

This opens Google's consent screen locally and writes the token to that
channel's file. It prints the file path and the secret name — **never the
token**. Copy the file's contents into the GitHub secret named above.

### How keys reach GitHub (forward, never store)

The Add Channel wizard has an **API keys** step. What is typed there is not
saved by the Command Center. It goes to a server route
(`app/api/setup/secrets`), which seals each value to the repository's Actions
public key with libsodium and `PUT`s it to
`/repos/{owner}/{repo}/actions/secrets/{NAME}`. The value exists for the length
of that function call: it is never written to Supabase, never put in an event's
metadata, never logged, never returned to the browser, and the input is cleared
the moment GitHub accepts it. GitHub itself will not read a secret back, so the
dashboard cannot show one afterwards — not even its length.

Three properties make this safe rather than merely convenient:

* **The write token is server-only.** `GITHUB_SECRETS_TOKEN` is a plain server
  environment variable, read exclusively by `lib/server/github-secrets.ts`,
  which is marked `server-only` so importing it from a client component fails
  the build instead of shipping the token. It must never be prefixed
  `NEXT_PUBLIC_`. Scope it as a fine-grained PAT on this one repository with
  *Secrets: Read and write* and nothing else.
* **An allowlist, not a filter.** Only the pipeline's own keys and
  `CHRONOS_YT_TOKEN_<REF>` may be written. `SUPABASE_SERVICE_KEY` and every
  other name is refused, so an authenticated operator cannot aim the endpoint at
  a secret the workflow trusts for something else. `tests/github-secrets.test.ts`
  pins that boundary.
* **The route is behind the session.** Both handlers call `getUser()` and answer
  401 without one.

Leave `GITHUB_SECRETS_TOKEN` unset and nothing breaks: the step says forwarding
is off and the channel is still created — the secrets are then added on GitHub
by hand, exactly as before.

`tools/connect_channel.py` is still how a refresh token is *produced*: an OAuth
code exchange needs the client secret and a browser consent it must own. What
changed is only where the resulting JSON is pasted — into the wizard, which
forwards it, instead of into GitHub's own form.

### Confirming the channel

The same step asks for a **YouTube Data API key**, and the Connect step uses it
for one call to `channels.list` before anything is created. That single read
proves both halves at once: the key works, and the channel id (or `@handle`)
names a real channel. What comes back — avatar, title, handle, subscriber,
video and view counts — is public, and it is the operator's proof that the right
channel was opened. A count YouTube hides reads *hidden*, never `0`.

The avatar and title are kept in `credential_ref` and shown on the channel card,
because they are public facts. They are **not** a credential status: whether the
channel can actually publish is still only ever reported by the bot, which is
the only party that can see the token.

---

## 4. The pipeline

One pipeline with a channel argument, not one pipeline per channel:

```bash
python main.py --channel extinct-world
python main.py                      # the default channel, exactly as before
```

`ChannelContext` flows into:

| Stage | What the channel supplies |
| --- | --- |
| `TopicManager` | its own queue, its own past videos, its own learned scores |
| `ScriptEngine` | language, target duration, content strategy, niche rules, visual style |
| `AudioMixer` | TTS provider and narrator voice (the voice is part of the segment cache key, so two channels never share a rendered segment) |
| `YouTubeUploader` | its own token and its own YouTube target |
| `IntelligencePoller` / `AnalyticsClient` | its own OAuth token, its own videos |
| `CommentFetcher` | its own OAuth token, comments on its own videos only |
| `TopicRecommender` | its own competitors and its own audience's requests |
| `ContentPlanner` | suggestions land in its own queue |
| `FeedbackEngine` / `PerformanceAnalyzer` | its own videos in, its own scores out |

### Competitors and audience demand

These are the two most channel-specific inputs there are, and both are scoped:

* **Competitors** come from the channel's own `competitor_channel_ids`
  (inside `agent_config` — a monitoring setting kept in the same JSON so a
  channel's whole configuration lives in one column). Snapshots are stored
  against the watching channel's `chronos_channel_id`. An **absent** list
  inherits the process-wide `COMPETITOR_CHANNEL_IDS`, which is what keeps a
  pre-Phase-5 deployment working; an **explicit empty** list means "watch
  nobody", and the two are deliberately different. There is no cross-channel
  fallback — a Finance channel never inherits a history channel's rivals.
* **Audience demand** is polled per channel: the fetcher authenticates as that
  channel, walks only its videos, and records the resulting demand signals
  against it. One channel's viewers must never steer another channel's topics.
* **Trending stays global.** YouTube's trending list is region-wide public data,
  identical whichever channel reads it, so it is polled once. Scoping it would
  filter nothing and only pretend to isolate something.

Each channel's comment pass and suggestion pass is wrapped individually: a
revoked comment scope on one channel costs the others nothing. If the registry
itself cannot be loaded, the poll runs the legacy single-channel pass rather
than skipping — degraded attribution, never lost coverage.

**Visual style** reaches the screen through the per-section `keywords` the script
prompt produces, which is what the stock-footage search actually runs on. It is
deliberately not appended to every Pexels query — literal style words make stock
search worse, not better.

**The publish gate is unchanged.** `main.py` uploads exactly when it uploaded
before; `human_approved` remains an audit flag that gates nothing (see
`docs/AUTONOMY.md`). Phase 5 changed *which channel* an upload targets, not
*whether* it happens.

### The isolation rule that matters most

A non-default channel **never** falls back to the process-wide
`YOUTUBE_CHANNEL_ID`. Publishing Finance's video to History's channel because a
config field was blank would be worse than failing, so a channel with no target
of its own omits the field and uploads to whatever channel its own token owns.

---

## 5. Scheduling

`.github/workflows/daily_video.yml` wakes **hourly**. A cheap `resolve` job
(two pure-Python packages, not `requirements.txt`) asks the registry which
channels are due at this UTC hour and emits a matrix; the 23 hours a day that
resolve to nothing cost seconds and produce an empty matrix, which the video job
skips.

GitHub cron cannot read a database, so this is how a per-channel
`publish_hour_utc` becomes a real schedule without hardcoding anyone's hour into
the workflow file.

- `fail-fast: false` — a credential failure or a render crash on one channel
  never cancels another channel's video.
- `max-parallel: 1` — one ffmpeg render at a time on a 2-core runner.
- A PAUSED channel is never returned, so pausing in the Command Center is what
  actually stops it being scheduled.
- `tools/list_channels.py` **cannot fail open**: an unloadable registry falls
  back to the default channel rather than emitting an empty matrix that would
  silently stop production.

With only the default channel configured, exactly one video job runs per day at
15:00 UTC — unchanged.

### When a credential is missing

Both `daily_video.yml` and `intelligence_poll.yml` write `client_secret.json`
**only when `YOUTUBE_CLIENT_SECRET_JSON` is actually set**. Writing it
unconditionally left an *empty* file behind, which passes an `exists()` check
and then fails deep inside the OAuth library with a bare `JSONDecodeError` — the
error the scheduled poll was really failing with, naming neither the file nor
the fix. `modules/channel_credentials.client_secret_problem()` now says which of
missing / empty / malformed / not-an-OAuth-file it is.

On a runner there is also no browser to consent in, so
`require_interactive_consent_possible()` fails fast with the remedy (run
`tools/connect_channel.py` locally) rather than blocking on `run_local_server()`
until the job's timeout.

### Adding a channel's token secret to the workflow

Actions secrets cannot be enumerated at runtime, so each channel's token secret
is listed explicitly in the `Run Nightshift bot` step's `env:` — one line per
channel:

```yaml
CHRONOS_YT_TOKEN_FINANCE: ${{ secrets.CHRONOS_YT_TOKEN_FINANCE }}
```

The same line is needed in **`intelligence_poll.yml`**, which reads analytics
and comments for every ACTIVE channel. Both files carry the pattern as a
comment.

The alternative, dumping `toJSON(secrets)` into a single env var, widens the leak
surface for every secret in the repository to save one line of YAML. An unset
secret is an empty string, which reports as `not_connected` — it never falls
back to another channel's token.

---

## 6. The URL is the selection

Every screen lives at `/{channel}/{section}`:

```
/all-channels/command-center     every channel, the dashboard
/chronos/videos                  one channel's videos
/extinct-world/analytics         another channel's analytics
/chronos/videos/dQw4w9WgXcQ      one video, in its channel's context
```

The channel used to be a cookie. That made a URL incomplete: it named a screen
but not which channel's screen, so pasting one to someone else opened *their*
last-viewed channel, two tabs could not show two channels, and the back button
did not undo a channel switch. State that the view depends on belongs in the
URL, so that is where it now lives.

How it holds together:

* **The middleware resolves the channel segment** and passes it inward as a
  request header (`x-nightshift-channel`), because a Server Component reached
  through a shared helper cannot see route params. `getChannelContext()` reads
  that header. One place decides; every page follows.
* **A channelless URL is redirected, never guessed at.** `/` and any old
  `/videos`-style link are sent to `/{remembered}/…`. The cookie survives only
  as that memory — which channel you last looked at — and never decides what a
  URL that already names a channel is showing.
* **The switcher navigates.** Choosing a channel swaps the first path segment
  and keeps you on the same section, so `/chronos/analytics` becomes
  `/extinct-world/analytics`.
* **An unknown channel corrects itself.** A slug that resolves to nothing (
  deleted, mistyped, or not visible to this user) falls back to every channel,
  and the layout rewrites the URL to `/all-channels/…` so the address bar never
  claims a channel the screen is not showing.
* **Section names are reserved channel ids.** `isValidChannelId` refuses
  `videos`, `analytics`, `all-channels` and the rest, because a channel with
  one of those names would make its own path ambiguous.
* **The segment is the channel's NAME, not its id.** `channel_id` is a database
  key — it is what `videos.channel_id` and every other row points at, and
  renaming it would mean rewriting all of them. But it is also the first thing
  an operator reads in the address bar, and the production channel's id is
  `default`, which says nothing. So `channelSlug()` puts the name there:
  `/chronos/pipeline`, not `/default/pipeline`. The id keeps resolving, so every
  old link still works, and the layout rewrites it to the name.

  The id is used instead whenever the name cannot stand in for it without
  ambiguity — it slugifies to nothing usable, to a reserved word, to something
  two channels share, or to another channel's id. A URL is allowed to be ugly;
  it is never allowed to be ambiguous.

---

## 7. Command Center

- **Channel switcher** in the header writes a cookie and refreshes, so Server
  Components re-query scoped to that channel. It renders nothing when there is
  one channel or none.
- **Filtering is a view control, not a security boundary.** RLS decides what a
  logged-in user may read at all; the selection decides what they are looking at
  now. Neither substitutes for the other.
- **Realtime** applies the same rule to live inserts: while scoped, another
  channel's event is dropped rather than appended, and global (null-channel)
  events stay visible.
- **Channels page** (`/channels`) shows each channel's configuration, credential
  status and per-channel health, plus a cross-channel comparison. Health is per
  channel on purpose — one channel's expired token must not make all of Nightshift
  read unhealthy — and with no evidence the tone is *idle*, never a green tick.
- **Add Channel** (`/channels/new`) creates the channel **PAUSED**, always. A
  human activates it after connecting YouTube.

### RLS

Migration 0001 adds one write capability, deliberately narrow:

- `channels` only — no data table gains a write policy, so a logged-in user
  still cannot insert a video, event, metric or score.
- **insert + update only, no delete.** A channel is retired by pausing it, which
  keeps its history intact and is reversible.
- `channels` holds no secret by construction, so this cannot expose a token.

Every new table keeps the same authenticated-read policy as the rest of the
schema. The anon key alone still reads nothing.

---

## 8. Applying the migration

```sql
-- Existing project: Supabase SQL editor -> paste -> Run
supabase/migrations/0001_multi_channel.sql
```

A fresh project needs only `supabase/schema.sql`, which now contains the same
statements inline. Both are idempotent; running either twice is safe.

There is **no drop, no rename, no type change and no delete** in the migration.
`channel_id` is added as `NOT NULL DEFAULT 'default'`, which on Postgres 11+ is a
catalog-only change that backfills every existing row to the default channel in
the same statement — that *is* the required backfill. It is reversible by
dropping the three new tables and the added columns.

Until it is applied, the Channels page says so plainly and the rest of the app
behaves exactly as it did before.

---

## 9. Deliberately not implemented

- **Autonomous publishing.** Unchanged from Phase 4: the publish gate is not
  wired, and this phase did not wire it.
- **Per-channel autonomy configuration.** The foundation exists (channels carry
  config the backend reads), but no autonomy setting is stored or honoured. That
  is the Step 2 decision described in `docs/AUTONOMY.md`.
- **Deleting a channel.** Pause it. Deletion would orphan videos, learning and
  history that the schema deliberately keeps.
