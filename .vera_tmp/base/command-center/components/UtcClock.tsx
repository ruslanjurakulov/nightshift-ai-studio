"use client";

import { useEffect, useState } from "react";

/** A subtle live clock in the operator's own time — Tashkent, UTC+5. */
export function UtcClock() {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const tick = () =>
      setNow(
        new Date().toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZone: "Asia/Tashkent",
          hour12: false,
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Render nothing until mounted so server/client first paint match.
  if (!now) return null;
  return (
    <span
      className="tnum hidden items-center text-xs tabular-nums text-[var(--color-muted)] 2xl:inline-flex"
      aria-label={`${now} Tashkent`}
      title="Tashkent, UTC+5"
    >
      {now}
    </span>
  );
}
