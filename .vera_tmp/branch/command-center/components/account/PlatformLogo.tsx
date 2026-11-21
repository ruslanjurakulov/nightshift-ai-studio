"use client";

import { useState } from "react";
import type { ConnectedAccount, Platform } from "@/lib/account";

/**
 * The publishing platforms' marks, drawn inline (one path each, no image file,
 * no request) for the account lists. Decorative: every row's text names the
 * platform, so the drawings are aria-hidden.
 *
 * YouTube and TikTok are the simple-icons outlines; Instagram is drawn as its
 * rounded camera outline (stroke), so it stays a few lines of geometry. The ink
 * is each platform's own colour at a size where it clears 3:1 against the tile
 * in both themes (TikTok's is the text colour, which is black or white by theme).
 */
const INK: Record<Platform, string> = {
  youtube: "#ff0000",
  instagram: "#e4405f",
  tiktok: "var(--color-fg)",
};

const YOUTUBE_PATH =
  "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z";
const TIKTOK_PATH =
  "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z";
// A rounded square, a lens and a dot, as one path stroked at 2 (the camera outline).
const INSTAGRAM_PATH = "M8 2.5h8A5.5 5.5 0 0 1 21.5 8v8a5.5 5.5 0 0 1-5.5 5.5H8A5.5 5.5 0 0 1 2.5 16V8A5.5 5.5 0 0 1 8 2.5zM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM17.5 6.5h.01";

export function PlatformLogo({ platform, className = "size-[18px]" }: { platform: Platform; className?: string }) {
  const stroke = platform === "instagram";
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-platform={platform}
      className={className}
      style={{ color: INK[platform] }}
      fill={stroke ? "none" : "currentColor"}
      stroke={stroke ? "currentColor" : undefined}
      strokeWidth={stroke ? 2 : undefined}
      strokeLinecap={stroke ? "round" : undefined}
      strokeLinejoin={stroke ? "round" : undefined}
    >
      <path d={platform === "youtube" ? YOUTUBE_PATH : platform === "tiktok" ? TIKTOK_PATH : INSTAGRAM_PATH} />
    </svg>
  );
}

/** The platform's mark in a rounded tile: what a row shows before anything is connected. */
export function PlatformTile({ platform }: { platform: Platform }) {
  return (
    <span
      aria-hidden
      data-platform-tile={platform}
      className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-panel-2)]"
    >
      <PlatformLogo platform={platform} />
    </span>
  );
}

/**
 * A connected account's own picture, round, with the platform's mark on its
 * corner. Only an https avatar is ever given (lib/connectedAccounts safeAvatar);
 * with none, or when the image does not load, the platform's tile stands in.
 * The name is in the row's text, so the picture is decorative.
 */
export function AccountTile({ account }: { account: Pick<ConnectedAccount, "platform" | "avatarUrl"> }) {
  // Keyed by URL: a new address gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  const url = account.avatarUrl;
  if (!url || failed === url) return <PlatformTile platform={account.platform} />;
  return (
    <span aria-hidden data-account-avatar="" className="relative inline-flex size-9 shrink-0">
      {/* A public avatar from the platform; not proxied through next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        aria-hidden="true"
        width={36}
        height={36}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(url)}
        className="size-9 rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] object-cover"
      />
      <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel)]">
        <PlatformLogo platform={account.platform} className="size-2.5" />
      </span>
    </span>
  );
}
