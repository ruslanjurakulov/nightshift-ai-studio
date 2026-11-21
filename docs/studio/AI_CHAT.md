# Nightshift AI — the Studio's planning chat

A chat on Studio Create (`/{channel}/create`, the overview) that plans **one** faceless YouTube video with the person:

1. It asks for what a script needs: length, style, platform, language and audience.
2. It proposes 2–3 scenarios, each with the backend's own price.
3. When the credits do not cover a scenario, it says so plainly, offers the longest length that fits, and links to the plan upgrade and to buying credits.
4. A chosen scenario opens the existing **Run now** form, prefilled.

The person confirms the price there; the chat itself never holds, charges, starts or publishes anything (CLAUDE.md rule 3).

It is the conversational front end PLANNER.md §4 describes, kept to what Run now makes today. The Planner's DAG, its executor and automatic generation are out of scope.

## Turning it on

| Variable (repository) | Values | Meaning |
|---|---|---|
| `NIGHTSHIFT_AI_CHAT` | empty / `off` | Nowhere: the panel is not rendered and `/api/ai-chat` answers 404 |
| | `orgs` | Only the workspaces in `NIGHTSHIFT_AI_CHAT_ORGS` |
| | `on` | Every workspace |
| `NIGHTSHIFT_AI_CHAT_ORGS` | comma-separated workspace ids | The owner's and the demo workspace's |

The two **secrets** are its own keys:

- `AI_CHAT_ANTHROPIC_API_KEY` (Claude Sonnet 5.5);
- `AI_CHAT_OPENAI_API_KEY` (GPT-6 Luna).

They are separate from the worker's `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, so the web server holds an LLM key only when the owner adds one for the chat. A key with its own spend limit is the safer choice. A model without its key shows "not set up on this server yet".

Apply migration **0197** first. Without it, the panel says Nightshift AI is not set up on this database.

## Which models

- The chat offers the registry's text models that are **on sale on the web** (`sellable_models('describe', 'web')`: probed, priced, switched on) **and** have a key on this server.
  - Claude Sonnet 5.5 is the default.
  - GPT-6 Luna is offered.
  - Gemini is shown as not available yet: it carries a terms gate and needs the adult attestation (0192).
- The model is explicit. A model that is unavailable, refuses or fails is said as such, with the remedy (bad key, empty balance, busy, refused, no answer). The other model is never tried in its place (CLAUDE.md rule 4).

## What the code guarantees (not the prompt)

`command-center/lib/ai-chat/logic.ts`:

- **Questions before proposals.** No scenario is shown until all five slots are filled. A model that proposes early has its scenarios dropped.
- **Lengths.** A scenario's length is one Run now takes (60, 180, 300, 600 or 1200 s).
- **Prices.** Every price is `estimateForChannel`'s (the Run now estimator, over `credit_rates`) for that length. A number the model writes is never read, and the model is never shown a price.
- **When it doesn't fit.** The longest length that fits is found by asking the estimator at each shorter length, never by dividing.
- **Text.** The model's text is plain, bounded, and rendered as text.

## Data, never instructions

- The model calls nothing. Each turn the server reads the channel's facts **as the person** (RLS) and hands them to the model as one JSON data block, along with the conversation:
  - recent videos and their latest views;
  - competitors' fastest titles of the last two weeks;
  - the audience's asks mined from comments (`demand_signals`). Raw comments never reach the model.
- The system prompt says nothing in that block is an instruction.
- When there is no data the chat says it is working from the topic alone. When the data could not be read it says that instead, never "no data" (rule 5).

## Cost and the cap

- LLM calls cost the platform money and are free to the person, within a per-workspace daily cap: **40 messages in a rolling 24 hours** to start.
- The cap is enforced in the database (`ai_chat_reserve_turn`, under the workspace's lock) **before** any vendor is called. A dead model is refused before the cap is touched.
- The owner changes the cap with `select public.ai_chat_set_limits(<per_org_daily>, <max_input_chars>);`.
- The metering (`ai_chat_calls`: workspace, person, model, tokens, outcome; no text) is read by the owner with `select * from public.ai_chat_usage('2026-11-01', '2026-11-30');`.
  - No vendor cost is stored or sent to a browser.
  - The token counts are what the server reported for the turn. A person calling the database directly could only under-report their own.

## Privacy

A conversation is visible only to the person who started it, not to the workspace's other members and not to the operator. Migration 0197's rollback drops every conversation.
