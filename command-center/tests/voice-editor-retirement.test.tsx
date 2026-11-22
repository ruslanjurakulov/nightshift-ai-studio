// @vitest-environment jsdom
/**
 * Agents → Voice warns about a channel's saved ElevenLabs Default voice from now until 31 Dec 2026, and after that
 * says the channel's runs are stopped. ElevenLabs' suggested replacement is marked (and listed first) only inside the
 * account's own voice list, read through the existing /api/setup/voices route, and is said to be missing when the
 * account does not have it. Nothing is replaced or saved for the person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/agents" }));

const postOperator = vi.fn();
const update = vi.fn();
vi.mock("@/lib/operator-post", () => ({ postOperator: (...a: unknown[]) => postOperator(...a) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ update: (row: unknown) => (update(row), { eq: () => Promise.resolve({ error: null }) }) }) }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { fmt } from "@/lib/i18n/core";
import { VoiceEditor } from "@/components/agents/VoiceEditor";
import { DEFAULT_VOICES } from "@/lib/voiceRetirement";

const t = dictionaries.en;
const GEORGE = "JBFqnCBsd6RMkjVDRZzb";
const ELDRIN = DEFAULT_VOICES[GEORGE].suggestedId;
const ADAM = "pNInz6obpgDQGcFmaJgB";
const voice = (voiceId: string, name: string) => ({ voiceId, name, category: "premade", previewUrl: "", labels: "" });

function show(at: string, cfg = { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: "narrator" }) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  render(
    <I18nProvider locale="en">
      <VoiceEditor channelId="chan-a" agentConfig={cfg} />
    </I18nProvider>,
  );
}
const notice = () => screen.queryByTestId("voice-retirement");
const rowNames = () => Array.from(document.querySelectorAll("li")).map((li) => li.querySelector(".truncate")?.textContent);

async function loadAccount(list: ReturnType<typeof voice>[]) {
  postOperator.mockResolvedValueOnce({ ok: true, data: { voices: list } });
  fireEvent.change(screen.getByPlaceholderText(t.voice.keyPlaceholder), { target: { value: "typed-for-this-test" } });
  fireEvent.click(screen.getByRole("button", { name: t.voice.load }));
  await screen.findByText("Adam");
}

beforeEach(() => {
  postOperator.mockReset();
  update.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the channel voice editor and retired Default voices", () => {
  it("before the date it says the saved narrator leaves on 31 Dec and runs stop from 1 Jan", () => {
    show("2026-11-22T10:00:00Z");
    expect(notice()?.textContent).toContain(fmt(t.voice.retireLeaving, { slot: t.voice.pickNarrator, name: "George" }));
    expect(notice()?.textContent).toContain(t.voice.suggestLoad);
    // A static notice is not a live region; only the suggestion line, which changes, is announced.
    expect(notice()?.getAttribute("role")).toBeNull();
    expect(notice()?.querySelector("[aria-live]")?.textContent).toBe(t.voice.suggestLoad);
  });

  it("marks ElevenLabs' suggestion only when the account's list has it, lists it first, and saves nothing by itself", async () => {
    show("2026-11-22T10:00:00Z");
    await loadAccount([voice(ADAM, "Adam"), voice(GEORGE, "George"), voice(ELDRIN, "Eldrin")]);
    expect(notice()?.textContent).toContain(fmt(t.voice.suggestIn, { name: DEFAULT_VOICES[GEORGE].suggested }));
    expect(screen.getAllByText(t.voice.suggestedTag)).toHaveLength(1);
    expect(screen.getByText("Eldrin").closest("li")?.textContent).toContain(t.voice.suggestedTag);
    expect(rowNames()[0]).toBe("Eldrin");
    // George still works until 31 Dec: listed, with the short tag.
    expect(screen.getByText("George").closest("li")?.textContent).toContain(t.voice.leavesTag);
    expect(update).not.toHaveBeenCalled();
  });

  it("the tags sit inside the name's button, so a narrow row never squeezes the name to nothing", async () => {
    show("2026-11-22T10:00:00Z");
    await loadAccount([voice(ADAM, "Adam"), voice(ELDRIN, "Eldrin")]);
    const tag = screen.getByText(t.voice.suggestedTag);
    const nameButton = screen.getByText("Eldrin").closest("button")!;
    expect(nameButton.contains(tag)).toBe(true);
    expect(nameButton.className).toContain("min-w-[8rem]");
  });

  it("says the suggestion is not in the account when it is not, and marks nothing", async () => {
    show("2026-11-22T10:00:00Z");
    await loadAccount([voice(ADAM, "Adam")]);
    expect(notice()?.textContent).toContain(fmt(t.voice.suggestMissing, { name: DEFAULT_VOICES[GEORGE].suggested }));
    expect(screen.queryByText(t.voice.suggestedTag)).toBeNull();
  });

  it("after the date it says runs are stopped, does not list the retired voice, and a retired voice cannot be saved", async () => {
    show("2027-01-01T00:00:00Z");
    expect(notice()?.textContent).toContain(fmt(t.voice.retireGone, { slot: t.voice.pickNarrator, name: "George" }));
    expect((screen.getByRole("button", { name: t.voice.save }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t.voice.retiredNoSave)).toBeTruthy();
    await loadAccount([voice(ADAM, "Adam"), voice(GEORGE, "George")]);
    expect(screen.queryByText("George")).toBeNull();
    // The person's own pick from the account's list is what gets saved.
    fireEvent.click(screen.getByText("Adam"));
    fireEvent.click(screen.getByRole("button", { name: t.voice.save }));
    await screen.findByText(t.voice.saved);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].agent_config.elevenlabs_voice_id).toBe(ADAM);
    // Once saved, the notice is gone: it describes what the channel's runs now use.
    expect(notice()).toBeNull();
  });

  it("one notice when the narrator and the quote voice are the same Default voice", () => {
    show("2026-11-22T10:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: GEORGE });
    expect(notice()?.querySelectorAll("p")).toHaveLength(1);
    expect(notice()?.textContent).toContain(fmt(t.voice.retireLeaving, { slot: t.voice.pickBoth, name: "George" }));
  });

  it("says nothing for a channel whose voices are not Default voices", () => {
    show("2026-11-22T10:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: ADAM, elevenlabs_secondary_voice_id: "narrator" });
    expect(notice()).toBeNull();
  });
});
