# Alibaba Model Studio: HappyHorse, Qwen-Image, Z-Image, and the gate on Wan

Status: adapters shipped DARK, 2026-10-25. Internal notes. Nothing here makes a model available or for sale.

## The finding that changed two existing entries

The Alibaba Cloud International Website Product Terms of Service (Last Updated Sep 23, 2026, `alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-product-terms-of-service`) say in section 4.48.1(d)(v) that, by using Model Studio, you shall not "resell Model Studio or AI models provided through Model Studio, or use Model Studio, AI models provided through Model Studio (including any Output of such AI models) to train or develop products or services that compete with Alibaba Cloud and/or its affiliates' products and services, unless expressly authorised by us".

A credits product that sells generations very likely falls under "resell" (our reading, not Alibaba's). `wan-2.7` and `wan-3.0` were added with `terms_gate: null` and empty notes, before this clause was found. Both now carry `terms_gate: written_consent_required` and the clause in `terms_notes`. The other clauses read: 4.48.1(e) Model Studio claims no ownership of Output; (g)(v) Output may be identical across customers; (h)(i)/(iv) the operator bears all responsibility for its product and indemnifies Alibaba; (h)(ii) the operator must label Outputs conspicuously "if required under applicable laws".

**Not read**: the Alibaba Cloud Membership Agreement that the Product Terms incorporate, any order form or negotiated terms, and anything about signing up or paying from Uzbekistan. No age limit was found in the text read.

### Owner action before the next registry sync

`tools/probe_models.py --sync` calls `sync_model_registry` (migration 0035). The table has a CHECK, `model_registry_terms_before_sale`: a row whose `availability` is `beta` or `ga` may not carry a `terms_gate`. If `wan-2.7` or `wan-3.0` was ever made available in the live database, the upsert that adds the gate is rejected, and the whole sync with it. Set both rows to `hidden` first (the admin board, or `update public.model_registry set availability = 'hidden' where id in ('wan-2.7','wan-3.0')`). Nothing in this change can tell which they are: availability lives in the database only.

The earlier `credit_prices` rows for the Wan units stay where they are (migrations are additive). `sellable_models()` requires an empty gate, so they are inert while the gate is open.

## New dark entries

| Registry id | Vendor model | Adapter | What it does |
| :-- | :-- | :-- | :-- |
| `happyhorse-1.1` | `happyhorse-1.1-t2v` / `happyhorse-1.1-i2v` | `video.happyhorse` | text-to-video, first-frame image-to-video; 480p/720p/1080p, 3-15 s, native audio |
| `qwen-image-2.1-pro` | `qwen-image-2.1-pro` | `image.dashscope` | text-to-image and editing (up to 10 pictures) |
| `qwen-image-2.1-turbo` | `qwen-image-2.1-turbo` | `image.dashscope` | the same, cheaper |
| `z-image-turbo` | `z-image-turbo` | `image.dashscope` | text-to-image, one image |

All four: `terms_gate: written_consent_required`, `api_exposure: web_only`, no `credit_prices` row, prices dated 2026-10-25 and marked ESTIMATE / `confirmed: false`.

Sources (alibabacloud.com/help/en/model-studio, read 2026-10-25): `happyhorse-text-to-video-api-reference` and `happyhorse-image-to-video-api-reference` (Oct 12, 2026), `qwen-image-generation-and-editing-api-reference` (Oct 11, 2026), `z-image-api-reference` (Oct 11, 2026), `use-video-generation`, `model-pricing`. The HappyHorse image-to-video and the current Qwen page were not in the first research pass; they were read for this change.

## What the adapters do

- Same key and host as Wan: `WAN_API_KEY` (or `DASHSCOPE_API_KEY`) and `WAN_WORKSPACE_ID` (`https://{id}.ap-southeast-1.maas.aliyuncs.com`). Alibaba says a key, a model and an endpoint must be in one region. Nothing new to wire: the Wan key is already in the worker env, the deploy workflow and the probe workflow.
- Video is asynchronous (`X-DashScope-Async: enable`, task id valid 24 h). The resolution and the duration are required and sent as given: the vendor default is 1080P, the dearest tier. Image-to-video keeps the picture's shape, so a job that names a ratio for it is refused. The 1.0 models, reference-to-video and video editing are not wired (their pages were not read). Audio is part of the model; the docs list no switch, so none is sent.
- **Watermark (changed 2026-11-11).** The vendor's default is ON ("HappyHorse", lower right). The adapter sends `watermark: true`, the vendor's default, and never off. Qwen's `watermark` is optional and off by default, so it is not sent (owner decision 2026-11-12: each maker's default unless its terms require the mark; the Product Terms 4.48.1(h)(ii) labelling duty applies only "if required under applicable laws" and does not require the visible mark). There is no constant or setting that switches either (`tests/test_vendor_watermarks.py`). Z-Image documents no watermark field. See `docs/AI_DISCLOSURE.md`, "Vendor watermarks and provenance".
- Pictures are synchronous and come back as a 24-hour PNG link (no base64 option). Z-Image's `prompt_extend` doubles its price ("Enabling prompt_extend increases cost"), so it is always sent, `false`. Qwen's `prompt_extend` and `enable_thinking` are left to the vendor (default on; the pricing table does not price them apart). `size` is sent only when the job names an aspect ratio.
- **Result links.** Alibaba's own FAQ says the storage domain "may change dynamically" and gives no whitelist. The examples are `dashscope-result[-xx].oss-<region>.aliyuncs.com` (Beijing, Shanghai, Shenzhen, Hangzhou, Ulanqab). **The Singapore host is not shown on any page read.** A link is accepted only on `aliyuncs.com` and on a `dashscope-result*` bucket; anything else is refused (fail closed), the refusal carries `SPEND MAY HAVE OCCURRED` and names the host it saw. The first real probe will show it; widen `RESULT_HOST_RE` in `modules/capabilities/alibaba.py` on purpose if it is Alibaba's.
- A submit whose answer never came back (timeout, dropped connection, 5xx, an unreadable 2xx) raises with `not_accepted` False and a message that starts with `UNCONFIRMED SPEND`. Every failure after Alibaba said the work was done starts with `SPEND MAY HAVE OCCURRED`. Alibaba's pricing page says failed requests are not billed; that is a vendor claim and is not repeated as fact anywhere in the code or the notes.
- Not wired: Qwen 3.0 (priced by output size, takes a negative prompt), the asynchronous and OpenAI-compatible image APIs, `n` above 1, the other regions.

## Wan 3.0 (note only)

The `use-video-generation` page lists `wan3.0-video` as text-to-video, first/last-frame image-to-video and all-in-one reference-to-video, 480P/720P/1080P, 2-30 s, 30 fps, with audio, an audio toggle, smart duration and adaptive aspect ratio, and `wan3.0-video-prime` as its speed-optimised variant. The entry stays text-to-video only: the API reference for those inputs was not read, and the Wan adapter sends the Wan 2.7 wire format. The page is recorded in the entry's `api_documented.note`. Prices on the 2026-10-25 pricing page: `wan3.0-video` has a per-second list for 480P / 720P / 1080P tagged "Limited-time 30% off" (which price is charged is not clear), `wan3.0-video-prime` a dearer one; input video is billed too. The figures are on the vendor pricing page, not here. The registry prices are unchanged.

## Prices (all ESTIMATES, `confirmed: false`)

Singapore list per output unit, `model-pricing`, 2026-10-25: HappyHorse 1.1 per second at 480P / 720P / 1080P (text and image input alike); Qwen-Image 2.1 Pro and Turbo per image; Z-Image Turbo per image with prompt rewriting off (dearer on). Other regions are about 12% lower. The figures are on the vendor pricing page; the prices themselves live in the model registry, not in prose. Rate limits were not on the pages read.

## To enable one (owner)

1. Ask Alibaba Cloud in writing to authorise Nightshift to resell Model Studio generations (4.48.1(d)(v)). The watermark policy is decided: each maker's default is kept (2026-11-12).
2. `python tools/probe_models.py --dry-run --model happyhorse-1.1`, then the real probe by name (`--all` skips every gated model): a 480p, 3 s clip for HappyHorse and one picture each for the image models, at the registry's prices. Read the result host off the probe if it is refused.
3. Re-check the prices, set `confirmed: true`, add the `credit_prices` rows, clear `terms_gate` in a reviewed change.
