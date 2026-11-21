"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { fmt } from "@/lib/i18n";
import { paymePriceText, type PaymeView } from "@/lib/payme";
import { Chip } from "@/components/ui/Chip";
import { assignTop } from "@/components/view-mode/frame-nav";

/**
 * Buy a credit pack through Payme (Uzcard/Humo), shown next to the primary seller's panel only when PAYMENTS_PROVIDER
 * lists `payme`, Payme is configured, it sells to this workspace and a pack has a UZS price (the page decides; this
 * component is not rendered otherwise). Pay asks our server for a checkout link and the page goes to Payme's hosted
 * checkout; card details go only to Payme. Credits arrive when Payme performs the transaction (payme-merchant Edge
 * Function); back from Payme (?payme=return) this says so and re-reads the page once, without claiming the payment
 * went through — only the balance can say that.
 */

type Phase = "idle" | "opening" | "returned" | "failed" | "too_many" | "not_on_sale";

export function PaymeBuyCredits({ view }: { view: PaymeView }) {
  const { t, locale } = useI18n();
  const p = t.payme;
  const path = useChannelPath();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const busy = useRef(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("payme") !== "return") return;
    url.searchParams.delete("payme");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    setPhase("returned");
    const timer = setTimeout(() => router.refresh(), 3000);
    return () => clearTimeout(timer);
  }, [router]);

  async function open(pack: string) {
    // One checkout at a time: a second press while one is opening is dropped, not a second order.
    if (busy.current) return;
    busy.current = true;
    setPhase("opening");
    try {
      const res = await fetch("/api/billing/payme/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pack, return_path: path("/credits"), lang: locale }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: unknown };
      if (res.ok && typeof json.url === "string" && /^https:\/\/(test|checkout)\.paycom\.uz\//.test(json.url)) {
        // The top window: Payme's checkout, like any payment page, will not load inside the view-mode frame.
        assignTop(json.url);
        return;
      }
      setPhase(res.status === 429 ? "too_many" : res.status === 404 ? "not_on_sale" : "failed");
    } catch {
      setPhase("failed");
    }
    busy.current = false;
  }

  const message: Partial<Record<Phase, { text: string; ok?: boolean }>> = {
    returned: { text: p.returned, ok: true },
    failed: { text: p.failed },
    too_many: { text: p.tooMany },
    not_on_sale: { text: p.notOnSale },
  };
  const msg = message[phase];

  return (
    <section className="panel flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="payme-title" data-provider="payme">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="payme-title" className="t-section">
            {p.title}
          </h2>
          {view.environment === "test" && (
            <Chip plain tone="warn">
              {p.testMode}
            </Chip>
          )}
        </div>
        <p className="text-sm font-light text-[var(--color-muted)]">{p.lead}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {view.packs.map((pack) => {
          const price = paymePriceText(pack.uzs, locale);
          return (
            <li key={pack.id} className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-4">
              <span className="text-base font-medium">{fmt(p.credits, { credits: pack.credits.toLocaleString(locale) })}</span>
              <button type="button" className="btn btn-primary min-h-11" disabled={phase === "opening"} onClick={() => open(pack.id)}>
                {phase === "opening" ? p.opening : fmt(p.buy, { price })}
              </button>
            </li>
          );
        })}
      </ul>
      {msg && (
        <p className="text-sm" style={{ color: msg.ok ? "var(--color-ok)" : "var(--color-fail)" }} data-buy-message={phase} aria-live="polite">
          {msg.text}
        </p>
      )}
    </section>
  );
}
