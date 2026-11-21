"use client";

import { useEffect, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");

/** The same text on the server and on the first browser render: the time in UTC, said so. */
export function utcStamp(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * A moment in the reader's own time zone. The server cannot know that zone,
 * so the server and the first render print the UTC stamp (identical on both
 * sides, nothing to mismatch), and once mounted the browser replaces it with
 * its local date and time. An unreadable time renders nothing.
 */
export function LocalTime({ iso, locale = "en", className }: { iso: string | null; locale?: string; className?: string }) {
  const stamp = iso ? utcStamp(iso) : null;
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    try {
      setLocal(d.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }));
    } catch {
      setLocal(null);
    }
  }, [iso, locale]);
  if (!iso || !stamp) return null;
  return (
    <time dateTime={iso} className={className}>
      {local ?? stamp}
    </time>
  );
}
