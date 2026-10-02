import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicShell } from "@/components/legal/PublicShell";
import { getDictionary } from "@/lib/i18n/server";
import { formatTimecode } from "@/components/ui/Timecode";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return { title: `${t.site.notFound.meta} · ${t.brand.name}`, description: t.site.notFound.body, robots: { index: false } };
}

/** 404, read as the monitor's frame counter: 00:00:04:04 at 25 fps. */
const NOT_FOUND_TC = formatTimecode(4 + 4 / 25, "frames", { fps: 25 });

/**
 * Any URL that matches no route: the monitor has lost its signal. The test
 * card and the frame counter (00:00:04:04 — the status code, set as timecode)
 * are the picture; the words say what to do next. "/" is the way back for
 * everyone: it sends a signed-in visitor to the dashboard they last used, and
 * shows a signed-out one the landing page.
 */
export default async function NotFound() {
  const { t } = await getDictionary();
  const n = t.site.notFound;
  return (
    <PublicShell t={t}>
      <section aria-labelledby="nf-title" className="st-wrap st-slate">
        <div>
          <p className="st-kicker flex items-center gap-3">
            <span aria-hidden className="ns-lamp" data-tone="fail" />
            {n.code} · 404
          </p>
          <h1 id="nf-title" className="st-h1-page mt-6">
            {n.title}
          </h1>
          <p className="st-lead mt-6">{n.body}</p>
          <div className="st-hero-actions">
            <Link href="/" className="st-key">
              {n.home}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="st-link">
              {n.pricing}
            </Link>
          </div>
        </div>
        <div className="st-slate-screen" aria-hidden>
          <div className="st-bars">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
          <div className="st-bars-low">
            <span />
            <span />
          </div>
          <span className="st-slate-tc st-num">{NOT_FOUND_TC}</span>
        </div>
      </section>
    </PublicShell>
  );
}
