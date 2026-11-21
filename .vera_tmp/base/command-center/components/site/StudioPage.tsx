import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { FaqList } from "@/components/landing/Faq";
import { EditorExample, PublishExample, StoryboardExample } from "@/components/site/StudioExamples";
import { faqPageJsonLd, jsonLdScript } from "@/lib/studio-page";
import "@/components/site/studio-page.css";

type Item = { id: string; title: string; body: string };

function Head({ id, label, title, lead }: { id: string; label: string; title: string; lead: string }) {
  return (
    <div className="sp-head">
      <p className="nx-label">{label}</p>
      <h2 id={id} className="nx-h2">
        {title}
      </h2>
      <p className="nx-sub">{lead}</p>
    </div>
  );
}

function List({ items, cols }: { items: readonly Item[]; cols?: 2 }) {
  return (
    <ul className="sp-list" data-cols={cols}>
      {items.map((i) => (
        <li key={i.id}>
          <h3>{i.title}</h3>
          <p>{i.body}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * /studio: what you can make and edit. One h1, then one h2 per block (the plan, the editor, publishing, price,
 * questions), each listing only what the product does today, with a drawn "Example" beside it where there is
 * something to draw. The questions are also given to search engines as FAQPage structured data, built from the same
 * strings (lib/studio-page.ts). A Server Component; the page frame (header, main, footer) is PublicShell's.
 */
export function StudioPage({ t }: { t: Dictionary }) {
  const p = t.site.studioPage;
  const ledger = t.site.pricingTeaser.ledger;
  const faqLinks: Record<string, { href: string; label: string }> = {
    pay: { href: "/pricing", label: p.faq.links.pay },
    fails: { href: "/terms#credits", label: p.faq.links.fails },
    data: { href: "/privacy", label: p.faq.links.data },
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqPageJsonLd(p.faq.items)) }} />

      <section aria-labelledby="studio-title" className="sp-hero">
        <div className="nx-wrap">
          <p className="nx-label">{p.hero.label}</p>
          <h1 id="studio-title" className="st-h1-page">
            {p.hero.title}
          </h1>
          <p className="st-lead mt-6">{p.hero.lead}</p>
          <div className="st-hero-actions">
            <Link href="/signup" className="st-key">
              {p.hero.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="st-link">
              {p.hero.secondary}
            </Link>
          </div>
          <nav aria-label={p.hero.jumpLabel}>
            <ul className="sp-jump">
              {p.hero.jump.map((j) => (
                <li key={j.id}>
                  <a href={`#${j.id}`}>{j.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>

      <section id="plan" aria-labelledby="plan-title" className="nx-section" data-tone="raised">
        <div className="nx-wrap">
          <Head id="plan-title" label={p.plan.label} title={p.plan.title} lead={p.plan.lead} />
          <div className="sp-split">
            <List items={p.plan.items} />
            <StoryboardExample p={p} />
          </div>
        </div>
      </section>

      <section id="editor" aria-labelledby="editor-title" className="nx-section">
        <div className="nx-wrap">
          <Head id="editor-title" label={p.editor.label} title={p.editor.title} lead={p.editor.lead} />
          <EditorExample p={p} t={t} />
          <div className="mt-10">
            <List items={p.editor.items} cols={2} />
          </div>
          <ul className="sp-notes">
            {p.editor.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="sp-caveat">{p.caveat}</p>
        </div>
      </section>

      <section id="publish" aria-labelledby="publish-title" className="nx-section" data-tone="raised">
        <div className="nx-wrap">
          <Head id="publish-title" label={p.publish.label} title={p.publish.title} lead={p.publish.lead} />
          <div className="sp-split">
            <List items={p.publish.items} />
            <PublishExample p={p} />
          </div>
        </div>
      </section>

      <section id="price" aria-labelledby="price-title" className="nx-section">
        <div className="nx-wrap">
          <Head id="price-title" label={p.price.label} title={p.price.title} lead={p.price.lead} />
          <ol className="sp-ledger" aria-label={p.price.ledgerLabel}>
            {ledger.map((row) => (
              <li key={row.id}>
                <b>{row.word}</b>
                <span>{row.body}</span>
              </li>
            ))}
          </ol>
          <Link href="/pricing" className="nx-link sp-link">
            {p.price.link}
            <ArrowRight aria-hidden />
          </Link>
        </div>
      </section>

      <section id="faq" aria-labelledby="faq-title" className="nx-section" data-tone="raised">
        <div className="nx-wrap grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div>
            <p className="nx-label">{p.faq.label}</p>
            <h2 id="faq-title" className="nx-h2">
              {p.faq.title}
            </h2>
          </div>
          <FaqList items={p.faq.items} linkFor={(id) => faqLinks[id] ?? null} />
        </div>
      </section>

      <section aria-labelledby="studio-final" className="nx-section sp-final">
        <div className="nx-wrap">
          <h2 id="studio-final" className="nx-h2">
            {p.final.title}
          </h2>
          <p className="nx-sub">{p.final.lead}</p>
          <div className="st-hero-actions">
            <Link href="/signup" className="st-key">
              {p.final.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="st-link">
              {p.hero.secondary}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
