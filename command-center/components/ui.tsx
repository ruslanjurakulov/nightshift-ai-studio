import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";

const TONE: Record<string, { fg: string; label: string }> = {
  ok: { fg: "var(--color-ok)", label: "OK" },
  run: { fg: "var(--color-primary)", label: "RUNNING" },
  fail: { fg: "var(--color-fail)", label: "FAILED" },
  warn: { fg: "var(--color-warn)", label: "WARN" },
  idle: { fg: "var(--color-idle)", label: "IDLE" },
};

export function StatusPill({
  tone,
  label,
  live = false,
}: {
  tone: keyof typeof TONE;
  label?: string;
  /** Breathe the dot (for genuinely-active states like a live connection). */
  live?: boolean;
}) {
  const t = TONE[tone] ?? TONE.idle;
  return (
    <span className="inline-flex items-center gap-1.5 mono text-[10px] font-semibold tracking-wider">
      <span
        className={`glow-dot inline-block size-1.5 rounded-full${live ? " live-ring" : ""}`}
        style={{ color: t.fg, background: t.fg }}
      />
      <span style={{ color: t.fg }}>{label ?? t.label}</span>
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: keyof typeof TONE;
}) {
  const color = tone ? (TONE[tone]?.fg ?? "var(--color-fg)") : "var(--color-fg)";
  return (
    <div className="border-t border-[var(--color-border)] pt-4 transition-colors hover:border-[var(--color-primary-dim)]">
      <div className="t-label">{label}</div>
      <div className="t-figure mt-3" style={{ color }}>
        {value}
      </div>
      {sub !== undefined && (
        <div className="mt-2 text-[13px] font-light text-[var(--color-muted)]">{sub}</div>
      )}
    </div>
  );
}

export function Panel({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section-open">
      <header className="section-head">
        <h2 className="t-panel">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

/**
 * The one empty state used across the app. A calm icon in a soft disc over a
 * short line of text, centered — a product's "nothing here yet", not a blank
 * gap. Pass `icon` to match the surface (a film reel for videos, a chart for
 * analytics); it defaults to a neutral inbox so every caller reads the same.
 */
export function EmptyState({
  children,
  icon: Icon = Inbox,
}: {
  children: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <span
        aria-hidden
        className="grid size-14 place-items-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
      >
        <Icon className="size-6" strokeWidth={1.5} />
      </span>
      <p className="m-0 max-w-[46ch] text-[14px] font-light leading-relaxed text-[var(--color-muted)]">
        {children}
      </p>
    </div>
  );
}
