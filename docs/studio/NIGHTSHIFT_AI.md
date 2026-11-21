# Nightshift AI — the shared contract (BRIEF v1)

Owner: S5. Every stream builds against this file. A change to a field below is announced to Atlas first; it is never silent.

## Names (the owner's decision, 20 Nov)

- **Nightshift AI**: the single assistant a person talks to (chat, research, channel analysis, plan, approval, next action). It is the UI name of the panel.
- **Nightshift Studio**: the one creative workspace (Canvas, Scenes, Timeline, Library).
- **Nightshift Brain**: the server-side layer behind the AI.
  - It holds the owner-chosen LLM adapter, plan, tool choice and project/channel context.
  - Code lives in `command-center/lib/brain/*` and routes under `/api/brain/*`.
  - **A model answer never authorises anything by itself.** The server owns data, actions, prices and permissions.

## What happens, end to end

1. **Prompt.** The person writes a prompt: Home's "Start from idea" box, or the Studio start box. They may attach a reference photo, which becomes a character (see Characters below).
2. **Panel.** The Nightshift AI panel docks on the **left** of the Studio canvas. It is titled with the prompt's first words and has "+ New" and a close button; at 390 px it is a sheet.
3. **Questions.** The Brain asks the questions the brief still needs, as **cards**: a short thread title, a question, 3 numbered options and an "your own answer" field, then Confirm.
   - The first question is always **kind**: a long YouTube video or a short Studio film/ad.
4. **Draft on the canvas.** After each answer the BRIEF below is stored, and the canvas (S6b) draws it as **draft** nodes: idea → story → chapters → characters, locations and props → scenes → visuals/clips → voice → music → assembly. Nothing is spent.
5. **Create.** "Create — N credits" is a person's press, and N is the backend's price.
   - **long** → the existing Run now form, prefilled. The person confirms its own priced button. The pipeline, voice and gates are unchanged.
   - **short** → the BRIEF becomes a **film** through `create_film_draft` / `save_film` (0166), priced by `quote_film` and started by `start_film` (0171).
6. **Live view.** The same canvas lights up from real status (S6) and ends at the assembled video.

The Brain never holds, charges, starts or publishes anything (CLAUDE.md rules 2 and 3). Uploads stay private.

## BRIEF v1 (JSON)

The BRIEF is stored per conversation and returned by `GET /api/brain/session/<session_id>`. All text is plain text, never HTML or markdown, already length-capped by the server. Ids are short and stable within one BRIEF (`c1`, `l1`, `p1`, `s1`) so scenes can point at them.

```jsonc
{
  "version": 1,
  "session_id": "uuid",
  "status": "drafting",            // drafting | ready (every required slot known) | created (handed off; see "handoff")
  "kind": "long",                  // long | short | null (not asked yet)
  "title": "The ship that sailed alone",
  "idea": "one-sentence premise",
  "language": "English",           // Uzbek | Russian | English
  "audience": "history fans",
  "style": "dark documentary, cold blue",
  "aspect": "16:9",                // 16:9 | 9:16 | 1:1   (long: always 16:9)
  "target_seconds": 180,           // long: 60 | 180 | 300 | 600 | 1200 (what Run now takes); short: see the limits below
  "story": { "logline": "", "conflict": "" },
  "chapters": [                    // the script outline: titles with timestamped beats
    { "id": "ch1", "title": "Cold open", "start_s": 0, "beats": [{ "at_s": 0, "text": "An empty deck at dawn" }] }
  ],
  "characters": [
    {
      "id": "c1", "name": "The captain", "description": "",
      "image_prompt": "",          // a reference image is generated from this once and reused in every scene
      "asset_id": null,            // set once a reference image exists (uploaded or generated): media_assets.id
      "character_id": null,        // set when it is a saved Studio character (characters table)
      "source": "prompt"           // prompt | upload | library
    }
  ],
  "locations": [{ "id": "l1", "name": "", "description": "", "image_prompt": "", "asset_id": null }],
  "props":     [{ "id": "p1", "name": "", "description": "" }],   // props are prompt text only (film_refs has no prop kind)
  "scenes": [
    {
      "id": "s1", "n": 1, "title": "",
      "duration_s": 6,             // short: 3..30 (film_limits); long: informational only (Run now cuts its own scenes)
      "visual_prompt": "",
      "dialogue": [{ "character_id": "c1", "line": "" }],   // short only: spoken by the video model inside the clip (see Voice)
      "character_ids": ["c1"], "location_id": "l1", "prop_ids": [],
      "keyframe_model": null,      // short: a model id the server checked is on sale (t2i/edit); null = the film's default
      "clip_model": null           // short: a model id the server checked is on sale (i2v); null = the film's default
    }
  ],
  "voice": { "mode": "off" },      // off | clip_audio (short: the video model speaks `dialogue`) | pipeline (long: Run now's own voice)
  "music": { "mode": "off" },      // off | library (asset_id) — no music generation before the event
  "price": {                       // ATTACHED BY THE SERVER, never by the model; absent until the backend computed it
    "state": "priced",             // priced | unpriced | failed | exempt
    "total_credits": 120,
    "nodes": { "s1": 18, "s2": 18 },   // per scene, when quote_film itemises it; absent otherwise
    "spendable": 300,              // number | "exempt" | "unknown" (a failed read is never 0)
    "fits": true,
    "shorter": null                // { "target_seconds": 60, "credits": 40 } — the longest that fits, from the backend
  },
  "handoff": null                  // see "Handoff" below; set only after the person's Create
}
```

**Validation, server side.**
- Unknown fields are dropped.
- A model id that is not on sale is dropped, and the field stays null: never replaced with another model.
- A length that the target path does not take is refused.
- Counts are capped: scenes ≤ 60 (film_limits), characters ≤ 8, locations ≤ 8, props ≤ 12, chapters ≤ 20, beats ≤ 12 per chapter.
- Text is capped at: title 120, idea 300, visual_prompt 2000 (film_limits.max_prompt_chars), line 300, beat 240.

## Limits that shape the BRIEF (from the database, not this file)

- **Short = a film.**
  - Scenes are 3–30 s, at most 60 per film.
  - **The film's target is 60–1200 s** (`film_limits.target_seconds_min/max`). A 15–30 s ad therefore needs S6 to lower `target_seconds_min`. Until then the Brain offers 60 s as the shortest short and says why. **Open question to S6/Atlas.**
- **Long = Run now.** 60, 180, 300, 600 or 1200 s. A request outside that is offered the nearest lengths, with the reason.
- **Voice.**
  - No TTS model is on sale, so the Brain never proposes a narration model and never accepts a typed voice id.
  - For short films it may offer **clip_audio**: the lines go into each scene's clip prompt, and the video model (MiniMax H3 t2v/i2v, verified 20 Nov) speaks them. The panel labels this "voice is generated by the video model".
  - If `quote_film` refuses a voice line (voice_not_set, channel_voice_not_priced), that reason is shown and nothing is substituted.
- **Characters from a photo.** An uploaded reference photo becomes `characters[].asset_id` with `source: upload`. It passes the existing rights acknowledgement (0174/0187), likeness and 18+ (0192) gates at quote and start. The Brain never bypasses them.

## Question cards

`POST /api/brain/turn` returns, next to the BRIEF, at most one card:

```jsonc
{ "card": { "id": "q-uuid", "slot": "kind", "thread_title": "Ancient desert action", "question": "",
            "options": ["", "", ""], "allow_own": true } }
```

- The slot order and which slot is asked are the **server's** state machine. The option texts come from the model inside strict JSON, are validated and capped (≤ 160 chars each), and are rendered as plain text.
- A confirmed option or own answer comes back as `{ "action": "answer", "session": "...", "card": "q-uuid", "choice": 1 | 2 | 3 | null, "own": "text" | null }`.

## Reading the BRIEF from the canvas (S6b)

- `GET /api/brain/session/<id>` → `{ "brief": BRIEF, "card": card | null, "updated_at": "iso" }`.
  - It is read as the person: a conversation is visible to its author only.
  - Poll after each turn, or listen for the browser event `nightshift:brain-brief` (`detail: { session_id, updated_at }`). The panel dispatches it whenever the BRIEF changes.
- The session id is in the Studio URL while the panel is open: `/studio?brain=<session_id>`.
- A draft node shows its price only from `brief.price.nodes[<id>]`. With no entry it shows no number (rule 5).

## Handoff (after the person's Create)

- `brief.status` becomes `created`, and `brief.handoff` is one of:
  - `{ "kind": "film", "film_id": "uuid" }`. The canvas opens `/studio?view=live&film=<film_id>`.
  - `{ "kind": "run", "channel_id": "...", "dispatched_at": "iso" }` (Actions backend). The canvas opens `/studio?view=live&channel=<channel_id>&since=<dispatched_at>`. The view labels it honestly: "events this channel recorded since this run was started".
  - `{ "kind": "run", "channel_id": "...", "job_id": "..." }` (queue backend). The canvas opens `/studio?view=live&channel=<channel_id>&run=<job_id>`.
- `dispatched_at` is added by S6b to `/api/agent/run`'s answer. That change is additive and alters nothing that is spent or dispatched.

## Research the Brain reads (S10, docs/studio/RESEARCH_TOOLS.md)

- The Brain calls S10's readers server-side, with the person's own session:
  - `research_own_channel`;
  - `research_competitors_view`;
  - `research_topic_channels`;
  - `research_comment_themes`.
- Their `data` goes into the model's data block as **data**, and `untrusted_text` stays labelled as untrusted.
- The Brain repeats only raw numbers, says "Source: YouTube", and computes no ratio, outlier or sentiment score.
- A status other than `ok` (`no_data`, `not_connected`, `refreshing`, `budget_exhausted`, `not_enabled`) is said as such. It is never "no competitors".
- `research_request_refresh` is called only when the person asks for fresh data.

## Who gets it, and what it costs

- **The flag.** `NIGHTSHIFT_AI_CHAT=off|orgs|on` and `NIGHTSHIFT_AI_CHAT_ORGS`, on only for the owner's and the demo workspace until reviewed.
- **Paid plans only** (Plus, Pro, Business). Free sees the panel locked, with "Upgrade plan" (`/credits#plans`).
- **Per-plan daily message caps.** Plus 30, Pro 100 and Business 300, in a rolling 24 h per workspace. The owner adjusts them, and the database enforces them before any LLM call.
- **The model.** The owner chooses it in the owner panel from the text LLMs on sale; the default is Claude Sonnet 5.5. Customers see no picker. If the chosen model is down, the panel says "Nightshift AI is unavailable right now", and no other model is tried.
- **Free to the person within the cap.** Usage (no text) is metered for the owner only.
