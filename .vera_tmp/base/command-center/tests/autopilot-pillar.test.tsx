// @vitest-environment jsdom
/**
 * The YouTube Autopilot pillar (/solutions/youtube-channels: components/site/AutopilotPillar.tsx, AutopilotComposer.tsx,
 * lib/site/autopilot-pillar.ts). What would break:
 * - a "You stay in control" sentence drifting from the code it describes (the default privacy, the 24-hour approval, the
 *   switches that are off by default, the publish check running before the upload, the voice that stops the run);
 * - a stage's cost line claiming a measurement the cost ledger does not record, or a price the backend did not publish;
 * - the composer starting, pricing or fetching anything, or throwing away what the visitor typed;
 * - the page losing its one h1, its control section, its FAQ structured data, or growing an hreflang it cannot back;
 * - a competitor named in the copy (docs/research/competitors.md), or a language missing a string.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement, type ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, replace: _r, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; replace?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/solutions/youtube-channels",
  useRouter: () => ({ push() {}, refresh() {}, back() {}, replace() {}, prefetch() {} }),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  headers: async () => new Headers(),
}));
const dict = vi.hoisted(() => ({ locale: "en" as "en" | "ru" | "uz" }));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ locale: dict.locale, t: dictionaries[dict.locale] }), getLocale: async () => dict.locale };
});

import { dictionaries, LOCALES } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { pillarEn } from "@/lib/i18n/autopilot-pillar/en";
import { pillarRu } from "@/lib/i18n/autopilot-pillar/ru";
import { pillarUz } from "@/lib/i18n/autopilot-pillar/uz";
import {
  APPROVAL_HOURS,
  AUTO_PUBLISH_DEFAULT,
  DEFAULT_UPLOAD_PRIVACY,
  LEDGER_GROUPS,
  PILLAR_GENRES,
  PILLAR_STAGES,
  PUBLISH_ON_APPROVE_DEFAULT,
  VISIBILITY_WORKER_ENV,
  genreSeconds,
  pillarComposeHref,
} from "@/lib/site/autopilot-pillar";
import { APPROVE_REASONS, storedGate } from "@/lib/videoApproval";
import { afterSignupPath } from "@/lib/safe-redirect";
import { runPrefillFromQuery } from "@/lib/home";
import { AutopilotComposer } from "@/components/site/AutopilotComposer";
import { YT_DISCLOSURE_URL, YT_MONETIZATION_URL, pillarFaqEntries } from "@/components/site/AutopilotPillar";
import { PROVIDER_BRANDS } from "./helpers/brands";

afterEach(cleanup);

const REPO = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const MIGRATIONS = join(REPO, "supabase/migrations");
const migrations = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const COPIES = { en: pillarEn, ru: pillarRu, uz: pillarUz } as const;

type Node = string | number | boolean | null | Node[] | { [k: string]: Node };
const strings = (n: Node): string[] =>
  typeof n === "string" ? [n] : Array.isArray(n) ? n.flatMap(strings) : n && typeof n === "object" ? Object.values(n).flatMap(strings) : [];

// ── the control section, held to the code ───────────────────────────────────

describe("“You stay in control” says what the code does", () => {
  it("every upload asks for private: config.YOUTUBE_PRIVACY defaults to it", () => {
    expect(read("config.py")).toMatch(/^YOUTUBE_PRIVACY = os\.getenv\("YOUTUBE_PRIVACY", "private"\)/m);
    expect(DEFAULT_UPLOAD_PRIVACY).toBe("private");
    expect(pillarEn.control.steps.find((s) => s.id === "private")!.body).toMatch(/Every upload asks YouTube for private/);
  });

  it("an approval holds 24 hours in every definition of approve_video_publish, the newest included", () => {
    const defs = migrations.filter((f) => /create or replace function public\.approve_video_publish\(/.test(readFileSync(join(MIGRATIONS, f), "utf8")));
    expect(defs.length).toBeGreaterThanOrEqual(3);
    for (const f of defs) expect(readFileSync(join(MIGRATIONS, f), "utf8"), f).toMatch(/v_exp\s+timestamptz := now\(\) \+ interval '24 hours'/);
    expect(APPROVAL_HOURS).toBe(24);
  });

  it("“Publish when approved” and auto-publish are off for every channel, and nothing later turns either default on", () => {
    expect(read("supabase/migrations/0116_visibility_requests.sql")).toMatch(/add column if not exists publish_on_approve boolean not null default false;/);
    expect(read("supabase/migrations/0004_review.sql")).toMatch(/add column if not exists auto_publish boolean not null default false;/);
    for (const f of migrations) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      expect(sql, f).not.toMatch(/alter column (?:publish_on_approve|auto_publish) set default true/i);
    }
    expect(PUBLISH_ON_APPROVE_DEFAULT).toBe(false);
    expect(AUTO_PUBLISH_DEFAULT).toBe(false);
  });

  it("the worker that carries out “Publish when approved” is off unless its env says on", () => {
    expect(read("modules/visibility_publish.py")).toContain(`env.get("${VISIBILITY_WORKER_ENV}", "off")`);
    expect(pillarEn.control.branch.items[1]).toMatch(/itself off unless the server is set to run it/);
  });

  it("the publish check runs before the upload, and only an allowed video is uploaded", () => {
    const main = read("main.py");
    const gate = main.indexOf("gate = publish_gate.evaluate(");
    // The long video's upload (the Short's, earlier in the file, is a helper the run calls after this one).
    const upload = main.search(/uploaded = uploader\.upload\(\s*video_path, script, thumbnail_path=chosen_thumb, privacy=privacy,/);
    const allowedOnly = main.indexOf("if not skip_upload and gate.allowed and auto_publish and not awaiting_two_person:");
    expect(gate).toBeGreaterThan(0);
    expect(allowedOnly).toBeGreaterThan(gate);
    expect(upload).toBeGreaterThan(allowedOnly);
    const order = PILLAR_STAGES.map((s) => s.id);
    expect(order.indexOf("gate")).toBeLessThan(order.indexOf("upload"));
  });

  it("a new video uploads private until a person answers “made for kids”, even with auto-publish on", () => {
    expect(read("main.py")).toMatch(/held = mfk\.privacy_until_answered\(allowed, answered=False\)/);
    expect(pillarEn.control.steps.find((s) => s.id === "private")!.body).toMatch(/Even with the channel’s auto-publish switch on/);
  });

  it("a cut with no stored verdict is “unknown” and cannot be approved", () => {
    expect(storedGate({ gate_verdict: null })).toBeNull();
    expect(APPROVE_REASONS).toContain("gate_unknown");
    expect(read("supabase/migrations/0112_approve_video_publish.sql")).toMatch(/return 'gate_unknown';/);
    expect(pillarEn.control.unknown.items[0]).toMatch(/reads “unknown”, never “passed”, and cannot be approved/);
  });

  it("a fact-check that did not run blocks by default", () => {
    const gate = read("modules/publish_gate.py");
    expect(gate).toMatch(/block_on_fact_check: bool = True/);
    expect(gate).toMatch(/\(decision\.blocks if config\.block_on_fact_check else decision\.warnings\)\.append\(\s*"fact_check_not_run"/);
  });

  it("the channel's voice is checked before anything is paid for, and there is no fallback voice", () => {
    const main = read("main.py");
    expect(main.indexOf("verify_voice(ctx)")).toBeGreaterThan(0);
    expect(main.indexOf("verify_voice(ctx)")).toBeLessThan(main.indexOf("# ── Stages 1-2: Topic and Script"));
    expect(read("modules/audio_mixer.py")).toMatch(/def verify_voice\(channel=None\) -> None:/);
    expect(pillarEn.control.fallback.body).toMatch(/never narrates in a different, cheaper voice/);
  });

  it("contrasts with the category without naming anyone, and names no provider", () => {
    expect(pillarEn.control.lead).toMatch(/^Many autopilot tools publish automatically by default/);
    for (const [code, copy] of Object.entries(COPIES)) {
      for (const s of strings(copy as unknown as Node)) {
        expect(s, code).not.toMatch(PROVIDER_BRANDS);
        expect(s, code).not.toMatch(/openart|autoshorts|fableclip|faceless\.video|revid|invideo|pictory/i);
        expect(s, code).not.toMatch(/\b(?:owner|viewer)s?\b/i);
      }
    }
  });
});

// ── the stages and what they cost ───────────────────────────────────────────

/** Each ledger group's unit constants (modules/cost_ledger.py) and the line that records it for the stage that names it. */
const LEDGER: Record<(typeof LEDGER_GROUPS)[number], string[]> = {
  tokens: ["GEMINI_INPUT_TOKENS", "GEMINI_OUTPUT_TOKENS"],
  narration: ["TTS_CHARACTERS"],
  footage: ["PEXELS_REQUESTS", "VIDEO_GEN_CLIPS", "IMAGE_GENERATIONS"],
  render: ["RENDER_SECONDS"],
  upload: ["UPLOAD_BYTES"],
};
const RECORDED: Record<string, [file: string, line: RegExp]> = {
  topic: ["modules/topic_manager.py", /self\.costs\.add_gemini_usage\(response, stage="topic_gate"\)/],
  script: ["main.py", /costs\.add_gemini_usage\(engine\.last_response, stage="script"\)/],
  factcheck: ["main.py", /costs\.add_gemini_usage\(r, stage=grounding\.STAGE\)/],
  voice: ["main.py", /costs\.add\(TTS_CHARACTERS, mixer\.characters_synthesized, stage="voice"\)/],
  visuals: ["main.py", /costs\.add\(PEXELS_REQUESTS, fetcher\.searches_made, stage="media"\)/],
  render: ["main.py", /costs\.add\(RENDER_SECONDS, time\.monotonic\(\) - render_started, stage="render"\)/],
  upload: ["main.py", /costs\.add\(UPLOAD_BYTES, float\(video_path\.stat\(\)\.st_size\), stage="upload"\)/],
};

describe("the stages", () => {
  it("run in main.py's order, from topic to public", () => {
    expect(PILLAR_STAGES.map((s) => s.id)).toEqual(["topic", "research", "script", "factcheck", "voice", "visuals", "render", "gate", "upload", "approve", "public"]);
  });

  it("claim a measurement only where the cost ledger records one, in a unit it defines", () => {
    const ledger = read("modules/cost_ledger.py");
    for (const units of Object.values(LEDGER)) for (const u of units) expect(ledger).toMatch(new RegExp(`^${u} = "${u.toLowerCase()}"`, "m"));
    for (const stage of PILLAR_STAGES) {
      if (!stage.meters) {
        expect(RECORDED[stage.id], stage.id).toBeUndefined();
        continue;
      }
      const [file, line] = RECORDED[stage.id];
      expect(read(file), stage.id).toMatch(line);
    }
  });

  it("charge nothing after the upload, and the failure path is the release the credit code describes", () => {
    expect(PILLAR_STAGES.filter((s) => !s.paid).map((s) => s.id)).toEqual(["approve", "public"]);
    expect(read("modules/credits.py")).toMatch(/A failed run is released in full/);
    expect(read("modules/publish_gate.py")).toMatch(/release the credit hold instead of capturing it/);
  });

  it.each(Object.entries(COPIES))("%s: one line per stage, in the same order, and a word for every ledger group", (_, copy) => {
    expect(copy.stages.items.map((i) => i.id)).toEqual(PILLAR_STAGES.map((s) => s.id));
    expect(Object.keys(copy.stages.ledger).sort()).toEqual([...LEDGER_GROUPS].sort());
    expect(copy.composer.items.map((i) => i.id)).toEqual(PILLAR_GENRES.map((g) => g.id));
    expect(copy.faq.items.map((i) => i.id)).toEqual(pillarEn.faq.items.map((i) => i.id));
  });

  it("uz: oʻ and gʻ with U+02BB, never a quote mark", () => {
    for (const s of strings(pillarUz as unknown as Node)) expect(s).not.toMatch(/[oOgG][‘’']/);
  });
});

// ── the composer ────────────────────────────────────────────────────────────

describe("the composer only fills the run form", () => {
  it("links to sign-up and then the run form, with the topic, the genre's length and the language", () => {
    const href = pillarComposeHref("The Flannan Isles Lighthouse Mystery", "mystery", "English")!;
    expect(href.startsWith("/signup?next=")).toBe(true);
    const next = decodeURIComponent(href.slice("/signup?next=".length));
    expect(afterSignupPath(next)).not.toBe("/welcome");
    const q = Object.fromEntries(new URL(next, "https://x.invalid").searchParams);
    expect(runPrefillFromQuery(q)).toEqual({ brief: "The Flannan Isles Lighthouse Mystery", duration: String(genreSeconds("mystery")), language: "English" });
  });

  it("carries “made for kids” only from the kids genre", () => {
    const kids = decodeURIComponent(pillarComposeHref("A turtle", "kids", "Uzbek")!);
    expect(kids).toContain("format=kids");
    expect(decodeURIComponent(pillarComposeHref("A library", "history", "Uzbek")!)).not.toContain("format=");
  });

  it("asks for a topic instead of opening an empty form, and cuts a long one so it still survives sign-up", () => {
    expect(pillarComposeHref("   ", "history", "English")).toBeNull();
    const long = "Тайна маяка на островах Фланнан и трёх смотрителей ".repeat(8);
    const href = pillarComposeHref(long, "mystery", "Russian")!;
    expect(href.startsWith("/signup?next=")).toBe(true);
    expect(afterSignupPath(decodeURIComponent(href.slice("/signup?next=".length)))).not.toBe("/welcome");
  });

  it("fills a genre's starter, keeps what the visitor typed, shows the COPPA note only for kids, and never fetches", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("no network here")));
    try {
      render(<AutopilotComposer copy={pillarEn.composer} language="English" />);
      const box = screen.getByRole("textbox", { name: pillarEn.composer.label }) as HTMLTextAreaElement;
      expect(box.value).toBe("The Flannan Isles Lighthouse Mystery");
      expect(screen.queryByRole("note")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Kids" }));
      expect(box.value).toBe(pillarEn.composer.items.find((i) => i.id === "kids")!.starter);
      expect(screen.getByRole("note").textContent).toMatch(/COPPA/);
      expect(screen.getByRole("link", { name: pillarEn.composer.go }).getAttribute("href")).toContain(encodeURIComponent("format=kids"));
      fireEvent.change(box, { target: { value: "My own topic" } });
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      expect(box.value).toBe("My own topic");
      expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.change(box, { target: { value: "" } });
      expect(screen.queryByRole("link", { name: pillarEn.composer.go })).toBeNull();
      expect((screen.getByRole("button", { name: pillarEn.composer.go }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("status").textContent).toBe(pillarEn.composer.empty);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── the page ────────────────────────────────────────────────────────────────

const PROPS = { params: Promise.resolve({ slug: "youtube-channels" }) };

async function pageHtml(locale: "en" | "ru" | "uz"): Promise<string> {
  dict.locale = locale;
  const mod = await import("@/app/solutions/[slug]/page");
  const el = (await mod.default(PROPS)) as ReactElement;
  return renderToStaticMarkup(createElement(PublicI18nProvider, { locale, t: publicDictionary(dictionaries[locale]), children: el }));
}

describe.each(LOCALES.map((l) => l.code))("/solutions/youtube-channels in %s", (locale) => {
  const p = dictionaries[locale].site.autopilot.pillar;

  it("renders one h1, the stages, the control section with its 24 hours, the questions and the sample file", async () => {
    const html = await pageHtml(locale);
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    for (const id of ["stages", "control", "faq"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("samples/demo_script.json");
    expect(html).toContain("The Flannan Isles Lighthouse Mystery");
    const approve = p.control.steps.find((s) => s.id === "approve")!.body.replace("{hours}", String(APPROVAL_HOURS));
    expect(html).toContain(approve);
    expect(html).not.toContain("{hours}");
    // No backend in the test: the price line says no rate is published, never a number.
    expect(html).toContain(p.stages.priceUnknown);
    expect(html).toContain(`href="${YT_MONETIZATION_URL}"`);
    expect(html).toContain(`href="${YT_DISCLOSURE_URL}"`);
  }, 60_000);

  it("states its FAQ and HowTo as the same text the page prints", async () => {
    const html = await pageHtml(locale);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const faq = blocks.find((b) => b["@type"] === "FAQPage");
    const howTo = blocks.find((b) => b["@type"] === "HowTo");
    expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(pillarFaqEntries(dictionaries[locale]).map((e) => e.q));
    expect(faq.mainEntity.map((q: { acceptedAnswer: { text: string } }) => q.acceptedAnswer.text)).toEqual(p.faq.items.map((i) => i.a));
    const page = dictionaries[locale].site.solutions.pages.find((x) => x.id === "youtube-channels")!;
    expect(howTo.step.map((s: { text: string }) => s.text)).toEqual([...page.start]);
    expect(howTo.inLanguage).toBe(locale);
  }, 60_000);

  it("has its own title and description, a self-referencing canonical, and no hreflang (one URL serves every language)", async () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    try {
      dict.locale = locale;
      const mod = await import("@/app/solutions/[slug]/page");
      const m = (await mod.generateMetadata(PROPS)) as { title: { absolute: string }; description: string; alternates?: { canonical?: string; languages?: unknown } };
      expect(m.title.absolute).toBe(`${p.meta.title} · ${dictionaries[locale].brand.name}`);
      expect(m.title.absolute.length).toBeLessThanOrEqual(70);
      expect(m.description).toBe(p.meta.description);
      expect(m.description.length).toBeGreaterThanOrEqual(40);
      expect(m.description.length).toBeLessThanOrEqual(160);
      expect(m.alternates?.canonical).toBe("/solutions/youtube-channels");
      expect(m.alternates).not.toHaveProperty("languages");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("autopilot-pillar.css", () => {
  const css = readFileSync(join(__dirname, "..", "components/site/autopilot-pillar.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("styles only .nx-pl-* classes, with tokens, nothing under 13px, and moves nothing unless motion is allowed", () => {
    const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter((x) => x && !x.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(30);
    for (const group of selectors) for (const sel of group.split(",").map((x) => x.trim())) expect(sel, sel).toMatch(/\.nx-pl-/);
    expect([...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n < 13)).toEqual([]);
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) expect(m[1]).toMatch(/^--(?:ns-|font-mono$)/);
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, "");
    expect(outside).not.toMatch(/\btransition\s*:|\banimation\s*:/);
    expect(css).toMatch(/\.nx-pl-genre \{[^}]*min-height: 44px;/);
  });
});
