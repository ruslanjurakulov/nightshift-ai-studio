# S10 — Opening Google's models: availability, price, terms, verdict

Stream S10 of the build program (`docs/studio/PROGRAM.md`). Research read **2026-11-22** from Google's own pages only; no live call
was made, so every row below is **docs-only** until a real call through our adapter succeeds (CLAUDE.md, Definition of Done).

Read this first:

- Every `ai.google.dev/gemini-api/docs/*` URL now answers **301 → `aistudio.google.com/docs/*`** (the terms page included). The
  pages below are the redirect targets. None of them shows a "last updated" date; where a page shows its own date it is quoted.
- Quotes were taken through a fetch tool that summarises pages and clips long quotes. **Before this goes to a lawyer, a person opens
  the terms page and checks the exact wording.**
- Nothing here switches anything on. Every Google row stays `terms_review_required` (0035 keeps a gated model off sale) until the
  owner's decisions in §4 are made and recorded.

## Sources (all read 2026-11-22)

| Key | Page | Its own date |
| :-- | :-- | :-- |
| DEP | https://aistudio.google.com/docs/deprecations | — (dates on it are the *earliest possible*) |
| PRICE | https://aistudio.google.com/docs/pricing | — |
| MODELS | https://aistudio.google.com/docs/models | — |
| OMNI | https://aistudio.google.com/docs/omni | — (last ~5.7k characters not read) |
| VIDEO | https://aistudio.google.com/docs/video | — |
| IMG | https://aistudio.google.com/docs/image-generation | — |
| INTER | https://aistudio.google.com/docs/interactions | — |
| CHLOG | https://aistudio.google.com/docs/changelog | entries dated |
| TERMS | https://aistudio.google.com/docs/terms (Gemini API Additional Terms) | "Effective March 23, 2026" |
| REG | https://aistudio.google.com/docs/available-regions | — |
| USAGE | https://aistudio.google.com/docs/usage-policies | — |
| GAPI | https://developers.google.com/terms (Google APIs Terms of Service) | "last modified November 9, 2021" |
| PUP | https://policies.google.com/terms/generative-ai/use-policy (Prohibited Use Policy) | "Last Modified: December 17, 2024" |
| BLOG-OMNI | https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-omni-1-2-flash/ | published 2026-11-05 |

## 1. Per model: available today, and its price

Prices are the Gemini API paid tier, Standard. "Ours" is what `schemas/model_registry.json` (PR #881) carries, `confirmed: false`.

| Registry id → vendor id | Status on the Gemini API | Shutdown / replacement | Price (docs) vs ours | Sources |
| :-- | :-- | :-- | :-- | :-- |
| `gemini-3.1-flash-image` | **GA** since 2026-05-28 ("Stable"); the `-preview` id shut down 2026-06-25 | none announced; DEP recommends `gemini-nano-banana-2.1` | 512 $0.045, 1K $0.067, 2K $0.101, **4K $0.151** (ours 0.15). Now on the Gemini API page, not only Vertex | DEP, PRICE, CHLOG, IMG |
| `gemini-3.1-flash-lite-image` | **GA** since 2026-06-30 | none | **1K $0.0336** (ours 0.034). Other sizes: not on the page — **unverified** | DEP, PRICE, CHLOG |
| `gemini-3-pro-image` | **GA id `gemini-3-pro-image` exists**, GA since 2026-05-28; `-preview` shut down 2026-06-25 | none | 1K/2K $0.134 (matches); **4K $0.24 — missing from our row** | DEP, PRICE, CHLOG, MODELS |
| `gemini-2.5-flash-image-{expand,relight,erase}` → `gemini-2.5-flash-image` | active, legacy (no status label) | **2027-03-15** at the earliest → `gemini-3.1-flash-lite-image` | **$0.039 / image** (ours: no price) | DEP, PRICE, IMG |
| `gemini-3.6-flash` (describe; also #898's chat) | **GA** since 2026-07-21 | none | **price doubles on 2027-01-01**: input $0.75 → $1.50 /M tokens, output $3.75 → $7.50 /M | DEP, PRICE, CHLOG |
| `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite` → `veo-3.1*-generate-preview` | **shut down 2026-10-22** ("The Veo 3.1 Preview in the Gemini API has been shut down", VIDEO). **No Veo of any version remains on the Gemini API** (2.0/3.0 shut 2026-06-30) | → `gemini-omni-1.2-flash` | not on PRICE | DEP, VIDEO, PRICE |
| `gemini-omni-1.1-flash` | GA since 2026-08-27 | **2026-12-03**: DEP says the endpoint "is automatically routing API requests to [1.2] effective December 3, 2026" (billed as 1.2) | ≈ $0.1014/s (matches ours); per-resolution 1.1 prices unverified | DEP, PRICE, OMNI |
| *(new)* **`gemini-omni-1.2-flash`** — the Veo replacement | **GA** since 2026-11-05 (CHLOG; BLOG-OMNI: "generally available on the Gemini API and Google Cloud") | none | **360p $0.023/s, 720p $0.07/s, 1080p (upscaled) $0.104/s, 4K (upscaled) $0.209/s** | DEP, PRICE, CHLOG, BLOG-OMNI |
| `gemini-nano-banana-2.1` | **GA** since 2026-10-06 | none | 1K $0.0336 (matches), **2K $0.0504, 4K $0.113**; **no 512** | DEP, PRICE, CHLOG, IMG |
| Imagen 4.x | **shut down 2026-08-17** (every `imagen-4.0-*-001`) | → `gemini-nano-banana-2.1` | — | DEP, MODELS |

**Omni 1.2's shape** (OMNI, BLOG-OMNI), for the adapter: `POST /v1beta/interactions` with an API key; the examples are synchronous
(`background=false`), with `delivery:"uri"` the file is polled on the Files API until `ACTIVE`. `response_format: {type:"video",
duration, resolution, aspect_ratio}`. Duration **3–15 s** whole seconds (default 10; >15 is an invalid-argument error). 360p / 720p
(default) / 1080p and 4K upscaled. **16:9 and 9:16 only.** Native audio out; audio *inputs* unsupported. Up to 6 reference images (3
per character, 2 characters). No system instruction, temperature, negative prompt. **"English is fully supported, but other
languages have not been evaluated"** — our ru/uz prompts are an open quality risk, not a blocker. OMNI and BLOG-OMNI disagree on
provisioned throughput (unverified; we do not use it).

**Image endpoint**: IMG's examples moved to the Interactions API; INTER calls `generateContent` "legacy" but "fully supported". Our
`image.gemini` adapter is on the legacy path, not a broken one. CHLOG 2026-10-26: **new** paid projects on generateContent now
`store=true` by default; existing projects keep their setting — **our project's setting is unverified** (owner checks in AI Studio).

## 2. The terms for offering these models to OUR users

We are a SaaS: people sign in, generate in our Studio, pay in our credits; we hold one paid-tier API key.

**Gemini API Additional Terms (TERMS, effective 2026-03-23)**

- **Consumer use.** "Use of Google AI Studio and Gemini API is for developers building with Google AI models for professional or
  business purposes, not for consumer use." Grammatically it governs who uses AI Studio and the API (us, a business). Other clauses
  plainly expect developers to make API Clients available to "users", and nothing limits those users to businesses. Whether a public
  self-serve sign-up is "consumer use" is **not settled by the text — lawyer**.
- **Age.** "You must be 18 years of age or older to use the APIs. You also will not use the Services as part of a website,
  application, or other service (collectively, "API Clients") that is directed towards or is likely to be accessed by individuals
  under the age of 18." The second sentence binds the **whole site**, not the Google features, and its test is "likely to be
  accessed by", which a self-attested checkbox does not by itself answer.
- **Regions.** "You may only access the Services (or make API Clients available to users) within an available region." The user's
  location counts, not only our server's. It is an allow-list.
- **EEA / CH / UK.** "You may use only Paid Services when making API Clients available to users in the European Economic Area,
  Switzerland, or the United Kingdom." Met while the key is paid tier; a free-tier key must never serve users.
- **Data.** Paid tier: Google "doesn't use your prompts … or responses to improve our products", logs them "for a limited period of
  time, solely for detecting and preventing violations" and legal disclosures; data "may be stored transiently or cached in any
  country". USAGE: retained "fifty-five (55) days" for abuse monitoring; a flagged project may get human review and be paused.
- **Output.** "Google won't claim ownership over that content"; "You're responsible for your use of generated content, and for the
  use of that content by anyone you share it with." Law "may require the provision of attribution to your users".
- **Grounding** (only if we turn on Search grounding): show grounded results only with their Search Suggestions to the user who
  asked; no caching, framing, syndicating or reselling them.
- Also: no developing competing models with the output, no bypassing safety, not for medical / legal / financial / mental-health
  advice (matters for #898's chat).
- **Not found** on the terms page: a SynthID / watermark or AI-disclosure duty, image/video likeness terms, a preview clause. IMG and
  OMNI say every output carries **SynthID**; whether we may strip it is unverified — we must not (see PUP §4.5).

**Google APIs Terms of Service (GAPI, last modified 2021-11-09)**

- §4(a)(1): "Sublicense an API for use by a third party. Consequently, you will not create an API Client that functions
  substantially the same as the APIs and offer it for use by third parties." A Studio where the model is one step inside our video
  product is plausibly not "substantially the same"; a near 1:1 relay (our public API, MCP or a connector generating straight on a
  Google model) plausibly is. **Lawyer.**
- §2(a): we must require our end users to comply with law and these terms (pass-down in our Terms of Service).
- §3(d): our privacy policy must say what we share with Google.
- §4(a): no removing or obscuring Google's terms or notices.

**Prohibited Use Policy (PUP, last modified 2024-12-17)**: no child sexual abuse or exploitation (§1.1), privacy/IP violations incl.
biometrics without consent (§1.6), sexual content for gratification (§3.4), deceptive impersonation (§4.2), "Misrepresenting the
provenance of generated content by claiming it was created solely by a human, in order to deceive" (§4.5).

**Model-specific (OMNI)**: "Uploading and editing images containing minors is not supported in European Economic Area, Switzerland,
and the United Kingdom"; "Uploading and editing images containing certain recognizable people is not supported" (everywhere);
"Editing or extending uploaded videos is not currently available for users in the EEA, Switzerland, and the United Kingdom". For the
image models no person/minor/region limit was found beyond grounding — **unverified, not "none"**.

**Regions (REG)**: **Uzbekistan is listed.** Not listed: Russia, mainland China, Hong Kong, Macau, Iran, Belarus, Cuba, North Korea.
Syria, Venezuela and Ukraine are listed. No narrower per-model list exists. Google's list is necessary, not sufficient: our own
sanctions/export position is a separate (lawyer) question.

## 3. What our gates already cover

| Obligation | Our gate | Covered? |
| :-- | :-- | :-- |
| 18+ per user | `requires_adult: true` on all 12 Google rows; 0192's `adult_attestation_gate` refuses quote and job without a recorded adult answer; a "minor" answer is refused every paid model | **Yes** for the per-user rule (self-attested) |
| Site "not likely to be accessed by under-18s" | Nightshift is adult-only by 0192 (`adult_only_service`) | **Partly** — whether self-attestation is enough is decision D2 |
| Region allow-list, user's location | `GOOGLE_AVAILABLE_REGIONS` → `GOOGLE_BLOCKED` (`lib/geo/blocked.ts`) twinned with `blocked_countries` on every row; unknown country **refused** (`REFUSE_UNKNOWN_COUNTRY`); 0208's database gate with the signed country claim so a direct PostgREST call cannot skip the routes | **Yes, once #881 is merged, 0208 applied and the key is set**. The list matches REG as read today (UZ allowed; RU, CN, HK, MO, IR, BY, CU, KP refused) |
| Paid tier for EEA/CH/UK | One paid-tier key | **Operational** — the owner confirms the key's project is on billing; no free-tier key anywhere |
| §4(a)(1) no 1:1 relay | `api_exposure: "web_only"` on all 12 rows: the public API and MCP never list them | **Yes** for API/MCP; the Studio itself is decision D3 |
| Off sale until decided | `terms_gate: "terms_review_required"` (0035 refuses `beta`/`ga` with an open gate) | **Yes** |
| Shut-down models never sold | `shutdown` on the Veo rows (2026-10-22) and omni-1.1 (2026-12-03) | **Yes** — Veo rows must stay unavailable; there is nothing to open |
| Omni: no minors / video edit for EEA/CH/UK; no recognisable-person uploads | none | **No** — needed before Omni i2v opens (see §5) |
| Privacy policy discloses Google processing | `lib/legal-docs/en.ts` names the Gemini API for pipeline text (scripts, comments, figures) only | **No** for Studio prompts, uploaded pictures and generated media; 55-day retention not stated |
| ToS pass-down of law + Google's terms / PUP | not found in the legal docs read | **No** — owner/lawyer text |
| PUP moderation (CSAE, sexual, impersonation) | Google's own safety filters; our own moderation not confirmed for the Studio | **Unverified** |
| SynthID kept, no "human-made" claim | nothing strips it on purpose; assembly (P4) likely re-encodes video | **Unverified** whether SynthID survives our transcode (it is designed to; not measured) |
| No silent model swap (rule 4) | — | **Gap**: Google routes `gemini-omni-1.1-flash` to 1.2 from 2026-12-03; the row must be retired before then, never sold as 1.1 |

## 4. Decisions only the owner (and his lawyer) can make

- **D1 Consumer use.** Is Nightshift's public self-serve sign-up "consumer use" under TERMS? If yes: Google models only for
  business/workspace accounts (a new entitlement), or not at all.
- **D2 Age assurance.** Is a recorded self-attestation (0192) enough for "likely to be accessed by individuals under the age of 18",
  which applies to the whole site? If not, what age assurance the site needs.
- **D3 §4(a)(1).** Is a credit-priced Studio that names Google's models one by one "an API Client that functions substantially the
  same as the APIs"? Keep them web-only forever (no API, no MCP, no connector)? Show Google's model names, or present them as
  product features (without obscuring Google's notices)?
- **D4 Sanctions.** Serve every REG-listed country, or also refuse sanctions-sensitive ones Google lists (e.g. SY, VE)? (Adding codes
  to `blocked_countries` is additive and safe; removing Google's is not allowed.)
- **D5 Legal texts.** Approve the privacy-policy and Terms-of-Service additions in §3 (Google as processor for Studio prompts,
  uploads and outputs; 55-day abuse retention; storage in any country; users bound by law and Google's Prohibited Use Policy).
- **D6 Omni in EEA/CH/UK.** Offer Omni there as text-to-video only (no image input, no video edit/extend), or not at all.
- **D7 gemini-3.6-flash price.** Re-quote credits for 2027-01-01's doubling (describe, and #898's chat), or choose another model by
  an explicit decision.
- **D8** Whether a lawyer's written opinion on D1–D3 is required before anything opens. (Recommended: the text does not settle them.)

## 5. Verdict per model

"Needs D…" means the model may open only after the named decisions **and** a successful real call through our adapter (§6).

| Model | Verdict | Why |
| :-- | :-- | :-- |
| `gemini-nano-banana-2.1` | **Needs a legal decision** (D1, D2, D3, D5) | GA, priced, our adapter `image.gemini_interactions` matches Google's recommended API. Re-price 2K/4K; drop 512 |
| `gemini-3.1-flash-image` | **Needs a legal decision** (D1, D2, D3, D5) | GA, priced (4K → $0.151) |
| `gemini-3.1-flash-lite-image` | **Needs a legal decision** (D1, D2, D3, D5) | GA; only 1K is priced on the page — open at 1K only |
| `gemini-3-pro-image` | **Needs a legal decision** (D1, D2, D3, D5) | GA id confirmed; add 4K $0.24 or drop 4K |
| `gemini-2.5-flash-image-{expand,relight,erase}` | **Needs a legal decision** (D1, D2, D3, D5); low priority | active until ≥2027-03-15, $0.039; would need a migration to a replacement within months |
| `gemini-3.6-flash` (describe) | **Needs a legal decision** (D1, D2, D3, D5, D7) | GA; price doubles 2027-01-01. Same verdict covers #898's chat |
| `gemini-omni-1.2-flash` (new row) | **Needs a legal decision** (D1, D2, D3, D5, D6) **and new work**: a registry row, the Omni 1.2 adapter shape (3–15 s, 4 resolutions), the EEA/CH/UK input gate | the only Google video model on the Gemini API |
| `gemini-omni-1.1-flash` | **Not allowed** to open | Google swaps it to 1.2 on 2026-12-03 (rule 4: no silent substitute). Retire the row |
| `veo-3.1`, `veo-3.1-fast`, `veo-3.1-lite` | **Not allowed** — shut down | no Veo exists on the Gemini API. (Veo on Vertex / Gemini Enterprise is a different product, terms and adapter; out of scope unless the owner asks) |
| Imagen 4.x | **Not available** — shut down 2026-08-17 | — |

No model is "OK to open" today: every one waits on D1–D3 and D5, which only the owner and his lawyer can decide.

## 6. After the decisions: the probe plan (paid, Atlas runs it with the owner's OK)

One real call per model through our own adapter (`tools/probe_models.py --model <id>`), the cheapest shape that proves the path.
Estimates are from §1's prices at today's rates.

| Model | Probe call | Est. cost |
| :-- | :-- | :-- |
| `gemini-nano-banana-2.1` | t2i, 1K, 1:1 | $0.034 |
| `gemini-3.1-flash-image` | t2i, 512 | $0.045 |
| `gemini-3.1-flash-lite-image` | t2i, 1K | $0.034 |
| `gemini-3-pro-image` | t2i, 1K | $0.134 |
| `gemini-2.5-flash-image` ops | one edit (erase) on a generated picture; expand and relight share the call | $0.039 (+ the input picture if generated: $0.034) |
| `gemini-3.6-flash` | describe one small picture, ~300 output tokens | < $0.01 |
| `gemini-omni-1.2-flash` | t2v, 360p, 16:9, 3 s | $0.069 |
| **Total** | | **≈ $0.40** (of the program's $15 cap) |

Then, as additive changes: the price rows above (re-priced to §1), the `gemini-omni-1.2-flash` row, retiring `gemini-omni-1.1-flash`,
and only then clearing `terms_gate` and the on-sale switch for the models the owner approved.

## 7. #898 (customer chat on gemini-3.6-flash)

It needs the same country list: import `GOOGLE_BLOCKED` / `refusesUnknownCountry` from `lib/geo/blocked.ts` (from #881), never a
copy. Its other Google obligations are the same as `gemini-3.6-flash` above, plus "not for medical, legal, financial … advice"
(a system-prompt rule) and D7.
