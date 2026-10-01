# Competitor and reference research (Creative OS UX)

Status: working notes, 2026-10-01. Internal only: brand names appear here for analysis and must never appear in customer-facing UI copy.

Evidence levels used below:

- **seen**: the product owner sent screenshots of the real product.
- **tool**: read from the product's own read-only MCP listing.
- **search**: web-search snippets or third-party reviews; treat as unverified until a screenshot confirms it.

The research environment could not open krea.ai, higgsfield.ai or magiclight.ai directly (network policy), so everything not marked **seen** needs a screenshot or a re-read from a session with those hosts allowed.

## Qisqacha (Uzbek summary)

- Hamma raqobatchida takrorlanadigan qonunlar: bitta kiritish paneli, narx tugmaning o'zida, natija lentasi (kutubxona shu), tahrir faqat media bo'lganda, pullik AI amallari oldindan narx bilan.
- Bizning ustunligimiz: YouTube'ga tasdiq darvozasi orqali nashr, ko'p kanal, o'zbek/rus tili, mahalliy to'lov, bekor qilish va qaytarish shartlarining oldindan ko'rinishi.
- Qarorlar: Videolar alohida ro'yxat; xato kartasi o'chirilguncha turadi; kredit ushlab turilib natijada yechiladi; Uslub to'plami (moodboard) va Lora hozircha qurilmaydi.

## 1. Rules every reference product shares

1. **One entry point.** A single prompt box with chips (model, aspect, quality, count). No separate Image / Video / Audio / Edit tabs for customers.
2. **Price on the primary button** (for example "25 Generate"), computed before the user commits. Cost changes live with every setting.
3. **Results are a feed, not a list.** Library and "what I generated" are one surface: big cards, status badge (Done / Processing / Draft / Failed), a "..." menu, filter chips.
4. **Editing appears when media exists.** Tool strips (CapCut/InShot style) show after a clip or image is selected, and differ for video and image.
5. **Paid AI actions are explicit buttons with a quote** (captions, speech, background removal, style, upscale). Plain ffmpeg tools are free.
6. **Examples fill the empty state.** Prompt suggestions, template cards, "use this style" actions. There is never a blank screen.
7. **Before/After slider** for any transformation (upscale, cutout, restyle, denoise) before the user accepts.
8. **Contextual upsell.** Tapping a locked model or feature opens the plan modal right there, with plain equivalents ("= 64 images or 20 videos").

## 2. Product notes

### Krea (evidence: seen for UI, tool for models/plans, search for the rest)

- Position: aggregator of ~100 image/video/3D/audio/enhance models, paid from one unit pool (CU). Own models Krea 1/2.
- Navigation (seen): Home, Moodboards, Train Lora, Node Editor, Assets, then a long Tools group (Image, Video, Enhancer, Edit, Realtime, Lipsync, Motion Transfer, 3D, Video Restyle), Pricing with a discount badge, Enterprise, MCP, Agent.
- Home (seen, top to bottom): hero carousel, agent banner plus six quick cards, template workflows, video model cards, image model cards, inspiration feed (rotating prompt search, masonry), footer with Solutions / Models / API / Release Notes.
- Model cards (seen): Featured/New badge, one-line description, speed indicator (1-3), quality indicator (1-3), approximate unit price, "Generate" on hover. Model picker defaults to "Auto" (tool).
- Prices drift between surfaces (node list vs docs vs plan examples). Lesson: one price source of truth for the button.
- Example unit costs from the node catalog (tool): image 2 to 356, video 84 to 1185, upscale 8 to 200, lipsync 222 to 350. Plan: Basic $9 ($5 yearly) 5,000 units ~ 64 images or 20 videos; Pro $35 ($21) 20,000; Max $70 ($42) 40,000. Yearly discount 40% (tool) vs 20% (third party): unverified.
- Moodboards (seen): up to 250 images analysed into a reusable style, preset boards. Parked idea, see section 5.
- Train Lora (seen): custom model from 50 to 2000 images by plan. Parked.
- Node Editor (seen): canvas pipelines, per-node price shown (6 units image, 256 video), presets (Image Generator, Video Generator, 8K Upscaling, LLM Image Captioning, Agent), "Turn workflow into app".
- Upscale preset (seen): Input Image node to Enhance node with a Before/After slider, model field, optional prompt, input image, upscale factor, collapsed settings, price 19 units.
- LLM Image Captioning (seen): image to prompt (reverse prompt).
- Agent (partly seen): brief, plan, model picks, results saved to a session. Reported free for all users (search); the owner hit a gate, details unknown.
- Gating (seen): free users can open features but running them asks for a plan; the upsell modal has monthly/yearly toggle, struck-through price, per-plan equivalents, "Best value" badge.

### Higgsfield (evidence: seen for mobile web UI, tool for models/plans, search for studios)

- Position: aggregator plus tools. Viral Hub effects (87 presets), Marketing Studio (product URL to ad), Shorts Studio, Faceless Studio (up to 5 min faceless YouTube video), Explainer (24 styles, all 9:16), Soul ID (consistent face from ~20 photos), Genjutsu (motion transfer, object swap), Supercomputer (agent), website builder, 3D, TikTok publishing. No YouTube publishing found.
- Mobile web (seen): header mode dropdown instead of tabs (Featured: Image, Audio, Video, MCP, Upscale, Inpaint, Effects; All: plus Video Edit, Explainer, Reframe, Speak, Popcorn, Character, Moodboard, Draw To Edit, Draw To Video). Bottom bar: Home, Community, center create button, Library, Profile. Pricing chip with a percent-off badge.
- Create screen (seen): dashed upload zone (up to 16 images), prompt box with Model row, chips (aspect, quality, resolution, count), big Generate button with price and struck-through discount price (8.5 to 6.5).
- Plans (tool): Plus $49 ($39 yearly) 1,000 credits; Ultra $129 ($99) 3,000. 100 credits ~ 50 premium images ~ 4 premium videos. Top-ups expire after 90 days. "Unlimited" promos work on the website only, not in agent/MCP (confusing). Refunds only within 7 days with zero credits used.
- Complaints (search): cancellation, refunds, charges after cancel, account suspensions.
- Model help: one-line "what it is good for" plus a `recommend` function from goal and inputs.

### MagicLight (evidence: search only, all unverified)

- Story-to-video for faceless and kids channels: idea or story (up to 12k chars) to script, characters, storyboard cards, voice, render, export. Web, iOS, Android. 30 to 50 minute outputs claimed.
- Characters: photo or text description, saved and reused across stories. Multi-character scenes drift.
- Credit model: charged per attempt including failures; cost not clearly shown before render; yearly billing defaulted at checkout. Trustpilot about 2.2 to 2.7 of 5.
- Plans (search): Free 300 credits; Standard $15 ($7.5 yearly) 8,000; Plus $28 27,000; Pro $44 47,000; Ultra $90 150,000; Ultimate $150 280,000.
- No direct YouTube publishing, no approval gate, no confirmed Russian/Uzbek.
- Pattern worth copying: read the script, then review storyboard cards, then approve. Pattern to avoid: hiding the price until render.

### Kling mobile (evidence: seen)

- Compact generate bar: settings summary pill ("Pro | 5s | 1") expanding upward, price on the Generate button.
- Resolution tier cards with a benefit line (720p faster, 1080p better, 4K highest).
- Native audio and voice select only for models that support them.
- Plan cards: monthly credits with equivalents ("3300 images / 33 videos"), benefits row.

### CapCut and InShot editors (evidence: seen)

- Bottom tool strip scrolls horizontally; each tool opens a sheet with a checkmark to confirm.
- Cutout (remove background, customized cutout, chroma key); in/out/combo animation; transitions grouped (Trending, Movement, Overlay, Blur) with 0.1 to 1.5 s slider and "Apply to all".
- Audio lanes (music, SFX, voice-over) as separate tracks; text and sticker lanes; AI speech with voice cards; multi-language auto captions.
- Speed: Standard and Curve modes, 0.1x to 10x, presets (Montage, Hero Time, Bullet Time, Jump Cut, Fast In, Fast Out), live total duration ("11.2s to 6.2s").
- Speech cleanup (filler words, silences), denoise (Low/Medium/High), music beats and AutoCut, quick-removal tools (Quick Removal, Modify Area, Cutout Stroke, Invert).
- Export sheet with share targets.

## 3. What Nightshift builds from this

### Studio (one page)

- Top: credit chip. Middle: feed (running jobs, finished results, uploads) with filter chips All / Done / Processing / Drafts / Failed. Bottom: pinned composer.
- Composer: prompt, attach files, model chip defaulting to "Auto" with plain hints ("Fast" / "Quality"), settings summary pill, live quote, primary button with the price.
- Selecting media shows an action bar (Edit, Variations, Animate, Use as reference, Download, Publish). Publishing always goes through the existing approval gate.
- Customer menu has five items: Studio, Videos, Channels, Credits, Settings. Mobile bottom bar with a center "+" for create.
- Free starter credits so the first result costs nothing; paywall only on expensive actions.

### Editor (only after media is loaded)

| Tool | Tier | Notes |
| --- | --- | --- |
| Trim, split, aspect | free | ffmpeg |
| Transitions | free | xfade, categories, 0.1 to 1.5 s |
| Speed and curve | free | 0.1x to 10x, presets, live total duration |
| Text, stickers, in/out animation | free | layers |
| Music, SFX, voice tracks | free | separate lanes |
| Chroma key, filters, adjust | free | ffmpeg |
| Denoise Low/Medium/High | free | afftdn |
| Auto captions uz/ru/en | paid, quote | transcription, editable text layer |
| AI speech | paid, quote | voice cards |
| Background removal | paid, quote | image and video, Before/After |
| AI style | paid, quote | Before/After |
| Speech cleanup | paid, quote | silences and fillers |
| Describe image (reverse prompt) | paid, small | vision LLM, then "make similar" |
| Upscale 2x/4x/8x | paid, quote | one slider, optional description, Before/After |
| Export | paid, quote | roughly 3 to 5 credits per minute; goes through the publish gate |
| Keyframes, AutoCut, music beats | later | |

### Plans page

- Monthly/yearly toggle with the discount percentage, struck-through old price, per-plan equivalents computed from `credit_prices` (never hand-typed), a "Best value" badge, and a contextual upsell modal when a locked feature is tapped.
- Cancellation and refund terms visible before purchase.

## 4. Decisions made by the product owner (2026-10-01)

- Videos stay a separate list (finished projects and publish status).
- A failed job card stays in the feed until dismissed, with the reason and a retry button; credits are returned automatically.
- Credits are held when a job starts, captured when the result arrives, and fully released on failure.
- Moodboard-style "Style kits" and custom model training are parked.
- BYOK is never offered; customers have no owner/editor/viewer roles.

## 5. Parked ideas

- **Style kit (moodboard):** collection of 3 to 8 reference images plus an LLM-written style description, attached to a channel as a "Style" chip. Priority: after Studio and editor.
- **Custom model (Lora):** needs a GPU fine-tune provider; expensive; revisit for recurring characters.
- **Workflow ("Run now" template):** step list, not a node canvas (phone-first). Steps: topic, script, images, video, voice, captions, approval gate, publish. Each step shows a model chip and price. Publishing stays behind the gate.
- **Assistant (agent):** chat in Studio that proposes a plan with a total quote, runs only after one explicit approval, never publishes without the gate.
- **Marketing site:** solutions pages (creators, agencies, e-commerce), models page, pricing, API, security, release notes; use-case landing pages in RU/UZ.
- **Community feed:** not planned (no social features).

## 6. Screens still needed from the owner (priority order)

1. Higgsfield: video create screen (duration, resolution, audio chips and price), model picker sheet, pricing page, out-of-credits or locked-model modal.
2. Higgsfield: Shorts Studio and Faceless Studio flow, library/projects, profile and cancellation flow.
3. Krea: image tool at phone width (price on button or in picker), pricing page and free-tier credit meter, video tool price changes, assets page.
4. MagicLight: pricing, create step 1 (modes, language, ratio, length), language and voice list (is Russian or Uzbek present), script review, character creation, storyboard cards with price, pre-render confirmation, billing and cancel page, mobile app.
5. Short screen recordings (30 to 60 seconds) of the flows above work well; frames can be extracted.

## 7. Next verification step

Re-read the public pages (pricing, docs, help centers, reviews) from a session whose network policy allows krea.ai, docs.krea.ai, higgsfield.ai, magiclight.ai, magiclight.app and trustpilot.com, and mark each **search** item here as confirmed or corrected.
