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
2. **Panel.** The Nightshift AI panel docks on the **left** of the Studio canvas, drawn in the same chat shell as the owner's (`components/chat`): the bare N, "Salom, {first name}", the pill composer, Copy and thumbs (no Regenerate: a stored turn moves the plan on and cannot be swapped), "New chat", and the person's own conversations in a history drawer (`GET /api/brain/history`, this workspace + channel + author only, read-only: 0199 has no rename or delete).
3. **Questions.** The Brain asks the questions the brief still needs, as **cards**: a short thread title, a question and 3 numbered options under the answer; the composer is the "your own answer" field while a card is open.
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

## Proposals and the plan step (S1, `claude/nsai-s1-plan`)

BRIEF v1's fields are unchanged by this section. What changed is what a proposal carries, and that a short film's storyboard is
written in its own step after the person chooses.

**A proposal is 2–3 outlines.** The proposing turn's `scenarios` (and each stored assistant message's `payload.scenarios`) holds
outlines, not storyboards:

```jsonc
{ "title": "", "idea": "", "story": { "logline": "", "conflict": "" },
  "chapters": [{ "id": "ch1", "title": "", "start_s": 0, "seconds": 20, "beats": [{ "at_s": 0, "text": "" }] }],
  "characters": [], "locations": [], "props": [],
  "scenes": [],                                  // always empty in a new proposal: the plan step writes them
  "target_seconds": 180,                         // the person's chosen length, never the sum of anything the model wrote
  "plan_turns": { "about": 3, "at_most": 6 } }   // short only, computed by the server on every read, never stored
```

- `chapters[].seconds` is the outline's own field. For a short film the chapters add up to exactly `target_seconds`, each at least
  3 s. An outline that does not add up is not proposed. `start_s` is computed from the lengths. The BRIEF's chapters keep v1's
  shape: `seconds` is dropped there, and `start_s` says where each chapter begins.
- A payload stored before this change, with `scenes`, is still read. Its scenes are used only when every one is 3–30 s and together
  they add up to `target_seconds` exactly. Otherwise the outline is planned like a new one, or the scenario is not offered.
- `plan_turns`: how many of today's messages writing this outline's storyboard uses. `about` is one turn per call. `at_most`
  counts every call being asked again once. The panel shows it before the press.

**Choosing a short outline** (`{ "action": "choose", "session", "index" }`) writes the storyboard on the server, in this order:
1. The safety floor, over the outline and the style and audience too (which go into every scene's prompt).
2. **The plan's lease** (migration 0211, `ai_chat_plan_begin`). It allows one running plan per conversation, granted under the
   conversation's row lock.
   - A second tab, a refresh or a repeat is refused `plan_running` while a plan runs (it expires after 320 s).
   - A failed or expired plan is granted again at once, as the next attempt.
   - Without 0211 the route answers `plan_unavailable`: there is never a plan without a lease.
   - The history read (`/api/brain/history?session=`) carries `plan: { state, reason, expires_at, scenario_index }`. With it the
     panel waits for a running plan, shows a failed one with its reason, or reads a finished one.
   - `ai_chat_plan_end` is called whatever happens, by the attempt's own number.
   - Before every write (the unpriced BRIEF, `save_film`, the priced BRIEF) the route asks `ai_chat_plan_state` whether its own
     attempt still holds the running lease (Breach BR-S1-08). A plan whose server stalled past 320 s and was taken over by another
     tab writes nothing and answers `plan_superseded`.
3. The film draft (`create_film_draft`), before any turn is spent: settings only, so a workspace that cannot make it is told now.
   Its key is `brain-` followed by 40 hex characters of a sha256 of the conversation, proposal and outline. The key never names
   the conversation, because every viewer of the workspace reads it.
4. The storyboard, in bounded calls of at most 15 scenes each, packed by the scenes their parts need, at most three at a time.
   Each call is an ordinary 0199 turn:
   - the first stores the outline's title as the person's message;
   - the rest use `p_retry` and add no message;
   - each request id is `pl` followed by 40 hex characters of a sha256 of the conversation, proposal, outline and attempt, then
     `-wN` (`-wNr` for the one re-ask).
5. The storyboard is kept as the BRIEF, unpriced: a refresh, or a draft save that fails, finds it, and choosing again re-reads it
   without a turn.
6. It is saved into the draft at the version the draft had. If someone edited the draft meanwhile, their edit wins (`plan_superseded`).
7. The quote (`quote_film`), then the BRIEF with its price.

**Choosing an outline again never writes over the film** (Lens H1). The draft's key replays the same film, and `create_film_draft`
answers it as it is now (0166 `film_read`: its version, models and scenes).
- If the draft already has scenes (this plan's, perhaps edited by the person since), nothing is saved into it and no BRIEF is written:
  the film is only priced, at its current version, and no lease or turn is taken. Create's own "Get a new price" (S2's
  `requoteFilm`) does the same and writes nothing.
- A plan whose replayed draft already has scenes stops before its first turn with `plan_superseded`: the film is left as it is.
- A stored storyboard that is not in the draft yet (a draft save that failed) is saved under a lease, like a plan.

Code merges the answers into one BRIEF: scenes `s1..sN` in order, at most 60, adding up to `target_seconds` exactly, and referring
only to the outline's ids. A plan answer may not name a vendor the outline does not, and may never claim that a vendor made it.

**A scene's prompt is never cut** (S9's contract for `creative_price`, migration 0218, which refuses an over-long prompt, a
`negative_prompt` on a model whose registry row has `takes_negative_prompt = false`, and a `seed` on any model, before the quote):
- The film gets each scene's whole prompt (`scenePrompt` in `lib/brain/logic.ts`): its visual prompt, then the descriptions of its
  characters and setting, its spoken lines and the film's style.
- The limit is the smaller of the picked clip and key-frame models' `limits.max_prompt_chars`, read server-side from their registry
  rows (`promptLimitOf` in `lib/server/brain/clip.ts`), never typed in code. With neither known, it is the film's own 2000
  (`film_limits.max_prompt_chars`). It is counted as 0218 counts it, in UTF-16 units (`.length`): an emoji is two.
- Every plan call is told the limit (`limits.prompt_max_chars`). A scene over it is asked again once with the limit, then refused
  as `prompt_too_long`. A stored storyboard over it is refused before the draft and before any turn.
- The BRIEF never carries a `negative_prompt` or a `seed`, so neither reaches the film.

**The models a film is made with are the server's choice** (`lib/brain/film-models.ts`). The model never names one.
- At `choose`, the server reads the models on sale now (`sellable_models`, web) for clips (i2v) and key frames (t2i, and edit,
  which 0166 also takes as a film's key-frame model). It picks the first one on sale from a fixed order:
  - clips: MiniMax H3, then Kling v3 (docs/FILM_STUDIO.md "Models");
  - key frames: GPT Image 2.6 Sunburst, GPT Image 2.6 Flare, Gemini 3 Pro Image, Nano Banana 2.1 (the most reference pictures).
- Nothing outside the order is ever taken. With none on sale for a role, that role is left unset and `quote_film`'s
  `model_not_set` says what to do. A catalogue that cannot be read plans nothing (503, no turn).
- The picked ids go into the draft's settings (`clip_model`, `keyframe_model`) and into BRIEF v1's existing `scenes[].clip_model` /
  `scenes[].keyframe_model`.
- The clip model's longest shot × `max_shots` is the longest scene every call is told to write. Its `durations_s` set each scene's
  `shot_count` (G4).
- Choosing again keeps the draft's models only when the stored BRIEF names the server's own (in the fixed order): a BRIEF is its
  author's to write, so any other id in it is ignored and the server picks again (Breach BR-S1-07). If one has left the catalogue,
  the quote refuses with its own reason.
- The card names, and a scene's prompt is measured against, the models the film was actually drafted with: the ones
  `create_film_draft` answers, a key-frame model read from the t2i and edit catalogues alike.
- A stored prompt is measured as written, before any reader caps it: a scene over the limit is refused, never cut first.
- `choose` answers with `models: { clip: { id, name } | null, keyframe: { id, name } | null }`. The card says
  "Video: {name}" / "Pictures: {name}".
- A scene with dialogue is saved with `clip_params: { "audio": true }` (G3).

**Errors `choose` adds** (none of them prices anything, and a plan with a chapter missing is never saved):

| Body | Status | Meaning |
| :-- | :-- | :-- |
| `{ "error": "plan_over_cap", "needed": 16, "about": 8, "left": 2 }` | 429 | Today's turns cannot cover the plan's worst case (`needed` = `at_most`). Refused before the first call, so a plan does not stop halfway for the plan's cap unless other chats or plans use today's messages meanwhile (the check reads what is left; it reserves nothing). No turn is taken. With `"scope": "person"`, the cap that does not cover it is the person's own across workspaces (0199 `per_user_daily`, returned by the lease). |
| `{ "error": "plan_running", "expires_at": "iso" }` | 409 | Another plan of this conversation is running (another tab, or before a refresh). Nothing is reserved or called. The panel waits for it until `expires_at`. |
| `{ "error": "plan_unavailable" }` | 503 | Migration 0211 is not applied here: the storyboard is not written without a lease. |
| `{ "error": "plan_superseded", "film_id": "uuid" }` | 409 | The film already has a storyboard that this plan would replace: it was edited while the storyboard was written, it had one from before, or another tab's plan took this one's lease. The film is left as it is and nothing more is written. No credits are charged (the plan's messages are used). Open the project to see it. |
| `{ "error": "prompt_too_long", "scene": 3, "limit": 1500 }` | 422 | Scene 3's whole prompt is over the models' limit (UTF-16 units). Nothing is cut, saved or priced. From the plan's own calls, after the one re-ask, the answer carries `chapter` and `scene` counts within that chapter. No Retry: choose another scenario. |
| `{ "error": "proposal_outdated" }` | 409 | A proposal stored before the plan step whose scenes do not add up to the length: ask for new scenarios. |
| `{ "error": "plan_failed", "reason": "vendor_error", "step": { "window": 2, "windows": 4, "chapter": 3, "chapters": 6 }, "quota": {…} }` | 502 | One call failed (`reason`: the vendor's failure, `timeout`, `invalid_output`, `output_too_long`, `unavailable`). `step` names which part of the plan (null when the merge failed). The panel offers Retry: a new attempt of the lease, with new request ids. |
| `{ "error": "plan_failed", "reason": "not_plannable", "step": null }` | 409 | The film cannot fit 60 scenes within the clip model's longest scene. |
| `{ "error": "plan_length_mismatch", "step": { … }, "quota": {…} }` | 502 | A chapter's scenes did not add up to its seconds, even when asked again once with the reason. Nothing is stretched or cut to fit. |
| `{ "error": "content_refused", "quota": {…} }` | 422 | The plan's own safety refusal, or the vendor's. Not charged as a turn. |
| `{ "error": "duplicate_request" }` | 409 | A repeat inside one attempt (0199's request id): no call is made. The panel waits for the plan already running. |

A failed plan's `reason` of `not_plannable`, `vendor_auth` or `not_configured` is offered no Retry: a new attempt cannot change it.

**Known, accepted.** A plan call the plan's own safety rule refuses (`refused`), or the vendor's (`vendor_refused`), is forgiven by
the workspace's plan cap but counted by the person's own daily cap (0199 `per_user_daily`) and the platform's. So an outline written
to make every chapter refused can make a person spend turns on refusals without spending the workspace's cap. The ceiling on that
is `per_user_daily` (pinned in tests/security/test_sec_brain_plan_breach.py). The refusal is still said as such each time, and
nothing is priced.

### Writing a project's storyboard (the film editor, `/api/brain/film`)

The film editor's "Write the storyboard with AI" is the same plan step for ONE existing project, from its own settings (title,
source text, language, aspect, `target_seconds`). Code: `app/api/brain/film/route.ts`, `lib/server/brain/film-plan.ts`,
`lib/brain/film-plan.ts`; the scenes are written by `writeStoryboard` itself.

- `GET ?film=<id>` takes nothing. It answers `{ ready: true, turns: { about, at_most }, left, scope: "plan" | "trial",
  sets: { clip, keyframe }, plan }`, or `{ ready: false, plan: { state: "running", expires_at } }` while a plan of this project
  runs, or the press's own refusal (below). `sets` names a model the press would set, only for a role the project has none for.
  `plan` is running while ANY of the person's conversations marked with the project holds a running lease (the rule a press
  yields by, below); one whose lease cannot be read makes GET answer `unavailable` (503).
- `POST { film, session? }` answers `{ film: { id, version }, scenes, seconds, models, quota }`. `session` is only ever the
  `retry_session` of an earlier 503 (below).
- **The source text is read whole**, up to 40,000 code points, or refused before any turn (`source_too_long` 422
  `{ limit: 40000 }`, GET and POST): never cut to its first pages. The project's reference pictures and refs are not used by the
  writer yet: it reads the title, the source text, the language, the aspect and the length.
- **The chapters are the server's** (`filmChapters`: about 60 s each, adding up to `target_seconds` exactly). The model writes their
  words in ONE outline call (`FILM_OUTLINE_SYSTEM_PROMPT`; the project's title and source text go in the DATA block). Because the
  lengths are fixed, every window is known before any turn: `at_most` = 1 + 2 × windows, checked up front as in `choose`. That check
  reads today's messages left; it reserves none. So a plan does not stop halfway for the cap unless other chats or plans use
  today's messages meanwhile. The plan's 300 s are counted from the request's first line (the precheck included): a window that
  could not finish inside them is never started (`plan_failed` `{ reason: "timeout" }`).
- **The conversation** is the person's own 0199 conversation for the project's workspace and channel (`ai_chat_start`), marked in its
  BRIEF with `"film_plan": { "film_id": "uuid" }` (an extra top-level field; the chat ignores it). It is found again by that marker,
  author and workspace, oldest first. `/api/brain` and the history list leave marked conversations out by the same predicate
  (`brief->film_plan->>film_id IS NULL`), and `/api/brain/turn` refuses every action on one (`film_conversation` 409, no turn, nothing
  saved). The marker write is asked twice; if it still fails, the press answers `unavailable` (503) with `retry_session: <id>`, the
  panel keeps that id in component state only and sends it as `session` with the next press, and the server takes it back only
  when it is the caller's own conversation in the project's workspace and channel, not handed off, with an empty BRIEF, no message,
  and under 24 hours old; otherwise it starts a new one. A project whose channel left the workspace is `film_channel_missing` (409).
  The outline call stores the
  press as the person's message (the project's title); every plan call after it is a `p_retry` turn. The lease is 0211's with
  proposal 0, outline 0. Request ids: `fo` + 40 hex of a sha256 of the conversation, project and attempt, and the plan's `pl…` ids.
- **One plan at a time, per person.** Two first presses racing (two tabs, a double click) can each make and mark a conversation.
  So after its lease is granted, a press lists all of the person's marked conversations of the project (at most 5) and asks each
  other one's lease: while any is running, or cannot be read, it ends its own lease and answers `plan_running` (409) with no turn
  taken. It then reads the project again: scenes are `film_has_scenes`, a moved version `plan_superseded`, again with no turn. The
  database does not tie a plan to a project yet, so this is per person, not per project: two editors pressing on the same empty
  project within ~5 min: one plan is superseded, its turns are spent, the project is never double-written. Migration 0232 closes
  that later.
- **Never over a person's work.** A project with scenes is refused `film_has_scenes` (409) before any turn; the panel also stays
  off while the editor has scenes or unsaved changes. `save_film` is called at the version read first: an edit made meanwhile is
  `plan_superseded`, and nothing is written. While the plan writes (or another tab's is followed, or a lost answer is confirmed)
  the canvas is read-only; the project is never reloaded over unsaved changes, and `plan_superseded` offers Reload instead of
  reloading. A press whose answer is lost (a network error, a proxy's non-JSON 502/504) is never sent again: the panel asks GET
  every 5 s until the lease says running (ask again), done or the project has scenes (written), or failed / ready (a failure, with
  Retry by hand).
- **No vendor credit.** A title that claims an AI vendor made the film ("Written by ChatGPT") is `title_claims_vendor` (422) before
  any turn; a title that only names one ("The rise of OpenAI") plans. The floor under every plan answer (`claimsAuthorship` in
  `lib/brain/plan.ts`, the chat's and the editor's alike) refuses a claim in the credit's own shapes ("a film by", "brought to you
  by", "with the help of", "X is the author", "Credits: X", "фильм от", "автор:", "при участии", "X muallifi") naming a chat vendor,
  a video or image model whose name is also a word (Sora, Veo, Kling, MiniMax, Llama, Mistral, Grok, Copilot…: a claim only, never
  a name anywhere), or any model or provider the catalogue sells. The chat's `choose` checks the chosen outline the same way before
  any plan turn. A database error's own text is never sent: `reason` is a machine word or `unavailable`.
- **Models.** The project's own clip and key-frame models when it has them and they are on sale; one it names that is not on sale is
  refused `film_model_unavailable` `{ role: "clip" | "keyframe" }` (409), never swapped. A role with none: the server's
  `FILM_MODEL_PREFERENCE` pick, saved with the storyboard.
- Errors added: `film_has_scenes`, `film_not_editable`, `film_model_unavailable`, `chat_plan_required` (402) and `chat_daily_cap`
  (429) said before the press; `source_too_long` (422, `limit`), `title_claims_vendor` (422), `film_channel_missing` (409),
  `unavailable` with `retry_session` (503); and on `/api/brain/turn`, `film_conversation` (409). Everything else is `choose`'s, with
  the same meaning. No price is attached: the project's Start quotes.

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

## Film run status (P3)

The contract between the film worker (P3) and the screens that show a running film. The source of truth is the SQL:
migrations 0166 (the tables), 0171 (the money and the state machine) and 0198 (the switch per organization, the take's creative
job). Where this section and the SQL disagree, the SQL is right and this section is the bug.

A started film is paid by one segment (`film_segments`, one credit hold `fm-<segment id>`). The worker (`tools/film_worker.py`,
`modules/film_orchestrator.py`) claims the segment, makes its takes, hands the assembly to the assembly session, and settles the
segment once. Nothing here is decided in a browser: every transition below is a service-role database function.

### `films.status` (0166's check, with 0171's `queued`)

| Value | Set by | Meaning |
| :-- | :-- | :-- |
| `draft` | `create_film_draft`; `film_settle_segment` / the sweep when a segment charged nothing and made nothing | Editable and startable. After a run that never ran, `pause_reason` says why (`worker_unavailable`, `hold_expired`, `takes_failed`, ...). |
| `queued` | `start_film` | The hold is taken; waiting for a worker (at most 3 hours, then the sweep settles it as `worker_unavailable`). |
| `running` | `film_claim_segment` (first claim) | A worker holds the segment's lease. |
| `draining` | `film_settle_segment` or `film_cancel_segment` while a take or the assembly is in flight; the sweep past the deadline | Nothing new begins; it settles when what is in flight ends. |
| `ready` | settle with reason `completed` | Every take and the assembly completed. |
| `paused` | settle with any other reason after something was charged | `pause_reason` is the reason handed to the settle (see the assembly below). |
| `cancelled` | settle with reason `cancelled` after something was charged | |
| `archived` | `archive_film` | Put away (drafts only). |
| `planning`, `planned`, `assembling`, `failed` | nothing yet | Reserved by 0166. **No function sets them**: a running film is `running`/`draining` during its assembly too; the assembly's own state is on the segment. |

### `film_segments.status` (0171)

| From | To | Function |
| :-- | :-- | :-- |
| (new) | `queued` | `start_film` |
| `queued` | `running` | `film_claim_segment` (starts the hold's 24-hour clock, sets a 20-hour deadline) |
| `running` / `draining` (stale lease) | the same, another worker | `film_claim_segment` (at most 3 leases; after that what is in flight fails as `worker_lost` and it settles) |
| `running` | `draining` | `film_settle_segment` / `film_cancel_segment` with something in flight; `film_expire_segments` past the deadline |
| any live | `settled` (something captured) or `released` (nothing captured) | `film_settle_segment`, `film_cancel_segment`, `film_begin_take` (hold lost, refund pending), `film_claim_segment` (hold expired), `film_expire_segments` (unclaimed 3 h, hold gone, deadline + 2 h grace) |

`film_segments.assembly_status`: `planned` → `running` (`film_begin_assembly`, only when every take is completed or superseded) →
`completed` / `failed` (`film_record_assembly`, called by the assembly session; or `failed` when the sweep or the last lease ends it).
`planned` → `skipped` when the segment settles without an assembly. The assembly itself, its file and its failure words are the
assembly session's: see the assembly section of this file and docs/FILM_STUDIO.md, "Assembly (P4)".

### `film_takes.status` (0166's check) and what a canvas node shows

| Status | Set by | Node shows |
| :-- | :-- | :-- |
| `planned` (and `queued`, which 0171 never writes) | `start_film`; `film_take_failed` / a rejected clip plan attempt 2 | **queued** |
| `running` | `film_begin_take` (before the paid call) | **running** |
| `completed` | `film_take_succeeded` (a clip only when its file measures at least 90% of its seconds) | **done**: `result_asset_id`, and for a clip or extend `result_last_frame_asset_id` |
| `failed` | `film_take_failed` with no retry left; a clip rejected by length with no retry left; the sweep or the last lease (`worker_lost`) | **failed**: `error_code` (below), charged 0 |
| `superseded` with `charge_basis = retried_not_charged` | the first failure of a take | **retried**: point to the attempt-2 take of the same slot (`kind`, `scene_id`, `shot_index`, `version`, `attempt` + 1) |
| `superseded` with any other basis | nothing today (P7's re-shoot) | **superseded** |
| `skipped` | the settle or a cancel, for a take that never began (charged 0) | not shot (the run ended before it) |

The narration is **one film-level take**: `kind = 'narration'`, `scene_id` null, `shot_index` 0. Its file (audio) runs on the film's
clock: each scene's words start 0.25 s into the scene, and the file's provenance carries the per-scene `segments`
`[{scene_id, start_s, end_s}]` and the measured `loudness_lufs` / `true_peak_db` (null when not measured).

The order the worker makes them in: every key frame, then the shots scene by scene (shot 1 from its first frame, shots 2-3 from the
previous shot's last frame), then the narration. Once any take has failed for good (its one retry failed too), or a shot can
never begin because its input did, the film can no longer be assembled: nothing new begins, not even the narration, and the
segment settles `takes_failed`. What was planned is `skipped` at 0; with nothing charged and nothing made the film is back in `draft`.

### Why a take failed: `film_takes.error_code`

The worker writes only these words (`modules/film_orchestrator.FILM_ERROR_CODES`). 0171 itself writes two more when it rejects a
clip by its recorded length, `output_too_short` and `output_length_unknown`; show both as `too_short`. `worker_lost` is also written
by 0171 when a lease or the deadline runs out.

| Code | Customer line | Remedy |
| :-- | :-- | :-- |
| `auth` | The generation service refused our access. | None for the customer; we're notified. |
| `quota` | Out of capacity right now. | Retry later. |
| `plan_required` | Not available on our current service plan. | Pick another voice or model. |
| `rate_limited` | Too many requests at once. | Retry later. |
| `bad_request` | The service refused this shot's settings. | Edit the scene. |
| `voice_not_found` | The voice no longer exists. | Pick another voice. |
| `moderated` | Content declined. | Change the description. |
| `provider_error` | The service failed. | Retry. |
| `timeout` | It didn't finish in time. | Retry. |
| `too_short` | The clip is shorter than planned. | Retry, or lower the seconds. |
| `no_output` | No file was returned. | Retry. |
| `worker_lost` | Our worker stopped; nothing was charged. | Start again. |
| `film_studio_off` | Switched off during the run. | Contact support. |

A take whose model went off sale after the film started (retired, hidden, unpriced, past its shutdown date or switched off: the
worker asks `sellable_models` again right before every take's paid call, as the creative worker does, `modules/creative_worker.py`
"Still on sale") is never sent: it fails as `bad_request`, charged 0, with an error text that names the model and says to choose
another. There is no word of its own yet because the live view has copy only for the words above; its one retry meets the same answer,
and the segment settles as `takes_failed`. The worker never swaps the model. If that answer cannot be read, nothing is sent and
the segment is left for the next claim.

`film_studio_off` is the settle reason (`films.pause_reason`) when the platform's or the organization's switch went off during the
run: nothing new begins (the database refuses `film_begin_take` and a new `film_take_job` with `film_studio_disabled`), a take that
was about to be sent ends with `error_code = film_studio_off`, and the takes that had not begun are skipped. A task already at the
vendor is still polled to its end, and a running segment may still be re-claimed for that.

A take's creative job (`payer = 'film'`) is never shown in the Studio's job feed, never listed by the credit worker's queue, never
cancellable by a member (`not_found`), notifies nobody, and ends when its take ends.

### Where an assembly failure shows

Only in three places: `film_segments.assembly_status = 'failed'`; `films.pause_reason`, which is exactly the reason the worker handed
to `film_settle_segment` (the assembly session's own word, or `assembly_failed`, or `assembly_unavailable` when the assembly is not
installed on the worker); and the `segment_settled` event's `reason`.

### `film_events.event`

`created`, `saved`, `archived` (0166); `started`, `start_refused`, `segment_claimed`, `take_completed`, `take_failed`, `take_retried`,
`assembly_completed`, `assembly_failed`, `segment_cancel_requested`, `segment_settled` (with `not_captured` when the hold could not
pay everything), `segment_skipped` (a segment the claim or the sweep could not touch, at most one an hour) (0171).

### The assembly handoff

**Both switches, or no claim.** `tools/film_worker.py` claims a segment only while `NIGHTSHIFT_FILM_WORKER=on` **and**
`NIGHTSHIFT_FILM_ASSEMBLY=on` **and** `modules.film_assembly` imports. Otherwise it logs one line naming what is missing and only
runs `film_expire_segments`: a queued film is never claimed, so its hold is never started, and the sweep settles it at 0 after 3
hours (`worker_unavailable`, back to draft). The checks below are the same rule again, for a segment claimed before a switch moved.

1. When every take is completed and at least one clip exists, the worker decides, in this order:
   - `modules.film_assembly` is **not installed** on the worker: it calls `film_begin_assembly`, records the assembly as failed
     (`film_record_assembly(segment, worker, false, null)`) and settles with `assembly_unavailable`.
   - It is installed but **`NIGHTSHIFT_FILM_ASSEMBLY` is not `on`**: nothing is begun, recorded or settled; one log line names the
     switch, and the segment is left to 0171 (the claim after its last lease, or `film_expire_segments` at the deadline plus the
     grace, settles it with the takes that were made).
   - Otherwise it calls `film_begin_assembly(segment, worker)`: `assembly_status` becomes `running`; the segment stays `running`.
2. Under the **same lease** (one lease per segment, no handoff; the worker keeps beating it through the assembly), the worker calls
   `modules.film_assembly.assemble_segment(segment, worker_id=..., db=..., media_root=..., tools=...)`. That code owns everything up to
   and including `film_record_assembly(segment, worker, ok, asset)`, its failure path included.
3. The worker then calls `film_settle_segment(segment, worker, 'completed')` when the assembly succeeded, or with its reason when it
   did not. When `assemble_segment` raises `DbUnavailable` (the database gave no decision) or `AssemblyDisabled` (its switch is
   off), nothing was recorded: the worker settles nothing and stops driving the segment. A worker that dies during the assembly, or
   stops like this, leaves `assembly_status = 'running'`; the next claim runs the assembly again.

## Assembly handoff (P3 worker → P4b assembly)

The plan becomes a film through Film Studio (migrations 0166 and 0171, docs/FILM_STUDIO.md). S6's worker
(`tools/film_worker.py`, `modules/film_orchestrator.py`) shoots the takes. The assembly (`modules/film_assembly.py`) turns
them into one finished mp4 at the film's aspect: the clips in scene order, the narration, the music if there is any, and the
captions (a WebVTT sidecar, and burned in when `captions_mode` is `burn` or `both`). This section is the contract between
the two, and it rests on 0171 as written.

### What 0171 decides

- **There is no segment state called `assembling`.** `film_begin_assembly` moves `film_segments.assembly_status` from
  `planned` to `running`, and the segment itself stays `running`. The canvas reads `assembly_status` and
  `assembly_asset_id`. `films.status = 'assembling'` exists in 0166's check, but nothing sets it.
- **One lease per segment.** Every service call (`film_begin_assembly`, `film_record_assembly`, `film_heartbeat_segment`,
  `film_settle_segment`) checks `film_segments.worker_id`. No function hands a lease over. `film_claim_segment` re-takes a
  segment only after its heartbeat has gone stale, and that costs an attempt (`attempts` + 1, capped by `max_attempts`).
  So a lease *can* move under a running assembly, and the assembly is built for that (below).
- **The assembly has no hold of its own.** It is one line inside the segment's `fm-<id>` hold. `film_record_assembly(ok)`
  charges the file's recorded length in whole minutes at the confirmed `film_assembly_minute` rate, never above its line.
  `film_record_assembly(false)` charges 0. The settle then captures what was charged and releases the rest.
- **`film_begin_assembly` answers as-is only while the assembly is running.** Once the assembly has ended, it refuses
  with `not_running`. `film_record_assembly` happens once: a retry with the same outcome and the same file gets the same
  answer, and anything else is an `idempotency_conflict`.
- **Nothing sets `film_scenes.current_version`** (choosing a version is P7's job). On a first shoot, the assembly cuts the
  version that this segment shot. A version a person has chosen is kept. A scene shot in two versions, with none chosen,
  is refused (`scene_not_shot`) rather than guessed.
- **No service function writes `film_takes.params`.** So the narration's timing goes on the narration *file*.

### The contract

1. **S6 holds the lease for the segment's whole life:** claim, takes, `film_begin_assembly`, the assembly, settle. Its
   heartbeat thread keeps running through the assembly, which can take up to `timeline.render_timeout_s(length)`
   (3 × length + 120 s).
2. **When every take is terminal** and `film_begin_assembly` has returned `assembly_status = 'running'`, S6 calls, in the
   same process and on the same lease:

   ```python
   outcome = film_assembly.assemble_segment(segment_json, worker_id=WORKER, store=film_assembly.AssemblyStore(media_store),
                                            media=media_store, media_root=MEDIA_ROOT, tools=tools)
   ```

3. **From there up to and including `film_record_assembly`, the assembly owns the work.** It reads the rows, builds the
   cut (`film_timeline.build_cut`) and the captions, renders through the editor's path, checks the output, and registers
   the master with provenance `{"film_segment_id", "film_id", "film_version", "cut_sha256", "captions_asset_id"}`. Then
   it calls `film_record_assembly(ok=true)`.
   **Every decision is recorded before the call returns.** A refusal, a bad output, or an unexpected exception (which is
   then re-raised) is recorded as `film_record_assembly(false)`, at 0. `outcome.recorded` says whether this call recorded.
   Four things are not decisions and are not recorded:
   - **The database did not answer.** That covers no answer, a timeout (`requests`' own errors included, during
     `register_asset` too), a 5xx, and a 4xx that is not a database function's refusal (Kong's 429, a JWT 401,
     PostgREST's `PGRST*`). Each raises `DbUnavailable` (a `ConnectionError`) and leaves the assembly `running`, so a
     paid, rendered film is never thrown away over a lost answer. A refusal is only a 4xx whose `code` is the
     database's (`NS…`, `P0001`, `P0002`, `42501`, `22023`) and whose `message` is a machine word.
   - **This worker's kill switch is off** (`AssemblyDisabled`). S6 does not begin an assembly while it is off; if
     one is running, it waits for a worker with the switch on, or 0171's deadline ends it at 0.
   - **The lease was lost** (`outcome.reason = 'lease_lost'`: the new holder records).
   - **The assembly is not running** (`not_running`: there is nothing to record).
   S6 settles a returned outcome. On `DbUnavailable` or `AssemblyDisabled` it settles nothing and lets the next claim
   retry.
4. **S6 then settles** with `film_settle_segment(seg, worker, 'completed' if outcome.ok else outcome.reason)`. The
   assembly never settles.
5. **Crash recovery.** If S6 re-claims a segment whose `assembly_status` is still `running`, it calls `assemble_segment`
   again. The master's asset id is `uuid5(segment, cut sha256)`. Whisper's word timings are cached per narration file
   (at temperature 0), so a retry builds the same cut. A file that a crashed attempt already registered is then recorded
   without rendering again. A segment whose assembly is already `completed` gets back the recorded file, with nothing
   rendered or charged twice. Past `max_attempts`, or past the deadline plus grace, 0171 itself fails a running assembly
   at 0 and settles.
6. **A lease that moves under a running assembly** (Breach BR-P4B-01 and -02):
   - each attempt renders in its own folder (`.film-assembly/<segment>/<attempt>`) and removes only that folder;
   - the lease is checked again (`film_heartbeat_segment`) after the render and before anything is registered;
   - a file registered just before the lease was lost is handed to `film_discard_unrecorded_assembly` (migration 0200,
     service role only). That soft-deletes it only when the segment's assembly is no longer running and did not record
     it, so a re-claimer's legitimate reuse is never touched.

### What S6's takes must carry

- Every clip and extend take is `completed`, with `result_asset_id` set. Every take that continues a shot or a scene has
  `first_frame_asset_id` equal to its predecessor's `result_last_frame_asset_id`, because `film_timeline` checks
  continuity against them.
- Clips in the film's aspect (2 % tolerance), probed (width, height and `duration_s` on the library row), and at least as
  long as their share of the scene.
- **The narration file's provenance**, written with `register_asset` when the file is registered (the take's `params`
  are read first, if a later migration ever writes them):

  ```json
  {"film_take_id": "<take>",
   "segments": [{"scene_id": "<scene>", "start_s": 0.25, "end_s": 9.5}],
   "loudness_lufs": null, "true_peak_db": null}
  ```

  Times are in the file's own time, on the film's clock: each scene's words start `NARRATION_LEAD_S` (0.25 s) into the
  scene, so a 60-scene film is one sound clip, not 60. Loudness that was not measured stays `null`, never a default
  (rule 5). **No `words` in provenance:** 0038 caps provenance at 16 KB, and about 400 words (2.7 minutes of speech)
  already exceed it (Lens L4). The assembly times the captions with Whisper base on the file instead. A word that
  overlaps a segment is kept as it is. A word whose timings fall entirely outside every segment lies in a silence the
  narration never speaks in: a transcription artefact (Whisper invents words in silence), not speech. It is **dropped,
  never failing the paid film** (Atlas's decision for the owner, 21 Nov), and recorded:
  - on the master's provenance, as `captions_dropped_words`: `{count, words: [{word, start_s, end_s}] (at most 50),
    reason}`;
  - in the outcome's `detail` ("N word(s) outside speech dropped from the captions: <times>") and `dropped_words`;
  - in the worker's log.

### What the assembly refuses (no silent fallback, rule 4)

Each of these fails the assembly at 0, by name, with the remedy in `detail`. A shorter film is never rendered:

- every `film_timeline` refusal (`missing_take`, `take_failed`, `asset_unavailable`, `continuity_broken`,
  `aspect_mismatch`, `too_many_audio_clips`, `film_too_long`, …);
- `narration_missing`;
- `captions_failed` (captions were asked for and could not be timed);
- `disk_low`: less free space than the fast intermediates need, which is 8 MB per second of 1080p scaled by pixels, plus
  the output. Below that, the editor's renderer would quietly switch to a second lossy generation;
- `render_timed_out` and `render_failed`;
- `render_degraded`: `render_backend` redid the segments with its compact encode (a second lossy generation) after a
  failure or a full disk, instead of failing. It does that without raising; the assembly reads it off the render's
  timings;
- `output_mismatch`: the length is more than 0.12 s off the sum of the scenes, the frame is not the aspect's, or a film
  with sound came out without it;
- `store_failed`: also a library row whose recorded length is not the film's, since 0171 charges by that length;
- `review_copy_missing` or `review_copy_too_large`. The review copy is the library's 480p proxy of the master, and it must
  fit the 50 MB Supabase object ceiling;
- `assembly_not_enabled`.

### The flag

There is one allowlist, the database's: `public.film_studio_on_for(p_org uuid)` from S6's migration (0198 provisional).
It is true when the global Film Studio switch and the organization's own `film_studio_enabled` are both on. It is STABLE
and granted to service_role only. S6's claim already requires it; the assembly reads the same function again as a
defensive check, before any row is read or anything is rendered.
- **An explicit `false`** is the database's decision. The assembly is recorded as failed at 0
  (`assembly_not_enabled`), so its hold is released at the settle.
- **A missing function** (its migration not applied), a refusal, or an answer that is not a plain boolean is no
  answer. The call raises `DbUnavailable`: nothing is assembled and nothing is recorded (Sentinel R3), because a
  configuration gap must not cost a paid film.
- **`NIGHTSHIFT_FILM_ASSEMBLY=on`** is only the worker's kill switch, off by default. It is read before the database
  (`AssemblyDisabled`, above), and is wired like every other media-worker switch: `deploy/.env.worker.example` and
  `deploy_web.yml`'s worker env, from the repository variable of the same name.

### Money

The assembly never reads or computes a price. 0171 charges the registered file's recorded length at the rate confirmed
when the film started, which `quote_film` and `creative_price` read from the `film_assembly_minute` row of
`credit_prices`. 0171 seeds no such row (a fresh database reads `unpriced`). The live database has one, added by hand
with the owner's approval. The lab, `tests/security/test_sec_film_assembly_worker.py`, drives this module against 0171's
real functions and checks these four things:
- a completed assembly is charged its minutes once;
- a crash leaves it charged 0, and the line is released at the settle;
- a retry after a lost record renders once and captures once;
- an organization that is not flagged pays nothing for an assembly.

`tests/security/test_sec_breach_film_assembly_worker.py` adds Breach's attacks: two lease holders racing, a render that
outlives its segment, a forged worker id or organization, a foreign row at the master's id, and the charge cap.
