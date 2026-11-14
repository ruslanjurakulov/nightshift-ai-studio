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
const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    const initial = p.initial as { capability?: string; sourceId?: string | null } | null;
    return (
      <div data-testid="generate-panel" data-cap={initial?.capability ?? ""} data-source={initial?.sourceId ?? ""} data-desk={String(p.desk ?? "")}>
        <button type="button" onClick={() => (p.onCreated as (j: { id: string }) => void)({ id: JOB_NEW })}>
          press
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
let seqReads = 0;

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { StudioCanvas } from "@/components/studio-canvas/StudioCanvas";
import { UNKNOWN_TOOLS, type ToolAvailability } from "@/lib/tool-availability";
import { layoutKey } from "@/lib/studio/canvas";
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
function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
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

function mount({ tools = UNKNOWN_TOOLS, filmStudio = false, operator = false }: { tools?: ToolAvailability; filmStudio?: boolean; operator?: boolean } = {}) {
  return render(
    <I18nProvider locale="en">
      <ShellProvider operator={operator} tools={tools}>
        <StudioCanvas
          data={{ orgId: ORG, models: [], unavailable: [], plans: null, dna: null, defaultStyleKitId: null }}
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
  window.localStorage.clear();
  panel.props = [];
  window.matchMedia = ((q: string) => ({ matches: narrow && q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  mockFetch();
});
afterEach(cleanup);

describe("first run", () => {
  it("offers three starter recipes and a blank canvas, and lists Projects only while its switch is on", async () => {
    mount();
    const first = await screen.findByTestId("canvas-first-run");
    for (const r of ["photoClip", "promptVideo", "promptVoice", "blank"]) expect(within(first).getByTestId(`recipe-${r}`)).toBeTruthy();
    expect(within(first).queryByTestId("recipe-projects")).toBeNull();
    expect(screen.getByTestId("canvas-status").textContent).toContain(c.statusEmpty);
    cleanup();
    mount({ filmStudio: true });
    expect((await screen.findByTestId("recipe-projects")).getAttribute("href")).toBe("/chronos/create/projects");
  });

  it("'Prompt → image → video' lays out Prompt → Image → Image → Video, and starts nothing", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("recipe-promptVideo"));
    const nodes = document.querySelectorAll("[data-node-id]");
    expect([...nodes].map((n) => n.getAttribute("data-kind"))).toEqual(["prompt", "image", "animate"]);
    expect(document.querySelectorAll("[data-wire]")).toHaveLength(2);
    // Nothing was asked of the jobs API: a recipe is a layout.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).startsWith("/api/creative"))).toBe(false);
  });

  it("'Photo → animated clip' shows the clip's missing picture on the node and opens the Library", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("recipe-photoClip"));
    const clip = document.querySelector('[data-kind="animate"]')!;
    expect(clip.getAttribute("data-status")).toBe("needs");
    expect(clip.textContent).toContain("Needs Picture");
    expect(await screen.findByTestId("canvas-library")).toBeTruthy();
  });
});

describe("wires are real inputs", () => {
  it("a finished Image's picture becomes the Image → Video form's source; without a wire the form has none", async () => {
    store({ nodes: [node("img", "image", 0, { jobId: JOB_DONE }), node("clip", "animate", 400)], wires: [{ id: "w1", from: "img", to: "clip" }] });
    mount();
    await waitFor(() => expect(document.querySelector('[data-node-id="img"]')!.getAttribute("data-status")).toBe("done"));
    openNode("clip");
    const form = await screen.findByTestId("generate-panel");
    expect(form.getAttribute("data-cap")).toBe("i2v");
    expect(form.getAttribute("data-source")).toBe(OUT);
    expect(form.getAttribute("data-desk")).toBe("video");
    // Disconnect: the inspector says the input is missing, before any quote.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(c.inspector.disconnect) }));
    expect((await screen.findByTestId("inspector-needs")).textContent).toContain("Needs Picture");
  });

  it("the phone's inspector wires from the canvas (it has no wires to drag), refusing nothing it lists", async () => {
    narrow = true;
    store({ nodes: [node("pic", "asset", -400, { assetId: PIC, assetKind: "image" }), node("clip", "animate", 0), node("voice", "voice", 0)], wires: [] });
    mount();
    fireEvent.click(await screen.findByTestId("flow-node-animate"));
    const pick = await screen.findByTestId("inspector-wire");
    // A voice-over cannot feed a clip: only the picture is offered.
    expect([...pick.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["—", "Fox"]);
    fireEvent.change(pick, { target: { value: "pic" } });
    await waitFor(() => expect(screen.getByTestId("flow-node-animate").getAttribute("data-status")).toBe("idle"));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).wires).toHaveLength(1));
  });

  it("on a desktop the inspector does not repeat the wire as a select: the wire on the board is the input", async () => {
    store({ nodes: [node("pic", "asset", -400, { assetId: PIC, assetKind: "image" }), node("clip", "animate", 0)], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    openNode("clip");
    expect(await screen.findByTestId("canvas-inspector")).toBeTruthy();
    expect(screen.queryByTestId("inspector-wire")).toBeNull();
  });
});

describe("results land on the node, from the job the database reports", () => {
  it("a failed job names its reason and offers a retry that is priced again; an unreadable job is 'unknown', never done", async () => {
    store({ nodes: [node("a", "image", 0, { jobId: JOB_FAIL }), node("b", "image", 400, { jobId: JOB_GONE })], wires: [] });
    mount();
    await waitFor(() => expect(document.querySelector('[data-node-id="a"]')!.getAttribute("data-status")).toBe("failed"));
    expect(document.querySelector('[data-node-id="b"]')!.getAttribute("data-status")).toBe("unknown");
    expect(document.querySelector('[data-node-id="b"]')!.textContent).toContain(c.node.unknown);
    expect(screen.getByTestId("canvas-status").textContent).toContain("1 failed");
    expect(screen.getByTestId("canvas-status").textContent).toContain("1 status unknown");
    // The node says why on its own face, and its Retry chip opens the form.
    expect(document.querySelector('[data-node-id="a"] .cv-nfail-why')!.textContent!.length).toBeGreaterThan(3);
    fireEvent.click(screen.getByTestId("retry-a"));
    expect((await screen.findByTestId("inspector-failure")).textContent!.length).toBeGreaterThan(3);
    const before = panel.props.length;
    fireEvent.click(screen.getByTestId("inspector-retry"));
    // A fresh form from that job: the composer prices it again before anything starts.
    await waitFor(() => expect(panel.props.length).toBeGreaterThan(before));
  });

  it("a press in the composer attaches the job it created to the node, and its state is read back", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    openNode("a");
    fireEvent.click(await screen.findByRole("button", { name: "press" }));
    await waitFor(() => expect(document.querySelector('[data-node-id="a"]')!.getAttribute("data-status")).toBe("working"));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).nodes[0].jobId).toBe(JOB_NEW));
  });
});

describe("honest states", () => {
  it("a tool with nothing on sale is 'Not available yet' on its node, and its inspector has no form", async () => {
    store({ nodes: [node("v", "video")], wires: [] });
    mount({ tools: { state: "known", sold: ["t2i"] } });
    const v = await waitFor(() => {
      const el = document.querySelector('[data-node-id="v"]');
      if (!el) throw new Error("not yet");
      return el as HTMLElement;
    });
    expect(v.getAttribute("data-status")).toBe("closed");
    expect(v.textContent).toContain(c.node.notAvailable);
    openNode("v");
    expect(await screen.findByTestId("inspector-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("generate-panel")).toBeNull();
  });

  it("works with storage blocked: the canvas opens and says it cannot remember the layout", async () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      mount();
      fireEvent.click(await screen.findByTestId("recipe-promptVoice"));
      expect(document.querySelectorAll("[data-node-id]")).toHaveLength(2);
      expect(await screen.findByText(c.notSaved)).toBeTruthy();
    } finally {
      Object.defineProperty(window, "localStorage", real);
    }
  });

  it("the dock's Quote key opens the selected node's form, and does nothing to price on its own", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    const quote = await screen.findByTestId("dock-quote");
    expect(quote.hasAttribute("disabled")).toBe(true);
    openNode("a");
    fireEvent.click(screen.getByRole("button", { name: c.inspector.close }));
    expect(screen.queryByTestId("generate-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("dock-quote"));
    expect(await screen.findByTestId("generate-panel")).toBeTruthy();
  });
});

describe("the board's hand", () => {
  it("a click opens the inspector; arrow keys move the selected node, and ⌘Z puts it back", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    openNode("a");
    expect(await screen.findByTestId("canvas-inspector")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: c.inspector.close }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).nodes[0].x).toBe(16));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).nodes[0].x).toBe(0));
  });

  it("Escape returns focus to the opened card", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    const card = document.querySelector('[data-node-id="a"]') as HTMLElement;
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    await screen.findByTestId("canvas-inspector");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => expect(screen.queryByTestId("canvas-inspector")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-node-id="a"]')));
  });

  it("Enter on a focused card opens it, as a click does (the keyboard's way in)", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    const card = document.querySelector('[data-node-id="a"]') as HTMLElement;
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(await screen.findByTestId("canvas-inspector")).toBeTruthy();
  });

  it("a wire can be selected and deleted with Delete, and ⌘Z puts it back", async () => {
    store({ nodes: [node("img", "image"), node("clip", "animate", 400)], wires: [{ id: "w1", from: "img", to: "clip" }] });
    mount();
    await screen.findByTestId("canvas-board");
    const hit = await waitFor(() => {
      const el = document.querySelector('[data-wire-hit="w1"]');
      if (!el) throw new Error("no wire yet");
      return el;
    });
    fireEvent.click(hit);
    await waitFor(() => expect(document.querySelector('[data-wire="img->clip"]')!.getAttribute("class")).toContain("is-sel"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(document.querySelectorAll("[data-wire]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-node-id]")).toHaveLength(2);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelectorAll("[data-wire]")).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }));
    });
    expect(document.querySelectorAll("[data-wire]")).toHaveLength(0);
  });

  it("a selected node's wires are lit; the rest are not", async () => {
    store({
      nodes: [node("p", "prompt", -400, { draft: "a fox" }), node("img", "image"), node("v", "voice", 400)],
      wires: [{ id: "w1", from: "p", to: "img" }],
    });
    mount();
    await screen.findByTestId("canvas-board");
    openNode("img");
    await waitFor(() => expect(document.querySelector('[data-wire="p->img"]')!.getAttribute("class")).toContain("is-hl"));
  });
});

describe("quick add: \"+\" by a card's output", () => {
  it("lists only the next steps that take this output, and a step with nothing on sale is there but disabled", async () => {
    store({ nodes: [node("img", "image")], wires: [] });
    mount({ tools: { state: "known", sold: ["t2i"] } });
    await screen.findByTestId("canvas-board");
    fireEvent.click(screen.getByTestId("plus-img"));
    const menu = await screen.findByTestId("quick-menu");
    // An Image puts out a picture: words-in tools (Image, Video, Voice) are not offered at all.
    for (const k of ["image", "video", "voice", "prompt"]) expect(within(menu).queryByTestId(`quick-${k}`)).toBeNull();
    // Image → Video takes a picture but nothing sells it here: listed with its reason, and refused.
    const clip = within(menu).getByTestId("quick-animate");
    expect(clip.getAttribute("aria-disabled")).toBe("true");
    expect(clip.textContent).toContain(c.palette.closedWhy);
    fireEvent.click(clip);
    expect(document.querySelectorAll("[data-node-id]")).toHaveLength(1);
  });

  it("picking a step makes a new card wired from this one, carrying the Studio's own composer (no price of its own)", async () => {
    store({ nodes: [node("img", "image")], wires: [] });
    mount({ tools: { state: "known", sold: ["t2i", "i2v"] } });
    await screen.findByTestId("canvas-board");
    fireEvent.click(screen.getByTestId("plus-img"));
    fireEvent.click(within(await screen.findByTestId("quick-menu")).getByTestId("quick-animate"));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).nodes).toHaveLength(2));
    const saved = JSON.parse(window.localStorage.getItem(KEY)!);
    const added = saved.nodes.find((n: { id: string }) => n.id !== "img");
    expect(added.kind).toBe("animate");
    expect(saved.wires).toEqual([expect.objectContaining({ from: "img", to: added.id })]);
    // The card's composer is the Studio's composer (its quote, hold and create), locked to this card's tool.
    const composer = await screen.findByTestId(`inline-composer-${added.id}`);
    const props = panel.props[panel.props.length - 1];
    expect(props.layout).toBe("composer");
    expect(props.only).toEqual(["i2v"]);
    // The card itself prints no price: only the server's quote, inside the composer, ever does.
    const card = document.querySelector(`[data-node-id="${added.id}"]`)!;
    expect(card.textContent!.replace(composer.textContent ?? "", "")).not.toMatch(/\d+\s*(credits|cr)\b/i);
    expect(screen.queryByTestId("canvas-inspector")).toBeNull();
    // A press in it attaches the job it started to this card, read back like any other.
    fireEvent.click(within(composer).getByRole("button", { name: "press" }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).nodes.find((n: { id: string }) => n.id === added.id).jobId).toBe(JOB_NEW));
  });

  it("\"More options\" opens the inspector for that card, in place of the small composer", async () => {
    store({ nodes: [node("img", "image")], wires: [] });
    mount({ tools: { state: "known", sold: ["t2i", "i2v"] } });
    await screen.findByTestId("canvas-board");
    fireEvent.click(screen.getByTestId("plus-img"));
    fireEvent.click(within(await screen.findByTestId("quick-menu")).getByTestId("quick-animate"));
    const id = await waitFor(() => {
      const el = document.querySelector('[data-testid^="inline-more-"]');
      if (!el) throw new Error("no composer yet");
      return el as HTMLElement;
    });
    fireEvent.click(id);
    expect(await screen.findByTestId("canvas-inspector")).toBeTruthy();
    expect(document.querySelector('[data-testid^="inline-composer-"]')).toBeNull();
  });

  it("the menu is the keyboard's: arrows move, Escape closes it and focus goes back to the \"+\"", async () => {
    store({ nodes: [node("img", "image")], wires: [] });
    mount({ tools: { state: "known", sold: ["t2i", "i2v"] } });
    await screen.findByTestId("canvas-board");
    const plus = screen.getByTestId("plus-img");
    plus.focus();
    fireEvent.click(plus);
    const menu = await screen.findByTestId("quick-menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(within(menu).getByTestId("quick-animate"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(within(menu).getByTestId("quick-animate"));
    expect(items).toContain(document.activeElement);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("quick-menu")).toBeNull();
    expect(document.activeElement).toBe(plus);
  });
});

describe("review fixes", () => {
  it("the board's keys stay on the board: Backspace and arrows on an inspector button do nothing to the node", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    openNode("a");
    const close = await screen.findByRole("button", { name: c.inspector.close });
    close.focus();
    fireEvent.keyDown(close, { key: "ArrowRight" });
    fireEvent.keyDown(close, { key: "Backspace" });
    expect(document.querySelector('[data-node-id="a"]')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse(window.localStorage.getItem(KEY)!).nodes[0].x).toBe(0);
    expect(screen.getByTestId("canvas-inspector")).toBeTruthy();
  });

  it("Delete and ⌘Z in the prompt's words box edit the words, not the canvas", async () => {
    store({ nodes: [node("p", "prompt", 0, { draft: "a fox" })], wires: [] });
    mount();
    await screen.findByTestId("canvas-board");
    openNode("p");
    const words = await screen.findByTestId("prompt-words");
    words.focus();
    fireEvent.keyDown(words, { key: "Delete" });
    fireEvent.keyDown(words, { key: "z", ctrlKey: true });
    expect(document.querySelector('[data-node-id="p"]')).toBeTruthy();
  });

  it("one failed read does not end the watch: running, then a 502, then completed lands on the node and refreshes credits and the library", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      store({ nodes: [node("v", "image", 0, { jobId: JOB_SEQ })], wires: [] });
      mount();
      await waitFor(() => expect(document.querySelector('[data-node-id="v"]')!.getAttribute("data-status")).toBe("working"));
      const mediaReads = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).startsWith("/api/media")).length;
      const before = mediaReads();
      // The 502: the node keeps its last good reading (still working), not "unknown".
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await waitFor(() => expect(seqReads).toBe(2));
      expect(document.querySelector('[data-node-id="v"]')!.getAttribute("data-status")).toBe("working");
      // Polling goes on (after a backoff) and the finished job lands.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      await waitFor(() => expect(document.querySelector('[data-node-id="v"]')!.getAttribute("data-status")).toBe("done"));
      expect(refreshCredits).toHaveBeenCalled();
      await waitFor(() => expect(mediaReads()).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a starter that needs a tool with nothing on sale is shown with its reason and builds nothing", async () => {
    mount({ tools: { state: "known", sold: ["t2i"] } });
    const clip = await screen.findByTestId("recipe-photoClip");
    expect(clip.getAttribute("aria-disabled")).toBe("true");
    expect(clip.textContent).toContain(c.palette.closedWhy);
    fireEvent.click(clip);
    expect(document.querySelectorAll("[data-node-id]")).toHaveLength(0);
  });

  it("Retry on a failed card refills the form from that job even when the inspector was closed", async () => {
    store({ nodes: [node("a", "image", 0, { jobId: JOB_FAIL })], wires: [] });
    mount();
    await waitFor(() => expect(document.querySelector('[data-node-id="a"]')!.getAttribute("data-status")).toBe("failed"));
    const before = panel.props.length;
    fireEvent.click(screen.getByTestId("retry-a"));
    await screen.findByTestId("canvas-inspector");
    // A second form mount: the retry's seed (the first is the inspector's own).
    await waitFor(() => expect(panel.props.length).toBeGreaterThan(before + 1));
  });
});

describe("keys and the palette", () => {
  it("a tool with nothing on sale is listed disabled with its reason, and cannot be added", async () => {
    mount({ tools: { state: "known", sold: ["t2i"] } });
    await screen.findByTestId("canvas-first-run");
    fireEvent.click(screen.getByTestId("recipe-blank"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    });
    const pal = await screen.findByTestId("canvas-palette");
    const video = within(pal).getByTestId("add:video");
    expect(video.getAttribute("aria-disabled")).toBe("true");
    expect(video.textContent).toContain(c.palette.closedWhy);
    fireEvent.click(video);
    expect(document.querySelector('[data-kind="video"]')).toBeNull();
    fireEvent.click(within(pal).getByTestId("add:image"));
    expect(document.querySelector('[data-kind="image"]')).toBeTruthy();
  });

  it("Escape closes the palette and focus goes back to what opened it", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    const add = await screen.findByTestId("dock-add");
    add.focus();
    fireEvent.click(add);
    const pal = await screen.findByTestId("canvas-palette");
    expect(document.activeElement?.tagName).toBe("INPUT");
    fireEvent.keyDown(pal, { key: "Escape" });
    expect(screen.queryByTestId("canvas-palette")).toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("⌘K opens the canvas palette (not the app's), N adds; adding a node is free", async () => {
    const appPalette = vi.fn();
    window.addEventListener("keydown", appPalette);
    mount();
    await screen.findByTestId("canvas-first-run");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
    const pal = await screen.findByTestId("canvas-palette");
    expect(appPalette).not.toHaveBeenCalled();
    expect(within(pal).getByText(c.palette.hint)).toBeTruthy();
    fireEvent.click(within(pal).getByTestId("add:voice"));
    expect(document.querySelector('[data-kind="voice"]')).toBeTruthy();
    window.removeEventListener("keydown", appPalette);
  });
});

describe("the phone", () => {
  it("draws the graph as a vertical flow with inputs as chips, and no board", async () => {
    narrow = true;
    store({ nodes: [node("img", "image"), node("clip", "animate", 400)], wires: [{ id: "w1", from: "img", to: "clip" }] });
    mount();
    expect(await screen.findByTestId("flow-node-animate")).toBeTruthy();
    expect(screen.queryByTestId("canvas-board")).toBeNull();
    expect(screen.getByTestId("flow-node-animate").textContent).toContain("from Image");
    fireEvent.click(screen.getByTestId("flow-node-animate"));
    expect((await screen.findByTestId("canvas-inspector")).className).toContain("is-sheet");
  });
});
