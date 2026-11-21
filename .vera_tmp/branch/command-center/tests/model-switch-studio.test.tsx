// @vitest-environment jsdom
/**
 * The Studio over a model the owner switched off (migration 0124).
 *
 * What would break without these: a retried job or a catalog link whose model is off being quietly swapped for another one (CLAUDE.md #4) and
 * priced and started on the person's tap; a form that offers a model the database will refuse; a refused create reading as a generic failure;
 * the owner's reason reaching the person; and the switch changing a Studio nobody switched anything off in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { mapCreativeError } from "@/lib/creative/operations";
import type { StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

// Three picture models; "pic-off" is the one the owner switched off, so the list the server sent lacks it.
const MODELS: StudioModel[] = [
  { id: "pic-fast", displayName: "Picture Fast", capabilities: ["t2i"], beta: false },
  { id: "pic-fine", displayName: "Picture Fine", capabilities: ["t2i"], beta: false },
];
const PRICE: Record<string, number> = { "pic-fast": 4, "pic-fine": 9 };

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<{ model: string }>;
let refuse: string | null;
const creates = () => fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  quotes = [];
  refuse = null;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      if (refuse) return json({ error: refuse }, 503);
      return json({ quote: { credits: PRICE[body.model] ?? 1 } });
    }
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (text: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });

describe("a form that came with a model that is switched off", () => {
  const open = () =>
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} unavailable={["pic-off"]} initial={{ capability: "t2i", model: "pic-off", prompt: "a red kite" } as never} />));

  it("says the model is temporarily unavailable, names no reason, and picks nothing for the person", async () => {
    open();
    const box = screen.getByTestId("gen-model-off");
    expect(within(box).getByText(t.modelSwitch.studio.offTitle)).toBeTruthy();
    expect(within(box).getByText(t.modelSwitch.studio.offBody)).toBeTruthy();
    expect(screen.queryByTestId("gen-model-name")).toBeNull();
    // nothing is priced and nothing can be started: neither of the other models was quietly taken
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect(creates()).toHaveLength(0);
    expect((document.querySelector('[data-testid="gen-dock"] button') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(/fund|balance|outage|vendor/i);
  });

  it("the person chooses another model themselves, and only then is anything priced", async () => {
    open();
    fireEvent.click(within(screen.getByTestId("gen-model-off")).getByRole("button", { name: t.modelSwitch.studio.offChoose }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Picture Fine"));
    await waitFor(() => expect(quotes.map((q) => q.model)).toEqual(["pic-fine"]));
    expect(screen.queryByTestId("gen-model-off")).toBeNull();
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fine");
  });

  it("with no other model to choose the choice is disabled, not a dead end that looks live", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[]} unavailable={["pic-off"]} initial={{ capability: "t2i", model: "pic-off" } as never} />));
    const btn = within(screen.getByTestId("gen-model-off")).getByRole("button", { name: t.modelSwitch.studio.offChoose }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("a form that did not come with such a model", () => {
  it("is exactly what it was: the first model that makes the kind is picked, as before", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} unavailable={["pic-off"]} initial={{ capability: "t2i", model: "pic-fine", prompt: "x" } as never} />));
    expect(screen.queryByTestId("gen-model-off")).toBeNull();
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fine");
  });

  it("without the prop (a page that does not know the switch) a model that is not in the list falls to the first, as it always did", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={{ capability: "t2i", model: "pic-off", prompt: "x" } as never} />));
    expect(screen.queryByTestId("gen-model-off")).toBeNull();
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fast");
  });

  it("a model that is in the list is never treated as off because an id sits in the switched-off list", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} unavailable={["pic-fast"]} initial={{ capability: "t2i", model: "pic-fast", prompt: "x" } as never} />));
    expect(screen.queryByTestId("gen-model-off")).toBeNull();
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fast");
  });
});

describe("a page left open while the owner switched the model off", () => {
  it("the refused quote says temporarily unavailable, and nothing is started", async () => {
    refuse = "model_temporarily_off";
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={{ capability: "t2i", model: "pic-fast", prompt: "a red kite" } as never} />));
    await waitFor(() => expect(screen.getByText(t.creative.errors.model_temporarily_off)).toBeTruthy());
    expect(creates()).toHaveLength(0);
    expect((document.querySelector('[data-testid="gen-dock"] button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the refusal is its own word", () => {
  it("is a 503 with a code the page words, and carries no reason", () => {
    const out = mapCreativeError({ code: "NS400", message: "model_temporarily_off", details: "pic-fast is temporarily unavailable" });
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "model_temporarily_off", detail: "pic-fast is temporarily unavailable" });
    expect(t.creative.errors.model_temporarily_off).toMatch(/temporarily unavailable/);
  });
});
