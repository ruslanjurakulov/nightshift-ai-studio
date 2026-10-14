"use client";

import { useEffect, useRef } from "react";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { THEME_KEY } from "@/lib/theme";
import { FRAME_WIDTH_PX, parseFrameSync } from "@/lib/view-mode";
import { ViewModeToggle } from "./ViewModeToggle";
import "./view-mode.css";

/**
 * The Mobile view on a wide screen: the whole site inside one same-origin
 * iframe about 430 px wide. Tailwind's breakpoints are viewport media queries,
 * and a frame has a viewport of its own, so every `sm:`/`lg:` rule inside it
 * answers exactly as on a phone, with no change to any page.
 *
 * This document draws only the frame and the switch (the middleware asked for
 * it, app/layout.tsx), so the switch is in the same place whatever page is
 * open. The framed page tells us where it is (EmbedBridge), and the address
 * bar and tab title follow with replaceState: a reload or a pasted link opens
 * the same page in the same view, and Back moves the frame (the browser keeps
 * one history for a page and its frames).
 */
export function ViewFrame({ src }: { src: string }) {
  const { t } = usePublicI18n();
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Our own origin, and our own frame: nothing else can move the address bar.
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const sync = parseFrameSync(e.data);
      if (!sync) return;
      if (sync.href !== window.location.pathname + window.location.search + window.location.hash) {
        window.history.replaceState(window.history.state, "", sync.href);
      }
      if (sync.title) document.title = sync.title;
    }
    // The theme is chosen inside the frame; this page's ground follows it (a storage event reaches the other same-origin documents).
    function onStorage(e: StorageEvent) {
      if (e.key !== THEME_KEY) return;
      if (e.newValue === "light" || e.newValue === "dark") document.documentElement.setAttribute("data-theme", e.newValue);
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <div className="ns-view" style={{ ["--ns-frame-w" as string]: `${FRAME_WIDTH_PX}px` }}>
      <div className="ns-view-bar">
        <ViewModeToggle showLabel />
      </div>
      <main className="ns-view-stage">
        <iframe
          ref={frame}
          src={src}
          title={t.common.viewFrameTitle}
          className="ns-view-phone"
        />
      </main>
    </div>
  );
}
