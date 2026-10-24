# Custom voice: a user clones THEIR OWN voice, and only that user uses it

Status: **database and pure code only** (migration `0117_voice_profiles.sql`, `modules/voice_profiles.py`), plus the two run-time
checks of the hard gate (`modules/voice_gate.py`, `lib/server/run-voice.ts`), which call the one read-only function
`channel_voice_config_problem` and change nothing for a run that uses no cloned voice. Nothing live runs: the ElevenLabs account is on
the **free plan**, which does not allow instant voice cloning. No worker, no screen, no workflow calls any other function of this
feature (a test fails if one starts to before this document is updated).

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
| `claim_voice_job(worker)` / `finish_voice_clone(...)` / `finish_voice_task(...)` | the service role | the worker's side (below) |
| `purge_voice_records(profile)` | the service role | removes a **deleted** voice's rows once its provider copy and sample are gone; keeps `voice_deletion_records` |
| `voice_usable_by(user, voice, org, channel)` | nobody (internal) | **the rule** |

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
  `no_impersonation`; and a consent text version (`v1`...). The wording of the consent text is **not written** (counsel; below).
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
org, old, new)` (granted to `authenticated` and `service_role`; it takes **no person**, so it answers for the **channel path** only):
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
     Actions, after two tries and about five seconds at most. This is the repository's rule for a Supabase outage (the channel registry
     falls back, the slot guard fails open), and today the gate protects nothing the outage could cost, because no custom voice can
     exist. With **`NIGHTSHIFT_VOICE_GATE_STRICT`** on (repo variable, reaches the daily run and the worker; empty = off), "could not
     answer" stops the run instead: exit **83**, its own red annotation ("could not be verified", not "not permitted"), three tries, the
     queue job fails with the hold released. `render_error` classes both endings as `voice`, not `unknown`.
   - **"The function does not exist"** (only PostgREST `PGRST202` or Postgres `42883`; the same two the route accepts) means 0117 is not
     applied, so no profile can exist: the run goes on, with a warning and an annotation. Any other 404 is "could not answer".
   - Not asked, by design: an Edge channel (it speaks no ElevenLabs voice), a value that is not shaped like a voice id, and the
     configured defaults above.
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
2. **`channel_voice_config_problem` restricted** to members of the channel's organization and the service role (it needs a migration;
   none is written here). It is executable by every signed-in user (0117 grants it to `authenticated` so the channels guard can ask it), and
   it takes any channel and any voice id: a stranger can learn that an id is a clone (it answers a key rather than NULL), which is an
   **oracle** on other people's voices. Harmless while no clone exists; not acceptable after the grant.
3. The worker, the UI and the consent text (below).

### What remains

- **The grant of `request_voice_clone` is a separate decision.** It is still granted to nobody, and this PR does not change that. It
  also needs the worker, the UI and the consent text (below). The two checks above are what the grant was waiting on, not a reason to
  make it.
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

## What is NOT built yet

- the **worker**: the clone job (claim, read the sample with the service role, Whisper the phrase, call the provider, finish), the
  provider deletion and the sample purge (the run-time re-check for runs that do not go through `render_jobs` is built: "Hard gate");
- the **UI**: recording, the phrase, the declarations, test, approve, attach, delete, and every state of them;
- **`regenerate_line`** (re-voice one line of a finished video);
- the **consent text** and the Privacy Policy / Terms changes;
- a **scheduled purge** and a retention period for `purge_voice_records` (it is run by hand);
- an HTTP **Whisper** step (the checker takes a transcript).

## Things the worker must do, because the database cannot

- **Sniff the audio bytes.** The bucket's MIME allow-list checks the *declared* type only. The worker must identify the real container
  (and refuse anything that is not audio) before it hashes, transcribes or sends the sample to the provider.
- **Enforce the upload window.** The "2 hours" is enforced only by `claim_voice_job`'s expiry of a request nobody uploaded for. The
  bucket's insert rule has no clock: until that sweep has rejected the profile, a late recording is still accepted (and then cloned like
  any other); after it, the profile is no longer waiting and the rule refuses. If the window matters, the worker must check the
  profile's age itself.
- **Delete the object itself** for every `purge_sample` job (the database only asks).

## Live blockers (nothing here can be tested live until they are cleared)

1. **The ElevenLabs plan is FREE**, which does not allow instant voice cloning. `ElevenLabsVoiceProvider.create_voice` refuses to run, and
   says so, unless the read-only plan probe reports `can_use_instant_voice_cloning` is true (an answer without the field counts as no).
   Run the manual workflow *ElevenLabs plan probe* after upgrading. Voice slots on the plan are the operator's, which is why a user is
   limited to 3 live voices.
2. **Every ElevenLabs request shape in `modules/voice_profiles.py` is "from the public API as the planner knew it, UNVERIFIED live"**:
   `POST /v1/voices/add` (multipart `name`, `files`, `labels`), `DELETE /v1/voices/{id}`, `GET /v1/voices/{id}`, the response field
   `voice_id`, whether cloned voices work with `eleven_v3` / the Uzbek and Russian narration, commercial and sub-licensing terms for
   customers' clones on the operator's account, and whether a clone costs characters.
3. **Counsel.** The Privacy Policy and Terms (`command-center/lib/legal-docs`) say **nothing** about voice samples today. A voice sample
   may count as biometric data in some jurisdictions; the legal basis, the retention of consent and deletion records, and what a deletion
   request can remove are legal decisions. Nothing should be switched on for customers before they are made.

## Deletion, retention, and what blocks what

- **Deleting an auth user** is blocked by the foreign keys from `voice_profiles` until that user's voices are deleted (`delete_voice`) and
  purged (`purge_voice_records`). **Deleting an organization** is blocked the same way (`voice_profiles.org_id` is `ON DELETE RESTRICT`). The
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
