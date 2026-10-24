"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { StateBlock } from "@/components/states/StateBlock";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import {
  blockedKey,
  confirmReason,
  nextPollDelay,
  planErrorKey,
  reasonKey,
  seriesTotal,
  startError,
  startedSummary,
  startKey,
  type ChipKey,
  type EpisodeView,
  type PlanView,
  type QuoteView,
  type StartError,
} from "@/lib/seriesPlan";

/** One episode as the page hands it over: the plan's row, the database's quote, and the chip it wears (already worked out, with its link). */
export interface EpisodeRow {
  episode: EpisodeView;
  quote: QuoteView | null;
  chip: ChipKey;
  href: string | null;
}

export interface SeriesPlanViewProps {
  plan: PlanView;
  rows: EpisodeRow[];
  linksFailed: boolean;
  backHref: string;
  againHref: string;
  /** Minutes since the plan was asked for, from the server's clock (null when unknown). Only used to say "taking longer than usual". */
  ageMinutes: number | null;
}

/** A plan still being made is looked at again by re-reading the page (never by calling the model): every 5 s at first, every 30 s after 2
 *  minutes, and not at all after 10 (lib/seriesPlan.ts nextPollDelay); then the person presses Check again. */
export const PLANNING_POLL_MS = 5000;
/** After this many minutes of "planning" the page says it is taking longer than usual. */
export const SLOW_AFTER_MINUTES = 10;

const CHIP_TONE: Partial<Record<ChipKey, "lit" | "warn">> = {
  refused: "warn",
  needs_confirm: "warn",
  unpriced: "warn",
  unavailable: "warn",
  failed: "warn",
  cancelled: "warn",
  ready: "lit",
  storyboard: "lit",
  video: "lit",
};

/**
 * A series plan (migration 0120): the outline cards, the hook and call-to-action variants, the price of each episode and of the series
 * (the DATABASE's, from `quote_series_episode`), a status chip per episode, and the one button that spends: "Start episode".
 *
 * What it does NOT do. It never shows model text as anything but text (React escapes it; no HTML, no link, no attribute is built from it).
 * It never calls an outline checked: the "Not fact-checked" label is on the page, and again on every outline. It never starts an
 * episode the database says may not start, and it never starts an unconfirmed episode without the person ticking the confirmation. The
 * price it sends back is the one it showed; the database refuses (`price_changed`) unless it is still the current one.
 */
export function SeriesPlanView({ plan, rows, linksFailed, backHref, againHref, ageMinutes }: SeriesPlanViewProps) {
  const { t } = useI18n();
  const s = t.seriesPlan;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-plan-status={plan.status}>
      <Link href={backHref} className="btn-quiet min-h-11 w-fit px-3 text-sm">
        {s.page.back}
      </Link>
      <PlanFacts plan={plan} />
      {plan.status === "requested" ? (
        <Planning ageMinutes={ageMinutes} />
      ) : plan.status === "failed" ? (
        <Failed plan={plan} againHref={againHref} />
      ) : (
        <Ready plan={plan} rows={rows} linksFailed={linksFailed} />
      )}
    </div>
  );
}

function PlanFacts({ plan }: { plan: PlanView }) {
  const { t } = useI18n();
  const p = t.seriesPlan.page;
  const facts: [string, string][] = [
    [p.topic, plan.topic],
    [p.language, plan.language],
    [p.episodesLabel, String(plan.nEpisodes)],
    [p.lengthLabel, fmt(p.minutes, { n: Math.round(plan.durationS / 60) })],
  ];
  return (
    <section className="section-card flex min-w-0 flex-col gap-4" aria-label={p.title}>
      {plan.title ? <h2 dir="auto" className="m-0 break-words text-[22px] font-semibold leading-tight">{plan.title}</h2> : null}
      <dl className="m-0 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="t-label">{label}</dt>
            <dd dir="auto" className="m-0 mt-1 break-words text-[15px]">{value || t.common.dash}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Planning({ ageMinutes }: { ageMinutes: number | null }) {
  const { t } = useI18n();
  const s = t.seriesPlan.planning;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The plan's age when this page opened: the schedule counts from when the plan was asked for, not from when this tab was.
  const startAge = useRef(ageMinutes);
  const [stopped, setStopped] = useState(() => nextPollDelay((ageMinutes ?? 0) * 60_000) === null);
  // The page re-reads itself while the plan is being made, with a growing pause, and stops for good after 10 minutes. A cleanup stops it
  // the moment the plan ends or the page is left.
  useEffect(() => {
    if (stopped) return;
    const born = Date.now() - (startAge.current ?? 0) * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delay = nextPollDelay(Date.now() - born);
      if (delay === null) {
        setStopped(true);
        return;
      }
      timer = setTimeout(() => {
        router.refresh();
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [router, stopped]);
  const slow = ageMinutes !== null && ageMinutes >= SLOW_AFTER_MINUTES;
  return (
    <StateBlock
      role="status"
      tone="idle"
      title={s.title}
      actions={
        <button type="button" className="btn-quiet min-h-11 px-4 text-sm" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
          {pending ? s.checking : stopped ? s.checkAgain : s.checkNow}
        </button>
      }
    >
      {stopped ? s.stopped : s.body}
      {slow ? ` ${s.slow}` : ""}
    </StateBlock>
  );
}

function Failed({ plan, againHref }: { plan: PlanView; againHref: string }) {
  const { t } = useI18n();
  const s = t.seriesPlan.failed;
  const key = planErrorKey(plan.errorCode);
  return (
    <StateBlock
      role="alert"
      tone="fail"
      title={s.title}
      actions={
        <Link href={againHref} className="btn-quiet min-h-11 px-4 text-sm">
          {s.again}
        </Link>
      }
    >
      {s.codes[key]} {s.nothingCharged}
    </StateBlock>
  );
}

/** The label that stays on every outline. It is not conditional on anything the model or the database says. */
function NotFactChecked({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const s = t.seriesPlan.notFactChecked;
  if (compact) {
    return (
      <span className="ns-chip" data-plain="true" data-tone="warn" data-not-fact-checked>
        <span className="truncate">{s.label}</span>
      </span>
    );
  }
  return (
    <div role="note" data-not-fact-checked className="rounded-xl border border-[var(--color-warn)] p-4">
      <p className="m-0 text-sm font-semibold">{s.label}</p>
      <p className="m-0 mt-1 break-words text-sm text-[var(--color-muted)]">{s.body}</p>
    </div>
  );
}

function Ready({ plan, rows, linksFailed }: { plan: PlanView; rows: EpisodeRow[]; linksFailed: boolean }) {
  const { t, locale } = useI18n();
  const s = t.seriesPlan;
  const total = seriesTotal(rows.map((r) => ({ n: r.episode.n, usable: r.episode.usable, quote: r.quote })));
  const verdict = plan.report?.verdict ?? "unknown";
  const started = startedSummary(rows.map((r) => ({ usable: r.episode.usable, status: r.episode.status, creditsHeld: r.episode.creditsHeld })));
  return (
    <>
      {/* Always shown, whatever the report says: the label does not depend on a field a stored plan could carry (rule 5). */}
      <NotFactChecked />
      <section className="flex min-w-0 flex-col gap-1 text-sm" aria-label={s.verdict[verdict]}>
        <p className="m-0 break-words">{s.verdict[verdict]}</p>
        <p className="m-0 break-words text-[var(--color-muted)]">{plan.report?.heldTopicsChecked === true ? s.repeats.held : s.repeats.unknown}</p>
      </section>
      <section className="section-card flex min-w-0 flex-col gap-2" aria-label={s.total.title}>
        <div className="t-label">{s.total.title}</div>
        <p className="tnum m-0 break-words text-[20px] font-semibold" data-total={total.kind}>
          {total.kind === "priced"
            ? fmt(total.episodes === 1 ? s.total.pricedOne : s.total.priced, { credits: formatCredits(total.credits, locale), n: total.episodes })
            : total.kind === "included"
              ? s.total.included
              : total.kind === "none"
                ? s.total.none
                : s.total.incomplete}
        </p>
        {started.count > 0 ? (
          <p className="m-0 break-words text-sm" data-started-total>
            {started.held !== null ? fmt(s.total.startedHeld, { n: started.count, credits: formatCredits(started.held, locale) }) : fmt(s.total.started, { n: started.count })}
          </p>
        ) : null}
        <p className="m-0 break-words text-sm text-[var(--color-muted)]">{s.total.note}</p>
      </section>
      {linksFailed ? <p className="m-0 break-words text-sm text-[var(--color-muted)]" role="status">{s.linksFailed}</p> : null}
      <ol className="m-0 flex min-w-0 list-none flex-col gap-5 p-0">
        {rows.map((row) => (
          <li key={row.episode.id} className="min-w-0">
            <EpisodeCard row={row} />
          </li>
        ))}
      </ol>
    </>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="t-label">{label}</div>
      <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-5 text-[15px]">
        {items.map((item, i) => (
          <li key={i} dir="auto" className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <div className="t-label">{label}</div>
      <p dir="auto" className="m-0 mt-1 break-words text-[15px]">{value}</p>
    </div>
  );
}

function ChipView({ chip, href }: { chip: ChipKey; href: string | null }) {
  const { t } = useI18n();
  const c = t.seriesPlan.chip;
  const label = c[chip];
  if (href) {
    const title = chip === "storyboard" ? c.openStoryboard : c.openVideo;
    return (
      <Link href={href} className="ns-chip" data-tone={CHIP_TONE[chip]} data-chip={chip} title={title} aria-label={`${label}. ${title}`}>
        <span className="truncate">{label}</span>
      </Link>
    );
  }
  return (
    <span className="ns-chip" data-plain="true" data-tone={CHIP_TONE[chip]} data-chip={chip}>
      <span className="truncate">{label}</span>
    </span>
  );
}

function priceLine(t: ReturnType<typeof useI18n>["t"], locale: string, ep: EpisodeView, quote: QuoteView | null): string {
  const p = t.seriesPlan.price;
  if (ep.status === "started") {
    if (ep.creditsHeld !== null) return fmt(p.held, { n: formatCredits(ep.creditsHeld, locale) });
    return p.heldIncluded;
  }
  if (!quote) return p.unavailable;
  if (quote.priceStatus === "included") return p.included;
  if (quote.priceStatus === "unpriced" || quote.credits === null) return p.unpriced;
  return fmt(p.credits, { n: formatCredits(quote.credits, locale) });
}

function EpisodeCard({ row }: { row: EpisodeRow }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const s = t.seriesPlan;
  const { confirm, dialog } = useConfirm();
  const { episode: ep, quote } = row;
  const o = ep.outline;
  const [busy, setBusy] = useState(false);

  function errorText(e: StartError): string {
    const m = s.start.errors;
    switch (e.key) {
      case "price_changed":
        return e.credits !== undefined ? fmt(m.price_changed, { credits: formatCredits(e.credits, locale) }) : m.price_changed_unknown;
      case "insufficient":
        return e.available != null && e.needed != null
          ? fmt(m.insufficient, { available: formatCredits(e.available, locale), needed: formatCredits(e.needed, locale) })
          : m.insufficient_unknown;
      default:
        return m[e.key];
    }
  }

  async function start() {
    if (busy || !quote) return;
    setBusy(true);
    try {
      const included = quote.priceStatus === "included";
      const price = quote.credits;
      if (!included && price === null) return;
      const ok = await confirm({
        title: fmt(s.start.title, { n: ep.n }),
        message: included ? s.start.messageIncluded : s.start.message,
        confirmLabel: fmt(s.start.confirmLabel, { n: ep.n }),
        tone: "primary",
        // An episode whose niche nobody confirmed starts only after the person says they read it: the database refuses the call that
        // does not claim it (confirmation_required), and the sheet cannot be pressed without the tick.
        acknowledge: ep.needsConfirmation ? s.start.acknowledge : undefined,
        details: [
          { label: s.start.episode, value: o.workingTitle || ep.topic, multiline: true },
          { label: s.start.price, value: included ? s.start.priceIncluded : fmt(s.price.credits, { n: formatCredits(price, locale) }) },
          { label: s.start.length, value: fmt(t.seriesPlan.page.minutes, { n: Math.round(ep.durationS / 60) }) },
        ],
        run: async () => {
          const supabase = createClient();
          if (!supabase) return s.start.errors.failed;
          const { error } = await supabase.rpc("start_series_episode", {
            p_episode: ep.id,
            // The price that was shown. The database computes its own and refuses unless the two are equal; it holds ITS number.
            p_max_credits: included ? null : Math.round((price ?? 0) * 100) / 100,
            p_idem: startKey(ep.id),
            p_confirmed: ep.needsConfirmation,
          });
          if (!error) return true;
          const e = startError(error);
          // These say the page is out of date: show it as it is now.
          if (["price_changed", "already_started", "earlier_episode_not_finished", "plan_not_ready", "series_not_runnable"].includes(e.key)) {
            router.refresh();
          }
          return errorText(e);
        },
      });
      if (ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const blocked = blockedKey(quote?.blockedBy ?? null);
  const canStart = ep.status === "planned" && ep.usable && quote !== null && quote.startable && quote.mayStart;
  const adminOnly = ep.status === "planned" && ep.usable && quote !== null && quote.startable && !quote.mayStart;
  const reasons = o.reasons.map((word) => {
    const key = reasonKey(word);
    if (key === "repeat") return o.repeatOf ? fmt(s.episode.reasons.repeat, { topic: o.repeatOf }) : s.episode.reasons.repeat_unnamed;
    return s.episode.reasons[key];
  });

  return (
    <article className="section-card flex min-w-0 flex-col gap-4" data-episode={ep.n} aria-labelledby={`ep-${ep.n}-title`}>
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id={`ep-${ep.n}-title`} className="m-0 min-w-0 flex-1 basis-48 break-words text-[18px] font-semibold leading-snug">
          {fmt(s.episode.heading, { n: ep.n })}
          {o.workingTitle ? (
            <>
              {": "}
              <span dir="auto">{o.workingTitle}</span>
            </>
          ) : null}
        </h3>
        <ChipView chip={row.chip} href={row.href} />
      </header>

      {!ep.usable ? (
        <div role="note" className="rounded-xl border border-[var(--color-fail)] p-3" data-refused>
          <p className="m-0 text-sm font-semibold">{s.episode.refusedTitle}</p>
          <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-5 text-sm">
            {reasons.map((r, i) => (
              <li key={i} dir="auto" className="break-words">
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {ep.usable && ep.needsConfirmation && ep.status === "planned" ? (
        <div role="note" className="rounded-xl border border-[var(--color-warn)] p-3" data-needs-confirmation>
          <p className="m-0 text-sm font-semibold">{s.episode.confirm.title}</p>
          <p className="m-0 mt-1 break-words text-sm text-[var(--color-muted)]">{s.episode.confirm[confirmReason(o)]}</p>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-3" data-outline>
        <div>
          <NotFactChecked compact />
        </div>
        <Field label={s.episode.topic} value={ep.topic} />
        <Field label={s.episode.angle} value={o.angle} />
        <Field label={s.episode.hook} value={o.hookSentence} />
        <List label={s.episode.hookOptions} items={o.hookVariants} />
        <List label={s.episode.cta} items={o.ctaVariants} />
        <Field label={s.episode.openLoop} value={o.openLoop} />
        <Field label={s.episode.cliffhanger} value={o.cliffhanger} />
        <List label={s.episode.keyFacts} items={o.keyFacts} />
      </div>

      <footer className="flex min-w-0 flex-col gap-3 border-t border-[var(--color-border)] pt-3">
        <p className="tnum m-0 break-words text-[15px]">
          <span className="t-label mr-2">{s.price.label}</span>
          <span data-price>{priceLine(t, locale, ep, quote)}</span>
        </p>
        {blocked && ep.status === "planned" && ep.usable ? <p className="m-0 break-words text-sm text-[var(--color-muted)]">{s.blocked[blocked]}</p> : null}
        {adminOnly ? <p className="m-0 break-words text-sm text-[var(--color-muted)]">{s.start.adminOnly}</p> : null}
        {canStart ? (
          <button type="button" className="btn-primary min-h-12 w-full px-4 text-sm sm:w-fit" disabled={busy} aria-busy={busy} onClick={() => void start()}>
            {busy ? s.start.starting : fmt(s.start.button, { n: ep.n })}
          </button>
        ) : null}
      </footer>
      {dialog}
    </article>
  );
}
