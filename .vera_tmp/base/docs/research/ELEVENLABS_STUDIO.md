# ElevenLabs in Nightshift Studio: where it fits, multi-character voices, pricing, terms

Status: research only, 2026-11-14 (Scout). No product code is changed and no paid call was made. No
ElevenLabs endpoint was called with a key. Every figure below carries its source (§12) and the date it
was read, or the word **unverified**. "Available" means only this: a real call through our adapter has
succeeded. No ElevenLabs model has passed that test yet in this repository (every registry entry says
`"confirmed": false`, and every one is gated `plan_required:scale`). Each one is **not verified** until
it does.

---

## Qisqacha xulosa (egasi uchun)

**Asosiy javob.** ElevenLabs Studio'da **ovoz** uchun qoladi: hikoya (narration), 2–3 qahramonli
dialog, o'zbek/rus/ingliz tillaridagi ovoz va o'zbekcha subtitrlar uchun Scribe. Musiqa, agentlar
(Conversational AI) va jonli (real-time) funksiyalar uchun **ishlatmaymiz**.

**Eng muhim 6 ta fakt (rasmiy sahifalardan o'qildi, 2026-11-14):**

1. **Bizning standart model o'zbek tilini bilmaydi.** Hozir standart model `eleven_multilingual_v2`
   (`config.py:338`). Uning ro'yxatida o'zbek tili **yo'q**, Flash v2.5'da ham yo'q. O'zbek tili faqat
   **Eleven v3** va **Eleven v4** modellarida bor [E1]. O'zbekcha kanal hozir "jimgina yomonroq" ovoz
   olishi mumkin (4-qoida). Birinchi kichik PR shuni to'xtatishi kerak.
2. **Ovozlarimizning ko'pi 2026-yil 31-dekabrda o'chadi.** `lib/voices.json`dagi 16 ovozdan 13 tasi
   ElevenLabs'ning "Default" ovozlari, ular **31.12.2026** dan keyin ishlamaydi [E20]. Yana 2 tasi
   (Rachel, Charlotte) allaqachon "Legacy": API ularni boshqa ovozga yo'naltiradi [E21]. Bu 47 kun
   qoldi. 2026-yil martidan keyin ochilgan yangi akkauntda Default ovozlar umuman ko'rinmaydi.
3. **Mijozlarga sotish uchun kamida Scale tarifi kerak.** OEM shartlari: Free, Starter,
   Creator yoki Pro tarifida xizmatni mijozlarga berish "aniq taqiqlangan" [E30 §2.B(f)].
   Reestrdagi `plan_required:scale` **to'g'ri**. Hozirgi akkaunt esa **Free** (`docs/CUSTOM_VOICE.md`).
4. **API'ni boshqalarga qayta sotib bo'lmaydi.** Mijozimiz ElevenLabs'ni o'z mijoziga bera olmaydi
   [E30 §2.B(a)]. Shuning uchun hamma ElevenLabs modellari `web_only` qoladi (bizning API'da yo'q).
   Musiqa API'ni uchinchi shaxsga berish ham taqiqlangan [E32 Exhibit 3 §1].
5. **Saytda "Powered by ElevenLabs" deb yozolmaymiz.** OEM shartlari, ElevenLabs bilan ishimiz haqida
   har qanday ommaviy bayonot uchun ElevenLabs'ning oldindan yozma roziligini talab qiladi
   [E30 §2.B(d)].
6. **Narx.** v4 va v3 1 000 belgi uchun, v4 Turbo va Flash undan arzonroq, Scribe soatiga, Dubbing v2
   daqiqasiga narxlanadi [E10] (raqamlar sotuvchining narx sahifasida; bizdagi narx DB narx
   jadvali / model reestrida, matnda emas). API dollar bilan hisoblanadi, har tarifda bir xil narx.
   10 daqiqalik hikoya taxminan 9–10 ming belgi: bizda **216–240 kredit**.

**2–3 qahramon bitta loyihada.** Ikki yo'l bor: **Text to Dialogue** (bitta so'rovda 10 tagacha ovoz,
v3/v4, satrlar vaqti bilan qaytadi) yoki **har bir satr alohida TTS**. Tavsiya: bitta sahna dialogini
Text to Dialogue bilan, bir necha "dubl" bilan, va hikoyani oddiy TTS bilan qilamiz. Canvas'da:
**Character** tuguni ovozni o'zida saqlaydi, **Dialogue** tuguni esa satrlarni qahramonlarga bog'laydi.

**Sizdan kerak bo'lgan qarorlar (§11):** (1) Scale tarifiga o'tish va qachon; (2) o'zbekcha kanallar
uchun standart modelni v4 yoki v3 qilish; (3) Default ovozlar o'rniga qaysi ovozlarni qo'yish;
(4) ma'lumotlardan o'qitishga (training) "yo'q" deyish (Data use toggle); (5) mijozlar uchun foydalanish
shartlari (End User Agreement) matni, ElevenLabs talablari bilan; (6) saytda ElevenLabs nomini ishlatish
uchun ruxsat so'rash yoki so'ramaslik.

---

## 1. What the repository already does (read 2026-11-14)

| Where | What it does today | What this research changes about it |
| :-- | :-- | :-- |
| `modules/audio_mixer.py` `verify_voice()` | Before a run spends: key present, narrator voice exists (`GET /v1/voices/{id}`), a secondary voice is chosen and is 20 alphanumerics, characters left (`GET /v1/user/subscription`). Raises `VoiceUnavailable`, never falls back (rule 4). | It does not check that **the model speaks the channel's language**. With `SCRIPT_LANGUAGE=Uzbek` and the default `eleven_multilingual_v2`, the run proceeds with a model whose language list has no `uz` [E1]. This is the silent-quality gap rule 4 forbids (§4.3). |
| `audio_mixer._tts_elevenlabs` | `text_to_speech.convert` per segment; stability 0.5 on v3, 0.45 elsewhere; `similarity_boost` 0.82; no `previous_text`/`next_text`, no `seed`, no `language_code`, no timestamps. | Request stitching, seed and `language_code` exist [E3]; with-timestamps returns character alignment that makes captions for our own narration free (§6.5). Stitching is **not** available on `eleven_v3` [E4]. |
| `audio_mixer._tts_refusal` / `_verify_voice_exists` | Quotes ElevenLabs' `detail.code`/`status`; the 401 copy says "'invalid_api_key' means the key is wrong; 'quota_exceeded' means the account is out of characters". | The current error reference no longer lists `quota_exceeded`: out-of-credits is **402 `insufficient_credits`** (`payment_required`), a bad key is **401 `invalid_api_key`** (`authentication_error`) [E5]. The remedy text should name both, keyed on `detail.code` (§6.9). |
| `config.py:320` | Default narrator voice `pNInz6obpgDQGcFmaJgB` ("Adam"). | Adam is **not** in the Default-voice expiry table [E20]; its status is **unverified** from the pages read. |
| `command-center/lib/voices.json` | 16 premade voices offered on the Create page, with preview clips. | 13 of them are Default voices that **expire 2026-12-31** [E20]; Rachel and Charlotte are Legacy and are re-routed by the API to other voices (Janet, Helen) [E21]. A list that silently re-routes is a rule-4 problem (§8.2). |
| `command-center/components/create/CreateStudio.tsx:563-581` | The Create page offers the premade list **plus a free-text "Custom voice id"** box, checked only for 20 alphanumerics. | Conflicts with the known ceiling "pick from the account's list, never type one". The channel editor (`VoiceEditor.tsx`) already does it right: it lists the account's voices. Studio uses only the list (§8.2). |
| `command-center/lib/ttsModels.ts` | `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_turbo_v2_5`. | `eleven_v4` is in the registry but not in this list. `eleven_turbo_v2_5` is deprecated and "functionally equivalent" to Flash v2.5 [E1]. |
| `app/api/voices/preview/route.ts` | Serves preview clips from the private `voice-previews` bucket; preparing a new clip is an operator action that spends the operator's characters through an Actions run. | Keep the pattern. The voices API returns a `preview_url` per voice [E7]; whether that URL may be played to our end users under the OEM terms is **unverified**. |
| `modules/capabilities/audio.py` | Adapters: TTS, SFX (`eleven_text_to_sound_v2`), voice changer (`eleven_multilingual_sts_v2`), dubbing (`/v1/dubbing/project`, v1/v2), Scribe v2 captions. | SFX v2 is deprecated and removed **2027-03-01**; v3 exists [E1]. Scribe v3 exists at the same price as v2 [E1][E10]. |
| `modules/voice_worker.py`, `docs/CUSTOM_VOICE.md` | Instant voice cloning of the user's **own** voice, read-aloud phrase verified by local Whisper; off by default; the account is on the Free plan, which cannot clone. | Fits the terms (§7.3). IVC needs Starter+, PVC Creator+ [E10][E22]. |
| `schemas/model_registry.json` | 9 ElevenLabs entries, all `plan_required:scale`, `api_exposure: web_only`, `confirmed: false`. | The gate and `web_only` are right (§7.1). Two prices disagree with the page (§5.1). |
| `docs/sql/prices_*.sql` | `credits_per_unit` = vendor cost converted to credits; customer pays `× (1 + margin)`, one margin for voice and another for image/video and dubbing (`prices_defaults_2026_10_03.sql:22-25`). | The Scribe row assumes twice the hourly price the page states [E10]; `docs/research/registry-corrections-2026-11-11.md` already flagged it. |

---

## 2. Where we use ElevenLabs in the Studio, and where we do not

"Yes" means the Studio should use it once the account is on Scale and a probe has passed. Until
then every row is **not verified**.

| Product line | Our use case | Decision | Why, and the alternative |
| :-- | :-- | :-- | :-- |
| **TTS: Eleven v4** (`eleven_v4`) | Narration and character lines, **including Uzbek** | **Yes, default for new projects** (after a probe) | 90+ languages including `uz`, 10,000 chars per request, "most emotive"; recommended over v3 "in almost every case" [E1][E2]. Request stitching works (the guide's example uses `eleven_v4`) [E4]. Priced per 1K chars [E10]. Caveats: no SSML, no Style/Speed sliders; "may sound substantially different from Eleven v3"; "will keep evolving" [E2], so a seed does not pin a voice across months. |
| **TTS: Eleven v3** (`eleven_v3`) | Existing channels already on v3; fallback **only if a person chooses it** | **Yes, kept** | 70+ languages including `uz`; 5,000 chars per request; **no request stitching** [E1][E4]. Same price as v4 [E10]. |
| **TTS: Multilingual v2** | English and Russian long-form | **Yes, but never for Uzbek** | 29 languages; `uz` is **not** among them [E1]. Stable on long form. `language_code` is "not supported for multilingual_v2 models" [E3]. |
| **TTS: Flash v2.5 / v4 Turbo** | Drafts and previews in the editor | **Later** | half the v4 rate per 1K [E10]. Flash: 32 languages, **no `uz`** [E1][E10]. v4 Turbo has `uz` but is built for latency; the Text to Dialogue websocket allows **only one** voice on v4 Turbo [E8]. Use for a cheap "draft take" only when the backend prices one (benchmark item 21). |
| **Text to Dialogue** | A scene with 2–3 characters | **Yes (P2)** | v4 and v3 only; up to 10 unique voices per request; keep ≤ 2,000 chars per request; with-timestamps returns `voice_segments` (start/end seconds per voice) [E6][E9]. §3. |
| **Speech to Text: Scribe v2/v3** | Uzbek captions; transcripts of uploaded media | **Yes for Uzbek and for uploads** | Uzbek is listed in the "Good (>10% to ≤20% WER)" band [E11]. Priced per hour; keyterms cost extra [E10]. Up to 32 speakers, word timestamps, SRT export, webhooks [E1]. **Not** for captions of our own narration: those come free from TTS alignment (§6.5). For English and Russian the local Whisper the repo already runs stays first (cost zero; quality not measured here). |
| **Speech to Speech (voice changer)** | Re-voice a recorded performance in a character's voice | **Later** | priced per minute [E10]; 5 min per segment; billed 1,000 chars/min [E12]. The capability page lists 29 languages for `eleven_multilingual_sts_v2` (no `uz`) [E12], the pricing card says "70+ languages" [E10]: the two disagree, so Uzbek is **unverified**. |
| **Dubbing** | A finished project into uz/ru/en when **we have no script** (customer uploads) | **Yes, narrow** | v2 and v1 priced per minute, v1 cheaper with a watermark [E10]; `uz` is in both v2 and v1 lists [E13]. 3 concurrent dubs on every self-serve plan [E13]. v2 is "alpha"; API editing and regeneration are Enterprise only [E13]. **For our own projects re-narrate the translated script instead** (§4.2): v4 costs a small fraction of Dubbing v2 per minute, and captions stay aligned. |
| **Sound effects** | Foley and stingers on a scene | **Yes (existing tool), move to v3** | priced per minute [E10]; 0.1–30 s, loopable [E14]. `eleven_text_to_sound_v2` (our registry) is deprecated and **removed 2027-03-01**; `eleven_text_to_sound_v3` replaces it [E1]. |
| **Music** | Background beds | **No** | API Exhibit 3 §1: "Unless you are an Authorized Reseller, you shall not resell, repackage, redistribute, sublicense, or otherwise make API access to the Music Service available to any third party" [E32]. Music rights table limits Scale to "entities … with fewer than 10 employees" [E33]. Keep the library and Sonilo (`docs/research/sonilo-first-party.md`). |
| **Voice Design** | A new voice for a character from a description | **Later (P3), behind a cap** | 3 previews per call; description 20–1,000 chars, preview text 100–1,000 [E7]; charged by preview text characters [E23]. v4 note: designed voices "may not be as performative" [E2]. Each saved voice uses a **custom voice slot** of our account: Scale 660, Business 2,200 [E10]. Slots are shared by all our customers. |
| **Instant voice cloning** | The user's own voice (`docs/CUSTOM_VOICE.md`) | **Yes, as already designed** | Starter+ [E10]; IVC "generally one to two minutes" of audio [E2]. Uses a slot as above. |
| **Professional voice cloning** | — | **No** | "You can only create a Professional Voice Clone of your own voice. Even with their consent, you cannot clone someone else's voice" [E22]. A PVC lives in one account: ours, so the user would not own it. |
| **Voice Isolator** | Clean an uploaded voice before dub or STT | **Later** | priced per minute, ≤ 500 MB / 1 h [E10][E15]. Useful only once uploads are common. A local open-source denoiser may do; not evaluated here. |
| **Forced alignment** | Align a customer's script to their own recording | **Later** | ≤ 10 h audio, ≤ 675,000 chars [E16]; its language list is the 29 Multilingual v2 languages, **no `uz`** [E16]. Price not shown on the API pricing page: **unverified**. For our own TTS the alignment comes back with the audio. |
| **Agents / Conversational, Realtime v1, Speech Engine** | — | **No** | A Studio renders files; nothing in it talks to a person live. Revisit only if the operator bot gets a voice. |
| **Studio projects API, Audio Native, Image & Video, Ads Engine** | — | **No** | ElevenLabs' own creative suite competes with ours and would sit behind the same OEM terms. Not evaluated. |

---

## 3. Two or three characters with different voices in one project

### 3.1 The two ways to do it

| | **Text to Dialogue** (`POST /v1/text-to-dialogue[/with-timestamps]`) | **Per-line TTS** (`POST /v1/text-to-speech/{voice_id}[/with-timestamps]`) |
| :-- | :-- | :-- |
| Models | `eleven_v4`, `eleven_v3` only; default `eleven_v3` [E6][E9] | any TTS model |
| Voices | `inputs[] = {text, voice_id}`; "maximum number of unique voice IDs is 10" [E9] | one per request |
| Size | keep total `inputs[].text` ≤ 2,000 chars "for reliable generation"; longer "can terminate early" [E9] | 5,000 (v3) / 10,000 (v4, v2) / 40,000 (Flash) [E1] |
| Turn-taking | the model hears the whole exchange: interruptions ("Hello, is this seat-" / "[jumping in] Free?"), ellipses, reactions [E6] | each line is generated alone; no interruptions |
| Continuity across requests | `previous_request_ids` / `next_request_ids` (≤ 3), `previous_text` / `future_text` (≤ 100 chars), "not supported by every model" [E9] | `previous_text`, `next_text`, `previous_request_ids`, `next_request_ids` (≤ 3) [E3]; not on `eleven_v3` [E4] |
| Timing | `voice_segments[]`: `voice_id`, `start_time_seconds`, `end_time_seconds`, character indices; plus character `alignment` [E9] | character `alignment` [E3]; line timing = our own concatenation |
| Settings | one `settings` for the whole dialogue: `stability`, `similarity`, `clone_strength` [E9] | per voice, per line |
| Determinism | `seed` best effort, "Determinism is not guaranteed" [E9]; "The models are nondeterministic" [E6] | same [E3] |
| Regenerate one line | regenerate the whole request (or split the scene into smaller requests) | regenerate that line only, with stitching ids |
| Price | not listed separately on the pricing page; presumably the model's per-character rate: **unverified** [E10] | the model's per-character rate [E10] |

### 3.2 Recommendation

- **Narration** (one narrator over the whole project): per-line TTS on v4, segment by segment, with
  `previous_request_ids`/`next_request_ids` and the with-timestamps endpoint. v3 channels keep v3 and
  get no stitching [E4].
- **A dialogue scene** (2–3 characters talking): **one Text to Dialogue request per scene**, ≤ 2,000
  characters, with timestamps. Generate **2–3 takes** and let the person choose; the docs advise
  exactly this ("consider generating several generations and allowing the user to select the best
  one") [E6]. A single bad line means one regenerated scene, which is bounded by the 2,000-char cap.
- **A long exchange** that exceeds 2,000 characters: split at a turn boundary into several dialogue
  requests chained with `previous_request_ids` (≤ 3) [E9]. Whether chaining holds a character's
  voice steady across requests is **not measured**: Probe should measure it (§10, P2) before the UI
  promises it.
- **Never mix models inside one scene.** The stitching docs say results are best "when the same model
  is used across the generations" [E3]. A Character carries its model with its voice.

### 3.3 Consistency across scenes

What actually holds a character's voice steady, from the docs:

1. **The same `voice_id`** and the same model on every line (above).
2. **Fixed settings per character**: `stability` (v3 accepts only the presets 0.0/0.5/1.0, as the repo
   already notes), `similarity`; on PVC + v4, `clone_strength` (start at 0%) [E2][E9].
3. **A stored `seed` per character**: best effort only [E3].
4. **Stitching ids** across a character's consecutive requests (v4 yes, v3 no) [E4].
5. **A pronunciation dictionary per project** for names (up to 3 locators per request) [E3]: so
   "Aziza" or a place name sounds the same in scene 1 and scene 9.

What can still drift, and must be shown as such (rule 5): the model itself changes ("Eleven v4 is
under active, continuous development … its behavior may shift over time") [E2]. A re-take next month
may not match last month's take with the same seed. The Studio should store, per take: model id,
voice id, settings, seed, request id, and the date, and say "voice drift: not checked" unless it was.

### 3.4 Emotion and audio tags (v3/v4)

- Tags are free-text instructions in square brackets inside the line: emotions (`[sad]`,
  `[whispering]`), audio events (`[applause]`), overall direction (`[auctioneer]`) [E6].
- In Text to Dialogue each turn carries its own tags; the `voice_id` still picks the speaker [E6].
- The vendor's own warning: "This feature is still under active development, actual results may vary"
  [E6]; on v4 "They're not perfect yet" [E2]. So a tag is a **request**, not a guarantee, and the UI
  must not promise it.
- Whether tag characters are billed as characters is **unverified** (billing is "per character" [E10]
  and the tags are part of the text, so assume yes and quote them).
- An Uzbek script with English tags (e.g. `[whispering] Bu yerda kimdir bor…`) is how the docs show
  tags (English instructions); whether tags work as well inside Uzbek text is **not measured**.

### 3.5 Timing to scenes

- The with-timestamps endpoints return character-level `alignment` (and `normalized_alignment`), and
  Text to Dialogue adds `voice_segments` with start and end seconds per voice [E3][E9].
- This is exactly the "**narration is the clock**" input of the Studio IA (`STUDIO_IA.md`, Narration
  node; benchmark items 18 and F6): words → word gaps → scene boundaries snap to them. A dialogue
  scene's length is the sum of its `voice_segments`, plus any pause we insert.
- Lip timing: the alignment gives per-character times; whether it is accurate enough for lip-sync
  models is **not measured**. Any lip-sync node is outside this document.

### 3.6 Voice library voices versus designed voices

| | Voice Library (community PVCs) | Voice Design / IVC (ours) |
| :-- | :-- | :-- |
| Count | "over 10,000 voices" [E7] | as many as our slots (Scale 660) [E10] |
| API access | "not available via the API to free tier users" [E7][E24] | yes on paid plans |
| Can disappear | yes: the owner sets a **Notice Period**; after it, the voice is gone from accounts that added it [E25]; ElevenLabs may remove any voice "with or without notice" [E25]. Webhooks `voice_removal_notice` / `voice_removed` [E17] | no (it lives in our account) |
| Who owns it | the sharer; rewards are paid to them per character used [E25] | our account |
| Uzbek | filter by `language` label; `verified_languages` per voice [E7] | whatever the model speaks |
| Risk for a character | the cast changes voice mid-series if the sharer removes it | a slot per character, shared across all customers |

Recommendation: a **Character's voice** may come from the account's own voices (designed, cloned by
the user, or a library voice the operator added). When a library voice receives
`voice_removal_notice`, the Character node turns amber with the date ("this voice leaves on 3 Feb"),
and after `voice_removed` every node that uses it **stops** with the remedy "pick another voice for
Aziza" (rule 4: no automatic replacement).

### 3.7 Limits to state in the UI

- 10 voices per dialogue request; 2,000 characters per dialogue request [E9].
- v3 lines: 5,000 chars per request; v4: 10,000 [E1].
- Dialogue websocket sessions: Scale 105, and an idle connection closes after 20 s [E1] (we do not need
  the websocket for rendering files).
- Concurrency on Scale: 15 (Multilingual v2 column), 30 (Flash) [E1]. Registry
  `max_concurrent_per_org: 4` is well inside it.

### 3.8 On our canvas

The IA already has a **Character** node (Look group, `→ R`) and a **Narration (Voice)** node
(`T → A`). This adds a voice to the first and one new node:

| Node | Ports | Inspector tabs | Stored |
| :-- | :-- | :-- | :-- |
| **Character** (exists) | → R | **Voice** (picker from the account's list, filtered by the project language; preview), **Delivery** (stability preset, default tags), **Pronunciation** (names), Used in N scenes | `voice_ref`: provider, voice id, model, settings, seed; never a typed id |
| **Dialogue** (new, Sound group) | T (lines), R (characters) → A, T (timed lines) | **Lines** (each line bound to a Character, with its tags), **Takes** (2–3, pick one), **Timing** (`voice_segments` on the timeline), **Quote** | the chosen take's request id, sha256 of the audio, `voice_segments` |
| **Narration** (exists) | T → A, timing | as in the IA, plus **Model** (disabled models show why: "Multilingual v2 does not speak Oʻzbekcha") | request ids for stitching, alignment |
| **Captions** (exists) | T → T | source shown: "from the narration's timing (no cost)" or "Scribe v2, Uzbek, ~10–20% WER per vendor" | which one it was |

A Dialogue node with an unassigned line, a Character without a voice, or a voice that cannot speak the
project's language shows the missing input on the node before any quote ("Choose a voice for Bobur
that speaks Oʻzbekcha"), as the IA's rule-6 row says.

---

## 4. The two directions: text → voice and voice → text

### 4.1 What each direction enables in the Studio

| Direction | Feature | ElevenLabs product | Uzbek, per the official docs (read 2026-11-14) |
| :-- | :-- | :-- | :-- |
| text → voice | Narration | TTS v4 / v3 | **v4 yes, v3 yes** [E1]; Multilingual v2 **no**, Flash v2.5 **no** [E1]; v4 Turbo yes, v3 Conversational yes [E1] |
| text → voice | Dialogue (2–3 characters) | Text to Dialogue | yes, via v4 or v3 [E6] |
| text → voice | A narrated project in uz, ru and en | TTS on the translated script | as narration |
| text → voice | A character voice from a description | Voice Design | `eleven_ttv_v3` "70+ languages" (the v3 list, which has `uz`); `eleven_multilingual_ttv_v2` 29 languages, no `uz` [E1] |
| voice → text | Captions of an uploaded video | Scribe v2/v3 | yes: "Good (>10% to ≤20% WER)" band [E11] |
| voice → text | Transcript of a customer's own recording, for editing | Scribe | as above |
| voice → voice | Dub a finished upload into uz/ru/en | Dubbing v2 / v1 | yes, both lists [E13] |
| voice → voice | Replace a voice-over with a character's voice | Voice changer (STS) | **unverified**: 29-language list without `uz` [E12] vs "70+ languages" on the pricing card [E10] |
| voice → text → voice | Voice-over replacement with a new script | Scribe → edit → TTS (v4) | yes (each step above) |

### 4.2 Dubbing our own projects: re-narrate, do not dub

For a project the Studio made, we own the script, so "into Russian" means: translate the script (an
LLM step, with the fact-check state carried over), then narrate it with the same Character voices on
v4, which keeps its native-accent behaviour ("generates fluent, natural-sounding speech in the target
language rather than carrying over the reference voice's accent") [E2]. The cost is the TTS rate
(at about 1K chars per minute of speech [E10]), a small fraction of Dubbing v2's per-minute
price [E10], and the captions come back aligned. Dubbing stays for media that arrives without a
script.

### 4.3 Uzbek: what to enforce

Per model, in the official models page [E1] and the v4 page [E2]:

| Model | `uz` listed? |
| :-- | :-- |
| `eleven_v4`, `eleven_v4_turbo` | yes |
| `eleven_v3`, `eleven_v3_conversational`, `eleven_ttv_v3` | yes |
| `eleven_multilingual_v2`, `eleven_multilingual_sts_v2`, `eleven_multilingual_ttv_v2` | **no** |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` (deprecated) | **no** |
| `scribe_v2`, `scribe_v3` | yes ("Good" band, 10–20% WER) [E11] |
| Dubbing v1, v2 | yes [E13] |
| Forced alignment | **no** (29-language list) [E16] |

So the rule-4 check missing today is: **a run (or a Narration/Dialogue node) whose language is
Uzbek and whose model is Multilingual v2 or Flash stops before it spends**, with the remedy "choose
Eleven v4 or v3 for Oʻzbekcha". The same table drives the disabled voices and models in the picker
(benchmark item 24). Listing `uz` is the vendor's claim; how good Uzbek narration sounds is **not
measured** here. The first P1 probe should include an Uzbek sentence, listened to by the owner.

---

## 5. Pricing audit

### 5.1 ElevenLabs API prices (read on elevenlabs.io/pricing/api, 2026-11-14 [E10])

"API usage is billed in US dollars, not credits" [E10, FAQ]. The per-unit price is the same on every
plan row; a plan buys an included amount.

The figures are on the vendor pricing page (read 2026-11-14); the price itself lives in the DB price
table / model registry, not in prose. What is priced, and whether the registry matched the page:

| Item | Billed per | Registry today | Match? |
| :-- | :-- | :-- | :-- |
| TTS v4 | 1K chars | `elevenlabs-v4` | yes |
| TTS v4 Turbo | 1K chars (half the v4 rate) | not in registry | — |
| TTS v3 | 1K chars (as v4) | priced | yes |
| TTS v3 Conversational | 1K chars (as v4 Turbo) | — | — |
| TTS Multilingual v2 | 1K chars (as v4) | priced | yes |
| TTS Flash / Turbo | 1K chars (as v4 Turbo) | priced | yes |
| Scribe v3, v2, v2 Medical | hour; keyterms and transcript editing extra | priced per second | yes (the credit row assumes twice the page's hourly price: **2× too high**) |
| Scribe v3 Live / v2 Realtime | hour | — | — |
| Music | minute; finetune extra | — | not used (§2) |
| Voice Isolator | minute | — | — |
| Voice Changer | minute | priced per second | yes |
| Sound Effects | minute | priced per second | yes ("billed per generation" in the FAQ: the exact metering of a 2 s effect is **unverified**) |
| Dubbing v1 | minute, cheaper with a watermark | priced per second (no-watermark price) | yes (no-watermark price) |
| Dubbing v2 | minute | priced per second | yes |
| Realtime v1 Mini/Max | minute + LLM tokens | — | not used |

Plans (API page, monthly billing, read 2026-11-14 [E10][E26]):

Plan prices are on the vendor pricing page (read 2026-11-14), not in this document.

| Plan | v4 chars included | Scribe hours included | Concurrency (Multilingual v2 / Flash / STT) [E1] | Custom voice slots [E26] | May offer to end users? [E30] |
| :-- | --: | --: | :-- | --: | :-- |
| Free / PAYG | 10,000 | 4 h 30 min | 2 / 4 / 8 | 3 | **no** |
| Starter | 75,000 | 30 h | 3 / 6 / 12 | 10 | **no** |
| Creator | 275,000 | 110 h | 5 / 10 / 20 | 30 | **no** |
| Pro | 1,238,000 | 495 h | 10 / 20 / 40 | 160 | **no** |
| **Scale** | 3,738,000 | 1,495 h | 15 / 30 / 60 | 660 | **yes** (Business Entity) |
| Business | 12,375,000 | 4,950 h | 15 / 30 / 60 | 2,200 | yes |

Notes:
- Included amounts equal the plan price at the list rate: the
  subscription is a prepaid commitment, not a discount.
- What a Scale account pays **past** its included amount is not stated in the text read: the page
  shows the same per-unit price on every row, and the repo's own check reads
  `allowed_to_extend_character_limit` from `/v1/user/subscription`. The overage rate is **unverified**.
- Rollover: "Unused credits roll over for up to two months" on the creator-side pricing page [E26];
  whether that applies to the API's dollar balance is **unverified**.
- Output quality per plan: 192 kbps MP3 needs Creator+, 44.1 kHz PCM/WAV needs Pro+ [E3]. Scale has
  both.
- Dubbing: 3 concurrent jobs on every self-serve plan [E13]. Music: 5 on Scale. SFX: 8 on Scale [E1].
- Rate limiting is by concurrency, reported in the `current-concurrent-requests` and
  `maximum-concurrent-requests` response headers [E1]; 429 carries `rate_limit_exceeded`,
  `concurrent_limit_exceeded` or `system_busy` [E5].

### 5.2 Our credit price per unit

The repo's convention (`docs/sql/prices_defaults_2026_10_03.sql:22-25`, `prices_2026_10_01.sql`):
`credits_per_unit` = vendor cost converted to credits; the customer is charged `credits_per_unit × (1 +
margin)`, with one margin for voice, another for image and video, and the dubbing rows on the latter.
Migration 0084 keeps the margin private: a quote shows the charged rate, never the margin. The vendor
cost and the margin live in the DB price table, not in prose; the charged rates:

| Unit | Charged per unit |
| :-- | --: |
| `model_elevenlabs_v4_character` | 0.024 cr |
| `model_elevenlabs_v3_character` | 0.024 cr |
| `model_elevenlabs_multilingual_v2_character` | 0.024 cr |
| `model_elevenlabs_flash_v2_5_character` | 0.012 cr |
| `model_elevenlabs_scribe_v2_second` (as seeded) | 0.0336 cr/s |
| same, at the read price | 0.0168 cr/s |
| `model_elevenlabs_sfx_second` | 0.6 cr/s |
| `model_elevenlabs_dubbing_v2_second` | 9.175 cr/s |

A dialogue unit does not exist. The simplest honest choice is to bill Text to Dialogue at the model's
character unit (it is billed per character [E10]), but that the vendor charges dialogue at the plain
TTS rate is **unverified** until the first real dialogue call shows its cost in the usage API. Owner
decision (§11).

### 5.3 Worked examples

Assumptions, stated so they can be checked: the repo's estimator uses **15 characters per second**
(`audio_mixer.CHARS_PER_SECOND`), i.e. 900 per minute; ElevenLabs' own page equates 1K characters with
about a minute [E10]. Both are estimates of speech density, not measurements.

**A 10-minute narrated project (one narrator, v4, one take):**

| | 9,000 chars (repo estimate) | 10,000 chars (vendor's rule of thumb) |
| :-- | --: | --: |
| Our charge at 0.024 cr/char | **216 credits** | **240 credits** |
| Captions from the TTS alignment | 0 (no extra call) | 0 |
| Captions via Scribe instead (600 s), at the read price | 10.1 cr | same |

Retakes multiply the TTS line; a typical retake rate is **not measured**. For scale: the whole
`video_minute` price is 60 credits a minute (`docs/BILLING_PLANS.md`), so a 10-minute run holds 600
credits; v4 narration alone would be 36–40% of that hold, and a comparable share of the per-minute
cost basis that document assumes. If channels move to v4, that cost basis
should be re-measured.

**A 3-character dialogue scene** (assumed 60 seconds, about 1,000 characters including tags, v4):

| | One take | Three takes (recommended) |
| :-- | --: | --: |
| Our charge at 0.024 cr/char | **24 credits** | **72 credits** |

Per-line TTS for the same scene costs the same per character; it saves money only when a single line
is regenerated instead of the whole scene.

At retail (`docs/BILLING_PLANS.md`: one credit sells for about $0.0072–$0.0095 by plan), 240 credits
bring in about $1.73–$2.28.

### 5.4 Which plan we need

**Scale, at least, and only Scale or above may be used for any customer-facing feature.** OEM Terms
§2.B(f): "if you are a Customer accessing the Services under a Free, Starter, Creator, or Pro tier
plan, you are expressly prohibited from Making Available the Services or any Bundled Service", and
§1.D defines a Business Entity as one on "a Scale, Business, Enterprise, or equivalent plan" [E30].
The registry's `plan_required:scale` is therefore **right**. The account today is Free
(`docs/CUSTOM_VOICE.md`), which also cannot use Voice Library voices through the API [E7] and is
"non-commercial" only (Terms of Use §3(c)) [E31].

Business adds seats, PVC slots and a cheaper low-latency TTS rate [E26]; nothing in the
Studio needs it until volume passes Scale's 3.7M included characters (about 370 ten-minute projects a
month at 10K chars each). Enterprise is the only route to Zero Retention Mode [E18] and to Dubbing v2
editing through the API [E13].

---

## 6. Technical capabilities and limits

| Topic | What the docs say (read 2026-11-14) | What it means for us |
| :-- | :-- | :-- |
| Characters per request | v4 10,000; v3 5,000; Multilingual v2 10,000; Flash v2.5 40,000 [E1]. Dialogue: keep ≤ 2,000 total [E9]. | Registry `max_prompt_chars` 3,000 for v3/v4 is conservative and fine. Segmenting already happens per script line. |
| Streaming | HTTP chunked streaming; TTS websocket (one voice per connection, non-v3); TTD websocket (per-chunk `voice_id`, up to 10 voices on v4, one on v4 Turbo) [E8][E19] | Rendering files needs neither; a "listen while it generates" preview could use HTTP streaming later. |
| Latency | v4 Turbo ~100 ms median; Flash ~75 ms (pricing) or ~100 ms (models page); v3 Conversational ~165 ms (models page) or ~280 ms (pricing) [E1][E10] | The two official pages disagree; not relevant to batch rendering. |
| Output formats | MP3 22.05–44.1 kHz, 32–192 kbps; PCM 8–48 kHz; WAV 8–48 kHz; Opus 48 kHz; μ-law/A-law 8 kHz. 192 kbps needs Creator+, 44.1 kHz PCM/WAV needs Pro+ [E3] | The adapters ask `mp3_44100_128`. For mixing, `pcm_44100` or `wav_44100` avoids a lossy generation step (Scale has it). |
| Timestamps / alignment | TTS and TTD `with-timestamps`: character `alignment` and `normalized_alignment`; TTD adds `voice_segments` [E3][E9]. STT: word or character timestamps [E1]. Forced alignment: 29 languages, no `uz` [E16]. | Captions and scene snapping for our narration come from the TTS alignment, for every language the model speaks, at no extra cost. |
| Request stitching | `previous_text`, `next_text`, `previous_request_ids`, `next_request_ids` (≤ 3; ids win over text) [E3]. **Not available for `eleven_v3`** [E4]. TTD: ids ≤ 3, text ≤ 100 chars, "not supported by every model" [E9]. Needs history: `enable_logging=false` disables stitching [E3]. | Store every request id. v4 gets smoother joins; v3 does not. |
| Pronunciation dictionaries | Up to 3 locators per request, applied in order [E3]; a dictionaries API exists [E19]. | One dictionary per project (names, places). |
| Seed | integer 0–4,294,967,295; "best effort … Determinism is not guaranteed" [E3]. | Store it; never present a re-take as identical. |
| Text normalisation | `apply_text_normalization` auto/on/off [E3]; `language_code` enforces language and normalisation, not on Multilingual v2 [E3]. | Send `language_code=uz` on v3/v4. Numbers in Uzbek: normalisation quality **not measured**. |
| Rate limits, concurrency | concurrency per plan (§5.1); 429 codes `rate_limit_exceeded`, `concurrent_limit_exceeded`, `system_busy` [E5]; headers report current and maximum [E1]. | Back off on 429; queue rather than fail. |
| Errors | `detail.code` is the field to read; `status` is "a legacy field that is no longer used" [E5]. 401 `invalid_api_key` / `missing_api_key`; 402 `insufficient_credits`; 403 `feature_not_available`, `subscription_required`, `voice_access_denied`; 404 `voice_not_found`; 422 validation; 429 as above [E5]. | §6.9. |
| Webhooks | Events: `voice_removal_notice`, `voice_removal_notice_withdrawn`, `voice_removed`, agents and image/video events [E17]; STT batch has its own `webhook` option [E1]. HMAC `ElevenLabs-Signature`; retries off by default; auto-disabled after 10 consecutive failures with no success for 7 days [E17]. ElevenAPI Terms §3.2: verify signatures and "handle duplicate deliveries idempotently" [E32]. | One receiver for voice removals (P3). TTS and TTD are synchronous: no webhook needed. |
| Data retention | Zero Retention Mode is Enterprise only, per request via `enable_logging=false`, and it disables stitching [E18]. | Not available to us; say so in our privacy notice. |
| Default voices | expire 2026-12-31; new accounts since March 2026 do not get them [E20]. | §8.2, P0. |

### 6.9 Telling `invalid_api_key` from an empty account (rule 6)

From the current error reference [E5]:

| HTTP | `detail.type` | `detail.code` | Remedy to show |
| :-- | :-- | :-- | :-- |
| 401 | `authentication_error` | `invalid_api_key`, `missing_api_key` | "The ElevenLabs key is wrong or missing. Replace the secret; nothing was spent." |
| 402 | `payment_required` | `insufficient_credits` | "The ElevenLabs account is out of credit. Top up the plan; no other voice is used." |
| 403 | `authorization_error` | `subscription_required`, `feature_not_available`, `voice_access_denied` | "This plan cannot use this voice or feature. Pick a voice from the account's list, or upgrade." |
| 404 | `not_found` | `voice_not_found` | "This account has no such voice. Pick one from its list." |
| 429 | `rate_limit_error` | `rate_limit_exceeded`, `concurrent_limit_exceeded`, `system_busy` | "Busy; the job waits and retries." (not a person's fault) |

The repo's comment that the two "are the same HTTP status" was true of older responses (`status:
quota_exceeded` under 401, which the code still tolerates by reading `code or status`). The current
docs list out-of-credit as 402. The copy should key on `detail.code`, keep the legacy `status`
fallback, and stop telling a person with a 401 that they may be out of characters. Whether the live
API still sends `quota_exceeded` anywhere is **unverified**.

---

## 7. Commercial and legal terms

Read 2026-11-14. Quotations are exact; section numbers are the documents' own. This is a reading for
the owner, not legal advice; §11 lists what needs a lawyer or ElevenLabs' written answer.

### 7.1 Can we pass ElevenLabs through to our customers?

**Yes, inside our product, on Scale or above, with an End User Agreement. Not as an API others resell.**

- OEM Terms ("Last Updated: 28 February 2025") [E30]:
  - Preamble: they govern how "Customer may bundle, make available and sublicense ('Make
    Available') certain ElevenLabs' Services … to its End Users".
  - §1.C: "'Bundled Service' means the combined offering of the Services and the Customer Solution.
    **Services cannot be used independent of the Customer Solution.**" → a thin "ElevenLabs TTS"
    resale page is out; a voice node inside a project is in.
  - §2.B: "Customer may not: (a) Make Available a Service to any third party who will itself Make
    Available the applicable Service or Bundled Service; … (d) issue any public statement regarding
    its business with ElevenLabs without ElevenLabs' prior written approval; (e) sell or Make
    Available the Services or Bundled Service to any Government Entity without ElevenLabs' prior
    written consent; or (f) Make Available the Services or Bundled Service if Customer is not
    accessing the Services as a Business Entity. For the avoidance of doubt, if you are a Customer
    accessing the Services under a Free, Starter, Creator, or Pro tier plan, you are expressly
    prohibited from Making Available the Services or any Bundled Service."
  - §1.I: an End User is a customer "licensing or using the Customer Solution **only for its own
    internal business operations**", who "has entered into an End User Agreement". Whether an
    individual YouTube creator on a Nightshift plan is an "End User" in this sense is **unclear**:
    owner decision, ask ElevenLabs in writing.
  - §3.A: every End User Agreement must bind users to restrictions "at least as restrictive as those
    found in the ElevenLabs Terms of Service, including the incorporated Prohibited Use Policy", make
    ElevenLabs "a third-party beneficiary", and grant ElevenLabs "a non-exclusive right to process
    and use End User's Data to provide and support the Services".
  - §3.C: ElevenLabs may audit compliance once a year, and for three years after.
  - §5.A: "Customer will independently establish the subscription price": our own credits are fine.
  - §6: "Customer is responsible for all initial contact from End Users for all support".
- Terms of Use ("Last Updated: 09 October 2026") list the OEM Terms as the terms for "incorporating
  the ElevenLabs Services in your own solution" [E31, list of Supplemental Terms].
- ElevenAPI Terms ("Last updated: October 09, 2026") §2.1: "You shall not share credentials outside
  your organization, expose them in third-party-accessible clients or artifacts, or commit or
  distribute any credential or secret" [E32]. This matches our rule 1 and the dashboard never holding
  the key. §2.3: we must ensure "a user cannot access Services resources you have not authorized
  that user to access", which is the per-org voice scoping in §8.2.
- Music via API, ElevenAPI Terms Exhibit 3 §1: "Unless you are an Authorized Reseller, you shall not
  resell, repackage, redistribute, sublicense, or otherwise make API access to the Music Service
  available to any third party" [E32]. → no Music in the Studio.
- **Web-only versus API passthrough.** §2.B(a) of the OEM terms is why the registry marks every
  ElevenLabs entry `api_exposure: web_only`: a customer of our public API who builds an app "will
  itself Make Available" the service. Keep it.

### 7.2 Commercial use per plan

- Terms of Use §3(c): "(i) if you access or use our Services free of charge … you may only use the
  Services for non-commercial purposes; (ii) if you access or use our Services through a paid
  subscription plan … you may use the Services for commercial purposes" [E31].
- Ownership: "as between you and ElevenLabs, you retain all rights in and to your Output" (§4(c)(ii))
  [E31]. The Text to Dialogue FAQ adds that commercial rights need a paid plan and that you may
  monetise "if you own the IP rights to the input content" [E6].
- Music has its own plan table (Exhibit A of the Music Terms): Free to Pro "For Individual Use Only";
  Scale "Individuals, or entities or organizations with fewer than 10 employees"; Business "fewer than
  50" [E33]. Another reason Music is out.
- Watermarks: ElevenLabs watermarks audio for its own AI-transparency detector; "No other platforms
  can currently detect ElevenLabs watermarks" and it is "not connected to other platforms'
  monetization" [E27]. Free-tier dubs are watermarked; paid Dubbing v2 is not [E13].

### 7.3 Voice cloning consent

- Terms of Use §4(b): a User Voice Model is "synthetic audio sounding like your voice or a voice you
  are authorized to share with us" [E31]. §4(g): "You may not provide Input or create Output for
  which you do not have all the rights necessary" [E31].
- PVC: "You can only create a Professional Voice Clone of your own voice. Even with their consent,
  you cannot clone someone else's voice"; PVCs pass a voice-captcha [E22][E28].
- The license we grant on cloned voices: §4(d) gives ElevenLabs a "perpetual and irrevocable …
  worldwide … sub-licensable" license to use Content, "including your voice", "to provide and improve
  the Services, and to develop new services and products", with "we will not commercialize your voice
  on a standalone basis without your permission" [E31]; §4(e) is the same for User Voice Models. A
  user who clones their voice in Nightshift should be told this in plain words before consenting; the
  0117 consent trail should record which text they saw.
- The existing design (`docs/CUSTOM_VOICE.md`: own voice only, live read-aloud phrase, consent rows,
  deletion) is consistent with these terms. Illinois: the Voice Library Addendum asks sharers not to
  be Illinois residents [E25]; this applies to sharing in the Library, not to cloning, but the BIPA
  question for cloned voices is a lawyer's (§11).

### 7.4 Voice Library usage rules

- Voice Library Addendum ("Last Updated 6 March 2026") [E25]: a sharer picks a Notice Period; after
  removal, "the User Voice Model will remain accessible for the duration of the Notice Period to users
  that added that User Voice Model to their account", and Outputs made before the end of the period
  "will continue to exist and remain available for use thereafter". ElevenLabs may "review and remove
  any User Voice Model … with or without notice" and may rename it.
- Library voices are "not available via the API to free tier users" [E7].
- Practical rule for us: a library voice is borrowed. Its loss must stop the nodes that use it, with a
  remedy, never swap it (§3.6).

### 7.5 Data use for training

- "ElevenLabs uses certain data you provide to us to improve the quality of our audio models for
  everyone … By default, we don't train on any data from our Enterprise customers … Anyone can opt out
  of data use at any time" via Terms and privacy → Data use → "Improve the models for everyone" [E29].
- Terms of Use §4(i): the opt-out works "once the request has been processed" and "does not affect any
  uses … prior to that date" [E31].
- Because all our customers' text and samples flow through **our** account, that one toggle decides
  for all of them. Recommendation: switch it off before the first customer call, and say so in our
  privacy notice (owner decision).

### 7.6 Government customers

Both the OEM Terms §2.B(e) and the Prohibited Use Policy ("If you are a Government Entity … or would
like to make our Services available to one, you need our prior written approval") [E30][E34]. Our sign-up
does not ask whether a customer is a government body; until it does, the safe reading is that the
ElevenLabs nodes are not offered to such customers. Owner decision.

---

## 8. The role in Nightshift Studio and on the site

### 8.1 Nodes and inspector tabs

| Node (IA name) | ElevenLabs product | Inspector tabs that use it |
| :-- | :-- | :-- |
| Narration (Voice) | TTS v4/v3/v2, with timestamps | Voice, Model, Delivery, Pronunciation, Takes, Timing, Quote |
| Dialogue (new) | Text to Dialogue v4/v3 | Lines, Takes, Timing, Quote |
| Character | the voice reference only | Voice, Delivery, Pronunciation |
| Captions | none for our narration (alignment); Scribe for uploads and Uzbek uploads | Source, Languages |
| Enhance → Voice (Sketch tools `tts`, `voice_change`, `dub`) | TTS, STS, Dubbing | as today's composer forms |
| Sound effect (SFX) | `eleven_text_to_sound_v3` (after a probe) | Prompt, Duration, Loop, Quote |
| Music | **not ElevenLabs** | — |

### 8.2 Picking a voice

- **From the account's list, never typed.** The Studio uses the server-side voices route (the v2
  paginated list the repo already calls, `lib/elevenlabsVoices.ts`), filtered by project language
  (`language` label and `verified_languages` [E7]) and by what the chosen model speaks (§4.3). The
  Create page's free-text "Custom voice id" is not carried into the Studio. Ids are still checked as
  20 alphanumerics (CLAUDE.md ceiling) as defence, not as the way in.
- **Per organisation.** Every customer sees the voices of our one ElevenLabs account, so the Studio
  must show a customer only (a) the platform's approved voices and (b) that customer's own voices
  (clones, designs). ElevenAPI Terms §2.3 makes this our duty [E32].
- **The Default-voice deadline.** Replace `lib/voices.json` with voices that do not expire (the
  vendor's suggested replacements are listed on [E20], "not a strict 1-to-1 replacement"), update
  `config.py`'s default, and run a one-off check of every channel's saved `elevenlabs_voice_id`
  against the list, before 2026-12-31. After that date a channel still on, say, "Brian" stops at
  `verify_voice` (404 or similar): the right failure, but avoidable.
- **Legacy re-routing.** "Legacy voice IDs will automatically route to their replacement voice IDs"
  [E21]: a channel saved on Rachel already speaks as Janet, with no error. The voice event should
  record the voice the response reports, where the response reports one (**unverified** that it does);
  otherwise the picker must at least stop offering Legacy ids.

### 8.3 Previews

- Keep the repo's rule: a preview clip that exists is never paid for twice; preparing one is an
  operator action, rate-limited (`api/voices/preview`).
- For a Character, the preview is the character's own line in the project language, generated once,
  quoted first ("Preview · 1 cr").
- Voice Design returns 3 previews per call [E7]; each is charged by preview text length [E23]; a
  designed voice is kept only when the person saves it (one slot).

### 8.4 States (every node that calls ElevenLabs)

| State | What the node shows |
| :-- | :-- |
| loading | "Generating line 3 of 8 · take 2" from the job's real events; never a spinner alone |
| empty | "No lines yet. Write the scene, or split it from the script." |
| success | the take with its waveform, duration, model, voice, seed; "Use this take" |
| error | the vendor's code mapped to a remedy (§6.9); the hold released |
| retry | "Try again" re-quotes; a 429 waits on its own and says so |
| disabled | "Multilingual v2 does not speak Oʻzbekcha", "This voice is leaving on 3 Feb", "Voice nodes need the platform's Scale plan" (operator-only copy) |
| insufficient credits | "This scene needs 72 cr; you have 40. Top up or make one take (24 cr)." |
| provider not verified | the node type is hidden from customers until the probe passed |

### 8.5 Price before spending

`Get quote` → `Start | N cr`, from the backend's quote function, as the IA requires. For voice the
quantity is the character count of exactly what will be sent (lines plus tags), times takes, at the
charged rate. Editing a line voids the quote. A quote for Uzbek on a model that cannot speak it is
refused with the remedy, never priced.

### 8.6 Public site (pricing and solutions pages)

What we may say, once a probe passed: "AI narration and multi-character dialogue in Oʻzbekcha,
Русский and English", "captions in Uzbek", "dub your uploads into …". Prices only as credits computed
by the backend.

What we must **not** say or show:
- "Powered by ElevenLabs", the ElevenLabs logo, or any statement about our business with them, without
  their prior written approval (OEM §2.B(d)) [E30].
- That we are ElevenLabs' partner or agent (§2.B(c), §3.A(b)) [E30].
- "Clone anyone's voice", "celebrity voices", or a library voice's name as a product.
- "Uzbek" next to a model that does not list it (Multilingual v2, Flash).
- "Identical every time" or "same voice forever" (seeds are best effort; v4 keeps changing) [E2][E3].
- "Unlimited voice", or a per-minute dollar price that the backend did not compute.
- Music by ElevenLabs.
- Any model as available before its probe passed.

---

## 9. Competitors and voice rivals

Read 2026-11-14 with curl or Playwright, no sign-up, no key. Copies are under
`/tmp/research/competitors/` (not committed). Five claims were re-checked against the saved pages:
Azure `uz-UZ-MadinaNeural`, Krea "Defaults to eleven_multilingual_v2", Gemini "Northern Uzbek", the
OpenAI TTS shutdown date and Runway's "1 credit/50 chars". Version names newer than our own knowledge
(Gemini 3.8, Sonic 3.6) are reported as the pages state them. DuckDuckGo rate-limited the search
after one query, so URLs came from sitemaps and page links.

### 9.1 How the studios use voice

| Studio | Voice provider(s) | Voice features | Voice pricing to users | Uzbek listed? |
| :-- | :-- | :-- | :-- | :-- |
| Higgsfield | **ElevenLabs** v3, v4, v4 Turbo; Seed Audio 1.0 (the default), Qwen Audio 3.0, MiniMax Speech 2.8 HD, Seed Speech (higgsfield.ai/audio) | TTS, "Pick or clone a voice", Voice Change, Translate; Seed Audio "Multi-speaker scenes"; lip sync through Kling, Sync and "Lipsync Studio" (higgsfield.ai/pricing) | credits; the cost per voice is **unverified** | unverified |
| Krea | **ElevenLabs**: TTS "Defaults to eleven_multilingual_v2", with eleven_v4 and v4 Turbo; Seed Audio (api.krea.ai/openapi.json). The pricing page source names elevenlabs-dialogue-v3, -dubbing, -voice-design and -voice-changer (krea.ai/pricing) | TTS, dialogue, dubbing, voice design, voice changer, lip sync | monthly plans in compute units (krea.ai/pricing); the cost per voice is unverified | unverified. Its **default model has no Uzbek** [E1] |
| buzzy.now | no voice tool found; only video models with "native audio" (buzzy.now/models) | — | — | unverified |
| Runway | **ElevenLabs** (eleven_v4, v3, multilingual_v2, dubbing, STS, isolation) and Seed Audio (docs.dev.runwayml.com/guides/models) | TTS, custom voices, dubbing, STS | app and API both price TTS per character (runwayml.com/pricing) | unverified |
| HeyGen | ElevenLabs (elevenlabs.io/blog/how-heygen-uses-elevenlabs…, 2025-04-24) plus its own "HeyGen Voice 1" | TTS, clone, dubbing, translation into "175+ languages and dialects", lip sync | Creator $29/mo "up to 10 hours of text to speech" (heygen.com/pricing) | not named: unverified |
| Hedra | ElevenLabs partnership (elevenlabs.io/blog/hedra, 2024-07-04) | character video with voice, lip sync | the current pricing page shows only GPU compute | unverified |
| CapCut | its own; no provider named | "200+ AI voices", voice clone (capcut.com/tools/text-to-speech) | advertised as free | not in the list on that page |
| InVideo | **ElevenLabs**: "29 languages on Eleven Multilingual v2", plus ElevenLabs Music (invideo.io/ai-models/elevenlabs) | TTS, cloning, voice design | credits | unverified (a 29-language model) |
| Pictory | **ElevenLabs**: "Multilingual hyper-realistic AI voices from ElevenLabs" (pictory.ai/pricing) | "170+ AI voices in 29+ languages" | plans $25–$199 | not listed |
| Synthesia | **ElevenLabs**: "voiceovers powered by ElevenLabs" (elevenlabs.io/blog, 2025-05-16) | TTS, cloning, dubbing, lip sync, 140+ languages | dubbing "80 credits with lip-sync, 40 without" per minute (synthesia.io/pricing) | **yes**, "Uzbek" in the language list (synthesia.io/features/languages) |
| Descript | its own, since 2018 (descript.com/ai-voices) | AI speech, clones, dubbing "30+ languages" | AI credits 400/800/1,500 a month | unverified |

What this tells us:
- **ElevenLabs is the common voice layer** of the video studios (Runway, Krea, Higgsfield, InVideo,
  Pictory, Synthesia, HeyGen). Voice is not where any of them is different, so it is not where we
  will be different either. What we can do differently is **language honesty and timing**: Krea
  defaults to a model with no Uzbek, and InVideo and Pictory advertise a 29-language model. A picker
  that disables voices for Oʻzbekcha (benchmark item 24) is a real gap in the market, not decoration.
- The second layer that keeps appearing beside ElevenLabs is **ByteDance Seed Audio** (Higgsfield's
  default, Krea, Runway). We have not evaluated it. Runway's API sells v4 below
  ElevenLabs' own list price, so Runway has a volume deal or a promotional rate. The
  repo's `prices_2026_10_01.sql` notes a promotional rate: the same figure.
- Nobody we read shows a **per-line voice price before generating**. Runway's per-character credit price is
  the closest. Our quote-before-start rule is ahead of them.

### 9.2 Voice rivals

| Provider | TTS billed per | Uzbek TTS | Uzbek STT | Notes |
| :-- | :-- | :-- | :-- | :-- |
| ElevenLabs (for comparison) | 1M chars; Flash/v4 Turbo at half the v4/v3 rate [E10] | v3, v4 yes; v2, Flash no [E1] | Scribe yes, "Good" 10–20% WER [E11] | dialogue, stitching, alignment, cloning |
| OpenAI | 1M chars (tts-1, tts-1-hd dearer); gpt-4o-mini-tts in tokens (platform.openai.com/docs/pricing) | not in the documented list | Whisper "98 languages"; Uzbek not stated: unverified | TTS endpoints "shut down on January 6, 2027" (platform.openai.com/docs/guides/text-to-speech). **Not a candidate** |
| Google Gemini TTS | gemini-3.8-flash-tts per 1M audio tokens out, doubling after 2026-12-31 (ai.google.dev pricing) | **"Northern Uzbek ✔️"** (ai.google.dev/gemini-api/docs/speech-generation) | — | two-speaker dialogue, voice design; the free tier is "Used to improve our products: Yes". **Worth a probe** as a second Uzbek voice |
| Google Cloud TTS Chirp 3 HD | 1M chars | **no uz-UZ** (cloud.google.com/text-to-speech/docs/chirp3-hd) | **uz-UZ yes** on chirp, chirp_2, chirp_3 | an STT alternative to Scribe for Uzbek; WER not compared |
| Azure AI Speech | Neural per 1M chars (azure.microsoft.com pricing) | **uz-UZ-MadinaNeural, uz-UZ-SardorNeural** (no custom lexicon or visemes) | **uz-UZ yes** (learn.microsoft.com language-support) | the cheapest proven Uzbek TTS; two stock voices only; no Uzbek custom or personal voice |
| Cartesia Sonic 3.6 | credits per char, prepaid plans | **no** (44 languages) | unverified | fast, timestamps |
| MiniMax Speech 2.8 | 1M chars (hd dearer than turbo) | **no** | **no** | already a vendor of ours for video |
| PlayHT | could not read (play.ht: proxy "502, gateway could not connect") | — | — | third-party pages say it shut down 2025-12-31: **unverified**, treat as unavailable |
| Fish Audio | 1M UTF-8 bytes | "83 languages", list not given: unverified | unverified | dialogue, cloning |

Conclusion for us: for **Uzbek**, ElevenLabs v3/v4 is the only option with dialogue, stitching and
alignment together. Azure (two stock voices) and Gemini TTS ("Northern Uzbek") are the
only other official Uzbek TTS found. They are the candidates for a *second* provider, which under
rule 4 would be a separate, explicit choice a person makes, never a fallback. For Uzbek captions of
uploads, Google Cloud STT and Azure STT both list uz-UZ. Neither has been measured against Scribe
here. Whisper's Uzbek support is not stated by OpenAI.

---

## 10. Recommendation and phased plan

Each phase is one small draft PR, in order. None needs the plan upgrade except where marked.

**P0: stop the quiet failures (no plan change, no spend).**
1. Language gate: `verify_voice` and the Studio quote refuse Uzbek on Multilingual v2, Flash and the
   deprecated Turbo, with the remedy. A test with `SCRIPT_LANGUAGE=Uzbek` and the default model stops
   before spend. (Rule 4.)
2. Error copy keyed on `detail.code` (§6.9), legacy `status` kept; tests for 401/402/403/404/429.
3. Default-voice deadline: a script that lists every channel's saved voice ids and flags the Default
   and Legacy ones (read-only; prints names, not keys); the Create page stops offering expiring ids
   once the owner picks replacements (decision 3).
4. Fix the Scribe credit row note (the page's hourly price, read 2026-11-14) as an owner-apply SQL file, not a migration
   change.

**P1: Scale plan and the first real calls (needs decision 1).**
1. Owner moves the account to Scale, turns the data-use toggle off (decision 4), and accepts the OEM
   terms path; our End User Agreement gains the §3.A clauses (decision 5).
2. Probes through our adapters: `eleven_v4` TTS in uz, ru, en; with-timestamps; Scribe v2 in uz. Only a
   passing probe flips `terms_gate` and makes a model "available". The owner listens to the Uzbek
   sample (quality is not measurable by us yet).
3. Add `eleven_v4` to `ttsModels.ts`; make it the default for new Uzbek channels (decision 2).

**P2: Character voice and Dialogue node.**
1. `voice_ref` on the Character; picker from the account's list, per-org scoping.
2. Dialogue node on Text to Dialogue with timestamps, 2–3 takes, `voice_segments` on the timeline.
3. A credit unit or rule for dialogue (decision 7) and the quote.
4. Probe measures: does a character keep its voice across chained dialogue requests? Report the
   measurement before the UI claims it.

**P3: the rest, each on its own evidence.**
- SFX v3 (before 2027-03-01), Scribe v3, voice-removal webhook receiver, Voice Design behind a slot
  cap, voice changer only if Uzbek is verified, dubbing for uploads.

---

## 11. Owner decisions needed

| # | Decision | Why it is yours | Our recommendation |
| :-- | :-- | :-- | :-- |
| 1 | Move ElevenLabs to **Scale**, and when | Money; OEM §2.B(f) makes it the minimum for any customer use | Yes, right before P1; not before the P0 PRs |
| 2 | Default TTS model for Uzbek channels: v4 or v3 | Changes how every Uzbek video sounds | v4 (stitching, 90+ languages), after you hear the probe |
| 3 | Replacement voices for the 13 expiring Default voices | Brand voice of every channel | Pick from the vendor's replacement table after listening |
| 4 | Data-use toggle off ("Improve the models for everyone") | Covers every customer's data | Off |
| 5 | End User Agreement clauses required by OEM §3.A | Legal text | Have a lawyer add them |
| 6 | Ask ElevenLabs in writing: are individual creators "End Users" (§1.I), and may we name ElevenLabs on the site (§2.B(d))? | Only they can answer | Ask before launch copy |
| 7 | Dialogue pricing: reuse the model's character unit, or a new unit | Pricing policy | Reuse, until the usage API shows a different vendor cost |
| 8 | Government customers: block the voice nodes, or ask ElevenLabs | §2.B(e) | Block until asked |
| 9 | Voice Design and cloning slots: per-customer cap | Slots are shared (Scale 660) | A small cap per org, shown in the UI |

---

## 12. Sources

All read 2026-11-14 with `curl` or Playwright (Chromium); copies under `/tmp/research/el/` in the
research session (not committed). "§" numbers refer to the source's own numbering.

| Id | Source |
| :-- | :-- |
| E1 | https://elevenlabs.io/docs/overview/models (models, languages, character limits, concurrency table, deprecations) |
| E2 | https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4 |
| E3 | https://elevenlabs.io/docs/api-reference/text-to-speech/convert (and `/convert-with-timestamps`) |
| E4 | https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching |
| E5 | https://elevenlabs.io/docs/eleven-api/resources/errors |
| E6 | https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue |
| E7 | https://elevenlabs.io/docs/overview/capabilities/voices ; https://elevenlabs.io/docs/eleven-creative/voices/voice-library ; https://elevenlabs.io/docs/api-reference/voices/search ; https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/voice-design |
| E8 | https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets |
| E9 | https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps |
| E10 | https://elevenlabs.io/pricing/api (cards, plan table, FAQ) |
| E11 | https://elevenlabs.io/docs/overview/capabilities/speech-to-text (supported languages and WER bands) |
| E12 | https://elevenlabs.io/docs/overview/capabilities/voice-changer |
| E13 | https://elevenlabs.io/docs/overview/capabilities/dubbing |
| E14 | https://elevenlabs.io/docs/overview/capabilities/sound-effects |
| E15 | https://elevenlabs.io/docs/overview/capabilities/voice-isolator |
| E16 | https://elevenlabs.io/docs/overview/capabilities/forced-alignment |
| E17 | https://elevenlabs.io/docs/eleven-api/resources/webhooks |
| E18 | https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode |
| E19 | https://elevenlabs.io/docs/eleven-api/concepts/audio-streaming ; https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries |
| E20 | https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices |
| E21 | https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-legacy-voices |
| E22 | https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/can-i-create-a-professional-voice-clone-of-someone-elses-voice |
| E23 | https://elevenlabs.io/docs/help-center/product/voices/voice-design/how-much-does-voice-design-cost |
| E24 | https://elevenlabs.io/docs/eleven-creative/voices/voice-library |
| E25 | https://elevenlabs.io/vla (Voice Library Addendum, "Last Updated 6 March 2026") |
| E26 | https://elevenlabs.io/pricing (plan cards, compare table, FAQ) |
| E27 | https://elevenlabs.io/docs/help-center/legal/audio-detector/will-watermarks-cause-my-content-to-be-flagged-downranked-or-demonetized-on-you-tube-or-other-platforms |
| E28 | https://elevenlabs.io/docs/eleven-api/concepts/voice-cloning |
| E29 | https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models |
| E30 | https://elevenlabs.io/oem-terms ("Last Updated: 28 February 2025") |
| E31 | https://elevenlabs.io/terms-of-use ("Last Updated: 09 October 2026") |
| E32 | https://elevenlabs.io/elevenapi-terms ("Last updated: October 09, 2026") |
| E33 | https://elevenlabs.io/music-terms ("Last updated: 09 October 2026"), Exhibit A |
| E34 | https://elevenlabs.io/use-policy ("Last Updated: 09 October 2026") |

Could not read: none of the ElevenLabs pages above failed. The pricing FAQ answers that are collapsed
("How will I know how many characters/minutes I've used", annual billing) did not expand and are not
used. The overage rate for API plans is not on any page read (§5.1).
