// @vitest-environment jsdom
/**
 * Space pressed the moment the timeline appears must play. The page's keyboard listener used to be attached in a passive
 * effect, which React runs in a task after the commit: a key pressed in between went to no listener and was lost (the
 * "Space plays on the page" flake). It is attached during the commit now.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FILM, S1, S2, filmJson, sceneJson } from "./films-fixtures";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => p }));
vi.mock("@/lib/credits-live", () => ({ refreshCredits: vi.fn() }));
vi.mock("@/components/studio-canvas/StudioCanvas", () => ({ BAR_SLOT_ID: "studio-bar-slot", ProjectBar: () => null }));

const { StudioTimeline } = await import("../components/studio-timeline/StudioTimeline");

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

it("Space pressed before the mount effects ran still plays", async () => {
  const film = filmJson({}, [sceneJson(S1, 0, { title: "Stadium" }), sceneJson(S2, 1, { title: "Light" })]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.startsWith("/api/films/") ? { film } : { error: "not_found" }), { status: url.startsWith("/api/films/") ? 200 : 404 })));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  host = document.createElement("div");
  document.body.append(host);
  let pressed = false;
  const seen = new MutationObserver(() => {
    if (pressed || !host?.querySelector('[data-testid="lanes"]')) return;
    pressed = true;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
  });
  seen.observe(host, { childList: true, subtree: true });
  root = createRoot(host);
  root.render(<StudioTimeline filmStudio filmId={FILM} />);
  await vi.waitFor(() => expect(pressed).toBe(true));
  seen.disconnect();
  await vi.waitFor(() => expect(host?.querySelector('[data-testid="play"]')?.getAttribute("aria-pressed")).toBe("true"));
});
