"""Lab helpers for the API balance under refunds (BR-0031-01, migration 0168): a customer with an activated API, one key, one active
channel and the price list, driven through the real functions as the caller each would have in production:

  * the Paddle webhook (service role) tops up and refunds: api_add_topup, api_refund_topup;
  * the customer's API key (anon + key hash, PostgREST's view of an API call) holds: api_create_video, api_request_download;
  * the worker ends a job or a download (status update, which fires 0031's settle triggers), as the database owner here.

Everything runs inside the caller's transaction (`s` is a sec_db Session); the tests roll it back.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass

from sec_db import ANON, SERVICE, attest_adults, user

BAL = "select balance_cents, reserved_cents from public.api_accounts where org_id = %s"


def as_owner(s):
    s.conn.execute("reset role")
    s.conn.execute("select set_config('request.jwt.claims', '', true)")


def call(s, actor, query, params=None):
    s.conn.execute("select set_config('request.jwt.claims', %s, true)", [json.dumps(actor.claims())])
    s.conn.execute("select set_config('request.jwt.claim.role', %s, true)", [actor.role])
    s.conn.execute("set local role " + actor.role)
    out = s.run(query, params)
    as_owner(s)
    return out


def ok(out):
    assert out.ok, out
    return out.rows[0][0] if out.rows else None


@dataclass
class Customer:
    actor: object
    org: str
    key_hash: str
    channel: str
    video: str


def customer(s) -> Customer:
    """A confirmed person, their workspace with the API activated, one key they made, one ACTIVE channel with a video that has a
    1080p master, and the API price list (the lab's scenario seeds none: LEDGER BR-A-SUMMARY note 2)."""
    tag = uuid.uuid4().hex[:8]
    who = user("apicust", f"apicust-{tag}@lab.test")
    s.rows("insert into auth.users (id, email, email_confirmed_at, created_at) values (%s, %s, now(), now()) returning 1",
           [who.uid, who.email])
    org = str(ok(call(s, who, "select public.create_organization(%s)", [f"API WS {tag}"])))
    key_hash = hashlib.sha256(f"lab-key-{tag}".encode()).hexdigest()
    s.rows("insert into public.api_settings (org_id, activated_at, activated_by, terms_version) values (%s, now(), %s, 'v1') returning 1",
           [org, who.uid])
    s.rows("insert into public.api_keys (org_id, name, prefix, key_hash, created_by) values (%s, 'lab key', null, %s, %s) returning 1",
           [org, key_hash, who.uid])
    channel, video = f"chan-api-{tag}", f"vid-api-{tag}"
    s.rows("insert into public.channels (channel_id, name, niche, status, org_id, credential_ref) "
           "values (%s, 'API channel', 'tech', 'ACTIVE', %s, '{\"verified_at\": \"2026-09-01\"}') returning 1", [channel, org])
    s.rows("insert into public.videos (video_id, channel_id, title, slug, review_state) values (%s, %s, 'v', %s, 'pending') returning 1",
           [video, channel, f"slug-{tag}"])
    s.rows("insert into public.download_masters (video_id, org_id, width, height, duration_seconds, bytes) "
           "values (%s, %s, 1920, 1080, 600, 1000) returning 1", [video, org])
    s.rows("insert into public.api_prices (unit, cents) values ('video_minute', 120), ('job_minimum', 60) "
           "on conflict (unit) do update set cents = excluded.cents returning 1")
    return Customer(who, org, key_hash, channel, video)


def topup(s, c: Customer, cents: int) -> str:
    ext = f"txn_lab{uuid.uuid4().hex[:16]}"
    ok(call(s, SERVICE, "select public.api_add_topup(%s, %s, %s, 'lab top-up')", [c.org, cents, ext]))
    return ext


def run(s, c: Customer, seconds: int):
    """One API run of `seconds` (2 cents a second at the lab's price): (job id, hold ref, price). The key's person has answered
    18+ (0196: a video run spends on Google); a customer who already answered keeps their answer."""
    attest_adults(s, c.actor.uid)
    body = ok(call(s, ANON, "select public.api_create_video(%s, %s, %s::jsonb, null, null, null)",
                   [c.key_hash, c.channel, json.dumps({"topic": "lab", "duration": seconds})]))
    assert body["ok"] is True and body["status"] == 201, body
    job = body["data"]["job_id"]
    ref = s.value("select api_hold_ref from public.render_jobs where id = %s", [job])
    return job, ref, body["data"]["price_cents"]


def refund(s, ext: str, cents=None, rid=None, reason="refund"):
    rid = rid or f"adj_lab{uuid.uuid4().hex[:12]}"
    out = ok(call(s, SERVICE, "select public.api_refund_topup(%s, %s, %s, 'lab', %s)", [ext, rid, cents, reason]))
    return rid, out


def end_job(s, job: int, status: str):
    """The worker ends a job: 'failed' (a run that stopped before spending, rule 4) releases its hold, 'succeeded' captures it."""
    s.rows("update public.render_jobs set status = %s where id = %s returning 1", [status, job])


def hold_status(s, ref: str) -> str:
    return s.value("select status from public.api_holds where ref = %s", [ref])


def account(s, org: str):
    rows = s.rows(BAL, [org])
    return tuple(rows[0]) if rows else (0, 0)  # the account row is made by the first top-up


def balanced(s, org: str) -> int:
    """The balance agrees with the ledger (holds and releases move reserved only), the last ledger row with the account, and the
    balance is never negative. Returns the balance."""
    bal, res = account(s, org)
    moved = s.value("select coalesce(sum(amount_cents), 0) from public.api_ledger "
                    "where org_id = %s and kind in ('topup', 'usage', 'refund', 'adjustment')", [org])
    held = s.value("select coalesce(sum(amount_cents), 0) from public.api_holds where org_id = %s and status = 'open'", [org])
    last = s.rows("select balance_after, reserved_after from public.api_ledger where org_id = %s order by id desc limit 1", [org])[0]
    assert bal == moved, f"balance {bal} vs ledger {moved}"
    assert res == held, f"reserved {res} vs open holds {held}"
    assert tuple(last) == (bal, res), f"last ledger row {tuple(last)} vs account {(bal, res)}"
    assert bal >= 0 and 0 <= res <= bal
    return bal
