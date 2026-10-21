#!/usr/bin/env python3
"""Workflow step: restore a customer channel's YouTube token from Supabase Vault.

    CHANNEL_ID=<id> python tools/restore_channel_token.py

Runs in ``.github/workflows/daily_video.yml`` (and the intelligence poll) right
after the GitHub-secret token steps, for every channel. A channel connected from
the Command Center (migration 0022 for a customer's, 0115 for the operator's own,
the legacy ``default`` channel included) has its refresh token in Vault, not in
a GitHub secret; this reads it with the
service key and writes the authorized-user document to the one file that
channel's uploader, analytics client and comment fetcher all read
(``channel_credentials.token_path``), created 0600. The file lives for this job
only: a GitHub-hosted VM is discarded, and the workflow's self-hosted cleanup
step removes ``youtube_token*.json`` whatever the outcome.

Order, per modules/channel_tokens.py: an ACTIVE Vault connection wins; with
none, nothing is written here and the channel's own GitHub secret (the step
before) is used exactly as before 0022. When Vault wins while that secret is
also set, the secret's env var is blanked for the rest of the job — otherwise
``materialize_token`` would overwrite the Vault token with it. The default
channel's secret was already written to its token file by the step before; the
Vault token replaces that file. A Vault lookup that FAILS while that file (or
a non-default operator channel's secret) exists keeps the secret, with a
warning: an unknown is not a no.

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

    # The environment is the operator's own channels' place for a token. A
    # channel of any other organization has no name and no fallback: its only
    # token is its Vault connection (BR-L-080). The legacy default channel's
    # "environment" is the file the previous step wrote from YOUTUBE_TOKEN_JSON,
    # so it has no env var name here either.
    operators = bool(channel.is_operators)
    is_default = bool(channel.is_default and operators)
    name = env_var_name(channel) if operators and not is_default else ""
    label = "YOUTUBE_TOKEN_JSON" if is_default else name
    if client is None:
        client = channel_tokens.VaultTokenClient(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_KEY", ""))
    if not client.configured:
        say(f"channel {channel_id}: SUPABASE_URL / SUPABASE_SERVICE_KEY not set — "
            + (f"using {label} only, as before." if operators else "no token for this channel."))
        return 0

    # The wrong-account guard, before anything is spent: a Vault token granted for another YouTube channel than the
    # one this channel is verified against stops the run. The legacy default channel's registry row carries no
    # YouTube id, so the YOUTUBE_CHANNEL_ID the run itself targets stands in for it; unset = no check, as before.
    expected = channel.credential.youtube_channel_id
    if is_default and not expected:
        expected = (env.get("YOUTUBE_CHANNEL_ID") or "").strip()
    try:
        resolved = channel_tokens.resolve_channel_token(
            channel_id, name, env, client=client,
            expected_youtube_channel_id=expected, allow_env=operators)
    except channel_tokens.VaultLookupError as e:
        if is_default and token_path(channel).exists():
            say(f"::warning::channel {channel_id}: {e} — keeping YOUTUBE_TOKEN_JSON for this run.")
            return 0
        say(f"::error::channel {channel_id}: {e}. Nothing was run.")
        return 1
    except channel_tokens.ChannelTokenError as e:
        say(f"::error::channel {channel_id}: {e}. Nothing was run.")
        return 1

    if resolved.source != channel_tokens.SOURCE_VAULT:
        say(f"channel {channel_id}: no active Vault connection — "
            + (f"using {label}, as before." if operators else "this channel has no token."))
        return 0

    for secret in channel_tokens.secret_strings(resolved):
        say(f"::add-mask::{secret}")
    path = channel_tokens.write_private(token_path(channel), resolved.token_json)
    if name and (env.get(name) or "").strip() and env.get("GITHUB_ENV"):
        with open(env["GITHUB_ENV"], "a", encoding="utf-8") as fh:
            fh.write(f"{name}=\n")
        say(f"channel {channel_id}: {name} is also set; its Vault connection takes precedence "
            "for this run.")
    if is_default:
        say(f"channel {channel_id}: its Vault connection takes precedence over YOUTUBE_TOKEN_JSON for this run.")
    say(f"channel {channel_id}: wrote {path.name} from its Vault connection — this channel "
        "will publish to its own account.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
