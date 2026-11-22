# Nightshift AI · Studio · Brain — the build program (22 Nov 2026)

Owner of this file: **Atlas** (the coordinating session). Every stream reads it first, then `CLAUDE.md`, then the contract it builds
against. A change to anything a second stream depends on (a field, a route, a table, a file another stream owns) goes to Atlas
first; it is never silent.

## The goal, in the owner's words

> Give Nightshift AI a topic, and it works live, like the reference videos: the AI plans the film, the cards appear on the canvas,
> the pieces are generated and fall into the timeline one by one, and a finished video comes out. The site must justify a
> $1.5M budget in every respect and stand first among its competitors.

Reference material (frames, in Atlas's session; described here so every stream has them):

- **The timeline** ("agentcut" editor): near-black panel; transport row with play/step, a large monospace timecode in an accent
  colour, `/ total`, a status word; a ruler with timecodes and a thin playhead with a flag; track headers in small uppercase
  monospace with a dim second line; segments as rounded saturated pills, one tone per track, monospace label inside, 1–2 px gaps;
  labelled agent tags (`caps-01`, `fx-02`) that fly to where a piece lands; a live "activity" log of what each worker did.
- **The canvas** (buzzy.now): dark canvas, image/video cards with 1 px borders and a small title above, soft grey bezier wires
  converging into a round "+" merge hub, cards grouped in subtle rounded frames, a floating dock.
- **Public site benchmarks**: Higgsfield, Krea, Runway, Buzzy, OpenArt (screens in Atlas's scratchpad `comp/`). We never publish
  a vendor price or a competitor comparison (owner's rule: project secret).

## What already exists (do not rebuild it)

| Piece | Where | State |
| :-- | :-- | :-- |
| The shared contract (names, BRIEF v1, question cards, handoff, film run status, assembly handoff) | `docs/studio/NIGHTSHIFT_AI.md` | merged; binding |
| Brain on the Studio canvas, question cards, BRIEF store | 0199, `lib/brain/*`, `/api/brain/*` (#843) | merged, behind `NIGHTSHIFT_AI_CHAT` |
| Film data, money, per-org switch, 10 s films | 0166, 0171, 0198, `docs/FILM_STUDIO.md` | merged, switched **off** |
| Film worker (P3) | `tools/film_worker.py`, `modules/film_orchestrator.py` (#853) | built, not switched on; switch-on gates open |
| Assembly (P4a/P4b) | `modules/film_timeline.py`, `modules/film_assembly.py`, 0200 (#845) | built, behind `NIGHTSHIFT_FILM_ASSEMBLY` |
| Live view of a run, activity log | #852, #865 | merged, read-only |
| Film timeline UI | `components/studio-timeline/*`, `lib/studio/timeline.ts` | merged |
| Workflow runs (one total, confirmed, ordinary jobs) | 0073 | merged |

In flight (other agents of Atlas; build on them, do not duplicate): customer chat shell (`claude/c2-customer-chat-shell`), Gemini
Flash for the customer chat (`claude/chat-gemini-flash`), the canvas dock + timeline lane (`claude/canvas-timeline-lane`), the public
homepage (PR #889, `vera/landing-models-ribbon-font`).

## The streams

Each stream is one session, a team of the project subagents (`.claude/agents/`), and one or more **draft** PRs. The session is the
stream lead; its subagents write, review, test and attack the code. Pipeline per PR (CLAUDE.md "The team"): Scout (if a provider is
involved) → Forge → Lens (+ a specialist reviewer) → Probe → Breach (money, auth, uploads, prompts) → Sentinel → Forge fixes → Pixel
(any UI) → the lead's final check → CI green → report to Atlas. No stream merges; Atlas merges in migration order after the owner's OK.

| Stream | Branch prefix | Owns (may edit) | Must not edit | Migration |
| :-- | :-- | :-- | :-- | :-- |
| **S1 Brain & plan** — topic → questions → a complete BRIEF with scenes, characters, locations, dialogue → draft nodes on the canvas → Create hands off to `create_film_draft`/`save_film` with the server's price | `claude/nsai-s1-` | `lib/brain/**`, `app/api/brain/**`, the Brain panel components, BRIEF → draft-node mapping (S6b) | money functions, worker, assembly, the lane files | 0211 (only if needed) |
| **S2 Run & money** — the film run switch-on gates (`docs/FILM_STUDIO.md` "Switch-on gates": the sweep every ≤15 min, `not_captured` alerts, the rest), end-to-end on the local Postgres lab with fake adapters, security pass on every money path, Create → `quote_film` → `start_film` wiring (in S2's own `useFilmStart`/`FilmCreateButton`, which S1's panel mounts); resume quotes only the takes not completed, at today's rates, confirmed by the person | `claude/nsai-s2-` | `modules/film_orchestrator.py`, `tools/film_worker.py`, money migrations, `.github/workflows/*film*`, `tests/security/` additions | Brain prompts, UI except the Create/price button | 0212 (sweep), 0215 (archive/resume) |
| **S3 Live canvas & timeline** — a started film lights the canvas cards from real status and fills the lane piece by piece (take → segment), agent tags, the activity log in the reference style, refresh-safe, realtime or polling with backoff | `claude/nsai-s3-` | the live view, the lane's data layer, activity log | money, worker, Brain | none expected |
| **S4 Assembly & export** — P4b on the real media worker (measure first, rule 8), the finished master in the lane, 480p review copy, download/export, the private upload stays behind the publish gate | `claude/nsai-s4-` | `modules/film_assembly.py`, `modules/film_timeline.py`, assembly workflow/docs | publish behaviour (rule 2) | 0213 (only if needed) |
| **S5 Design & benchmark** — the "$1.5M" bar: one visual language for the public site and the Studio (tokens, type scale, spacing, motion, dark-first), competitor benchmark, a Pixel audit of every stream's PR, and the app-shell polish in files no other stream owns | `claude/nsai-s5-` | `app/tokens.css`, `components/ds/**`, shell/rail/header styles, `docs/design/**` | another stream's components (send it findings instead) | none |

| **S6 Voice & lip-sync** — a narration/voice model a customer can be sold (ElevenLabs on the plan its terms require; Uzbek only on v3/v4), lip-sync of a character's lines onto a clip (Kling lip-sync or another verified provider), both as registry entries that stay unconfirmed until a real call through the adapter succeeds; the film's voice track for S2/S4 | `claude/nsai-s6-` | `modules/audio_mixer.py` voice paths, `modules/voice_worker.py`, `modules/creative_adapters.py` (new adapters only), the model registry entries, `docs/research/**` | Brain prompts, money functions (ask S2), assembly (hand S4 the track contract) | 0214 (only if needed) |

Dependencies: S1 → (BRIEF, film id) → S2 (S6 supplies the voice/lip-sync models S1 may propose and S2 may run) → (film status, takes, events) → S3 → (segment order) → S4 → (master) → S3 shows it.
S3 builds against the contract's status tables now and rebases on `claude/canvas-timeline-lane` once that is pushed. S5 reviews
everyone and lands tokens early so others consume them.

Migration numbers: applied live up to 0209 (0206/0207 reserved, 0208 in PR #881, 0210 provisional elsewhere). Numbers above are
provisional; Atlas renumbers at merge. Additive only, applied by hand.

## The owner's approvals (22 Nov 2026, in chat with Atlas: "hammasiga ruxsat beraman")

The owner approved every non-code step the program needs. Atlas carries them out and reports each; a stream never acts on them directly.

- **Switches and migrations:** applying the program's migrations live and turning on Film Studio (`film_studio_enabled` / the per-org switch, first for the owner's and the demo workspace only), `NIGHTSHIFT_FILM_ASSEMBLY` and `NIGHTSHIFT_AI_CHAT` for those workspaces — each only after its PR is merged, CI is green and the switch-on gates in `docs/FILM_STUDIO.md` hold.
- **One real paid test film** through the whole chain, run by Atlas in the owner's workspace once S1–S4 are merged; budget cap **USD 15 total** for the program's live tests unless the owner raises it. Streams test with fakes and the local lab only.
- **Vendor plans:** ElevenLabs on the plan its OEM terms require for resale, and a Kling API package with lip-sync. Purchases are the owner's own act on the vendor's site (Atlas tells him when the adapter is ready, so no month is paid for nothing); keys go to GitHub Actions secrets through the Command Center, never into chat.
- **Kling letter of authorization:** signed and submitted by the owner himself.
- **Storage:** film masters and film review copies live on our own server's media volume and are served through the session + RLS library route. They are never copied to Supabase Storage, whose free tier (1 GB total, 50 MB per object) stays for the per-channel review copies. Supabase holds rows, not film media.
- **Spending a customer's credits (22 Nov):** only members of the customer's organisation may start or resume a paid film (or any paid job) on its credits; a platform admin who is not a member may not. Support staff who need to help are added as members by the customer.
- **Google models (S10 decisions D1–D7, 22 Nov):** D1 the "not for consumer use" clause is read as applying to the API itself, not to the Studio on top of it; D2 the 0192 18+ self-attestation is the gate; D3 the Studio shows model names (e.g. "Nano Banana") in its list, no Google logos and no partnership claim; D4 follow Google's own available-regions list (#881 GOOGLE_BLOCKED is the single source); D5 the privacy policy and ToS get Google as sub-processor, its 55-day retention and the pass-down of Google's terms (en/ru/uz); D6 Omni refuses uploads of minors and video edit/extend for EEA/CH/UK, server-side; D7 when gemini-3.6-flash doubles on 2027-01-01 the customer price rises, the model stays. A Google model reaches customers only after its paid probe succeeded (cap USD 0.50, inside the USD 15 live-test cap), #881 is live, the D5 text is merged and, for Omni, the D6 gate.
- **Design:** the app's AND the public site's dark ground is neutral near-black, not navy (owner's choices of 22 Nov after S5's benchmark); accent colours stay.

## Rules every stream keeps (from CLAUDE.md; the ones this program touches most)

- No browser publishes, renders or spends. The person's Create is a database call with the backend's price, confirmed.
- No silent fallback: a model, voice or source that is down stops the run with the remedy named.
- Unknown is shown as unknown (a duration, a price, a verdict).
- Every upload is private; nothing here adds a publish path. Film Studio and the Brain stay behind their switches; the owner turns
  them on.
- No secret in code, logs, events, chat or PR text. Keys go to GitHub Actions secrets.
- Every user-visible string in en/ru/uz; Uzbek with ʻ (U+02BB) and ʼ (U+02BC).
- No vendor price, margin or competitor comparison on any public page.
- Real spend (a live film run against a vendor) only after the owner's explicit go-ahead, asked through Atlas.

## Definition of done for the program

A signed-in member of a switched-on workspace types a topic; the Brain asks its cards; the canvas draws the plan; Create shows one
backend price; after the press the cards light up and the lane fills piece by piece; the assembled video appears at the end of the
lane and can be downloaded; it is uploaded private; refresh, provider outage, insufficient credits, duplicate press and a phone width
all behave. Every screen on the way meets S5's bar.


**creative_price apply order (22 Nov):** 0208 (live) → 0218 → 0219 → 0224. 0224 re-points onto 0218's body; 0218's drift guard also accepts the 0208+0224 body, so either order is safe. 0222 is live.

## Migration numbers assigned (provisional; Atlas renumbers at merge)
| No. | Stream | What |
| :-- | :-- | :-- |
| 0208 | (#881) | Google country gate + image price by size (LIVE) |
| 0211 | S1 | ai_chat_plan_leases (one plan at a time per conversation) |
| 0212 | S2 | film sweep schedule + film_sweep_status |
| 0213 | S4 | (only if needed) |
| 0214 | S6 | voice_language_problem |
| 0215 | S2 | film archive/resume + opaque worker id in film events |
| 0216 | S6 | 'lipsync' capability (when the adapter is probed) |
| 0217 | S7 | reserved root segments refused for channel ids |
| 0218 | S9 | creative_price refuses before the hold: prompt over the model's max_prompt_chars (UTF-16 units), negative_prompt unless `takes_negative_prompt`, seed everywhere; params refusal never echoes caller keys (Breach F1–F3) |
| 0219 | S9 | operator-only assistant exposure for web_only models; Seedance never exposed (applied with 0218) |
| 0220 | S2 | quote_film/start_film call voice_language_problem (after 0214 + probe sync) |
| 0221 | S9 | oauth_creative_list (MCP list_creative_jobs) |
| 0222 | S10 | retire gemini-omni-1.1-flash before Google re-routes it to 1.2 on 2026-12-03 (LIVE 22 Nov) |
| 0223 | S10 | Omni 1.2 registry row (hidden until probed) + EEA/CH/UK gate on minors' uploads and video edit/extend (D6, after 0208) |
| 0224 | S10 | dated price row: gemini-3.6-flash customer price rises 2027-01-01 00:00 UTC (D7) |
| 0225 | S2 | worker identity: table SELECT revoked, named column grants (BR-0036-01/02, BR-S-031) |
| 0226 | S2 | is_org_spender everywhere credits are spent: a non-member platform admin cannot spend a customer org's credits (owner decision 22 Nov); helper introduced in 0215 |

Streams S7 (language URLs), S8 (media-first cards, sound), S9 (MCP Studio tools), S10 (Google models) were added on 22 Nov.

## Reporting

Each lead sends Atlas a short report when a PR is ready (branch, PR link, what was verified, screenshots, open risks) with the
session messaging tool to Atlas's session, and immediately when blocked or when a contract change is needed.
