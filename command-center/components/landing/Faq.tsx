import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { SectionHead } from "@/components/landing/SectionHead";

type FaqItem = { id: string; q: string; a: string };
type FaqLink = { href: string; label: string } | null;

const OPEN_ON_ARRIVAL = ["cancel", "refund"] as const;

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
    <div className="border-b border-[var(--color-border)]">
      {items.map((item) => {
        const link = linkFor?.(item.id) ?? null;
        return (
          <details key={item.id} open={openIds.includes(item.id)} className="lp-faq group border-t border-[var(--color-border)]">
            <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-4 py-4 text-[16px] font-medium transition-colors hover:text-[var(--color-primary)]">
              <h3 className="font-sans">{item.q}</h3>
              <Plus className="lp-faq-icon size-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
            </summary>
            <div className="pb-6 pr-8">
              <p className="text-[15px] font-light leading-relaxed text-[var(--color-muted)]">{item.a}</p>
              {link && (
                <Link
                  href={link.href}
                  className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[14px] text-[var(--color-primary)] underline-offset-4 hover:underline"
                >
                  {link.label}
                  <ArrowRight className="size-3.5" aria-hidden />
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
 * refunds, unused credits, privacy. Cancelling and refunds are open on
 * arrival, so the terms are read before the buy button, not after. Each
 * answer describes what the code does today — no promised timings, no roadmap.
 */
export function Faq({ t, hour }: { t: Dictionary; hour: string }) {
  const f = t.landing.faq;
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <SectionHead hour={hour} eyebrow={f.eyebrow} title={f.title} id="faq-title" className="lg:sticky lg:top-28 lg:self-start" />
        <FaqList items={f.items} linkFor={(id) => faqLink(id, f)} openIds={OPEN_ON_ARRIVAL} />
      </div>
    </section>
  );
}
