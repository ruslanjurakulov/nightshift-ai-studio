import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/server";
import { fmt } from "@/lib/i18n";
import { getUser } from "@/lib/supabase/server";
import { jsonLdScript, runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { modelPageJsonLd } from "@/lib/site/model-pages";
import { PublicShell } from "@/components/legal/PublicShell";
import { ModelDetailView } from "@/components/site/ModelPages";
import { MODEL_PAGES, SAMPLE_ITEMS, modelPageBySlug } from "@/components/site/model-catalog";

/** Only the models with a page exist; any other slug under /models/ is the 404 (the gate lets the shape through, lib/public-paths.ts). */
export const dynamicParams = false;

export function generateStaticParams() {
  return MODEL_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = modelPageBySlug(slug);
  if (!page) return {};
  const { t, locale } = await getDictionary();
  const m = t.site.modelPages.meta;
  const title = fmt(m.title, { model: page.facts.name });
  const description = fmt(m.description, { model: page.facts.name });
  const origin = runtimeSiteOrigin();
  const alt = fmt(m.ogAlt, { model: page.facts.name });
  const share = shareMetadata({ origin, path: page.path, title, description, siteName: t.brand.name, imageAlt: alt, locale });
  // The share card is the model's own lead sample (its 1280-wide still), not the site's generic card: it is what the page is about.
  const { e, f } = page.hero;
  const poster = origin && typeof f.poster === "string" && f.poster.startsWith("/") ? new URL(f.poster, origin).toString() : null;
  if (!poster) return { title: { absolute: title }, description, ...share };
  const image = { url: poster, width: e.width, height: e.height, alt, type: "image/webp" };
  return {
    title: { absolute: title },
    description,
    ...share,
    openGraph: { ...share.openGraph, images: [image] },
    twitter: { ...share.twitter, card: "summary_large_image", images: [{ url: poster, alt }] },
  };
}

/** /models/<slug>: one model's real samples and what the Studio can ask it for (components/site/ModelPages.tsx). Public to everyone. */
export default async function ModelRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = modelPageBySlug(slug);
  if (!page) notFound();
  // Who is asking decides one thing only: where "Use this prompt" goes (the Studio form signed in, sign-up first signed out).
  // When the auth server cannot answer, the page is still the same public page, so it is served as signed out rather than as
  // an error: the worst case is a signed-in visitor whose link goes to /signup, which sends a session to its home in the app
  // (the words are not carried there). Nothing here is authorization; the Studio checks the session itself.
  const [user, { t, locale }] = await Promise.all([getUser().catch(() => null), getDictionary()]);
  const m = t.site.modelPages;
  const ld = modelPageJsonLd({
    page,
    origin: runtimeSiteOrigin(),
    title: fmt(m.meta.title, { model: page.facts.name }),
    description: fmt(m.meta.description, { model: page.facts.name }),
    homeName: m.crumbs.home,
    modelsName: m.crumbs.models,
    noPrompt: t.site.gallery.noPrompt,
  });
  return (
    <PublicShell t={t} fresh>
      {ld.map((d, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(d) }} />
      ))}
      <ModelDetailView t={t} locale={locale} page={page} pages={MODEL_PAGES} all={SAMPLE_ITEMS} signedIn={Boolean(user)} />
    </PublicShell>
  );
}
