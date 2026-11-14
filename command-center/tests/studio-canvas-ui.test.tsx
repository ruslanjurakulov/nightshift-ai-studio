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

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ShellProvider } from "@/components/shell/ShellContext";
import { StudioCanvas } from "@/components/studio-canvas/StudioCanvas";
import { UNKNOWN_TOOLS, type ToolAvailability } from "@/lib/tool-availability";
import { layoutKey } from "@/lib/studio/canvas";

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

  it("'Prompt → image → video' lays out an Image wired into Image → Video, and starts nothing", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("recipe-promptVideo"));
    const nodes = document.querySelectorAll("[data-node-id]");
    expect([...nodes].map((n) => n.getAttribute("data-kind"))).toEqual(["image", "animate"]);
    expect(document.querySelectorAll("[data-wire]")).toHaveLength(1);
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
    fireEvent.click(within(document.querySelector('[data-node-id="clip"]') as HTMLElement).getByRole("button", { pressed: false }));
    const form = await screen.findByTestId("generate-panel");
    expect(form.getAttribute("data-cap")).toBe("i2v");
    expect(form.getAttribute("data-source")).toBe(OUT);
    expect(form.getAttribute("data-desk")).toBe("video");
    // Disconnect: the inspector says the input is missing, before any quote.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(c.inspector.disconnect) }));
    expect((await screen.findByTestId("inspector-needs")).textContent).toContain("Needs Picture");
  });

  it("the inspector wires from the canvas (the phone's way), refusing nothing it lists", async () => {
    store({ nodes: [node("pic", "asset", -400, { assetId: PIC, assetKind: "image" }), node("clip", "animate", 0), node("voice", "voice", 0)], wires: [] });
    mount();
    fireEvent.click(within((await screen.findAllByRole("group")).find((g) => g.getAttribute("data-node-id") === "clip")!).getAllByRole("button")[0]);
    const pick = await screen.findByTestId("inspector-wire");
    // A voice-over cannot feed a clip: only the picture is offered.
    expect([...pick.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["—", "Fox"]);
    fireEvent.change(pick, { target: { value: "pic" } });
    await waitFor(() => expect(document.querySelectorAll("[data-wire]")).toHaveLength(1));
    expect(document.querySelector('[data-node-id="clip"]')!.getAttribute("data-status")).toBe("idle");
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
    fireEvent.click(within(document.querySelector('[data-node-id="a"]') as HTMLElement).getAllByRole("button")[0]);
    expect((await screen.findByTestId("inspector-failure")).textContent!.length).toBeGreaterThan(3);
    const before = panel.props.length;
    fireEvent.click(screen.getByTestId("inspector-retry"));
    // A fresh form from that job: the composer prices it again before anything starts.
    await waitFor(() => expect(panel.props.length).toBeGreaterThan(before));
  });

  it("a press in the composer attaches the job it created to the node, and its state is read back", async () => {
    store({ nodes: [node("a", "image")], wires: [] });
    mount();
    fireEvent.click(within((await screen.findAllByRole("group"))[0]).getAllByRole("button")[0]);
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
    fireEvent.click(within(v).getAllByRole("button")[0]);
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
      expect(document.querySelectorAll("[data-node-id]")).toHaveLength(1);
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
    fireEvent.pointerDown(screen.getByTestId("canvas-board"));
    fireEvent.click(within(document.querySelector('[data-node-id="a"]') as HTMLElement).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: c.inspector.close }));
    expect(screen.queryByTestId("generate-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("dock-quote"));
    expect(await screen.findByTestId("generate-panel")).toBeTruthy();
  });
});

describe("keys and the palette", () => {
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
