// @vitest-environment jsdom
/**
 * A model whose registry spec lists NO aspect ratio (an empty `aspect_ratios`) makes its own shape: the Studio offers no
 * shape for a text picture / text video on it and never sends `aspect_ratio`. Without this, the form's default 16:9 rode
 * along on every picture job, and a model that refuses the option behind the shape (the first probe of the hidden grounded
 * picture model, 2026-11-12: its vendor refused the tool that carries the shape) failed every job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({
  useChannelPath: () => (p: string) => `/chronos${p}`,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import {
  buildParams,
  withTiers,
  type StudioForm,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => (
  <I18nProvider locale="en">{ui}</I18nProvider>
);
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const SHAPELESS: StudioModel = {
  id: "own-shape",
  displayName: "Own Shape",
  capabilities: ["t2i", "edit"],
  beta: false,
  fixedShape: true,
};
const SHAPED: StudioModel = {
  id: "shaped",
  displayName: "Shaped",
  capabilities: ["t2i", "edit"],
  beta: false,
};
const SHAPELESS_VIDEO: StudioModel = {
  id: "own-shape-video",
  displayName: "Own Shape Video",
  capabilities: ["t2v"],
  beta: false,
  fixedShape: true,
};

let quotes: Array<{
  model: string;
  capability: string;
  params: Record<string, unknown>;
}>;
let fetchMock: ReturnType<typeof vi.fn>;
const creates = () =>
  fetchMock.mock.calls.filter(
    ([u, init]) =>
      u === "/api/creative/jobs" &&
      (init as RequestInit | undefined)?.method === "POST",
  );

beforeEach(() => {
  quotes = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      quotes.push(JSON.parse(String(init?.body)));
      return json({ quote: { credits: 1 } });
    }
    if (url === "/api/creative/jobs" && init?.method === "POST")
      return json({ job: { id: "j1" }, replay: false }, 201);
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/style-kits"))
      return json({ error: "not_available" }, 503);
    if (url.startsWith("/api/media"))
      return json({ available: true, assets: [], uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "t2i",
  prompt: "a red apple",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

describe("the request for a model that makes its own shape", () => {
  it("leaves aspect_ratio out of a text picture and a text video, and keeps everything else", () => {
    expect(buildParams(form({ noAspect: true }))).toEqual({
      prompt: "a red apple",
    });
    expect(buildParams(form({ capability: "t2v", noAspect: true }))).toEqual({
      prompt: "a red apple",
      duration_s: 5,
    });
  });

  it("sends the shape as before when the model takes one (or nothing is known)", () => {
    expect(buildParams(form({}))).toEqual({
      prompt: "a red apple",
      aspect_ratio: "16:9",
    });
    expect(buildParams(form({ noAspect: false }))).toEqual({
      prompt: "a red apple",
      aspect_ratio: "16:9",
    });
    expect(buildParams(form({ noAspect: null }))).toEqual({
      prompt: "a red apple",
      aspect_ratio: "16:9",
    });
    expect(buildParams(form({ capability: "t2v" }))).toEqual({
      prompt: "a red apple",
      aspect_ratio: "16:9",
      duration_s: 5,
    });
  });
});

describe("the model's spec decides", () => {
  const base: StudioModel = {
    id: "m",
    displayName: "M",
    capabilities: ["t2i"],
    beta: false,
  };
  const row = (spec: Record<string, unknown>) => [{ id: "m", spec }];

  it("an empty aspect_ratios list marks the model as making its own shape", () => {
    expect(withTiers([base], row({ aspect_ratios: [] }))[0].fixedShape).toBe(
      true,
    );
  });

  it("a spec that lists shapes, or says nothing about them, keeps the shape picker", () => {
    expect(
      withTiers([base], row({ aspect_ratios: ["1:1", "16:9"] }))[0],
    ).not.toHaveProperty("fixedShape");
    expect(withTiers([base], row({}))[0]).not.toHaveProperty("fixedShape");
    expect(
      withTiers([base], row({ aspect_ratios: null }))[0],
    ).not.toHaveProperty("fixedShape");
    // The sellable rows did not answer: nothing is assumed.
    expect(withTiers([base], null)[0]).not.toHaveProperty("fixedShape");
  });
});

// The real registry file: the entries that list no shape today. All four older ones were hidden and never probed on
// 2026-11-13 (no Studio job could reach them yet); once they are on sale they get no shape, the call their adapters make.
type Entry = { id: string; capabilities: string[]; aspect_ratios: string[] };
const REGISTRY = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "schemas", "model_registry.json"),
    "utf8",
  ),
) as { models: Entry[] };
const entry = (id: string): Entry => {
  const e = REGISTRY.models.find((m) => m.id === id);
  if (!e) throw new Error(`${id} is not in the registry`);
  return e;
};
// What sellable_models() / operator_preview_models() hand the Studio: the id and the public half of spec.
const asStudio = (e: Entry): StudioModel =>
  withTiers(
    [
      {
        id: e.id,
        displayName: e.id,
        capabilities: e.capabilities,
        beta: false,
      },
    ],
    [{ id: e.id, spec: { aspect_ratios: e.aspect_ratios } }],
  )[0];

describe("the registry entries that list no shape", () => {
  it.each([
    ["grounded-image-1.0", "t2i"],
    ["ideogram-4", "t2i"],
    ["minimax-hailuo-2.3", "t2v"],
    ["flux-3-video", "t2v"],
    ["pika-2.5", "t2v"],
  ] as const)("%s is sent no aspect_ratio for %s", (id, capability) => {
    const e = entry(id);
    expect(e.aspect_ratios).toEqual([]);
    expect(e.capabilities).toContain(capability);
    const model = asStudio(e);
    expect(model.fixedShape).toBe(true);
    const params = buildParams(
      form({ capability, noAspect: model.fixedShape }),
    );
    expect(params).not.toHaveProperty("aspect_ratio");
    expect(params).toMatchObject({ prompt: "a red apple" });
  });

  it("an entry that lists shapes keeps them", () => {
    const shaped = REGISTRY.models.find(
      (m) => m.capabilities.includes("t2i") && m.aspect_ratios.includes("16:9"),
    );
    expect(shaped).toBeTruthy();
    const model = asStudio(shaped as Entry);
    expect(model).not.toHaveProperty("fixedShape");
    expect(buildParams(form({ noAspect: model.fixedShape }))).toEqual({
      prompt: "a red apple",
      aspect_ratio: "16:9",
    });
  });

  it("the panel sends ideogram-4 no shape", async () => {
    render(
      withI18n(
        <GeneratePanel orgId={ORG} models={[asStudio(entry("ideogram-4"))]} />,
      ),
    );
    expect(screen.queryByRole("group", { name: t.gen.aspectLabel })).toBeNull();
    fireEvent.change(
      document.getElementById("gen-prompt") as HTMLTextAreaElement,
      { target: { value: "a red kite" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Generate · 1 credits/ }),
    );
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(
      JSON.parse(String((creates()[0][1] as RequestInit).body)).params,
    ).toEqual({ prompt: "a red kite" });
  });
});

describe("the panel", () => {
  it("offers no shape for a text picture on such a model, and quotes and creates without one", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SHAPELESS]} />));
    expect(screen.queryByRole("group", { name: t.gen.aspectLabel })).toBeNull();
    fireEvent.change(
      document.getElementById("gen-prompt") as HTMLTextAreaElement,
      { target: { value: "a red kite" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Generate · 1 credits/ }),
    );
    await waitFor(() => expect(creates()).toHaveLength(1));
    const sent = JSON.parse(String((creates()[0][1] as RequestInit).body));
    expect(sent.params).toEqual({ prompt: "a red kite" });
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((q) => !("aspect_ratio" in q.params))).toBe(true);
  });

  it("offers no shape for a text video on such a model, but still the length", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SHAPELESS_VIDEO]} />));
    expect(screen.queryByRole("group", { name: t.gen.aspectLabel })).toBeNull();
    expect(
      screen.getByRole("group", { name: t.gen.durationLabel }),
    ).toBeTruthy();
    fireEvent.change(
      document.getElementById("gen-prompt") as HTMLTextAreaElement,
      { target: { value: "a red kite" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Generate · 1 credits/ }),
    );
    await waitFor(() => expect(creates()).toHaveLength(1));
    const sent = JSON.parse(String((creates()[0][1] as RequestInit).body));
    expect(sent.params).not.toHaveProperty("aspect_ratio");
    expect(sent.params).toMatchObject({ prompt: "a red kite", duration_s: 5 });
  });

  it("still offers and sends the shape for a model that takes one", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SHAPED]} />));
    expect(screen.getByRole("group", { name: t.gen.aspectLabel })).toBeTruthy();
    fireEvent.change(
      document.getElementById("gen-prompt") as HTMLTextAreaElement,
      { target: { value: "a red kite" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Generate · 1 credits/ }),
    );
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(
      JSON.parse(String((creates()[0][1] as RequestInit).body)).params,
    ).toEqual({ prompt: "a red kite", aspect_ratio: "16:9" });
  });
});
