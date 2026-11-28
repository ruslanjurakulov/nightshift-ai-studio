// @vitest-environment jsdom
/**
 * The Studio canvas in a browser (components/studio-canvas).
 *
 * What would break without these: a first visit with nothing to start from; a wire that is only a drawing
 * (the Image → Video form not getting the wired picture); a node that hides a missing input until a quote
 * fails; a failed job shown without its reason or a way to retry; a job that could not be read shown as
 * done; a tool with nothing on sale drawn as ready, or given a form that can only end in "no model"; the
 * layout lost on reload, or the canvas breaking when storage is blocked; ⌘K opening the app's palette over
 * the canvas; and the phone getting a board it cannot use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/studio",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, scroll: _s, ...rest }: { href: string; children: ReactNode; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/credits-live", () => ({ refreshCredits: vi.fn() }));
// The composer is today's GeneratePanel; here a stub records what the canvas hands it (it has its own tests).
const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], generateClicks: 0 }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    const initial = p.initial as { capability?: string; sourceId?: string | null } | null;
    return (
      <div data-testid="generate-panel" data-cap={initial?.capability ?? ""} data-source={initial?.sourceId ?? ""} data-desk={String(p.desk ?? "")}>
        <button type="button" onClick={() => (p.onCreated as (j: { id: string }) => void)({ id: JOB_NEW })}>
          press
        </button>
        {/* Where the real form's Generate sits: a test can see that it was focused, and that nothing pressed it. */}
        <button type="button" className="ns-price-button" onClick={() => (panel.generateClicks += 1)}>
          generate
        </button>
      </div>
    );
  },
}));

const ORG = "0a000000-0000-4000-8000-00000000000a";
const PIC = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const OUT = "4f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_DONE = "1a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_FAIL = "2a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_GONE = "5a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_NEW = "6a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_SEQ = "7a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_LOST = "8a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const LOST = "9f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const JOB_FAR = "ba2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const FAR = "bf2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
let seqReads = 0;
let libraryFails = false;

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { StudioCanvas } from "@/components/studio-canvas/StudioCanvas";
import { UNKNOWN_TOOLS, type ToolAvailability } from "@/lib/tool-availability";
import { COMPOSER_W, layoutKey } from "@/lib/studio/canvas";
import { refreshCredits } from "@/lib/credits-live";

const en = dictionaries.en;
const c = en.studioCanvas;
const KEY = layoutKey(ORG, "chronos", "u1");

const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  capability: "t2i",
  status,
  requested_model: "m1",
  params: {},
  quoted_credits: 4,
  charged_credits: null,
  error_code: null,
  result: null,
  result_asset_ids: [],
  created_at: "2026-11-14T00:00:00Z",
  ...extra,
});

// jsdom has no PointerEvent: without one, fireEvent's pointer events carry no coordinates and a drag cannot be told from a click.
if (typeof window.PointerEvent === "undefined") {
  (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {} as typeof MouseEvent;
}

// React Flow measures with ResizeObserver, DOMMatrix and offset sizes, none of which jsdom has (reactflow.dev/learn/advanced-use/testing).
class FakeResizeObserver {
  constructor(private cb: (entries: { target: Element }[], o: unknown) => void) {}
  observe(target: Element) {
    this.cb([{ target }], this);
  }
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? +scale : 1;
  }
};
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

/** A click that does not move: on a node's title bar, it opens the inspector. */
function openNode(id: string) {
  const head = document.querySelector(`[data-node-id="${id}"] .cv-nh`) as HTMLElement;
  fireEvent.click(head);
}

let narrow = false;
/** Job reads held open until the test releases them (two refreshes ending in the same tick). */
let gates: Map<string, Promise<void>> | null = null;
function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [id, gate] of gates ?? []) if (url.includes(id)) await gate;
    if (url === `/api/media/${FAR}`) {
      return new Response(JSON.stringify({ asset: { id: FAR, kind: "image" }, urls: { thumb: "https://x.test/far.jpg", display: "https://x.test/far-d.jpg" } }), { status: 200 });
    }
    if (url.startsWith("/api/media") && libraryFails) return new Response(JSON.stringify({ error: "failed" }), { status: 500 });
    if (url.startsWith("/api/media")) {
      return new Response(
        JSON.stringify({
          assets: [
            { id: PIC, kind: "image", name: "Fox", thumbUrl: "https://x.test/fox.jpg", viewUrl: null },
            { id: OUT, kind: "image", name: "Made", thumbUrl: "https://x.test/made.jpg", viewUrl: null },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes(JOB_DONE)) return new Response(JSON.stringify({ job: job(JOB_DONE, "completed", { result_asset_ids: [OUT] }) }), { status: 200 });
    if (url.includes(JOB_FAIL)) return new Response(JSON.stringify({ job: job(JOB_FAIL, "failed", { error_code: "provider_timeout" }) }), { status: 200 });
    if (url.includes(JOB_FAR)) return new Response(JSON.stringify({ job: job(JOB_FAR, "completed", { result_asset_ids: [FAR] }) }), { status: 200 });
    if (url.includes(JOB_LOST)) return new Response(JSON.stringify({ job: job(JOB_LOST, "completed", { result_asset_ids: [LOST] }) }), { status: 200 });
    if (url.includes(JOB_NEW)) return new Response(JSON.stringify({ job: job(JOB_NEW, "running") }), { status: 200 });
    if (url.includes(JOB_SEQ)) {
      seqReads += 1;
      if (seqReads === 1) return new Response(JSON.stringify({ job: job(JOB_SEQ, "running") }), { status: 200 });
      if (seqReads === 2) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ job: job(JOB_SEQ, "completed", { result_asset_ids: [OUT] }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }) as typeof fetch;
}

function mount({ tools = UNKNOWN_TOOLS, filmStudio = false, operator = false, locale = "en" }: { tools?: ToolAvailability; filmStudio?: boolean; operator?: boolean; locale?: "en" | "ru" | "uz" } = {}) {
  return render(
    <I18nProvider locale={locale}>
      <ShellProvider operator={operator} tools={tools}>
        <StudioCanvas
          data={{ orgId: ORG, models: [], unavailable: [], plans: null, dna: null, defaultStyleKitId: null, effects: [] }}
          userId="u1"
          channel="chronos"
          filmStudio={filmStudio}
        />
      </ShellProvider>
    </I18nProvider>,
  );
}

const store = (layout: unknown) => window.localStorage.setItem(KEY, JSON.stringify(layout));
const node = (id: string, kind: string, x = 0, extra: Record<string, unknown> = {}) => ({ id, kind, x, y: 0, ...extra });

beforeEach(() => {
  narrow = false;
  seqReads = 0;
  libraryFails = false;
  panel.generateClicks = 0;
  gates = null;
  window.localStorage.clear();
  panel.props = [];
  window.matchMedia = ((q: string) => ({ matches: narrow && q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  mockFetch();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });


describe.each(["en", "ru", "uz"] as const)("353 existing save warning (%s)", (locale) => {
  it("stays silent before failure, then announces localized loss risk without recovery actions or data changes", async () => {
    const originalSet = Storage.prototype.setItem;
    let blocked = false;
    const writes = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (blocked && key === KEY) throw Error("Synthetic storage write error");
      originalSet.call(this, key, value);
    });
    mount({ locale });
    await screen.findByTestId("canvas-first-run");
    await waitFor(() => expect(writes.mock.calls.some(([key]) => key === KEY)).toBe(true));
    const prior = window.localStorage.getItem(KEY);
    const status = document.querySelector('.cv-strip-warn[role="status"]')!;
    expect(status).toBeTruthy();
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    blocked = true;
    fireEvent.change(screen.getByTestId("first-run-words"), { target: { value: "353 safe synthetic working words" } });
    fireEvent.click(screen.getByTestId("tile-voice"));
    await waitFor(() => expect(status.textContent).toBe(dictionaries[locale].studioCanvas.notSaved));
    expect(document.querySelector('.cv-strip-warn[role="status"]')).toBe(status);
    expect(document.querySelectorAll("[data-node-id]")).toHaveLength(2);
    expect(document.body.textContent).toContain("353 safe synthetic working words");
    expect(window.localStorage.getItem(KEY)).toBe(prior);
    expect(screen.queryByTestId("canvas-storage-retry")).toBeNull();
    expect(screen.queryByTestId("canvas-layout-download")).toBeNull();
    expect(status.querySelector("button, a")).toBeNull();
    expect(dictionaries[locale].studioCanvas.notSaved).not.toMatch(/retry|download/i);
  });
});
