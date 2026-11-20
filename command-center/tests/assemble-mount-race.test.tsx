// @vitest-environment jsdom
/**
 * A press that lands before the panel's mount effects have run must still be answered. React runs passive effects after the
 * commit, in a later task; a person (or a test) can press the key in between. The version effect used to run on mount too, so
 * it bumped the quote sequence under the quote that press had just sent: the answer was dropped as stale, the key fell back to
 * "Get the price" and the note never came (the studio-timeline-ui flake on main, run 44791827572).
 */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { studioTimelineEn as c } from "../lib/i18n/studio-timeline/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => p }));
vi.mock("@/lib/credits-live", () => ({ refreshCredits: vi.fn() }));

const { AssemblePanel } = await import("../components/studio-timeline/AssemblePanel");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it("a press before the mount effects ran still gets its quote answered", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "failed" }), { status: 502 })));
  // Outside act, React commits in one task and runs passive effects in a later one, as in a browser.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  host = document.createElement("div");
  document.body.append(host);
  let pressedBeforeEffects = false;
  const seen = new MutationObserver(() => {
    const key = host?.querySelector<HTMLButtonElement>('[data-testid="assemble-key"]');
    if (!key || pressedBeforeEffects) return;
    pressedBeforeEffects = true;
    key.click(); // a microtask after the commit, before the passive-effect task
  });
  seen.observe(host, { childList: true, subtree: true });
  // React's scheduler yields once its 5 ms slice is spent. A fast, idle machine can finish the commit and the passive effects in
  // one slice, so the press would land after the effects and the test would pass on the buggy code. Every read of the clock
  // jumps 50 ms until the press, so the scheduler always yields between the commit and the effects.
  let fake = performance.now();
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => (pressedBeforeEffects ? realNow() : (fake += 50)));
  root = createRoot(host);
  root.render(<AssemblePanel filmId="f" orgId="o" version={3} editable status="draft" onStarted={() => undefined} />);
  await vi.waitFor(() => expect(pressedBeforeEffects).toBe(true));
  seen.disconnect();
  await vi.waitFor(() => expect(host?.querySelector('[data-testid="assemble-note"]')?.textContent).toBe(c.quoteFailed));
});

it("another project at the same version number forgets the old project's quote", async () => {
  // The version guard must not hide a change of project: the reset also runs when filmId (and so the starter) changes.
  const { render, screen, fireEvent, waitFor, cleanup } = await import("@testing-library/react");
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(JSON.stringify({ quote: { priced: true, total: 16, quote_id: `fq-3-${"b".repeat(32)}`, startable: true, may_start: true, blocked_by: [], refusals: [] } }), { status: url.includes("/quote") ? 200 : 404 })));
  const panel = (filmId: string) => <AssemblePanel filmId={filmId} orgId="o" version={3} editable status="draft" onStarted={() => undefined} />;
  const view = render(panel("film-a"));
  fireEvent.click(screen.getByTestId("assemble-key"));
  await waitFor(() => expect(screen.getByTestId("assemble-amount").textContent).toMatch(/16/));
  view.rerender(panel("film-b"));
  expect(screen.getByTestId("assemble-amount").textContent).toBe(c.getPrice);
  cleanup();
});
