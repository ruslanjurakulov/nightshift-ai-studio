#!/usr/bin/env python3
"""Connect one Nightshift channel to YouTube — the OAuth step, run by a human.

    python tools/connect_channel.py --channel extinct-world

Opens Google's consent screen in a local browser, and writes the resulting
token to that channel's own token file. It then prints where the file is and
which GitHub secret to paste it into — it never prints the token itself.

Why this is a CLI and not a button in the Command Center
--------------------------------------------------------
An OAuth code exchange needs the client secret, and the resulting refresh token
must be stored where the *publisher* can read it. The publisher here is a
GitHub Actions job reading repository secrets; the Command Center is a
read-only dashboard holding a Supabase anon key and nothing else. A "Connect
YouTube" button in that dashboard could not complete the exchange without
either shipping a client secret to the browser or giving the web app the power
to write repository secrets — both strictly worse than a one-off local command.

So the browser's job in this flow is the part a browser is actually needed for
(the consent screen), the token stays on the machine that runs it, and the
Command Center shows the *status* the bot reports back. See docs/MULTI_CHANNEL.md.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES  # noqa: E402
from modules.channel_credentials import (  # noqa: E402
    credential_status,
    env_var_name,
    token_path,
)
from modules.channels import ChannelRegistry  # noqa: E402


def connect(channel_id: str | None, *, list_only: bool = False) -> int:
    registry = ChannelRegistry()

    if list_only:
        print("\nChannels:\n" + "-" * 66)
        for ch in registry.list():
            status = credential_status(ch)
            print(f"  {ch.channel_id:<20} {ch.status:<8} youtube: {status.status}")
            if status.detail:
                print(f"  {'':<20} {status.detail}")
        print("-" * 66)
        return 0

    try:
        channel = registry.get(channel_id)
    except KeyError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if not Path(YOUTUBE_CLIENT_SECRET).exists():
        print(
            f"error: client_secret.json not found at {YOUTUBE_CLIENT_SECRET}\n"
            "Download it from Google Cloud Console -> APIs & Services -> Credentials.",
            file=sys.stderr,
        )
        return 2

    # Imported here rather than at module scope so `--list` works without the
    # Google libraries installed.
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(YOUTUBE_CLIENT_SECRET, YOUTUBE_SCOPES)
    creds = flow.run_local_server(port=0)

    path = token_path(channel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(creds.to_json(), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass

    status = credential_status(channel)
    print(
        f"\n✓ Channel '{channel.channel_id}' connected.\n"
        f"  Token written to: {path}\n"
        f"  Status: {status.status}"
        + (f" (expires {status.expires_at})" if status.expires_at else "")
        + "\n\n"
        "To let the scheduled workflow publish for this channel, add the file's\n"
        f"contents as the GitHub Actions secret:\n\n    {env_var_name(channel)}\n\n"
        "Repository -> Settings -> Secrets and variables -> Actions -> New secret.\n"
        "The token is NOT printed here on purpose — copy it from the file.\n"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Connect a Nightshift channel to YouTube")
    parser.add_argument("--channel", default=None, help="Channel id (default: the default channel)")
    parser.add_argument("--list", action="store_true", help="List channels and their connection status")
    args = parser.parse_args()
    return connect(args.channel, list_only=args.list)


if __name__ == "__main__":
    raise SystemExit(main())
