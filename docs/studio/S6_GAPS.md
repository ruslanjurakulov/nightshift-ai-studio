# S6 — Voice & lip-sync: what the vendors say, what our code lacks (22 Nov 2026)

Stream S6 of `docs/studio/PROGRAM.md`. Rule 8 says to diagnose before fixing, so this file comes first: the evidence, then the gaps,
then the plan. No paid call was made, no key was used and nobody signed up for anything. Every vendor fact below is **docs-only**
until a real call through our adapter has succeeded (CLAUDE.md, Definition of Done). Where an official page could not be read,
the fact is marked **unverified**.

Earlier research that this file builds on and does not repeat: `docs/research/ELEVENLABS_STUDIO.md` (read 2026-11-14),
`docs/research/minimax-h3-first-party.md`, and the Kling entries in `schemas/model_registry.json`.

## Qisqacha (egasi uchun)

- **Ovoz (ElevenLabs).** Mijozga sotish uchun **Scale** tarifi kerak: oyiga **$299** (oylik to‘lov, elevenlabs.io/pricing/api,
  2026-11-22). Free, Starter, Creator va Pro tariflarida xizmatni mijozlarga berish taqiqlangan (OEM §2.B(f)). O‘zbek tili faqat
  Eleven v4 va v3 da bor. Default ovozlar **2026-12-31** da o‘chadi, ya’ni 39 kun qoldi.
- **Lab-sinx (Kling).** Kling’da ikki bosqichli lip-sync bor: avval yuzni topish, keyin ovozni yuzga moslash. Bitta vazifada
  faqat bitta yuz; video 2–60 s; audio ≤ 5 MB. Narxi: 5 soniya uchun 0.5 Unit ($0.07), yuzni topish $0.007. Kling’ning o‘z TTS’i
  faqat `zh` va `en` tillarini biladi, shuning uchun o‘zbek va rus ovozi ElevenLabs’dan fayl bo‘lib beriladi.
- **Kling paketi.** Qaysi paketni olish kerakligi (nomi, narxi, muddati) rasmiy sahifada o‘qib bo‘lmadi (sahifa bo‘sh ochiladi).
  Kling Developer kabinetida **video resource package** ko‘rinadi. Uni sotib olishdan oldin adapter tayyorligini Atlas aytadi.
- **MiniMax H3 ovozi** ikki qahramonli o‘zbekcha film uchun yetarli emas: til, ovoz barqarorligi va lab harakati tasdiqlanmagan.
- Mijozlarga Kling (yoki sync.so) orqali lab-sinx sotish uchun vendordan **yozma ruxsat** kerak.

---

## 1. Vendor facts (Scout, read 2026-11-22)

### 1.1 ElevenLabs: re-check of what may have changed since 14 Nov

| Fact | Official statement | Source |
| :-- | :-- | :-- |
| Scale price | "$299 per month" (monthly billing). Annual billing works out to $249.17 a month. Pro "$99 per month"; Business "$990 per month". | https://elevenlabs.io/pricing/api, https://elevenlabs.io/pricing |
| Scale allowance | The /pricing card says "1.8M credits per month". The /pricing/api table gives 3,738,000 characters of v4/v3/Multilingual v2. **Which allowance governs API use is unverified**: the two pages disagree. | same |
| Overage example | "TTS (v4) $0.08 per 1K characters" | https://elevenlabs.io/pricing/api |
| Resale floor | Unchanged, OEM terms "Last Updated: 28 February 2025". §2.B(f): Free/Starter/Creator/Pro "expressly prohibited from Making Available". §1.D: a Business Entity is on "a Scale, Business, Enterprise, or equivalent plan". | https://elevenlabs.io/oem-terms |
| Default voices | "All our Default voices will expire on December 31, 2026, and they will no longer be accessible after this date." | https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices |
| Uzbek | `eleven_v4`'s "90+ languages" include "Uzbek (uz)". v3 is "previous generation", not deprecated. Newly deprecated: `eleven_turbo_v2_5`, `eleven_turbo_v2`, `eleven_text_to_sound_v2`, `scribe_v1`, `music_v1`. | https://elevenlabs.io/docs/overview/models |
| Text to Dialogue | `POST /v1/text-to-dialogue/with-timestamps`, default `eleven_v3`. Returns `voice_segments` (start/end seconds per voice) and `alignment`. Only the models page ties it to v4/v3; the API reference does not list the models. | https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps |

### 1.2 Kling: lip-sync, avatar and TTS

- **Base URL and auth.** The base URL is `https://api-singapore.klingai.com`. Auth is `Authorization: Bearer <API Key>`.
- **Registry correction.** The access-key/secret JWT is "only applicable to legacy version design standards", so the registry's
  "JWT or API key" wording should say API key
  ([authentication](https://kling.ai/document-api/api/get-started/authentication.md)). `modules/capabilities/character_swap.py`
  already refuses `<access>:<secret>`.

| Step | Official statement | Source |
| :-- | :-- | :-- |
| 1. Find the faces | `POST /v1/videos/identify-face` with exactly one of `video_id` (a Kling video from the last 30 days, ≤ 60 s) or `video_url` (.mp4/.mov, ≤ 100 MB, 2–60 s, 720p/1080p, each side 512–2160 px). Returns `session_id` and `face_data[]` (`face_id`, `start_time`/`end_time` in ms). **This call is billed.** How long a session stays valid: **not stated**. | https://kling.ai/document-api/api/video/lip-sync/face-detection.md |
| 2. Lip-sync | `POST /v1/videos/advanced-lip-sync` with `session_id` and `face_choose[]`. The page says it "currently only supports one person lip-sync". | https://kling.ai/document-api/api/video/lip-sync.md |
| Audio input | per face, exactly one of `audio_id` (Kling TTS) or `sound_file` (base64 or URL; mp3/wav/m4a/aac; ≤ 5 MB; 2–60 s) | same |
| Required timing | `sound_start_time`, `sound_end_time`, `sound_insert_time` (ms). The crop must be ≥ 2 s and overlap the face's interval by ≥ 2 s. | same |
| Optional fields | `sound_volume` and `original_audio_volume` (0–2), `watermark_info`, `external_task_id`, `callback_url` | same |
| Query and statuses | `GET /v1/videos/advanced-lip-sync/{task_id}`. Statuses: `submitted`, `processing`, `succeed`, `failed` (reason in `task_status_msg`). | same |
| Output | `task_result.videos[]` with `url`, `watermark_url` and `duration`, plus `final_unit_deduction` | same |
| Retention | "deleted after 30 days": copy the result into our storage immediately | same |
| Avatar (photo + audio → talking video) | `POST /v1/videos/avatar/image2video`. Image ≥ 300 px; audio mp3/wav/m4a/aac, ≤ 5 MB, **2–300 s**; `prompt` ≤ 2,500 chars; `mode` std/pro | https://kling.ai/document-api/api/video/avatar.md |
| Kling TTS | `POST /v1/audio/tts`, `voice_language` "Allowed values are `zh` and `en`". **No uz, no ru.** | https://kling.ai/document-api/api/video/avatar/text-to-speech.md |
| Price | Lip Sync "0.5 Units ($0.07) /5s". Face Recognition "0.05 Units ($0.007) /call". Avatar "0.4 Units ($0.056) /s" and "0.8 Units ($0.112) /s": which of these is std and which is pro is **unverified**. | https://kling.ai/document-api/pricing/base/video.md |
| Package to buy | **unverified**: kling.ai/dev/pricing renders only a title to a fetcher. The billing API names the package types `video`, `image` and `try-on`. That lip-sync draws on the video package is a lead, not a fact. | https://kling.ai/document-api/api/assets/billing-deduction/package.md |
| Concurrency | counted per account, model version and package type. Over the limit the API answers `1303`. No numbers are published. | https://kling.ai/document-api/api/get-started/concurrency-rules.md |
| Callback schema | not read: **unverified** | https://kling.ai/document-api/api/get-started/callbacks.md |

**Terms** ([paid service](https://kling.ai/document-api/guides/protocols/paid-service.md), effective 2026-04-21, the version the
registry already cites):

- §3.3: the licence is "non-exclusive, non-transferable or sublicensable".
- §8.2.3: we may not "sell, transfer, license or transfer any one or more API Services".
- Output: "commercial purposes is not restricted".
- No letter-of-authorization clause appears in this text. The letter the owner signs is Kling's own onboarding step.
- Using lip-sync on the owner's own channels is fine. Offering it to Studio customers needs Kling's written confirmation. That is
  the same `web_only` / terms gate as the other Kling entries.

### 1.3 The alternative: sync.so (Sync Labs)

- **Create call.** `POST https://api.sync.so/v2/generate` with header `x-api-key`. Models: `lipsync-2`, `lipsync-2-pro`,
  `sync-3` and others.
- **Inputs.** A video URL plus an audio URL, or a text script with an ElevenLabs voice.
- **Async.** An `Idempotency-Key` header is accepted. Statuses: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `REJECTED`.
  Webhooks are HMAC-signed `Sync-Signature` (https://sync.so/docs/api-reference/api/generate-api/create.md).
- **Length limits per plan.** Free 15 s, Hobbyist 1 min, Scale 30 min.
- **Plans** (https://sync.so/pricing):

  | Plan | Price | Note |
  | :-- | :-- | :-- |
  | Hobbyist | $5/month | output is watermarked |
  | Creator | $19/month | |
  | Growth | $49/month | |
  | Scale | $249/month | |

- **Usage price.** lipsync-2 costs $0.05/s on Creator and $0.04/s on Scale. Output retention is **not stated**.
- **Terms** ("Last updated: June 6th, 2024"):
  - The licence is "non-sublicensable".
  - Use "in any manner that competes with Sync Labs" is forbidden, and the customer must warrant it is not a competitor.
  - Sync may use User Content to improve the service.
- **Verdict:** a lip-sync feature in our Studio may read as competing. Written confirmation is needed before customer use.
- Hedra: prices and API fields **unverified**. HeyGen and Tavus were not checked.

Why Kling first: its single-face limit fits a film's one-speaker shot, it is a vendor we already integrate, and the owner already
approved its package. sync.so is the second provider. Under rule 4 that would be a separate choice a person makes, never a
fallback.

### 1.4 MiniMax H3 speech inside the clip (`clip_audio`)

**Documented:**

- **Audio flag.** Audio is generated by default, and `generate_audio: false` gives a silent clip
  (https://platform.minimax.io/docs/guides/video-generation.md). This **corrects**
  `docs/research/minimax-h3-first-party.md`, which says no audio flag exists.
- **Reference audio.** Reference-to-video takes up to 3 `reference_audio` clips, 2–15 s each and ≤ 15 s in total.
  "Voice timbre follows reference audio 1"
  (https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md).

**Not documented on any official page:**

- that the lines in the prompt are spoken word for word;
- which languages it speaks (the "11 languages, no Uzbek" list comes only from mirrors);
- that lips move with the words;
- that a voice stays the same across clips;
- that two characters keep two voices.

**Verdict:** `clip_audio` may stay what the contract already calls it, "voice is generated by the video model", unmeasured, and
only for en/ru until a probe the owner listens to says otherwise. It is **not enough** for a two-character film that must keep
each voice or speak Uzbek. The documented path for that is ElevenLabs (v4, `uz`) for the lines, then lip-sync onto a silent or
muted clip.

---

## 2. What our code already does (read 2026-11-22, `main` at 7ef5b38)

| Piece | State |
| :-- | :-- |
| Language gate for channel runs | **Done** (#781). `modules/tts_languages.py`, with its twin `command-center/lib/ttsLanguages.ts`. `audio_mixer.verify_voice()` refuses Uzbek on Multilingual v2 and Flash before any spend. |
| ElevenLabs error codes | **Done** (#781). Errors are keyed on `detail.code`: 401 is a bad key, 402 is out of credit. |
| Expiring-voice audit | **Done, read-only** (#781): `tools/audit_voices.py` lists the Default and Legacy voices in use. |
| Film narration on the film's clock | **Done** (S2's #853). `film_orchestrator._narration`: one TTS call per scene, each at `scene_start + NARRATION_LEAD_S`, refused if it overruns its scene. Provenance carries `segments` and the measured loudness, as `NIGHTSHIFT_AI.md` "What S6's takes must carry" requires. |
| Film language reaches the TTS job | **Done** (0198): the narration job's params carry `language`. The ElevenLabs adapter refuses a model that cannot speak it **at submit**. |
| TTS registry entries | `elevenlabs-v4`, `-v3`, `-multilingual-v2` and `-flash-v2.5` exist. All are `plan_required:scale`, `web_only`, and none has been probed, so none is available. |

## 3. Gaps, with evidence

| # | Gap | Evidence | Rule | Fix (PR) |
| :-- | :-- | :-- | :-- | :-- |
| G1 | **A film is quoted and its credits held before anyone checks that its voice model speaks the film's language.** An Uzbek film with Multilingual v2 gets a price and a hold, and fails only at the narration take, after the clips were paid. | `0171_films_money.sql` `quote_film` (narration line, around line 796): it checks model, capability and price, never `f.language`. `modules/capabilities/audio.py:171-173` says "the SQL-side refusal before the hold is a follow-up". | 4, 6 | `claude/nsai-s6-language-gate`: TTS registry entries carry `languages`, and the validator allows it for `tts`. Migration **0214** adds `public.voice_language_problem(model, language)`, read from `model_registry.spec`. **S2 calls it in `quote_film`**, because the money functions are S2's. |
| G2 | **The Brain cannot tell which voice model speaks Uzbek.** `sellable_models()` returns `spec.languages`, but TTS entries have none. The registry validator even forbids `languages` outside dub and captions. | `modules/model_registry.py:501`; the four TTS entries have no `languages` | 4 | same PR. S1 reads `languages` and proposes only a model that lists the film's language. |
| G3 | **Default voices stop on 2026-12-31 and nothing in a run warns before that.** On 1 January a channel's run will die at preflight with a vendor 404 rather than our remedy. The Create page still offers the 13 expiring ids (`lib/voices.json`). A Legacy id is re-routed silently today, but the help page gives names only, so a Legacy *id* cannot be recognised. | `tools/audit_voices.py` only prints. `verify_voice` reads no retirement table. | 4, 6 | `claude/nsai-s6-voice-retirement`: one table (`modules/voice_retirement.py`). Preflight and the TTS adapter refuse a Default id from its expiry date, naming ElevenLabs' suggested replacement **only if that voice is in the account's own list**, never typed and never swapped in automatically. Until then a run logs the days left. The Create page stops offering expired ids. |
| G4 | **The narration request does not send `language_code`.** v3/v4 accept it to enforce the language and its text normalisation; Multilingual v2 does not. | `audio.py` ElevenLabsTTSAdapter sends `text` and `model_id` only | 4 | `claude/nsai-s6-tts-films`: send `language_code` when the job names a language and the model takes it. Pinned by a test with a fake HTTP layer. |
| G5 | **No voice for a character's dialogue.** A short film's lines exist only as `clip_audio`, which is unverified (§1.4). There is no adapter for ElevenLabs Text to Dialogue (with timestamps) and no per-character voice track. | no `text-to-dialogue` in `modules/` | 4, 5 | `claude/nsai-s6-tts-films`: a dialogue adapter behind its own registry entry, unconfirmed. The track contract (§4) goes to S4. |
| G6 | **No lip-sync anywhere.** There is no capability, adapter, registry entry or take kind. | grep for `lipsync` and `lip_sync`: no hits | DoD | `claude/nsai-s6-lipsync`: capability `lipsync`, registry-only until migration 0214 teaches `model_registry` the capability. The Kling adapter (two steps, one face, limits above) uses fakes only. The entry stays unconfirmed and unpriced. A `lipsync` take kind is S2's (0166's check). |
| G7 | **The MiniMax research note is out of date** about the audio flag. | §1.4 | 5 | One line in the same PR as G5. The H3 adapter's "refuse a job that names an audio flag" rule is S2/S1's to revisit; we flag it, we do not edit it. |
| G8 | The registry says Kling uses "JWT or API key". | §1.2 | 5 | The `lipsync` PR's entry says API key. The old entries' notes are left to their owner. |

Not gaps:

- The 60 s minimum film length (`NIGHTSHIFT_AI.md` "Open question to S6/Atlas") is a money limit (`film_limits`). S6 does not change
  it and leaves the question with Atlas and S2.
- The voices a customer may see are already scoped by 0117's `voice_usable_by`.

## 4. The track contract S6 proposes to S4 (and S2)

What S4 already consumes stays unchanged: the narration file, one per film, with `segments` on the film's clock (§2).

**Dialogue (new, only when a film has `dialogue` and its voice mode is not `clip_audio`).** One audio file per scene that has
lines. Each file is registered with this provenance:

```json
{"film_take_id": "<take>", "scene_id": "<scene>", "kind": "dialogue",
 "lines": [{"character_id": "c1", "voice_id": "<20 alnum>", "start_s": 0.4, "end_s": 2.9}],
 "model": "eleven_v4", "language": "uz", "loudness_lufs": null, "true_peak_db": null}
```

- Times are in the file's own clock, which starts at the scene's start. They come from Text to Dialogue's `voice_segments`.
- Loudness that was not measured stays `null`.
- No `words`, because of the 16 KB provenance cap (Lens L4).

**Lip-synced clip.** This is a **replacement result for a clip take, not a new track**:

- the same aspect and seconds as the clip it was made from;
- `first_frame` and last frame continuity re-measured on the new file;
- the dialogue audio burned into the clip.

It carries `{"lipsync_of_asset_id": "<clip>", "dialogue_asset_id": "<dialogue>", "face_id": "...", "model": "kling-lipsync"}`.

When the master is assembled from lip-synced clips, the assembly keeps the clip's own audio for those scenes and does not lay the
dialogue file on top a second time. Whether that is a new `film_timeline` rule or a flag on the take is **S4's decision**. S6 asks,
it does not edit assembly.

A refusal S4 should add: `dialogue_missing`, the same rule as `narration_missing`.

## 5. Plan (draft PRs, in this order)

1. `claude/nsai-s6-gaps`: this file.
2. `claude/nsai-s6-language-gate`: G1 and G2, plus migration 0214 (helper function only, additive, not applied by us). The message
   to S2 carries the one-line call for `quote_film`.
3. `claude/nsai-s6-voice-retirement`: G3. It must land before 2026-12-31.
4. `claude/nsai-s6-tts-films`: G4, G5 and G7 (dialogue adapter, unconfirmed).
5. `claude/nsai-s6-lipsync`: G6 and G8 (Kling adapter, registry-only, unconfirmed). If 0214 has not merged by then, it adds the
   `lipsync` capability to it.

Every PR uses fakes only. Nothing here makes a model available: that happens only after the owner buys the plan, the key is
stored as a GitHub Actions secret, and `tools/probe_models.py` records a real successful call.

## 6. What the owner must buy (when Atlas says the adapter is ready)

| Vendor | Plan / package | Price as the official page states (read 2026-11-22) | Why |
| :-- | :-- | :-- | :-- |
| ElevenLabs | **Scale** | "$299 per month" (monthly billing) — https://elevenlabs.io/pricing/api | OEM §2.B(f) and §1.D: Scale is the lowest plan that may be offered to customers |
| Kling | a **video resource package** with lip-sync | usage: lip-sync "0.5 Units ($0.07) /5s", face recognition "$0.007 /call" (https://kling.ai/document-api/pricing/base/video.md). **The package's name, price and validity are unverified**: the official package page does not render to a fetcher. The owner reads it in the Kling developer console before paying. | Kling bills from packages. Customer use needs Kling's written OK (§3.3, §8.2.3). |
| sync.so | nothing now | — | second provider, only if Kling's quality on Uzbek speech fails the owner's listening test |

Still open; each needs a page that renders or a paid probe, and a probe is the owner's call:

- the Kling package name and price;
- the Kling callback schema;
- lip-sync quality on Uzbek and Russian audio;
- which ElevenLabs Scale allowance governs the API;
- every H3 speech claim.
