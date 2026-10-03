"""Build the end-to-end database: a scratch Postgres from the repository's own
migrations, plus one person who subscribes (Creator), has credits, a channel
that can make videos and the prices that go with it. Prints the DSN, the user's
id and the session cookie the browser would hold, as JSON.

  NIGHTSHIFT_SECURITY_PG=postgresql://postgres:...@localhost:PORT/postgres python3 tests/oauth_e2e/seed.py
"""

from __future__ import annotations

import base64
import json
import os
import sys
import uuid
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "security"))
import sec_db  # noqa: E402


def main() -> int:
    admin = sec_db.admin_dsn()
    if not admin:
        print("NIGHTSHIFT_SECURITY_PG is not set", file=sys.stderr)
        return 2
    name = os.environ.get("E2E_DB", "ns_oauth_e2e")
    dsn = sec_db.build(admin, name)
    alice = os.environ.get("E2E_USER", str(uuid.UUID(int=0xE2E)))
    free = str(uuid.UUID(int=0xF2E))
    org, forg = str(uuid.UUID(int=0x0E2E)), str(uuid.UUID(int=0x0F2E))
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("insert into auth.users (id, email) values (%s,'alice@e2e.test'),(%s,'free@e2e.test')", [alice, free])
        c.execute("insert into public.organizations (id, name, slug) values (%s,'Alice Studio','alice-e2e'),(%s,'Free Folk','free-e2e')", [org, forg])
        c.execute("insert into public.org_members (org_id, user_id, email, role) values (%s,%s,'alice@e2e.test','owner'),(%s,%s,'free@e2e.test','owner')",
                  [org, alice, forg, free])
        c.execute("select public.grant_credits(%s, 400, 'e2e')", [org])
        c.execute("select public.grant_credits(%s, 400, 'e2e')", [forg])
        c.execute("insert into public.subscriptions (org_id, provider_subscription_id, plan_id, status) values (%s,'sub_e2e0000000000','creator','active')", [org])
        # The plan's parallel-run limit is tested on its own; here the spending limit is what is reached.
        c.execute("update public.plan_entitlements set value = '1000' where key = 'concurrency'")
        c.execute("insert into public.credit_prices (unit, credits_per_unit, margin) values ('video_minute', 60, 0.5), ('job_minimum', 10, 0) on conflict (unit) do nothing")
        c.execute("insert into public.channels (channel_id, name, niche, status, org_id, agent_config, credential_ref) values "
                  "('e2e-channel','E2E Channel','tech','ACTIVE',%s,'{\"target_duration_seconds\": 60}','{\"verified_at\":\"2026-09-01\"}')", [org])
    def cookie(uid):
        session = {"access_token": f"tok-{uid}", "refresh_token": "r", "token_type": "bearer", "expires_in": 3600,
                   "expires_at": 4102444800, "user": {"id": uid, "aud": "authenticated", "email": "x"}}
        return "base64-" + base64.urlsafe_b64encode(json.dumps(session).encode()).decode().rstrip("=")
    print(json.dumps({"dsn": dsn, "user": alice, "free_user": free, "cookie": cookie(alice), "free_cookie": cookie(free)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
