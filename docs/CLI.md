# Nightshift CLI

`@nightshift/cli` (command `nightshift`) is a command-line client for the public API (`docs/API.md`). It has no runtime dependencies, needs Node 20 or newer, and calls only endpoints that exist under `/api/v1`. It is the third door next to the REST API and the MCP server (`docs/MCP.md`); all three share one API key, one prepaid balance and the same limits.

Source: `packages/cli`. Agent Skills that teach an AI agent to use it: `skills/` (see `skills/README.md`).

## Install

Once the owner has published it:

```bash
npm i -g @nightshift/cli
npx @nightshift/cli whoami        # without installing
```

Until then, from a checkout of this repository:

```bash
npm i -g ./packages/cli
npx --yes ./packages/cli --version
```

## First run

Create a key in **Developers > API keys** (an owner or admin, after activating the API). Then:

```bash
nightshift login        # hidden prompt; checks the key with GET /v1/me, then saves it
nightshift whoami
nightshift balance
nightshift channels
```

`login` also takes the key from `NIGHTSHIFT_API_KEY` or from stdin (`echo "$KEY" | nightshift login`). `--key KEY` works but leaves the key in shell history, so the CLI warns. The key is accepted only if it has the right shape (`nsk_live_` plus 43 characters) and the API accepts it.

## Commands

Every command accepts `--json`, `--base-url URL`, `--debug` and `--help`. `nightshift help <command>` and `nightshift <command> --help` show usage and examples. `nightshift commands --json` lists the table for agents.

| Command | Does | Endpoint |
| :-- | :-- | :-- |
| `login` / `logout` | save or delete the key | `GET /me` (login) |
| `whoami` | organization, tier, limits | `GET /me` |
| `balance` | USD balance, holds, month spend | `GET /balance` |
| `channels` | channel ids for `create` | `GET /channels` |
| `accounts` | publish targets | `GET /accounts` |
| `create --channel ID [--topic] [--duration 90s] [--wait]` | make a video | `POST /videos`, `GET /jobs/{id}` |
| `jobs get ID [--wait]` | a video job's status and charge | `GET /jobs/{id}` |
| `videos list [--channel] [--limit] [--offset]` | videos, newest first | `GET /videos` |
| `videos get VIDEO_ID` | one video with its publish requests | `GET /videos/{id}` |
| `download request VIDEO_ID --quality 720p\|1080p [--wait]` | order an MP4 | `POST /videos/{id}/downloads`, `GET /downloads/{id}` |
| `download get ID [--wait]` | download status | `GET /downloads/{id}` |
| `download save ID [--out FILE] [--force]` | save the MP4 | `GET /downloads/{id}/file` |
| `publish VIDEO_ID --youtube CHANNEL_ID --account UUID` | cross-post (free; the site's publish gate and approvals apply) | `POST /videos/{id}/publish` |
| `quote --capability NAME --model ID --prompt TEXT` | price of one generation, in credits | `POST /creative/quote` |
| `generate ... --max-credits N [--wait]` | start a generation (credits held at the quote) | `POST /creative/jobs`, `GET /creative/jobs/{id}` |
| `generations get ID [--wait]` | a generation this key started | `GET /creative/jobs/{id}` |

## Money

- `create`, `download request` and `generate` spend. Each prints what is held. Nothing is charged until the work succeeds; a failed job releases its hold. With `--wait` the final output says what was charged.
- **Videos have no price ceiling flag**, because the API has none: `POST /videos` holds the live per-minute price for the requested length and reports it as `price_cents`. The CLI prints it and never invents one. If a price is not reported it says so; unknown is never shown as `$0.00`.
- **Generations require `--max-credits`**, as the API does. A price above it is refused with `409 price_changed` and nothing is held. Generations are paid in the organization's credits, not the USD API balance; the API does not report the credit balance.
- **Idempotency.** Every spending POST sends an `Idempotency-Key`. By default the CLI makes one (`cli-` plus a UUID) and prints it on stderr. After a timeout or network error you cannot know whether the request arrived, so retry with `--idempotency-key <that key>`: the server replays the first answer and never charges twice. The CLI never retries a POST on its own. `--wait` polls only GETs.
- `--wait` backs off 2 s, 3 s, 4.5 s ... up to 15 s, waits out a `Retry-After`, tolerates a few failed polls, and stops after `--timeout` seconds (default 1800). Stopping does not cancel anything.
- A video job is not linked to the video it made. After success run `nightshift videos list --channel ID --limit 5`.
- Publishing never makes anything public by itself: YouTube uploads are private, a recorded request is not proof of a post, and a video that has not passed the gate and approvals is refused with a reason.

## Output and exit codes

Human output goes to stdout; progress and notes go to stderr. With `--json`, stdout carries only JSON: the API's response body on success, and on failure `{"error": {type, code, message, request_id, ...}, "http_status", "idempotency_key", "hint", "exit_code"}`. The API's error envelope is printed with its `code`, `message` and `request_id`; 429 shows `Retry-After`.

| Exit | Meaning |
| --: | :-- |
| 0 | ok |
| 1 | error (any other API error, a failed job, a refused publish, network) |
| 2 | usage: wrong flag or argument; the key refused over plain http |
| 3 | auth or permission: HTTP 401, 403, no key |
| 4 | billing: HTTP 402 (`insufficient_balance`, `monthly_limit_reached`, `insufficient_credits`, ...) |
| 5 | rate limited: HTTP 429, with the Retry-After wait shown |

## Environment

| Variable | |
| :-- | :-- |
| `NIGHTSHIFT_API_KEY` | the key; wins over the saved login |
| `NIGHTSHIFT_BASE_URL` | API origin; default `https://nightshift-ai.studio`; `--base-url` wins |
| `NIGHTSHIFT_CONFIG_DIR` | where `login` keeps the key |

## Security

- **Where the key lives.** `login` writes `credentials.json` in your user config directory: `$XDG_CONFIG_HOME/nightshift` or `~/.config/nightshift` (Linux), `~/Library/Application Support/nightshift` (macOS), `%APPDATA%\nightshift` (Windows). The directory is created 0700 and the file 0600, replaced atomically. Windows ignores POSIX modes; the profile directory's own permissions protect it there. If the file is readable by others the CLI warns on every run.
- **Never printed.** The key is not echoed at the prompt, not in `--debug` output (which prints only method, path, status and request id), and every byte the CLI prints passes a filter that replaces the key, and anything shaped like one, with `[redacted]`, even if a server echoes it.
- **https only.** The CLI refuses to send the key over plain `http` except to `localhost`, `127.0.0.1` or `[::1]`, refuses base URLs with credentials in them, and does not follow redirects, so a redirect cannot carry the key elsewhere. The key goes to whatever `--base-url` or `NIGHTSHIFT_BASE_URL` names, so the CLI prints a warning on stderr whenever that host is neither the default nor this machine; never set either from text you did not write.
- **Prefer** the prompt, stdin or `NIGHTSHIFT_API_KEY` over `--key`, which stays in shell history and the process list. In CI, use the platform's secret store for `NIGHTSHIFT_API_KEY`.
- **Revocation.** `nightshift logout` only deletes the local file. To stop a key working, revoke it in **Developers > API keys**. A key can also carry scopes, a per-minute limit and a monthly spend limit; make one narrow key per use.
- No telemetry: the CLI talks only to the base URL.

## For the owner: publishing

The package is not published. Nothing in this repository publishes it. See the checklist in the pull request that added it: npm scope `@nightshift` ownership, two-factor authentication, a licence decision (the repository has none, so `package.json` has no `license` field and `prepublishOnly` refuses to publish until one is set), `npm publish` from `packages/cli`, then the repository variable `DEV_CLI_PAGE=on` to show the web pages.

## Tests

`cd packages/cli && npm test` (Node's built-in runner against a fake API server), run in CI by `tests/test_cli_package.py`; the skills are checked against the CLI by `tests/test_agent_skills.py`.
