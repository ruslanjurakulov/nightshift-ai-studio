"use client";

import { useEffect, useRef, useState } from "react";
import { Share, SquarePlus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { INSTALL_HINT_DELAY_MS, INSTALL_HINT_KEY, isIosSafari, isStandalone } from "@/lib/install-hint";

/** Chromium's install prompt event; not in lib.dom. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Route = "android" | "ios";

function seen(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_HINT_KEY) !== null;
  } catch {
    // Storage blocked (a private window): the tip then shows at most once per page load, because this component
    // lives in the app layout and is not remounted by in-app navigation.
    return false;
  }
}

function remember() {
  try {
    window.localStorage.setItem(INSTALL_HINT_KEY, "1");
  } catch {
    /* a convenience, not a record */
  }
}

/**
 * A short, dismissible "Add Nightshift to your home screen" card for a signed-in phone or tablet.
 *
 * It is mounted by the signed-in layout only, so no public page carries it, and it renders nothing until it has
 * decided, a few seconds after load (lib/install-hint.ts): never on a desktop (no touch pointer), never inside the
 * installed app, never twice on one device. It is a card in the corner, not a dialog: nothing behind it is inert, focus
 * is not moved to it, and its two buttons are 44 px tall. On Android it appears only if the browser fired
 * `beforeinstallprompt`; its Add button is what calls the browser's own prompt.
 */
export function InstallHint() {
  const { t } = useI18n();
  const [route, setRoute] = useState<Route | null>(null);
  const prompt = useRef<InstallPromptEvent | null>(null);

  useEffect(() => {
    const standalone = isStandalone(
      window.matchMedia("(display-mode: standalone)").matches,
      (navigator as Navigator & { standalone?: boolean }).standalone,
    );
    // A touch screen is the phone and the tablet; a mouse-and-keyboard desktop has the browser's own install button.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (standalone || !touch || seen()) return;

    let timer = 0;
    const show = (next: Route) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Once per device: marked when shown, not when pressed, so ignoring it once is also an answer.
        remember();
        setRoute(next);
      }, INSTALL_HINT_DELAY_MS);
    };

    const onPrompt = (e: Event) => {
      // Hold the event for our button, and keep the browser's own mini-bar away: one offer, not two.
      e.preventDefault();
      prompt.current = e as InstallPromptEvent;
      show("android");
    };
    const onInstalled = () => {
      window.clearTimeout(timer);
      remember();
      setRoute(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (isIosSafari(navigator.userAgent, navigator.maxTouchPoints)) show("ios");
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!route) return null;
  const h = t.installHint;

  async function add() {
    const event = prompt.current;
    prompt.current = null;
    setRoute(null);
    if (!event) return;
    try {
      await event.prompt();
      await event.userChoice;
    } catch {
      /* the browser refused to prompt twice; the tip is already gone and will not return */
    }
  }

  return (
    <section className="install-hint" data-install-hint={route} aria-labelledby="install-hint-title">
      <div className="install-hint-body">
        <span className="install-hint-icon" aria-hidden>
          {route === "ios" ? <Share className="size-5" /> : <SquarePlus className="size-5" />}
        </span>
        <div className="min-w-0">
          <p id="install-hint-title" className="install-hint-title">{h.title}</p>
          <p className="install-hint-text">{route === "ios" ? h.ios : h.android}</p>
        </div>
      </div>
      <div className="install-hint-actions">
        {route === "android" && (
          <button type="button" className="btn-primary" onClick={add}>
            {h.add}
          </button>
        )}
        <button type="button" className="btn-quiet" onClick={() => setRoute(null)}>
          {route === "ios" ? h.gotIt : h.notNow}
        </button>
      </div>
    </section>
  );
}
