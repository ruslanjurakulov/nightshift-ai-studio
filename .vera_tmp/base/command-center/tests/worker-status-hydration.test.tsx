/**
 * /integrations threw "Hydration failed" on every load: WorkerStatusPanel is a client component rendered on the server,
 * and its heartbeat age ("12s ago") read Date.now() on the server and again, a moment later, in the browser. The age is
 * now computed from the server's clock that the page already hands in (`nowMs`), so the two renders print the same text
 * however long the page took to arrive, in every language.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { coerceWorkers, type WorkerRow } from "../lib/workers";

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));
vi.mock("@/lib/i18n/context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: dictionaries[state.locale], locale: state.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries, fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: dictionaries[state.locale], locale: state.locale, fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { WorkerStatusPanel } from "../components/workers/WorkerStatusPanel";

afterEach(() => vi.useRealTimers());

const SERVER_NOW = Date.UTC(2026, 9, 17, 8, 53, 0);
const iso = (agoMs: number) => new Date(SERVER_NOW - agoMs).toISOString();
const rows: WorkerRow[] = coerceWorkers([
  { worker_id: "w1", kind: "media", state: "running", detail: null, version: "1.2.3", started_at: iso(3_600_000), updated_at: iso(7_000) },
  { worker_id: "w2", kind: "render", state: "running", detail: null, version: null, started_at: iso(7_200_000), updated_at: iso(5 * 60_000) },
]);
const html = () => renderToStaticMarkup(createElement(WorkerStatusPanel, { read: "ok", rows, nowMs: SERVER_NOW }));

describe.each(["en", "ru", "uz"] as const)("WorkerStatusPanel markup (%s)", (locale) => {
  it("is identical when the browser renders it seconds, minutes or hours after the server did", () => {
    state.locale = locale;
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_NOW);
    const server = html();
    vi.setSystemTime(SERVER_NOW + 3_000);
    const clientSoon = html();
    vi.setSystemTime(SERVER_NOW + 9 * 3_600_000);
    const clientLater = html();
    expect(clientSoon).toBe(server);
    expect(clientLater).toBe(server);
  });

  it("the age shown is the server's, not the wall clock's", () => {
    state.locale = locale;
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_NOW + 3 * 3_600_000);
    // The fresh worker was heard 7 seconds before the SERVER rendered; three hours of wall clock change nothing.
    expect(html()).toMatch(/7/);
    expect(html()).not.toMatch(/\b3\s?(h|ч|soat)/);
    expect(html()).toContain("w1");
  });
});
