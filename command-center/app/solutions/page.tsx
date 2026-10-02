import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { PublicShell } from "@/components/legal/PublicShell";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { Slug } from "@/components/site/Slug";
import { StatusLamp } from "@/components/ui/StatusLamp";

/** Public: listed exactly in lib/public-paths.ts (SOLUTION_PATHS). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.site.solutions.meta;
  const title = `${m.title} · ${t.brand.name}`;
  return {
    title: { absolute: title },
    description: m.description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/solutions",
      title,
      description: m.description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/**
 * The Solutions index: the three ways into the one product, then the three
 * rules that hold whichever way you came in.
 */
export default async function SolutionsPage() {
  const { t } = await getDictionary();
  const s = t.site.solutions;
  const rules = t.site.rules;
  return (
    <PublicShell t={t} current="solutions">
      <section aria-labelledby="solutions-title" className="st-wrap pb-16 pt-10 lg:pb-24 lg:pt-20">
        <Slug>{s.slug}</Slug>
        <h1 id="solutions-title" className="st-h1-page mt-8 max-w-[20ch]">
          {s.title}
        </h1>
        <p className="st-lead mt-7">{s.lead}</p>
        <ul className="st-ways">
          {s.pages.map((page, i) =>
            isSolutionId(page.id) ? (
              <li key={page.id} className="st-way" aria-labelledby={`way-${page.id}`}>
                <span className="st-way-no st-num" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="st-way-head">
                  <span className="st-kicker">{page.kicker}</span>
                  <h2 id={`way-${page.id}`} className="st-h3 text-[clamp(26px,2.4vw,34px)]">
                    <Link href={solutionHref(page.id)} className="st-way-title">
                      {/* The last word and the arrow never part: a title that
                          filled its line left the arrow alone on the next. */}
                      {page.title.split(" ").slice(0, -1).join(" ")}{" "}
                      <span className="whitespace-nowrap">
                        {page.title.split(" ").slice(-1)[0]}
                        <ArrowRight aria-hidden />
                      </span>
                    </Link>
                  </h2>
                  <p className="st-small max-w-[52ch]">{page.lead}</p>
                </div>
                <ul className="st-way-list" aria-label={s.whatLabel}>
                  {page.what.slice(0, 3).map((w) => (
                    <li key={w.title}>
                      <span aria-hidden className="ns-lamp" data-tone="ok" />
                      {w.title}
                    </li>
                  ))}
                  <li data-kind="not">
                    <X className="size-4 shrink-0" aria-hidden />
                    <span>
                      <span className="sr-only">{s.notLabel}: </span>
                      {page.not[0]}
                    </span>
                  </li>
                </ul>
              </li>
            ) : null,
          )}
        </ul>
      </section>

      <section aria-labelledby="same-title" className="st-section">
        <div className="st-wrap">
          <Slug>{rules.slug}</Slug>
          <h2 id="same-title" className="st-h2 mt-8">
            {rules.title}
          </h2>
          <ul className="st-rules">
            {rules.items.map((item) => (
              <li key={item.id} className="st-rule">
                <StatusLamp tone={item.id === "approval" ? "run" : "ok"} label={item.state} />
                <h3 className="st-h3">{item.title}</h3>
                <p className="st-body">{item.body}</p>
              </li>
            ))}
          </ul>
          <div className="st-hero-actions mt-12">
            <Link href="/signup" className="st-key">
              {s.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="st-link">
              {s.secondary}
            </Link>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}
