import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, X } from "lucide-react";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { PublicShell } from "@/components/legal/PublicShell";
import { isSolutionId, solutionHref } from "@/lib/solutions";
import { Slug } from "@/components/site/Slug";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { HeroFx } from "@/components/site/HeroFx";
import { AudienceTabs } from "@/components/site/AudienceTabs";
import { ApiPicture, ComposerPicture, SignOffPicture } from "@/components/site/SolutionPictures";
import { MotionToggle } from "@/components/site/MotionToggle";

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

/** The product's own picture for each way in (components/site/SolutionPictures.tsx): the publish desk, the composer, the endpoint list. */
const WAY_PICTURE = { "youtube-channels": SignOffPicture, "creative-studio": ComposerPicture, developers: ApiPicture } as const;

/**
 * The Solutions index: who it is for, as three tabs (the three audiences the product serves, no others), each with its own
 * words and the product's own picture for that job, and then the three rules that hold whichever way you came in. No stills
 * here: the landing and /mcp have them, and this page shows the product itself instead of a picture that stands for it.
 */
export default async function SolutionsPage() {
  const { t } = await getDictionary();
  const s = t.site.solutions;
  const rules = t.site.rules;
  const tabs = s.pages.flatMap((page) => {
    if (!isSolutionId(page.id)) return [];
    const Picture = WAY_PICTURE[page.id];
    return [
      {
        id: page.id,
        label: page.nav,
        panel: (
          <div className="nx-aud-body">
            <div className="nx-aud-copy">
              <p className="nx-way-kicker">{page.kicker}</p>
              <h2 id={`way-${page.id}`} className="nx-way-h">
                <Link href={solutionHref(page.id)} className="nx-way-link">
                  {/* The last word and the arrow never part: a title that filled its line left the arrow alone on the next. */}
                  {page.title.split(" ").slice(0, -1).join(" ")}{" "}
                  <span className="whitespace-nowrap">
                    {page.title.split(" ").slice(-1)[0]}
                    <ArrowRight aria-hidden />
                  </span>
                </Link>
              </h2>
              <p className="nx-way-lead">{page.lead}</p>
              <ul className="nx-way-list" aria-label={s.whatLabel}>
                {page.what.slice(0, 3).map((w) => (
                  <li key={w.title}>
                    <Check aria-hidden />
                    {w.title}
                  </li>
                ))}
                <li data-kind="not">
                  <X aria-hidden />
                  <span>
                    <span className="sr-only">{s.notLabel}: </span>
                    {page.not[0]}
                  </span>
                </li>
              </ul>
            </div>
            <div className="nx-aud-stage">
              <Picture t={t} />
            </div>
          </div>
        ),
      },
    ];
  });
  return (
    <PublicShell t={t} current="solutions" fresh>
      <div className="nx-lit">
        <HeroFx />
        <section aria-labelledby="solutions-title" className="st-wrap nx-sol-hero">
          <Slug>{s.slug}</Slug>
          <h1 id="solutions-title" className="st-h1-page mt-6">
            {s.title}
          </h1>
          <p className="st-lead mt-6">{s.lead}</p>
          <MotionToggle pause={t.site.fx.pause} />
        </section>
        <section aria-label={s.slug} className="st-wrap nx-sol-ways">
          <AudienceTabs label={s.slug} tabs={tabs} />
        </section>
      </div>

      <section aria-labelledby="same-title" className="st-section" data-tone="raised">
        <div className="st-wrap">
          <h2 id="same-title" className="st-h2">
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
