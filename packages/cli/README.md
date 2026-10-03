# @nightshift/cli

Command-line client for the Nightshift public API: make, follow, download and publish videos from a terminal, a script or an AI agent. Node 20 or newer, no runtime dependencies.

```bash
npm i -g @nightshift/cli          # once published
# until then, from a checkout of the repository:
npm i -g ./packages/cli           # or: npx --yes ./packages/cli --help

nightshift login                  # hidden prompt; key checked, then saved 0600
nightshift whoami
nightshift balance
nightshift channels
nightshift create --channel my-channel --topic "How tides work" --duration 90s --wait
nightshift videos list --channel my-channel --limit 5
nightshift download request VIDEO_ID --quality 1080p --wait && nightshift download save 45
nightshift publish VIDEO_ID --youtube my-channel
```

Create a key in **Developers > API keys** in the Nightshift web app. Add `--json` to any command for machine-readable output, `--help` for usage and examples.

- Spending commands (`create`, `download request`, `generate`) print what is held and charge only on success. Retry with the same `--idempotency-key`, never a new one.
- Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 billing, 5 rate limited (Retry-After shown).
- The key is stored 0600 in your user config directory, never printed, redacted from all output, and never sent over plain http except to localhost.
- `nightshift logout` deletes the local key; revoke it in Developers > API keys to stop it working.

Full reference, money rules and security notes: [docs/CLI.md](../../docs/CLI.md). Agent Skills for this CLI: [skills/](../../skills/).
