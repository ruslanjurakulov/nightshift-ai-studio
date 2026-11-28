// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

/**
 * The panel's side of the S1 story grammar (fakes only). What would break without these: a guessed aspect shown as a fact nobody
 * can change; a voice-over film offered a Create that would start it silent, or one whose in-clip lines nobody would hear; the old
 * "the video model speaks the lines" note still on screen while the cut drops clip sound.
 */
const created = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/components/studio-timeline/FilmCreateButton", () => ({
  FilmCreateButton: () => {
    created.n += 1;
    return <div data-testid="film-create" />;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FILM_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const en = dictionaries.en.aiChat;
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 30, characters: [{ id: "c1" }], scenes: [], format: "F3",
  chapters: [{ id: "ch1", title: "a", seconds: 15, beats: [] }, { id: "ch2", title: "b", seconds: 15, beats: [] }] });
const slots = { kind: "short", target_seconds: 30, style: "multfilm", aspect: "9:16", language: "Uzbek", audience: "oilalar", inferred: ["aspect", "language", "audience"] };
let voice: Record<string, unknown> = { mode: "narration", blocked: ["voice_unavailable"] };
let sent: Record<string, unknown>[] = [];

beforeEach(() => {
  sent = [];
  created.n = 0;
  voice = { mode: "narration", blocked: ["voice_unavailable"] };
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        return json(200, { session: { id: S1, step: "proposing", slots }, card: null, brief: { version: 1, kind: "short" },
          messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] });
      }
      return json(200, { sessions: [{ id: S1, title: "x", updated_at: new Date().toISOString() }], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (body.action === "change") {
        return json(200, { reply: "OK", step: "proposing", card: null, slots: { ...slots, aspect: "16:9", inferred: ["language", "audience"] },
                           scenarios: [outline("Alpha"), outline("Beta")], brief: { version: 1, kind: "short" } });
      }
      return json(200, { brief: { version: 1, kind: "short", title: "Alpha", idea: "i", target_seconds: 30, voice, music: { mode: "off" },
                                  scenes: [{ id: "s1", dialogue: [], speech: voice.mode === "narration" ? "voice_over" : voice.mode === "clip_audio" ? "in_clip" : "none",
                                             ...(voice.intent ? { speech_intent: voice.intent } : {}), narration: "Ota ketdi." }],
                                  characters: [], text_layers: [{ scene_id: "s1", text: "10 yil", position: "bottom" }] },
                         film: { id: FILM_ID, version: 2 }, models: { clip: null, keyframe: null }, quote: null,
                         film_quote: { priced: false, refusals: [{ reason: "voice_not_set" }] } });
    }
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session: { id: S1 }, gate: null });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async () => {
  const u = new URL(window.location.href);
  u.searchParams.set("brain", S1);
  window.history.replaceState(null, "", u.toString());
  render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
  return screen.findByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") });
};

describe("Nightshift AI panel: story grammar", () => {
  it("inferred slots are chips; pressing one shows the server's own options and sends the person's choice as a change", async () => {
    await open();
    const chip = await screen.findByRole("button", { name: en.inferredChipLabel.replace("{slot}", "Shape").replace("{value}", "9:16") });
    await act(async () => fireEvent.click(chip));
    const card = await screen.findByTestId("change-card");
    expect(card.textContent).toContain("16:9");
    expect(card.textContent).toContain("1:1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /16:9/ })));
    await waitFor(() => expect(sent.some((b) => b.action === "change")).toBe(true));
    expect(sent.find((b) => b.action === "change")).toMatchObject({ action: "change", session: S1, slot: "aspect", choice: 1 });
    // The answer is the person's now: no chip for it any more.
    await waitFor(() => expect(screen.queryByRole("button", { name: en.inferredChipLabel.replace("{slot}", "Shape").replace("{value}", "16:9") })).toBeNull());
  });

  it("a voice-over film says so, names why Create is not offered, and never mounts Create", async () => {
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByText(en.speechBlocked.voice_unavailable);
    expect(screen.getByText(en.voiceOverNote)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.createBlocked })).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("film-create")).toBeNull();
    expect(created.n).toBe(0);
    expect(document.body.textContent).not.toContain("spoken by the video model");
  });

  it("a film spoken in its clips is refused by its own reason while the cut drops clip sound", async () => {
    voice = { mode: "clip_audio", blocked: ["clip_sound_not_kept"] };
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByText(en.speechBlocked.clip_sound_not_kept);
    expect(screen.queryByTestId("film-create")).toBeNull();
  });

  it("a story planned wordless where its format meant words says so plainly, and Create is S2's", async () => {
    voice = { mode: "off", intent: "voice_over" };
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByTestId("film-create");
    expect(screen.getByText(en.plannedWordless)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Nothing was charged/);
  });

  it("chips show a language by its own name, and its change options too", async () => {
    await open();
    const chip = await screen.findByRole("button", { name: en.inferredChipLabel.replace("{slot}", "Language").replace("{value}", "O'zbek") });
    await act(async () => fireEvent.click(chip));
    const card = await screen.findByTestId("change-card");
    expect(card.textContent).toContain("Русский");
    expect(card.textContent).not.toContain("Russian");
  });

  it("with nothing blocking, Create is S2's as before", async () => {
    voice = { mode: "off" };
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByTestId("film-create");
  });
});
