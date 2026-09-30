"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { qualityGate, type GateKey } from "@/lib/autonomy";
import type { SystemEventRow } from "@/lib/types";

const LABEL: Record<GateKey, keyof Dictionary["auto"]> = {
  script: "gScript",
  voice: "gVoice",
  media: "gMedia",
  thumbnail: "gThumbnail",
  render: "gRender",
  upload: "gUpload",
};

/**
 * Read-only content quality gate for one video. It reports which stages really
 * completed; it does not block publishing — the publish path is untouched.
 */
export function QualityGate({ events }: { events: SystemEventRow[] }) {
  const { t } = useI18n();
  const gate = qualityGate(events);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          {gate.failures > 0 ? fmt(t.auto.gFailures, { n: gate.failures }) : ""}
        </span>
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.22em]"
          style={{ color: gate.ready ? "var(--color-ok)" : "var(--color-muted)" }}
        >
          {gate.ready ? t.auto.gReady : t.auto.gNotReady}
        </span>
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {gate.items.map((item) => {
          const color = item.ok ? "var(--color-ok)" : "var(--color-idle)";
          return (
            <li
              key={item.key}
              className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1.5"
            >
              <span
                aria-hidden
                className="grid size-3.5 shrink-0 place-items-center rounded-full text-[8px] font-bold"
                style={{ border: `1.5px solid ${color}`, color: item.ok ? color : "var(--color-muted)" }}
              >
                {item.ok ? "✓" : ""}
              </span>
              <span className="truncate text-[12px]" style={{ color: item.ok ? "var(--color-fg)" : "var(--color-muted)" }}>
                {String(t.auto[LABEL[item.key]])}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mono mt-3 text-[9px] text-[var(--color-muted)]">{t.auto.gNote}</p>
    </div>
  );
}
