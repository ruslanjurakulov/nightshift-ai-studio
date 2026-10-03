"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";

/**
 * One picture before and after a tool, split by a handle. The handle is a
 * native range input stretched over the picture: dragging, tapping and the
 * arrow keys all work, and a screen reader hears a slider with a percentage.
 * The checkerboard shows where a background was removed.
 */
export function BeforeAfter({
  before,
  after,
  alt = "",
  bare = false,
}: {
  before: string;
  after: string;
  alt?: string;
  /** Inside a result card: the card draws the edge, so no frame or width cap of its own. */
  bare?: boolean;
}) {
  const { t } = useI18n();
  const [pos, setPos] = useState(50);

  return (
    <div
      className={`relative aspect-[4/3] w-full overflow-hidden focus-within:ring-2 focus-within:ring-inset focus-within:ring-[var(--color-primary)] ${
        bare ? "" : "max-w-md rounded-[var(--ns-r-key)] border border-[var(--color-border)]"
      }`}
      style={{
        backgroundColor: "var(--color-panel-2)",
        backgroundImage:
          "linear-gradient(45deg, var(--color-border) 25%, transparent 25%, transparent 75%, var(--color-border) 75%), linear-gradient(45deg, var(--color-border) 25%, transparent 25%, transparent 75%, var(--color-border) 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0, 8px 8px",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived same-origin links */}
      <img src={after} alt={alt} className="absolute inset-0 h-full w-full object-contain" loading="lazy" draggable={false} />
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img
        src={before}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        loading="lazy"
        draggable={false}
      />
      <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" style={{ left: `${pos}%` }}>
        <span className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[var(--ns-r-key)] bg-white text-xs text-black shadow">
          ⇆
        </span>
      </span>
      <span aria-hidden className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        {t.gen.before}
      </span>
      <span aria-hidden className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
        {t.gen.after}
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        aria-label={t.gen.compareLabel}
        aria-valuetext={`${pos}%`}
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0 focus-visible:opacity-0"
      />
    </div>
  );
}
