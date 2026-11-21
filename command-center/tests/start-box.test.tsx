// @vitest-environment jsdom
/**
 * The app's start box (components/prompt/StartBox.tsx, lib/start-box.ts, lib/brain/flag.ts). What would break without
 * these: a closed Agent chip that still opens Nightshift AI (`ai=new`), a format that is not the closed enum riding in an address,
 * a typo in NIGHTSHIFT_AI_CHAT opening the assistant for everyone, the stand-in flag drifting from S5's `aiChatOpenFor`, a
 * template drawn under two purposes or an empty purpose drawn as a heading with nothing under it, and the box itself posting a
 * job, a quote or an agent call (CLAUDE.md rule 3: the box is a link and nothing more).
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
import { TEMPLATE_CATEGORIES, templateCreateHref, type TemplateDto } from "@/lib/templates/trends";
import { dictionaries } from "@/lib/i18n";
import {
  AI_READER_READY,
  EDIT_WORDS_MAX,
  UNKNOWN_START,
  PURPOSE_CATEGORIES,
  START_FORMATS,
  START_TABS,
  TEMPLATE_PURPOSES,
  groupTemplates,
  isStartFormat,
  startAvailability,
  startRoute,
  type StartAvailable,
  type StartChoice,
} from "@/lib/start-box";
import { rovingIndex } from "@/components/prompt/StartBox";
import { aiChatEnv, aiChatMode, aiChatOpenFor, aiChatOrgs } from "@/lib/brain/flag";

const en = dictionaries.en;
const ORG = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const ctx = (channel: string | null = "my-channel") => ({ path: (s: string) => `/my-channel${s}`, channel, language: "English" as const });
const params = (href: string) => new URL(href, "https://x.test").searchParams;

// ── routing ─────────────────────────────────────────────────────────────────

describe("where the send key goes: every tab × Agent (open/closed, on/off) × format", () => {
  const cases: StartChoice[] = [];
  for (const tab of START_TABS)
    for (const agentOpen of [true, false])
      for (const aiReader of [true, false, undefined])
        for (const agent of [true, false]) for (const format of START_FORMATS) cases.push({ tab, agent, agentOpen, aiReader, format, kind: "video" });

  it.each(cases)("%o is an address on this channel, and a closed Agent never yields ai=new", (c) => {
    const r = startRoute(c, "A lighthouse keeper finds a bottle", ctx());
    expect(r.href.startsWith("/my-channel/")).toBe(true);
    const q = params(r.href);
    const reader = c.aiReader ?? AI_READER_READY;
    if (!c.agentOpen || !c.agent || !reader || c.tab === "edit") expect(q.has("ai")).toBe(false);
    // The words never ride in the address unless they are a short channel topic (the run form's own contract).
    if (r.via === "idea") expect(r.href).not.toContain("lighthouse");
    // `format` is only ever one of the closed enum.
    if (q.has("format")) expect(isStartFormat(q.get("format"))).toBe(true);
  });

  it("the reader exists since #843 (AI_READER_READY): an open flag routes to ai=new; closing the switch closes the chip", () => {
    expect(AI_READER_READY).toBe(true);
    for (const format of START_FORMATS) {
      expect(params(startRoute({ tab: "create", agent: true, agentOpen: true, format, kind: "video" }, "x", ctx()).href).get("ai")).toBe("new");
      const shut = startRoute({ tab: "create", agent: true, agentOpen: true, aiReader: false, format, kind: "video" }, "x", ctx());
      expect(params(shut.href).has("ai")).toBe(false);
    }
  });

  it("Agent on, open and its reader there: Nightshift AI with the words kept in this browser and the format as a closed enum", () => {
    for (const format of START_FORMATS) {
      const r = startRoute({ tab: "create", agent: true, agentOpen: true, aiReader: true, format, kind: "video" }, "x", ctx());
      expect(r).toEqual({ via: "idea", href: `/my-channel/studio?ai=new&idea=1&format=${format}`, fallback: null });
    }
  });

  it("Agent on but closed is the same as off: never the assistant", () => {
    const on = startRoute({ tab: "create", agent: true, agentOpen: false, format: "film", kind: "video" }, "x", ctx());
    const off = startRoute({ tab: "create", agent: false, agentOpen: false, format: "film", kind: "video" }, "x", ctx());
    expect(on).toEqual(off);
  });

  it("Agent off: Create's box for the kind through the idea pickup, the fallback the same kind with the words in the address", () => {
    for (const format of ["film", "ad"] as const) {
      const r = startRoute({ tab: "create", agent: false, agentOpen: true, format, kind: "video" }, "words", ctx());
      expect(r).toEqual({ via: "idea", href: "/my-channel/create?idea=1", fallback: "/my-channel/create?kind=video&prompt=words" });
    }
    for (const kind of ["image", "audio"] as const) {
      const r = startRoute({ tab: "create", agent: false, agentOpen: false, format: "film", kind }, "words", ctx());
      expect(r).toEqual({ via: "idea", href: `/my-channel/create?idea=1&kind=${kind}`, fallback: `/my-channel/create?kind=${kind}&prompt=words` });
    }
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

// ── what is on sale ─────────────────────────────────────────────────────────

describe("startAvailability: the box marks what the Studio start's chips mark", () => {
  it("an unknown read marks nothing (rule 5)", () => {
    expect(startAvailability({ state: "unknown" })).toEqual(UNKNOWN_START);
  });
  it("a kind is its Create desk (Audio is Voice); the edit tab is video_edit alone, not any Enhance tool", () => {
    expect(startAvailability({ state: "known", sold: ["t2i", "video_edit"] })).toEqual({ video: false, image: true, audio: false, edit: true });
    expect(startAvailability({ state: "known", sold: ["i2v", "tts", "upscale"] })).toEqual({ video: true, image: false, audio: true, edit: false });
    expect(startAvailability({ state: "known", sold: [] })).toEqual({ video: false, image: false, audio: false, edit: false });
  });
  it("the roving keys step over a closed key, and stay put when no other key is usable", () => {
    const closed = (i: number) => i === 1 || i === 2;
    expect(rovingIndex("ArrowRight", 0, 4, closed)).toBe(3);
    expect(rovingIndex("ArrowLeft", 3, 4, closed)).toBe(0);
    expect(rovingIndex("End", 0, 4, (i) => i === 3)).toBe(2);
    expect(rovingIndex("Home", 3, 4, (i) => i === 0)).toBe(1);
    expect(rovingIndex("ArrowRight", 0, 2, (i) => i === 1)).toBe(-1);
    expect(rovingIndex("a", 0, 4)).toBe(-1);
  });
});

// ── the flag ────────────────────────────────────────────────────────────────

describe("NIGHTSHIFT_AI_CHAT (stand-in, same answers as S5's lib/ai-chat/flag aiChatOpenFor)", () => {
  it("off, unset and every malformed value are off", () => {
    for (const v of [undefined, "", "off", "1", "true", "yes", "orgs,on", "all", "o n"]) {
      expect(aiChatMode({ NIGHTSHIFT_AI_CHAT: v })).toBe("off");
      expect(aiChatOpenFor(ORG, { NIGHTSHIFT_AI_CHAT: v, NIGHTSHIFT_AI_CHAT_ORGS: ORG })).toBe(false);
    }
    expect(aiChatOpenFor(ORG, {})).toBe(false);
  });
  it("the mode is read as S5 reads it: trimmed, case-insensitive", () => {
    expect(aiChatOpenFor(ORG, { NIGHTSHIFT_AI_CHAT: "On " })).toBe(true);
    expect(aiChatMode({ NIGHTSHIFT_AI_CHAT: " ORGS" })).toBe("orgs");
  });
  it("orgs: only the listed workspaces, ids compared case-insensitively, non-uuid entries dropped", () => {
    const env = { NIGHTSHIFT_AI_CHAT: "orgs", NIGHTSHIFT_AI_CHAT_ORGS: ` ${ORG.toUpperCase()} , not-a-uuid,,` };
    expect([...aiChatOrgs(env)]).toEqual([ORG]);
    expect(aiChatOpenFor(ORG, env)).toBe(true);
    expect(aiChatOpenFor(OTHER, env)).toBe(false);
    expect(aiChatOpenFor(null, env)).toBe(false);
    expect(aiChatOpenFor(undefined, { NIGHTSHIFT_AI_CHAT: "on" })).toBe(false);
  });
  it("on: every workspace, whatever its plan (a free one gets its trial inside the panel, so the plan is not asked)", () => {
    expect(aiChatOpenFor(OTHER, { NIGHTSHIFT_AI_CHAT: "on" })).toBe(true);
    expect(aiChatOpenFor.length).toBe(2);
  });
  it("reads only its two variables, by name", () => {
    vi.stubEnv("NIGHTSHIFT_AI_CHAT", "orgs");
    vi.stubEnv("NIGHTSHIFT_AI_CHAT_ORGS", ORG);
    try {
      expect(aiChatEnv()).toEqual({ NIGHTSHIFT_AI_CHAT: "orgs", NIGHTSHIFT_AI_CHAT_ORGS: ORG });
    } finally {
      vi.unstubAllEnvs();
    }
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

/** `aiReader` defaults to true here; `reader: "constant"` leaves it to AI_READER_READY (true since #843). */
function draw(
  agentOpen = true,
  channel: { slug: string; name: string } | null = { slug: "my-channel", name: "Night Tales" },
  locale: "en" | "uz" = "en",
  opts: { reader?: boolean | "constant"; available?: StartAvailable; fillHere?: (w: string, k: "video" | "image" | "audio") => void } = {},
) {
  const reader = opts.reader ?? true;
  return render(
    <I18nProvider locale={locale}>
      <StartBox
        agentOpen={agentOpen}
        {...(reader === "constant" ? {} : { aiReader: reader })}
        available={opts.available ?? UNKNOWN_START}
        channel={channel}
        fillHere={opts.fillHere}
      />
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
    fireEvent.click(screen.getByTestId("start-agent"));
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

  it("Agent off: Video | Image | Audio | Channel video, a radio group with arrow keys; each kind opens its own box", () => {
    draw();
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Video", "Image", "Audio", "Channel video"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
    // AI film and Ad shape only Nightshift AI's questions: where they would change nothing, they are not drawn.
    expect(screen.queryByTestId("start-format-film")).toBeNull();
    expect(screen.queryByTestId("start-format-ad")).toBeNull();
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(radios[3].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[3]);
    fireEvent.click(screen.getByTestId("start-kind-audio"));
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "Welcome to our channel" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/create?idea=1&kind=audio");
  });

  it("Agent on: AI film | Ad | Channel video, and the note says the format shapes its questions", () => {
    draw();
    fireEvent.click(screen.getByTestId("start-agent"));
    const radios = within(screen.getByRole("radiogroup")).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["AI film", "Ad", "Channel video"]);
    expect(screen.queryByTestId("start-kind-video")).toBeNull();
    expect(screen.getByText(/shaped by the format you chose/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("start-format-ad"));
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "A bakery ad" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/studio?ai=new&idea=1&format=ad");
  });

  it("a closed Agent is disabled with its reason in words, cannot be switched on, and never sends to ai=new", () => {
    draw(false);
    const chip = screen.getByTestId("start-agent");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("start-agent-reason").textContent).toContain("Not open for this workspace yet");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "An idea" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/create?idea=1");
    expect(assign.mock.calls[0][0]).not.toContain("ai=");
  });

  it("an open Agent starts OFF (S5's reader is not on main yet): a person turns it on, and off again goes to Create", () => {
    draw(true);
    const chip = screen.getByTestId("start-agent");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByTestId("start-agent-reason")).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "An idea" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/create?idea=1");
  });

  it("an empty box is refused in words and goes nowhere", () => {
    draw();
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(screen.getByTestId("start-empty").textContent).toBe("Write a few words first.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("Channel video: says the topic will be cut before the press, and goes to the run form", () => {
    draw(false);
    fireEvent.click(screen.getByTestId("start-format-channel"));
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "t".repeat(TOPIC_MAX + 1) } });
    expect(screen.getByTestId("start-topic-cut").textContent).toContain(String(TOPIC_MAX));
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign.mock.calls[0][0]).toMatch(/^\/my-channel\/create\?topic=t{300}&/);
  });

  it("Channel video with no channel: the key connects one, and needs no words", () => {
    draw(false, null);
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

  it("a template card is a link to the template's own Create address (model, shape and length come with it), never a fill", async () => {
    draw();
    const card = await screen.findByRole("link", { name: "Open “T story-one” in Create" });
    expect(card.getAttribute("href")).toBe(`/my-channel${templateCreateHref("story-one")}`);
    expect(screen.getByText("Storytelling")).toBeTruthy();
    expect(screen.getByText("Brand assets")).toBeTruthy();
    expect(screen.queryByText("Marketing")).toBeNull();
    expect(screen.getByText("Open a template: its model, shape and length come with it.")).toBeTruthy();
    // A plain link: nothing here reads the template or fills the box (the Create page does, once it is open).
    expect(card.tagName).toBe("A");
    onlyTemplateReads();
  });

  it("a card says its model's status as the Trends gallery does: unavailable offers no link to Create, unknown says so", async () => {
    templatesResponse = async () =>
      new Response(
        JSON.stringify({
          templates: [
            { ...tpl("gone-one", "story"), model_status: "unavailable" },
            { ...tpl("maybe-one", "story"), model_status: "unknown" },
            { ...tpl("sold-one", "story"), model_status: "available" },
          ],
        }),
        { status: 200 },
      );
    draw();
    await screen.findByText("T gone-one");
    const gone = document.querySelector('[data-template="gone-one"]') as HTMLElement;
    expect(gone.tagName).toBe("DIV");
    expect(gone.textContent).toContain(en.trends.modelUnavailable);
    expect(within(gone).getByRole("link").getAttribute("href")).toBe("/my-channel/models");
    const maybe = document.querySelector('[data-template="maybe-one"]') as HTMLElement;
    expect(maybe.getAttribute("href")).toBe("/my-channel/create?template=maybe-one");
    expect(maybe.textContent).toContain(en.trends.modelUnknown);
    const sold = document.querySelector('[data-template="sold-one"]') as HTMLElement;
    expect(sold.getAttribute("href")).toBe("/my-channel/create?template=sold-one");
    expect(sold.textContent).not.toContain(en.trends.modelUnknown);
  });

  it("AI edit takes what a video edit takes (500): the field's limit and counter follow the tab, and a longer draft is said", () => {
    draw();
    const field = () => screen.getByTestId("start-field") as HTMLTextAreaElement;
    expect(field().maxLength).toBe(2000);
    fireEvent.change(field(), { target: { value: "w".repeat(620) } });
    fireEvent.click(screen.getByTestId("start-tab-edit"));
    expect(field().maxLength).toBe(EDIT_WORDS_MAX);
    expect(screen.getByTestId("start-count").textContent).toBe(` 620 of ${EDIT_WORDS_MAX}`);
    expect(screen.getByTestId("start-edit-cut").textContent).toContain(String(EDIT_WORDS_MAX));
    fireEvent.change(field(), { target: { value: "w".repeat(350) } });
    expect(screen.getByTestId("start-count").textContent).toBe(` 350 of ${EDIT_WORDS_MAX}`);
    expect(screen.queryByTestId("start-edit-cut")).toBeNull();
  });

  it("templates: loading, then failed with a retry that only reads again, then empty — never a zero", async () => {
    let fail = true;
    templatesResponse = async () =>
      fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ templates: [] }), { status: 200 });
    draw();
    const loading = screen.getByTestId("start-templates-loading");
    // The "loading" status is not inside the busy region, where a screen reader would hold it back.
    expect(within(loading).getByRole("status").closest("[aria-busy]")).toBeNull();
    await screen.findByTestId("start-templates-error");
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-templates-retry"));
    });
    // The retry key is gone with its error: focus stays in the section, on its title, not at the top of the page.
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: en.startBox.library.title }));
    await waitFor(() => expect(screen.getByTestId("start-templates-empty")).toBeTruthy());
    expect(screen.getByTestId("start-templates").textContent).not.toMatch(/\b0\b/);
    onlyTemplateReads();
    expect(calls.filter((c) => c.url.startsWith("/api/templates"))).toHaveLength(2);
  });

  it("an open flag without its reader (the switch closed): the chip reads closed with its reason and never sends to ai=new", () => {
    draw(true, undefined, "en", { reader: false });
    const chip = screen.getByTestId("start-agent");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("start-agent-reason").textContent).toContain(en.startBox.agent.closed);
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("start-format-film")).toBeNull();
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "An idea" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/create?idea=1");
  });

  it("a closed Agent chip is named \"Agent\" alone and described by the reason line under the box", () => {
    draw(false);
    const chip = screen.getByTestId("start-agent");
    expect(chip.textContent).toBe("Agent");
    expect(chip.querySelector(".sb-chip-sub")).toBeNull();
    const reason = screen.getByTestId("start-agent-reason");
    expect(reason.tagName).toBe("P");
    expect(reason.className).toBe("sb-line");
    expect(chip.getAttribute("aria-describedby")).toBe(reason.id);
    expect(chip.contains(reason)).toBe(false);
  });

  it("a kind or the edit tab with nothing on sale is not drawn at all, and the arrow keys never land on a missing one", () => {
    draw(true, undefined, "en", { available: { video: true, image: false, audio: false, edit: false } });
    for (const k of ["image", "audio"]) expect(screen.queryByTestId(`start-kind-${k}`)).toBeNull();
    expect(screen.queryByTestId("start-tab-edit")).toBeNull();
    expect(screen.getByTestId("start").textContent).not.toContain(en.startBox.notYet);
    fireEvent.keyDown(screen.getByTestId("start-kind-video"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("start-format-channel"));
  });

  it("Video with nothing on sale: the box opens on the first kind that has something, and Video is not drawn", () => {
    draw(true, undefined, "en", { available: { video: false, image: true, audio: null, edit: null } });
    expect(screen.getByTestId("start-kind-image").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("start-kind-video")).toBeNull();
  });

  it("unknown availability (null) keeps every choice usable and claims nothing", () => {
    draw();
    expect(screen.getByTestId("start").textContent).not.toContain(en.startBox.notYet);
    for (const k of ["video", "image", "audio"]) expect(screen.getByTestId(`start-kind-${k}`).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByTestId("start-tab-edit").getAttribute("aria-disabled")).toBeNull();
  });

  it("no channel and Channel video: says the topic comes after connecting, that the words are not carried, and keeps nothing", () => {
    draw(false, null);
    fireEvent.click(screen.getByTestId("start-format-channel"));
    const field = screen.getByTestId("start-field") as HTMLTextAreaElement;
    expect(field.placeholder).toBe(en.startBox.placeholder.connect);
    expect(screen.getByText(/What you typed here is not carried over\./)).toBeTruthy();
    fireEvent.change(field, { target: { value: "A topic" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(assign).toHaveBeenCalledWith("/my-channel/channels/new");
    // Nothing reads kept words after connecting: kept anyway, a later Create page would fill its box with them by surprise.
    expect(localStorage.getItem(IDEA_KEY)).toBeNull();
  });

  it("on the Studio start: says it fills the box below, fills it, and empties itself", () => {
    const fillHere = vi.fn();
    draw(true, undefined, "en", { fillHere });
    expect(screen.getByText(en.startBox.note.here)).toBeTruthy();
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "A misty lake" } });
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(fillHere).toHaveBeenCalledWith("A misty lake", "video");
    expect((screen.getByTestId("start-field") as HTMLTextAreaElement).value).toBe("");
    expect(assign).not.toHaveBeenCalled();
  });

  it("the count is not a live region; one hidden line speaks, and only at the limit", () => {
    draw();
    const live = screen.getByTestId("start-limit");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "w".repeat(1900) } });
    expect(screen.getByTestId("start-count").getAttribute("aria-live")).toBeNull();
    expect(live.textContent).toBe("");
    fireEvent.change(screen.getByTestId("start-field"), { target: { value: "w".repeat(2000) } });
    expect(screen.getByTestId("start-limit")).toBe(live);
    expect(live.textContent).toBe("2000 of 2000");
  });

  it("speaks Uzbek", async () => {
    draw(true, null, "uz");
    expect(screen.getByTestId("start-tab-create").textContent).toContain("Yaratish");
    expect(screen.getByTestId("start-kind-image").textContent).toBe("Rasm");
    fireEvent.click(screen.getByTestId("start-agent"));
    expect(screen.getByTestId("start-format-ad").textContent).toBe("Reklama");
  });
});
