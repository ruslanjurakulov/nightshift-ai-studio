# Terms review of the gated models — which we can open next

Scout research, read 2026-11-14. Research only: no registry entry, migration, price or gate was changed, no model was
opened, and no paid API call was made. Every page below was read on 2026-11-14 with `curl -sL -A "Mozilla/5.0"` or the
preinstalled Chromium (Playwright); the copies were saved under `/tmp/terms/` in the research container and are not
committed.

## Qisqacha (egasi uchun)

- **Ochilmagan 43 ta modeldan:** hozir shartsiz ochiladigani **0 ta**; tasdiqlash qadami (acknowledgement) bilan
  ochsa bo'ladigani **21 ta** (Google 5, BFL 6, Recraft 2, xAI 3, Meta 1, LTX 4); vendordan yozma ruxsat kerak **14 ta**
  (Kling 3, Vidu 4, Pika 2, Krea 2, Sonilo 2, AssemblyAI 1); ruxsat yo'q **2 ta** (Runway upscale — sizning qoidangiz;
  gemini-omni-1.1-flash — 2026-12-03 dan 1.2 ga yo'naltiriladi); aniqlab bo'lmadi **6 ta** (3 ta generic video op —
  vendor yo'q; 3 ta gemini-2.5 op — hech qachon real chaqirilmagan va 2027-03-15 da yopiladi).
- **Narxi yo'q 5 ta modeldan** 4 tasining narxi topildi: OpenAI 3 ta (token → rasm formulasi, har sifat va o'lcham
  uchun jadval; bitta probe ≈ $0.006), Hailuo 2.3 (klip uchun: $0.28 / $0.56 / $0.49; probe $0.28). ideogram-upscale
  narxi o'qilmadi (sahifa narxni yuklamaydi).
- **Eng muhimi:** "acknowledgement bilan ochiladi" degani shartlar ruxsat beradi, lekin **faqat veb-Studio** ichida.
  API/MCP orqali to'g'ridan-to'g'ri uzatish (passthrough) deyarli hamma vendorda taqiqlangan; hammasi `web_only`
  qolishi kerak.
- **Google, Meta, xAI** 18 yoshdan kichiklarni taqiqlaydi: ro'yxatdan o'tishdagi yosh tekshiruvi (PR #689) jonli
  bo'lmaguncha bularni ochmang. **BFL, Pika** prompt va rasmlarni o'z modellarini o'qitishga oladi — maxfiylik
  siyosatiga bir qator qo'shilishi kerak.
- **Keyingi ochish tartibi:** 1) Nano Banana Pro (`gemini-3-pro-image`), 2) `flux-3-image`, 3) `grok-imagine-video-1.5`,
  4) `ltx-2.5-pro`, 5) `gemini-3.1-flash-image` — batafsil pastda.
- Bu hujjatning o'zi hech narsani ochmaydi: 0163 dagi qoidalar bo'yicha har bir model uchun yana real probe, registrdagi
  narx va sizning `terms_gate` ni tozalash qaroringiz kerak.

## How a model becomes "openable" here

The gates are the ones migration 0163 (`claude/open-cleared-models`, PR #736) applies before a model goes on sale: a
successful real probe (`verified_at`), an empty `spec.terms_gate` (the owner's legal decision), the adapter and vendor
model the file was written for, a vendor price for every priced variant, no `blocked_countries` the database cannot
enforce yet (0142), not past an announced shutdown (0125), not disabled, and `api_exposure: web_only`. 0035's CHECK
`terms_before_sale` refuses beta/ga while a terms gate is set.

This review answers only the terms question and the price question. A verdict of "openable" means **the vendor's
published terms permit it and the owner may clear the gate**; the other gates still apply.

Our use, as read against each vendor's terms: Nightshift Studio is a web application; a customer buys credits from
Nightshift and spends them on generations that Nightshift requests from the vendor with Nightshift's own key. Some
models are also reachable through our public API/MCP, where `api_exposure` decides. These two uses are answered
separately below because almost every vendor treats them differently.

**One reading rule, applied to every vendor.** Where a vendor's terms *expressly* license an application that end users
use (BFL 2(a), Recraft 3.1/3.5, LTX 2.1(b), xAI 1(b)–(c), Meta §1, Runway §1, Google's "make API Clients available to
users"), we read that vendor's general "no competing product" clause as not reaching a studio that integrates the
model, and we say so as **our reading**, not the vendor's. Where the grant is missing, conditional on an unread plan, or
paired with a clause that names selling (Kling 3.3, Vidu clause 4, Pika §5, Sonilo 11/12.2, AssemblyAI 2.1/2.4(d),
Krea), the verdict is **written permission**.

## Acknowledgement kinds

The planned rights-acknowledgement kinds: `likeness_photo` (an uploaded or depicted real person, with their consent),
`voice_clone` (none of the 48 needs it), `third_party_content` (uploaded material, brands, styles or works belonging
to someone else). A model that only takes a text prompt still needs `likeness_photo` where the vendor's policy bars
generating a real person without consent, because the prompt can name one.

## The 48 models

Price columns quote the vendor's page as read; "registry" means the figure already in `schemas/model_registry.json`
matched the page.

| Model | Vendor | Verdict | Deciding clause (URL) | Ack kind | Price (URL) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| gemini-3-pro-image | Google | **Ack** + 18+ gate live | "make API Clients available to users" within an available region; 18+ only [G1] | likeness_photo, third_party_content (edit) | $0.134 / image 1K–2K, $0.24 4K [G4] |
| gemini-3.1-flash-image | Google | **Ack** + 18+ gate | as above [G1] | likeness_photo, third_party_content | $0.045 512, $0.067 1K, $0.101 2K, $0.151 4K [G4] |
| gemini-nano-banana-2.1 | Google | **Ack** + 18+ gate | as above [G1] | likeness_photo, third_party_content | $0.0336 1K, $0.0504 2K, $0.113 4K [G4] |
| gemini-3.1-flash-lite-image | Google | **Ack** + 18+ gate | as above [G1] | likeness_photo, third_party_content | $0.0336 1K [G4] |
| gemini-3.6-flash (describe) | Google | **Ack** + 18+ gate | as above [G1] | third_party_content (uploaded image) | per token: $0.75 in / $3.75 out per 1M until 2026-12-31, **$1.50 / $7.50 from 2027-01-01** [G4md] |
| gemini-omni-1.1-flash | Google | **Not allowed** (shutdown) | "Effective December 3, 2026, all API requests to gemini-omni-1.1-flash automatically route to gemini-omni-1.2-flash and are billed at gemini-omni-1.2-flash rates" [G4] | — | ~$0.10/s 720p; 1.2 is ~$0.07/s [G4] |
| gemini-2.5-flash-image-expand | Google | **Could not determine** | terms as [G1], but no real call was ever made (registry) and Google: "deprecated and will be shut down on March 15, 2027" [G4] | likeness_photo | $0.039 / image up to 1024² (gemini-2.5-flash-image) [G4] |
| gemini-2.5-flash-image-relight | Google | **Could not determine** | as above | likeness_photo | $0.039 / image [G4] |
| gemini-2.5-flash-image-erase | Google | **Could not determine** | as above | likeness_photo | $0.039 / image [G4] |
| flux-3-image | BFL | **Ack** + privacy line | API Terms 2(a): licence "to develop and operate integrations whereby End Users of a Developer Application can interface with the FLUX AI Models" [B1] | likeness_photo | $0.041 768², $0.048 1K, $0.07 1.5K, $0.10 2K, $0.607 4K [B3] |
| flux-3-image-klein | BFL | **Ack** + privacy line | as above [B1] | likeness_photo | $0.008 768², $0.009 1K, $0.011 1.5K, $0.014 2K, $0.036 4K [B3] |
| flux-3-video | BFL | **Ack** + privacy line | as above [B1] | likeness_photo | t2v/i2v $0.15/s HD, $0.24 FHD, $0.28 QHD, $0.41 UHD [B3] |
| flux-2-max | BFL | **Ack** + privacy line | as above [B1] | likeness_photo | $0.07 first MP + $0.03 per added MP; ref image $0.03/MP [B3] (registry null) |
| flux-2-pro | BFL | **Ack** + privacy line | as above [B1] | likeness_photo | $0.03 first MP + $0.015 per added MP; ref $0.015/MP [B3] (registry null) |
| flux-2-flex | BFL | **Ack** + privacy line | as above [B1] | likeness_photo | $0.05 first MP + $0.05 per added MP; ref $0.05/MP [B3] (registry null) |
| recraft-v4.1 | Recraft | **Ack** (fresh call every time) | 3.5: "If you integrate the API into a Developer Application made available to third-party end users …" [R1] | third_party_content (7.3 brands/styles), likeness_photo | $0.035 raster, $0.08 vector, $0.21 pro raster 2K, $0.30 pro vector [R2] |
| recraft-v4.1-flash | Recraft | **Ack** | as above [R1] | third_party_content, likeness_photo | $0.007 / image raster [R2] |
| grok-imagine-video-1.5 | xAI | **Ack** + 18+ gate | Enterprise ToS 1: "(c) distribute or otherwise make the Bundled Service available to Customer's end users" [X1] | likeness_photo | $0.08/s 480p, $0.14 720p, $0.25 1080p; $0.01 per input image [X3] |
| grok-imagine-video-1.5-lite | xAI | **Ack** + 18+ gate | as above [X1] | likeness_photo | $0.02/s 480p, $0.03 720p, $0.14 1080p; $0.01 per input image [X3] |
| grok-imagine-image-2.0 | xAI | **Ack** + 18+ gate | as above [X1] | likeness_photo | $0.04 1K low … $0.08 2K medium; $0.01 per input image [X3] |
| grounded-image-1.0 | Meta | **Ack** + 18+ gate + DB country check | ToS §1 Integrated Products for End Users; 10.1(i) no resale or other access [M1] | likeness_photo | $0.01 per generated image ("billed only for images the model successfully generates") [M3] |
| ltx-2.5-pro | Lightricks | **Ack** (our reading) | API Licence 2.1(b): "to utilize the LTX Model in Customer's Service to be used by End Users" [L1] | likeness_photo, third_party_content | $0.12/s 720p, $0.17 1080p, $0.25 1440p, $0.39 4K [L2] |
| ltx-2.5-fast | Lightricks | **Ack** (our reading) | as above [L1] | likeness_photo, third_party_content | $0.09 / 0.13 / 0.19 / 0.30 per s [L2] |
| ltx-2.3-pro | Lightricks | **Ack** (our reading) | as above [L1] | likeness_photo, third_party_content | $0.04 / 0.08 / 0.16 / 0.32 per s [L2] |
| ltx-2.3-fast | Lightricks | **Ack** (our reading) | as above [L1] | likeness_photo, third_party_content | $0.03 / 0.06 / 0.12 / 0.24 per s [L2] |
| kling-v3 | Kling | **Written permission** (letter of 2026-11-11 pending) | 3.3: "you has no right to disseminate, transfer, license, or provide these resources to others for use" [K1] | likeness_photo | units/s by mode [K2]; 1 unit ≈ $0.149–0.154 by package [K3]; registry $0.084/s |
| kling-v2.6 | Kling | **Written permission** | as above [K1] | likeness_photo | 0.3 units/s 720p, 0.5 1080p (no audio) [K2]; registry $0.042/s |
| kling-4.0-omni-edit | Kling | **Written permission** | as above [K1] | likeness_photo, third_party_content | with input video ≤ output: 0.6 units/s 720p, 0.9 1080p, × 2 [K2]; registry $0.188/s |
| vidu-q3-pro | Vidu | **Written permission** | clause 4: "You may not sell the Vidu-related technology directly or indirectly without obtaining … the prior consent of us." [V1] | likeness_photo | page served in RMB: 1 credit = ¥0.03125; credits/s per model [V2]. Registry USD $0.10/s **not re-confirmed** |
| vidu-q3-turbo | Vidu | **Written permission** | as above [V1] | likeness_photo | RMB credits [V2]; registry $0.06/s not re-confirmed |
| vidu-q3-pro-fast | Vidu | **Written permission** | as above [V1] | likeness_photo | RMB credits [V2]; registry $0.06/s not re-confirmed |
| vidu-q4-preview | Vidu | **Written permission** | as above [V1] | likeness_photo | 78 credits/s at 4K [V2]; registry $0.095/s not re-confirmed |
| pika-2.5 | Pika | **Written permission** | §5: no "sell, resell, sublicense, or provide access … to any third party, except as expressly permitted under your Plan" [P1] | likeness_photo | $0.02/s 480p, $0.04 720p, $0.06 1080p ($0.09 for a 5 s 1080p) [P2] |
| pika-pikaframes | Pika | **Written permission** | as above [P1] | likeness_photo | registry $0.04/s; catalog page for pikaframes not re-read |
| krea-3 | Krea | **Written permission** | no API terms exist at any URL tried; consumer Terms (Last updated May 20, 2024) license users "non-sublicensable and non-transferable" [KR1] | likeness_photo | "Base pricing is $0.03 at 1K or $0.06 at 2K" [KR2] |
| krea-3-regional | Krea | **Written permission** | as above [KR1] | likeness_photo, third_party_content | as above [KR2] |
| sonilo-music | Sonilo | **Written permission** | ToS 4: "You may not use the Service or Outputs to build, train, benchmark, or offer a product or service that competes with Sonilo." 12.2 [S1] | third_party_content | $0.00225/s ($0.135/min) [S2] |
| sonilo-video-music | Sonilo | **Written permission** | as above [S1] | third_party_content (the customer's video) | $0.009/s ($0.54/min) [S2] |
| assemblyai-universal-2 | AssemblyAI | **Written permission** | 2.1: licence "for the internal business purposes of Customer"; 2.4(d): not "for the benefit of a third party or make the Services available to any third party" [A1] | third_party_content (the audio) | $0.15 / hour = $0.0000417/s [A2] (registry null) |
| runway-video-upscale | Runway (Magnific) | **Not allowed** (owner's rule, not Runway's) | owner 2026-11-13: through Runway only Runway's own models; Runway's §1 itself would allow it [RW1] | — | per output frame (registry) |
| generic-video-edit | none | **Could not determine** | no vendor is named; nothing to read | — | none |
| generic-video-reframe | none | **Could not determine** | as above | — | none |
| generic-video-remove-bg | none | **Could not determine** | as above | — | none |
| openai-gpt-image-2.5-flare | OpenAI | price **found** (rule); no terms gate set | not part of the 43; OpenAI's terms and `api_exposure: any` were not re-read here | likeness_photo | see the OpenAI section: $0.00588 low 1024² … $0.21072 max 1024² [O1] |
| openai-gpt-image-2.5-sunburst | OpenAI | as above | as above | likeness_photo | same token counts as Flare [O1] |
| openai-gpt-image-2 | OpenAI | price **found** (rule); low value (shutdown 2027-02-10, registry) | — | likeness_photo | $0.00588 low, $0.05268 medium, $0.21072 high at 1024² [O1] |
| ideogram-upscale | Ideogram | price **not found** | pricing page renders "Loading current prices" and never fills in a headless browser [I1] | third_party_content | not found; see below |
| minimax-hailuo-2.3 | MiniMax | price **found**, per clip; gate cleared by the owner 2026-11-13 | "Legacy Models" table [MM1] | likeness_photo | $0.28 per 768P 6 s, $0.56 per 768P 10 s, $0.49 per 1080P 6 s; no 1080P 10 s [MM1] |

The totals are in the summary at the end.

## Per vendor

### Google — Gemini API (9 models)

Sources: [G1] Gemini API Additional Terms, `https://aistudio.google.com/docs/terms` ("Effective March 23, 2026"; the old
`ai.google.dev/gemini-api/terms` now only redirects there); [G2] Google APIs Terms of Service,
`https://developers.google.com/terms` ("Last modified: November 9, 2021"); [G3] Generative AI Prohibited Use Policy,
`https://policies.google.com/terms/generative-ai/use-policy` ("Last Modified: December 17, 2024"); [G4] pricing,
`https://aistudio.google.com/docs/pricing`, and its Markdown copy [G4md] `https://aistudio.google.com/docs/pricing.md`;
[G5] `https://aistudio.google.com/docs/available-regions`.

1. **Offering to our users.** Studio: allowed. [G1] Use Restrictions: "You may only access the Services (or make API
   Clients available to users) within an available region." API/MCP passthrough: **not allowed.** [G2] §4(a): you may
   not "Sublicense an API for use by a third party. Consequently, you will not create an API Client that functions
   substantially the same as the APIs and offer it for use by third parties." The open question the registry already
   names is [G1]: "Use of Google AI Studio and Gemini API is for developers building with Google AI models for
   professional or business purposes, not for consumer use." **Our reading:** the sentence governs who may *use the
   API* (a business, which Nightshift is), and the next sentence expressly contemplates making API Clients available to
   users; it does not say the API Client's users must be businesses. This is our reading, not Google's; the earlier
   notes asked for a lawyer and that remains the owner's call.
2. **Commercial use, attribution.** [G1] "Google won't claim ownership over that content." No attribution duty for
   image output; output carries SynthID (registry).
3. **End-user obligations.** [G1] "You must be 18 years of age or older to use the APIs. You also will not use the
   Services as part of a website, application, or other service … that is directed towards or is likely to be accessed
   by individuals under the age of 18." → the sign-up age gate (PR #689) must be live first. [G3] bars "using personal
   data or biometrics without legally-required consent", "Impersonating an individual (living or dead) without explicit
   disclosure, in order to deceive", sexually explicit content, and "Misrepresenting the provenance of generated
   content". [G2] §2(a): "You will require your end users to comply with … the Terms." Data: on Paid Services "Google
   doesn't use your prompts … or responses to improve our products" and "logs prompts and responses for a limited
   period of time, solely for detecting and preventing violations" [G1]; Unpaid quota is used for training and human
   review — **use a billed project only**. Kinds: `likeness_photo` for every model (edit takes a photo; t2i can name a
   person), `third_party_content` for edit and describe.
4. **Countries.** Only the available regions [G5] (Uzbekistan is listed); "You may use only Paid Services when making
   API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom." Billing from
   Uzbekistan: not verified.
5. **Price.** Published per token with a per-image equivalent (table above) [G4]. Note for `gemini-3.6-flash`: the
   per-token price **doubles on 2027-01-01** ($0.75/$3.75 → $1.50/$7.50 per 1M) [G4md].
6. **Verdict.** `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-nano-banana-2.1`, `gemini-3.1-flash-lite-image`,
   `gemini-3.6-flash`: **openable with an acknowledgement step** (`likeness_photo`; `third_party_content` for edits),
   web only, after the 18+ gate is live. `gemini-omni-1.1-flash`: **not allowed in practice** — from 2026-12-03 every
   call is served and billed as 1.2 [G4]; register `gemini-omni-1.2-flash` instead (~$0.07/s at 720p [G4]).
   `gemini-2.5-flash-image-{expand,relight,erase}`: **could not determine** — terms as above, but no real call has ever
   been made (registry) and Google is shutting the model down on 2027-03-15 and says to migrate to 3.1 Flash Lite Image
   [G4]; not worth a probe.

### Black Forest Labs — FLUX (6 models)

Sources: [B1] FLUX API Service Terms, `https://bfl.ai/legal/flux-api-service-terms` ("Last Revised on August 4, 2026");
[B2] Developer Terms of Service, `https://bfl.ai/legal/developer-terms-of-service` (same date; applies outside the EU,
the EU version was not read); [B3] `https://bfl.ai/pricing`; Usage Policy `https://bfl.ai/legal/usage-policy`.

1. **Offering.** Studio: allowed. [B1] 2(a): licence "solely to develop and operate integrations whereby End Users of a
   Developer Application can interface with the FLUX AI Models from within the Developer Application." API/MCP:
   **not allowed.** Same clause: "Developer may not host … an API endpoint to any FLUX AI Models that allows third
   parties to integrate or otherwise use the FLUX AI Models in or with their own products or services." [B2] 6(c) also
   bars a product "that competes with us"; under the reading rule above, the express 2(a) grant covers the Studio.
2. **Commercial use.** [B2] 4(b): "You and your End Users may use Outputs for your or their own personal or commercial
   purposes". No attribution duty found; 6(i): never "Remove, disable, alter, obscure, any Content Credentials".
3. **End users.** [B2] 9(a): where input or output "realistically simulates, the name, image, likeness and/or voice of a
   natural person", the developer warrants "the informed, documented consent of such person" → `likeness_photo`.
   6(j) no images of individuals without consent; 6(k) no "images, videos or personal data … relating to individuals
   under the age of 18". **Training:** [B1] 2(b): BFL gets a "perpetual, irrevocable, worldwide, non-exclusive, and
   fully sublicensable" licence to Input and Output and "may use Inputs and Outputs to train". No opt-out on the pages
   read (the pricing page lists an Enterprise tier; its terms were not read). This needs a line in the Privacy Policy
   and should be said in the acknowledgement.
4. **Countries.** [B2] 2(a): not "located or organized in a U.S.-sanctioned jurisdiction"; 6(l)–(m) export laws. No
   country list of BFL's own.
5. **Price.** Published [B3], table above. FLUX.2 is billed per megapixel, so its registry `null` can now be filled:
   e.g. a 1 MP FLUX.2 [pro] image is $0.03, a 4 MP one $0.03 + 3 × $0.015 = $0.075. How BFL counts a megapixel was not
   stated on the page.
6. **Verdict.** All six: **openable with an acknowledgement step** (`likeness_photo`), web only, after the privacy-notice
   line on BFL's training licence. FLUX.2 is superseded by FLUX 3 in BFL's own table; open FLUX 3 first.

Side finding for the generic video ops: [B3] lists "FLUX Video Edit [fast] … $0.03 /s" under BFL's terms — a candidate
vendor for `generic-video-edit` (not researched further).

### Recraft (2 models)

Sources: [R1] Developer Terms, `https://www.recraft.ai/legal/developer-terms` ("Effective Date: 20 October 2026");
[R2] `https://www.recraft.ai/docs/api-reference/pricing`.

1. **Offering.** Studio: allowed. 3.1 licenses "applications or services that integrate with Recraft's image generation
   and editing capabilities (including, for example, third-party Model Context Protocol (MCP) servers and other AI
   client integrations)"; 3.5 sets the duties "If you integrate the API into a Developer Application made available to
   third-party end users". API/MCP passthrough: 3.1 names MCP servers as an allowed Developer Application, so Recraft is
   the one vendor whose text does not bar it — but 3.1 is "non-sublicensable" and 3.2(x) bars "goods or services that
   compete with Recraft"; keep `web_only` unless Recraft agrees (1.4: "a separate written agreement … including any
   reseller, marketplace, platform, or model distribution agreement … prevails").
2. **Commercial use.** 6.2: "You own all Assets … for personal or commercial use, subject to the following restriction:
   Assets may not be used to train any artificial intelligence model". 6.4: never remove Recraft's metadata or
   watermarks. No attribution duty found. 6.3: Recraft does not train on API Assets.
3. **End users.** 3.5: bind them to terms "at least as protective of Recraft", keep a privacy policy, suspend violators.
   3.7 **No Substitution**: never serve an earlier generation "in place of a new API call" (no cache shared between
   customers). 7.3: prompts in the style of a "third-party brand, trademark, design system, identifiable creator, or
   identifiable individual" need the rights → `third_party_content` and `likeness_photo`. 2.1: the developer must be 18+.
4. **Countries.** 2.1(iii): export-control laws only; no list.
5. **Price.** Published [R2]: V4.1 $0.035 raster / $0.08 vector / $0.21 pro raster 2K / $0.30 pro vector; V4.1 Flash V2
   $0.007; "$1 = 1,000 units", prepaid, non-refundable (5.1).
6. **Verdict.** Both: **openable with an acknowledgement step** (`third_party_content`, `likeness_photo`), web only,
   fresh call per generation.

### xAI — Grok Imagine (3 models)

Sources: [X1] Terms of Service — Enterprise, `https://x.ai/legal/terms-of-service-enterprise` ("Last Updated: October 27,
2026"; party: "SpaceX Super Intelligence LLC"); [X2] Acceptable Use Policy, `https://x.ai/legal/acceptable-use-policy`
("Effective: August 14, 2026"); [X3] `https://docs.x.ai/developers/pricing`. The registry's earlier note that x.ai/legal
answers 403 is no longer true for a real browser: `curl` still gets 403, Chromium read both pages.

1. **Offering.** Studio: allowed. [X1] §1: "(b) use SpaceXSI's application programming interfaces … to develop
   integrations between the Services and Customer's own products or services (each, a 'Bundled Service'); and (c)
   distribute or otherwise make the Bundled Service available to Customer's end users". API/MCP passthrough: "Customer
   may only provide End Users with access to the Services as part of a Bundled Service" — a raw passthrough is not a
   Bundled Service; keep `web_only`.
2. **Commercial use.** [X1]: Customer "owns all right, title, and interest in the Output in perpetuity". No attribution
   duty found. [X2] bars "Stripping, altering or circumventing embedded provenance metadata or watermarks".
3. **End users.** [X1]: "legally enforceable terms of service and an acceptable use policy with all Permitted Users and End
   Users that are no less protective"; suspend an offending End User on request. The Enterprise terms "are for … users …
   who are at least 18 years old". [X2] bars "altering a real person's image or likeness to depict them in an intimate
   or sexual context", "Deceptively impersonating a real person", "Sexualizing or exploiting children" →
   `likeness_photo`. Data: "automatically and permanently deleted no later than 30 days after the end of the
   interaction" unless agreed otherwise; personal data only through the ZDR-enabled API (Zero Data Retention clause).
4. **Countries.** [X1] Export Control and Sanctions: neither party in "any country or territory that is the target of
   comprehensive U.S. sanctions or embargoes". [X3]: "Your model access might vary depending on various factors such as
   geographical location".
5. **Price.** Published [X3], table above. [X3]: "When your request is deemed to be in violation of our usage guideline
   … we will still charge for the generation" (+$0.05 fee when caught before generation in the Responses API) — a
   refused job still costs us money, which the refund-on-failure policy must account for.
6. **Verdict.** All three: **openable with an acknowledgement step** (`likeness_photo`), web only, after the 18+ gate.

### Meta — `grounded-image-1.0` (vendor model `muse-image-1.0`)

Sources: [M1] Model API Terms, `https://dev.meta.ai/legal/terms-of-service` ("Last updated: October 9, 2026");
[M2] Geographic Use Policy, `https://dev.meta.ai/legal/geographic-use-policy` ("Last updated: November 9, 2026");
[M3] `https://dev.meta.ai/docs/pricing-rate-limits`.

1. **Offering.** Studio: allowed — §1 grants the right to build products "that allow end users of your products or
   services ('End Users') to interface with the Services". API/MCP: **not allowed** — 10.1(i): "you may not resell, or
   otherwise provide access to the Services".
2. **Commercial use.** Not restricted on the pages read; no Meta name or mark may be used (registry, ToS 7).
3. **End users.** 10.1: "You and your End Users must be at least 18 years of age … and you will not create Integrated
   Products targeted at individuals under the age of 18." Training: Standard Services content is not used to train
   (5.1). Kind: `likeness_photo`.
4. **Countries.** [M2] §3 Restricted Territories (as read: Afghanistan, Belarus, Cambodia, PRC incl. Hong Kong and
   Macau, Cuba, Eritrea, Ethiopia, Haiti, Iran, Iraq, Libya, Myanmar, Nicaragua, North Korea, Pakistan, Russia, Somalia,
   Syria, Crimea/Donetsk/Luhansk, Venezuela, Western Sahara). Uzbekistan is not listed. The registry's
   `blocked_countries` carries 22 codes; check it against this list (e.g. whether HK and MO are counted separately).
5. **Price.** "$0.01 per image"; "billed only for images the model successfully generates and returns" [M3].
6. **Verdict.** **Openable with an acknowledgement step** (`likeness_photo`), but last of the "Ack" group: it also needs
   the 18+ gate live, the database-level country check (the registry: the web routes check the country, the database
   does not), and the provider name hidden from customers (ToS 7).

### Lightricks — LTX (4 models)

Sources: [L1] LTX-2 API License Agreement, `https://static.lightricks.com/legal/ltx-2-api-license-agreement.pdf` ("Last
Updated: May 12, 2026", 18 pages; found via `https://ltx.io/model/license`, the registry's `docs.ltx.io/api-license.md`
now 404s); [L2] `https://docs.ltx.io/pricing.md`.

1. **Offering.** Studio: allowed on our reading. 2.1 licenses the customer "(b) to utilize the LTX Model in Customer's
   Service to be used by End Users"; 1.19 counts "all downstream users … who interact in any manner with the LTX Model"
   as End Users. 2.2 opens "Except as expressly permitted in this Agreement" and then (d) bars making the model
   "available to any third party through a service bureau, resale or similar models". **Our reading:** a customer using
   LTX inside our Studio is the 2.1(b) Permitted Use; an API/MCP passthrough is the "service bureau, resale" case →
   **not allowed** there. Because the word "resale" sits next to a credits product, a one-line confirmation from
   Lightricks is cheap insurance (contact below); it is not required by the text.
2. **Commercial use.** 4.2 (registry): Input and Output stay the customer's and are not used to train the LTX Model;
   2.2(i): no Output to train competing models.
3. **End users.** 3.2: enforceable agreements at least as protective, enforced; 3.3: we answer for their breaches.
   AUP (registry, 2026-03-30, not re-read): commercially used Output must not replicate a real likeness, brand or
   location unless cleared → `likeness_photo`, `third_party_content`. No age clause found.
4. **Countries.** 2.1: "worldwide (excluding any jurisdictions prohibited by applicable law)".
5. **Price.** Published per second by resolution [L2], table above.
6. **Verdict.** All four: **openable with an acknowledgement step** (`likeness_photo`, `third_party_content`), web only.

### Kling (3 models) — written permission

Sources: [K1] Terms of API Paid Service, `https://kling.ai/document-api/guides/protocols/paid-service` (Effective Date
2026-04-21); [K2] `https://kling.ai/document-api/pricing/base/video`; [K3] `https://kling.ai/dev/pricing`.

3.3: "a non-exclusive, non-transferable or sublicensable … license … you has no right to disseminate, transfer,
license, or provide these resources to others for use"; 3.8: the key "can only be used for the authorized your Client
Application". The terms mention end users only for privacy (5.2) and never grant an end-user application, so the
letter the owner sent on 2026-11-11 (registry) decides. Commercial use of output: 6.4 "is not restricted". Training:
5.1 none. Minors: under 13 barred (12.1). Price: units per second [K2]; packages at $0.15386, $0.15229 and $0.14915 per
unit [K3]. Kinds: `likeness_photo` (+ `third_party_content` for the omni edit's uploaded video). Contact below.

### Vidu (4 models) — written permission

Sources: [V1] Terms of Use, `https://platform.vidu.com/docs/terms-and-policies/terms-of-use` ("Effective on
2025-01-23"); [V2] `https://platform.vidu.com/docs/overview/pricing`.

Clause 4 grants "you are entitled to integrate the API into your applications and authorize your end users to provide
input … and receive output", then: "You may not sell the Vidu-related technology directly or indirectly without
obtaining the necessary approval from regulatory authorities and the prior consent of us." Embargo: output "may not be
sold, transferred, exported or re-exported to (a) any embargoed country or territory". **Price:** the page as served to
this container is in RMB ("Credit Unit Price … 1 … 0.03125", packages ¥500 = 16,000 credits; e.g. "viduq4-preview …
4k … 78credits/second"); "Videos that fail to generate do not consume credits (including failures caused by content
moderation rejection)". The registry's USD figures could not be re-confirmed from this read. Business contact on that
page: `platform@vidu.cn`; the Terms page header shows `platform@vidu.com`; the registry used `platform@vidu.studio`.

### Pika (2 models) — written permission

Sources: [P1] Terms of Service, `https://pika.art/terms-of-service` ("Last modified: 08/04/2026"); [P2] catalog entry
`https://api.dev.pika.art/catalog/apis/pika/pika-2.5/text-to-video` (JSON).

Every right we need is "except as expressly permitted under your Plan": §5 "sell, resell, sublicense, or provide access
… to any third party", "use the Service for any commercial purpose". §4: "the Service is for your personal,
noncommercial use only. If your Plan includes API access or commercial use rights, you may use the Service to build
products". No Plan terms were found. Attribution: "you must display appropriate attribution in a manner reasonably
visible to end users, unless your Plan expressly permits white-labeling" (white-label is enterprise-only). 18+: "you
state that you are at least 18 years old". Price [P2]: $0.02/s 480p, $0.04 720p, $0.06 1080p.

### Krea (2 models) — written permission

Sources: [KR1] `https://www.krea.ai/terms` ("Last updated: May 20, 2024"); [KR2]
`https://www.krea.ai/docs/developers/introduction.md`, `…/api-keys-and-billing.md`.

No API or developer terms exist at any URL tried (`/legal/api-terms`, `/legal/terms`, `/api-terms-of-service`,
`/enterprise-terms`, `/legal` all 404; the docs index links no terms page). The consumer terms grant a
"non-sublicensable and non-transferable license" and reserve the right to change commercial-use terms "at any time".
Price is published: "Base pricing is $0.03 at 1K or $0.06 at 2K" [KR2].

### Sonilo (2 models) — written permission

Sources: [S1] `https://sonilo.com/terms` ("Last updated: October 2, 2026"); [S2] `https://platform.sonilo.com/pricing`;
API docs `https://sonilo.com/docs/api`.

The API docs say "Audio generated through the Sonilo API can be used commercially — in your own product and by your end
users", but the Terms govern, and they bar a product "that competes with Sonilo" (4), forbid to "Assign, sublicense,
resell, or otherwise transfer rights in the Software except as expressly authorized" (11) and require "prior written
consent" for anything not expressly allowed (12.2). Training with no opt-out and no delete route (registry). Price:
$0.00225/s text→music, $0.009/s video→music [S2].

### AssemblyAI — `assemblyai-universal-2` (written permission)

Sources: [A1] `https://www.assemblyai.com/legal/terms-of-service` ("Effective July 1, 2026"); [A2]
`https://www.assemblyai.com/pricing`.

2.1 licenses use "for the internal business purposes of Customer"; 2.4(d): Customer shall not "use the Services for the
benefit of a third party or make the Services available to any third party". Captioning a customer's own video for
them is for that customer's benefit. 4.6: AssemblyAI may use de-identified Customer Data to train. Price: Universal-2
"$0.15 /hr" [A2], i.e. $0.0000417 per second — fills the registry's `null`.

### Runway — `runway-video-upscale` (not allowed: the owner's rule)

[RW1] `https://runway.com/terms-of-use` ("Last updated October 23, 2026") §1 would allow it ("make that functionality
available to end users as part of Your Application", with "Powered by Runway"). It stays closed only because of the
owner's rule of 2026-11-13: through Runway only Runway's own models (this is Magnific's upscaler).

### The generic video ops (3 models) — could not determine

No vendor is named (`vendor_model: unassigned-placeholder`), so there are no terms to read. Candidates seen in passing:
BFL "FLUX Video Edit [fast] $0.03/s" [B3].

## The five unpriced models

### OpenAI image models — price from tokens

Sources: [O1] the cost calculator in `https://developers.openai.com/api/docs/guides/image-generation` ("Calculating
costs", driven with Playwright, every cell read twice in opposite orders with the same result); [O2]
`https://developers.openai.com/api/docs/pricing`.

Rule: **cost per image = output_tokens × $30 / 1,000,000** ("Per image at 30 USD per million image output tokens.
Excludes text and image input tokens and streaming partial images." [O1]), plus input: text $5 / 1M, image input $8 /
1M, cached image input $2 / 1M ("Both GPT-Image-2.5 models use the same token rates: $8 per million image input tokens,
$2 per million cached image input tokens, $30 per million image output tokens, $5 per million text input tokens, and
$1.25 per million cached text input tokens" [O1]). Partial images add 100 output tokens each. [O2]'s standard table now
lists only `gpt-image-2.6-sunburst` / `-flare` ($8 / $30 / $2); `gpt-image-2.5-*` appear there only under Batch ($4 / $15 /
$1). The text input rate for `gpt-image-2` was not stated on the pages read.

Output tokens and the output cost per image, from the calculator:

| Model | Quality | 1024×1024 | 1536×1024 or 1024×1536 | 2048×2048 | 3840×2160 |
| :-- | :-- | --: | --: | --: | --: |
| gpt-image-2.5 Flare / Sunburst | low | 196 = $0.00588 | 158 = $0.00474 | 397 = $0.01191 | 371 = $0.01113 |
| | medium | 439 = $0.01317 | 343 = $0.01029 | 892 = $0.02676 | 865 = $0.02595 |
| | high | 1,756 = $0.05268 | 1,372 = $0.04116 | 3,568 = $0.10704 | 3,336 = $0.10008 |
| | xhigh | 3,122 = $0.09366 | 2,459 = $0.07377 | 6,343 = $0.19029 | 5,930 = $0.17790 |
| | max | 7,024 = $0.21072 | 5,488 = $0.16464 | 14,272 = $0.42816 | 13,342 = $0.40026 |
| gpt-image-2 | low | 196 = $0.00588 | 158 = $0.00474 | 397 = $0.01191 | 371 = $0.01113 |
| | medium | 1,756 = $0.05268 | 1,372 = $0.04116 | 3,568 = $0.10704 | 3,336 = $0.10008 |
| | high | 7,024 = $0.21072 | 5,488 = $0.16464 | 14,272 = $0.42816 | 13,342 = $0.40026 |
| gpt-image-2.6 (replacement, for comparison) | low | 823 = $0.02469 | 664 = $0.01992 | 1,667 = $0.05001 | 1,558 = $0.04674 |
| | medium | 1,449 = $0.04347 | 1,132 = $0.03396 | 2,944 = $0.08832 | 2,855 = $0.08565 |

These are the calculator's **estimates** of output tokens, not a bill; the guide itself says "Use the response's usage
to measure token consumption". The calculator shows landscape and portrait using fewer tokens than square at every
quality; that is what the page says, not something we measured. The registry's three variants (low/medium/high)
would read, at 1024×1024: 2.5 Flare/Sunburst $0.00588 / $0.01317 / $0.05268; gpt-image-2 $0.00588 / $0.05268 /
$0.21072 (output only).

**One verification probe** (the registry's probe: t2i, 1:1, quality low, prompt "a red apple on a white table"): 196
output tokens = $0.00588, plus about 7 text tokens × $5/1M ≈ $0.00004, so **≈ $0.006 per model**, about $0.018 for all
three. A probe should record `usage` from the response to replace the estimate with a measurement.

### `ideogram-upscale` — price could not be read

[I1] `https://ideogram.ai/pricing/?pricing_tab=api` shows "Loading current prices." in both `curl` and Chromium (15 s
wait, no pricing request was made by the page); nothing else on the API docs gives a per-image figure. Two findings
for the owner: (a) the adapter calls the v1 endpoint, which Ideogram now labels "Upscale (legacy)"
(`https://developer.ideogram.ai/v1/llms.txt`); (b) the v2 upscale endpoints route to other makers' models — "Upscale with
Nano Banana Pro", "Topaz Bloom 2", "Topaz Wonder 4" … (`https://developer.ideogram.ai/v2/llms.txt`), the same middleman
pattern the owner ruled out for Runway. v2 documents `dry_run`: "the request is validated and priced but not run:
nothing is generated, stored, or billed" (`https://developer.ideogram.ai/v2/api-reference/images/upscale/auto.md`), so
the v2 price can be read for **$0.00**; the v1 price cannot. The registry's v1 probe uses `input_image: generated`,
so it pays for one generation (Ideogram 3 Turbo, $0.03 in the registry) plus an upscale of unknown price.

### `minimax-hailuo-2.3` — per clip

[MM1] `https://platform.minimax.io/docs/pricing/overview`, "Legacy Models": "MiniMax-Hailuo-2.3 $0.28 per 768P, 6s video",
"$0.56 per 768P, 10s video", "$0.49 per 1080P, 6s video"; no 1080P 10 s row. Per-second equivalents differ
($0.0467, $0.056, $0.0817), so one per-second figure would over- or under-charge. **Rule:** price by clip with variants
by resolution × duration (768p-6s, 768p-10s, 1080p-6s) and refuse 1080p-10s as unpriced. One probe (registry: t2v
768p 6 s) costs **$0.28**. MiniMax calls it legacy; H3 is already on sale.

## Open next — ranked

Highest value for the Studio first: quality (the registry's `quality_tier`), price, and how much work stands between
the model and a sale. Every one is web only.

1. **gemini-3-pro-image** (Nano Banana Pro) — the registry's tier 5 image (quality not measured by us); $0.134/image.
   Blocked only by the 18+ gate and the owner's reading of "not for consumer use".
2. **flux-3-image** — tier 5 image at $0.048 (1K); express end-user grant. Needs the BFL training line in the Privacy
   Policy.
3. **grok-imagine-video-1.5** — tier 4 video, $0.08/s at 480p, $0.14 at 720p, takes audio input. Needs the 18+ gate;
   requests refused for a violation are still billed.
4. **ltx-2.5-pro** — tier 4 video up to 4K, $0.12/s at 720p; clear 2.1(b) grant.
5. **gemini-3.1-flash-image** and **gemini-nano-banana-2.1** — tier 4 images at $0.067 and $0.0336.
6. **flux-3-video** — tier 4 video, $0.15/s HD.
7. **recraft-v4.1** — tier 4, the only vector output in the set ($0.08 vector); $0.035 raster.
8. **grok-imagine-video-1.5-lite** and **ltx-2.3-pro / -fast** — budget video ($0.02–0.04/s).
9. **flux-3-image-klein**, **recraft-v4.1-flash**, **gemini-3.1-flash-lite-image** — budget images ($0.007–0.034).
10. **grok-imagine-image-2.0**, **grounded-image-1.0** — tier 4 images, but Meta has the most prerequisites.
11. **flux-2-max / -pro / -flex** — superseded by FLUX 3.
12. **gemini-3.6-flash** — a describe utility, not a product; price doubles 2027-01-01.
13. OpenAI **gpt-image-2.5-flare / -sunburst** — no terms gate; only a price row and a probe stand in the way.
    `gpt-image-2` is not worth it (shutdown 2027-02-10).

Not next: Kling, Vidu, Pika, Krea, Sonilo, AssemblyAI until the vendor answers; `gemini-omni-1.1-flash` (route to 1.2);
the gemini-2.5 ops (deprecated); `runway-video-upscale` (owner's rule); the generic ops (no vendor).

## Written permission — who to write to and what to ask

| Vendor | Models | Contact (source) | Ask |
| :-- | :-- | :-- | :-- |
| Kling | kling-v2.6, kling-v3, kling-4.0-omni-edit | `enterprise@kling.ai` [K1] §13 (letter already sent 2026-11-11) | 3.3/3.5: may users of our app generate through our key? |
| Vidu (ShengShu) | vidu-q3-pro, -turbo, -pro-fast, q4-preview | `platform@vidu.com` [V1]; business: `platform@vidu.cn` [V2] | clause 4 "prior consent" to sell generations for credits; USD price list |
| Pika (Mellis, Inc.) | pika-2.5, pika-pikaframes | `support@pika.art` [P1] | which Plan grants API + commercial + end-user rights; attribution placement |
| Krea | krea-3, krea-3-regional | `sales@krea.ai` [KR2] | API terms; resale inside our app; commercial use of Output |
| Sonilo | sonilo-music, sonilo-video-music | `legal@sonilo.com` [S1] | 4 (compete), 11 (resell), training opt-out, deleting uploads |
| AssemblyAI | assemblyai-universal-2 | `legal@assemblyai.com` [A1] | 2.1 internal use / 2.4(d) third-party benefit for captions inside our app |
| Lightricks (optional) | ltx-* | sales form `https://ltx.io/forms/ltx-contact-sales?kpi=licensing` | confirm 2.2(d) "resale" does not reach a credits studio under 2.1(b) |
| BytePlus (ByteDance) | seedream-5.0-pro, -5.0-flash, -4.5, seedance-1.0-pro, -2.0, -2.5, -2.5-edit | Contact sales form `https://www.byteplus.com/en/contact-us` (letter already sent 2026-11-11, registry) | Customer Agreement 6.2(1) reseller consent; Model Services 4.2.3 "AI content creation tools" |
| Alibaba Cloud | wan-2.7, wan-3.0, happyhorse-1.1, qwen-image-2.1-pro, -turbo, z-image-turbo | `contact.us@alibabacloud.com` / `https://www.alibabacloud.com/en/contact-sales` | Product Terms §4.48.1(d)(v) "expressly authorised" resale |
| Luma AI | luma-ray-3.2, luma-uni-1, luma-uni-1-max | `support@lumalabs.ai` (Terms of Service, `https://lumalabs.ai/legal/tos`); no API terms page (`/legal/api-terms` 404) | the API Terms of Use the ToS defers to; written consent for a studio product |

Request draft (adapt the bracketed parts):

> Subject: Permission to offer [Model] to end users of our web studio
> We are Nightshift, a business that runs a web studio where customers buy credits and generate images and video.
> We would call [Model] server-side with our own key and show the result only inside our app; no customer gets API access or a key.
> Your [terms name, date] §[clause] says "[quoted words]"; please confirm in writing that this use is permitted, or tell us which plan or agreement allows it.
> We will bind our users to terms no less protective than yours, keep a consent step for real people, and keep your provenance marks.
> Please also confirm the countries we may serve and the current per-unit price in USD.

## What this review did not do, and what failed

- No API key was used and no model was called; every price is the vendor's published figure or the vendor's own
  calculator, not a bill.
- Not read: BFL EU Developer Terms and Enterprise terms; Recraft General Terms; the LTX AUP and Credit Terms (cited from
  the registry); Pika Plan terms and Privacy Policy; Kling Special Terms; Meta AUP (cited from the registry); xAI DPA;
  any order form of any vendor.
- Failed pages: Ideogram API prices (client-side, never loaded); `docs.ltx.io/api-license.md` (404, licence found as
  PDF instead); Krea API terms (none at any URL tried); `lumalabs.ai/legal/api-terms` (404); `openai.com/api/pricing`
  (403; the developers.openai.com copy was used).
- Not verified for any vendor: sign-up and billing from Uzbekistan.

## Summary

Of the **43** terms-gated models: **openable now 0**; **openable with an acknowledgement step 21** (Google 5, BFL 6,
Recraft 2, xAI 3, Meta 1, LTX 4 — all web only; Google, xAI and Meta only once the 18+ gate is live; BFL once the
Privacy Policy names its training licence); **needs written permission 14** (Kling 3, Vidu 4, Pika 2, Krea 2, Sonilo 2,
AssemblyAI 1); **not allowed 2** (`runway-video-upscale` by the owner's rule, `gemini-omni-1.1-flash` by its
2026-12-03 re-routing); **could not determine 6** (the 3 generic video ops, no vendor; the 3 gemini-2.5 picture ops,
never called and shutting down). Of the **5** unpriced models: price **found for 4** (the three OpenAI image models by
the token rule, Hailuo 2.3 per clip), **not found for 1** (`ideogram-upscale`).
