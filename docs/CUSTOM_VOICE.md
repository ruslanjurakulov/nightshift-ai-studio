# Custom voice: a user clones THEIR OWN voice, and only that user uses it

Status: **database, pure code and a worker behind a switch** (migrations `0117_voice_profiles.sql` and `0121_voice_job_gates.sql`,
`modules/voice_profiles.py`, `modules/voice_worker.py`, `tools/voice_worker.py`). Nothing live runs: the ElevenLabs account is on the **free plan**, which does not
allow instant voice cloning. The worker is **off** unless the repository variable `NIGHTSHIFT_VOICE_CLONING` is `on` (the owner sets
it; it is empty by default and reaches the worker env through `deploy_web.yml`), and **nothing starts it**: no service, cron entry or
workflow runs `tools/voice_worker.py` (a test fails if one does). **The UI exists but is dark** (slice V3, "The UI" below): a page behind
the server-side flag `CUSTOM_VOICE_ENABLED` (off unless it is exactly `1`), which asks the database nothing while it is off. Only one
application file names the owner's functions (`command-center/lib/custom-voice-api.ts`; a test fails if another does), and none names the
internal ones.
The run-time checks of the hard gate (`modules/voice_gate.py`, `lib/server/run-voice.ts`) call only the read-only function
`channel_voice_config_problem` and change nothing for a run that uses no cloned voice. Migration 0121 (the gates G2 and G3 and the oracle
below) is **live on apply** and touches no row; it grants nothing to anyone who had nothing, and does not grant `request_voice_clone`.

**It is also dormant at the API.** `request_voice_clone` is created and granted to **nobody** (not `authenticated`, not `service_role`):
starting a clone is the one entry into the feature, so no signed-in user can create a profile, a queue row or (the bucket's insert rule
needs a waiting profile) a stored object. The grant ships in the migration that ships the worker and the UI, and is a separate
decision (the Actions pre-flight it waited on is built: see "Hard gate" below).

## The decisions this implements (the owner's)

- Every **user** may clone **their own** voice, and **only that user** may use it.
- Ownership is **traceable**: a unique, non-repeating id is made for each user, so every voice can be traced to who it belongs to.
- v1 takes a **live recording only** (no file upload), with a **random phrase read aloud** for verification.
- At cloning time the user chooses whether the raw sample is **deleted right after the clone** (the default) or **kept until the
  user deletes it**.
- Re-voicing a single line of a finished video (`regenerate_line`) is approved but is a **later slice**. It is not here.

## The model

| Table | What it holds | Who reads | Who writes |
| :-- | :-- | :-- | :-- |
| `user_voice_refs` | one `owner_ref` per user (immutable) | the user's own row | the 0117 functions |
| `voice_profiles` | one row per clone request: owner, organization, name, status, provider voice id (UNIQUE), sample hash, `keep_sample`, `sample_state` | the owner's own rows | the 0117 functions |
| `voice_consents` | the consent trail, **append-only** | the owner's own rows | the 0117 functions |
| `voice_deletion_records` | what survives a deletion: no user id | nobody through the API | the 0117 functions |
| `voice_clone_jobs` | the worker's queue (the phrase is in it) | nobody through the API | the 0117 functions |
| `voice_channel_attachments` | the owner's explicit act of putting a voice on a channel | the owner's own rows | the 0117 functions |

No API role (anon, authenticated, **service role**) can insert, update or delete any of them. Every write is a `SECURITY DEFINER`
function with a pinned `search_path`; `EXECUTE` is revoked from everyone and granted narrowly (a test reads the file and the lab reads
the catalog).

Status: `pending_verification` -> `testing` (the worker cloned it and the read-aloud check passed) -> `approved` (the owner heard it and
approved) ; `rejected` and `deleted` are terminal. A usable status always has a provider voice behind it (a CHECK).
`attach_voice_to_channel` keeps a stricter `ai_disclosure_voice` that is already set (`real_person`, or any value the reader would read as
`real_person`): it only ever sets `own_clone` where the key is absent, `generic` or already `own_clone`.

### The functions

| Function | Caller | What it does |
| :-- | :-- | :-- |
| `my_voice_ref()` | the user | their own `owner_ref` (made now if absent) |
| `request_voice_clone(name, declarations, consent_version, keep_sample, idem, org?)` | **nobody yet** (see "Hard gate"); a person once granted | writes the profile, the consent row, one queue row, an audit row. **Calls no provider.** Returns the phrase to read, the upload prefix and when the request lapses (2 hours). Idempotent on `idem`; **5 requests per person per rolling day** and **3 live voices per person** |
| `approve_voice(profile)` | the owner | `testing` -> `approved`, only after the worker's verification passed and the owner's own Studio `tts` clip made with this voice completed |
| `attach_voice_to_channel(profile, channel, slot?)` | the owner, who must be a real administrator of the channel's organization | the attachment, the channel's voice key (`narrator` = `elevenlabs_voice_id`, `secondary` = `elevenlabs_secondary_voice_id`), and `ai_disclosure_voice = own_clone`; one audit row |
| `detach_voice_from_channel(profile, channel)` | the owner | revokes the attachment; the id stays in the config and runs on it are refused (rule 4) |
| `delete_voice(profile)` | the owner | marks it deleted (unusable at once), revokes attachments, queues the provider deletion and the sample purge, keeps a minimal record |
| `delete_voice_sample(profile)` | the owner | for a kept sample: queues its purge |
| `claim_voice_job(worker)` / `finish_voice_clone(...)` / `finish_voice_task(...)` | the service role | the worker's side (below). Since 0121 `claim_voice_job` also **ends** a clone job whose profile is deleted or rejected and queues what that profile still needs (G2, below) |
| `voice_requeue_overdue(older_than)` / `voice_overdue_report()` | the service role (0121) | put purge and provider-deletion jobs that failed for good back in the queue, bounded; report what is late as counts and ages (G3, below). `tools/voice_worker.py --sweep` is their one caller |
| `purge_voice_records(profile)` | the service role | removes a **deleted** voice's rows once its provider copy and sample are gone; keeps `voice_deletion_records` |
| `voice_usable_by(user, voice, org, channel)` | nobody (internal) | **the rule** |
| `channel_voice_config_problem(channel, org, old, new)` | the service role; a signed-in user (0117, narrowed by 0121) | the channel-path question, **a wrapper since 0121** (the oracle, below). Its core, `channel_voice_config_problem_core`, is 0117's body unchanged and callable by nobody |

## The unique `owner_ref`, and how a voice in the provider account traces to a user

`user_voice_refs.owner_ref` is a **random** 32-hex value (a UUIDv4 without dashes: **122** random bits, not 128; the version and variant
nibbles are fixed), one per user, unique by constraint,
immutable (a trigger refuses any update, even from the database owner), created the first time a user touches a voice function and
**backfilled for every existing user** by the migration (idempotent). Why random and not an HMAC of the user id: there is no secret to
store, rotate or leak; it is unique by construction; it is not guessable; and it never exposes the auth user id. The repo has no trigger on
`auth.users` (signup is done through RPCs), so the reference is created lazily and by the backfill instead.

The later worker names every provider voice `ns-<owner_ref>-<first 8 characters of the profile id>` and sets the labels
`nightshift_owner_ref` and `nightshift_profile` (`provider_voice_name()` in `modules/voice_profiles.py`). The user's own words (the
profile name) are **never** sent to the provider. To trace a voice found in the ElevenLabs account:

```sql
-- the name is ns-<owner_ref>-<profile8>
select u.email, p.id, p.name, p.status, p.created_at
  from public.user_voice_refs r
  join auth.users u on u.id = r.user_id
  join public.voice_profiles p on p.user_id = r.user_id and p.owner_ref = r.owner_ref
 where r.owner_ref = '<the 32 hex characters from the voice name>';
```

After a user's account and records are purged the reference resolves to nobody: `voice_deletion_records` keeps the pseudonym only.

## Who may use a voice (the ownership rule, enforced in the database)

Before this migration any id that matched a shape regex passed everywhere, and all customers share the operator's ElevenLabs account.
Now, **if a provider voice id is in `voice_profiles`**, it may be used only:

- **(a)** by its **owner**, in their own jobs, when the profile is `approved` (a Studio `tts` **test** is also allowed while it is
  `testing`, owner only: that is how the test that precedes approval can happen at all); or
- **(b)** in **channel runs** on a channel the owner **attached** it to (an active attachment, in the channel's current organization,
  in the slot asked for, the owner still an administrator of that organization, the profile `approved`).

A deleted, rejected or pending profile is never usable, by anyone. A voice that is in **no** profile (the operator's own premade and
library voices) works exactly as before. A re-cased or whitespace-padded copy of an id is the same id (the reader strips the secondary
voice id, so the check does too). A channel's voice setting that is not a JSON string (a number such as `12345678901234567890`, a list, an
object, a boolean) is refused when a write sets it, because the reader would turn it into text and use it; `null` still means "not set".

Where voice ids enter the system, in the database, for **every writer** (the service key, the definer functions and the SQL editor too):

| # | Entry point | Mechanism | What it covers |
| :-- | :-- | :-- | :-- |
| 1 | `creative_jobs` | `BEFORE INSERT` trigger `creative_jobs_voice_guard` | Studio `tts` (owner test or use) and `voice_change` (approved voice, owner only), whatever function inserts the row (`create_creative_job`, the API, workflows) |
| 2 | `render_jobs` | `BEFORE INSERT` trigger `render_jobs_voice_guard` | a run's own `params.voice_id` (owner only) and, for a run that narrates (not a `repair`), the channel's configured narrator and secondary voices as they are **now** |
| 3 | `channels.agent_config` | `channels_config_guard()` replaced on 0114's latest body | `elevenlabs_voice_id` and `elevenlabs_secondary_voice_id` may be **set** to a custom voice only if the owner attached it; covers `set_channel_dna`, `create_channel` and direct updates |

Why these are triggers and not edits of `creative_params_problem` / `render_job_params_valid`: both are immutable pure functions of the
parameters (one sits in a CHECK constraint), so they cannot see who is asking or which organization. They are unchanged and still do the
shape check. A value that is unchanged by a write passes entry point 3 (an unrelated edit of a channel that already has the voice is not
blocked); a *run* on it is refused by entry point 2 once the voice is no longer attached.

Consequences worth knowing: a workflow saved with a custom voice fails at the step that creates the job when someone other than the
owner runs it; `channels_elevenlabs_voice_unique` (0005) still allows one channel per ElevenLabs narrator voice, so attaching a second
channel as narrator answers `voice_in_use`; the label `ai_disclosure_voice = own_clone` is written **only** by `attach_voice_to_channel`
for anyone who is not a platform administrator (0114's direct lock is unchanged). `own_clone` does not change the label itself
(`docs/AI_DISCLOSURE.md`).

## Consent, verification and retention

- `request_voice_clone` requires five declarations, all true: `own_voice`, `sole_speaker`, `over_18`, `voice_data_to_provider`,
  `no_impersonation`; and a consent text version (`v0` is the UI's placeholder, `v1` onward is counsel's text, once it exists). The wording of the consent text is **not written** (counsel; below).
  Coarse client info is the user agent only, never an IP address.
- **The phrase** is six distinct random words from a fixed 128-word list, **made by the database** (the caller never supplies it, so a
  recording cannot be prepared in advance), stored in plain text only in the closed queue row and as a SHA-256 in the consent row.
  `check_transcript()` compares a Whisper-style transcript with it (case, punctuation and up to 8 extra words ignored; one near-miss word
  tolerated; a different phrase, a swapped order or a missing word fails; the whole list read aloud fails). Whisper is not called here.
  **What this proves and what it does not:** it proves a live person read that phrase in that recording. It does **not** prove the voice
  is theirs: someone can play a recording of a target and read the phrase over it. It reduces casual abuse; live-recording-only narrows
  the gap slightly. Say so in the product and the terms.
- **Name screen** (`voice_name_problem` in SQL, `voice_guard` in Python, one shared corpus): refuses names that read as a real or public
  person ("sounds like ...", "voice of ...", "president", ...). **Keyword-weak by design**: a nickname or a misspelling gets through. It
  stops a casual attempt and tells the user why; nothing relies on it for safety.
- **The consent trail is append-only** for every role, the database owner included (the `credit_transactions` pattern). The worker's
  verification result is a **new** `kind = 'verification'` row. Only `purge_voice_records` may delete, and it leaves
  `voice_deletion_records` (owner_ref, consent version and time, hashes; **no user id, no name, no declarations**).
- **The raw sample.** Uploaded to the private bucket `voice-samples` at `<user_id>/<profile_id>/sample.<ext>`. If the user chose
  *delete after cloning* (default) the profile goes to `sample_state = purge_pending` and a `purge_sample` job is queued; if they chose
  *keep*, it stays until `delete_voice_sample` or `delete_voice`. **The database never deletes the Storage object itself**: Supabase
  Storage blocks direct deletes on `storage.objects` (the blob would stay) and the lab does not emulate that block, so the worker deletes
  through the Storage API with the service role and confirms with `finish_voice_task`, which sets `purged`. Until then the sample is
  *requested to be deleted*, not deleted: the verification query below lists any that are overdue. **Unverified on the live project.**
- **The bucket**: private, 50 MB, audio MIME types only. The owner may `INSERT` only into their own prefix, only for a profile of theirs
  that is waiting for its sample, only with the name `sample.<ext>`. There is **no** SELECT, UPDATE or DELETE for anon or authenticated.
  Four **restrictive** policies close those for the bucket even if a permissive policy made by hand in the dashboard exists (the lesson of
  0098: storage policies add up). Upload with `contentType: 'audio/webm'` exactly: whether Storage accepts `audio/webm;codecs=opus`
  against the allow-list is unverified.

## Hard gate: the database rule does not cover the GitHub Actions backend

The ownership rule is enforced where a voice id enters **the database**. A run that goes through the GitHub Actions backend does not
pass through `render_jobs` or `creative_jobs`:

- the Run-now `voice_id` input (`command-center/app/api/agent/run/route.ts` -> the `daily_video.yml` dispatch -> `ELEVENLABS_RUN_VOICE_ID`)
  reaches the pipeline without any row being inserted;
- scheduled runs read `channels.agent_config` at run time. Entry point 3 stops a custom voice being **set** there unattached, but a voice
  attached earlier and deleted or detached since is still in the config, and the config is read by Actions without any check.

### What is closed (this PR, no migration)

Both checks ask the one voice function the migration already grants to the roles that need it, `channel_voice_config_problem(channel,
org, old, new)` (granted to `authenticated` and `service_role`; it takes **no person**, so it answers for the **channel path** only; since 0121 a signed-in
caller is told the truth only about voices they may know exist, see "The oracle on `channel_voice_config_problem`" below):
the voice must be `approved`; an **active attachment** to this channel must exist, **in the channel's current organization** and in the
slot asked for (`narrator` for `elevenlabs_voice_id`, `secondary` for `elevenlabs_secondary_voice_id`); and the attaching owner must
**still be an administrator** of that organization. A voice id in no profile answers "fine" and nothing about the run changes; the
database compares ids lowercased and stripped, so a case or padding variant is the same voice. `voice_usable_by` itself is not
executable by any API role, and the service role cannot read the voice tables (0117 revokes `SELECT` from it), so this function is the
only door; the answer is one key or NULL, never a reason.

1. **Run-now route** (`lib/server/run-voice.ts`, called from `app/api/agent/run/route.ts` for both backends). A `voice_id` shaped like
   a provider voice id (20 letters and digits: all the dispatch and the queue row ever forward) is checked as the signed-in user,
   **before** the credit hold, the dispatch or the insert. Refused: `403 voice_not_allowed` (logged server-side as the code alone, never the
   voice id). **Fails closed here**, unlike the runner (a Run-now already needs Supabase for its sign-in and its hold, and a person is
   waiting to be told): a check that errors, throws,
   answers in a shape nobody expects, or has no database client is `503 voice_check_unavailable`. The only error that lets the id through
   is "the function does not exist" (PostgREST `PGRST202` / Postgres `42883`: 0117 is not applied, so no profile can exist). Both
   messages are translated (en/ru/uz), say nothing was taken, and are the **same sentence for every reason**: they do not tell a stranger
   whether the id is a clone, whose, or in what state. No `voice_id`, or one that is not shaped like a voice id: the database is not asked
   and the answer is what it always was (pinned by a test).
2. **Actions pre-flight** (`modules/voice_gate.py`, called in `main.run` as the first of the voice stages, before `verify_voice` and
   before the first paid call). For an ElevenLabs run it asks about the voices the run will speak with: the narrator (the run's own
   `ELEVENLABS_RUN_VOICE_ID`, else the channel's) in the narrator slot, and the quote voice in the secondary slot, in one call, with the
   service key (`allow_redirects=False`: a redirect would carry the key elsewhere, and any 3xx is "could not answer"). A voice equal to
   the deployment's configured default (`config.ELEVENLABS_VOICE_ID` / `ELEVENLABS_SECONDARY_VOICE_ID`) is **not asked about**: a clone's
   id comes from a clone request, so it can never be one of them, and the built-in narrator is on every run.
   - **The database ANSWERED "not allowed"** -> `VoiceGateRefused` -> exit code **82**, in every mode: one log line naming the slot and
     the fix, a red step with its own annotation in `daily_video.yml`, and `tools/queue_worker.py` fails the job; as with 78-81, the
     non-zero exit makes the settle step **release the credit hold**. It covers, by the database rule above: a detached attachment, a
     demoted or removed owner, a channel that moved organization, a deleted, pending, rejected or merely `testing` profile, case and
     padding variants (including a number where a string should be), and the secondary slot (a voice attached as narrator may not speak
     the quoted lines). It never becomes a silent stock voice (rule 4).
   - **The database COULD NOT ANSWER** (unreachable, timeout, 429, 5xx, 401/403, a redirect, any other 4xx, an unreadable or odd body, or no
     `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`): **by default the run goes on**, with a warning in the log and a `::warning::` annotation on
     Actions, after two tries and at most 5 seconds in total. That total is a wall-clock deadline enforced around the request itself
     (`requests` timeouts are per socket read, so a server that drips a byte a second would outlast them); the strict schedule's is 24
     seconds. This is the repository's rule for a Supabase outage (the channel registry
     falls back, the slot guard fails open), and today the gate protects nothing the outage could cost, because no custom voice can
     exist. With **`NIGHTSHIFT_VOICE_GATE_STRICT`** on (repo variable, reaches the daily run and the worker; empty = off), "could not
     answer" stops the run instead: exit **83**, its own red annotation ("could not be verified", not "not permitted"), three tries, the
     queue job fails with the hold released. `render_error` classes both endings as `voice`, not `unknown`.
   - Only the **exact keys asked about** (`elevenlabs_voice_id`, `elevenlabs_secondary_voice_id`) count as "not allowed"; HTTP 200 with any
     other string or shape is "could not answer". A **bug inside the gate** is contained the same way: a warning and the run goes on, or exit
     83 under strict; the deliberate 82/83 exits and `SystemExit` are never swallowed.
   - **"The function does not exist"** (only PostgREST `PGRST202` or Postgres `42883`; the same two the route accepts) means 0117 is not
     applied, so no profile can exist: the run goes on, with a warning and an annotation. Any other 404 is "could not answer".
   - Not asked, by design: an Edge channel (it speaks no ElevenLabs voice), a value that is not shaped like a voice id, and the
     configured defaults above. That skip is sound only while a clone's id never equals the repo variable `ELEVENLABS_VOICE_ID` or
     `ELEVENLABS_SECONDARY_VOICE_ID`: **the operator must never set a clone's id there** (those are the operator's own premade voices).
   - A scheduled run refused here (82, or 83 under strict) **consumes one slot-guard attempt** for its slot (`NIGHTSHIFT_SLOT_MAX_ATTEMPTS`,
     default 2, and `NIGHTSHIFT_SLOT_MIN_ATTEMPT_GAP_MINUTES`, default 60: `docs/VIDEO_GO_LIVE.md`) and **does not pause the channel**; the
     catch-up retry then tries again within those limits and is refused again until the voice is fixed.
3. **Repair and scene regeneration** never reach the gate: they reuse the run's saved audio and buy no voice, which is why 0117 lets a
   `repair` job through (`render_jobs_voice_guard`); `scene_repair` and `scene_regenerate` have their own entry in `main.py` and do not
   call `run()`. A resumed run does narrate, and is gated.

Behaviour for a run that uses no profile-backed voice is unchanged: the same stages in the same order, the same exit codes. The cost is
one cheap RPC per ElevenLabs run that speaks a voice other than the configured defaults (Python), and per Run-now that names a voice (route).

### Hard conditions for the migration that grants `request_voice_clone`

The grant is a separate decision, and the migration that makes it must not ship without all of these:

1. **`NIGHTSHIFT_VOICE_GATE_STRICT` turned on** (repo variable, with the worker's) in the same release. Until then an outage of Supabase lets
   a run continue unchecked, which is acceptable only because no custom voice can exist; after the grant it would be a way to speak with
   someone's voice unchecked.
2. **`channel_voice_config_problem` restricted** to members of the channel's organization and the service role. **Narrowed by migration
   0121, NOT closed** (below, "The oracle on `channel_voice_config_problem`"): the function itself no longer leaks, but the entry guards
   still do for any signed-in user who made a workspace of their own, and whether that is acceptable is a decision for the migration that
   grants `request_voice_clone`. The function was executable
   by every signed-in user (0117 grants it to `authenticated` so the channels guard can ask it), took any channel and any voice id, and
   answered a key rather than NULL for a clone: an **oracle** on other people's voices.
3. The worker, the UI and the consent text (below).

### The oracle on `channel_voice_config_problem` (narrowed by 0121, not closed)

0117 granted the function to `authenticated` because the channels guard (a trigger that runs as the caller) asks it, and because the
Run-now route calls it as the signed-in user. Called through the API with any channel and any 20-character id, it answered a key for an
id that is somebody's clone and NULL for an id that is no voice at all: a way to confirm that a known id is a clone.

0121 keeps 0117's body as `channel_voice_config_problem_core` (character for character, callable by nobody) and makes the function of
the old name a wrapper. The exact answer goes to:

- the **service role**, and a session with **no API claims** (the Actions pre-flight `modules/voice_gate.py`, the SQL editor);
- the **channels guard**, which asks from inside its own trigger (`pg_trigger_depth() > 0`). That is a write to the channels table by a
  caller who already passed the table's policy for that row, or a definer function (`create_channel`, `set_channel_dna`,
  `attach_voice_to_channel`) that checked the caller itself. The guard must keep refusing a custom voice that is not attached, whoever
  writes; masking it would let anyone with a channel store another person's voice id in it. Nothing a caller sends through the API can
  raise the trigger depth.

Any **other signed-in caller** is told the truth only when both hold: they are a **member of the channel's organization** (looked up from
the channel row, never from the `p_org` they pass), **and** the voice is **their own** or was **requested in that same organization**.
Otherwise the answer is NULL, exactly as for an id that is no voice. The second condition matters: membership alone would leave the
function an oracle, because anyone can have a workspace and a channel of their own and ask about a stranger's id from there.

**The two voice keys are asked one at a time.** The core returns the *first* key that fails. Asked about both keys at once, a masked first
key used to swallow the refusal of a non-string second key (and a first key that is no voice let it through), which told a hidden clone from
a non-voice. So for these callers the wrapper calls the core once per key with only that key in `p_old` and `p_new`, and masks per key: the
answer for one key never depends on, or reveals, the other. A value that is not a JSON string is still refused for everybody (no profile can
be behind it), and that refusal is independent of every other key. A member, the service role and the guard get exactly what the core gives
for the whole request (tested with every pairing of a hidden clone, a non-voice and a non-string in both positions).

**No timing claim is made.** A masked answer reads the profile and the membership, but it is not the same work as the answer for an id that
is no voice (a difference of a few tens of microseconds was measured in review). The statement is about the answer, not the clock.

What this changes for the two callers: the **Run-now route** (a signed-in member) keeps its early, friendly refusal for the voices of the
caller's own organization and the caller's own voices; for any other id it now reads "fine", and the run is stopped where it always had to
be: the Actions runner asks with the service key and gets the truth (exit 82, nothing spent), and on the queue backend the database
refuses the `render_jobs` insert. `modules/voice_gate.py` is unchanged. `lib/server/run-voice.ts` only gained a comment.

**Residual: narrowed, not closed.** The three entry guards of 0117 refuse a clone that the writer may not use; that refusal is what makes
them guards. Anyone who can write to one of those tables can therefore still *test a known id* by trying to use it and reading
`voice_not_allowed` (SQLSTATE 42501) instead of success. That is **every signed-in user who has a workspace of their own**: workspace
creation (`create_organization`) is open, and an editor can update `channels.agent_config` of a channel in it, so a user of organization B
gets `voice_not_allowed` for organization A's clone and success for an id that is no voice (reproduced in review). A voice id is a
20-character alphanumeric string (62^20 values), is listed nowhere, and is never sent to a browser except the owner's; so what is left is
confirming an id someone already holds, at the cost of a write attempt per question. Closing it would need every guard to refuse the same
way for ids that are no voice, which cannot be done without refusing every unknown id. **It remains a decision for the migration that
grants `request_voice_clone`** (accept it, rate-limit those writes, or change the guards' answer); 0121 does not make it.

### What remains

- **The grant of `request_voice_clone` is a separate decision.** It is still granted to nobody, and neither the Actions pre-flight nor
  0121 changes that. It also needs the worker, the UI and the consent text (below). The checks above are what the grant was waiting on,
  not a reason to make it. `NIGHTSHIFT_VOICE_GATE_STRICT` is untouched.
- **The Run-now voice is held to the same rule as every run: the narrator attachment.** The function has no person, so an owner who
  approved a voice but has not attached it to the channel cannot use it for a Run-now on that channel (the database lets the owner use
  it in a `render_jobs` row on the queue backend; the Actions backend cannot tell who asked, because the workflow dispatch carries no
  requester). Attach it first. Making Run-now accept "the owner's own approved voice" needs a person-aware function (a migration)
  and a requester on the dispatch; not done here, and refusing is the safe side.
- **The route and the runner each ask once.** A voice detached between the click and the runner is caught by the runner (that is what
  the second check is for); a voice attached **and then detached while the runner is already narrating** is not interrupted.
- **`voice_previews.yml`** (the operator-only preview clip of a voice id, `app/api/voices/preview/route.ts`) is not gated: it can
  synthesize a short fixed sample with any voice id the operator pastes, a clone included, and GET lets any signed-in user fetch a
  stored clip by id. Closing it is its own change (it needs the same function with no channel, or a preview deny-list); a clone has no
  UI and no way to exist yet.
- **Not verified live.** The tests fake the database at the PostgREST call and model the SQL's channel path; the SQL itself is tested in
  `tests/security/`. Nothing here has run against the live project, and no profile exists there.

## The worker (slice V2, hardened)

`tools/voice_worker.py [--once]` carries out `voice_clone_jobs` with the service key, through `claim_voice_job`, `finish_voice_clone` and
`finish_voice_task` only (it never calls `purge_voice_records`: that stays the operator's, after a retention period). It needs
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` **and `ELEVENLABS_API_KEY`: without any of the three it refuses to start** (exit 2). There is no
keyless mode, deliberately: `claim_voice_job(p_worker)` hands out the oldest job of *any* kind and cannot be asked for one, so a worker that
could not reach the provider would claim every clone and every provider deletion, park them, use up their three claims, and about an hour
later reject every outstanding clone and permanently fail every `delete_provider` job. (`VoiceWorker` itself refuses to be built without a
provider.) A purge-only mode would need a kind filter in `claim_voice_job`, which is a migration; until then a recording stranded while
the key is away is purged by hand, below. It sweeps `nsvoice-*` work directories left by a killed worker (SIGKILL, the OOM killer) when
it starts.

| Job | What it does | Ends as |
| :-- | :-- | :-- |
| `clone` | 1. asks the account's plan **before anything else** (`can_use_instant_voice_cloning`); 2. fetches the object with the service key (no redirect, stops at 50 MB); 3. sniffs the bytes (never the declared type) and decodes **once**; 4. Whisper (the pipeline's local one) must hear the phrase; 5. looks for a voice **labelled for this profile** and adopts it, otherwise creates one from the decoded wav; 6. records the id and hash with `finish_voice_clone`; 7. only then deletes the whole `<user_id>/<profile_id>/` prefix (unless the owner chose to keep the sample) | `testing`, or `rejected` with a closed reason |
| `delete_provider` | `DELETE /v1/voices/{id}`; 404 is done; needs no plan | done, or parked (below), then failed and logged `voice OVERDUE` |
| `purge_sample` | deletes the prefix, lists it again to confirm it is empty. For a **rejected** profile that never got a voice recorded it also removes voices labelled for that profile from the provider (an orphan) | `sample_state = purged`, or parked, then failed and logged `voice OVERDUE` |

**The decode.** The container's own statement of its length is never believed: an Ogg Opus file with 900 s of audio and a patched last-page
granule reports 5 s (reproduced with ffmpeg 7.0.2 in review). The worker therefore decodes exactly once, to a mono 16 kHz 16-bit wav, **cut at
301 s of audio** (`-t`), with the output size limited (`-fs`), and measures the length from the frames of *that* file: more than 300 s is
`sample_too_long`. Exactly one audio stream and no video (`not_audio` otherwise). ffmpeg and ffprobe run with an **empty environment** (no
service key, no ElevenLabs key), only the `file` protocol (`-protocol_whitelist file`), the demuxer the sniffed bytes named (`-f`, never
auto-detection), a timeout, and rlimits on CPU (120 s), address space (3 GiB), file size and core dumps. Whisper is given the samples of
that wav (read with the stdlib, so its own ffmpeg call never starts) under a 180 s deadline, and **the provider receives that wav too**
(`audio/wav`, 16 kHz mono), never the upload. Consequence to know: a 16 kHz recording is a lower-fidelity sample for the provider than the
original; if clone quality needs more, a second capped decode at a higher rate is a small change.

**Who is at fault decides what happens.** The person's own faults end the request at once and purge the recording: `not_audio`,
`unreadable_audio`, `sample_too_large`, `sample_too_long`, `sample_missing`, `verification_failed` (the wrong phrase), `provider_rejected`
(a 422), `provider_error` (an HTTP answer that will not change), `provider_conflict`, `bad_job`, and **`provider_not_enabled` when the
subscription explicitly says `can_use_instant_voice_cloning: false`** (the documented free plan: nothing fetched, created or spent). The
operator's or the provider's faults are **parked, not answered**, so a recording is not burned for them: `provider_auth` (a bad key),
`provider_not_configured`, `provider_plan_unknown` (a subscription that says nothing about cloning, which is an unverified shape, not a
verdict), `provider_not_enabled` *after* a good probe, `provider_unavailable` (network, timeout, 5xx, 429), `provider_redirect`,
`provider_error` with no usable id, `storage_error`, `transcribe_failed`, `transcribe_timeout`, `audio_tool_error`, `worker_error`.

**Parking, and the real horizon.** The database allows three claims of a job (`max_attempts`) and nothing the service key can call raises
that or re-queues a failed job. A parked job is simply not answered: it stays `running` and `claim_voice_job` returns it to the queue after
its 30-minute lease. The wait between claims is therefore 30 minutes, about **90 minutes in all**; only the third claim answers, with the
specific word (and a purge or delete that ends so is logged `voice OVERDUE` with the job kind and a closed word). That is the longest
horizon the existing functions give. A worker that dies is the same thing (the lease; after three losses `worker_lost` with its purge
queued). Every path that ends a profile queues its purge, and the worker deletes the prefix twice (right after the answer is recorded,
then when that job runs). A retry never makes a second voice: it looks for the voice labelled for the profile first.

**The longer horizon (migration 0121).** Two service-role functions and one command:

- `voice_requeue_overdue(p_older_than interval default '3 hours')` puts `purge_sample` and `delete_provider` jobs that **failed for good** back
  in the queue with `attempts = 0`. **Bounded**: at most 20 a call, oldest first, only jobs that failed more than `p_older_than` ago (between
  1 hour and 30 days, in days, hours, minutes and seconds only: an interval with months or years is refused, else `22023`); one job per (profile, kind), the newest failure, and none where a live job of that kind exists (a live job that appears between the list and the update, because the owner deletes a voice or its sample at that moment, is skipped and does not abort the call).
  **Never a clone job.** **Never where the work must not run**: a purge only while the profile's `sample_state` is `purge_pending` and the
  profile is not waiting for its verification; a provider deletion only for a profile that is `deleted`, has a recorded voice id and has no
  succeeded deletion (so it can never delete a live voice). It returns counts only: `{requeued, purge_sample, delete_provider}`. It writes no
  audit row and no deletion record (the job rows are the trail).
- `voice_overdue_report()` returns, for six fixed lines, a `count` and `oldest_seconds` (NULL when the count is 0: an age of 0 would read as
  "just now") and a `total`, and nothing else: no id, name, user or error text. The lines: `failed_purge_sample`, `failed_delete_provider`,
  `late_queued` (a purge or deletion queued or running for more than 3 hours), `stranded_clone` (a queued clone of a deleted or rejected
  profile: `claim_voice_job` ends it, so it reads 0 once a worker runs), `purge_without_job` (a sample waiting to be purged with no purge
  job queued, running or failed), `provider_without_job` (a deleted voice with a recorded id and no deletion queued, running, failed or done).
- `python tools/voice_worker.py --sweep` calls both and logs **only** the integers and those six words: `voice sweep: requeued=N
  purge_sample=N delete_provider=N`, and for every line with a count above 0, at ERROR, `voice OVERDUE: <line> count=<n> oldest_seconds=<n>`.
  Exit 0: nothing is overdue. Exit 1: something is. Exit 2: the database could not answer (a function missing, an odd answer, an
  unreachable host): nothing is known, which is not 0. It starts under the same conditions as the loop (the switch on; `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY` and `ELEVENLABS_API_KEY` all set, otherwise exit 2 before anything is contacted), claims no job and calls no provider.
  **Nothing starts it**: no service, cron entry or workflow (a test fails if one does); running it on a schedule and telling a person is the
  owner's decision and the part of G3 that stays open.

**The recurring check (until `--sweep` is scheduled, run it or this at least daily, and whenever the worker logs `voice OVERDUE`).** In the SQL editor:

```sql
-- 1. samples still waiting to be removed (expected: none older than 3 hours once the worker runs)
select id, status, sample_state, created_at from public.voice_profiles
 where sample_state = 'purge_pending' and (deleted_at is null or deleted_at < now() - interval '3 hours');
-- 2. a purge or a provider deletion that failed for good (expected: none)
select id, profile_id, kind, error_code, finished_at from public.voice_clone_jobs
 where kind in ('purge_sample', 'delete_provider') and status = 'failed';
-- 3. recordings in the bucket whose profile is gone or already purged (expected: none)
select o.name, o.created_at from storage.objects o
  left join public.voice_profiles p on p.id::text = split_part(o.name, '/', 2)
 where o.bucket_id = 'voice-samples' and (p.id is null or p.sample_state = 'purged');
```

To retry what query 2 lists, call `voice_requeue_overdue('1 hour')` (service role; 20 at a time), or by hand as the database owner:
`update public.voice_clone_jobs set status = 'queued', attempts = 0, worker_id = null, finished_at = null where id = '<job>';` (the worker
picks it up). Query 3 is a hand deletion of the object or a profile that was purged
with an object left behind: delete the object through the Storage API or the dashboard.

**Adopting and deleting a provider voice.** A voice is the worker's to adopt or delete only if it carries the profile's name **and** the
labels `nightshift_profile` = the profile's **full** id and `nightshift_owner_ref` = the owner's reference (the eight hex characters in
the name are not enough). The listing's labels are read, or the voice by id when the listing has none. A voice with the name and any other
label is a `provider_conflict`: the clone ends, and nothing is adopted, duplicated or deleted. The service key cannot read other profiles
(no privilege on any voice table), so "this voice id belongs to another profile" is answered by the database's own UNIQUE: the worker
records the id, and `voice_id_taken` means nothing is deleted and a person looks. An orphan is removed only after the database has *just
rejected* the profile (an answer that was recorded: not `lost`, not `unrecorded`), or by a `purge_sample` of a profile whose status is
`rejected` or `deleted` with no voice recorded (0121): a pending or usable profile may have a clone in flight, and a clone that is still
running for a deleted profile records its voice afterwards and gets its own `delete_provider` (a 404 is done).

**Keep.** If the owner chose to keep the sample (`keep_sample`), the worker does **not** delete it after a successful clone: the database
queued no purge and the profile says `stored`. It is deleted by `delete_voice_sample` or `delete_voice`, like the database says.
(v1's UI offers no such choice yet; the default is delete.)

**Known gaps, none of which a test can close**

- A worker that is alive but silent for 30 minutes (no heartbeat function exists; a job takes seconds) can lose its lease while a second worker
  takes the job. The second adopts the labelled voice, the first's late answer is refused (`not_holder`) and it deletes nothing; but if the
  first was still *before* its create, two voices of one name could exist, and only the extra one labelled for the profile is removed later.
- A voice created whose answer was lost, in an attempt that then ended for good, is removed by the `purge_sample` that follows, **if the
  profile is `rejected` or `deleted` and has no recorded voice** (since 0121: it ends the parked clone job of a deleted profile and queues
  that purge, and the worker sweeps a deleted profile like a rejected one) and the provider is reachable; otherwise find it by name
  (`ns-<owner_ref>-<profile8>`, above).
- The 2-hour upload window is the database's (`claim_voice_job` lapses a request that has no object). The worker does not know the
  profile's age, so a sample uploaded just before the window closes is cloned like any other.
- `provider_not_enabled` (an explicit "no") rejects the request. There is no "wait for an upgrade" state in 0117; after the plan changes the person asks again.

**Purging a stranded sample by hand** (the worker is not running, or its key is away, or a purge failed for good). The recording is
`<user_id>/<profile_id>/sample.<ext>` in the private bucket `voice-samples`. Delete it with the dashboard (Storage, `voice-samples`) or with
the service key through the Storage API: `POST /storage/v1/object/list/voice-samples` with `{"prefix": "<user_id>/<profile_id>", "limit": 100,
"offset": 0}` to list, then `DELETE /storage/v1/object/voice-samples` with `{"prefixes": ["<user_id>/<profile_id>/sample.webm", ...]}`;
list again to confirm nothing is left (including any `.emptyFolderPlaceholder`). Direct `DELETE` on `storage.objects` from SQL does not remove
the blob. Then, as the database owner in the SQL editor, `update public.voice_profiles set sample_state = 'purged' where id = '<profile_id>';`
and, if a `purge_sample` job is left `queued`/`running`/`failed`, `update public.voice_clone_jobs set status = 'succeeded', error_code = null,
finished_at = now() where profile_id = '<profile_id>' and kind = 'purge_sample' and status in ('queued', 'running', 'failed');` (read the
`voice_profiles_guard` trigger first: **untested live**). Query 3 of the recurring check finds objects whose profile is gone.

## Gates before the owner may enable `NIGHTSHIFT_VOICE_CLONING`

Two of these (G2, G3) are closed, and the oracle is narrowed (not closed), by migration 0121, which becomes live when it is applied after
the independent security review. Everything else is a **live verification** or a separate decision. Each is a hard gate: do not set the variable until it is closed
or knowingly accepted.

- **G1 (closed in code, kept as a rule): no keyless worker.** See above. A purge-only worker needs a kind filter in `claim_voice_job`.
- **G2 (closed by 0121, migration): a clone job that was parked and whose profile the owner then deleted no longer stays `queued` for
  ever.** The cause was: `delete_voice` cancels *queued* clone jobs, but a parked one is `running`; when its lease ran out it went back to
  `queued`, and `claim_voice_job` hands out a clone job only for a profile that is `pending_verification`, so a deleted profile's clone job
  was never claimed and never ended; its live `(profile, kind)` row blocked `purge_voice_records` (`job_outstanding`), and with it the
  deletion of the account and of the organization, and the sweep a finished clone would have queued was never queued. Now `claim_voice_job`
  ends such a job once (`cancelled` if it was never claimed, `expired` if it was; error word `profile_not_pending`), for a **deleted or
  rejected** profile only, and queues `purge_sample` (when the job had been claimed, because a claimed attempt may have created a voice whose
  answer was lost, or when the sample is not purged yet; for a profile with no recorded voice that purge is also the provider sweep) and
  `delete_provider` (when a voice id is recorded). A running job whose lease has not run out is left to its worker. Proven in
  `tests/security/test_sec_voice_job_gates.py`, including the control (0117's function leaves the purge at `job_outstanding`) and account
  and organization deletion once the voices are purged. A stranded row already on the live database is ended by the first claim after the
  file is applied.
- **G3 (the migration and the command are built; the schedule and the alert are not): `voice_requeue_overdue()` and
  `voice_overdue_report()`** (0121) and `tools/voice_worker.py --sweep`, described under "The longer horizon". What stays open is the owner's
  decision to run `--sweep` on a schedule and to have a person told when it exits 1 or 2: **nothing starts it**. Until then the recurring SQL
  checks above are a human's daily duty.
- **The oracle (narrowed by 0121, NOT closed; see "The oracle on `channel_voice_config_problem`")** is "Hard condition" 2 of the migration
  that grants `request_voice_clone`. The function no longer leaks to a stranger; the entry guards still do for a user with a workspace.
  Accept it, or close it, before that grant.
- **Live verification of the free-plan answer shape.** Run the *ElevenLabs plan probe* workflow on the current (free) account and read
  whether the subscription carries `can_use_instant_voice_cloning: false` or no such field. If the field is absent, the free plan ends as
  `provider_plan_unknown` after about 90 minutes instead of `provider_not_enabled` at once, and the code or the copy must be decided.
- **Live verification that ElevenLabs accepts, and clones well from, a 16 kHz mono wav**, which is what the worker now sends. Compare a
  clone made from it with one made from the original recording; if it is worse, add a second capped decode at a higher rate.
- **Live verification of the labels format**: that `GET /v1/voices` returns `labels` as an object with the keys we set
  (`nightshift_profile` = the full profile id, `nightshift_owner_ref`), or that `GET /v1/voices/{id}` does. A voice with the right name and
  no labels anywhere is treated as a conflict (never adopted), so if labels are not returned, an adoption after a lost create answer ends as
  `provider_conflict` instead of recovering.
- **Live verification of the Storage request shapes** (download, list, delete with `prefixes`, a missing object answering 404 or 400
  `statusCode` 404, and the object really gone afterwards), of the rlimits (3 GiB address space) with the worker image's ffmpeg, of Whisper
  on a real MediaRecorder `audio/webm` recording, and of `language="en"` for Uzbek and Russian speakers.
- The grant of `request_voice_clone`, the UI, the Actions pre-flight ("Hard gate" above) and counsel's consent text are separate gates.

## The UI (slice V3, dark)

`/{channel}/agents/voice`, under the channel's agents area (`command-center/app/(app)/[channel]/agents/voice/page.tsx`). **No migration,
no grant, nothing live.**

**The switch.** `CUSTOM_VOICE_ENABLED`, a server-side environment variable (repository variable of the same name, mapped in
`deploy_web.yml`, empty in `deploy/.env.web.example`). Only the literal `1` is on. Off, the page is the public 404 and no database
client is created: the middleware answers before the auth gate (`customVoiceDecision`, `lib/custom-voice.ts`) and the page checks the flag
as its first statement. The agents page links to it only while the flag is on. **The flag is not the grant**: with it on, the first call
(`request_voice_clone`) is still refused by the database, and the page words that as "Not available yet" (nothing was recorded or sent).
Setting the variable is the owner's act; it is read per request, a restart is enough.

**What the page does**, all in the browser with the signed-in person's own session (no API route, no service key; the route list gains
only the flagged page):

1. Explains the flow and the honest limit ("this proves a live person read a phrase, not whose voice it is"), and says recording is live
   only, in one take, with no file upload.
2. **Consent**: a name and the five declarations the database requires (own voice, only speaker, over 18, recording goes to the voice
   technology partner, no impersonation), each a required checkbox, and the consent text. **The consent text is a PLACEHOLDER marked
   "counsel review required"; its version constant `CONSENT_TEXT_VERSION` is `v0`** (not `v1`: recording v1 for text nobody reviewed
   would be a false record in the append-only trail). Counsel's text ships as `v1` with the change of that constant and of
   `CONSENT_TEXT_IS_PLACEHOLDER`. The five declaration labels are short statements of the five facts and are for counsel to review with it.
3. **The request** is the first call, because the phrase is the database's and only comes back from it. A browser that cannot record is
   told before the request, so it does not spend one of the day's five.
4. **Recording**: `MediaRecorder` only, a 30 to 60 second guard (shorter is discarded with the length said, longer is stopped at 60),
   listen, record again, then the upload to `<user_id>/<profile_id>/sample.<ext>` of the private bucket with the person's own session,
   using the prefix the database returned and the base content type (`audio/webm`, not with codecs). Microphone denied, no microphone,
   an unsupported browser and a site-policy block each have their own sentence.
5. **The list** (explicit columns only: no provider voice id, owner reference, hash or path is ever read into the screen), polled every
   5 seconds for up to 10 minutes while a request is being checked. Every state has a card: pending (checking, or no recording received),
   testing, approved, rejected (the closed reason word mapped to translated text; an unknown word reads "no reason could be shown"),
   deleted ("deletion was requested", not "done": the removal at the provider and of the recording is the worker's, in the background).
6. Approve, attach to and detach from the current channel (narrator slot), delete voice and delete recording, each behind the confirm sheet,
   each answering with the database's own word mapped to a sentence.

**The test step is a labelled stub.** The Studio speech tool is a priced job (quote, hold, capture) that needs the voice id, which this
screen never holds; wiring it is its own change. The card says so ("Not connected yet", with a TODO) and makes no call. Consequence: until it
exists the Approve button is **switched off** (`TEST_STEP_WIRED` in `lib/custom-voice.ts`, flipped by the change that wires the test), and its
confirm text does not claim the voice was heard; **no voice can be approved from the UI**.

**What must be switched on or granted (owner)**, in order: counsel's consent text (and the constants above); the gates below; the grant of
`request_voice_clone` and the strict gate (see "Hard conditions"); then `CUSTOM_VOICE_ENABLED=1`. Nothing in this slice does any of them.

**Open items this slice found (none is closed by it):**

- **V3-G1, the Permissions-Policy blocks the microphone site-wide.** `next.config.ts` and `deploy/Caddyfile` both send `microphone=()`.
  With that, `getUserMedia` is refused whatever the person clicks. The page detects it (`document.permissionsPolicy.allowsFeature`, where
  the browser has it) and says "Recording is not enabled for this site yet", but does not change the headers: opening the microphone is a
  deploy-header change to make on purpose, for this one path (`microphone=(self)` in both places, and the Caddy line must exclude the path,
  because two policies are intersected). It is not made here (nothing live).
- **V3-G2, a 30 to 60 second recording and the phrase check disagree.** The worker accepts at most the phrase plus 8 other words
  (`MAX_EXTRA_WORDS`): about 14 words in all. Thirty seconds of normal speech is about 75 words and fails with `verification_failed`. The page
  asks for the phrase once and for the recording to run to 30 seconds, which in practice means long pauses. Either the worker checks the
  phrase against the start of the transcript (or windows), or the guard changes; the owner decides before any live test.
- **V3-G3, no resume.** The phrase is shown once. A reload before the upload leaves a pending request with no recording: the card says so and
  offers delete (which frees the slot); the request also lapses by itself after 2 hours. A recording cannot be replaced after the upload
  (the bucket grants insert only), so re-recording is possible only before it is sent.
- **V3-G4, translations.** ru and uz are machine drafts, flagged in `lib/i18n/custom-voice/*` and by a visible note at the top of the page.

Hardening after review (hardening PR): a take that ran past 60 s (a paused tab) is discarded, not shown as 60 s; a storage refusal naming the
format is its own message, a bare 400 is not read as "the request ended", and a 409 (a recording already there, e.g. after a lost answer)
ends the flow and re-checks the request instead of stranding the person; focus moves to the heading of each step; the scan test guards
`delete_voice_sample`, forbids `my_voice_ref` everywhere (it returns the owner reference to the browser) and also covers `middleware.ts` and
`command-center/scripts`.

## What is NOT built yet

- the **Studio test step** (a stub, above), so approval from the UI;
- **`regenerate_line`** (re-voice one line of a finished video);
- the **consent text** (a placeholder, `v0`) and the Privacy Policy / Terms changes;
- a **scheduled purge**, a **scheduled `--sweep`** with an alert, and a retention period for `purge_voice_records` (it is run by hand);
- anything that **runs** the worker (a service, a cron entry, a workflow) and the grant of `request_voice_clone` (the run-time re-check of the
  hard gate is built: see "Hard gate");

## Things the worker does because the database cannot

- **Sniff the audio bytes.** The bucket's MIME allow-list checks the *declared* type only. The worker identifies the real container
  (`sniff_audio`), refuses anything that is not audio, decodes once to a capped wav and measures that (see "The decode"); the provider
  gets that wav.
- **Enforce the upload window.** The "2 hours" is enforced only by `claim_voice_job`'s expiry of a request nobody uploaded for. The
  bucket's insert rule has no clock: until that sweep has rejected the profile, a late recording is still accepted (and then cloned like
  any other); after it, the profile is no longer waiting and the rule refuses. The worker is not told the profile's age and does not
  check it. If the window matters, `claim_voice_job` must return it (a later migration).
- **Delete the object itself** for every `purge_sample` job (the database only asks), through the Storage API.

## Live blockers (nothing here can be tested live until they are cleared)

**Closed by tests (fakes, and the real ffmpeg when the machine has it), not by a live call:** the header-duration bypass (the decoded
length is what counts); one audio stream and no video; the provider and Whisper hear the same capped wav; ffmpeg runs with an empty
environment, the `file` protocol only, a named demuxer, a timeout and rlimits; leftover work directories are swept; a worker without the
ElevenLabs key refuses to start (it would otherwise burn every outstanding job's claims); purge and delete failures are parked for the full lease horizon and then logged `voice OVERDUE`; a voice is adopted or
deleted only with the full profile id and owner label; a recording is not burned for a bad key, an unknown plan or an outage; the logs are
quiet under sentinel secrets on every path.

**Still open:**

1. **The ElevenLabs plan is FREE**, which does not allow instant voice cloning. `ElevenLabsVoiceProvider.create_voice` refuses to run, and
   says so, unless the read-only plan probe reports `can_use_instant_voice_cloning` is true (an answer without the field counts as no;
   the worker *parks* that case as `provider_plan_unknown` and rejects only an explicit `false`: **whether the real free-plan answer
   carries an explicit `false` is unverified**, and until it is, a free-plan clone ends as `provider_plan_unknown` after about 90 minutes
   instead of at once). Run the manual workflow *ElevenLabs plan probe* after upgrading. Voice slots on the plan are the operator's, which
   is why a user is limited to 3 live voices.
2. **Every ElevenLabs request shape in `modules/voice_profiles.py` is "from the public API as the planner knew it, UNVERIFIED live"**:
   `POST /v1/voices/add` (multipart `name`, `files`, `labels`), `DELETE /v1/voices/{id}`, `GET /v1/voices/{id}`, `GET /v1/voices` (the
   worker's lookup: the `voices` list with `name`, `voice_id` and `labels`, or the labels from `GET /v1/voices/{id}`), the response field
   `voice_id`, whether a 16 kHz wav is accepted and clones well, whether cloned voices work with `eleven_v3` / the Uzbek and Russian
   narration, commercial and sub-licensing terms for customers' clones on the operator's account, and whether a clone costs characters.
3. **The Storage API request shapes in `modules/voice_worker.py` are UNVERIFIED on the live project too**: `GET /storage/v1/object/voice-samples/<path>`
   with the service key (and that a missing object answers 404, or 400 with `statusCode` 404), `POST /storage/v1/object/list/voice-samples`
   (`prefix`, `limit`, `offset`; folders come back with `id: null`), `DELETE /storage/v1/object/voice-samples` (`prefixes`), and that the
   object is really gone afterwards. Also unverified: a real Whisper on a MediaRecorder `audio/webm` recording (it has no duration in its
   header; the decode measures it), the rlimits (3 GiB address space) with the worker image's ffmpeg, and that Whisper hears a six-word
   English phrase spoken by a Uzbek or Russian speaker with `language="en"`.
4. **A longer retry horizon than about 90 minutes needs a migration** (above). Until then the recurring check is a human's.
5. **Counsel.** The Privacy Policy and Terms (`command-center/lib/legal-docs`) say **nothing** about voice samples today. A voice sample
   may count as biometric data in some jurisdictions; the legal basis, the retention of consent and deletion records, and what a deletion
   request can remove are legal decisions. Nothing should be switched on for customers before they are made.

## Deletion, retention, and what blocks what

- **Deleting an auth user** is blocked by the foreign keys from `voice_profiles` until that user's voices are deleted (`delete_voice`) and
  purged (`purge_voice_records`; since 0121 a clone job a worker had parked no longer blocks it, and `tests/security/test_sec_voice_job_gates.py`
  deletes a user and an organization after the purge). **Deleting an organization** is blocked the same way (`voice_profiles.org_id` is `ON DELETE RESTRICT`). The
  account- and organization-deletion procedures must include those two calls first.
- **`voice_deletion_records` has no retention yet**: it is append-only, even `purge_voice_records` cannot remove its rows, and nothing
  deletes them. How long to keep them is counsel's decision.
- The consent trail and the deletion record are `ENABLE ALWAYS` triggers: they still fire when a session sets
  `session_replication_role = replica`.

## Decisions for the owner

- The numbers: 5 requests per person per day, 3 live voices per person, a request lapses after 2 hours without a sample. All are
  constants in `request_voice_clone` / `claim_voice_job`.
- Whether a user may test a voice (a Studio `tts` clip) while it is `testing`. The brief said "only when approved"; but approval is
  "after a test", so a test of an unapproved voice has to be allowed for the owner alone. The alternative is a worker-made test clip.
- `own_clone` is written for a non-platform administrator by `attach_voice_to_channel`. That is a deliberate exception to 0114's lock for
  this one path; `own_clone` does not change the label.
- Whether cloning costs credits (it does not, here).
- The retention period after which `purge_voice_records` is run, and whether a user can ask for it (it is service-only now).
- Deleting an auth user is blocked by the profile's foreign key until the user's voices are deleted and purged. That is deliberate (a
  voice must not outlive its owner's record in the provider account) but it is a step the account-deletion procedure must include.

## How to apply and verify (owner)

1. Merge only after the independent security review. The Supabase integration applies the file to the live database on merge.
2. Before: `select count(*) from auth.users;` (the backfill creates this many rows in `user_voice_refs`). The drift check is **in the
   file**: a `DO` block at the top compares the md5 of the body of the live `channels_config_guard()` and `audit_action_allowed()` (with
   white space read as one space, so line endings and indentation cannot cause a false alarm) with the 0114 / 0116 bodies in the repo (or
   0117's own, which is what a replay sees) and **raises** if either differs: something was applied by hand since; read the live body
   first.
3. Apply `0117_voice_profiles.sql` (or let the integration). It is idempotent; running it twice changes nothing.
4. Run the **Verify** block at the bottom of the migration file (every column must read `true`), then the two storage-policy queries
   (the second must return no row) and the two overdue/dangling queries (both must return no rows).
5. Read-only checks you can paste:

```sql
-- no voice anywhere yet; no sample waiting
select count(*) as profiles from public.voice_profiles;
select count(*) as queued from public.voice_clone_jobs where status = 'queued';
-- the entry guards exist
select tgname, tgrelid::regclass from pg_trigger
 where tgname in ('creative_jobs_voice_guard', 'render_jobs_voice_guard', 'channels_config_guard') and not tgisinternal;
-- the bucket
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'voice-samples';
-- nothing but SELECT is granted on the voice tables to an API role (expected: no rows)
select grantee, table_name, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and table_name like any (array['voice\_%', 'user\_voice\_refs'])
   and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and privilege_type <> 'SELECT';
```

6. Undo: `docs/sql/rollback_0117_voice_profiles.sql` (owner-applied). Read its header first: after it, a cloned voice id is protected by
   nothing again, so delete every clone first. It **keeps** the six tables, their rows and the bucket (the consent record).

### Applying `0121_voice_job_gates.sql` (owner)

1. Merge only after the independent security review: the file is **live on apply**. It replaces `claim_voice_job()` and
   `channel_voice_config_problem()` (both on 0117's bodies; no later migration redefines either) and adds three functions. It writes no row,
   alters no table, trigger or policy, and does not grant `request_voice_clone`.
2. **Apply it as ONE transaction** (the SQL editor, `apply_migration`, or `psql --single-transaction -v ON_ERROR_STOP=1`). A half-applied file
   (the oracle narrowed but the queue function not yet replaced, or the reverse) is not a state anyone designed for.
3. The drift check is in the file: a `DO` block at the top compares the md5 of the live `claim_voice_job()` and
   `channel_voice_config_problem()` bodies (white space read as one space) with 0117's and 0121's own, and **raises** if either is
   something else (applied by hand since: read the live body first). It also refuses if one of the three new names already exists with
   another body. Re-running 0117 afterwards puts 0117's two bodies back and would be refused by nothing: re-apply 0121 after it.
4. Run the **Verify** block at the bottom of the file (every column `true`), then `select public.voice_overdue_report();` as the SQL editor
   (every count 0 on a database with no voice yet).
5. Undo: `docs/sql/rollback_0121_voice_job_gates.sql` (owner-applied; refuses a body it has not seen, restores 0117's two bodies byte for
   byte and their grants, drops the three functions). It rewrites no row: a queue row that `claim_voice_job` already ended stays ended. After
   it the oracle is open again and `--sweep` reports the functions as not available.
6. Deploy order: the file first, then the code. `tools/voice_worker.py --sweep` on a database without 0121 exits 2 and says so; the rest of
   the worker is unchanged. The worker's one other change (`purge_sample` sweeps a **deleted** profile's labelled voices as well as a
   rejected one's) is harmless before the file.
