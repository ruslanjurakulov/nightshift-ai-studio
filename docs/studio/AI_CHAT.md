# Nightshift AI — operating it

This page covers turning it on, its costs and its limits. The product contract (names, BRIEF v1, cards, handoff) is in
docs/studio/NIGHTSHIFT_AI.md.

## Turning it on

1. Apply migration **0197** (the number is assigned at merge).
2. Add the repository secret `AI_CHAT_ANTHROPIC_API_KEY`, and optionally `AI_CHAT_OPENAI_API_KEY`.
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

## Who may use it

- **Plans.** Plus (`creator`), Pro and Business (`studio`).
- **Free trial.** A plan without a row in `ai_chat_plan_caps` (free) gets 3 messages in the workspace's whole life. The count comes from the metering, which no member can change. Two tabs cannot both take the last one. After the trial the panel is locked, with "Upgrade plan". The conversation already on screen stays. Change the number with `update public.ai_chat_settings set trial_messages = <n> where id;`.
- **Pilot.** A workspace the owner lists gets Business's cap (300 a day) whatever its plan: `select public.ai_chat_set_pilot('<workspace id>', true);`. `false` takes it off again. The list is in `ai_chat_owner_settings()`. No workspace id is written in the migration. For the pilot, list the owner's and the demo workspace, both also in `NIGHTSHIFT_AI_CHAT_ORGS`.
- **Role.** An editor or above. A viewer is told that an editor can use it.
- **Starting a long video.** Run now itself stays an admin's press. Others are told so.
- **Age.** Someone who said they are under 18 is not served (0192).

## The model

- The owner chooses it: `select public.ai_chat_set_model('anthropic-claude-sonnet-5-5');`. The default is Claude Sonnet 5.5.
- It must be a registry text model. Each turn also checks that it is on sale (`sellable_models('describe','web')`) and keyed on this server.
- Customers never see or pick it. When it is down, the panel says "Nightshift AI is unavailable right now". No other model is tried.
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
- **Short films.** At least 10 seconds (0198).

## Cost

- **Who pays.** The person is not charged for messages; the platform pays the vendor.
- **Metering.** `ai_chat_calls` records workspace, person, model, tokens and outcome. It holds no text.
- **Reading usage.** `select * from public.ai_chat_usage('2026-11-01', '2026-11-30');`
- **What the tokens mean.** They are what the Command Center reported for each turn. An unreported count stays unknown.
- **Accuracy.** A member calling the database directly can misreport their own turns, within 1M tokens in and 100k out per turn. Reconcile with the vendor's dashboard.
- **Where vendor cost lives.** No vendor cost is stored or sent to a browser.

## Privacy

A conversation is visible only to the person who started it: not the workspace's other members, not the operator. The vendor receives an opaque hash of the workspace, never the person's id. The rollback drops every conversation; films created from a plan remain.
