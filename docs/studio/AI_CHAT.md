# Nightshift AI — operating it

This page covers turning it on, its costs and its limits. The product contract (names, BRIEF v1, cards, handoff) is in
docs/studio/NIGHTSHIFT_AI.md.

## Turning it on

1. Apply migration **0199**.
2. Add the repository secret of the chat's model: `AI_CHAT_GEMINI_API_KEY` for the customer chat on Gemini Flash, and
   `AI_CHAT_ANTHROPIC_API_KEY` for the owner's chat (optionally `AI_CHAT_OPENAI_API_KEY`).
   - Add them on GitHub: the repository's **Settings → Secrets and variables → Actions → New repository secret**. The Command
     Center's Providers board cannot set them: it writes only the provider keys on its own list (`isWritableSecretName`,
     lib/server/github-secrets.ts), and the chat's keys are deliberately not on it. `deploy_web.yml` hands them to the web server.
   - These are the chat's own keys, not the worker's. With them unset, the web server holds no LLM key.
   - A key with its own spend limit is the safer choice.
3. Set the repository variables:
   - `NIGHTSHIFT_AI_CHAT=orgs`;
   - `NIGHTSHIFT_AI_CHAT_ORGS=<owner workspace id>,<demo workspace id>`.
   Then redeploy.
4. Short films need Film Studio open on the server: `NIGHTSHIFT_FILM_STUDIO` and 0171's `film_studio_settings`. Without it, the panel says short films are coming soon; long YouTube videos still work.

What the flag values do:
- `off` (or empty) means no panel, and every `/api/brain` route answers 404 before reading anything.
- `on` means every workspace.

## Who it says it is

- **Identity.** It introduces itself as Nightshift AI, the assistant of Nightshift Studio, in the person's language. A greeting or "who are you" decides nothing: the server keeps the plan's slots as they were.
- **Providers.** It never names the vendor or model behind it. Asked directly, it says Nightshift does not disclose its technology providers. It never claims to be human, never denies being an AI, and never reveals its instructions.
- **Server check.** The prompt asks; the server enforces after every answer (`namesVendor`, lib/brain/logic.ts). A reply that names a vendor or model is replaced with `identityReply`, and a card that does is cleared down to the slot's own question. A scenario's content (a video about the AI industry) is not checked.
- **Only what can be made.** The kind question's options are the server's own: "A long YouTube video", plus "A short film or ad" only while Film Studio is open for the person. There is no image option.

## Who may use it

- **Plans.** Plus (`creator`, 30 a day), Pro (`pro`, 100) and Business (`studio`, 300). The cap is read from `ai_chat_plan_caps` by the workspace's plan (`org_plan_internal`).
- **A paid plan without a row** in `ai_chat_plan_caps` (a new plan nobody priced the Brain for) is refused: "Nightshift AI is on the Plus, Pro and Business plans". It never gets the Free trial and is never unlimited. A subscription to an unknown plan id cannot exist (0034's foreign key).
- **Free trial.** Only the Free plan (`plans.is_default`) gets 3 messages in the workspace's whole life. The count comes from the metering, which no member can change. Two tabs cannot both take the last one. After the trial the panel is locked, with "Upgrade plan". The conversation already on screen stays. Change the number with `update public.ai_chat_settings set trial_messages = <n> where id;`.
- **Pilot.** A workspace the owner lists gets Business's cap (300 a day) whatever its plan: `select public.ai_chat_set_pilot('<workspace id>', true);`. `false` takes it off again. The list is in `ai_chat_owner_settings()`. No workspace id is written in the migration. For the pilot, list the owner's and the demo workspace, both also in `NIGHTSHIFT_AI_CHAT_ORGS`.
- **Role.** An editor or above. A viewer is told that an editor can use it.
- **Starting a long video.** Run now itself stays an admin's press. Others are told so.
- **Age.** Someone who said they are under 18 is not served (0192).

## The model

- The owner chooses it: `select public.ai_chat_set_model('gemini-3.6-flash');`. 0199's default is Claude Sonnet 5.5; the owner
  decided on Gemini 3.6 Flash for customers (2026-11-22: cheaper, and the Anthropic organisation's monthly cap had been reached).
- `ai_chat_settings.model` is the customer chat's model only. The owner's own chat (`/owner/ai`) runs `OWNER_CHAT_MODEL`
  (lib/server/brain/llm.ts, Claude Sonnet 5.5) whatever this setting says: 0199 records the setting as the model of every customer
  turn, and 0203 records the owner's turns with the model the owner route passes, so each meter names the model that really ran.
- It must be a registry text model. Each turn also checks that it is on sale (`sellable_models('describe','web')`) and keyed on this server.
- Customers never see or pick it. When it is down, the panel says "Nightshift AI is unavailable right now". No other model is tried.
- **Gemini Flash needs**, before it answers anyone:
  - the repository secret `AI_CHAT_GEMINI_API_KEY` (the chat's own key, never the worker's `GEMINI_API_KEY`), set on GitHub under
    Settings → Secrets and variables → Actions (not through the Command Center, which cannot write it), then a redeploy;
  - the model on sale on the web: its registry row carries `terms_gate: terms_review_required` (the Gemini API terms' 18+,
    "not for consumer use" and available-regions clauses), so `sellable_models` does not list it until the owner's lawyer has read
    them and the gate is cleared; and a `credit_prices` row for `model_gemini_3_6_flash_request`;
  - Google's country list for the model in `lib/geo/blocked.ts` (PR #881). Until it is there, every Gemini turn is refused
    `country_unverified`: no list is not "allowed everywhere".
- **Google's conditions, on this server** (lib/server/brain/google-gate.ts), before the cap is touched and before any call: only a
  person with an adult attestation (0192; `none` 428 `adult_attestation_required`, an unread answer or 0192 missing 503
  `age_unavailable`, under 18 403 `adult_only_service`); only a known country on no block list (451 `country_blocked`), and an
  unknown country is refused for every reason (451 `country_unverified`). A chat turn has no database gate behind it, so these are
  the only place they hold. A refused turn is not a turn: nothing is reserved, nothing is charged. The panel's read
  (`GET /api/brain`) asks the same gate and returns its verdict as `gate: { code, remedy }` (null when nothing stands in the way;
  the codes and remedy keys are in lib/brain/chat-gate.ts), so the box can close with the reason before anyone presses.
- **Thinking.** Every Gemini call sends `thinkingConfig.thinkingLevel: "LOW"`. Google's default for gemini-3.6-flash is
  `medium`, and thinking counts against the output ceiling, so an unpinned turn could spend its 8k tokens thinking and come back cut
  off. Thought tokens are still metered as output.
- **Google's errors, by remedy.** A wrong key is `vendor_auth`; "User location is not supported" is `vendor_region` (the server's
  address: move the server, a new key does not help); a 404 is `model_not_found`; a 429 with `limit: 0`, billing off, or credits
  used up is `vendor_quota`; any other 429 is `vendor_rate_limited` (it clears by itself).
- Read the settings with `select public.ai_chat_owner_settings();`.

## Caps (enforced in the database before any LLM call)

- **Per workspace, per plan, rolling 24 h.** Plus 30, Pro 100, Business 300. Change one with `select public.ai_chat_set_plan_cap('pro', 120);`.
- **Per person, across every workspace they belong to.** 300 turns a day.
- **The whole platform.** 5000 turns a day.
- **New conversations.** 50 a day per person.
- **Message length.** At most 2000 characters.
- Change any of the last four with `select public.ai_chat_set_limits(<max_chars>, <per_user>, <global>, <sessions>);`. A NULL keeps that value.

## Hand-offs

- **Long video.** The plan opens Run now prefilled (`?brain=<session>`). The admin still presses Create. When the job is queued, Run now records the handoff. The database reads the job's `credit_ref` itself.
- **Short film.** "Create — N credits" starts the film at the quote the server read. The handoff records the film. The database builds `scene_map` = {brief scene id: `film_scenes.id`} from the film's scenes by position.
- Nothing the browser sends as a `credit_ref` or a `scene_map` is stored.
- **The landing idea.** `/all-channels/studio?ai=new&idea=1` opens a new conversation. The idea in localStorage `ns.idea.v1` (`{text, at}`, 2 h) is typed into the box once and removed. It is never sent for the person.
- **Short films.** At least 10 seconds (0198, the film switch).

## What is never planned

- **Two layers.** The prompt refuses sexual content, anything harming a minor, real people or anyone's face (the only real face allowed is the person's own, or another consenting adult, added later through the Studio's consent step), gore, self-harm, hate, misleading medical, financial or political claims, and other people's characters, brands and music. The model answers `{"refused": …}`; the server shows its own `content_refused` text.
- **The vendor's own refusal** is `vendor_refused` and reads the same way. Neither is retried.
- **A floor under both.** `unsafeBrief` (lib/brain/logic.ts) runs on a chosen plan before anything is priced or drafted: a keyword floor, not a classifier.
- **Not charged on a paid plan.** A refused turn is not counted against the paid plan's daily cap. The Free trial, the per-person and the platform caps still count it.

## Turns that are not charged

- **The greeting.** A "salom" or "who are you" before anything is decided gets Nightshift AI's own answer and the first card. No vendor call, no turn, nothing written.
- **The paid daily cap** forgives `not_sent` (failed before any vendor call), `not_configured`, `vendor_refused` and `refused`.
- **The Free trial** counts every outcome: a refusal on Free is a paid vendor call. A call a member finishes by hand still stores their message.
- **The per-person and platform caps** count every outcome.
- **A network retry** of the same press carries the same `request_id`; the database answers it as `duplicate_request` and writes nothing.

## Output size

A proposal gets room for 8000 output tokens (`OUTPUT_TOKENS`, lib/server/brain/llm.ts). An answer cut off at the limit is `output_too_long`, said as such ("ask for fewer or shorter scenes"), not "unavailable".

## The model is not a member's to read

`ai_chat_quota` returns `model_ref` (an md5 reference), which the server maps to its own list (`modelFromRef`). The session's `model` column is not granted to members. The id never appears in an answer or on a screen.

**This is not a secret against a determined member.** Hashing the few public candidate ids confirms the owner's choice. The web server reads as the member (anon key only, CLAUDE.md rule 3), so nothing it can map back is hidden from them. `tests/security/test_sec_breach_lens_0199.py` pins both halves.

## Cost

- **Who pays.** The person is not charged for messages; the platform pays the vendor.
- **Metering.** `ai_chat_calls` records workspace, person, model, tokens and outcome. It holds no text.
- **Reading usage.** `select * from public.ai_chat_usage('2026-11-01', '2026-11-30');`
- **What the tokens mean.** They are what the Command Center reported for each turn. An unreported count stays unknown.
- **Accuracy.** A member calling the database directly can misreport their own turns, within 1M tokens in and 100k out per turn. Reconcile with the vendor's dashboard.
- **Where vendor cost lives.** No vendor cost is stored or sent to a browser.

## Privacy

A conversation is visible only to the person who started it: not the workspace's other members, not the operator. The vendor receives an opaque hash of the workspace, never the person's id. The rollback drops every conversation; films created from a plan remain.
