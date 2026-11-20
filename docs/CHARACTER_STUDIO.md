# Character Studio ("Qahramon studiyasi")

A person picks a video from their library and one picture per character, writes who becomes whom ("replace the person on the left
with @Image 1"), chooses the model by its price for that clip, declares the consent, and asks for one swap. A worker sends it to that
model's maker, stores the result in the library (labelled AI-made), and the credits are captured or given back.

**It ships DARK.** Nothing is on sale, nothing runs, and nothing is shown until the owner does the steps under "Releasing" below.

| Piece | Where | Off by |
|---|---|---|
| Database | `supabase/migrations/0137_character_studio.sql` | both models' `credits_per_usd` seeded NULL: `not_on_sale` |
| Worker | `tools/character_swap_worker.py`, `modules/character_swap.py` | `NIGHTSHIFT_CHARACTER_STUDIO` unset; not in docker-compose |
| Adapters | `modules/capabilities/character_swap.py` (`video.kling_omni`, `video.seedance2_edit`) | registry-only, terms-gated |
| Web | `/{channel}/character-studio`, `/api/character-studio/*` | `NIGHTSHIFT_CHARACTER_STUDIO` unset: 404, no rail entry |
| Samples | `tools/character_studio_samples.py` | prints a plan unless `--run --approve-paid-call <model>` |

## The two models (the person chooses)

Both are their makers' own first-party APIs, and both stay terms-gated in `schemas/model_registry.json`
(`api_exposure: web_only`; the capability `video_character_swap` is registry-only, so the creative system can never sell it).

| | Kling 4.0 Omni (`kling-4.0-omni-edit`) | BytePlus Seedance 2.5 (`seedance-2.5-edit`) |
|---|---|---|
| Call | `POST /omni-video/kling-4.0`, `contents[]`: `prompt`, `base_video`, `refer_image`; `settings.audio: "original"`; Bearer API key | `POST /api/v3/contents/generations/tasks`, model `dreamina-seedance-2-5-260628`, `omni_reference_task_type: "edit"`, `reference_video` + `reference_image`, `ratio: adaptive`, `duration: -1` |
| Poll | `GET /tasks?task_ids=<id>` | `GET …/tasks/<id>` |
| Input | 3–30 s, 700–4553 px a side, ≤ 8,294,400 px, 24–60 fps, ≤ 300 MB | 4–30 s, ≥ 407,696 px, 24–60 fps, ≤ 200 MB |
| Pictures | up to 10 | up to 30 |
| Sound | keeps the clip's own (`audio: original`) | not kept: `generate_audio: false`, and the picker says "No sound" before anything is asked. The worker does not re-mux the source's track, because the vendor's file is stored byte for byte (its provenance and any mark stay: `docs/AI_DISCLOSURE.md`); adding the sound back as an editor track is a follow-up |
| Watermark | optional mark off by default, no clause requires it: not sent (`docs/AI_DISCLOSURE.md`) | optional mark off by default, AUP forbids removing identifiers: not sent, file stored as it came |
| Vendor price (per clip second) | per the vendor pricing page (read 2026-11-11); output × 2 with a video input | per the vendor pricing page (read 2026-11-11); (in + out) s × W × H × 24 / 1024 tokens, ESTIMATE (the minimum-token table was not read) |
| Source | kling.ai/document-api/pricing/base/video | docs.byteplus.com/en/docs/ModelArk/1544106 |
| Gate | `terms_review_required` (Terms of API Paid Service 3.3) | `written_consent_required` (Customer Agreement 6.2(1), Model Services 4.2.3) |
| Real people | the consent step below | refused by BytePlus unless each performer is a verified BytePlus asset; **sold only for the organization's own generated clips** (see "Real people") |

Read 2026-11-11 (research note `character-swap.md`; Kling's 4.0 pages: `docs/research/monitoring-claims-2026-11-10.md` §5). Kling's
item field names are confirmed by the first probe the owner approves; `tests/test_character_swap_adapters.py` pins what we send.

## Money (0137, the 0133 pattern)

- **The charge** is computed in the database, never by a client: `credits_round_up(ceil(input seconds) × the vendor's USD per second
  at the resolution × the model's credits_per_usd)` (`character_swap_charge`). Each model shows its own charge for the person's clip
  (`quote_character_swap` returns every model at once, so switching the model in the picker changes the cost at once).
- **The hold** is `greatest(charge, credits_round_up(job_minimum))`, because `reserve_credits` refuses any hold below `job_minimum`
  (30 live) and no shared money function is changed. With job_minimum 30, a 10 s Kling clip at 720p and 10 credits per USD: 30
  held while it runs, 18.80 charged.
- **The capture** is exactly the charge: `capture_credits(ref, charge, false)` in `finish_character_swap`, which releases the rest of
  the hold in the same transaction.
- **Releases**: every worker failure, a cancel (only before a worker takes it), a job nobody took in 2 hours, a worker that went
  quiet before it recorded a vendor task (15 minutes), a recorded task still unfinished 6 hours after the submit.
- **The confirmed price** (`p_max_credits`) is compared with the charge, never the hold; NaN and the infinities are refused first.
  A higher charge is `price_changed` (detail `charge=…`), never charged.
- **Idempotent replay**: the same press (`p_idem`) with the same inputs is the same job and holds nothing twice; the same key with
  other inputs is `idempotency_conflict`.
- **One paid task per job**: the worker records the vendor's task id (`record_character_swap_task`) before its first poll; a crash
  then polls that task (the next claim resumes it) and never submits again. A submit whose answer was lost is UNCONFIRMED SPEND:
  the job fails, the person is not charged, nobody retries it, and the worker logs "POSSIBLE UNCONFIRMED VENDOR SPEND" with the job
  id and the model so it can be checked on the vendor's usage page (Kling also carries the job id as `external_task_id`). A finish
  without a recorded task is refused.
- **The length that was priced is the file's.** The quote reads the library's recorded length; before any paid call the worker
  measures the file itself with ffprobe (the video stream's length, else its frames over its rate, else the container's) and refuses
  the job (`input_length_mismatch`, hold released) if the two differ by more than one frame plus 0.1 s, so a file whose header
  understates its length is never sold below cost or past the vendor's limit.
- **Caps** (`character_swap_settings`, safety defaults, not yet owner-approved): one job in flight per organization (unique index),
  10 per organization per 24 h, 200 per platform per 24 h, 20 in flight on the platform; 100 consents per organization per 24 h.
- The exempt (operator's) organization is not charged, and only a platform admin may start a swap there.

## Consent and real people

- **The consent step** (modelled on `docs/CUSTOM_VOICE.md` / 0117): before a request the person declares, for THIS video, THESE
  pictures in this order and THIS model, all five of: `rights_to_video`, `performers_consented`, `no_minors`,
  `references_owned_or_licensed`, `data_to_provider`. `character_swap_consents` is append-only for every role (ENABLE ALWAYS
  triggers) and has no foreign key, so the trail outlives the job. A request needs a consent of the same person, organization, model,
  video and pictures, made within the hour, used by no other job (`consent_required`). The text version is `v1`.
- **The prompt screen** (`character_swap_prompt_problem`, the same list as `modules/character_swap.PROMPT_PATTERNS`, in the spirit of
  `modules/avatar.synthetic_only_guard`): words that read as a real or public person, a lookalike, a deepfake or a child are refused
  (`prompt_real_person`); hidden and control characters are refused; the words must name a picture (`@Image 1`). KEYWORD-WEAK BY
  DESIGN: it stops casual attempts and says so; the consent and the vendor's own refusals stand behind it.
- **Seedance and real faces.** BytePlus refuses real human faces unless each performer is verified through its real-person asset flow
  (a QR invitation, verification on the performer's own phone, an `asset://` id). 0137 does not take such ids yet, so Seedance is sold
  ONLY for a video that is the organization's own generated clip: `source = 'generated'`, a BytePlus model's output per its
  provenance, at most 30 days old (ModelArk's own "trusted model outputs" rule: the same account, within 30 days, unedited). Anything
  else is `needs_own_generated_clip`, and the quote says so per model before anything is asked. Taking performer asset ids is a
  follow-up (it needs BytePlus's Assets API, part of the paid "Advanced Creation Rights").
- **The AI label** (`docs/AI_DISCLOSURE.md`): every output is stored as `source = 'generated'` with provenance `origin:
  character_swap`, `ai_label: altered_or_synthetic`, `ai_reasons: [generated_video, people_replaced]` (the database's finish refuses
  any other output), and the studio shows "AI-made" on every result. Carrying that label into a render or an upload that uses the clip
  (`modules/ai_disclosure.py`'s `generated_video` reason, YouTube's `containsSyntheticMedia`) is a follow-up: the library does not
  read provenance into the run's signals yet.

## Unlocking a model (owner actions)

Nothing below is done by this change. In order, per model:

**Kling 4.0 Omni**
1. Kling's written answer to the terms letter (sent 2026-11-11) on Terms of API Paid Service 3.3 (offering it to our users).
2. Buy a video resource package; keep `KLING_API_KEY` as the plain console API key (an `access:secret` pair is the legacy API's and
   is refused); set a spend cap in Kling's console.
3. Approve one probe (a 5 s 720p edit, priced on the vendor pricing page) and run it through the worker on an owned clip; confirm the request fields.
4. Set the price: `update public.character_swap_models set credits_per_usd = <n> where model_id = 'kling-4.0-omni-edit';`
   (a `security_events` row of kind `character_swap.settings` records it). Change the registry's `terms_gate` only then.

**Seedance 2.5**
1. BytePlus's written authorisation (sent 2026-11-11) covering Customer Agreement 6.2(1) and Model Services 4.2.3.
2. Activate 2.5 (the console's minimum balance, a savings plan or a resource pack); complete enterprise verification (4.2.2 asks the platform to
   verify end users and keep a takedown process).
3. Decide on "Advanced Creation Rights" (the Assets API) if performer verification should be offered (follow-up).
4. Approve one probe on the account's own ModelArk clip, then set the price as above for `seedance-2.5-edit`.

## Releasing (after a model is unlocked)

1. Apply 0137 (merged = applied; it is dark on its own). Verify with the block at the end of the file.
2. The web switch is already plumbed and empty (`deploy/.env.web.example`, `.github/workflows/deploy_web.yml`). Add
   `NIGHTSHIFT_CHARACTER_STUDIO` + `NIGHTSHIFT_CHARACTER_STUDIO_PUBLIC_ORIGIN` + `MEDIA_URL_SECRET` to `deploy/.env.worker.example`
   and remove the `NIGHTSHIFT_CHARACTER_STUDIO_PUBLIC_ORIGIN` entry of `INTENTIONALLY_UNREACHABLE` in `tests/test_switch_reachability.py`.
3. Add a `character-swap-worker` service to `deploy/docker-compose.yml` (the `media` volume read-write, the vendor keys from the
   worker env, no ports).
4. Set the repository variable `NIGHTSHIFT_CHARACTER_STUDIO=on` and deploy. The page and the rail entry appear; nothing is on sale
   for a model whose price is still NULL.

The worker fetches nothing from a job row: it signs short-lived links (at most an hour, the web app's own HMAC, `lib/server/media.ts`)
to the Command Center's `/api/media/file/<id>/original`, which the vendor fetches. `NIGHTSHIFT_CHARACTER_STUDIO_PUBLIC_ORIGIN` is that
public origin; `MEDIA_URL_SECRET` is the same value the web app has.

## Samples

Each gallery card (`character_swap_templates`, seeded with two) has one sample slot per model
(`character_swap_template_samples`). An empty slot reads "Namuna tez orada"; a slot never shows another model's clip. "Sinab ko'rish"
(Try) opens the studio with the card's words; the person brings their own video and pictures.

The plan: the web copy (720p H.264, faststart) lives in the Supabase **public** bucket `character-samples`, served through the CDN; the
original stays in the **private** bucket `character-samples-private` (the row stores its object path, never a link). Making a sample
is a paid call the owner has not approved, so nothing has been made:

```bash
# the plan and the vendor's list price only (no upload, no call):
python tools/character_studio_samples.py --card two-characters --model kling-4.0-omni-edit --video clip.mp4 \
    --image a.png --image b.png --cdn-base https://cdn.example.com/character-samples
# the paid call, once approved for that model:
... --run --approve-paid-call kling-4.0-omni-edit
```

Before the first run: create the two buckets (public and private), point the CDN at the public one, and use only owned inputs (no real
person, or for Seedance the account's own ModelArk output).

## Not in this change (follow-ups)

- **The agent canvas.** 0130 hard-codes its node types; a character-swap node (`video.input`, `character.reference`,
  `consent.check`, `video.character_swap`, …) needs its own migration on `save_agent_workflow_draft`'s latest body. 0130 is not touched.
- Performer verification for Seedance (BytePlus `asset://` ids), person detection to pick targets on a frame, the 480p draft
  preview, splitting clips longer than 30 s, Kling 4.0 Flash.
- The docker-compose service and the deploy variables (release steps above).
- Seedance results have no sound: putting the source's sound back as a separate editor track (never by rewriting the vendor's file).
- Reading a library clip's `ai_label` provenance into a run's AI-disclosure signals (see "Consent and real people").

## Strings that need a native read

`lib/i18n/character-studio/ru.ts` and `uz.ts` are drafts by a non-native writer, marked so at the top of each file.
