import type { Metadata } from "next";
import { headers } from "next/headers";
import { getDictionary } from "@/lib/i18n/server";
import { fmt, getDictionaryFor, isLocale } from "@/lib/i18n";
import { isReviewToken } from "@/lib/review-link";
import { callerKey, takeAnonRate, viewReviewLink } from "@/lib/server/review-link";

export const dynamic = "force-dynamic";

/**
 * Not a page to index, cache or leak: the address is the secret, so a crawler is
 * told no (also by robots.txt and the X-Robots-Tag in next.config.ts), no
 * Referer is sent from it, and the title says nothing about what it holds.
 */
export const metadata: Metadata = {
  title: "Preview",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

function when(iso: string, locale: string): string {
  try {
    return `${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso))} UTC`;
  } catch {
    return iso;
  }
}

/**
 * A review link's page (migration 0101): one video, view only, no sign-in.
 * Nothing on it approves, publishes, downloads or spends, and it shows nothing
 * but this one preview's title: no workspace, channel, other video or price.
 * "Gone" is one answer for a link that is unknown, malformed, expired or turned
 * off.
 */
export default async function ReviewLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // The database counts views per link; this is the guard per caller in front of it, so a loop on one address
  // cannot spend a link's allowance for everyone else.
  const slowDown = !takeAnonRate(`page:${callerKey(await headers())}`, 60);
  const view = !isReviewToken(token)
    ? ({ status: "gone" } as const)
    : slowDown
      ? ({ status: "limited" } as const)
      : await viewReviewLink(token);

  // The language the link's maker was using, when this app can show it; otherwise the visitor's own (cookie, then
  // Accept-Language, then English). Which languages exist is lib/i18n's list, so a new one needs nothing here.
  const fallback = await getDictionary();
  const made = view.status === "ok" && isLocale(view.locale) ? view.locale : null;
  const locale = made ?? fallback.locale;
  const r = (made ? getDictionaryFor(made) : fallback.t).reviewPage;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[880px] flex-col justify-center gap-5 px-4 py-8">
      {view.status === "ok" ? (
        <>
          <div className="flex flex-col gap-3">
            <span
              className="pill w-fit border px-3 py-1 text-xs font-semibold tracking-wide"
              style={{ borderColor: "var(--color-warn)", color: "var(--color-warn)" }}
            >
              {r.badge}
            </span>
            <h1 className="m-0 break-words text-[22px] font-semibold leading-tight">{view.title ?? r.untitled}</h1>
          </div>
          {/* preload=metadata + a plain src: the browser asks the stream route for ranges, as a phone does. */}
          <video
            src={`/r/${token}/video`}
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            aria-label={r.videoLabel}
            className="aspect-video w-full rounded-[18px] border border-[var(--color-border)] bg-black"
          />
          <div className="flex flex-col gap-2 text-sm text-[var(--color-muted)]">
            <p className="m-0">{r.note}</p>
            <p className="m-0">{r.viewOnly}</p>
            <p className="m-0">{fmt(r.until, { when: when(view.expiresAt, locale) })}</p>
          </div>
        </>
      ) : (
        <div className="section-card flex flex-col gap-3 text-center">
          <h1 className="m-0 text-xl font-semibold">
            {view.status === "limited" ? r.limitedTitle : view.status === "unavailable" ? r.unavailableTitle : r.goneTitle}
          </h1>
          <p className="m-0 text-sm text-[var(--color-muted)]">
            {view.status === "limited" ? r.limitedBody : view.status === "unavailable" ? r.unavailableBody : r.goneBody}
          </p>
        </div>
      )}
    </main>
  );
}
