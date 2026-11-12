// @vitest-environment jsdom
/**
 * The studio (components/character-studio/*, NIGHTSHIFT_CHARACTER_STUDIO).
 * What would break without these: the studio drawn while the switch is off; the cost below the model picker instead of above it; a
 * model switch that leaves the old model's price on screen; a price shown that the database never quoted (or a model "on sale" with no
 * number); "Try" that does not carry the example's words; an empty sample slot that borrows another model's clip or says nothing; the
 * swap started before all five declarations, without the quoted charge as its ceiling, or twice for one press; a viewer offered the button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { characterStudioEn as t } from "../lib/i18n/character-studio/en";
import type { StudioState } from "../lib/characterStudio/model";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});

const { CharacterStudio, costText } = await import("../components/character-studio/CharacterStudio");
const ORG = "0a000000-0000-4000-8000-00000000000a";
const VIDEO = "0b000000-0000-4000-8000-00000000000b";
const PIC = "0c000000-0000-4000-8000-00000000000c";
const TPL = "1a000000-0000-4000-8000-00000000001a";
const PROMPT = "Replace the person on the left with the character in @Image 1. Keep the scene.";

const state = (over: Partial<StudioState> = {}): StudioState => ({
  available: true,
  templates: [
    {
      id: TPL, slug: "one-character", title: { en: "One new character", ru: "Один", uz: "Bitta" }, prompt: PROMPT, characters: 1,
      samples: { "kling-4.0-omni-edit": { model: "kling-4.0-omni-edit", webUrl: "https://cdn.example.com/s/one/kling.mp4", posterUrl: null }, "seedance-2.5-edit": null },
    },
  ],
  jobs: [],
  videos: [{ id: VIDEO, kind: "video", name: "clip.mp4", thumbUrl: null, durationS: 9.2, source: "upload" }],
  pictures: [{ id: PIC, kind: "image", name: "cat.png", thumbUrl: null, durationS: null, source: "upload" }],
  ...over,
});

const QUOTE = {
  seconds: 9.2, billedSeconds: 10, resolution: "720p", exempt: false,
  models: [
    { model: "kling-4.0-omni-edit", onSale: true, credits: 18.8, hold: 30, problem: null },
    { model: "seedance-2.5-edit", onSale: true, credits: 27.6, hold: 30, problem: null },
  ],
};

let calls: { method: string; url: string; body: unknown }[] = [];
let answers: ((url: string, method: string) => { status: number; body: unknown } | undefined)[] = [];

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers.map((f) => f(url, method)).find(Boolean);
    const out = a ?? (url.startsWith("/api/character-studio/quote") ? { status: 200, body: { quote: QUOTE } }
      : url === "/api/character-studio/consent" ? { status: 201, body: { consent_id: "0d000000-0000-4000-8000-00000000000d" } }
        : url === "/api/character-studio/swaps" ? { status: 201, body: { id: "0e000000-0000-4000-8000-00000000000e", status: "requested" } }
          : { status: 200, body: { org: ORG, ...state() } });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(over: Partial<Parameters<typeof CharacterStudio>[0]> = {}) {
  return render(<CharacterStudio enabled orgId={ORG} canEdit initial={state()} libraryHref="/alpha/library" {...over} />);
}

async function openAndPick() {
  fireEvent.click(screen.getAllByRole("button", { name: t.gallery.try })[0]);
  fireEvent.click(screen.getByRole("radio", { name: /clip\.mp4/ }));
  await waitFor(() => expect(screen.getByTestId("cs-cost-main").textContent).toBe("18.8 credits"));
}

describe("the studio", () => {
  it("draws nothing while the switch is off", () => {
    const { container } = mount({ enabled: false });
    expect(container.innerHTML).toBe("");
  });

  it("a card shows each model's sample slot, and an empty slot says a sample is coming, never another model's clip", () => {
    mount();
    const card = document.querySelector('[data-template="one-character"]') as HTMLElement;
    const kling = card.querySelector('[data-model="kling-4.0-omni-edit"]') as HTMLElement;
    const seed = card.querySelector('[data-model="seedance-2.5-edit"]') as HTMLElement;
    expect(kling.querySelector("video")?.getAttribute("src")).toBe("https://cdn.example.com/s/one/kling.mp4");
    expect(kling.querySelector("video")?.hasAttribute("autoplay")).toBe(false);
    expect(seed.querySelector("video")).toBeNull();
    expect(within(seed).getByText(t.gallery.sampleSoon)).toBeTruthy();
  });

  it("Try opens the studio with the example's words", () => {
    mount();
    expect(screen.queryByTestId("cs-prompt")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: t.gallery.try })[0]);
    expect((screen.getByTestId("cs-prompt") as HTMLTextAreaElement).value).toBe(PROMPT);
  });

  it("the cost is at the top, the model picker below it, and switching the model changes the cost at once", async () => {
    mount();
    await openAndPick();
    const cost = screen.getByTestId("cs-cost");
    const models = screen.getByTestId("cs-models");
    expect(cost.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("30 credits are held while it runs; 18.8 are charged when it is ready, and the rest goes back.")).toBeTruthy();
    expect(screen.getByTestId("cs-price-kling-4.0-omni-edit").textContent).toBe("18.8 credits");
    expect(screen.getByTestId("cs-price-seedance-2.5-edit").textContent).toBe("27.6 credits");
    const quotes = calls.filter((c) => c.url.startsWith("/api/character-studio/quote")).length;
    fireEvent.click(screen.getByRole("radio", { name: /Seedance 2\.5/ }));
    expect(screen.getByTestId("cs-cost-main").textContent).toBe("27.6 credits");
    expect(calls.filter((c) => c.url.startsWith("/api/character-studio/quote")).length, "one quote holds every model's price").toBe(quotes);
  });

  it("a resolution change asks the database again; the browser never computes a price", async () => {
    mount();
    await openAndPick();
    fireEvent.click(screen.getByRole("radio", { name: "1080p" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("resolution=1080p"))).toBe(true));
  });

  it("a model with no price reads not on sale, and the button stays off", async () => {
    answers.push((url) => url.startsWith("/api/character-studio/quote")
      ? { status: 200, body: { quote: { ...QUOTE, models: [{ model: "kling-4.0-omni-edit", onSale: false, credits: null, hold: null, problem: null }, QUOTE.models[1]] } } }
      : undefined);
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: t.gallery.try })[0]);
    fireEvent.click(screen.getByRole("radio", { name: /clip\.mp4/ }));
    await waitFor(() => expect(screen.getByTestId("cs-cost-main").textContent).toBe("Kling 4.0 Omni is not on sale yet."));
    expect((screen.getByRole("button", { name: t.consent.submit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("starts only after all five declarations, with the quoted charge as its ceiling, and one key per press", async () => {
    mount();
    await openAndPick();
    fireEvent.click(screen.getByRole("checkbox", { name: /cat\.png/ }));
    const submit = screen.getByRole("button", { name: t.consent.submit }) as HTMLButtonElement;
    const boxes = within(screen.getByTestId("cs-consent")).getAllByRole("checkbox");
    expect(boxes).toHaveLength(5);
    for (const b of boxes.slice(0, 4)) fireEvent.click(b);
    expect(submit.disabled, "four of five is not consent").toBe(true);
    fireEvent.click(boxes[4]);
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/character-studio/swaps")).toBe(true));
    const swap = calls.find((c) => c.url === "/api/character-studio/swaps")!.body as Record<string, unknown>;
    expect(swap).toMatchObject({ input: VIDEO, references: [PIC], prompt: PROMPT, model: "kling-4.0-omni-edit", resolution: "720p", max_credits: 18.8 });
    expect(String(swap.idem)).toMatch(/^cs-[0-9a-f]{32}$/);
    const c = calls.find((x) => x.url === "/api/character-studio/consent")!.body as Record<string, unknown>;
    expect(c).toMatchObject({ model: "kling-4.0-omni-edit", input: VIDEO, references: [PIC] });
  });

  it("a refusal is said in words with the database's own number", async () => {
    answers.push((url) => (url === "/api/character-studio/swaps" ? { status: 409, body: { error: "price_changed", charge: 20.5 } } : undefined));
    mount();
    await openAndPick();
    fireEvent.click(screen.getByRole("checkbox", { name: /cat\.png/ }));
    for (const b of within(screen.getByTestId("cs-consent")).getAllByRole("checkbox")) fireEvent.click(b);
    fireEvent.click(screen.getByRole("button", { name: t.consent.submit }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The price changed to 20.5 credits. Check it and press again."));
  });

  it("a viewer sees the gallery and the cost, but cannot declare or start", async () => {
    mount({ canEdit: false });
    expect(screen.getByText(t.readOnly)).toBeTruthy();
    await openAndPick();
    for (const b of within(screen.getByTestId("cs-consent")).getAllByRole("checkbox")) expect((b as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: t.consent.submit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a ready swap carries the AI label", () => {
    mount({ initial: state({ jobs: [{ id: "0e000000-0000-4000-8000-00000000000e", model: "kling-4.0-omni-edit", resolution: "720p", status: "ready", errorCode: null, credits: 18.8, charged: 18.8, outputAssetId: VIDEO, createdAt: null }] }) });
    expect(screen.getByText(t.jobs.aiLabel)).toBeTruthy();
    expect(screen.getByText("18.8 credits charged")).toBeTruthy();
  });
});

describe("costText", () => {
  it("never invents a number", () => {
    expect(costText(t, undefined, false).sellable).toBe(false);
    expect(costText(t, { model: "seedance-2.5-edit", onSale: true, credits: null, hold: 30, problem: null }, false).main).toBe("Seedance 2.5 is not on sale yet.");
    expect(costText(t, { model: "seedance-2.5-edit", onSale: true, credits: 68, hold: 68, problem: null }, false).detail).toBe(
      "68 credits are held while it runs and charged when it is ready.",
    );
    expect(costText(t, { model: "seedance-2.5-edit", onSale: true, credits: 27.6, hold: 30, problem: "needs_own_generated_clip" }, false).main).toBe(
      t.errors.needs_own_generated_clip,
    );
  });
});
