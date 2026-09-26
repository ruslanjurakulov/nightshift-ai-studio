#!/usr/bin/env python3
"""Workflow step: restore a customer channel's YouTube token from Supabase Vault.

    CHANNEL_ID=<id> python tools/restore_channel_token.py

Runs in ``.github/workflows/daily_video.yml`` right after "Restore YouTube token
(this channel)", for every channel that is not the legacy default. A channel
whose organization connected it from the Command Center (migration 0022) has
its refresh token in Vault, not in a GitHub secret; this reads it with the
service key and writes the authorized-user document to the one file that
channel's uploader, analytics client and comment fetcher all read
(``channel_credentials.token_path``), created 0600. The file lives for this job
only: a GitHub-hosted VM is discarded, and the workflow's self-hosted cleanup
step removes ``youtube_token*.json`` whatever the outcome.

Order, per modules/channel_tokens.py: an ACTIVE Vault connection wins; with
none, nothing is written here and the channel's own GitHub secret (the step
before) is used exactly as before 0022. When Vault wins while that secret is
also set, the secret's env var is blanked for the rest of the job — otherwise
``materialize_token`` would overwrite the Vault token with it.

Before the file is written, every secret string in it is registered with the
runner's log masking (``::add-mask::``, consumed by the runner and never
shown), the way a secret fetched at run time has to be: Actions only masks the
values it injected itself.

Exit codes: 0 = done (a token written, or nothing to do); 1 = the Vault lookup
failed and there is no GitHub secret to fall back to, or the token cannot be
used — the job stops here, before the run spends anything.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from modules import channel_tokens  # noqa: E402
from modules.channel_credentials import env_var_name, token_path  # noqa: E402


def _load_channel(channel_id: str):
    from modules.channels import ChannelRegistry  # noqa: PLC0415

    return ChannelRegistry().get(channel_id)


def main(env=None, *, load_channel=_load_channel, client=None, out=None) -> int:
    env = dict(os.environ if env is None else env)
    out = out or sys.stdout

    def say(msg: str) -> None:
        print(msg, file=out, flush=True)

    channel_id = (env.get("CHANNEL_ID") or "").strip()
    if not channel_id:
        say("::error::CHANNEL_ID is not set — nothing to restore.")
        return 1
    try:
        channel = load_channel(channel_id)
    except Exception as e:  # noqa: BLE001 — the registry's own problem, reported by main.py
        # Not this step's call to fail the job: the run resolves the channel
        # again and stops there if it really is unknown. Here it only means
        # Vault is not consulted, which is exactly the pre-0022 behaviour.
        say(f"::warning::channel {channel_id}: could not load the channel registry "
            f"({type(e).__name__}) — Vault not consulted; the GitHub secret applies as before.")
        return 0
    if channel.is_default:
        say(f"channel {channel_id}: the default channel keeps YOUTUBE_TOKEN_JSON — Vault is not consulted.")
        return 0

    name = env_var_name(channel)
    if client is None:
        client = channel_tokens.VaultTokenClient(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_KEY", ""))
    if not client.configured:
        say(f"channel {channel_id}: SUPABASE_URL / SUPABASE_SERVICE_KEY not set — "
            f"using {name} only, as before.")
        return 0

    try:
        resolved = channel_tokens.resolve_channel_token(
            channel_id, name, env, client=client,
            expected_youtube_channel_id=channel.credential.youtube_channel_id)
    except channel_tokens.ChannelTokenError as e:
        say(f"::error::channel {channel_id}: {e}. Nothing was run.")
        return 1

    if resolved.source != channel_tokens.SOURCE_VAULT:
        say(f"channel {channel_id}: no active Vault connection — using {name}, as before.")
        return 0

    for secret in channel_tokens.secret_strings(resolved):
        say(f"::add-mask::{secret}")
    path = channel_tokens.write_private(token_path(channel), resolved.token_json)
    if (env.get(name) or "").strip() and env.get("GITHUB_ENV"):
        with open(env["GITHUB_ENV"], "a", encoding="utf-8") as fh:
            fh.write(f"{name}=\n")
        say(f"channel {channel_id}: {name} is also set; its Vault connection takes precedence "
            "for this run.")
    say(f"channel {channel_id}: wrote {path.name} from its Vault connection — this channel "
        "will publish to its own account.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
