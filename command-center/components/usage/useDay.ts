"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n/context";
import { shortDate } from "@/components/credits/Equivalents";
import { formatDayTime } from "@/lib/date-format";

const subscribe = () => () => {};

/**
 * A calendar day for the viewer, safe to hydrate. The server has no idea of the
 * viewer's time zone and prints UTC; a browser in Tashkent (UTC+5) prints the
 * next day for anything after 19:00 UTC, React finds different text and throws
 * the server HTML away (error #418). So the first render, on the server and
 * during hydration, is the UTC day, and the browser's own day replaces it
 * straight after: no mismatch, and the person ends up with their local date.
 */
export function useDay(): (iso: string | null) => string {
  const { locale } = useI18n();
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return (iso) => shortDate(iso, locale, hydrated ? undefined : "UTC");
}

/** The same idea for a day with its time: UTC while hydrating, the viewer's own zone straight after. "—" when there is none. */
export function useDayTime(): (iso: string | null | undefined) => string {
  const { locale } = useI18n();
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? formatDayTime(d, locale, hydrated ? undefined : "UTC") : "—";
  };
}
