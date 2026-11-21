"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { PlatformLogo } from "@/components/social/PlatformLogo";
import { PICK_FLAG, type ConnectPlatform, type ConnectWord } from "@/lib/connect-picker";

/**
 * The Add channel screen's way in: one button per platform. Each is a plain
 * link to the platform's start route (a redirect, so not a client navigation):
 * the person signs in on the platform's own screen and lands on the pick
 * screen. Nothing here creates anything, and a platform this server has no app
 * for says so instead of offering a button that cannot finish.
 */
export function ConnectStart({
  canYoutube,
  canSocial,
  configured,
  result,
  niche,
  language,
}: {
  /** Presentation only: the start route and the database check again. */
  canYoutube: boolean;
  canSocial: boolean;
  configured: Record<ConnectPlatform, boolean>;
  result: { platform: ConnectPlatform; word: ConnectWord } | null;
  niche?: string | null;
  language?: string | null;
}) {
  const { t } = useI18n();
  const tc = t.connectPicker;
  const name: Record<ConnectPlatform, string> = { youtube: tc.youtube, instagram: tc.instagram, tiktok: tc.tiktok };

  const href = (platform: ConnectPlatform) => {
    const q = new URLSearchParams({ [PICK_FLAG]: "1" });
    // What /welcome asked for rides along, so the new channel starts with it.
    if (platform === "youtube") {
      if (niche) q.set("niche", niche);
      if (language) q.set("language", language);
    }
    return `/api/oauth/${platform}/start?${q.toString()}`;
  };

  const rows: { platform: ConnectPlatform; label: string; hint: string; allowed: boolean }[] = [
    { platform: "youtube", label: tc.connectYoutube, hint: tc.youtubeHint, allowed: canYoutube },
    { platform: "instagram", label: tc.connectInstagram, hint: tc.instagramHint, allowed: canSocial },
    { platform: "tiktok", label: tc.connectTiktok, hint: tc.tiktokHint, allowed: canSocial },
  ];

  return (
    <section className="ns-desk g2-desk g2-connect" aria-labelledby="connect-start-title">
      <header>
        <h2 id="connect-start-title" className="g2-h2">
          {tc.title}
        </h2>
        <p className="g2-sub">{tc.subtitle}</p>
      </header>

      {result && (
        <p className="g2-warn" role="alert">
          {fmt(tc.results[result.word], { platform: name[result.platform] })}
        </p>
      )}

      <ul className="g2-connect-list">
        {rows.map((r) => (
          <li key={r.platform} className="g2-connect-row">
            <div className="g2-platform-name">
              <PlatformLogo platform={r.platform} size={20} />
              <h3 className="g2-h3">{name[r.platform]}</h3>
            </div>
            <p className="g2-note">{r.hint}</p>
            {!configured[r.platform] ? (
              <p className="g2-note">{fmt(tc.unavailableYet, { platform: name[r.platform] })}</p>
            ) : !r.allowed ? (
              <p className="g2-note">{tc.noPermission}</p>
            ) : (
              <a href={href(r.platform)} className="btn-primary g2-connect-btn">
                {r.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
