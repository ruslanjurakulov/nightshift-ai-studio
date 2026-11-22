// @vitest-environment jsdom
/**
 * Speech's voice is picked by character from the account's own list (components/studio/VoiceCatalog.tsx).
 *
 * What would break without these: a voice offered that the account cannot speak in; a library voice that its owner
 * can withdraw presented like a safe one; a list that cannot be read shown as an empty account (or as nothing at
 * all, a dead end); a typed string, even one shaped like an id, sent as `voice_id`; and a voice picked on the
 * person's behalf.
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
import type { StudioModel } from "@/lib/creative/studio";
import { facetValues, filterVoices, sortVoices, type CatalogVoice } from "@/lib/creative/voiceCatalog";

const t = dictionaries.en;
const c = t.voiceCatalog;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [{ id: "elevenlabs-v3", displayName: "Eleven v3", capabilities: ["tts"], beta: false }];

const v = (over: Partial<CatalogVoice> & { voiceId: string; name: string }): CatalogVoice => ({
  category: "premade",
  previewUrl: "",
  labels: "",
  traits: {},
  library: false,
  ...over,
});
const SHARED = v({ voiceId: "AAAAAAAAAAAAAAAAAAA1", name: "Aria Shared", category: "professional", library: true, traits: { gender: "female", accent: "british" } });
const CLONE = v({ voiceId: "BBBBBBBBBBBBBBBBBBB2", name: "Bob Clone", category: "cloned", traits: { gender: "male" } });
const DESIGNED = v({ voiceId: "CCCCCCCCCCCCCCCCCCC3", name: "Cora Designed", category: "generated", traits: { gender: "female", age: "young", description: "Bright explainer" } });
const PREMADE = v({
  voiceId: "DDDDDDDDDDDDDDDDDDD4",
  name: "Dan Premade",
  previewUrl: "https://cdn.test/dan.mp3",
  traits: { gender: "male", age: "middle_aged", accent: "american", useCase: "narration", description: "Deep, calm narrator" },
});
const ACCOUNT = [SHARED, CLONE, DESIGNED, PREMADE];

let voicesAnswer: () => Promise<Response>;
let voiceCalls: number;
let quotes: Array<Record<string, unknown>>;
beforeEach(() => {
  voiceCalls = 0;
  quotes = [];
  voicesAnswer = () => json({ voices: ACCOUNT, truncated: false });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/creative/voices") {
        voiceCalls += 1;
        return voicesAnswer();
      }
      if (url === "/api/creative/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return json({ quote: { credits: 2 } });
      }
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (url.startsWith("/api/style-kits")) return json({ kits: [] });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openSpeech() {
  const view = render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
  fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.tts }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Salom, kanalga xush kelibsiz" } });
  return view;
}
const catalog = () => screen.getByTestId("voice-catalog");
const radios = () => within(screen.getByTestId("voice-catalog-list")).getAllByRole("radio");

describe("voice order and filters (pure)", () => {
  it("offers premade and designed voices first, a library voice last", () => {
    expect(sortVoices(ACCOUNT).map((x) => x.name)).toEqual(["Dan Premade", "Cora Designed", "Bob Clone", "Aria Shared"]);
  });

  it("filters by character; an unlabelled voice is not 'any', and the search never reads the id", () => {
    expect(filterVoices(ACCOUNT, { gender: "female" }).map((x) => x.name)).toEqual(["Aria Shared", "Cora Designed"]);
    expect(filterVoices(ACCOUNT, { age: "young" }).map((x) => x.name)).toEqual(["Cora Designed"]);
    expect(filterVoices(ACCOUNT, { query: "calm" }).map((x) => x.name)).toEqual(["Dan Premade"]);
    expect(filterVoices(ACCOUNT, { query: PREMADE.voiceId })).toEqual([]);
    expect(facetValues(ACCOUNT).gender).toEqual(["female", "male"]);
    expect(facetValues(ACCOUNT).useCase).toEqual(["narration"]);
  });
});

describe("the account's plan and library voices", () => {
  const library = () => screen.getByRole("radio", { name: /Aria Shared/ });

  it("free plan: a library voice is marked as needing a paid plan and cannot be picked; premade voices can", async () => {
    voicesAnswer = () => json({ voices: ACCOUNT, truncated: false, plan: "free" });
    openSpeech();
    expect(await screen.findByText(c.planFree)).toBeTruthy();
    expect(library().textContent).toContain(c.libraryNeedsPaid);
    expect((library() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(library());
    expect(library().getAttribute("aria-checked")).toBe("false");
    // Arrow keys step over it: from the voice before it, ArrowDown wraps to the first voice.
    const clone = screen.getByRole("radio", { name: /Bob Clone/ });
    fireEvent.keyDown(clone, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /Dan Premade/ }).getAttribute("aria-checked")).toBe("true");
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes.some((q) => (q.params as Record<string, unknown>)?.voice_id === SHARED.voiceId)).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: /Dan Premade/ }));
    expect(screen.getByRole("radio", { name: /Dan Premade/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("free plan: a library voice picked earlier is called out, not sent", async () => {
    voicesAnswer = () => json({ voices: ACCOUNT, truncated: false, plan: "free" });
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={{ capability: "tts", model: "elevenlabs-v3", prompt: "Salom", aspect: "16:9", duration: 5, voiceId: SHARED.voiceId }} />));
    expect(await screen.findByText(c.pickedNeedsPaid)).toBeTruthy();
  });

  it("an ElevenLabs Default voice is tagged as leaving, and once retired cannot be picked and is called out as retired, not as a plan", async () => {
    const GEORGE = v({ voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George" });
    voicesAnswer = () => json({ voices: [...ACCOUNT, GEORGE], truncated: false, plan: "paid" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
      openSpeech();
      await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
      expect(screen.getByRole("radio", { name: /George/ }).textContent).toContain(t.create.flow.voiceLeavingTag);
      cleanup();
      vi.setSystemTime(new Date("2027-01-02T10:00:00Z"));
      render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={{ capability: "tts", model: "elevenlabs-v3", prompt: "Salom", aspect: "16:9", duration: 5, voiceId: GEORGE.voiceId }} />));
      expect(await screen.findByText(t.create.flow.voiceRetired.replace("{name}", "George"))).toBeTruthy();
      expect((screen.getByRole("radio", { name: /George/ }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByText(c.pickedNeedsPaid)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("paid plan: a library voice can be picked and carries no plan mark", async () => {
    voicesAnswer = () => json({ voices: ACCOUNT, truncated: false, plan: "paid" });
    openSpeech();
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    expect(library().textContent).not.toContain(c.libraryNeedsPaid);
    expect(library().textContent).not.toContain(c.libraryMayNeedPaid);
    expect(screen.queryByText(c.planFree)).toBeNull();
    expect(screen.queryByText(c.planUnknown)).toBeNull();
    fireEvent.click(library());
    expect(library().getAttribute("aria-checked")).toBe("true");
  });

  it("unknown plan (or none sent): says so, marks library voices 'may need', and blocks nothing", async () => {
    for (const plan of ["unknown", undefined]) {
      voicesAnswer = () => json({ voices: ACCOUNT, truncated: false, ...(plan ? { plan } : {}) });
      openSpeech();
      expect(await screen.findByText(c.planUnknown)).toBeTruthy();
      expect(library().textContent).toContain(c.libraryMayNeedPaid);
      expect((library() as HTMLButtonElement).disabled).toBe(false);
      // Premade voices are never marked.
      expect(screen.getByRole("radio", { name: /Dan Premade/ }).textContent).not.toContain(c.libraryMayNeedPaid);
      cleanup();
    }
  });
});

describe("the speech voice picker", () => {
  it("while loading, says so and offers the standard voices; nothing is picked for the person", async () => {
    let release!: (r: Response) => void;
    voicesAnswer = () => new Promise<Response>((r) => (release = r));
    openSpeech();
    expect(catalog().getAttribute("data-state")).toBe("loading");
    expect(screen.getByText(c.loading)).toBeTruthy();
    expect((document.querySelector("#gen-voice") as HTMLSelectElement).value).toBe("");
    release(new Response(JSON.stringify({ voices: ACCOUNT, truncated: false }), { status: 200 }));
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("lists the account's voices by character, marks a library voice, and plays ElevenLabs' sample", async () => {
    openSpeech();
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    expect(radios().map((r) => r.querySelector(".truncate")?.textContent)).toEqual([
      "Dan Premade",
      "Cora Designed",
      "Bob Clone",
      "Aria Shared",
    ]);
    expect(radios()[0].textContent).toContain("middle aged · american · narration");
    expect(radios()[3].textContent).toContain(c.library);
    expect(radios()[0].textContent).not.toContain(c.library);
    // A sample to listen to where ElevenLabs gives one; "No sample" where it does not, never a broken button.
    expect(screen.getByRole("button", { name: `${t.create.voiceListen}: Dan Premade` })).toBeTruthy();
    expect(screen.getAllByText(c.noPreview)).toHaveLength(3);
  });

  it("picking a voice sends its id as params.voice_id", async () => {
    openSpeech();
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    fireEvent.click(screen.getByRole("radio", { name: /Cora Designed/ }));
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ prompt: "Salom, kanalga xush kelibsiz", voice_id: DESIGNED.voiceId }), {
      timeout: 2000,
    });
  });

  it("no typed id: an id-shaped string in the search is a search, never a voice", async () => {
    openSpeech();
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    // The only text box in the picker is the search.
    const boxes = within(catalog()).queryAllByRole("textbox").concat(within(catalog()).queryAllByRole("searchbox"));
    expect(boxes).toHaveLength(1);
    expect(boxes[0].getAttribute("type")).toBe("search");
    fireEvent.change(boxes[0], { target: { value: PREMADE.voiceId } });
    expect(screen.getByText(c.noMatch)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes.some((q) => (q.params as Record<string, unknown>)?.voice_id === PREMADE.voiceId)).toBe(false);
    expect(screen.getByText(t.gen.blocked.need_voice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: c.clearFilters }));
    expect(radios()).toHaveLength(4);
  });

  it("filters by gender and searches the description", async () => {
    openSpeech();
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    fireEvent.change(screen.getByLabelText(c.facets.gender), { target: { value: "female" } });
    expect(radios().map((r) => r.textContent)).toEqual([expect.stringContaining("Cora Designed"), expect.stringContaining("Aria Shared")]);
    fireEvent.change(screen.getByLabelText(c.facets.gender), { target: { value: "" } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "explainer" } });
    expect(radios()).toHaveLength(1);
  });

  it("says when the list is only part of the account's voices", async () => {
    voicesAnswer = () => json({ voices: ACCOUNT, truncated: true });
    openSpeech();
    expect(await screen.findByText(c.truncated)).toBeTruthy();
  });

  it("says when a voice picked earlier is not on the account", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} initial={{ capability: "tts", model: "elevenlabs-v3", prompt: "Salom", aspect: "16:9", duration: 5, voiceId: "ZZZZZZZZZZZZZZZZZZZ9" }} />));
    expect(await screen.findByText(c.pickedMissing)).toBeTruthy();
  });

  it.each([
    ["not configured", 503, { error: "voices_not_configured" }, c.notConfigured, false],
    ["ElevenLabs unreachable", 502, { error: "elevenlabs_unreachable" }, c.unreachable, true],
    ["key rejected", 502, { error: "elevenlabs_key_rejected" }, c.keyRejected, false],
    ["rate limited", 429, { error: "rate_limited" }, c.rateLimited, true],
    ["signed out", 401, { error: "unauthorized" }, c.signedOut, false],
    ["any other error", 500, {}, c.failed, true],
  ])("%s: says why, keeps the standard voices to pick from", async (_name, status, body, message, retry) => {
    voicesAnswer = () => json(body, status);
    openSpeech();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText(`${c.builtInTitle}.`)).toBeTruthy();
    expect(document.querySelector("#gen-voice")).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: c.retry }))).toBe(retry);
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("an empty account says so, rather than showing nothing", async () => {
    voicesAnswer = () => json({ voices: [], truncated: false });
    openSpeech();
    expect(await screen.findByText(c.empty)).toBeTruthy();
    expect(document.querySelector("#gen-voice")).toBeTruthy();
  });

  it("retry asks again and shows the account's list once it answers", async () => {
    let first = true;
    voicesAnswer = () => {
      if (first) {
        first = false;
        return Promise.reject(new TypeError("network"));
      }
      return json({ voices: ACCOUNT, truncated: false });
    };
    openSpeech();
    fireEvent.click(await screen.findByRole("button", { name: c.retry }));
    await waitFor(() => expect(catalog().getAttribute("data-state")).toBe("ok"));
    expect(voiceCalls).toBe(2);
  });
});
