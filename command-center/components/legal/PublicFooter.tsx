import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { LEGAL } from "@/lib/legal";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

type FooterLink = { href: string; label: string; external?: boolean };

/**
 * The public pages' footer: Product, Resources and Legal columns. Every link
 * resolves — section anchors point at sections the homepage always renders
 * (never the showcase, which may be absent), and the contact address appears
 * only when the operator configured one. Google's verification checks that the
 * homepage links the Privacy Policy; Paddle's that pricing is one click away.
 *
 * /login keeps the compact LegalFooter; this one is for the marketing frame.
 */
export function PublicFooter({ t }: { t: Dictionary }) {
  const f = t.landing.footer;
  const columns: { title: string; links: FooterLink[] }[] = [
    {
      title: f.product,
      links: [
        { href: "/#product", label: f.overview },
        { href: "/#how", label: f.how },
        { href: "/#autonomy", label: f.autonomy },
        { href: "/#series", label: f.series },
        { href: "/#capabilities", label: f.capabilities },
      ],
    },
    {
      title: f.resources,
      links: [
        { href: "/#faq", label: f.faq },
        { href: "/#google-data", label: f.googleData },
        { href: GOOGLE_PERMISSIONS, label: f.googleAccess, external: true },
        { href: "/login", label: f.signIn },
        ...(LEGAL.contactEmail ? [{ href: `mailto:${LEGAL.contactEmail}`, label: f.contact, external: true }] : []),
      ],
    },
    {
      title: f.legal,
      links: [
        { href: "/privacy", label: t.legal.privacy },
        { href: "/terms", label: t.legal.terms },
        { href: "/pricing", label: t.legal.pricing },
      ],
    },
  ];

  return (
    <footer className="relative z-10 border-t border-[var(--color-border)]">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))]">
        <div className="flex flex-col gap-3">
          <Link
            href="/"
            className="self-start font-display text-xl font-semibold tracking-[-0.02em] text-[var(--color-primary)]"
          >
            {t.brand.name}
          </Link>
          <p className="max-w-xs text-[13px] font-light leading-relaxed text-[var(--color-muted)]">{t.legal.tagline}</p>
          {LEGAL.contactEmail && (
            <a
              href={`mailto:${LEGAL.contactEmail}`}
              className="mono self-start text-[12px] text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-primary)] hover:underline"
            >
              {LEGAL.contactEmail}
            </a>
          )}
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:contents">
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title} className="flex flex-col gap-1">
              <h2 className="t-label mb-2">{col.title}</h2>
              {col.links.map((l) =>
                l.external ? (
                  <a
                    key={l.href}
                    href={l.href}
                    {...(l.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="flex min-h-9 items-center text-[14px] font-light text-[var(--color-fg)] transition-colors hover:text-[var(--color-primary)]"
                  >
                    {l.label}
                  </a>
                ) : (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="flex min-h-9 items-center text-[14px] font-light text-[var(--color-fg)] transition-colors hover:text-[var(--color-primary)]"
                  >
                    {l.label}
                  </Link>
                ),
              )}
            </nav>
          ))}
        </div>
      </div>
      <div className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-[12px] font-light text-[var(--color-muted)] sm:px-6">
          <span>{LEGAL.legalName ? `© ${LEGAL.legalName}` : t.brand.name}</span>
        </div>
      </div>
    </footer>
  );
}
