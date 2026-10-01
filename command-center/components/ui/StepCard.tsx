import type { ReactNode } from "react";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Timecode, type TimecodeFormat } from "@/components/ui/Timecode";

/**
 * One step of a long make — script → characters → storyboard → render — as a
 * rundown line (IDENTITY.md §Signature devices; the reference products' step
 * cards with a total at each step, and their node strip with a price per
 * node). The number is the step's real position; the price is this step's
 * quote and the total is what the make has cost up to and including it.
 *
 * Prices are the backend's or nothing: null shows the `unknownPrice` words
 * ("priced after the script"), never 0.
 */
export type StepState = "done" | "current" | "next" | "blocked";

export function StepList({
  label,
  layout = "column",
  children,
}: {
  label: string;
  /** `row` lays the steps side by side from md up (a pipeline strip). */
  layout?: "column" | "row";
  children: ReactNode;
}) {
  return (
    <ol className="ns-steps" aria-label={label} data-layout={layout}>
      {children}
    </ol>
  );
}

export function StepCard({
  index,
  title,
  state,
  stateLabel,
  price,
  total,
  priceLabel,
  totalLabel,
  unknownPrice,
  unit,
  format = "credits",
  priceWords,
  totalWords,
  locale = "en",
  testId,
  children,
  action,
}: {
  /** 1-based position in the make. */
  index: number;
  title: ReactNode;
  state: StepState;
  /** The state in words ("Done", "Now", "Next", "Waiting"). */
  stateLabel: string;
  price?: number | null;
  total?: number | null;
  priceLabel: string;
  totalLabel: string;
  /** What an unknown price reads as. */
  unknownPrice: string;
  unit?: string;
  /** What the two figures count: credits (default), or a length (`duration`: running length of a plan). */
  format?: TimecodeFormat;
  /** A known state said in words instead of a figure ("not charged"); never a stand-in for an unknown. */
  priceWords?: string;
  totalWords?: string;
  locale?: string;
  testId?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tone = state === "done" ? "ok" : state === "current" ? "run" : state === "blocked" ? "warn" : "idle";
  return (
    <li className="ns-step" data-state={state} data-testid={testId} aria-current={state === "current" ? "step" : undefined}>
      <span aria-hidden className="ns-step-no">
        {String(index).padStart(2, "0")}
      </span>
      <div className="ns-step-title">
        <span className="min-w-0">{title}</span>
        <StatusLamp tone={tone} label={stateLabel} />
      </div>
      {children ? <div className="ns-step-body">{children}</div> : <span />}
      <div className="ns-step-price">
        <span>
          {priceLabel}{" "}
          <strong>
            {priceWords ? <span>{priceWords}</span> : <Timecode value={price} format={format} locale={locale} unit={unit} unknown={unknownPrice} />}
          </strong>
        </span>
        <span>
          {totalLabel}{" "}
          <strong>
            {totalWords ? <span>{totalWords}</span> : <Timecode value={total} format={format} locale={locale} unit={unit} unknown={unknownPrice} />}
          </strong>
        </span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
    </li>
  );
}
