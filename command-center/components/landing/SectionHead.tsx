/**
 * The landing page's section heading pieces. The hour mark in each eyebrow
 * walks the night from 22:00 at the hero to 06:00 at the closing call — a
 * motif only, hidden from assistive tech, never a time anything takes.
 */
export function Eyebrow({ hour, children }: { hour: string; children: React.ReactNode }) {
  return (
    <div className="lp-eyebrow t-label text-[var(--color-primary)]">
      <span className="lp-hour mono tracking-[0.12em] text-[var(--color-muted)]" aria-hidden>
        {hour}
      </span>
      <span className="lp-eyebrow-text">{children}</span>
    </div>
  );
}

/** Eyebrow, H2 and optional lead — the head every landing section opens with. */
export function SectionHead({
  hour,
  eyebrow,
  title,
  lead,
  id,
  className = "",
}: {
  hour: string;
  eyebrow: string;
  title: string;
  lead?: string;
  /** The H2's id, which the section's aria-labelledby points at. */
  id: string;
  className?: string;
}) {
  return (
    <div className={`max-w-3xl ${className}`}>
      <Eyebrow hour={hour}>{eyebrow}</Eyebrow>
      <h2 id={id} className="t-section mt-5">
        {title}
      </h2>
      {lead && <p className="t-lead mt-5">{lead}</p>}
    </div>
  );
}
