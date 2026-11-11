# Registry corrections from the makers' own pages, 2026-11-11

Status: registry change (`schemas/model_registry.json`) plus tests. No database price, no adapter and no new model is changed. No vendor API was called and no key was used.

Every quote below was read on 2026-11-11 on a page the model's maker publishes, fetched directly (HTML, the site's embedded data for BytePlus, or the maker's own Markdown export for Google and Kling). A research note from the same day listed these as candidate fixes; it was a starting point only, and each item here was re-read on the page cited. Where a page could not be read, the entry was left as it was (last section).

## What changes for sale

**Nine entries are now terms-gated.** A gate keeps a model out of `sellable_models` (migrations 0035 and 0125) and out of `tools/probe_models.py --all`. It does not touch the daily pipeline, which reads `config.SEEDANCE_MODEL` and `config.GEMINI_MODEL` and never reads the registry gate.

| Entry | Gate was, gate is now | Terms that gate it |
| :-- | :-- | :-- |
| `flux-2-pro`, `flux-2-max`, `flux-2-flex`, `flux-3-video` | null, now `terms_review_required` | BFL FLUX API Service Terms 2(b): the training licence that already gates `flux-3-image` and `flux-3-image-klein` |
| `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-3.6-flash` | null, now `terms_review_required` | Gemini API Additional Terms, the 18+ and "not for consumer use" clauses that already gate `gemini-nano-banana-2.1` and `gemini-omni-1.1-flash` |
| `seedance-1.0-pro` | null, now `written_consent_required` | BytePlus Customer Agreement 6.2(1), which already gates every Seedance 2.x and Seedream entry |

What the owner loses until the gates are cleared:

- **Describe has no model left.** `gemini-3.6-flash` was the only ungated `describe` entry.
- **Studio picture generation and editing are OpenAI only** (plus Ideogram for t2i). The three Gemini image entries and the three FLUX.2 entries leave sale. Region edit (`modules/region_edit.py`) refuses a gated model, so it runs on the OpenAI entries only.
- **Studio text-to-video is Runway Gen-4.5 only**, and image-to-video is the two Runway entries. Seedance 1.0 Pro and FLUX 3 Video leave sale.
- The credit prices already seeded for these units (`docs/sql/prices_2026_10_01.sql` and its corrections) stay in the database, made inert by the gate. Nothing is deleted.

Left as they are: `veo-3.1`, `veo-3.1-fast` and `veo-3.1-lite` (Google terms, no gate) and `seedance-1.5-pro` (BytePlus, no gate). All four are past their announced shutdown, so they are not sold at all.

## 1. `api_exposure` is now `web_only`

A `web_only` entry is still sold in the Studio. Only the public API and MCP stop offering it (`sellable_models(capability, 'api')`, docs/API.md). This works like the Ideogram change pinned by `tests/test_ideogram_web_only.py`.

| Entries | Maker's page (read 2026-11-11) | Clause quoted into `terms_notes` |
| :-- | :-- | :-- |
| `runway-gen4.5`, `runway-gen4-turbo`, `runway-video-upscale` | runway.com/terms-of-use, "Last updated October 23, 2026" | §1: the APIs may be used to "make that functionality available to end users as part of Your Application", which "must prominently display "Powered by Runway" and link to runway.com". §1.3(a): "you shall not license, sell, rent, lease, transfer, assign, reproduce, distribute, host, or similarly exploit any Services except as permitted through the APIs". §2.1: "Your Accounts, passwords, and API keys are for your use only". |
| `kling-v2.6`, `kling-v3` | kling.ai/document-api/guides/protocols/paid-service (Terms of API Paid Service), "Effective Date: 2026-04-21" | 3.3: "a non-exclusive, non-transferable or sublicensable ... license" and "you has no right to disseminate, transfer, license, or provide these resources to others for use". 3.8: the Key "can only be used for the authorized your Client Application" and may not be transferred, rented or lent "to any third party". 3.5: use beyond the authorization lets Kling suspend the service immediately. |
| `wan-2.7`, `wan-3.0` | alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-product-terms-of-service, "Last Updated:Oct 19, 2026" (the registry had read the Sep 23 version) | §4.48.1(d)(v), wording unchanged: you shall not "resell Model Studio or AI models provided through Model Studio ... unless expressly authorised by us". |
| `elevenlabs-v4`, `elevenlabs-v3`, `elevenlabs-multilingual-v2`, `elevenlabs-flash-v2.5`, `elevenlabs-sfx`, `elevenlabs-voice-changer`, `elevenlabs-dubbing-v2`, `elevenlabs-dubbing-v1` | elevenlabs.io/oem-terms, "Last Updated: 28 February 2025" | §2.B(a): "Customer may not: (a) Make Available a Service to any third party who will itself Make Available the applicable Service or Bundled Service". §1.C: "Services cannot be used independent of the Customer Solution". §2.A: use "solely to" integrate, demonstrate, Make Available and support the Bundled Service. |
| `seedance-1.0-pro` (gated too, above) | docs.byteplus.com/en/docs/legal/docs-customer-agreement, "Effective: Sep 30, 2026" | 6.2(1): "Unless otherwise permitted by Applicable Laws or consented in writing to by BytePlus in advance, you shall not ... hold yourself out as an original equipment manufacturer ("OEM"), Software as a Service ("SaaS") provider, Model as a Service ("MaaS") provider, service provider, reseller, or distributor of the Services". |

Runway: §1 says "link to runway.com", so the three Runway entries' `attribution.url` moved from `https://runwayml.com` to `https://runway.com`. Their old note, which said "runwayml.com", was corrected to match.

Readings:

- **Runway.** §1 allows the functionality "as part of Your Application". A pass-through API that other developers build on is our stricter reading of §1.3(a) ("host, or similarly exploit"). It is not Runway's own wording, and a lawyer may read it more loosely.
- **ElevenLabs.** The research note named only Runway, OpenAI, Kling and Wan. The ElevenLabs entries were added because §2.B(a) is the same kind of clause: an API customer of ours who builds on it "will itself Make Available" the service. All eight entries are also behind `plan_required:scale`.

Still `api_exposure: any`:

- **The three OpenAI entries.** OpenAI's terms could not be read: every `openai.com/policies/*` page answered HTTP 403 (last section).
- **`luma-ray-3.2`.** Luma's terms were not re-read today.
- **`seedance-1.5-pro`.** It is past its shutdown.

## 2. Gates under the same vendor terms

| Vendor | Quote (read 2026-11-11) | Why it is the same terms |
| :-- | :-- | :-- |
| BFL | bfl.ai/legal/flux-api-service-terms, "Last Revised on August 4, 2026", 2(b): "Developer grants the Company a fully paid, royalty-free, perpetual, irrevocable, worldwide, non-exclusive, and fully sublicensable right and license to use ... Developer's Input and Output ... the Company may use Inputs and Outputs to train and improve its artificial intelligence models" | The API Terms govern "the FLUX AI Models via the FLUX API". Developer Terms 1(f) defines FLUX AI Models as "the Company's artificial intelligence models", so FLUX.2 and FLUX 3 Video are covered. `flux-3-image` is gated on exactly this clause. |
| Google | aistudio.google.com/docs/terms (ai.google.dev now redirects there), "Effective March 23, 2026": "You must be 18 years of age or older to use the APIs. You also will not use the Services as part of a website, application, or other service ... that is directed towards or is likely to be accessed by individuals under the age of 18." and "Use of Google AI Studio and Gemini API is for developers building with Google AI models for professional or business purposes, not for consumer use." | The ungated Gemini 3.x entries already carried these clauses with "Owner/lawyer decision needed ... before any Google model is offered". Nano Banana 2.1 and Omni 1.1 are gated until the lawyer has read the same clauses. |
| BytePlus | Customer Agreement 6.2(1), quoted above | 6.2(1) is about "the Services", every one of them. It is not limited to Seedance 2.x. |

The stricter reading is the one the gated siblings already had. No gate was cleared anywhere.

## 3. Prices

`confirmed` stays `false` on every entry. In this repository, `true` is kept for a price pinned by a probe's billed amount. Each page figure is quoted in `pricing.note`, with `source_url` set and `as_of` set to 2026-11-11.

| Entry | Was | Now | Quote |
| :-- | :-- | :-- | :-- |
| `flux-3-video` | $0.17/s (search extract, release-notes URL) | $0.15/s base; variants 720p $0.15, 1080p $0.24 | bfl.ai/pricing, FLUX 3 Video: "Text / Image → Video, HD$0.15/s", "Text / Image → Video, FHD$0.24/s"; HD is "above 0.5 and up to 1.0 MP per frame", Full HD "above 1.0 and up to 2.0 MP". api.bfl.ai/openapi.json, Flux3VideoT2VInputs.resolution: `"default": "hd"`. The adapter sends hd or fhd. |
| `elevenlabs-scribe-v2` | null | $0.0000556/s | elevenlabs.io/pricing/api: "Scribe v2 ... $0.20 Price per hour". It is the same $0.20 on every plan row. Keyterm prompting ($0.050/h) and transcript editing ($0.070/h) are extra, and the adapter sends neither. |
| `elevenlabs-v4` | null | $0.00008/char | same page: "v4 ... $0.08 Price per 1K characters" |
| `elevenlabs-v3` | null | $0.00008/char | same page: "v3 ... $0.08 Price per 1K characters", "5,000 character limit" |
| `kling-v2.6` | null | $0.042/s | kling.ai/document-api/pricing/base/video: "Kling 2.6 \| No Native Audio \| ... \| 0.3 Units ($0.042) /s \| 0.5 Units ($0.07) /s" (720P, 1080P). Native audio is 1080P only. The adapter always sends `"mode": "std"` (720p). |
| `minimax-hailuo-2.3` | null, no source | still null, with source and date | platform.minimax.io/docs/pricing/overview, Legacy Models: "$0.28 per 768P, 6s video", "$0.56 per 768P, 10s video", "$0.49 per 1080P, 6s video". |

Notes on the prices:

- **FLUX 3 Video.** The release note of 2026-09-10 gives other figures for qhd and uhd. The registry does not offer those bands, and the note itself points to "full rates on the pricing page".
- **Hailuo 2.3 is billed per clip.** The clips work out to $0.047/s, $0.056/s and $0.082/s. No single per-second figure fits, so none is claimed.
- **Hailuo 2.3 at 1080P for 10 s.** MiniMax lists no price for it, but the registry offers `1080p` with `durations_s` 6 and 10. That pair was not changed here and needs a separate decision.

Rechecked, and the same as the registry: Runway gen4.5 "12 credits per second" and gen4_turbo "5 credits per second"; Kling 3.0 at 720P, $0.084/s silent and $0.126/s with audio; ElevenLabs Multilingual v2 at $0.08 and Flash at $0.04 per 1K characters.

### Credit prices against these costs (not changed in this PR)

Customer credits are `credits_per_unit × (1 + margin)`, and a credit is about $0.01 retail (docs/API.md: Starter is 1,000 credits for $10). The prices of the larger packs are not in the repository. **No unit sells below cost at $0.01 per credit.** Three units have a cost basis that is now wrong:

| Unit | Seeded | Customer price | New cost | Below cost when a credit sells under |
| :-- | :-- | :-- | :-- | :-- |
| `model_flux_3_video_second` | 17 credits, margin 1.5 | 42.5 credits/s ≈ $0.425/s | $0.15/s at 720p, $0.24/s at 1080p | $0.0056 (1080p) |
| `model_minimax_hailuo_2_3_second` | 4.7 credits, margin 1.5 ("≈ $0.047/s") | 11.75 credits/s | 768P 10 s $0.056/s, 1080P 6 s $0.082/s | $0.0069 (1080P 6 s) |
| `model_elevenlabs_scribe_v2_second` | 0.0112 credits, margin 2.0 (assumed $0.40/h) | 0.0336 credits/s ≈ $1.21/h | $0.20/h | far below any pack price |

Details:

- **FLUX 3 Video.** The base row is quoted at every resolution: there is no `default_resolution`, so migration 0125 uses the base unit. At 1080p the margin is about 1.8×, not 2.5×.
- **Hailuo 2.3.** The 4.7 basis understates the 10 s and 1080P clips.
- **Scribe v2.** The basis is overstated by 2×, so the customer pays more than intended. It is not a loss.
- **The other entries** keep their margins: Kling 2.6 (4.2 after `prices_corrections_2026_10_01.sql`, i.e. $0.105/s against $0.042/s), and ElevenLabs v4 and v3 (0.008 with margin 2.0, i.e. $0.24 against $0.08 per 1K characters).
- **The gated units.** The FLUX.2, Gemini 3.x and Seedance 1.0 Pro units keep their seeded rows. While those entries are gated, the rows are not used.

## 4. Gemini Omni 1.1: served as 1.2 from 2026-12-03

| Page (read 2026-11-11) | Quote |
| :-- | :-- |
| aistudio.google.com/docs/deprecations (`.md`), Gemini Omni Flash models | `gemini-omni-1.1-flash`, released "August 27, 2026", shutdown "December 3, 2026", replacement "`gemini-omni-1.2-flash` (Effective December 3, 2026, the endpoint is automatically routing API requests to `gemini-omni-1.2-flash`)" |
| aistudio.google.com/docs/pricing (`.md`), Gemini Omni 1.1 Flash | "Effective December 3, 2026, all API requests to `gemini-omni-1.1-flash` automatically route to `gemini-omni-1.2-flash` and are billed at `gemini-omni-1.2-flash` rates." 1.1 video output is "$17.50" per 1M tokens (about $0.10/s). |
| same page, Gemini Omni 1.2 Flash | video output "$12.00" per 1M tokens, "approximately $0.07 per second" at 720p; "$0.023/s for 360p", "$0.104/s for 1080p", "$0.209/s for 4K" |

The registry already had the shutdown fields: `shutdown.on` is 2026-12-03 and `replacement` is `gemini-omni-1.2-flash`, read 2026-11-10. Migration 0125 ends the sale on that day, so nothing is sold as 1.1 once Google serves 1.2 in its place. This PR makes the routing explicit:

- `pricing.note` now says that from 2026-12-03 every 1.1 call is served by 1.2 and "billed at gemini-omni-1.2-flash rates" ($12 per 1M tokens of video, about $0.07/s at 720p). The 1.1 estimate ($0.1014/s) is kept for the days before that.
- `api_documented.note` quotes the deprecations page's routing sentence.
- A terms note, starting "Silent routing:", records it as well.

`replacement` stays a bare model id.

## Pages that could not be read (entries left unchanged)

- **OpenAI.** `openai.com/policies/services-agreement`, `/service-terms`, `/business-terms`, `/usage-policies`, `/terms-of-use` and `/row-terms-of-use` all answered HTTP 403 by direct fetch; the first two also answered 403 through the fetch tool. The three OpenAI entries keep `api_exposure: any` and no gate. A person needs to read the Services Agreement (resale and End User clauses) before deciding.
- **BytePlus pricing.** `docs.byteplus.com/en/docs/ModelArk/model-pricing` was not needed for this change, so no BytePlus price was touched. The Customer Agreement was read from the data the page embeds.

## Tests

- `tests/test_registry_corrections_2026_11_11.py` pins every change above: each `web_only` entry with its clause and date, the exact list of entries still on `any`, the nine new gates, a gate on every live BFL, Google and BytePlus entry, each price with its source, and the Omni routing.
- Four tests that pinned the earlier state were updated: `test_captions` (Scribe price), `test_flux3_image` (the FLUX.2 gate) and `test_model_shutdown` (the Google gates). The fourth is `test_region_edit`, which now resolves an OpenAI edit model and refuses the gated Gemini one.
- `test_region_edit_run` tests the run itself on the Gemini entry with its gate cleared in the test. The refusal of a gated entry is still pinned there.
