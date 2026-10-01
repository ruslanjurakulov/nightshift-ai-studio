"use client";

import { Gem, Zap } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

/**
 * A model's speed and quality, as the registry marks them (1–5). A mark the
 * registry does not give is not drawn: no mark is better than a guessed one.
 */
export function TierMarks({ speed, quality }: { speed: number | null; quality: number | null }) {
  const { t, fmt } = useI18n();
  if (speed === null && quality === null) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {speed !== null && <Meter icon="speed" value={speed} label={fmt(t.gen.speedMark, { n: speed })} />}
      {quality !== null && <Meter icon="quality" value={quality} label={fmt(t.gen.qualityMark, { n: quality })} />}
    </span>
  );
}

function Meter({ icon, value, label }: { icon: "speed" | "quality"; value: number; label: string }) {
  const Icon = icon === "speed" ? Zap : Gem;
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex items-center gap-1 text-[var(--color-muted)]">
      <Icon aria-hidden className="size-3" strokeWidth={2} />
      <span aria-hidden className="inline-flex items-center gap-[2px]">
        {[1, 2, 3, 4, 5].map((n) => (
          <span
            key={n}
            className={`h-2 w-[5px] rounded-[1.5px] ${n <= value ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
          />
        ))}
      </span>
    </span>
  );
}
