# Custom voice: a user clones THEIR OWN voice, and only that user uses it

Status: **database, pure code and a worker behind a switch** (migration `0117_voice_profiles.sql`, `modules/voice_profiles.py`,
`modules/voice_worker.py`, `tools/voice_worker.py`). Nothing live runs: the ElevenLabs account is on the **free plan**, which does not
allow instant voice cloning. The worker is **off** unless the repository variable `NIGHTSHIFT_VOICE_CLONING` is `on` (the owner sets
it; it is empty by default and reaches the worker env through `deploy_web.yml`), and **nothing starts it**: no service, cron entry or
workflow runs `tools/voice_worker.py` (a test fails if one does). No screen calls any of the rest yet (a test fails if one starts to
before this document is updated).

**It is also dormant at the API.** `request_voice_clone` is created and granted to **nobody** (not `authenticated`, not `service_role`):
starting a clone is the one entry into the feature, so no signed-in user can create a profile, a queue row or (the bucket's insert rule
needs a waiting profile) a stored object. The grant ships in the migration that ships the worker, the UI and the Actions pre-flight; see
"Hard gate" below.

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

So **the migration that grants `request_voice_clone` MUST be preceded by**: the Run-now route and the Actions pre-flight (before any spend)
calling a `voice_usable_by`-equivalent check (a service-side RPC that answers for the run's requester, the channel and the voice ids it
will use) and refusing the run when it fails. Until that exists nothing can create a custom voice (the function is not granted), so the
gap is empty today; **it must not be allowed to become real**. No code for it is in this PR.

## The worker (slice V2)

`tools/voice_worker.py [--once]` carries out `voice_clone_jobs` with the service key, through `claim_voice_job`, `finish_voice_clone` and
`finish_voice_task` only (it never calls `purge_voice_records`: that stays the operator's, after a retention period). It needs
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `ELEVENLABS_API_KEY`; without the last it claims nothing.

| Job | What it does | Ends as |
| :-- | :-- | :-- |
| `clone` | 1. asks the account's plan (`can_use_instant_voice_cloning` must be a real `true`) **before anything else**; 2. fetches the object with the service key (no redirect, stops at 50 MB); 3. sniffs the bytes (never the declared type), probes streams and length (audio only, at most 300 s); 4. Whisper (the pipeline's local one) must hear the phrase; 5. looks for a voice of the profile's own name and adopts it, otherwise creates one; 6. records the id and hash with `finish_voice_clone`; 7. only then deletes the whole `<user_id>/<profile_id>/` prefix (unless the owner chose to keep the sample) | `testing`, or `rejected` with a closed reason |
| `delete_provider` | `DELETE /v1/voices/{id}`; 404 is done; needs no plan | done, or retried (3 attempts) then failed |
| `purge_sample` | deletes the prefix, lists it again to confirm it is empty; for a profile that never got a voice recorded it also removes any voice of that profile's name from the provider (an orphan) | `sample_state = purged` |

Reasons a profile is rejected (`reject_reason` / `error_code`, all closed words): `provider_not_enabled` (the plan, **what every clone ends
as on the free plan: nothing was fetched, nothing created, nothing spent**), `provider_not_configured`, `provider_auth`,
`provider_rejected`, `provider_redirect`, `provider_unavailable` (retried first), `provider_error`, `not_audio`, `unreadable_audio`,
`sample_too_large`, `sample_too_long`, `sample_missing`, `storage_error`, `transcribe_failed`, `verification_failed` (the wrong phrase),
`worker_error`, `worker_lost`, `bad_job`.

**Retry and loss.** A failure that can pass (network, timeout, 5xx, 429, the transcriber) is reported as `transient`; the database puts the
job back while `attempts < max_attempts` (3) and the worker reports the meaningful word on the third. The sample is kept between attempts
and deleted at the end. A worker that dies leaves the job `running`; after 30 minutes `claim_voice_job` queues it again, and after three
losses rejects the profile (`worker_lost`) and queues `purge_sample`. Every path that ends a profile queues its purge, and the worker
deletes the prefix twice (right after the answer is recorded, then when the purge job runs). A retry never makes a second voice: it
looks for the voice of the profile's own name first.

**Keep.** If the owner chose to keep the sample (`keep_sample`), the worker does **not** delete it after a successful clone: the database
queued no purge and the profile says `stored`. It is deleted by `delete_voice_sample` or `delete_voice`, like the database says.
(v1's UI offers no such choice yet; the default is delete.)

**Known gaps, none of which a test can close**

- A worker that is alive but silent for 30 minutes (no heartbeat is sent; a job takes seconds) can lose its lease while a second worker
  takes the job. The second adopts the voice by name, the first's late answer is refused (`not_holder`) and it deletes nothing; but if
  the first was still *before* its create, two voices of one name could exist. The orphan sweep above removes the extra one only for a
  profile that has no recorded voice.
- A voice created whose answer was lost, in an attempt that then died three times, is removed by the `purge_sample` that follows. If the
  provider is unreachable then, it stays; find it by name (`ns-<owner_ref>-<profile8>`, above).
- The 2-hour upload window is the database's (`claim_voice_job` lapses a request that has no object). The worker does not know the
  profile's age, so a sample uploaded just before the window closes is cloned like any other.
- `provider_not_enabled` rejects the request. There is no "wait for an upgrade" state in 0117; after the plan changes the person asks again.

## What is NOT built yet

- the **UI**: recording, the phrase, the declarations, test, approve, attach, delete, and every state of them;
- a run-time re-check of `voice_usable_by` for runs that do not go through `render_jobs` (the GitHub Actions path reads the channel config at
  run time; the config guard and the deleted-voice provider 404 are what protect it today);
- **`regenerate_line`** (re-voice one line of a finished video);
- the **consent text** and the Privacy Policy / Terms changes;
- a **scheduled purge** and a retention period for `purge_voice_records` (it is run by hand);
- anything that **runs** the worker (a service, a cron entry, a workflow) and the grant of `request_voice_clone`;
- the **Actions pre-flight** above (the hard gate).

## Things the worker does because the database cannot

- **Sniff the audio bytes.** The bucket's MIME allow-list checks the *declared* type only. The worker identifies the real container
  (`sniff_audio`), refuses anything that is not audio, reads the streams and the length with ffprobe (a container with a video stream,
  or without an audio one, is refused) and sends the provider the *sniffed* type.
- **Enforce the upload window.** The "2 hours" is enforced only by `claim_voice_job`'s expiry of a request nobody uploaded for. The
  bucket's insert rule has no clock: until that sweep has rejected the profile, a late recording is still accepted (and then cloned like
  any other); after it, the profile is no longer waiting and the rule refuses. The worker is not told the profile's age and does not
  check it. If the window matters, `claim_voice_job` must return it (a later migration).
- **Delete the object itself** for every `purge_sample` job (the database only asks), through the Storage API.

## Live blockers (nothing here can be tested live until they are cleared)

1. **The ElevenLabs plan is FREE**, which does not allow instant voice cloning. `ElevenLabsVoiceProvider.create_voice` refuses to run, and
   says so, unless the read-only plan probe reports `can_use_instant_voice_cloning` is true (an answer without the field counts as no).
   Run the manual workflow *ElevenLabs plan probe* after upgrading. Voice slots on the plan are the operator's, which is why a user is
   limited to 3 live voices.
2. **Every ElevenLabs request shape in `modules/voice_profiles.py` is "from the public API as the planner knew it, UNVERIFIED live"**:
   `POST /v1/voices/add` (multipart `name`, `files`, `labels`), `DELETE /v1/voices/{id}`, `GET /v1/voices/{id}`, `GET /v1/voices` (the
   worker's lookup of a voice by its exact name: the `voices` list with `name` and `voice_id`), the response field
   `voice_id`, whether cloned voices work with `eleven_v3` / the Uzbek and Russian narration, commercial and sub-licensing terms for
   customers' clones on the operator's account, and whether a clone costs characters.
3. **The Storage API request shapes in `modules/voice_worker.py` are UNVERIFIED on the live project too**: `GET /storage/v1/object/voice-samples/<path>`
   with the service key (and that a missing object answers 404, or 400 with `statusCode` 404), `POST /storage/v1/object/list/voice-samples`
   (`prefix`, `limit`, `offset`; folders come back with `id: null`), `DELETE /storage/v1/object/voice-samples` (`prefixes`), and that the
   object is really gone afterwards. Also unverified: a real Whisper and a real ffprobe on a MediaRecorder `audio/webm` recording (such a
   file states no duration in its header; the worker decodes it once to measure it), and that Whisper hears a six-word English phrase
   spoken by a Uzbek or Russian speaker with `language="en"`.
4. **Counsel.** The Privacy Policy and Terms (`command-center/lib/legal-docs`) say **nothing** about voice samples today. A voice sample
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
