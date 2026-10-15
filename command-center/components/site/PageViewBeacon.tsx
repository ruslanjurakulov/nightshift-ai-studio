"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/core";
import { PAGE_VIEW_ENDPOINT, deviceClass, optedOutInBrowser, referrerHost, type PageViewBeacon as Beacon } from "@/lib/page-views";

// Module state, not storage: it lives as long as this tab's JavaScript and is gone on reload. The referrer belongs to the
// first page of a visit only; a click from one of our pages to another has no outside referrer.
let firstView = true;
let lastPath: string | null = null;

/**
 * Counts a view of a public page: path, referring host, device class, language,
 * sent once the page has loaded, with credentials omitted. It reads and writes no
 * cookie and no storage, sends nothing that identifies the visitor, and sends
 * nothing at all when the browser signals Do-Not-Track or Global Privacy Control.
 * The route and the database refuse any path that is not a public marketing page
 * (app/api/pv, migration 0104), so this does not need to know which those are.
 */
export function PageViewBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || pathname === lastPath) return;
    lastPath = pathname;
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (optedOutInBrowser(nav, window as unknown as { doNotTrack?: string | null })) return;
    const beacon: Beacon = {
      path: pathname,
      ref: firstView ? referrerHost(document.referrer, window.location.host) : "",
      device: deviceClass(window.innerWidth),
      lang: isLocale(document.documentElement.lang) ? document.documentElement.lang : DEFAULT_LOCALE,
    };
    firstView = false;
    const send = () => {
      fetch(PAGE_VIEW_ENDPOINT, {
        method: "POST",
        body: JSON.stringify(beacon),
        headers: { "content-type": "application/json" },
        credentials: "omit",
        keepalive: true,
      }).catch(() => {});
    };
    if (document.readyState === "complete") send();
    else window.addEventListener("load", send, { once: true });
  }, [pathname]);
  return null;
}
