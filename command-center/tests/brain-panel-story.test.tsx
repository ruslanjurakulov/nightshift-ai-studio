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
let changeFails = false;
let chooseError: Record<string, unknown> | null = null;

beforeEach(() => {
  sent = [];
  changeFails = false;
  chooseError = null;
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
      if (body.action === "choose" && chooseError) return json(502, chooseError);
      if (body.action === "change" && changeFails) return json(409, { error: "card_changed" });
      if (body.action === "turn") return json(200, { reply: "OK", step: "proposing", card: null, slots, scenarios: [outline("Alpha"), outline("Beta")], brief: { version: 1, kind: "short" } });
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

const chipName = (slot: string, value: string) => en.inferredChipLabel.replace("{slot}", slot).replace("{value}", value);

describe("Nightshift AI panel: story grammar", () => {
  it("inferred slots are short chips; pressing one shows the server's own options, described, and sends the value as a change", async () => {
    await open();
    const chip = await screen.findByRole("button", { name: chipName("Shape", "9:16") });
    expect(chip.textContent).toBe("Shape: 9:16");
    await act(async () => fireEvent.click(chip));
    const card = await screen.findByTestId("change-card");
    expect(card.textContent).toContain(en.aspectNames["16:9"]);
    expect(card.textContent).toContain(en.aspectNames["1:1"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: new RegExp(en.aspectNames["16:9"]) })));
    await waitFor(() => expect(sent.some((b) => b.action === "change")).toBe(true));
    expect(sent.find((b) => b.action === "change")).toMatchObject({ action: "change", session: S1, slot: "aspect", choice: 1 });
    // The answer is the person's now: no chip for it any more.
    await waitFor(() => expect(screen.queryByRole("button", { name: chipName("Shape", "16:9") })).toBeNull());
  });

  it("M1: the card opens right after its chip with focus inside; Escape and Keep it close it and give focus back to the chip", async () => {
    await open();
    const chip = await screen.findByRole("button", { name: chipName("Shape", "9:16") });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.hasAttribute("aria-pressed")).toBe(false);
    await act(async () => fireEvent.click(chip));
    const card = await screen.findByTestId("change-card");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.getAttribute("aria-controls")).toBe(card.id);
    // In the DOM right after the chip that opened it, so Tab from the chip reaches the card, not the next chip.
    expect(chip.nextElementSibling).toBe(card);
    await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    await waitFor(() => expect(screen.queryByTestId("change-card")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: chipName("Shape", "9:16") })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: chipName("Shape", "9:16") })));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: en.changeCancel })));
    await waitFor(() => expect(screen.queryByTestId("change-card")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: chipName("Shape", "9:16") })));
  });

  it("M2: with a shape's card open, a typed message is an ordinary turn and closes the card; only the audience takes the box", async () => {
    await open();
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: chipName("Shape", "9:16") })));
    await screen.findByTestId("change-card");
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("placeholder")).not.toBe(en.shell.ownAnswer);
    await act(async () => { fireEvent.change(box, { target: { value: "make it funnier" } }); });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]).toMatchObject({ action: "turn", text: "make it funnier" });
    expect(sent.some((b) => b.action === "change")).toBe(false);
    expect(screen.queryByTestId("change-card")).toBeNull();
  });

  it("M2: the audience's card makes the box its answer, with the own-answer placeholder", async () => {
    await open();
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: chipName("Audience", "oilalar") })));
    await screen.findByTestId("change-card");
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("placeholder")).toBe(en.shell.ownAnswer);
    await act(async () => { fireEvent.change(box, { target: { value: "grandparents" } }); });
    await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
    await waitFor(() => expect(sent.some((b) => b.action === "change")).toBe(true));
    expect(sent.find((b) => b.action === "change")).toMatchObject({ slot: "audience", own: "grandparents" });
  });

  it("m1: a language chip and its options are in the app's own language; the value sent is the server's", async () => {
    await open();
    const chip = await screen.findByRole("button", { name: chipName("Language", en.languageNames.Uzbek) });
    await act(async () => fireEvent.click(chip));
    const card = await screen.findByTestId("change-card");
    expect(card.textContent).toContain(en.languageNames.Russian);
    expect(card.textContent).not.toContain("O'zbek");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: new RegExp(en.languageNames.Russian) })));
    await waitFor(() => expect(sent.find((b) => b.action === "change")).toMatchObject({ slot: "language", choice: 2 }));
  });

  it("m7: a change that fails closes its card, and the refusal is said", async () => {
    changeFails = true;
    await open();
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: chipName("Shape", "9:16") })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: new RegExp(en.aspectNames["16:9"]) })));
    await waitFor(() => expect(screen.queryByTestId("change-card")).toBeNull());
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("M3: a blocked film (a storyboard saved before the fix round) says why, that nothing was priced once, and offers the way to make it today", async () => {
    voice = { mode: "narration", blocked: ["voice_unavailable", "clip_sound_not_kept"] };
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByText(en.speechBlocked.voice_unavailable);
    expect(screen.getByText(en.speechBlocked.clip_sound_not_kept)).toBeTruthy();
    expect(screen.getAllByText(en.blockedSaved)).toHaveLength(1);
    expect(screen.queryByTestId("film-create")).toBeNull();
    expect(created.n).toBe(0);
    // No dead Create button: the press that can change it, and the storyboard.
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.getByRole("link", { name: en.seeStoryboard })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: en.wordlessAsk })));
    await waitFor(() => expect(sent.some((b) => b.action === "turn" && b.text === en.wordlessAskText)).toBe(true));
    expect(document.body.textContent).not.toMatch(/Nothing was charged|spoken by the video model/);
  });

  it("M4: a narration refusal keeps its own words on the plan_failed path, with or without its chapter", async () => {
    chooseError = { error: "plan_failed", reason: "narration_too_long", step: null };
    let btn = await open();
    await act(async () => fireEvent.click(btn));
    expect(await screen.findByText(en.errors.narration_too_long_plain)).toBeTruthy();
    cleanup();
    chooseError = { error: "plan_failed", reason: "narration_too_long", step: { chapter: 2, chapters: 4, window: 1, windows: 1 } };
    btn = await open();
    await act(async () => fireEvent.click(btn));
    expect(await screen.findByText(en.errors.narration_too_long.replace("{chapter}", "2"))).toBeTruthy();
  });

  it("a story planned wordless where its format meant words says so plainly, and Create is S2's", async () => {
    voice = { mode: "off", intent: "voice_over" };
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByTestId("film-create");
    expect(screen.getByText(en.plannedWordless)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Nothing was charged/);
  });

  it("with nothing blocking, Create is S2's as before", async () => {
    voice = { mode: "off" };
    const btn = await open();
    await act(async () => fireEvent.click(btn));
    await screen.findByTestId("film-create");
  });
});
