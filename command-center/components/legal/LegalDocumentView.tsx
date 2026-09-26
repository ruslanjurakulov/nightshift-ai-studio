import Link from "next/link";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { LegalBlock, LegalDocument } from "@/lib/legal-docs";
import { tokenizeInline, type LegalVar } from "@/lib/legal-docs/inline";
import { LEGAL, LEGAL_ENV_VARS, type LegalConfig } from "@/lib/legal";

/** An operator detail, or the marker saying which env var would supply it. */
function Var({ name, t }: { name: LegalVar; t: Dictionary }) {
  const value = LEGAL[name as keyof LegalConfig];
  if (value === null) {
    return (
      <span
        className="mono whitespace-nowrap rounded-md border border-[var(--color-warn)] px-1.5 py-0.5 text-[0.8em] text-[var(--color-warn)]"
        title={LEGAL_ENV_VARS[name]}
      >
        {t.legal.notConfigured} · {LEGAL_ENV_VARS[name]}
      </span>
    );
  }
  if (name === "contactEmail") {
    return (
      <a href={`mailto:${value}`} className="text-[var(--color-primary)] underline underline-offset-4">
        {value}
      </a>
    );
  }
  return <>{value}</>;
}

function Inline({ text, t }: { text: string; t: Dictionary }) {
  return (
    <>
      {tokenizeInline(text).map((tok, i) => {
        switch (tok.kind) {
          case "text":
            return <span key={i}>{tok.text}</span>;
          case "code":
            return (
              <code key={i} className="mono break-all text-[0.88em] text-[var(--color-fg)]">
                {tok.text}
              </code>
            );
          case "var":
            return <Var key={i} name={tok.name} t={t} />;
          case "link":
            return tok.href.startsWith("/") ? (
              <Link key={i} href={tok.href} className="text-[var(--color-primary)] underline underline-offset-4">
                {tok.label}
              </Link>
            ) : (
              <a
                key={i}
                href={tok.href}
                target="_blank"
                rel="noopener noreferrer"
                className="break-words text-[var(--color-primary)] underline underline-offset-4"
              >
                {tok.label}
              </a>
            );
        }
      })}
    </>
  );
}

function Block({ block, t }: { block: LegalBlock; t: Dictionary }) {
  if (typeof block === "string") {
    return (
      <p>
        <Inline text={block} t={t} />
      </p>
    );
  }
  if ("list" in block) {
    return (
      <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-[var(--color-primary)]">
        {block.list.map((item, i) => (
          <li key={i}>
            <Inline text={item} t={t} />
          </li>
        ))}
      </ul>
    );
  }
  if ("note" in block) {
    return (
      <p
        role="note"
        className="rounded-xl border border-[var(--color-warn)] px-4 py-3 text-[14px] font-medium text-[var(--color-warn)]"
      >
        <Inline text={block.note} t={t} />
      </p>
    );
  }
  // Tables scroll inside their own box on a phone rather than widening the page.
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
      <table className="w-full min-w-[34rem] border-collapse text-left text-[14px]">
        <thead className="bg-[var(--color-panel-2)]">
          <tr>
            {block.table.head.map((h, i) => (
              <th key={i} scope="col" className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-muted)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.table.rows.map((row, r) => (
            <tr key={r} className="border-t border-[var(--color-border)] align-top">
              {row.map((cell, c) => (
                <td key={c} className={`px-4 py-3 ${c === 0 ? "font-medium text-[var(--color-fg)]" : ""}`}>
                  <Inline text={cell} t={t} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LegalDocumentView({ doc, t, locale }: { doc: LegalDocument; t: Dictionary; locale: Locale }) {
  const facts: { label: string; name: LegalVar }[] = [
    { label: t.legal.operator, name: "legalName" },
    { label: t.legal.country, name: "country" },
    { label: t.legal.contact, name: "contactEmail" },
    { label: t.legal.effectiveDate, name: "effectiveDate" },
  ];

  return (
    <article className="mx-auto w-full max-w-3xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
      <h1 className="t-hero">{doc.title}</h1>
      <p className="t-lead mt-4">{doc.summary}</p>

      <dl className="glass-card mt-8 grid gap-x-6 gap-y-3 rounded-2xl border border-[var(--color-border)] p-5 text-[14px] sm:grid-cols-2">
        {facts.map((f) => (
          <div key={f.name} className="flex flex-col gap-1">
            <dt className="t-label">{f.label}</dt>
            <dd>
              <Var name={f.name} t={t} />
            </dd>
          </div>
        ))}
      </dl>

      {locale !== "en" && (
        <p className="mt-4 text-[13px] font-light text-[var(--color-muted)]">{t.legal.translationNote}</p>
      )}

      <nav aria-label={t.legal.contents} className="mt-10">
        <div className="t-label">{t.legal.contents}</div>
        <ol className="mt-3 grid gap-1.5 text-[14px] sm:grid-cols-2">
          {doc.sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-primary)]">
                {s.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-12 flex flex-col gap-12">
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-6">
            <h2 className="text-[1.375rem] font-semibold tracking-[-0.015em]">{s.heading}</h2>
            <div className="mt-4 flex flex-col gap-4 text-[15px] font-light leading-relaxed text-[var(--color-fg)]">
              {s.body.map((b, i) => (
                <Block key={i} block={b} t={t} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
