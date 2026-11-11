"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatNumber } from "@/lib/number-format";
import {
  BASE,
  BUDGET_KINDS,
  computeBudget,
  defaultDuration,
  parseBudget,
  optionOf,
  type BudgetKind,
  type BudgetModel,
  type BudgetResult,
} from "@/lib/owner/budget";
import { StateBlock } from "@/components/states/StateBlock";

type Text = ReturnType<typeof useI18n>["t"]["modelBudget"];

/**
 * The owner's prices and budget board (lib/owner/budget.ts). Every registry model, grouped by what it makes, with the
 * vendor's price per unit and a "Budget ($)" field whose answer is worked out here as it is typed: arithmetic on the
 * registry's own figures, nothing asked of a server, nothing written anywhere.
 */
export function ModelBudgetBoard({ groups, pricesUnread }: { groups: Record<BudgetKind, BudgetModel[]>; pricesUnread: boolean }) {
  const { t } = useI18n();
  const b = t.modelBudget;
  return (
    <div className="flex flex-col gap-4" data-testid="model-budget-board">
      <p className="m-0 max-w-[68ch] text-sm text-[var(--color-muted)]">{b.subtitle}</p>
      <details className="rounded-xl border border-[var(--color-border)]">
        <summary className="tap cursor-pointer px-3 py-2 text-sm font-medium text-[var(--color-fg)]">{b.rules.title}</summary>
        <ul className="m-0 flex list-disc flex-col gap-1 px-8 pb-3 pt-1 text-xs leading-relaxed text-[var(--color-muted)]">
          {b.rules.items.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      {pricesUnread && (
        <StateBlock role="status" tone="warn" compact>
          {b.pricesUnread}
        </StateBlock>
      )}
      {BUDGET_KINDS.filter((k) => groups[k].length > 0).map((k) => (
        <section key={k} className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby={`budget-${k}`} data-testid="budget-group" data-kind={k}>
          <h2 id={`budget-${k}`} className="t-section">
            {b.kinds[k]} <span className="text-xs font-normal text-[var(--color-muted)]">· {fmt(b.count, { n: groups[k].length })}</span>
          </h2>
          <ul className="m-0 flex list-none flex-col divide-y divide-[var(--color-border)] p-0">
            {groups[k].map((m) => (
              <BudgetRow key={m.id} m={m} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** "720p_audio" -> "720p, with sound": the registry's own key, with the words it uses translated. */
function variantLabel(key: string, b: Text): string {
  const words = b.variantWords as Record<string, string>;
  return key
    .split("_")
    .map((p) => words[p] ?? p)
    .join(", ");
}

function usd(n: number, locale: string): string {
  // Up to six decimals: a per-character voice price of $0.00004 must not print as $0.
  return `$${formatNumber(n, locale, 6)}`;
}

function BudgetRow({ m }: { m: BudgetModel }) {
  const { t, locale } = useI18n();
  const b = t.modelBudget;
  const ids = useId();
  const [budget, setBudget] = useState("");
  const [optionKey, setOptionKey] = useState<string | null>(m.defaultOption);
  const [durationS, setDurationS] = useState<number | null>(defaultDuration(m));
  const option = optionOf(m, optionKey);
  const priced = m.options.length > 0 && m.unit !== null;
  const perUnit = m.unit ? b.perUnit[m.unit] : "";
  const optionText = (key: string) =>
    key === BASE ? (m.baseMatches.length > 1 ? fmt(b.optionBaseSame, { keys: m.baseMatches.map((k) => variantLabel(k, b)).join(" / ") }) : b.optionBase) : variantLabel(key, b);
  const result: BudgetResult = option
    ? computeBudget({ budget, kind: m.kind, unit: m.unit, usdPerUnit: option.usd, durationS, floorSeconds: m.floorSeconds })
    : { kind: "no_price" };
  const lengthApplies = m.unit === "second" && (m.kind === "video" || m.durations.length > 0) && m.durations.length > 0;
  const status = statusChips(m, b);

  return (
    <li className="flex flex-col gap-2 py-3" data-testid="budget-model" data-model={m.id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-[var(--color-fg)]">{m.displayName}</span>
        <span className="text-xs text-[var(--color-muted)]">{m.provider}</span>
        {status.map((s) => (
          <span key={s.text} className={`rounded-full border px-2 py-0.5 text-[11px] ${s.warn ? "border-[var(--color-warn)] text-[var(--color-warn)]" : "border-[var(--color-border)] text-[var(--color-muted)]"}`}>
            {s.text}
          </span>
        ))}
      </div>

      {!priced ? (
        <p className="m-0 text-sm text-[var(--color-muted)]" data-testid="budget-no-price">
          {b.noPrice}
        </p>
      ) : (
        <>
          <div className="flex min-w-0 max-w-full flex-wrap items-end gap-3">
            {m.options.length > 1 && (
              <label className="flex min-w-0 max-w-full flex-col gap-1 break-words text-xs text-[var(--color-muted)]" htmlFor={`${ids}-opt`}>
                {b.option}
                <select
                  id={`${ids}-opt`}
                  className="min-h-[44px] w-full max-w-full truncate rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] px-2 text-sm text-[var(--color-fg)]"
                  value={optionKey ?? ""}
                  onChange={(e) => setOptionKey(e.target.value)}
                >
                  {m.options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {optionText(o.key)} — {usd(o.usd, locale)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {lengthApplies && m.durations.length > 1 && (
              <label className="flex min-w-0 max-w-full flex-col gap-1 break-words text-xs text-[var(--color-muted)]" htmlFor={`${ids}-len`}>
                {b.length}
                <select
                  id={`${ids}-len`}
                  className="min-h-[44px] w-full max-w-full truncate rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] px-2 text-sm text-[var(--color-fg)]"
                  value={durationS ?? ""}
                  onChange={(e) => setDurationS(Number(e.target.value))}
                >
                  {m.durations.map((d) => (
                    <option key={d} value={d}>
                      {fmt(b.seconds, { n: d })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex min-w-0 max-w-full flex-col gap-1 break-words text-xs text-[var(--color-muted)]" htmlFor={`${ids}-budget`}>
              {b.budget}
              <input
                id={`${ids}-budget`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={b.budgetPlaceholder}
                className="min-h-[44px] w-32 max-w-full rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] px-3 text-sm text-[var(--color-fg)] aria-[invalid=true]:border-[var(--color-fail)]"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                aria-invalid={result.kind === "invalid" ? true : undefined}
                aria-describedby={`${ids}-result`}
                data-testid="budget-input"
              />
            </label>
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-[var(--color-muted)]">{b.vendorCost}</dt>
            <dd className="m-0 min-w-0 break-words text-[var(--color-fg)]" data-testid="budget-vendor-cost">
              {option ? `${usd(option.usd, locale)} ${perUnit}` : b.noPrice}
              {option && optionKey !== null && (m.options.length > 1 || optionKey !== BASE) ? ` · ${optionText(optionKey)}` : ""}
              {m.estimate ? ` · ${b.estimate}` : ""}
              {m.asOf ? ` · ${fmt(b.asOf, { date: m.asOf })}` : ""}
            </dd>
            <dt className="text-[var(--color-muted)]">{b.customer}</dt>
            <dd className="m-0 min-w-0 break-words text-[var(--color-fg)]" data-testid="budget-customer">
              {m.customerUnread
                ? b.customerUnread
                : option?.customerCredits != null
                  ? fmt(b.credits, { n: formatNumber(option.customerCredits, locale, 4), unit: perUnit })
                  : b.customerNone}
            </dd>
          </dl>
          {m.unpricedVariants.length > 0 && (
            <p className="m-0 text-[11px] text-[var(--color-muted)]">{fmt(b.unpriced, { keys: m.unpricedVariants.map((k) => variantLabel(k, b)).join(", ") })}</p>
          )}
          <BudgetLine id={`${ids}-result`} result={result} m={m} budget={budget} optionKey={optionKey} durationS={durationS} />
        </>
      )}
    </li>
  );
}

function statusChips(m: BudgetModel, b: Text): { text: string; warn: boolean }[] {
  const out: { text: string; warn: boolean }[] = [];
  out.push({ text: m.availability ? b.status[m.availability] : b.status.unknown, warn: false });
  if (m.termsGate) out.push({ text: b.status.terms, warn: true });
  if (m.shutdownOn) out.push({ text: fmt(m.pastShutdown ? b.status.pastShutdown : b.status.shutdown, { date: m.shutdownOn }), warn: m.pastShutdown });
  return out;
}

/** The small text under the field: nothing until an amount is typed. */
function BudgetLine({
  id,
  result,
  m,
  budget,
  optionKey,
  durationS,
}: {
  id: string;
  result: BudgetResult;
  m: BudgetModel;
  budget: string;
  optionKey: string | null;
  durationS: number | null;
}) {
  const { t, locale } = useI18n();
  const b = t.modelBudget;
  const n = (v: number) => formatNumber(v, locale, 0);
  const min = (v: number) => formatNumber(v, locale, 1);
  if (result.kind === "empty") return <p id={id} className="m-0 min-h-[1rem] text-xs" aria-live="polite" data-testid="budget-result" />;
  if (result.kind === "invalid")
    return (
      <p id={id} className="m-0 text-xs text-[var(--color-fail)]" aria-live="polite" data-testid="budget-result">
        {b.notAmount}
      </p>
    );
  if (result.kind === "no_price")
    return (
      <p id={id} className="m-0 text-xs text-[var(--color-muted)]" aria-live="polite" data-testid="budget-result">
        {b.noPrice}
      </p>
    );
  // The amount as it was read, so "10,5" is visibly $10.5 and nothing else.
  const amount = parseBudget(budget);
  const main: string[] = [];
  // Short clauses about billing ("each billed as 10 s"), and whole sentences about what the count stands on.
  const notes: string[] = [];
  const basis: string[] = [];
  switch (result.kind) {
    case "videos":
      main.push(fmt(b.result.videos, { d: result.durationS, n: n(result.count), m: min(result.minutes) }));
      if (result.billedS > result.durationS) notes.push(fmt(b.result.billed, { b: result.billedS }));
      break;
    case "seconds":
      main.push(fmt(b.result.minutes, { m: min(result.minutes) }));
      if (result.clips) {
        main.push(fmt(b.result.clips, { d: result.clips.durationS, n: n(result.clips.count) }));
        if (result.clips.billedS > result.clips.durationS) notes.push(fmt(b.result.billed, { b: result.clips.billedS }));
      }
      if (result.floorSeconds) notes.push(fmt(b.result.floor, { f: result.floorSeconds }));
      break;
    case "images":
      main.push(fmt(b.result.images, { n: n(result.count) }));
      break;
    case "characters":
      main.push(fmt(b.result.characters, { n: n(result.count) }));
      break;
    case "requests":
      main.push(fmt(b.result.requests, { n: n(result.count) }));
      break;
  }
  // Say which option and length the count stands on, when the owner has not picked them.
  if (optionKey === m.defaultOption && m.defaultWhy && (m.options.length > 1 || optionKey !== BASE)) basis.push(b.startsOn[m.defaultWhy]);
  if (durationS !== null && durationS === defaultDuration(m) && m.durations.length > 1 && (result.kind === "videos" || (result.kind === "seconds" && result.clips))) basis.push(b.shortest);
  return (
    <p id={id} className="m-0 break-words text-xs text-[var(--color-fg)]" aria-live="polite" data-testid="budget-result">
      {main.join(" · ")}
      {amount !== null && <span className="text-[var(--color-muted)]"> {fmt(b.forAmount, { amount: `$${formatNumber(amount, locale, 6)}` })}</span>}
      {notes.length > 0 && <span className="text-[var(--color-muted)]"> — {notes.join("; ")}</span>}
      {basis.length > 0 && <span className="block text-[11px] text-[var(--color-muted)]">{basis.join(" ")}</span>}
    </p>
  );
}
