"use client";

import { useState } from "react";
import { UserRound } from "lucide-react";
import { avatarInitial, avatarSrc, type AvatarSizePx } from "@/lib/avatar";

/**
 * The person's round picture: their photo when they have one, otherwise the
 * first letter of their e-mail (or the neutral person mark when there is no
 * usable letter). One component for every place the letter is drawn today, so
 * wiring the photo in is a swap, not a redesign.
 *
 * The circle is the one AccountMenu's user card and CustomerSidebar draw: soft
 * accent ground, primary-ink letter, semibold. `ring` adds the hairline border
 * the account panel's header circle wears. (Those files still draw their own
 * circle; they swap to this in the wiring step.)
 *
 * `version` is the avatar_v number from the person's user_metadata
 * (lib/avatar.ts) or null. A photo that fails to load (the object is gone, the
 * session lapsed, the network dropped) falls back to the letter instead of a
 * broken-image box.
 *
 * It is decorative: the control around it carries the accessible name, and
 * neither the e-mail nor anything derived from it is written into alt, title or
 * aria-label. Photos are private, so this only ever shows the signed-in person
 * their own.
 */
const BOX: Record<AvatarSizePx, { box: string; text: string; icon: string }> = {
  24: { box: "size-6", text: "text-xs", icon: "size-3" },
  32: { box: "size-8", text: "text-sm", icon: "size-4" },
  40: { box: "size-10", text: "text-[15px]", icon: "size-4" },
  64: { box: "size-16", text: "text-2xl", icon: "size-6" },
  96: { box: "size-24", text: "text-4xl", icon: "size-9" },
};

export function Avatar({
  email,
  version = null,
  size = 32,
  ring = false,
  className = "",
}: {
  email: string | null | undefined;
  version?: number | null;
  size?: AvatarSizePx;
  ring?: boolean;
  className?: string;
}) {
  const src = avatarSrc(version);
  const [failed, setFailed] = useState<string | null>(null);
  const initial = avatarInitial(email);
  const dims = BOX[size] ?? BOX[32];
  const showPhoto = src !== null && failed !== src;

  return (
    <span
      aria-hidden
      data-avatar={showPhoto ? "photo" : "initial"}
      className={`relative grid ${dims.box} shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--color-accent-soft)] font-semibold text-[var(--color-primary)] ${dims.text} ${
        ring ? "border border-[var(--color-border)]" : ""
      } ${className}`}
    >
      {showPhoto ? (
        // The photo is our own private route, not a remote image: next/image would only add a proxy.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          aria-hidden
          width={size}
          height={size}
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="size-full object-cover"
        />
      ) : (
        (initial ?? <UserRound className={dims.icon} />)
      )}
    </span>
  );
}
