import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";
import { LEGAL } from "@/lib/legal";
import { SOLUTION_IDS, solutionHref } from "@/lib/solutions";
import { BrandMark } from "@/components/site/BrandMark";
import { devFor } from "@/lib/i18n/dev";
import { devPagesEnabled } from "@/lib/dev-pages";

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

type FooterLink = { href: string; label: string; external?: boolean };

/**
 * The public pages' footer: Product, Solutions, Company and Legal columns.
 * Every link resolves — section anchors point at sections the homepage always
 * renders. Pricing, Privacy, Terms and Contact are always there: Contact mails
 * the operator's configured address, or opens the Terms' contact section when
 * none is set. Google's verification checks that the homepage links the
 * Privacy Policy; Paddle's that pricing is one click away.
 *
 * /login keeps the compact LegalFooter; this one is for the marketing frame.
 */
export function PublicFooter({ t }: { t: Dictionary }) {
  const f = t.site.footer;
  const dev = devFor(t);
  const contact: FooterLink = LEGAL.contactEmail
    ? { href: `mailto:${LEGAL.contactEmail}`, label: f.contact, external: true }
    : { href: "/terms#contact", label: f.contact };
  const pages = t.site.solutions.pages;
  const columns: { title: string; links: FooterLink[] }[] = [
    {
      title: f.product,
      links: [
        { href: "/#how", label: f.how },
        { href: "/#studio", label: f.studio },
        { href: "/pricing", label: f.pricing },
        { href: "/#faq", label: f.faq },
      ],
    },
    {
      title: f.solutions,
      links: SOLUTION_IDS.map((id) => ({ href: solutionHref(id), label: pages.find((p) => p.id === id)?.nav ?? id })),
    },
    {
      // CLI and Skills are linked only while their flag is on (lib/dev-pages.ts).
      title: dev.nav.label,
      links: [
        { href: "/docs/api", label: f.api },
        { href: "/mcp", label: dev.nav.mcp },
        ...(devPagesEnabled()
          ? [
              { href: "/docs/cli", label: dev.nav.cli },
              { href: "/docs/skills", label: dev.nav.skills },
            ]
          : []),
      ],
    },
    {
      title: f.company,
      links: [
        contact,
        { href: "/login", label: f.signIn },
        { href: "/#google-data", label: f.googleData },
        { href: GOOGLE_PERMISSIONS, label: f.googleAccess, external: true },
      ],
    },
    {
      title: f.legal,
      links: [
        { href: "/privacy", label: t.legal.privacy },
        { href: "/terms", label: t.legal.terms },
      ],
    },
  ];

  return (
    <footer className="st-footer">
      <div className="st-wrap st-footer-grid">
        <div className="flex flex-col gap-3">
          <Link href="/" className="st-brand self-start">
            <BrandMark />
            {t.brand.name}
          </Link>
          <p className="st-small max-w-[30ch]">{f.note}</p>
          {LEGAL.contactEmail && (
            <a href={`mailto:${LEGAL.contactEmail}`} className="st-link self-start text-sm">
              {LEGAL.contactEmail}
            </a>
          )}
        </div>
        <div className="st-footer-cols">
          {columns.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <h2>{col.title}</h2>
              {col.links.map((l) =>
                l.external ? (
                  <a key={l.href} href={l.href} {...(l.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                    {l.label}
                  </a>
                ) : (
                  <Link key={l.href} href={l.href}>
                    {l.label}
                  </Link>
                ),
              )}
            </nav>
          ))}
        </div>
      </div>
      <div className="st-wrap">
        <div className="st-footer-base">
          <span>{LEGAL.legalName ? `© ${LEGAL.legalName}` : t.brand.name}</span>
          <span>{t.legal.tagline}</span>
        </div>
      </div>
    </footer>
  );
}
