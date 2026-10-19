"""Hard USD caps on one run and on one day — the brake that does not depend on a
channel having set a ``spend_ceiling_usd``.

``modules/budget.py`` is a per-channel, per-month ceiling checked once, before a
run starts. It cannot stop a run that is already paying, and a deployment with no
ceiling set had no brake at all. This module adds two operator-level caps, both
read from the worker's environment (repository VARIABLES, see
deploy/.env.worker.example) and both checked by ``main.run`` immediately before
each stage that buys something it ledgers: the topic (so an exhausted daily cap
stops the run before any paid planning), the voice, generated clips, generated
stills, and the avatar presenter.

``CHRONOS_MAX_RUN_USD``    USD one run may have spent so far (default 10).
``CHRONOS_MAX_DAILY_USD``  USD the whole worker may have spent today, UTC (default
                           30); applied to runs of the operator's own organisation
                           only, because a customer's run is paid for by the
                           customer's credits and must not be stopped by the
                           operator's day.

An unset or empty variable means the default. ``off`` switches a cap off. Zero,
a negative number or text that is not a number is refused with a warning and the
default stays in force (a typo must never remove a brake).

What it can and cannot know. Spend is the cost ledger's USD, and the ledger prices
a unit only when ``CHRONOS_PRICE_<UNIT>`` is set (modules/cost_ledger.py). A unit
with no price counts as 0 here, so with no prices set the caps never fire. That is
said out loud: the first check of a run logs a warning naming the unpriced units.
``planned`` lets the caller include what it is about to buy (the clips it is about
to submit) so a cap stops the submit instead of noticing afterwards.

NOT covered, said plainly: the avatar presenter clip itself (Higgsfield; it has no
cost-ledger unit, so its price is not counted, only a stop before it on what was
already spent), the advisory vision critic (it runs after the render; stopping
there would throw away a finished video, so it keeps its own channel ceiling),
scene regeneration jobs (tools/queue_worker -> main --regenerate-scene, paid by
their own confirmed price and not through ``main.run``) and every Creative OS job
(tools/creative_worker.py), which has its own price and hold.

A breach raises :class:`SpendLimitExceeded`; ``main.run`` lets it propagate, the
worker marks the job failed (the credit hold is released), the cost ledger is
flushed in ``run``'s ``finally``, and the message names the variable to change.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Iterable, Optional, Tuple

from modules import cost_ledger

logger = logging.getLogger(__name__)

RUN_ENV = "CHRONOS_MAX_RUN_USD"
DAILY_ENV = "CHRONOS_MAX_DAILY_USD"
DEFAULT_MAX_RUN_USD = 10.0
DEFAULT_MAX_DAILY_USD = 30.0
#: The words that switch a cap off (build-worker-env.py reads the same tuple).
OFF_WORDS = ("off", "none", "unlimited", "disabled")


class SpendLimitExceeded(RuntimeError):
    """A run was stopped because the ledger so far is over a USD cap."""


def limit(env_name: str, default: float, env=None) -> Optional[float]:
    """The cap in USD, or None when switched off with ``off``."""
    raw = str((os.environ if env is None else env).get(env_name, "") or "").strip()
    if not raw:
        return default
    if raw.lower() in OFF_WORDS:
        return None
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not value > 0 or value != value or value == float("inf"):
        logger.warning("%s is not a positive number — using the default $%.2f (write `off` to switch the cap off)",
                       env_name, default)
        return default
    return value


def _day_start_iso(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def _planned_usd(planned: Optional[Iterable[Tuple[str, float]]]) -> Tuple[float, list]:
    total, unpriced = 0.0, []
    for unit, quantity in planned or ():
        price = cost_ledger.unit_price(unit)
        if price is None:
            unpriced.append(unit)
        else:
            total += float(quantity) * price
    return round(total, 6), unpriced


def stored_today_usd(store, now: Optional[datetime] = None) -> float:
    """Priced USD the local cost database holds for today (UTC), every channel."""
    from modules import budget

    spent, _priced, _unpriced = budget.channel_spend_usd(store, None, since_iso=_day_start_iso(now))
    return spent


def check(costs, stage: str, *, operators: bool = False, planned=None, store=None, env=None) -> None:
    """Raise :class:`SpendLimitExceeded` if running ``stage`` would go over a cap.

    ``costs`` is the run's CostLedger; ``planned`` is ``[(unit, quantity), ...]``
    the stage is about to buy; ``operators`` is True for the operator's own
    organisation (the only one the daily cap applies to). Reading the day's
    spend can fail (no database): that is logged and the daily cap is skipped for
    this check, the per-run cap needs no database."""
    run_cap = limit(RUN_ENV, DEFAULT_MAX_RUN_USD, env)
    day_cap = limit(DAILY_ENV, DEFAULT_MAX_DAILY_USD, env) if operators else None
    if run_cap is None and day_cap is None:
        return
    planned_usd, planned_unpriced = _planned_usd(planned)
    unpriced = sorted(set(costs.unpriced_units()) | set(planned_unpriced))
    if unpriced and not getattr(costs, "guard_warned", False):
        costs.guard_warned = True
        logger.warning(
            "Spend guard: %s are recorded without a price, so they count as $0 against %s / %s. "
            "Set %s as repository variables (USD per single unit) for the caps to see them.",
            ", ".join(unpriced), RUN_ENV, DAILY_ENV, ", ".join(cost_ledger.price_env_var(u) for u in unpriced))

    run_spent = costs.priced_usd()
    if run_cap is not None and run_spent + planned_usd > run_cap:
        _stop(costs, stage, "run", run_spent, planned_usd, run_cap, RUN_ENV)

    if day_cap is not None:
        try:
            if store is not None:
                today = stored_today_usd(store)
            else:
                from modules.state_store import StateStore

                with StateStore() as _store:
                    today = stored_today_usd(_store)
        except Exception as e:
            logger.warning("Spend guard: today's spend could not be read (%s) — the daily cap %s was not checked",
                           type(e).__name__, DAILY_ENV)
            return
        day_spent = today + costs.priced_usd(pending_only=True)
        if day_spent + planned_usd > day_cap:
            _stop(costs, stage, "day", day_spent, planned_usd, day_cap, DAILY_ENV)


def _stop(costs, stage, scope, spent, planned_usd, cap, env_name) -> None:
    what = "this run" if scope == "run" else "today (UTC, all channels on this worker)"
    message = (
        f"Spend guard: stopped before {stage}. {what.capitalize()} has spent ${spent:.2f}"
        + (f" and {stage} would add about ${planned_usd:.2f}" if planned_usd else "")
        + f", over the ${cap:.2f} cap {env_name}. "
        f"Nothing further was bought. To allow more, raise the repository variable {env_name} "
        "and run Deploy web (or write `off` to remove the cap); to find out why it is high, "
        "look at the cost ledger (Billing page / video_costs)."
    )
    logger.error(message)
    print(f"\nSTOPPED: {message}")
    try:
        from modules import event_log as events

        events.emit(events.BUDGET_EXCEEDED, agent="spend_guard", status=events.STATUS_FAILED,
                    channel_id=getattr(costs, "channel_id", None),
                    metadata={"scope": scope, "stage": stage, "spent_usd": round(spent, 6),
                              "planned_usd": planned_usd, "cap_usd": cap, "variable": env_name})
    except Exception:
        pass
    raise SpendLimitExceeded(message)
