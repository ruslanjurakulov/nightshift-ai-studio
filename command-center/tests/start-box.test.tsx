// @vitest-environment jsdom
/**
 * The app's start box (components/prompt/StartBox.tsx, lib/start-box.ts, lib/nightshift-ai-flag.ts). What would break without
 * these: a closed Agent chip that still opens Nightshift AI (`ai=new`), a format that is not the closed enum riding in an address,
 * a typo in NIGHTSHIFT_AI_CHAT opening the assistant for everyone, a template drawn under two purposes or an empty purpose drawn
 * as a heading with nothing under it, `/studio?ai=new` landing on a page that ignores it, and the box itself posting a job, a
 * quote or an agent call (CLAUDE.md rule 3: the box is a link and nothing more).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-channel/home",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (section: string) => `/my-channel${section}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { StartBox } from "@/components/prompt/StartBox";
import { TOPIC_MAX } from "@/lib/home";
import { IDEA_KEY } from "@/lib/site/idea-handoff";
import { TEMPLATE_CATEGORIES, type TemplateDto } from "@/lib/templates/trends";
import {
  PURPOSE_CATEGORIES,
  START_FORMATS,
  START_TABS,
  TEMPLATE_PURPOSES,
  groupTemplates,
  isStartFormat,
  startRoute,
  studioAiFallback,
  type StartChoice,
} from "@/lib/start-box";
import { aiChatMode, aiChatOrgs, nightshiftAiAccess, nightshiftAiOpen, type NightshiftAiAccess } from "@/lib/nightshift-ai-flag";
import { aiPlanOf } from "@/lib/server/nightshift-ai";

vi.mock("server-only", () => ({}));

const ORG = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const ctx = (channel: string | null = "my-channel") => ({ path: (s: string) => `/my-channel${s}`, channel, language: "English" as const });
const params = (href: string) => new URL(href, "https://x.test").searchParams;

// ── routing ─────────────────────────────────────────────────────────────────

describe("where the send key goes: every tab × Agent (open/closed, on/off) × format", () => {
  const cases: StartChoice[] = [];
  for (const tab of START_TABS)
    for (const agentOpen of [true, false])
      for (const agent of [true, false]) for (const format of START_FORMATS) cases.push({ tab, agent, agentOpen, format, kind: "video" });

  it.each(cases)("%o is an address on this channel, and a closed Agent never yields ai=new", (c) => {
    const r = startRoute(c, "A lighthouse keeper finds a bottle", ctx());
    expect(r.href.startsWith("/my-channel/")).toBe(true);
    const q = params(r.href);
    if (!c.agentOpen || !c.agent || c.tab === "edit") expect(q.has("ai")).toBe(false);
    // The words never ride in the address unless they are a short channel topic (the run form's own contract).
    if (r.via === "idea") expect(r.href).not.toContain("lighthouse");
    // `format` is only ever one of the closed enum.
    if (q.has("format")) expect(isStartFormat(q.get("format"))).toBe(true);
  });

  it("Agent on and open: Nightshift AI with the words kept in this browser and the format as a closed enum", () => {
    for (const format of START_FORMATS) {
      const r = startRoute({ tab: "create", agent: true, agentOpen: true, format, kind: "video" }, "x", ctx());
      expect(r).toEqual({ via: "idea", href: `/my-channel/studio?ai=new&idea=1&format=${format}`, fallback: null });
    }
  });

  it("Agent on but closed is the same as off: never the assistant", () => {
    const on = startRoute({ tab: "create", agent: true, agentOpen: false, format: "film", kind: "video" }, "x", ctx());
    const off = startRoute({ tab: "create", agent: false, agentOpen: false, format: "film", kind: "video" }, "x", ctx());
    expect(on).toEqual(off);
  });

  it("AI film and Ad go to Create's box through the idea pickup; an image template to its picture box", () => {
    for (const format of ["film", "ad"] as const) {
      const r = startRoute({ tab: "create", agent: false, agentOpen: true, format, kind: "video" }, "words", ctx());
      expect(r).toMatchObject({ via: "idea", href: "/my-channel/create?idea=1" });
    }
    const img = startRoute({ tab: "create", agent: false, agentOpen: false, format: "film", kind: "image" }, "words", ctx());
    expect(img.href).toBe("/my-channel/create?idea=1&kind=image");
  });

  it("Channel video goes to the channel's run form with the topic, cut to TOPIC_MAX and said so", () => {
    const short = startRoute({ tab: "create", agent: false, agentOpen: false, format: "channel", kind: "video" }, "  Silk   road ", ctx("tashkent-nights"));
    expect(short.via).toBe("topic");
    expect(short.href.startsWith("/tashkent-nights/create?")).toBe(true);
    expect(short.href.endsWith("#run")).toBe(true);
    expect(params(short.href).get("topic")).toBe("Silk road");
    expect(short).toMatchObject({ cut: false });
    const long = startRoute({ tab: "create", agent: false, agentOpen: false, format: "channel", kind: "video" }, "w".repeat(TOPIC_MAX + 50), ctx());
    expect(long).toMatchObject({ via: "topic", cut: true });
    expect(params(long.href).get("topic")).toHaveLength(TOPIC_MAX);
  });

  it("Channel video with no verified channel links to connecting one, as Home's old composer did", () => {
    const r = startRoute({ tab: "create", agent: false, agentOpen: false, format: "channel", kind: "video" }, "x", ctx(null));
    expect(r).toEqual({ via: "connect", href: "/my-channel/channels/new" });
  });

  it("AI edit goes to the Enhance desk's video edit, words through the same pickup, whatever the chips say", () => {
    for (const agentOpen of [true, false])
      for (const format of START_FORMATS) {
        const r = startRoute({ tab: "edit", agent: true, agentOpen, format, kind: "image" }, "x", ctx());
        expect(r).toEqual({ via: "idea", href: "/my-channel/create?desk=enhance&tool=video_edit&idea=1", fallback: null });
      }
  });
});

describe("/studio?ai=new while S5's panel is not there", () => {
  it("falls back to Create, keeping the idea pickup", () => {
    expect(studioAiFallback({ ai: "new", idea: "1", format: "film" }, false)).toBe("/create?idea=1");
    expect(studioAiFallback({ ai: "new" }, false)).toBe("/create");
    expect(studioAiFallback({ ai: ["new", "x"], idea: ["1"] }, false)).toBe("/create?idea=1");
  });
  it("does nothing when the address does not ask for the panel, or the panel exists", () => {
    expect(studioAiFallback({ view: "timeline" }, false)).toBeNull();
    expect(studioAiFallback({ ai: "new", idea: "1" }, true)).toBeNull();
  });
  it("the Studio page redirects before it reads or draws anything", () => {
    const src = readFileSync(path.join(__dirname, "../app/(app)/[channel]/studio/page.tsx"), "utf8");
    const body = src.slice(src.indexOf("export default async function StudioPage"));
    const redirectAt = body.indexOf("if (aiFallback) redirect(");
    expect(redirectAt).toBeGreaterThan(0);
    expect(redirectAt).toBeLessThan(body.indexOf("sp.shelf"));
    expect(src).toContain("studioAiFallback(sp, NIGHTSHIFT_AI_PANEL_AVAILABLE)");
  });
});

// ── the flag ────────────────────────────────────────────────────────────────

describe("NIGHTSHIFT_AI_CHAT (stand-in for S5's flag function)", () => {
  it("off, unset and every malformed value are off", () => {
    for (const v of [undefined, "", "off", "ON", "On", "1", "true", "yes", "orgs,on", "all"]) {
      expect(aiChatMode({ NIGHTSHIFT_AI_CHAT: v })).toBe("off");
      expect(nightshiftAiOpen(ORG, "paid", { NIGHTSHIFT_AI_CHAT: v, NIGHTSHIFT_AI_CHAT_ORGS: ORG })).toBe(false);
    }
  });
  it("orgs: only the listed workspaces, ids compared case-insensitively, non-uuid entries dropped", () => {
    const env = { NIGHTSHIFT_AI_CHAT: "orgs", NIGHTSHIFT_AI_CHAT_ORGS: ` ${ORG.toUpperCase()} , not-a-uuid,,` };
    expect([...aiChatOrgs(env)]).toEqual([ORG]);
    expect(nightshiftAiAccess(ORG, "paid", env)).toEqual({ open: true });
    expect(nightshiftAiAccess(OTHER, "paid", env)).toEqual({ open: false, reason: "workspace" });
    expect(nightshiftAiAccess(null, "paid", env)).toEqual({ open: false, reason: "workspace" });
  });
  it("on: every paid workspace", () => {
    expect(nightshiftAiAccess(OTHER, "paid", { NIGHTSHIFT_AI_CHAT: "on" })).toEqual({ open: true });
  });
  it("paid plans only: a free plan is closed with its reason, an unread plan is not assumed either way", () => {
    expect(nightshiftAiAccess(ORG, "free", { NIGHTSHIFT_AI_CHAT: "on" })).toEqual({ open: false, reason: "plan" });
    expect(nightshiftAiAccess(ORG, "unknown", { NIGHTSHIFT_AI_CHAT: "on" })).toEqual({ open: false, reason: "plan_unknown" });
    // A free workspace that is not on the list hears "not open here", not "upgrade".
    expect(nightshiftAiAccess(OTHER, "free", { NIGHTSHIFT_AI_CHAT: "orgs", NIGHTSHIFT_AI_CHAT_ORGS: ORG })).toEqual({ open: false, reason: "workspace" });
  });
  it("the billing summary as a plan: exempt is paid, the default plan is free, no summary or no plan is unknown", () => {
    expect(aiPlanOf(null)).toBe("unknown");
    expect(aiPlanOf({ exempt: true, plan: null } as never)).toBe("paid");
    expect(aiPlanOf({ exempt: false, plan: null } as never)).toBe("unknown");
    expect(aiPlanOf({ exempt: false, plan: { isDefault: true } } as never)).toBe("free");
    expect(aiPlanOf({ exempt: false, plan: { isDefault: false } } as never)).toBe("paid");
  });
});

// ── templates by purpose ────────────────────────────────────────────────────

const tpl = (slug: string, category: TemplateDto["category"], kind: TemplateDto["kind"] = "video"): TemplateDto =>
  ({ slug, title: `T ${slug}`, category, kind, aspect: "16:9", prompt: `A {thing} for ${slug}`, poster_url: null }) as unknown as TemplateDto;

describe("templates grouped by purpose", () => {
  it("every Trends category is in exactly one purpose", () => {
    const all = TEMPLATE_PURPOSES.flatMap((p) => PURPOSE_CATEGORIES[p]);
    expect([...all].sort()).toEqual([...TEMPLATE_CATEGORIES].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(PURPOSE_CATEGORIES).toEqual({ storytelling: ["story", "lifestyle"], marketing: ["business", "viral"], brand: ["text"] });
  });
  it("keeps the gallery's order inside a purpose and leaves an empty purpose out", () => {
    const g = groupTemplates([tpl("aa-1", "viral"), tpl("bb-1", "story"), tpl("cc-1", "business"), tpl("dd-1", "lifestyle")]);
    expect(g.map((x) => x.purpose)).toEqual(["storytelling", "marketing"]);
    expect(g[0].templates.map((t) => t.slug)).toEqual(["bb-1", "dd-1"]);
    expect(g[1].templates.map((t) => t.slug)).toEqual(["aa-1", "cc-1"]);
    expect(groupTemplates([])).toEqual([]);
  });
});

// ── the component ───────────────────────────────────────────────────────────

const OPEN: NightshiftAiAccess = { open: true };
type FetchCall = { url: string; method: string };
let calls: FetchCall[];
let templatesResponse: () => Promise<Response>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  localStorage.clear();
  templatesResponse = async () => new Response(JSON.stringify({ templates: [tpl("story-one", "story"), tpl("logo-two", "text", "image")] }), { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url.startsWith("/api/templates")) return templatesResponse();
      return new Response("{}", { status: 404 });
    }),
  );
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function draw(agent: NightshiftAiAccess = OPEN, channel: { slug: string; name: string } | null = { slug: "my-channel", name: "Night Tales" }, locale: "en" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <StartBox agent={agent} channel={channel} />
    </I18nProvider>,
  );
}

/** Nothing the box may call: a job, the agent, a quote. A GET of the templates is the only request it makes. */
function onlyTemplateReads() {
  for (const c of calls) {
    expect(c.method).toBe("GET");
    expect(c.url.startsWith("/api/templates")).toBe(true);
    expect(c.url).not.toMatch(/\/api\/(creative\/jobs|agent\/)|quote/);
  }
}

describe("StartBox", () => {
  it("submitting starts nothing: it keeps the words and goes, with no POST, no quote, no agent call", async () => {
    draw();
    await screen.findByText("T story-one");
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "A lighthouse keeper" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/studio?ai=new&idea=1&format=film");
    expect(localStorage.getItem(IDEA_KEY)).toContain("A lighthouse keeper");
    onlyTemplateReads();
  });

  it("no way out of the box makes a request: AI edit and the run form are plain navigations too", async () => {
    draw();
    await screen.findByText("T story-one");
    fireEvent.click(screen.getByTestId("start-tab-edit"));
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "Make it night" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenLastCalledWith("/my-channel/create?desk=enhance&tool=video_edit&idea=1");
    onlyTemplateReads();
  });

  it("the tabs are a real tablist with a panel, moved by the arrow keys, Home and End", () => {
    draw();
    const list = screen.getByRole("tablist");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    const panel = screen.getByRole("tabpanel");
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[1].id);
    fireEvent.keyDown(tabs[1], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    // The edit tab has no format and no Agent chip.
    fireEvent.click(tabs[1]);
    expect(screen.queryByTestId("start-agent")).toBeNull();
    expect(screen.queryByTestId("start-formats")).toBeNull();
  });

  it("the format chip is a radio group with arrow keys", () => {
    draw();
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[2]);
  });

  it("a closed Agent is disabled with its reason in words, cannot be switched on, and never sends to ai=new", () => {
    draw({ open: false, reason: "plan" });
    const chip = screen.getByTestId("start-agent");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("start-agent-reason").textContent).toContain("On paid plans");
    expect(screen.getByTestId("start-plans").getAttribute("href")).toBe("/my-channel/credits#plans");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "An idea" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/create?idea=1");
    expect(assign.mock.calls[0][0]).not.toContain("ai=");
  });

  it("an unread plan says so, never 'on paid plans'", () => {
    draw({ open: false, reason: "plan_unknown" });
    expect(screen.getByTestId("start-agent-reason").textContent).toContain("Couldn't check your plan");
    expect(screen.queryByTestId("start-plans")).toBeNull();
  });

  it("an empty box is refused in words and goes nowhere", () => {
    draw();
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(screen.getByTestId("start-empty").textContent).toBe("Write a few words first.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("Channel video: says the topic will be cut before the press, and goes to the run form", () => {
    draw({ open: false, reason: "workspace" });
    fireEvent.click(screen.getByTestId("start-format-channel"));
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "t".repeat(TOPIC_MAX + 1) } });
    expect(screen.getByTestId("start-topic-cut").textContent).toContain(String(TOPIC_MAX));
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign.mock.calls[0][0]).toMatch(/^\/my-channel\/create\?topic=t{300}&/);
  });

  it("Channel video with no channel: the key connects one, and needs no words", () => {
    draw({ open: false, reason: "workspace" }, null);
    fireEvent.click(screen.getByTestId("start-format-channel"));
    expect(screen.getByTestId("start-submit").textContent).toContain("Connect a channel");
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/channels/new");
  });

  it("this browser refusing to keep the words: AI edit says so instead of opening an empty desk", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      draw();
      fireEvent.click(screen.getByTestId("start-tab-edit"));
      fireEvent.change(screen.getByTestId("start-field"), { target: { value: "Make it night" } });
      fireEvent.click(screen.getByTestId("start-submit"));
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByTestId("start-refused")).toBeTruthy();
    } finally {
      setItem.mockRestore();
    }
  });

  it("a template only fills the box: no request, no navigation; an empty purpose is not drawn", async () => {
    draw();
    const card = await screen.findByRole("button", { name: "Put “T story-one” in the box" });
    expect(screen.getByText("Storytelling")).toBeTruthy();
    expect(screen.getByText("Brand assets")).toBeTruthy();
    expect(screen.queryByText("Marketing")).toBeNull();
    const before = calls.length;
    fireEvent.click(card);
    expect((screen.getByTestId("start-field") as HTMLTextAreaElement).value).toBe("A {thing} for story-one");
    expect(calls.length).toBe(before);
    expect(assign).not.toHaveBeenCalled();
  });

  it("templates: loading, then failed with a retry that only reads again, then empty — never a zero", async () => {
    let fail = true;
    templatesResponse = async () =>
      fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ templates: [] }), { status: 200 });
    draw();
    expect(screen.getByTestId("start-templates-loading")).toBeTruthy();
    await screen.findByTestId("start-templates-error");
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-templates-retry"));
    });
    await waitFor(() => expect(screen.getByTestId("start-templates-empty")).toBeTruthy());
    expect(screen.getByTestId("start-templates").textContent).not.toMatch(/\b0\b/);
    onlyTemplateReads();
    expect(calls.filter((c) => c.url.startsWith("/api/templates"))).toHaveLength(2);
  });

  it("speaks Uzbek", async () => {
    draw(OPEN, null, "uz");
    expect(screen.getByTestId("start-tab-create").textContent).toContain("Video yaratish");
    expect(screen.getByTestId("start-format-film").textContent).toBe("AI film");
  });
});
