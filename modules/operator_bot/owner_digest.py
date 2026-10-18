"""The owner's daily e-mail digest: YESTERDAY, in the owner's time zone.

The Telegram digest (views.view_digest) is a snapshot of "now and the last 24
hours". An e-mail read over breakfast needs a closed day, so this one is built
from the same sources over the local calendar day that just ended: money
received, new accounts, videos made / published / held / failed, the provider
cost estimate, and what needs a person.

Rules it keeps (CLAUDE.md #5): a source that cannot answer says why and is
listed under "could not check"; it is never a zero, and "nothing needs attention"
is only written when every source answered. A total built from rows without an
amount is "at least", never a total. No customer appears: payments are an amount,
a currency and counts; accounts are a count.

Every line is built by ``t()`` from ids, counts and fixed words (values escaped);
modules/operator_bot/owner_mail.py turns each into plain text and escapes it again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from modules.operator_bot import analysis, views
from modules.operator_bot.i18n import Raw, t
from modules.operator_bot.sources import OperatorSources, Section, parse_ts
from modules.tg_text import safe_id

VIDEO_EVENTS = ("render.completed", "video.published", "publish.held", "render.failed", "upload.failed")
#: How far back a payment that needs a person is still listed as "needs attention".
PAYMENT_ATTENTION = timedelta(days=7)
_FAILED_DEPLOY = ("failure", "timed_out", "startup_failure")


@dataclass
class Digest:
    date: str                                   # the local date of YESTERDAY
    lines: list = field(default_factory=list)   # what happened
    attention: list = field(default_factory=list)


def _window(ops: OperatorSources) -> tuple:
    """(start, end) of the local day that just ended, aware, plus its date."""
    now, tz = ops.now(), ops.cfg.tz
    end = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=1)
    return start, end, start.strftime("%Y-%m-%d")


def _within(rows, field_name: str, start: datetime, end: datetime) -> list:
    out = []
    for r in rows or []:
        at = parse_ts(r.get(field_name))
        if at is not None and start <= at < end:
            out.append(r)
    return out


def _money_lines(lang: str, sec: Section, start: datetime, end: datetime, now: datetime) -> list:
    """Money received yesterday, per currency, with the problems beside it."""
    if not sec.ok:
        return [t(lang, "ownermail.dg_pay_unknown", why=views.unknown(lang, sec))]
    day = _within(sec.data, "received_at", start, end)
    c = analysis.classify_payments(day, start)
    out = []
    totals: dict = {}
    for r in c["paid"]:
        cur = safe_id(r.get("currency"), 3).upper()
        entry = totals.setdefault(cur, [0, 0, 0])      # known minor units, payments, payments without an amount
        entry[1] += 1
        try:
            minor = int(r.get("amount_minor"))
            if minor < 0 or not cur:
                raise ValueError
            entry[0] += minor
        except (TypeError, ValueError, OverflowError):
            entry[2] += 1
    if not totals:
        out.append(t(lang, "ownermail.dg_pay_none"))
    for cur, (minor, n, unpriced) in sorted(totals.items()):
        if not cur or unpriced == n:
            out.append(t(lang, "ownermail.dg_pay_noamount", n=n))
        elif unpriced:
            out.append(t(lang, "ownermail.dg_pay_partial", total=views.money(lang, minor, cur), n=n - unpriced,
                         missing=unpriced))
        else:
            out.append(t(lang, "ownermail.dg_pay_total", total=views.money(lang, minor, cur), n=n))
    if any(c[k] for k in ("rejected", "failed", "refunds")):
        out.append(t(lang, "ownermail.dg_pay_problems", rejected=len(c["rejected"]), failed=len(c["failed"]),
                     refunds=len(c["refunds"])))
    if sec.cap:
        out.append(t(lang, "ownermail.dg_cut", n=sec.cap))
    return out


def build(ops: OperatorSources, lang: str, held: Optional[list] = None) -> Digest:
    """Yesterday for the owner. ``held`` is the review queue (None when unknown)."""
    ops.reset()
    now, cfg = ops.now(), ops.cfg
    start, end, date = _window(ops)
    d = Digest(date=date)
    unchecked: list = []

    # -- money
    pay = ops.payment_events(now - PAYMENT_ATTENTION)
    d.lines += _money_lines(lang, pay, start, end, now)
    if not pay.ok:
        unchecked.append("ownermail.src_payments")

    # -- accounts
    su = ops.signups(start)
    if su.ok:
        d.lines.append(t(lang, "ownermail.dg_accounts", n=len(_within(su.data, "created_at", start, end))))
    else:
        d.lines.append(t(lang, "ownermail.dg_accounts_unknown", why=views.unknown(lang, su)))

    # -- videos
    ev = ops.events(start, VIDEO_EVENTS)
    if ev.ok:
        c = analysis.event_counts(_within(ev.data, "ts", start, end))
        d.lines.append(t(lang, "ownermail.dg_videos", made=c.get("render.completed", 0),
                         published=c.get("video.published", 0), held=c.get("publish.held", 0),
                         failed=c.get("render.failed", 0) + c.get("upload.failed", 0), cut=views.cut(lang, ev)))
    else:
        d.lines.append(t(lang, "ownermail.dg_videos_unknown", why=views.unknown(lang, ev)))

    # -- spend: only rows recorded inside the day, so the wording of the bot's cost line applies unchanged
    costs = ops.creative_costs(start)
    if costs.ok:
        costs = Section(True, _within(costs.data, "recorded_at", start, end), cap=costs.cap)
    d.lines.append(views._cost_line(lang, t(lang, "ownermail.dg_spend_label"), costs, start))

    # -- what needs a person
    ws = ops.workers()
    if ws.ok:
        bad = [w for w in analysis.classify_workers(ws.data, now) if w["stale"] or w.get("state") == "failed"]
        if bad:
            d.attention.append(t(lang, "ownermail.dg_att_workers", n=len(bad)))
    else:
        unchecked.append("ownermail.src_workers")

    rejected = analysis.classify_payments(pay.data, now - PAYMENT_ATTENTION)["rejected"] if pay.ok else []
    if rejected:
        d.attention.append(t(lang, "ownermail.dg_att_payments", n=len(rejected)))

    if held is None:
        unchecked.append("ownermail.src_held")
    elif held:
        d.attention.append(t(lang, "ownermail.dg_att_held", n=len(held)))

    rj = ops.render_jobs(start)
    if rj.ok:
        c = analysis.classify_render_jobs(rj.data, now, cfg)
        failed = _within(c["failed"], "finished_at", start, end)
        if failed:
            d.attention.append(t(lang, "ownermail.dg_att_failed", n=len(failed)))
        if c["stuck"]:
            d.attention.append(t(lang, "ownermail.dg_att_stuck", n=len(c["stuck"])))
    else:
        unchecked.append("ownermail.src_jobs")

    bal = ops.balances()
    if bal.ok:
        low = [r for r in analysis.balance_flags(bal.data, views._low_threshold()) if r["low"]]
        if low:
            d.attention.append(t(lang, "ownermail.dg_att_balances", who=", ".join(safe_id(r["provider"]) for r in low)))
    else:
        unchecked.append("ownermail.src_balances")

    dep = ops.deploys()
    if dep.ok:
        for wf in dep.data:
            run = analysis.latest_run(wf["runs"]) if wf.get("ok") else None
            if run and run.get("conclusion") in _FAILED_DEPLOY:
                d.attention.append(t(lang, "ownermail.dg_att_deploy", workflow=safe_id(wf.get("label"), 24)))
    else:
        unchecked.append("ownermail.src_deploys")

    site = ops.site()
    if site.ok:
        down = [r["path"] for r in site.data if r["status"] is None or not (200 <= r["status"] < 400)]
        if down:
            d.attention.append(t(lang, "ownermail.dg_att_site", pages=", ".join(down)))
    else:
        unchecked.append("ownermail.src_site")

    if unchecked:
        d.attention.append(t(lang, "ownermail.dg_att_unchecked",
                             what=Raw(", ".join(t(lang, k) for k in dict.fromkeys(unchecked)))))
    elif not d.attention:
        d.attention.append(t(lang, "ownermail.dg_att_none"))
    return d
