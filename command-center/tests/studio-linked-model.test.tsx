// @vitest-environment jsdom
/**
 * A link into the Studio that names a model (a public sample's "Try this prompt": /all-channels/create?tool=t2v&model=<id>&prompt=…).
 *
 * The owner's decision (22 Nov): the Studio takes `model` ONLY when that model is on sale for that tool to this workspace. Otherwise
 * it opens on the default model AND says so in one line, naming the default. The same holds for a feed "Try again" whose model was
 * delisted, so the words never say "link". What would break without these: a linked model that is not offered being
 * swapped for the first usable one without a word (CLAUDE.md #4: the person clicked a sample made with X and is quoted for Y); the line
 * naming an id nobody can vouch for; a price appearing before the server's quote; and the link carrying markup, a script URL, a path
 * or an over-long id into the form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { prefillModel } from "@/lib/models-discovery";
import { AUTO_MODEL, cleanLinkPrompt, prefillFromImprove } from "@/lib/creative/improve";
import { afterSignupPath, studioNext } from "@/lib/safe-redirect";
import { deskFromQuery } from "@/lib/creative/desks";
import { drawsCreateScreen } from "@/lib/customer/create";
import { prefillFromJob, type StudioJob, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";

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

let fetchMock: ReturnType<typeof vi.fn>;
let quotes: Array<{ model: string }>;
// When set, the quote never answers: the form is "quoting" for as long as the test looks.
let hangQuote: boolean;

beforeEach(() => {
  quotes = [];
  hangQuote = false;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      if (hangQuote) return new Promise(() => {});
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

const noteText = () => screen.getByTestId("gen-model-gone").textContent ?? "";
const gone = (d = "Video Fast") => fmt(t.gen.modelGone, { default: d });

const link = (model: string, capability: "t2v" | "t2i" = "t2v"): StudioPrefill =>
  ({ capability, model, prompt: "a paper boat on a rainy street", aspect: "16:9", duration: 5 }) as StudioPrefill;

const openDesk = (initial: StudioPrefill, extra: { unavailable?: string[]; desk?: "video" | "image" } = {}) =>
  render(
    withI18n(
      <GeneratePanel orgId={ORG} models={MODELS} desk={extra.desk ?? "video"} unavailable={extra.unavailable ?? []} initial={initial} />,
    ),
  );

describe("the link's model, on the media desk a sample link opens", () => {
  it("an offered model is taken as linked, and no note is shown", async () => {
    openDesk(link("vid-fine"));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fine");
    await waitFor(() => expect(quotes.map((q) => q.model)).toEqual(["vid-fine"]));
  });

  it("an unknown well-formed id opens on the default model and says so, naming no model it cannot vouch for", async () => {
    openDesk(link("vid-retired-2024"));
    const note = screen.getByTestId("gen-model-gone");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.getAttribute("aria-live")).toBe("polite");
    expect(noteText()).toBe(gone());
    expect(noteText()).not.toContain("vid-retired-2024");
    // read where focus lands: the prompt and the price key point at it while it has text
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toContain("gen-model-gone");
    expect(screen.getByTestId("gen-dock").querySelector("button")?.getAttribute("aria-describedby")).toContain("gen-model-gone");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fast");
    await waitFor(() => expect(quotes.map((q) => q.model)).toEqual(["vid-fast"]));
  });

  it("a model of another kind (a picture model on a clip tool) opens on the default and the note may name it", () => {
    openDesk(link("pic-fast"));
    expect(noteText()).toBe(fmt(t.gen.modelGoneNamed, { model: "Picture Fast", default: "Video Fast" }));
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fast");
  });

  it("is said outside the folded settings on the video desk, where the model block sits closed", () => {
    openDesk(link("vid-retired-2024"));
    const note = screen.getByTestId("gen-model-gone");
    expect(note.closest("details")).toBeNull();
    expect(screen.getAllByTestId("gen-model-gone")).toHaveLength(1);
  });

  it("is said on the image desk too (a t2i sample)", () => {
    openDesk(link("pic-retired", "t2i"), { desk: "image" });
    expect(noteText()).toBe(gone("Picture Fast"));
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Picture Fast");
  });

  it("a switched-off model keeps its own words and picks nothing: no second note, nothing priced", async () => {
    openDesk(link("vid-off"), { unavailable: ["vid-off"] });
    expect(screen.getByTestId("gen-model-off")).toBeTruthy();
    expect(noteText()).toBe("");
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("Auto from the link is not a model id and draws no note", () => {
    openDesk({ ...link(""), auto: true } as StudioPrefill);
    expect(noteText()).toBe("");
    cleanup();
    openDesk(link(AUTO_MODEL));
    expect(noteText()).toBe("");
  });

  it("Auto on and off again after a gone link: the default the person was shown is the model, and the note does not come back", async () => {
    openDesk(link("vid-retired-2024"));
    expect(noteText()).toBe(gone());
    fireEvent.click(screen.getByTestId("gen-more").querySelector("summary") as HTMLElement);
    fireEvent.click(screen.getByTestId("gen-auto"));
    expect(noteText()).toBe("");
    fireEvent.click(screen.getByTestId("gen-auto"));
    expect(noteText()).toBe("");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fast");
    await waitFor(() => expect(quotes.at(-1)?.model).toBe("vid-fast"));
  });

  it("an honoured link's model says nothing on another tab (t2v -> i2v)", () => {
    openDesk(link("vid-fine"));
    fireEvent.click(document.getElementById("gen-tab-i2v") as HTMLElement);
    expect(noteText()).toBe("");
  });

  it("a gone link's note is about its own tool only: on another tab there is nothing to say", () => {
    openDesk(link("vid-retired-2024"));
    expect(noteText()).toBe(gone());
    fireEvent.click(document.getElementById("gen-tab-i2v") as HTMLElement);
    expect(noteText()).toBe("");
  });

  it("a feed \"Try again\" whose model was delisted gets the same neutral line, never link wording", () => {
    const job = {
      id: "22222222-2222-4222-8222-222222222222",
      capability: "t2v",
      status: "succeeded",
      requested_model: "vid-delisted",
      params: { prompt: "a paper boat", aspect_ratio: "16:9", duration_s: 5 },
      quoted_credits: 40,
      charged_credits: 40,
      error_code: null,
      result: null,
      result_asset_ids: [],
      created_at: "2026-11-01T00:00:00Z",
    } as StudioJob;
    const initial = prefillFromJob(job);
    expect(initial?.model).toBe("vid-delisted");
    openDesk(initial as StudioPrefill);
    expect(noteText()).toBe(gone());
    for (const l of ["en", "ru", "uz"] as const) {
      expect(dictionaries[l].gen.modelGone).not.toMatch(/link|ссылк|havola/i);
      expect(dictionaries[l].gen.modelGoneNamed).not.toMatch(/link|ссылк|havola/i);
    }
  });

  it("the note goes once the person picks a model themselves", async () => {
    openDesk(link("vid-retired-2024"));
    fireEvent.click(screen.getByTestId("gen-more").querySelector("summary") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("Video Fine"));
    await waitFor(() => expect(noteText()).toBe(""));
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Video Fine");
  });

  it("no price is shown in the note state until the server's quote is ready", async () => {
    hangQuote = true;
    openDesk(link("vid-retired-2024"));
    expect(screen.getByTestId("gen-model-gone")).toBeTruthy();
    await waitFor(() => expect(quotes.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("price-tag")).toBeNull();
    // the note names models, never a number
    expect(noteText()).toBe(gone());
  });

  it("every language has the line, in its own words", () => {
    for (const l of ["en", "ru", "uz"] as const) {
      const g = dictionaries[l].gen;
      expect(g.modelGone).toContain("{default}");
      expect(g.modelGoneNamed).toContain("{model}");
      expect(g.modelGoneNamed).toContain("{default}");
    }
    for (const l of ["ru", "uz"] as const) {
      expect(dictionaries[l].gen.modelGone).not.toBe(t.gen.modelGone);
      expect(dictionaries[l].gen.modelGoneNamed).not.toBe(t.gen.modelGoneNamed);
    }
    // Uzbek's okina is U+02BB, not an ASCII apostrophe
    expect(dictionaries.uz.gen.modelGone).toContain("So\u02BBralgan");
  });
});

describe("the link's model in the overview's composer (StudioHome)", () => {
  it("says the same line under the box, where the model pill shows the default's name", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} layout="composer" desk="video" initial={link("vid-retired-2024")} />));
    expect(noteText()).toBe(gone());
    expect(screen.getByTestId("composer-model").textContent).toContain("Video Fast");
    expect(screen.getAllByTestId("gen-model-gone")).toHaveLength(1);
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toContain("gen-model-gone");
  });

  it("an offered model draws no note there either", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} layout="composer" desk="video" initial={link("vid-fine")} />));
    expect(noteText()).toBe("");
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).not.toContain("gen-model-gone");
    expect(screen.getByTestId("composer-model").textContent).toContain("Video Fine");
  });
});

describe("what a link may carry into the form", () => {
  const base = link("");
  it.each([
    ['"><script>alert(1)</script>'],
    ["javascript:alert(1)"],
    ["../../admin"],
    ["a".repeat(41)],
    ["Vid-Fast"],
    [""],
  ])("a model id %j is never put into the form", (raw) => {
    expect(prefillModel(base, raw)?.model).toBe("");
  });

  it("a 40-character well-formed id is taken (the shape only; the panel decides whether it is on sale)", () => {
    const id = `v${"a".repeat(39)}`;
    expect(prefillModel(base, id)?.model).toBe(id);
  });

  it("a repeated `model` (an array) is not taken", () => {
    expect(prefillModel(base, ["vid-fast", "vid-fine"])?.model).toBe("");
  });

  it("a hostile id that reaches the panel anyway is shown as nothing but the generic line", () => {
    const { container } = openDesk(link('"><img src=x onerror=alert(1)>'));
    expect(noteText()).toBe(gone());
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("the words lose control, bidi and invisible characters and are bounded", () => {
    const words = cleanLinkPrompt("t2v", "a boat‮​\u0000 at dusk");
    expect(words).toBe("a boat at dusk");
    expect(prefillFromImprove(link(""), { prompt: "x".repeat(100_000) })?.prompt.length).toBeLessThanOrEqual(10_000);
  });

  it.each([["//evil.example/x"], ["https://evil.example/all-channels/create"], ["/\\evil.example"], ["javascript:alert(1)"], ["/api/x"], ["/all-channels/../api"]])(
    "sign-up's `next` %j never leaves the Studio form on this origin",
    (raw) => {
      expect(studioNext(raw)).toBeNull();
      expect(afterSignupPath(raw)).toBe("/welcome");
    },
  );

  it("a real sample link survives sign-up", () => {
    const next = "/all-channels/create?tool=t2v&model=vid-fast&prompt=a+boat";
    expect(afterSignupPath(next)).toBe(`/welcome?next=${encodeURIComponent(next)}`);
  });
});

describe("which surface a sample link opens", () => {
  it("?tool=t2v and ?tool=t2i open a media desk (GenerateSection) for a customer and for the owner, never the Create screen", () => {
    for (const tool of ["t2v", "t2i"]) {
      const desk = deskFromQuery({ tool });
      expect(desk).toBe(tool === "t2v" ? "video" : "image");
      expect(drawsCreateScreen({ desk, pendingFile: false, ownerFrame: false })).toBe(false);
      expect(drawsCreateScreen({ desk, pendingFile: false, ownerFrame: true })).toBe(false);
    }
  });
});

function fmt(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}
