// @vitest-environment jsdom
/**
 * The edges of the "linked model not offered" note (tests/studio-linked-model.test.tsx pins the main behaviour).
 *
 * What would break without these: a page with no models (or none for the link's tool) crashing or claiming "{default} is selected"
 * with nothing selected; a model only locked for this organization drawing the note on top of its lock; a fast double press, or a
 * press while the note is up, sending the gone id to the quote or the create (the database would refuse it, or worse, a hold for a
 * model the person was told is not selected); a re-render dropping or duplicating the line; a language switch leaving it in the
 * old language; the composer's footer taking room while there is nothing to say; and the real sample links from
 * lib/site/showcase.json reaching the panel as a form that does not match what the page builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));

import { I18nProvider, useI18n } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { prefillModel } from "@/lib/models-discovery";
import { prefillFromImprove } from "@/lib/creative/improve";
import { coerceModels, prefillFromQuery, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";
import { toolPrefill } from "@/lib/home";
import { presetPrefill } from "@/lib/presets";
import { withChannelDna } from "@/lib/channel-dna";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { tryHref } from "@/lib/site/showcase-link";
import { resetCreditsLive, seedCredits } from "@/lib/credits-live";
import { coerceAccount } from "@/lib/credits";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "vid-fast", displayName: "Video Fast", capabilities: ["t2v"], beta: false },
  { id: "vid-fine", displayName: "Video Fine", capabilities: ["t2v"], beta: false },
  { id: "pic-fast", displayName: "Picture Fast", capabilities: ["t2i"], beta: false },
  { id: "anim-fast", displayName: "Animate Fast", capabilities: ["i2v"], beta: false },
];
const PRICE: Record<string, number> = { "vid-fast": 40, "vid-fine": 90, "pic-fast": 4 };

let quotes: Array<{ model: string }>;
let creates: Array<Record<string, unknown>>;
// When set, the create answers only when the test releases it: the press is in flight for as long as the test looks.
let holdCreate: (() => void) | null;
let hangCreate: boolean;

beforeEach(() => {
  quotes = [];
  creates = [];
  holdCreate = null;
  hangCreate = false;
  resetCreditsLive();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/creative/quote") {
        const body = JSON.parse(String(init?.body));
        quotes.push(body);
        return json({ quote: { credits: PRICE[body.model] ?? 1 } });
      }
      if (url === "/api/creative/jobs" && init?.method === "POST") {
        creates.push(JSON.parse(String(init.body)));
        if (hangCreate) return new Promise<Response>((res) => (holdCreate = () => void json({ job: { id: "j1" } }).then(res)));
        return json({ job: { id: "j1" } });
      }
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
      return json({}, 404);
    }),
  );
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCreditsLive();
});

const noteText = () => screen.getByTestId("gen-model-gone").textContent ?? "";
const gone = (d = "Video Fast", l: "en" | "ru" | "uz" = "en") => fmt(dictionaries[l].gen.modelGone, { default: d });
const link = (model: string, capability: "t2v" | "t2i" = "t2v"): StudioPrefill =>
  ({ capability, model, prompt: "a paper boat on a rainy street", aspect: "16:9", duration: 5 }) as StudioPrefill;
const panel = (initial: StudioPrefill, models: StudioModel[] = MODELS, desk: "video" | "image" = "video") => (
  <GeneratePanel orgId={ORG} models={models} desk={desk} unavailable={[]} initial={initial} />
);
const pressKey = () => screen.getByTestId("gen-dock").querySelector("button") as HTMLButtonElement;

describe("no model to fall back to", () => {
  it("an empty models list draws no note and does not crash", () => {
    render(withI18n(panel(link("vid-retired-2024"), [])));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-gone").className).toBe("sr-only");
    expect(pressKey().disabled).toBe(true);
  });

  it("a models list with nothing for the link's tool names no default (never \"so  is selected\") and prices nothing", async () => {
    const picturesOnly = MODELS.filter((m) => !m.capabilities.includes("t2v"));
    const { container } = render(withI18n(panel(link("vid-retired-2024"), picturesOnly)));
    expect(noteText()).toBe("");
    expect(container.textContent).not.toMatch(/so\s+is selected/);
    expect(pressKey().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("a list where every model of the tool is locked: the note names the locked default and its lock is said, nothing is priced", async () => {
    const allLocked = MODELS.map((m) => (m.capabilities.includes("t2v") ? { ...m, lock: "first_purchase" as const } : m));
    render(withI18n(panel(link("vid-retired-2024"), allLocked)));
    expect(noteText()).toBe(gone());
    expect(screen.getByTestId("gen-locked").getAttribute("data-lock")).toBe("first_purchase");
    expect(pressKey().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("a registry row with a blank display name is named by its id, so the default in the line is never empty", () => {
    const rows = [{ id: "vid-blank", display_name: "   ", capabilities: ["t2v"], availability: "ga", verified_at: "2026-11-01T00:00:00Z" }];
    const models = coerceModels(rows);
    expect(models[0].displayName).toBe("vid-blank");
    render(withI18n(panel(link("vid-retired-2024"), models)));
    expect(noteText()).toBe(gone("vid-blank"));
  });
});

describe("a model the list knows but this organization cannot buy", () => {
  it("is taken as linked: its lock is named, and no note claims it is not offered", async () => {
    const lockedFine = MODELS.map((m) => (m.id === "vid-fine" ? { ...m, lock: "first_purchase" as const } : m));
    render(withI18n(panel(link("vid-fine"), lockedFine)));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fine");
    expect(screen.getByTestId("gen-locked").getAttribute("data-lock")).toBe("first_purchase");
    expect(pressKey().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });
});

describe("what the press sends in the note state", () => {
  it("the quote and the create carry the default the note names, never the gone id, and a double press creates once", async () => {
    hangCreate = true;
    render(withI18n(panel(link("vid-retired-2024"))));
    expect(noteText()).toBe(gone());
    await waitFor(() => expect(pressKey().disabled).toBe(false));
    fireEvent.click(pressKey());
    fireEvent.click(pressKey());
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0].model).toBe("vid-fast");
    expect(creates[0].max_credits).toBe(40);
    expect(creates[0].mode).toBeUndefined();
    expect(JSON.stringify(creates[0])).not.toContain("vid-retired-2024");
    expect(quotes.every((q) => q.model === "vid-fast")).toBe(true);
    expect(JSON.stringify(quotes)).not.toContain("vid-retired-2024");
    // still in flight: a third press is no second job
    fireEvent.click(pressKey());
    await act(async () => {
      holdCreate?.();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(creates).toHaveLength(1);
  });

  it("a named gone model (a picture model on the clip tool) is never sent either", async () => {
    render(withI18n(panel(link("pic-fast"))));
    await waitFor(() => expect(pressKey().disabled).toBe(false));
    fireEvent.click(pressKey());
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0].model).toBe("vid-fast");
    expect(creates[0].capability).toBe("t2v");
    expect(quotes.map((q) => q.model)).not.toContain("pic-fast");
  });

  it("short of credits in the note state: the key says how many are missing, the note stays and still shows no number", async () => {
    seedCredits(ORG, coerceAccount({ balance: 10, reserved: 0 }));
    render(withI18n(panel(link("vid-retired-2024"))));
    await waitFor(() => expect(screen.getByTestId("gen-short-note")).toBeTruthy());
    expect(noteText()).toBe(gone());
    expect(noteText()).not.toMatch(/\d/);
    const key = screen.getByTestId("gen-need-credits");
    expect(key.textContent).toContain(fmt(t.gen.needMore, { n: "30" }));
    // the price on the key is the default's quote, the one the note says is selected
    expect(screen.getByTestId("price-tag").textContent).toContain("40");
    expect(quotes.every((q) => q.model === "vid-fast")).toBe(true);
    expect(creates).toEqual([]);
  });

  it("short of credits in the note state: the top-ups key points at the note too, as the Generate key does", async () => {
    seedCredits(ORG, coerceAccount({ balance: 10, reserved: 0 }));
    render(withI18n(panel(link("vid-retired-2024"))));
    const key = await screen.findByTestId("gen-need-credits");
    expect(noteText()).toBe(gone());
    // focus lands on this key in place of Generate; without the reference the swap is not read there
    expect(key.getAttribute("aria-describedby") ?? "").toContain("gen-model-gone");
  });
});

describe("the note across re-renders, reloads and languages", () => {
  it("a re-render with the same props keeps exactly one line with the same words", async () => {
    const initial = link("vid-retired-2024");
    const { rerender } = render(withI18n(panel(initial)));
    expect(noteText()).toBe(gone());
    rerender(withI18n(panel(initial)));
    rerender(withI18n(panel({ ...initial })));
    expect(screen.getAllByTestId("gen-model-gone")).toHaveLength(1);
    expect(noteText()).toBe(gone());
    await waitFor(() => expect(quotes.at(-1)?.model).toBe("vid-fast"));
  });

  it("a reload (a fresh mount from the same link) says it again: the line does not depend on state that survived", () => {
    render(withI18n(panel(link("vid-retired-2024"))));
    expect(noteText()).toBe(gone());
    cleanup();
    render(withI18n(panel(link("vid-retired-2024"))));
    expect(noteText()).toBe(gone());
  });

  it("the models list arriving with the linked model in it takes the model and the note goes", () => {
    const without = MODELS.filter((m) => m.id !== "vid-fine");
    const initial = link("vid-fine");
    const { rerender } = render(withI18n(panel(initial, without)));
    expect(noteText()).toBe(fmt(t.gen.modelGone, { default: "Video Fast" }));
    rerender(withI18n(panel(initial, MODELS)));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fine");
  });

  it("switching the language while the note is up says it in the new language (ru, then uz)", () => {
    function Switch() {
      const { setLocale } = useI18n();
      return (
        <>
          <button type="button" onClick={() => setLocale("ru")}>to-ru</button>
          <button type="button" onClick={() => setLocale("uz")}>to-uz</button>
        </>
      );
    }
    render(
      withI18n(
        <>
          <Switch />
          {panel(link("pic-fast"))}
        </>,
      ),
    );
    expect(noteText()).toBe(fmt(t.gen.modelGoneNamed, { model: "Picture Fast", default: "Video Fast" }));
    fireEvent.click(screen.getByText("to-ru"));
    expect(noteText()).toBe(fmt(dictionaries.ru.gen.modelGoneNamed, { model: "Picture Fast", default: "Video Fast" }));
    fireEvent.click(screen.getByText("to-uz"));
    expect(noteText()).toBe(fmt(dictionaries.uz.gen.modelGoneNamed, { model: "Picture Fast", default: "Video Fast" }));
  });

  it("away to another tab and back: what the link's tool shows again is the default, and the press never carries the gone id", async () => {
    render(withI18n(panel(link("vid-retired-2024"))));
    fireEvent.click(document.getElementById("gen-tab-i2v") as HTMLElement);
    expect(noteText()).toBe("");
    fireEvent.click(document.getElementById("gen-tab-t2v") as HTMLElement);
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fast");
    // either it says so again or the default became the model; never a silent gone id on the wire
    expect(["", gone()]).toContain(noteText());
    await waitFor(() => expect(pressKey().disabled).toBe(false));
    fireEvent.click(pressKey());
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0].model).toBe("vid-fast");
    expect(JSON.stringify(quotes)).not.toContain("vid-retired-2024");
  });

  it.each(["ru", "uz"] as const)("opened in %s, the generic line is in that language", (l) => {
    render(withI18n(panel(link("vid-retired-2024")), l));
    expect(noteText()).toBe(gone("Video Fast", l));
  });
});

describe("the composer's footer", () => {
  const composer = (initial: StudioPrefill) => (
    <GeneratePanel orgId={ORG} models={MODELS} layout="composer" desk="video" initial={initial} />
  );
  it("takes the footer's room only while there is something to say", () => {
    render(withI18n(composer(link("vid-fine"))));
    const quiet = screen.getByTestId("gen-model-gone");
    expect(quiet.className).toBe("sr-only");
    expect(quiet.parentElement?.className ?? "").not.toContain("sc-foot");
    cleanup();
    render(withI18n(composer(link("vid-retired-2024"))));
    const said = screen.getByTestId("gen-model-gone");
    expect(said.className).not.toContain("sr-only");
    expect(said.parentElement?.className).toBe("sc-foot");
  });

  it("the composer's press carries the default, never the gone id", async () => {
    render(withI18n(composer(link("vid-retired-2024"))));
    const key = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-describedby]")).find((b) =>
        (b.getAttribute("aria-describedby") ?? "").startsWith("gen-status"),
      ) as HTMLButtonElement;
    expect(key().getAttribute("aria-describedby")).toContain("gen-model-gone");
    await waitFor(() => expect(key().disabled).toBe(false));
    fireEvent.click(key());
    fireEvent.click(key());
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0].model).toBe("vid-fast");
  });
});

/** The page's own chain (app/(app)/[channel]/create/page.tsx) for an all-channels link: no channel, so no DNA. */
function pagePrefill(href: string): StudioPrefill | null {
  const url = new URL(href, "https://example.test");
  const q: Record<string, string | string[] | undefined> = {};
  for (const k of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(k);
    q[k] = all.length > 1 ? all : all[0];
  }
  return prefillFromImprove(prefillModel(presetPrefill(withChannelDna(prefillFromQuery(q.tool, q.source) ?? toolPrefill(q.tool), null), q), q.model), q);
}

describe("a real sample's link, end to end into the panel", () => {
  const samples = SHOWCASE_ENTRIES.filter((e) => e.capability === "t2v" || e.capability === "t2i");

  it("the data file has t2v and t2i samples to test with", () => {
    expect(samples.some((e) => e.capability === "t2v")).toBe(true);
    expect(samples.some((e) => e.capability === "t2i")).toBe(true);
  });

  it("every t2v/t2i sample's signed-in link becomes a form on its own tool with its words, and the model only when the link names it", () => {
    for (const e of samples) {
      const href = tryHref(e, true);
      expect(href).toMatch(/^\/all-channels\/create\?/);
      const named = new URL(href as string, "https://example.test").searchParams.get("model");
      const initial = pagePrefill(href as string);
      expect(initial?.capability).toBe(e.capability);
      expect(initial?.model).toBe(named ?? "");
      expect((initial?.prompt ?? "").length).toBeGreaterThan(0);
      // An operator preview's link names no model: the panel then has nothing to say about one.
      if (e.operatorPreview) expect(named).toBeNull();
    }
  });

  it("an operator-preview sample opens the desk on the default with no note (nothing was asked for)", () => {
    const e = samples.find((s) => s.capability === "t2v" && s.operatorPreview);
    if (!e) return; // the data file has none: the next test covers the named path
    render(withI18n(panel(pagePrefill(tryHref(e, true) as string) as StudioPrefill)));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fast");
  });

  it("a sample on sale (preview flag cleared) whose model this workspace is not offered: its id travels and the note names the default", () => {
    const base = samples.find((s) => s.capability === "t2v") as (typeof samples)[number];
    const e = { ...base, operatorPreview: false, shutdownOn: null };
    const href = tryHref(e, true) as string;
    const initial = pagePrefill(href) as StudioPrefill;
    expect(initial.model).toBe(e.modelId);
    render(withI18n(panel(initial)));
    expect(noteText()).toBe(gone());
    cleanup();
    // offered: taken silently
    const offered = [...MODELS, { id: e.modelId, displayName: e.modelName, capabilities: ["t2v"], beta: false }];
    render(withI18n(panel(initial, offered)));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-name").textContent).toBe(e.modelName);
  });

  it("a t2i sample on sale reaches the image desk the same way", () => {
    const base = samples.find((s) => s.capability === "t2i") as (typeof samples)[number];
    const initial = pagePrefill(tryHref({ ...base, operatorPreview: false, shutdownOn: null }, true) as string) as StudioPrefill;
    expect(initial.capability).toBe("t2i");
    expect(initial.model).toBe(base.modelId);
    render(withI18n(panel(initial, MODELS, "image")));
    expect(noteText()).toBe(gone("Picture Fast"));
  });

  it("the signed-out link (sign-up, then `next`) carries the same form", () => {
    const base = samples.find((s) => s.capability === "t2v") as (typeof samples)[number];
    const e = { ...base, operatorPreview: false, shutdownOn: null };
    const out = new URL(tryHref(e, false) as string, "https://example.test");
    const next = out.searchParams.get("next");
    expect(next).toMatch(/^\/all-channels\/create\?/);
    const viaSignup = pagePrefill(next as string);
    expect(viaSignup?.capability).toBe("t2v");
    expect(viaSignup?.model).toBe(e.modelId);
    // the words may be cut on a word to fit sign-up, never extended
    expect(pagePrefill(tryHref(e, true) as string)?.prompt.startsWith(viaSignup?.prompt ?? "\u0000")).toBe(true);
  });
});

function fmt(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}
