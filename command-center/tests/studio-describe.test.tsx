// @vitest-environment jsdom
/**
 * Describe image (migration 0055): a library picture -> a generation prompt,
 * as text. It goes the same priced way as every tool — the database quotes
 * it, the price is on the button ("Describe · N credits"), the press sends
 * that price as max_credits with one idempotency key — and its params are
 * exactly what 0055 accepts: the picture and, optionally, the language. The
 * finished text is shown with Copy and "Make similar", which only FILLS the
 * image form; "Describe" on a finished picture only fills the composer. None
 * of them spends.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import {
  CREATIVE_CAPABILITIES,
  DESCRIBE_LANGUAGES,
  PARAM_KEYS,
  SOURCE_CAPABILITIES,
  parseGenerationInput,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";
import { STUDIO_TOOLS } from "@/lib/navigation";
import {
  COMPOSER_CAPABILITIES,
  DESCRIBE_MAX,
  buildParams,
  canQuote,
  defaultDescribeLanguage,
  describePrefill,
  describeResult,
  generateLabel,
  nearestAspect,
  outputKind,
  prefillFromJob,
  prefillFromQuery,
  promptRule,
  sheetQuoteParams,
  similarPrefill,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const OUT = "33333333-3333-4333-8333-333333333333";
const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0055_describe_image.sql"), "utf8");

/** The body of a function in 0055, for pins against the code. */
function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL);
  if (!m) throw new Error(`no ${name} in 0055`);
  return m[1] + m[2];
}

const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "describe",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: PIC,
  factor: 2,
  ...over,
});

const job = (over: Partial<StudioJob>): StudioJob => ({
  id: "j-describe",
  capability: "describe",
  status: "completed",
  requested_model: "seer",
  params: { source_asset_id: PIC, language: "en" },
  quoted_credits: 2,
  charged_credits: 2,
  error_code: null,
  result: { text: "A lighthouse on a rocky coast at dawn, soft fog, warm light.", language: "en", width: 1080, height: 1920 },
  result_asset_ids: [],
  created_at: "2026-10-01T10:00:00Z",
  ...over,
});

const MODELS: StudioModel[] = [
  { id: "seer", displayName: "Picture reader", capabilities: ["describe"], beta: true },
  { id: "img", displayName: "Image model", capabilities: ["t2i", "edit"], beta: false },
];

const libraryBody = {
  available: true,
  assets: [
    {
      id: PIC, kind: "image", mime: "image/png", bytes: 2048, width: 1080, height: 1920, durationS: null, source: "upload",
      name: "lighthouse.png", variants: ["thumb"], version: 1, createdAt: "2026-09-30T10:00:00Z",
      thumbUrl: `/t/${PIC}`, viewUrl: `/v/${PIC}`,
    },
    {
      id: OUT, kind: "image", mime: "image/png", bytes: 2048, width: 1024, height: 1024, durationS: null, source: "generated",
      name: "out.png", variants: ["thumb"], version: 1, createdAt: "2026-09-30T10:00:00Z",
      thumbUrl: `/t/${OUT}`, viewUrl: `/v/${OUT}`,
    },
  ],
  uploads: [],
};

let quotes: Array<Record<string, unknown>>;
let creates: Array<Record<string, unknown>>;
let feed: StudioJob[];
beforeEach(() => {
  quotes = [];
  creates = [];
  feed = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/media")) return json(libraryBody);
      if (url === "/api/creative/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return json({ quote: { credits: 2 } });
      }
      if (url === "/api/creative/jobs" && init?.method === "POST") {
        creates.push(JSON.parse(String(init.body)));
        return json({ job: { id: "j1" } }, 201);
      }
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: feed });
      if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── the request ──────────────────────────────────────────────────────────────

describe("the request (0055's rules)", () => {
  it("is the picture and the language — never words, a shape or a style", () => {
    expect(buildParams(form({ describeLanguage: "uz", prompt: "make it a cat", styleKitId: OUT }))).toEqual({
      source_asset_id: PIC,
      language: "uz",
    });
    expect(buildParams(form({}))).toEqual({ source_asset_id: PIC });
    expect(promptRule("describe")).toBe("none");
  });

  it("asks for a price only once a picture is picked, and the sheet prices it the same way", () => {
    expect(canQuote(form({ sourceId: null }))).toBe(false);
    expect(canQuote(form({}))).toBe(true);
    expect(sheetQuoteParams(form({ sourceId: null }))).toBeNull();
    expect(sheetQuoteParams(form({ describeLanguage: "ru" }))).toEqual({ source_asset_id: PIC, language: "ru" });
  });

  it("the route refuses what 0055 refuses", () => {
    const parse = (capability: string, params: Record<string, unknown>) =>
      parseGenerationInput({ capability, model: "seer", params, max_credits: 2 }, ORG, { requirePrice: true });
    expect(parse("describe", { source_asset_id: PIC, language: "ru" }).ok).toBe(true);
    for (const bad of [
      { source_asset_id: "https://169.254.169.254/latest" },
      { source_asset_id: PIC, language: "de" },
      { source_asset_id: PIC, language: "EN" },
    ]) {
      const r = parse("describe", bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parse("t2i", { prompt: "x", language: "en" }).ok).toBe(false);
    // The price the person confirmed is required.
    const unpriced = parseGenerationInput({ capability: "describe", model: "seer", params: { source_asset_id: PIC } }, ORG, {
      requirePrice: true,
    });
    expect(unpriced.ok).toBe(false);
  });

  it("the button says what the press buys", () => {
    expect(generateLabel(t, { status: "ready", credits: 2 }, "en", "describe")).toBe("Describe · 2 credits");
    expect(generateLabel(t, { status: "idle" }, "en", "describe")).toBe("Describe");
    expect(generateLabel(t, { status: "ready", credits: 2 }, "en", "t2i")).toBe("Generate · 2 credits");
  });

  it("starts in the language the app is read in", () => {
    expect(defaultDescribeLanguage("uz")).toBe("uz");
    expect(defaultDescribeLanguage("ru")).toBe("ru");
    expect(defaultDescribeLanguage("de")).toBe("en");
  });
});

// ── pinned to the database ───────────────────────────────────────────────────

describe("pinned to 0055", () => {
  it("every capability and param key the code sends is one 0055 accepts", () => {
    const supported = fn("creative_capability_supported");
    // captions (0072) is pinned to 0072, which replaces these functions on top of 0055's.
    for (const c of CREATIVE_CAPABILITIES) if (c !== "captions") expect(supported, c).toContain(`'${c}'`);
    const params = fn("creative_params_problem");
    for (const k of PARAM_KEYS) expect(params, k).toContain(`'${k}'`);
    expect(CAPABILITIES as readonly string[]).toContain("describe");
  });

  it("the language allow-list is the same in the code and the database", () => {
    expect(fn("creative_params_problem")).toContain(`not in (${DESCRIBE_LANGUAGES.map((l) => `'${l}'`).join(", ")})`);
  });

  it("a description is one request, and never a library asset", () => {
    expect(fn("creative_quantity")).toContain("when p_capability = 'describe' then 1::numeric");
    expect(SQL).toContain("cardinality(result_asset_ids) = 0");
    expect(SQL).toContain(`between 1 and ${DESCRIBE_MAX}`);
  });

  it("the picture check is 0046's: another organization's picture reads like a missing one", () => {
    expect(fn("creative_source_problem")).toContain("'edit', 'i2v', 'upscale', 'remove_bg', 'describe'");
    expect(fn("creative_source_problem")).toContain("and org_id = p_org");
  });

  it("a model that writes text is read from the registry", () => {
    const [m] = coerceSellableModels([
      {
        id: "seer", display_name: "Picture reader", provider: "acme", capabilities: ["describe"], availability: "beta",
        verified_at: "2026-10-01T00:00:00Z", credit_unit: "model_seer_request", entitlement: null, credits_per_unit: 0.5,
        margin: 0, spec: { output: "text", unit: "request", limits: { max_prompt_chars: 4000, max_concurrent_per_org: 4 } },
      },
    ]);
    expect(m?.spec.output).toBe("text");
  });
});

// ── where it is offered ──────────────────────────────────────────────────────

describe("where Describe is offered", () => {
  it("is a composer tool and a sidebar tool, and the Library's picture links offer it", () => {
    expect(COMPOSER_CAPABILITIES).toContain("describe");
    expect(STUDIO_TOOLS).toContain("describe");
    expect(SOURCE_CAPABILITIES).toContain("describe");
    expect(outputKind("describe")).toBe("text");
    expect(prefillFromQuery("describe", PIC)).toMatchObject({ capability: "describe", sourceId: PIC });
    expect(prefillFromQuery("describe", "https://evil.example/a.png")).toBeNull();
  });

  it("every language names it", () => {
    for (const d of Object.values(dictionaries)) {
      for (const k of [d.gen.tabs.describe, d.gen.kinds.describe, d.gen.describeNote, d.gen.copy, d.gen.makeSimilar]) {
        expect(k.trim()).not.toBe("");
      }
      expect(d.gen.describePriced).toContain("{n}");
    }
  });

  it("customer copy names no provider", () => {
    for (const d of Object.values(dictionaries)) {
      const copy = JSON.stringify([
        d.gen.describeNote, d.gen.describe, d.gen.describePriced, d.gen.describeAction, d.gen.makeSimilar,
        d.gen.makeSimilarHint, d.gen.tabs.describe, d.gen.kinds.describe, d.gen.describeLanguageLabel,
      ]).toLowerCase();
      for (const brand of ["gemini", "google", "openai", "gpt", "claude", "anthropic"]) expect(copy).not.toContain(brand);
    }
  });
});

// ── the result ───────────────────────────────────────────────────────────────

describe("the result", () => {
  it("is the text, the language and the picture's size — or nothing", () => {
    expect(describeResult(job({}))).toEqual({
      text: "A lighthouse on a rocky coast at dawn, soft fog, warm light.",
      language: "en",
      width: 1080,
      height: 1920,
    });
    expect(describeResult(job({ status: "processing" }))).toBeNull();
    expect(describeResult(job({ capability: "t2i" }))).toBeNull();
    expect(describeResult(job({ result: { text: "   " } }))).toBeNull();
    expect(describeResult(job({ result: { text: "x".repeat(900) } }))?.text).toHaveLength(DESCRIBE_MAX);
  });

  it("Make similar fills the image form with the text and the picture's shape", () => {
    const d = describeResult(job({}))!;
    expect(similarPrefill(d)).toEqual({ capability: "t2i", model: "", prompt: d.text, aspect: "9:16", duration: 5 });
    expect(nearestAspect(1920, 1080)).toBe("16:9");
    expect(nearestAspect(1000, 1100)).toBe("1:1");
    expect(nearestAspect(null, null)).toBe("16:9");
  });

  it("Try again on a failed description keeps the picture and the language", () => {
    expect(prefillFromJob(job({ status: "failed", params: { source_asset_id: PIC, language: "ru" } }))).toMatchObject({
      capability: "describe",
      sourceId: PIC,
      describeLanguage: "ru",
    });
    expect(describePrefill("not-an-id", "en")).toBeNull();
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

describe("the composer on Describe", () => {
  it("shows the price on the button and the press sends exactly the picture, the language and that price", async () => {
    render(
      withI18n(
        <GeneratePanel orgId={ORG} models={MODELS} initial={describePrefill(PIC, "uz")} />,
        "uz",
      ),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    const button = await screen.findByRole("button", { name: /Tasvirlash · 2 kredit/ });
    expect(quotes.at(-1)).toMatchObject({ capability: "describe", model: "seer", params: { source_asset_id: PIC, language: "uz" } });
    expect(creates).toHaveLength(0);
    fireEvent.click(button);
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({
      capability: "describe",
      params: { source_asset_id: PIC, language: "uz" },
      max_credits: 2,
    });
    expect(String(creates[0].idempotency_key)).toMatch(/^studio:/);
  });

  it("the language chips change what is priced", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={describePrefill(PIC, "en")} />));
    await screen.findByRole("button", { name: /Describe · 2 credits/ });
    const group = screen.getByRole("group", { name: t.gen.describeLanguageLabel });
    fireEvent.click(within(group).getByRole("button", { name: t.gen.languages.ru }));
    await waitFor(() => expect(quotes.at(-1)).toMatchObject({ params: { source_asset_id: PIC, language: "ru" } }));
    expect(creates).toHaveLength(0);
  });
});

// ── the feed ─────────────────────────────────────────────────────────────────

describe("the feed", () => {
  it("shows a description with Copy and Make similar, and neither spends", async () => {
    feed = [job({})];
    const onMakeSimilar = vi.fn();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(withI18n(<JobFeed orgId={ORG} models={MODELS} onMakeSimilar={onMakeSimilar} />));
    const text = await screen.findByTestId("describe-text");
    expect(text.textContent).toBe("A lighthouse on a rocky coast at dawn, soft fog, warm light.");
    expect(text.getAttribute("lang")).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: t.gen.copy }));
    await screen.findByRole("button", { name: t.gen.copied });
    expect(writeText).toHaveBeenCalledWith("A lighthouse on a rocky coast at dawn, soft fog, warm light.");

    fireEvent.click(screen.getByRole("button", { name: t.gen.makeSimilar }));
    expect(onMakeSimilar).toHaveBeenCalledWith({
      capability: "t2i",
      model: "",
      prompt: "A lighthouse on a rocky coast at dawn, soft fog, warm light.",
      aspect: "9:16",
      duration: 5,
    });
    expect(creates).toHaveLength(0);
    expect(quotes).toHaveLength(0);
  });

  it("says so when the clipboard is not available, and the text stays selectable", async () => {
    feed = [job({})];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    render(withI18n(<JobFeed orgId={ORG} models={MODELS} onMakeSimilar={vi.fn()} />));
    fireEvent.click(await screen.findByRole("button", { name: t.gen.copy }));
    expect(await screen.findByText(t.gen.copyFailed)).toBeTruthy();
  });

  it("offers Describe on a finished picture, which only fills the composer", async () => {
    feed = [
      job({ id: "j-img", capability: "t2i", params: { prompt: "a red apple" }, result: { files: [] }, result_asset_ids: [OUT] }),
    ];
    const onDescribe = vi.fn();
    render(withI18n(<JobFeed orgId={ORG} models={MODELS} onDescribe={onDescribe} />));
    fireEvent.click(await screen.findByRole("button", { name: t.gen.describeAction }));
    expect(onDescribe).toHaveBeenCalledWith(OUT);
    expect(creates).toHaveLength(0);
    expect(quotes).toHaveLength(0);
  });

  it("a failed description shows no text, says the credits came back, and offers Try again", async () => {
    feed = [job({ status: "failed", error_code: "bad_response", result: null, charged_credits: 0 })];
    render(withI18n(<JobFeed orgId={ORG} models={MODELS} onRetry={vi.fn()} />));
    expect(await screen.findByRole("button", { name: t.gen.tryAgain })).toBeTruthy();
    expect(screen.queryByTestId("describe-text")).toBeNull();
    expect(screen.getByText(t.gen.returned)).toBeTruthy();
  });
});
