// @vitest-environment jsdom
/** The worker ages are as of the server's clock: the panel says so, and asks the server again every minute while visible. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { coerceWorkers } from "../lib/workers";

const h = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
import { WorkerStatusPanel } from "../components/workers/WorkerStatusPanel";

const SERVER_NOW = Date.UTC(2026, 9, 17, 8, 53, 0);
const rows = coerceWorkers([{ worker_id: "w1", kind: "media", state: "running", detail: null, version: null, started_at: new Date(SERVER_NOW - 3600_000).toISOString(), updated_at: new Date(SERVER_NOW - 7000).toISOString() }]);

beforeEach(() => {
  h.refresh.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkerStatusPanel", () => {
  it("says 'as of' the server's time in the owner's clock (Tashkent, 24 h)", () => {
    render(<WorkerStatusPanel read="ok" rows={rows} nowMs={SERVER_NOW} />);
    expect(screen.getByText("as of 13:53")).toBeTruthy();
  });
  it("refreshes from the server every minute while the tab is visible, and not while hidden", () => {
    render(<WorkerStatusPanel read="ok" rows={rows} nowMs={SERVER_NOW} />);
    vi.advanceTimersByTime(59_000);
    expect(h.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    vi.advanceTimersByTime(120_000);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  it("refreshes the moment the tab becomes visible again (a phone back from the background)", () => {
    render(<WorkerStatusPanel read="ok" rows={rows} nowMs={SERVER_NOW} />);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
  it("stops asking when it unmounts", () => {
    const { unmount } = render(<WorkerStatusPanel read="ok" rows={rows} nowMs={SERVER_NOW} />);
    unmount();
    vi.advanceTimersByTime(300_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
