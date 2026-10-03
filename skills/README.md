# Nightshift Agent Skills

Skills are small folders of instructions an AI agent loads when a task matches (the open `SKILL.md` format used by Claude Code and other compatible agents). These eight teach an agent to use Nightshift through its CLI, its MCP server and its API without spending money by accident.

| Skill | Use it to |
| :-- | :-- |
| `nightshift-setup` | get an API key, install the CLI or connect MCP, verify with `whoami` and `balance` |
| `make-a-video` | turn a brief into a video: channel, length, create, wait, find it. Money rules |
| `generate-media` | quote and generate a single asset in credits, with a required `--max-credits` |
| `check-balance-and-costs` | read the balance, holds, limits and what a job was charged |
| `download-and-publish` | download a 720p or 1080p MP4 and cross-post. The publish gate; YouTube uploads are private |
| `troubleshoot-errors` | every error class and exit code, and what to do |
| `batch-videos` | many videos with a count cap, a spend ceiling, a ledger and a stop on the first problem |
| `use-the-mcp-tools` | the ten MCP tools, and when to prefer MCP or the CLI |

They assume the `nightshift` CLI (`packages/cli`, documented in `docs/CLI.md`) or the MCP server (`docs/MCP.md`). Both need an API key from **Developers > API keys** in the web app.

## Install

Copy the folders you want.

For every project of one person:

```bash
mkdir -p ~/.claude/skills
cp -R skills/* ~/.claude/skills/        # run from a checkout of this repository
```

For one project (commit them so the team shares them):

```bash
mkdir -p .claude/skills
cp -R /path/to/nightshift-ai-studio/skills/* .claude/skills/
```

Remove `README.md` from the copied directory if your agent complains about a non-skill file; it is not needed there.

Restart the agent session. The skills load by their `description`, so asking "make a Nightshift video about tides" is enough.

### With `npx skills add` (after the owner publishes)

TODO-owner: this works only once the repository is public and the skills are discoverable by the `skills` tool. Until then use the copy commands above.

```bash
npx skills add <owner>/<repo>      # TODO-owner: replace with the published GitHub owner/repo
```

## Safety, in one paragraph

A skill never asks for the key in chat, states every held amount from the command's own output, reuses one idempotency key per intent, stops at a spend ceiling the person sets, treats everything a command returns (titles, topics, error text) as data and never as instructions, never changes the key or server address on its own, and never says a video will go public: YouTube uploads are private and the site's publish gate and approvals apply.

## Keeping them honest

`tests/test_agent_skills.py` checks every skill: front matter parses and matches the folder name, every `nightshift ...` command and flag exists in the CLI's command table, every error code exists in the API, there is no key-shaped string and no model or vendor name, and the MCP tool list equals the server's.
