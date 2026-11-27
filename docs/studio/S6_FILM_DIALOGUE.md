# S6: scene dialogue becomes character voices and lip-sync (design, 27 Nov 2026)

Atlas's goal (27 Nov): a Film Studio short film where 2–5 characters talk (Russian or Uzbek), their lips match their words, and
every step is priced and quoted before Start. Rule 8 applies: this file is the diagnosis and the plan, and nothing in it is built
yet. Claims about existing code cite `origin/main` as of 27 Nov. The vendor facts were re-read on 2026-11-27 and are docs-only;
§6 lists them.

## Qisqacha (egasi uchun)

- **Bugun qahramonlar filmda gapira olmaydi.**
  - Brain dialog satrlarini sahna tasviri (prompt) ichiga yozib yuboradi; ular hech qayerda saqlanmaydi.
  - Qahramonda ovoz yo‘q.
  - Yig‘ishda klipning o‘z ovozi tushirib qoldiriladi (`-an`).
- **Reja:**
  - har bir qahramonga akkaunt ro‘yxatidan ovoz tanlanadi;
  - har bir sahna dialogi ElevenLabs Text to Dialogue bilan bitta faylga aylanadi;
  - Kling shu sahna klipiga lab-sinxni qo‘yadi;
  - hammasi Start’dan oldin narxlanadi.
- **Cheklov:** Kling bitta vazifada faqat bitta yuzni gapirtiradi. Shuning uchun bitta sahnada bitta gapiruvchi bo‘ladi: suhbat "kadr / qarshi kadr" usulida, sahnama-sahna olinadi.
- **Sinov (probe) xarajati:** taxminan $1.10. Bunga qo‘shimcha ElevenLabs Scale ($299/oy) va Kling paketi kerak; Kling paketining narxi rasmiy sahifada ko‘rinmaydi.

## 0. What main does today (the evidence)

| Fact | Where |
| :-- | :-- |
| The Brain writes `scenes[].dialogue` into the visual prompt as `X says: "…"`. No line is stored. | `command-center/lib/brain/logic.ts:461-472` |
| `film_scenes` has no dialogue column. `films.voice` is the narration voice only (`source`, `model`, `voice_id`). | `0166_films_core.sql:297-326, 758-790` |
| No character has a voice. `characters` (0047) has name, kind and description; `film_refs` holds pictures only. | `0047_style_kits_characters.sql:116-128`, `0166:394-399` |
| `voice_usable_by` guards only cloned voices: it is true for any id not in `voice_profiles`. | `0117_voice_profiles.sql:632` |
| The account's voice list is read only by the web server (`ELEVENLABS_VOICES_KEY`), so the database cannot see it. | `command-center/app/api/creative/voices/route.ts` |
| **A clip's own sound never reaches the master.** Picture segments are encoded with `-an`, and the film's sound tracks are the narration and the music only. | `modules/render_backend.py:768`, `modules/film_timeline.py:470-572` |

The last row is good news for lip-sync: a lip-synced clip is already muted in the cut, as agreed in `S6_GAPS.md` §4. It also
means that today's `clip_audio` speech, where the video model speaks the lines, probably never reaches the film. **S4 is asked to
confirm this.** It is a separate finding, not fixed here.

## 1. Data: migration 0216 (S6, additive)

- **`films.dialogue_model text null` and `films.lipsync_model text null`**, each with the same model-id check as
  `films_models_check` (`0166:263-265`).
  - Text to Dialogue takes one model per call, so the model is per film, not per character.
  - A film is in dialogue mode when any of its scenes has stored lines.
  - `clip_audio` stays as it is today.
- **`film_cast`**: one row per film character.
  - Columns: `film_id`, `org_id`, `key` (`^c[0-9]{1,2}$`, the BRIEF id), `name` (at most 120 characters),
    `character_id uuid null`, `voice_id text null`, `voice_name text` (display only), `position` 0–7.
  - `voice_id` must be `^[A-Za-z0-9]{20}$`, as in `0117:343`.
  - Unique on `(film_id, key)`. Members read it; only the writer below changes it.
- **`film_scenes.dialogue jsonb not null default '{"lines":[],"lipsync":true}'`**, where each line is `{character_key, line}`.
  - At most 6 lines a scene, each at most 300 characters, and at most 2,000 characters a scene, which is Text to Dialogue's
    reliable limit.
  - `lipsync: false` means the speaker is off screen.
- **`save_film_dialogue(p_film, p_version, p_cast, p_dialogue)`**, with the reader `film_dialogue_of(film)`. `save_film`'s pinned
  body is left unchanged. The writer:
  - locks the film and requires an editable film at the stated version;
  - writes the cast and the lines, bumps `films.version` so older quotes go stale, and logs a `film_events` row;
  - refuses `voice_not_found` (via `voice_usable_by(auth.uid(), …, 'use')`) and `character_unknown`.
- **The web route that calls it** (S6, `command-center`) refuses before the RPC:
  - `voice_not_in_account`: the id is not in the account's voice list;
  - `voice_retired`: the retirement table from #924.

  A person picks a voice from that list, never types one.
- **The voice is checked again later**, as for narration:
  - at the quote, with `auth.uid()`;
  - at the take, with `s.created_by` (`0198:365-370`);
  - in the adapter, before the vendor call.

## 2. Take kinds and capabilities

- **New capabilities.** 0216 adds `dialogue` and `lipsync` to:
  - `model_registry_capabilities_check` and `model_probe_runs_capability_check` (latest in `0100:95-107`);
  - `creative_params_problem` and `creative_price` (latest in `0208`).

  They are not added to the API or MCP model lists: both registry entries are `web_only`.
- **New take kinds.** 0216 replaces `film_takes_slot_check` (`0166:452-458`), adding:
  - `dialogue`: scene-level, `shot_index = 0`;
  - `lipsync`: scene-level, `shot_index = 1`. It requires `shot_count = 1`, which the quote enforces.

  This moves the take-kind change from S2 to S6, unlike `S6_GAPS.md` §4. Widening a check is inert until something writes the
  rows, and S4 can build against it early. **S2 must agree.**
- **Worker order** (S2, `modules/film_orchestrator.py:97`):
  `PHASE = {dialogue: 0, keyframe: 1, clip: 2, extend: 2, lipsync: 3, narration: 4}`.
  - Dialogue goes first. It is the cheapest take and the one most likely to be refused (a voice gone, a wrong language, a line
    too long). The existing stop rule then halts the film before any picture is paid for.
  - A lip-sync take needs the scene's completed clip and dialogue (`_inputs_ready`, `:518-542`).

## 3. Money (S2's `film_price`, on top of 0220)

**Units.** Each is unpriced until a probe and an owner-applied price; a missing row reads `unpriced`, as `0171:44-46` does.

| Unit | Charged per | Note |
| :-- | :-- | :-- |
| `model_elevenlabs_dialogue_v3_character` | character | Separate from the TTS unit, so a TTS price never silently prices dialogue. ElevenLabs states no dialogue rate (**unverified**). |
| `model_kling_lipsync_second` | second | |
| `model_kling_face_check_call` | call | added once a job |

**The dialogue line.** One per scene with lines.

- Quantity: the characters of that scene's lines, known exactly at the quote (audio tags count).
- Price: `film_try_price(org, 'dialogue', …)`. The narration rule applies: round up, with at least one minimum per call
  (`0171:810-817`).

**The lip-sync line.** One per scene with `lipsync: true`.

- Quantity: the clip line's priced `duration_s`, rounded **up** to whole 5 s blocks, plus one face check. Kling does not say how a
  partial block is billed, so we read it conservatively.
- The planned length is used, never a measured one, because nothing is measured at the quote.
- It is charged in full, like a clip, when the output is a live video of at least 90% of `duration_s` (`0171:1680-1694`).

**Named refusals.** Each one leaves the line, the total and the quote id NULL (rule 4):

- **Dialogue:**
  - `dialogue_model_not_set`
  - `model_not_available` / `model_not_offered`
  - `voice_language_unsupported` / `voice_language_unknown` (0214)
  - `character_voice_not_set` (names the character and the scene)
  - `character_unknown`
  - `voice_not_found`
  - `dialogue_too_long` (over 2,000 characters a scene)
  - `dialogue_too_many_voices` (over 10)
- **Lip-sync:**
  - `lipsync_model_not_set`
  - `lipsync_model_not_available`
  - `lipsync_scene_too_long` (over 60 s)
  - `lipsync_scene_too_short` (under 2 s)
  - `lipsync_multi_shot`
  - `lipsync_one_speaker` (a scene's lines name more than one character)
  - `clip_audio_not_switchable` (the clip model cannot be made silent)
  - `lipsync_continuity_unmeasured` (the next scene continues from this clip's last frame, until probe L4)
  - `likeness_acknowledgement_required` (a cast member from an uploaded photo, the 0174/0187 gate)

`film_precheck` gets the cheap ones, so `start_film` refuses before its rate step, as 0220 does for narration.

**At the take** (S2's `film_take_job`, `0198:241`):

- **Preparing the dialogue file:**
  - pad it with silence to the scene's planned length, so its clock is the scene's clock (this also meets Kling's 2 s minimum);
  - send it as mp3, because 30 s of 44.1 kHz stereo WAV is about 5.3 MB, over Kling's 5 MB cap.
- **Failures, each charged 0:**
  - `partial_not_delivered`: the timings do not cover every line;
  - `dialogue_overruns_scene`: the speech is longer than the scene;
  - `lipsync_no_face` or `lipsync_face_ambiguous`: the face check found no face, or more than one. No face is ever guessed.
- **Settling** follows 0171's rules unchanged: one automatic retry within the line, and the vendor's spend on a failure is the
  platform's.
  - A dialogue take that fails for good stops the segment before any clip is paid for.
  - A lip-sync that fails for good after the clips leaves the film `paused`, charged for what was delivered.

## 4. Order of work, and who does what

1. **S6, 0216** (draft PR `claude/nsai-s6-dialogue-db`): the capabilities and their params and price shapes, the slot check,
   `film_cast`, `film_scenes.dialogue`, `films.dialogue_model` and `films.lipsync_model`, `save_film_dialogue` and
   `film_dialogue_of`. It needs #915 (0214). It seeds no price and puts nothing on sale.
2. **S6, code:**
   - the dialogue adapter (`claude/nsai-s6-tts-films`) and the Kling adapter (#928);
   - `modules/film_dialogue.py`: lines to Text to Dialogue inputs, `voice_segments` to the provenance in `S6_GAPS.md` §4, the
     padding plan, and the Kling timing fields;
   - the voice-picker route.
3. **S2, a migration after 0220:**
   - `film_price` and `film_precheck` get the two lines and the refusals above;
   - `start_film` and resume plan the new kinds (`0215:731, 1581, 1601`);
   - `film_take_job` and `film_take_inputs` get the dialogue and lip-sync branches;
   - `film_take_succeeded` and `film_take_failed` get the new kinds (`0171:1669`; resume maps `0215:1043, 1071`).
4. **S2, worker:** PHASE, OUTPUT_KIND, `_inputs_ready`, and a dialogue and a lip-sync `_make` branch.
5. **S4, assembly:**
   - `_chosen_shots` prefers a scene's completed lip-sync take over its clip;
   - one premixed dialogue stem (measure the 60-input audio premix first, rule 8);
   - `dialogue_mismatch`, `dialogue_missing` and `dialogue_outside_scene`.
6. **S1, Brain:**
   - proposes cast voices only from the account's list;
   - writes lines through `save_film_dialogue` and stops putting them in the prompt in dialogue mode;
   - plans one speaking face per scene with `shot_count` 1;
   - proposes only a dialogue model whose `languages` list the film's language.
7. **The MiniMax adapter's owner:** it learns `generate_audio: false`. Today `modules/capabilities/minimax.py:20-23` sends no
   audio flag and refuses one.
8. **The owner:**
   - buys ElevenLabs Scale and a Kling package, and stores the keys;
   - approves the probes, and listens to the uz/ru results.

   Then the migration that puts the two models on sale and seeds their prices lands, with Kling's written consent for customer
   use.

**Probes** (paid; the owner's decision; vendor usage only):

| # | What it proves | Cost (USD) |
| :-- | :-- | :-- |
| D1 | Text to Dialogue v3/v4, three scenes (uz, ru, en), 2 voices, about 1,000 characters: `voice_segments` cover every line | about $0.08 |
| D2 | How dialogue is billed (subscription usage before and after D1) | $0 |
| L1–L3 | Kling lip-sync on one 6 s clip with uz, ru and en audio | about $0.44 |
| L4 | Last-frame difference and output length of a lip-synced clip compared with its source | $0 (reuses L1) |
| L5 | A two-face clip: what `face_data` returns, and choosing the speaker by `face_id` | about $0.15 |
| L6 | A 30 s scene: how a partial 5 s block is billed | about $0.43 |
| H1 | H3 with `generate_audio: false` is silent | one H3 clip |

That is about **$1.10** of vendor usage, before anything is sold. Uzbek and Russian quality is the owner's listening verdict,
never a number we infer.

## 5. Risks

- **One face per Kling task.** v1 allows one speaker per lip-synced scene and refuses `lipsync_one_speaker` at the quote.
  - The Brain plans a conversation as shot / reverse shot.
  - A two-shot with two speakers would need two chained tasks on one video, which is unverified and not offered.
  - sync.so can target several speakers in one clip (`segments`), but it costs 3–9 times more a second and its terms forbid
    competing use (§6). It would be a separate choice a person makes, never a fallback.
- **Uzbek and Russian lip-sync quality is unmeasured.** The models stay unconfirmed until L1–L2 and the owner's listening test.
- **The 32 sound-clip limit** (`film_timeline.py:142`) holds only with one premixed dialogue stem.
- **Clip models that speak.**
  - Kling's output keeps the clip's original audio unless `original_audio_volume = 0`.
  - H3 told to speak moves the mouth to other words.
  - So in dialogue mode the lines leave the prompt and the clip must be silent, and a model that cannot be made silent is
    refused.
- **Continuity.** A lip-synced clip's last frame may differ from its source. The quote refuses a continued scene until L4
  measures it.
- **Default voices end on 2026-12-31** (#924). The quote and the take read the retirement table.

## 6. Vendor re-check, 27 Nov (docs-only; sources as in S6_GAPS §1 unless named)

- **Kling, one face per task.** Still one person per task: "Currently only supports one person lip-sync". Since 09/15/2025 a clip
  may show several people, and `face_id` picks the speaker (https://kling.ai/document-api/updates/api.md).
- **Kling price.** Unchanged:

  | Item | Price |
  | :-- | :-- |
  | Lip Sync | 0.5 Units ($0.07) /5s |
  | Face Recognition | 0.05 Units ($0.007) /call |

  - The lip-sync price is in the 720p column, and **the 1080p price is unverified**.
  - The avatar's $0.056/s and $0.112/s are its 720p and 1080p prices.
  - How a partial block is billed is not stated.
  - The output reports `final_unit_deduction`; record it as the charge actually made.
- **Kling callbacks** (https://kling.ai/document-api/api/get-started/callbacks.md):
  - a JSON POST on every status change, in a new or a legacy payload;
  - signed with HMAC-SHA256 under the Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`), with a
    5-minute timestamp window;
  - the retry policy is not stated, so polling stays the source of truth.
- **Kling package.** Its name and price are **still unverified**; the owner reads them in the Kling developer console.
- **Kling terms** (paid service, effective 2026-04-21):
  - §3.3, §8.2.3 and §10.3: providing the service to others needs Kling's written consent;
  - §3.5: competing derivative products are forbidden;
  - §6.4: commercial use of the output is not restricted.
- **sync.so.**
  - Several speakers in one clip are supported through `segments[]`, each with its own audio and its own target face.
  - Prices: lipsync-2 is $0.05/s on Creator ($19/month) and $0.04/s on Scale ($249/month); lipsync-2-pro is $0.083/s and
    $0.067/s; sync-3 is $0.133/s and $0.107/s.
  - Terms (June 2024): "competes with Sync Labs" and a not-a-competitor warranty, so written confirmation is needed.
- **HeyGen.** Multi-speaker lip-sync is not documented, its prices did not render, and its terms forbid authorizing third parties
  and competing products. **Hedra**: unverified.
- **Cost of a 10 s, two-speaker scene:**

  | Option | Cost |
  | :-- | :-- |
  | Kling, two 5 s shots | $0.154 |
  | sync.so lipsync-2, segments | $0.40–0.50 |

## 7. Music with vocals (scout only, for Atlas and the owner)

- **ElevenLabs Music** (`music_v2_5`).
  - **What it does:**
    - vocals and lyrics;
    - 3 s to 5 min according to the docs (the marketing page says 10 min, so this needs a probe);
    - $0.150 a minute, on paid plans only.
  - **Languages:** Russian and Uzbek are **not named**.
  - **Terms:**
    - Exhibit 3 §1 still forbids making the Music API available to third parties "Unless you are an Authorized Reseller", which
      takes ElevenLabs' prior written authorization; no application process is published.
    - A carve-out says that only generating and distributing Output through our own product does not make us a Reseller.
    - The media rights exclude "film, TV, radio" on every plan below Enterprise Music, and "film" is not defined.
    - Scale is limited to companies of fewer than 10 employees.
  - **Verdict:** not for customers without ElevenLabs' written answer.
- **Google Lyria 3.5** (Gemini API, paid tier).
  - **What it does:** vocals and timed lyrics, in "the language of your prompt" (ru/uz not listed). $0.08 a song; Lyria 3 Clip is
    $0.04 for 30 s.
  - **Conditions:**
    - only in available regions: Uzbekistan yes, **Russia no**;
    - 18+ only;
    - a SynthID watermark;
    - no competing models.
  - **Verdict:** the only option that could be offered to customers today, within those limits and after a probe.
- **Not available:**
  - MiniMax Music: closed to new users since 2026-08-20;
  - Suno: no official API;
  - Stable Audio: no intelligible vocals.
