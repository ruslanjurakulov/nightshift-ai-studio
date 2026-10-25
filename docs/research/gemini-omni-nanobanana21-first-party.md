# Gemini Omni Flash 1.1 and Nano Banana 2.1 on Google's own API (first party)

Status: adapters shipped DARK, 2026-10-25. Internal notes. Nothing here makes a model available or for sale.

Two registry entries use Google's Interactions API (`https://generativelanguage.googleapis.com/v1beta/interactions`, key `GEMINI_API_KEY`, optional host override `GEMINI_BASE_URL`, https only; the same key and host variable as `image.gemini`):

| Registry id | Vendor model | Adapter | What it does |
| :-- | :-- | :-- | :-- |
| `gemini-omni-1.1-flash` | `gemini-omni-1.1-flash` | `video.gemini_omni` | t2v, i2v (one first-frame picture), 360p/720p/1080p/4k, 16:9 or 9:16, 3-10 s steered by the prompt, native audio |
| `gemini-nano-banana-2.1` | `gemini-nano-banana-2.1` | `image.gemini_interactions` | t2i and edit, up to 14 reference pictures, 1K/2K/4K, 14 aspect ratios |

Both replace models Google is retiring (the Veo 3.1 previews: shutdown 2026-10-22 at the earliest; `gemini-3.1-flash-image`: Google names Nano Banana 2.1 as its replacement, no shutdown date announced). See `docs/MIGRATIONS.md`, 0123, for how an announced shutdown date ends a sale.

## Why they are not for sale

Each entry has `terms_gate: terms_review_required` (so `sellable_models()` never returns it), `api_exposure: web_only`, and no `credit_prices` row. The owner's lawyer has to read, for a credits-based creative platform whose users may be under 18 or consumers:

- **Gemini API Additional Terms** (ai.google.dev/gemini-api/terms, effective 2026-03-23, read 2026-10-25), Age Requirements: "You must be 18 years of age or older to use the APIs. You also will not use the Services as part of a website, application, or other service ... that is directed towards or is likely to be accessed by individuals under the age of 18."
- The same page, Use Restrictions: "Use of Google AI Studio and Gemini API is for developers building with Google AI models for professional or business purposes, not for consumer use." Also: only within an available region; Paid Services only for EEA/Switzerland/UK; the Prohibited Use Policy applies.
- **Google APIs Terms of Service** 4(a) (developers.google.com/terms, last modified 2021-11-09): "Sublicense an API for use by a third party. Consequently, you will not create an API Client that functions substantially the same as the APIs and offer it for use by third parties." This is why the entries are `web_only`; whether a credits product that sells generations is this is a reading for the lawyer. A Google forum thread (2026-09-06, from the earlier research) asks the same question and had no official answer.
- Output: "Google won't claim ownership over that content"; attribution "may" be required by law; all output carries invisible SynthID; no customer watermark duty found.

Not read: whether a refused or failed request is billed (no Google page says), how long a stored interaction is kept, Uzbekistan billing support (Uzbekistan is on the AI Studio / Gemini API region list; billing country support is a separate list, not checked).

## What the adapters do

Sources (`ai.google.dev/gemini-api/docs/...`, as `.md.txt`, read 2026-10-25): `omni`, `models/gemini-omni-flash`, `image-generation`, `models/gemini-nano-banana-2.1`, `background-execution`, `pricing`, `deprecations`.

- **Omni** is treated as asynchronous: `POST /interactions` with `background: true, store: true` answers an interaction `id`; `GET /interactions/{id}` until `status` is `completed` (`in_progress`, `requires_action`, `failed`, `cancelled` are the other states on the background page). **UNVERIFIED:** that page names standard Gemini models and managed agents, not Omni, and Omni's own page shows a synchronous call. Both work: a create answer that is already `completed` still yields its id. The clip comes back **inline (base64)** from GET even when `delivery: "uri"` was asked for; a `uri` is accepted only on `generativelanguage.googleapis.com` and downloaded with the key in the `x-goog-api-key` header, no redirect, byte cap, atomic write (`safe_fetch`, with a `download_headers` hook that stays closed for every other adapter).
- **Nano Banana 2.1** is synchronous (`background: false`, `store: false`: the interaction is not kept for later turns; what Google retains otherwise, for abuse review for example, was not read), one image per call, inline base64, stored under the type its bytes say it is.
- **No setting the price depends on is defaulted.** Omni's `resolution` is required (Google's default is 720p; 1080p and 4k are "upscaled" and unpriced). Nano Banana's `image_size` is required, and `thinking_level` is always sent as `medium` (Google's default, pinned so a change of default cannot change the bill; thinking tokens are billed at $7.50 per 1M).
- **Omni has no duration setting.** The registry offers none (`durations_s` is empty), so a job that names one is refused, not ignored; the length (3-10 s) is steered in the prompt and billed as produced. That also means a per-second quote cannot be exact: whoever prices it has to decide how.
- **Nothing is claimed about billing.** Every refusal and failure starts with `BILLING UNKNOWN: the Google pages read do not say whether a refused or failed request is billed ...`; a submit whose answer was lost starts with `UNCONFIRMED SPEND`; a failure after Google finished (no clip, bad file, refused link, download error) starts with `SPEND MAY HAVE OCCURRED`.
- Errors use Google's `error.status` where it is sharper than the HTTP code: `FAILED_PRECONDITION` about billing is `quota`, about location is `auth`; `PERMISSION_DENIED` about billing is `quota`; content words are `policy`.
- Not wired: first/last-frame interpolation, subject/style references and video references for Omni, editing and extension of videos, `delivery: "uri"`, multi-turn (`previous_interaction_id`), search grounding, thinking levels other than `medium`, the `Api-Revision` header (shown only on the background page), streaming, batch.

## Prices (all ESTIMATES, `confirmed: false`)

`ai.google.dev/gemini-api/docs/pricing`, 2026-10-25, paid tier, Standard: Omni video output $17.50 per 1M tokens at 5,792 tokens per second of 720p video = $0.1014 per second (Google: "approximately $0.10"); input $1.50 per 1M; text output $9 per 1M. 360p, 1080p and 4k are not priced anywhere I read, so they are `null`. Nano Banana 2.1 image output $30 per 1M tokens: $0.0336 (1K, 1120 tokens), $0.0504 (2K, 1680), $0.113 (4K, 3780 tokens); input $1.50 per 1M and thinking $7.50 per 1M are NOT in those figures.

## To enable one (owner)

1. The owner's lawyer reads the terms above and decides (18+ gate, consumer use, sublicensing). Nothing else moves until then.
2. Billing on the Gemini API paid tier for the key in `GEMINI_API_KEY` (already mapped for the probe workflow and the worker), with a spend cap.
3. `python tools/probe_models.py --dry-run --model gemini-nano-banana-2.1`, then the real probe, by name (`--all` skips every gated model): about $0.034 for the image; Omni's 360p probe costs whatever Google bills for a 3-10 s clip, no more than about $1 at the 720p rate.
4. The probe settles the unverified points: whether `background: true` is accepted for Omni, the exact failed-interaction body, and the length a prompt yields.
5. Re-check the prices, set `confirmed: true`, add the `credit_prices` rows, clear `terms_gate` in a reviewed change.

## Review fixes (second pass)

- **No redirect is followed** on any call (`follow_redirects = False`): the key rides a header that `requests` does not strip on a cross-host redirect, and a 307/308 would re-send the body. Loopback tests cover Omni create, Omni poll and Nano Banana create, with a control that leaks the key when redirects are turned on.
- An interaction id goes into a URL path: it must start with a letter, digit, `_` or `-` and may then also contain `.`; `..`, `.`, `a:cancel` and anything with `/` are refused.
- A completed answer in a shape nobody planned for (`steps: 5`, `content: true`) keeps its spend note (`SPEND MAY HAVE OCCURRED` for Omni, `UNCONFIRMED SPEND` for Nano Banana) instead of a bare `TypeError`.
- Input pictures are checked by their bytes (PNG, JPEG, WebP), the type sent is the type the bytes say, and a document named `.png` is refused before any request.
- An inline result is refused before it is decoded when its base64 would decode past the byte cap. A media type with parameters (`video/mp4; codecs=avc1`) is accepted as an MP4.
- The key rides a result download only to the very same host and netloc the API itself is on.
- The two Google Cloud Terms notes (§20.d, §17.a) are the registry's pre-existing citations for Google models and were NOT re-read for the Gemini API; the Gemini API's own terms are the notes after them.
- A poll that fails with an HTTP error does not mean the Omni clip stopped: it may still be running and billing at Google. Keep the task id and poll again; never submit again.

