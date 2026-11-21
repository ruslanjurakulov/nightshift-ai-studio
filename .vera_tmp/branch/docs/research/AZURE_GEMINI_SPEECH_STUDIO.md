# Azure AI Speech and Gemini TTS in Nightshift Studio: an Uzbek voice without ElevenLabs Scale

Status: research only, 2026-11-14 (Scout). A follow-up to `docs/research/ELEVENLABS_STUDIO.md`, asked
for by the coordinating session on the owner's behalf: the owner is testing and cannot pay ElevenLabs
Scale yet, and the ElevenLabs OEM terms §2.B(f) block every customer-facing ElevenLabs use
below Scale. No product code is changed, no key was used, no paid call was made. Every figure cites
its official source (§10) with the date read, or says **unverified**. No model of either provider has
been called through an adapter of ours (none exists), so every one of them is **not verified**.

---

## Qisqacha xulosa (egasi uchun)

**Asosiy javob.** Sinov bosqichi uchun ikkala provayder ham qonuniy va arzon yo'l beradi. Ikkalasida
ham ElevenLabs'dagi kabi "kamida Scale tarifi" talabi **yo'q**: oddiy "to'laganingcha" (pay-as-you-go)
hisob bilan mahsulotimiz ichida mijozlarga berish mumkin. Faqat bizning API orqali qayta sotish
mumkin emas.

**Eng muhim faktlar (rasmiy sahifalardan, 2026-11-14):**

1. **Azure: o'zbekcha 2 ta ovoz bor.** Bular `uz-UZ-MadinaNeural` (ayol) va `uz-UZ-SardorNeural`
   (erkak) [A1]. Ularda uslub (style) ham, rol ham yo'q. Fonema, lug'at (lexicon) va viseme ham
   qo'llab-quvvatlanmaydi [A1]. Narxi 1M belgi hisobida [A2] (raqam sotuvchining narx sahifasida).
   10 daqiqalik hikoya bizda **~41–45 kredit** turadi (ElevenLabs'da 216–240 kredit).
2. **Azure'ning bepul (F0) tarifidagi ovozni tijoratda ishlatib bo'lmaydi.** Tijoriy foydalanish
   huquqi faqat **pullik** tarifda beriladi [A5]. F0 faqat ichki tinglash sinovi uchun yaraydi.
3. **Gemini 3.8 Flash TTS "Northern Uzbek"ni qo'llab-quvvatlaydi** [G1]. Bitta so'rovda **2 ta
   so'zlovchi** bo'lishi mumkin [G1]. Narx ovoz davomiyligiga bog'liq: 1 soniya = 25 token [G2].
   10 daqiqa narxi 2027-yil 1-yanvardan **ikki baravar** oshadi [G2]. Gemini **so'z vaqtlarini
   (timestamps) qaytarmaydi**, shuning uchun subtitr uchun alohida STT kerak.
4. **Gemini'ning bepul tarifi ma'lumotni o'qitish uchun ishlatadi.** U yerda yuborilgan matnlarni
   inson ham o'qishi mumkin [G3]. Pullik tarifda bunday emas [G3]. **Muhim:** repodagi hozirgi Gemini
   kaliti **bepul tarifda** ishlaydi (`docs/GEMINI_QUOTA.md`), ya'ni hozirgi ssenariy matnlarimiz ham
   Google'ga o'qitish uchun ketyapti.
5. **O'zbekiston ikkalasida ham bor.** Gemini API Uzbekistan'da ishlaydi [G4]. Azure pay-as-you-go
   taklifi Uzbekistan uchun USD'da ochiq [A9]. Google Cloud'ning Uzbekistan'dagi to'lov tafsilotlari
   **tekshirilmadi**.
6. **O'zbekcha STT:**
   - Azure `uz-UZ` (real-time va batch, soatiga narxlanadi) [A1][A2];
   - Google `chirp`, `chirp_2`, `chirp_3` (`uz-UZ`, daqiqasiga narxlanadi) [G6][G7];
   - ElevenLabs Scribe (soatiga narxlanadi).
7. **Uchta qahramon:**
   - Azure'da o'zbekcha faqat 2 ovoz bor, demak 3 ta farqli o'zbekcha ovoz chiqmaydi.
   - Gemini'da 3-qahramon alohida so'rov bilan qilinadi.
   - Haqiqiy dialog uchun eng yaxshisi hali ham ElevenLabs.

**Tavsiya.**

- **Sinov bosqichi:** Azure S0 (pullik, minimal to'lovsiz). Bu eng arzon va qonuniy o'zbekcha
  hikoya. Gemini **pullik** tarifini ikkinchi nomzod sifatida faqat sinab ko'ramiz.
- **Ishga tushirish (launch):** dialog va ifodali ovoz uchun ElevenLabs Scale, arzon hikoya uchun
  Azure. Gemini sifatini siz eshitganingizdan keyin qaror qilinadi.
- **4-qoida:** ikkinchi provayder har kanal yoki loyiha uchun inson tanlaydigan aniq tanlov
  bo'ladi. U hech qachon "jimgina zaxira" (fallback) bo'lmaydi.

**Sizdan kerak bo'lgan qarorlar (§9):**

1. Azure S0 hisob ochish.
2. Gemini billing'ni yoqish. Bu hozirgi ssenariy matnlari uchun ham kerak.
3. 6 ta ovozdan o'zbekcha paragrafni tinglash: Madina, Sardor va 4 ta Gemini ovozi.
4. Kanal bo'yicha provayder tanlovini UI'da ochish.

---

## 1. Where each fits in the Studio, and where it does not

| Capability | Azure AI Speech | Gemini TTS (+ Google Cloud STT) | Compared with ElevenLabs |
| :-- | :-- | :-- | :-- |
| Uzbek TTS | **Yes**: 2 voices, `uz-UZ-MadinaNeural` (F), `uz-UZ-SardorNeural` (M), type "Standard" [A1] | **Yes**: "Northern Uzbek ✔️" on both `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` [G1] | v3/v4 list `uz` [ELEVENLABS_STUDIO E1] |
| Voices that can speak Uzbek | the two above. The multilingual and HD voices are not shown with `uz` on the language page [A1]: **unverified** for Uzbek | 30 prebuilt voices plus an "Extended Voice Library" of "hundreds"; the model "detect[s] the input language automatically" [G1], so any voice may read Uzbek. Quality per voice is **not measured** | thousands of voices; filter by language [E7] |
| Emotion / style | uz-UZ: the "Style/Roles" column is **empty** [A1]. No `express-as` for Uzbek | `speech_metadata.style` per turn and inline tags (`<laugh>`, `<sigh>`, `<short pause>`) [G1]. Whether they work in Uzbek is **not measured** | audio tags on v3/v4 |
| Multi-speaker in one request | several `<voice>` elements in one SSML document (≤ 50 voice/audio tags) [A3][A4]; each voice reads its own turn alone. "Multi-talker" (coherent dialogue) exists only as `en-US-MultiTalker-Ava-Andrew:DragonHDLatestNeural` [A3] | **2 speakers** per request with prebuilt voices; designed or replicated voices must be "synthesize[d] each speaker's turn individually" [G1] | Text to Dialogue: up to 10 voices, coherent turns |
| Word timestamps | `WordBoundary` event in the Speech SDK: "the current word's time offset … from the beginning of the output audio" [A6]. That it fires for uz-UZ is **unverified** (not listed as excluded) | **None documented** on the TTS page [G1]. Captions and scene timing need an STT pass | character alignment with every TTS call |
| Visemes (lip timing) | **Not for uz-UZ** (footnote 3: "Phonemes, custom lexicon, and visemes aren't supported") [A1] | none | none |
| Pronunciation control | SSML; **custom lexicon and phonemes not supported for uz-UZ** [A1] | prompt and style only | pronunciation dictionaries (≤ 3 per request) |
| Request stitching / continuity | none: each request is independent | none documented; "rely on the voice reference for stability" [G1] | `previous_request_ids` on v4 |
| Custom voice / cloning | Professional and Personal voice are **Limited Access**: "Only customers managed by Microsoft, meaning those who are working directly with Microsoft account teams, are eligible" [A7]. uz-UZ is not a personal-voice target [A1] | Voice design and voice replication on 3.8 models [G1]. Replication needs a consent clip in a listed language, and **Uzbek is not on the consent-phrase list** [G5]. Stored voices: 200 per project, 1-year TTL [G1] | IVC Starter+, PVC Creator+ |
| Dubbing / translation | Video Translation: uz-UZ as standard voice source and target [A1]; priced per hour of input and of output video [A2] | none in TTS; translate the script with Gemini text, then TTS | Dubbing v1/v2 |
| Uzbek STT | **Yes**: real-time, monolingual post-stream refinement, batch, fast transcription; custom speech with plain text [A1] | Google Cloud STT V2: `uz-UZ` on `chirp`, `chirp_2`, `chirp_3`, with automatic punctuation; **no diarization** for uz-UZ [G6] | Scribe, "Good" 10–20% WER |
| Output formats | many, e.g. `riff-24khz-16bit-mono-pcm`, `audio-48khz-192kbitrate-mono-mp3`, `ogg-48khz-16bit-mono-opus` [A8] | WAV (unary default) or raw `audio/l16`, 24 kHz mono 16-bit; also mu-law/A-law; `sample_rate` 24000/16000/8000 [G1] | MP3/PCM/WAV/Opus up to 48 kHz |

**Where they belong in the Studio:**

- **Narration node:** both providers can narrate in Uzbek.
- **Character voices:**
  - Azure gives exactly two distinct Uzbek voices.
  - Gemini gives many voices, at unmeasured quality.
- **Dialogue node:**
  - Azure: per-turn SSML only.
  - Gemini: 2 speakers natively, plus per-turn calls for a third.
  - The coherent turn-taking of a real dialogue scene still needs ElevenLabs.
- **Captions:**
  - Azure STT, Google STT and Scribe all list `uz-UZ`.
  - With Azure TTS, the `WordBoundary` events may give timing for free (probe it).
  - With Gemini TTS, timing always needs an STT pass.
- **Not for:**
  - lip-sync timing (neither provider gives Uzbek visemes);
  - custom voices of users on Azure (Limited Access);
  - Uzbek-speaker voice replication on Gemini (no Uzbek consent phrase).

---

## 2. Two or three characters in one project

### 2.1 Azure

- One SSML document may hold several voices: "Within the `speak` element, you can specify multiple
  voices … For each voice, the text must be wrapped in a `voice` element" [A3]. Limit: "Maximum total
  number of distinct `<voice>` and `<audio>` tags in SSML: 50" per request; 10 minutes of audio per
  request [A4].
- For Uzbek there are **two** voices and **no styles or roles** [A1], so:
  - two characters: Madina and Sardor;
  - a third character: the same timbre shifted with `<prosody pitch/rate>`. That is a workaround,
    not a third voice, and the UI must say so ("Character C uses Sardor's voice, pitched up").
- No coherent turn-taking: "single-talker models … synthesize each turn in isolation"; the coherent
  multi-talker voice exists only for en-US [A3].
- Timing: one SSML document yields one audio file; the `WordBoundary` and `Bookmark` events give
  offsets inside it [A6]. Whether they fire for uz-UZ is to be probed.
- Billing counts markup: "All markup within the text field of the request body in the SSML format,
  except for `<speak>` and `<voice>` tags" [A10]. A `<prosody>` wrapper is billed; `<voice>` is not.

### 2.2 Gemini

- Format: `speech_config.speakers = [{"speaker": "Joe", "voice": "Puck"}, {"speaker": "Jane",
  "voice": "Kore"}]`, and one content item per turn with `speech_metadata.speaker` and an optional
  turn-level `style` [G1].
- Limit: "Single-request multi-speaker generation (`speech_config.speakers`) supports up to 2 speakers
  using prebuilt voices" [G1]. For three characters, or any designed voice, synthesize per turn and
  concatenate the 24 kHz PCM (strip each WAV's 44-byte header, or request `audio/l16`) [G1].
- Consistency: "Gemini 3.8 TTS models are trained to anchor on the audio reference first"; long
  "Director's Notes" style blocks are "the most common cause of voice drift"; carry a designed
  `voice_...` id instead [G1]. A designed voice is stored for 1 year (200 per project) [G1]. That is a
  TTL the Character node must show and renew, never let lapse silently.
- Timing: no timestamps are returned [G1]. Line timing in a two-speaker request is unknown without
  an STT or alignment pass; per-turn requests give per-line durations for free, from the file
  lengths.
- Output cap: 16,384 output tokens per request [G8], at 25 tokens per second of audio [G2], is about
  655 s (≈ 10.9 min).

### 2.3 On our canvas

The Character node's `voice_ref` (ELEVENLABS_STUDIO §3.8) gains a `provider` field. The voice picker
lists per provider, and a voice from one provider is never offered as a stand-in for another's.

The Dialogue node shows what each provider can do:

- **ElevenLabs:** "dialogue (turns aware of each other)".
- **Gemini:** "2 voices together, a 3rd separately".
- **Azure:** "each line separately; 2 Uzbek voices".

---

## 3. Text→voice and voice→text, Uzbek checked per model and voice

Official language pages, read 2026-11-14:

| Direction | Provider / model | Uzbek | Source |
| :-- | :-- | :-- | :-- |
| TTS | Azure `uz-UZ-MadinaNeural` (F), `uz-UZ-SardorNeural` (M) | yes, Standard, no style/role, no voice conversion | [A1] |
| TTS | Azure multilingual and Dragon HD voices | `uz` not shown on the language page: **unverified** | [A1] |
| TTS | Azure Personal voice | uz-UZ not a target ("Personal voice target: No") | [A1] |
| TTS | Gemini `gemini-3.8-flash-tts` | yes, "Northern Uzbek" | [G1] |
| TTS | Gemini `gemini-3.8-flash-lite-tts` | yes, "Northern Uzbek" | [G1] |
| TTS | Gemini `gemini-3.1-flash-tts-preview`, `gemini-2.5-pro-preview-tts` | legacy; 3.1 shuts down 2026-12-18 | [G9] |
| TTS | Google Cloud TTS Chirp 3 HD | **no** uz-UZ | competitor pass, `cloud.google.com/text-to-speech/docs/chirp3-hd` |
| STT | Azure uz-UZ | real-time ✅, monolingual refinement ✅, batch ✅, fast transcription ✅, custom speech (plain text) | [A1] |
| STT | Google Cloud `chirp`, `chirp_2`, `chirp_3` uz-UZ | yes (auto punctuation; chirp_2 adds word-level confidence; no diarization) | [G6] |
| STT | ElevenLabs Scribe v2/v3 | yes, "Good" band | ELEVENLABS_STUDIO [E11] |
| Translation | Azure Video Translation uz-UZ | standard voice source and target | [A1] |

What the two directions give the Studio:

- **Text → voice:** narration and character lines in uz/ru/en.
  - Translation is Gemini text plus TTS, so the script stays ours and the fact-check state carries
    over.
- **Voice → text:**
  - captions of uploads;
  - transcripts for voice-over replacement;
  - timing for Gemini narration.

Region note for Google STT: uz-UZ `chirp_3` is listed in `us` and `eu`; `chirp`/`chirp_2` in
`us-central1`, `europe-west4` and `asia-southeast1` [G6].

---

## 4. Pricing audit

### 4.1 Official prices

**Azure** (azure.microsoft.com/en-us/pricing/details/speech, region shown "Central US", USD, read
2026-11-14 [A2]):

The figures are on the vendor pricing page (read 2026-11-14); the price itself lives in the DB price
table / model registry, not in prose. What the page prices:

| Item | Billed |
| :-- | :-- |
| TTS Neural / Neural HD Flash, real-time and batch | per 1M characters |
| Free tier (F0) | 0.5M characters per month (neural); 5 audio hours STT |
| Commitment tiers, TTS Neural | prepaid character blocks with an overage rate per 1M |
| Professional custom voice | per 1M chars (HD dearer); training per compute hour, capped; hosting per model per hour (Limited Access) |
| STT real-time | per hour |
| STT batch | per hour, cheaper than real-time |
| Video translation | per hour of input and of output (standard voice) |
| Billing unit | "speech synthesis usage is billed per character" |

**Gemini TTS** (ai.google.dev/gemini-api/docs/pricing, read 2026-11-14 [G2]); `gemini-3.8-flash-tts`,
per 1M tokens:

| Tab | Free tier | Paid: text input and audio output |
| :-- | :-- | :-- |
| Standard | free of charge; "Used to improve our products: Yes" | priced; **doubles** after 2026-12-31 |
| Batch | not available | half of Standard; doubles after 2026-12-31 |
| Flex | not available | as Batch |
| Priority | not available | dearer than Standard; doubles after 2026-12-31 |

The figures are on the vendor pricing page (read 2026-11-14), not in this document.

Footnote: "Audio tokens correspond to 25 tokens per second of audio" [G2]. (The token guide's
"32 tokens per second" is for audio **input** to understanding models [G10], not TTS output.)

**Google Cloud STT V2** (cloud.google.com/speech-to-text/pricing, read 2026-11-14 [G7]):

| Item | Billed |
| :-- | :-- |
| Recognition, Standard (includes `chirp`) | per minute, for 0–500,000 minutes a month |
| Recognition with data logging | first 60 minutes per month free |
| Dynamic batch recognition, Standard | per minute, cheaper than Standard |

The figures are on the vendor pricing page (read 2026-11-14), not in this document.

### 4.2 Our credit price

The convention is the one in `docs/sql/prices_defaults_2026_10_03.sql` (vendor cost converted to
credits, times the voice margin); the vendor cost and the margin live in the DB price table, not in
prose. The proposed charged prices:

| Unit (proposed name) | Charged |
| :-- | --: |
| `model_azure_tts_neural_character` | **0.0045 cr/char** |
| `model_gemini_3_8_flash_tts_audio_second` (to 2026-12-31) | **0.0675 cr/s** |
| same, from 2027-01-01 | **0.135 cr/s** |
| `model_gemini_3_8_flash_tts_input_token` (to 2026-12-31) | 0.00015 cr/token |
| `model_azure_stt_uz_second` (batch) | 0.015 cr/s |
| `model_google_stt_chirp_second` | 0.08 cr/s |

Gemini bills by **output audio duration**, which is not known before the call. The quote must hold
an upper bound and capture the actual usage reported by the response; the backend computes both, and
the UI shows "up to N cr". Whether the response reports output tokens for TTS is **unverified**.

### 4.3 Worked examples

Assumptions (same as the ElevenLabs doc): 9,000–10,000 characters for 10 minutes; a 60-second,
about 1,000-character dialogue scene.

**A 10-minute Uzbek narration:**

| | Azure Neural | Gemini 3.8 Flash TTS (to 2026-12-31) | Gemini (from 2027-01-01) | ElevenLabs v4 |
| :-- | --: | --: | --: | --: |
| Billed by | characters | 600 s × 25 tok/s of audio output + text tokens* | ×2 | characters |
| Our charge | **41–45 cr** | 40.5 + ≤ 1.5 = **≈ 42 cr** | **≈ 84 cr** | 216–240 cr |
| Captions | Azure STT batch 600 s: 9 cr, or `WordBoundary` (free, if it works for uz) | must transcribe: Azure batch 9 cr, or Google 48 cr | same | free (alignment) |

\* Text tokens for 10,000 characters are counted as at most 10,000 (one token per character, a
deliberate upper bound; Uzbek tokenisation is **not measured**).

**A 3-character dialogue scene (60 s, ~1,000 characters, one take):**

| | Azure (2 Uzbek voices + 1 pitched) | Gemini (2 in one request + 1 per turn) | ElevenLabs Text to Dialogue |
| :-- | --: | --: | --: |
| Billed by | ~1,100 billable chars incl. `<prosody>` markup | 60 s × 25 tok/s of audio output + text | characters |
| Our charge | **≈ 5 cr** | **≈ 4–5 cr** | 24 cr |
| Distinct Uzbek voices | 2 | 3 (quality not measured) | 3 |
| Turns aware of each other | no | yes for the 2 in one request | yes |

### 4.4 Minimum plan

- **Azure:** none. A Standard (S0) resource on the pay-as-you-go offer is a paid tier. The
  commercial-use right attaches to "the paid tier TTS Service only" [A5]; F0 output has no such
  right, so F0 is for internal listening only.
- **Gemini:** none. "Paid Services" means a Cloud project with an active billing account [G3]. The
  free tier is legal outside the EEA, Switzerland and the UK, but it is data-for-training (§5.3), so
  no customer text may go through it.

---

## 5. Commercial and legal terms

### 5.1 May we offer it to our end users inside our product?

**Azure: yes, as a Customer Solution; no resale.** From the Microsoft Product Terms, Microsoft Azure
(read 2026-11-14) [A5]:

- Limitations: "Customer may not resell or redistribute the Microsoft Azure Services".
- Azure Customer Solution: "Customer may create and maintain a Customer Solution. Despite anything
  to the contrary in Customer's licensing agreement, Customer may permit third parties to access and
  use the Microsoft Azure Services solely in connection with the use of that Customer Solution."
  Customer is responsible for "ensuring that third parties who access, use or distribute the Customer
  Solution comply with these terms".
- Foundry Tools: "Customer will not use and will not allow third parties to use Foundry Tools or data
  from Foundry Tools to create, train, or improve (directly or indirectly) a similar or competing
  product or service."
- TTS output: "For Customers of the paid tier TTS Service only, Customer may use the audio output of
  prebuilt neural voices generated using the TTS Service, including for commercial purposes."
- Retirement: "Microsoft will provide Customer with 12 months' notice before discontinuing a
  Microsoft Azure Service or removing any material feature", except Previews.
- Universal License Terms, Microsoft Generative AI Services [A11]: no web scraping, no reverse
  engineering, and "Customer will not use … a Microsoft Generative AI Service to generate Output
  Content for the express purpose of creating synthetic training data to develop or train AI models
  … that have substantially similar functionality".
- Microsoft Enterprise AI Services Code of Conduct (ms.date 2026-05-01) [A12]:
  - "Disclose when the output … [is] generated by AI, including the synthetic nature of generated
    voices".
  - No impersonation "without explicit and valid consent".
  - Never "simulate the voice or image of politicians or government officials, even with their
    consent".

**Gemini: yes, inside an API Client; no thin wrapper.**

- Gemini API Additional Terms ("Effective March 23, 2026") [G3]:
  - "Use of Google AI Studio and Gemini API is for developers building with Google AI models for
    professional or business purposes, not for consumer use."
  - "You may only access the Services (or make API Clients available to users) within an available
    region. You may use only Paid Services when making API Clients available to users in the
    European Economic Area, Switzerland, or the United Kingdom."
  - "You must be 18 years of age or older to use the APIs. You also will not use the Services as
    part of a website, application, or other service … that is directed towards or is likely to be
    accessed by individuals under the age of 18."
  - "You may not use the Services to develop models that compete with the Services."
  - "Google won't claim ownership over that content."
- Google APIs Terms of Service ("Last modified: November 9, 2021") §4.a [G11]: you may not
  "Sublicense an API for use by a third party. Consequently, you will not create an API Client that
  functions substantially the same as the APIs and offer it for use by third parties."
- Google Cloud Terms of Service, which govern Paid Services billing and Cloud STT [G12]:
  - §1.1: Customer may "integrate the GCP Services … into any Customer Application that has
    material value independent of the Services".
  - §3.3(c): Customer will not "sell, resell, sublicense, transfer, or distribute any or all of the
    Services".

**Web-only versus API passthrough:** the same rule as ElevenLabs applies to both. A voice node inside
a project is a Customer Solution or API Client "with material value independent of the Services". Raw
TTS exposed through our public API would be the "substantially the same" client or a redistribution.
New registry entries should be `api_exposure: web_only`.

### 5.2 Minimum plan, pay-as-you-go

Neither provider has an OEM-style plan floor in the pages read. Azure S0 pay-as-you-go and Gemini Paid
Services (billing account) are enough [A5][G3]. Azure commitment tiers are optional discounts [A2].

### 5.3 Data use and training

- **Azure, prebuilt TTS:** "Neither input text nor output audio content is stored in Microsoft logs"
  [A13]. Generative AI Services: "will not use Customer Data to train any generative AI foundation
  model, except pursuant to Customer's documented instructions" [A11].
- **Gemini, free tier ("Unpaid Services"):** "Google uses the content you submit to the Services and
  any generated responses to provide, improve, and develop Google products", and "human reviewers may
  read" it [G3].
- **Gemini, paid tier:** "Google doesn't use your prompts … or responses to improve our products";
  prompts and responses are logged "for a limited period of time, solely for detecting and preventing
  violations of the Prohibited Use Policy" [G3]. **The paid tier is exempt from training; the free
  tier is not.**
- **A finding outside voice:** `docs/GEMINI_QUOTA.md` shows the repo's Gemini key hitting "Free Tier"
  limits. Every script, research prompt and fact-check sent today is therefore Unpaid Services data:
  used for improvement and open to human review. Enabling billing fixes it at no code change (that
  document already says so).

### 5.4 Country restrictions

- Gemini API "Available regions" lists **Uzbekistan** [G4].
- Azure pay-as-you-go (MS-AZR-0003P) "Offer availability" lists **Uzbekistan, United States – Dollar
  ($) USD** [A9].
- Google Cloud billing for an Uzbek business: the currency page read does not list Uzbekistan
  [G13]. Whether an Uzbek card or company can open a billing account is **unverified**. A US-dollar
  account from a supported country is a question for the owner, not a guess.

### 5.5 Attribution and naming on our site

- **Azure:** the only attribution rule found is for translations ("reasonably prominent notice that
  the text has been automatically translated") [A5]. No licence to Microsoft logos was found in the
  pages read, so do not use them. Trademark guidelines were **not read**.
- **Gemini:** API Terms §6.b: "You agree to display any attribution(s) required by Google as
  described in the documentation", and Google grants a licence "to display Google's Brand Features
  for the purpose of promoting or advertising that you use the APIs", per the Brand Features
  guidelines [G11] (guidelines **not read**). So "built with Gemini" is allowed within those
  guidelines, unlike ElevenLabs, which needs prior written approval.

### 5.6 Custom and personal voice consent

- **Azure:** custom neural voice and personal voice are **Limited Access**: "Only customers managed
  by Microsoft, meaning those who are working directly with Microsoft account teams, are eligible"
  [A7][A5]. A voice owner needs "explicit written permission" and must be given Microsoft's
  disclosure for voice talent [A5].
- The Code of Conduct also requires, for External Users who clone their voice [A12]:
  - "dynamic recording scripts";
  - a recorded "Microsoft-provided acknowledgement statement";
  - each user "may create voice models based only on their own voice".
- Not reachable for us now.
- **Gemini:** voice replication needs `consent_audio` of the same speaker reciting "I am the owner
  of this voice and I consent to Google using this voice to create a synthetic voice model", in one
  of the listed consent languages [G5]. **Uzbek is not listed**; Russian and English are. Stored
  voices expire after 1 year [G1].

---

## 6. Technical limits

| | Azure | Gemini |
| :-- | :-- | :-- |
| Per request | 10 minutes of audio; ≤ 50 `<voice>`/`<audio>` tags; WebSocket SSML ≤ 64 KB [A4] | input ≤ 8,192 tokens; output ≤ 16,384 tokens (≈ 655 s) [G8] |
| Rate | F0: 20 transactions per 60 s (not adjustable). S0: 30 TPS default, adjustable to 1,000 [A4] | per project, by tier, shown in AI Studio [G14]. TTS-specific numbers for 3.8 are **unverified** |
| Batch | batch synthesis: 100 requests per 10 s; 10,000 inputs per job; not on F0 [A4] | Batch tab at half price [G2] |
| Streaming | SDK and WebSocket | `stream: true` → raw `audio/l16` chunks [G1] |
| Timestamps | `WordBoundary`, `Bookmark`, `VisemeReceived` events [A6]; visemes not for uz-UZ [A1] | none |
| Errors | 401 "key or token is valid and in the correct region" (a bad key and a wrong region give the same code); 429 "exceeded the quota or rate"; 400, 415, 502, 503 [A8]. "Most HTTP 429 errors with text-to-speech standard voice are caused by limited backend service capacity for a specific voice in the selected region, not by quota limits" [A4] | `429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE` → back off; `403 PERMISSION_DENIED` for a restricted project, free-tier verification, "Payment needed", or a key "reported as leaked or blocked" [G15]. The code for an invalid key and for an unsupported location was **not read** |
| Lifecycle | 12 months' notice before discontinuing a service or feature [A5] | 3.8 TTS released 2026-09-22, "No shutdown date announced"; `gemini-3.1-flash-tts-preview` shuts down 2026-12-18 [G9]; **prices double 2027-01-01** [G2] |

Rule 6 for both: name the remedy. For an Azure 401, say "the key is wrong, or it belongs to another
region: check both". For a 429 on a standard voice, say "the voice is busy in this region", not "out
of quota".

---

## 7. Quality honesty and the probe to run

Nothing here measures how Uzbek **sounds**. The language lists are the vendors' claims. Until the
owner listens, every Uzbek voice is "not verified".

**The probe (P1), a few cents in total at the vendor pricing pages' rates:**

1. One fixed Uzbek paragraph, about 600 characters (≈ 40 s). It should contain:
   - oʻ, gʻ and the ʼ letter (U+02BB / U+02BC);
   - a number and a date, a question, and a quoted line;
   - two personal names and a place name.
2. Synthesize it once per voice:
   - Azure `uz-UZ-MadinaNeural` and `uz-UZ-SardorNeural` (S0);
   - Gemini `gemini-3.8-flash-tts` with Kore, Puck, Charon and Leda (paid tier);
   - Gemini `gemini-3.8-flash-lite-tts` with one of those voices.
   - ElevenLabs v4 cannot be called for a customer until Scale; the owner can listen in the
     ElevenLabs web app on his own account, which is non-commercial use.
3. **The owner listens** and scores each clip for naturalness and pronunciation. That is the only
   quality gate.
4. Run a round-trip check: transcribe each clip with Azure uz-UZ, Google `chirp_3` uz-UZ and Scribe,
   and compare the transcripts with the source text. This measures intelligibility, not
   naturalness, and must be labelled that way.
5. Store each clip's provider, model, voice, cost and date. Only a passing probe flips a registry
   entry to available.

---

## 8. Verdict

| | ElevenLabs | Azure AI Speech | Gemini TTS |
| :-- | :-- | :-- | :-- |
| Uzbek TTS | v3, v4 (vendor claim) | 2 voices, no styles | 3.8 Flash and Flash-Lite, many voices |
| Dialogue | Text to Dialogue, ≤ 10 voices, turns aware of each other | per-turn SSML; 2 Uzbek voices | 2 speakers per request; more per turn |
| Timestamps | character alignment with every call | `WordBoundary` (uz to be probed) | none |
| 10-minute narration, our charge | 216–240 cr | 41–45 cr | ≈ 42 cr; ≈ 84 cr from 2027 |
| Minimum plan for customer use | **Scale** (OEM §2.B(f)) | none (S0, paid tier) | none (billing account) |
| Data use | trains unless opted out; Enterprise not | no training; prebuilt TTS not logged | paid: no training; free: training and human review |
| Uzbek STT | Scribe (per hour) | batch (per hour) | Google Cloud `chirp*` (per minute; dynamic batch cheaper) |
| Custom voice for users | IVC on paid plans | Limited Access only | replication, no Uzbek consent phrase |
| Main risk | cost floor; Default voices expire 2026-12-31 | only 2 Uzbek voices; no expressiveness | new model; no timestamps; price doubles 2027-01-01; under-18 clause |

**Testing phase (now):**

- **Azure S0 pay-as-you-go** for Uzbek narration. It is the cheapest legal path: paid tier, no
  minimum, no training, Uzbekistan in USD.
- Captions from Azure uz-UZ batch STT, or from `WordBoundary` if the probe shows it works.
- **Gemini, paid tier only**, as the second candidate for character voices, once the owner has
  listened.
- Enable Gemini billing anyway (§5.3).

**Launch:**

- ElevenLabs Scale for dialogue scenes and expressive narration.
- Azure as the budget Uzbek narrator.
- Gemini only if the probe beats Azure for character voices.
- Captions: TTS alignment where it exists, otherwise Azure or Google STT for Uzbek uploads (cheaper
  than Scribe at batch rates; accuracy not compared).

**Rule 4:** a second provider is a choice a person makes per channel or project, shown on the Narration
and Character nodes. It is never a fallback: if the chosen provider fails, the node stops with its
remedy. `verify_voice` gains the same per-provider checks (key present, voice exists, language
supported) before any spend.

**Small PRs this implies:** each is one draft PR, in this order.

1. Owner-apply SQL with the proposed credit units (unpriced until approved).
2. Registry entries for `azure-tts-neural` and `gemini-3.8-flash-tts`, both `plan_required: null`,
   `web_only`, `confirmed: false`.
3. The adapters and the probe script.
4. Per-provider voice pickers on the Character node.
5. `verify_voice` per provider.

---

## 9. Owner decisions needed

| # | Decision | Recommendation |
| :-- | :-- | :-- |
| 1 | Open an Azure Speech S0 resource (pay-as-you-go, USD), and in which region | Yes; a region near the voices' capacity, chosen after the probe (429 note in §6) |
| 2 | Enable Gemini billing (paid tier) | Yes: needed for any customer text, and it stops today's scripts going to training |
| 3 | Listen to the 7 probe clips and pick the Uzbek voices | Required before anything is offered |
| 4 | Allow a per-channel provider choice (ElevenLabs / Azure / Gemini) | Yes, as an explicit setting, never a fallback |
| 5 | Pricing: approve the proposed credit units (§4.2) | Review |
| 6 | Under-18 clause (Gemini): our "made for kids" channels | Ask a lawyer whether a creator tool whose *output* targets children is "likely to be accessed by individuals under 18" |
| 7 | Google billing from Uzbekistan | Check with Google, or bill through a supported country |

---

## 10. Sources

All read 2026-11-14 with curl or Playwright; copies in `/tmp/research/az`, `/tmp/research/gg` and
`/tmp/research/competitors` of the research session (not committed). "ms.date" is Microsoft's page
date.

| Id | Source |
| :-- | :-- |
| A1 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support (STT, TTS voices, visemes, video translation tables; footnote 3) |
| A2 | https://azure.microsoft.com/en-us/pricing/details/speech/ (region "Central US", USD) |
| A3 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice (ms.date 2026-01-30) |
| A4 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits (ms.date 2026-10-02) |
| A5 | https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/MCA (Product Terms: Limitations, Azure Customer Solution, Retirement, Microsoft AI Services, Limited Access, Foundry Tools, TTS Services) |
| A6 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis (ms.date 2026-02-25) |
| A7 | https://learn.microsoft.com/en-us/legal/cognitive-services/speech-service/text-to-speech/limited-access |
| A8 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech (ms.date 2026-05-21) |
| A9 | https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0003p ("Offer availability") |
| A10 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech ("Billable characters") |
| A11 | https://www.microsoft.com/licensing/terms/product/ForOnlineServices/all (Universal License Terms, Microsoft Generative AI Services) |
| A12 | https://learn.microsoft.com/en-us/legal/ai-code-of-conduct (ms.date 2026-05-01) |
| A13 | https://learn.microsoft.com/en-us/legal/cognitive-services/speech-service/text-to-speech/data-privacy-security (ms.date 2026-02-25) |
| G1 | https://ai.google.dev/gemini-api/docs/speech-generation (languages, models, multi-speaker, formats, limitations) |
| G2 | https://ai.google.dev/gemini-api/docs/pricing (Gemini 3.8 Flash TTS; "25 tokens per second of audio") |
| G3 | https://ai.google.dev/gemini-api/terms ("Effective March 23, 2026") |
| G4 | https://ai.google.dev/gemini-api/docs/available-regions |
| G5 | https://ai.google.dev/gemini-api/docs/voice-replication (consent requirements and phrases) |
| G6 | https://cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages ("Last updated 2026-11-10 UTC") |
| G7 | https://cloud.google.com/speech-to-text/pricing |
| G8 | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts (token limits) |
| G9 | https://ai.google.dev/gemini-api/docs/deprecations |
| G10 | https://ai.google.dev/gemini-api/docs/tokens |
| G11 | https://developers.google.com/terms ("Last modified: November 9, 2021") |
| G12 | https://cloud.google.com/terms |
| G13 | https://cloud.google.com/billing/docs/resources/currency |
| G14 | https://ai.google.dev/gemini-api/docs/rate-limits |
| G15 | https://ai.google.dev/gemini-api/docs/troubleshooting |

Could not read or not found: Azure trademark guidelines and Google Brand Features guidelines (not
fetched); the Google Cloud billing countries for Uzbekistan; TTS-specific rate limits for Gemini 3.8;
the Gemini error code for an invalid key or an unsupported location; whether Azure multilingual voices
speak Uzbek.
