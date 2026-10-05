import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { PackExpiry } from "@/lib/plans";
import { SectionHead } from "@/components/landing/SectionHead";

type FaqItem = { id: string; q: string; a: string };
type FaqLink = { href: string; label: string } | null;

/** The one money answer open on the homepage: refunds. Cancelling, unused credits and the rest are one tap away, and /pricing opens its own. */
const OPEN_ON_ARRIVAL = ["refund"] as const;
const OPEN_ON_ARRIVAL_PACKS = ["refund"] as const;

/**
 * The money questions as they apply to what is on sale. With no monthly plan
 * on sale the plan question goes, and the answers that mention plans take
 * their packs-only wording (t.site.packsOnly) — never a sentence about a plan
 * that does not exist.
 */
export function faqForSale<T extends FaqItem>(
  items: readonly T[],
  plansOnSale: boolean,
  packsOnly: Dictionary["site"]["packsOnly"],
  /** This deployment's pack expiry (lib/plans.ts packExpiry). */
  expiry: PackExpiry,
): T[] {
  if (plansOnSale) return [...items];
  return items
    .filter((item) => item.id !== "cancel")
    .map((item) =>
      item.id === "card"
        ? { ...item, a: packsOnly.card }
        : item.id === "unused" || item.id === "rollover"
          ? { ...item, a: unusedAnswer(packsOnly, expiry) }
          : item,
    );
}

/** The unused-credits answer, as sure as the expiry is: an unknown term points to the Terms (BR-L-100). */
function unusedAnswer(packsOnly: Dictionary["site"]["packsOnly"], expiry: PackExpiry): string {
  if (expiry.kind === "never") return packsOnly.unusedNever;
  if (expiry.kind === "months") return fmt(packsOnly.unusedAfter, { m: expiry.months });
  return packsOnly.unusedUnknown;
}

/** The expiry line among the pack terms (/pricing and the landing). */
export function expiryTerm(p: Dictionary["pricing"], expiry: PackExpiry): string {
  if (expiry.kind === "never") return p.expiryNever;
  if (expiry.kind === "months") return fmt(p.expiryAfter, { m: expiry.months });
  return p.expiryUnknown;
}

/** Answers that point somewhere carry the link beneath them. */
function faqLink(id: string, f: Dictionary["landing"]["faq"]): FaqLink {
  if (id === "data") return { href: "/privacy", label: f.privacyLink };
  if (id === "unused") return { href: "/pricing", label: f.pricingLink };
  if (id === "cancel" || id === "refund") return { href: "/terms#credits", label: f.termsLink };
  return null;
}

/**
 * Native <details>/<summary>: keyboard- and screen-reader-accessible with no
 * script, and every answer is in the HTML for search engines. Shared by the
 * homepage FAQ and the Pricing page's questions.
 */
export function FaqList({
  items,
  linkFor,
  openIds = [],
}: {
  items: readonly FaqItem[];
  linkFor?: (id: string) => FaqLink;
  /** Answers shown open on arrival — the money terms a visitor should read before paying. */
  openIds?: readonly string[];
}) {
  return (
    <div className="st-faq">
      {items.map((item) => {
        const link = linkFor?.(item.id) ?? null;
        return (
          <details key={item.id} open={openIds.includes(item.id)}>
            <summary>
              <h3>{item.q}</h3>
              <span className="st-faq-mark" aria-hidden />
            </summary>
            <div className="st-faq-body">
              <p className="st-body">{item.a}</p>
              {link && (
                <Link href={link.href} className="st-link mt-2">
                  {link.label}
                  <ArrowRight aria-hidden />
                </Link>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

/**
 * The homepage FAQ: the questions to settle before paying — cancelling,
 * refunds, unused credits, privacy. Refunds are open on arrival, so the
 * money terms are read before the buy button, not after. Each
 * answer describes what the code does today — no promised timings, no roadmap.
 */
export function Faq({
  t,
  plansOnSale,
  expiry,
  aside,
}: {
  t: Dictionary;
  plansOnSale: boolean;
  /** The pack expiry, so the unused-credits answer says it as surely as it is known. */
  expiry: PackExpiry;
  aside?: React.ReactNode;
}) {
  const f = t.landing.faq;
  const items = faqForSale(f.items, plansOnSale, t.site.packsOnly, expiry);
  return (
    <section id="faq" aria-labelledby="faq-title" className="st-section" data-tone="raised">
      <div className="st-wrap grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        {/* The left column carries the title and whatever the page puts under
            it (the landing: its Google data statement), so it is never empty. */}
        <div className="flex flex-col gap-12">
          <SectionHead eyebrow={f.eyebrow} title={f.title} id="faq-title" />
          {aside}
        </div>
        <FaqList items={items} linkFor={(id) => faqLink(id, f)} openIds={plansOnSale ? OPEN_ON_ARRIVAL : OPEN_ON_ARRIVAL_PACKS} />
      </div>
    </section>
  );
}
