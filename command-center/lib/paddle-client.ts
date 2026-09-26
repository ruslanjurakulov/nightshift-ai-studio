/**
 * Paddle.js in the browser, shared by everything that talks to it: the Buy
 * credits panel (checkout) and the public Pricing page (price preview only).
 *
 * Paddle.Initialize may run once per page load, so whichever component gets
 * there first initializes it and later ones re-point the event callback. That
 * state has to live in one module: two private copies would each believe they
 * were first, and the second Initialize is what Paddle refuses.
 *
 * Browser-only — call these from effects and event handlers, never on render.
 */

import { PADDLE_JS_URL, previewTotals, type PaddleEnvironment, type PricePreviewResponse } from "@/lib/paddle";

export interface PaddleEventData {
  name?: string;
}

export interface PaddleJs {
  Environment: { set(env: PaddleEnvironment): void };
  Initialize(opts: { token: string; eventCallback?: (e: PaddleEventData) => void }): void;
  Update(opts: { eventCallback?: (e: PaddleEventData) => void }): void;
  Checkout: {
    open(opts: {
      items: { priceId: string; quantity: number }[];
      customData?: Record<string, string>;
      customer?: { email: string };
      settings?: {
        displayMode?: "overlay";
        theme?: "light" | "dark";
        locale?: string;
        allowLogout?: boolean;
        variant?: "one-page" | "multi-page";
      };
    }): void;
  };
  PricePreview?(req: { items: { priceId: string; quantity: number }[] }): Promise<PricePreviewResponse>;
}

declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

let initialized = false;
let scriptPromise: Promise<PaddleJs> | null = null;

export function loadPaddle(): Promise<PaddleJs> {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<PaddleJs>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PADDLE_JS_URL;
    s.async = true;
    s.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error("Paddle.js did not load")));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Paddle.js did not load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Paddle.js, loaded and initialized for this deployment. With `onEvent`, that
 * callback receives checkout events from now on; without one (the Pricing
 * page, which opens no checkout) any callback already set is left alone.
 */
export async function ensurePaddle(
  config: { environment: PaddleEnvironment; clientToken: string },
  onEvent?: (e: PaddleEventData) => void,
): Promise<PaddleJs> {
  const paddle = await loadPaddle();
  if (!initialized) {
    if (config.environment === "sandbox") paddle.Environment.set("sandbox");
    paddle.Initialize({ token: config.clientToken, eventCallback: onEvent });
    initialized = true;
  } else if (onEvent) {
    paddle.Update({ eventCallback: onEvent });
  }
  return paddle;
}

/** Paddle's localized total per price id — for the visitor's country and currency. */
export async function previewPrices(paddle: PaddleJs, priceIds: string[]): Promise<Record<string, string>> {
  if (!paddle.PricePreview || priceIds.length === 0) return {};
  return previewTotals(await paddle.PricePreview({ items: priceIds.map((priceId) => ({ priceId, quantity: 1 })) }));
}
