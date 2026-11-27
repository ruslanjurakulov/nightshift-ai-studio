// @vitest-environment jsdom
/**
 * The Create page and ElevenLabs' retired Default voices (lib/voiceRetirement.ts). Before 31 Dec 2026 a Default voice
 * is offered with a short tag and one line saying what the tag means; from 1 Jan 2027 it is not offered, and a retired
 * voice (typed, restored, or the channel's own) disables Make with the reason beside it. Nothing is picked in its place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/create" }));
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
import { CreateStudio } from "@/components/create/CreateStudio";
import { fmt } from "@/lib/i18n/core";

const t = dictionaries.en;
const f = t.create.flow;
const GEORGE = "JBFqnCBsd6RMkjVDRZzb";
const ADAM = "pNInz6obpgDQGcFmaJgB";

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

function show(at: string, agentConfig: Record<string, string> | null = null) {
  // Only Date is faked: the component's promises and timers run as usual.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  render(
    <I18nProvider locale="en">
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={agentConfig} canRun />
    </I18nProvider>,
  );
}
function openVoices() {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(f.voiceLabel) }));
  return screen.getByRole("radiogroup", { name: t.create.voicePick });
}
const make = () => screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement;
const brief = () => screen.getByRole("textbox", { name: f.topicTitle });
const typeBrief = () => fireEvent.change(brief(), { target: { value: "Ancient Khiva" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      String(url).startsWith("/api/credits/estimate")
        ? json({ supported: true, enforced: true, exempt: false, estimate: { credits: 120, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 400 })
        : json({ events: [], jobs: null }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("retired ElevenLabs voices on the Create page", () => {
  it("before the date, a Default voice carries a short tag and the long sentence is said once", () => {
    show("2026-12-30T12:00:00Z");
    const group = openVoices();
    expect(within(group).getByRole("radio", { name: /George/ }).textContent).toContain(f.voiceLeavingTag);
    expect(within(group).getByRole("radio", { name: /Adam/ }).textContent).not.toContain(f.voiceLeavingTag);
    expect(screen.getAllByText(f.voiceLeaves)).toHaveLength(1);
  });

  it("from 1 Jan 2027 it is not offered at all", () => {
    show("2027-01-01T00:00:00Z");
    const group = openVoices();
    expect(within(group).queryByRole("radio", { name: /George/ })).toBeNull();
    expect(within(group).getByRole("radio", { name: /Adam/ })).toBeTruthy();
    expect(screen.queryByText(f.voiceLeaves)).toBeNull();
  });

  it("a retired id typed by hand is named, Make is off, and the reason sits next to it", () => {
    show("2027-01-02T00:00:00Z");
    typeBrief();
    fireEvent.click(within(openVoices()).getByRole("radio", { name: f.voiceOwn }));
    fireEvent.change(screen.getByRole("textbox", { name: t.create.voiceCustomId }), { target: { value: GEORGE } });
    expect(screen.getByRole("alert").textContent).toBe(fmt(f.voiceRetired, { name: "George" }));
    expect(make().disabled).toBe(true);
    const reason = document.getElementById(make().getAttribute("aria-describedby")!);
    expect(reason?.textContent).toBe(fmt(f.voiceStops, { name: "George" }));
  });

  it("Enter in the brief says why instead of silently doing nothing", () => {
    show("2027-01-02T00:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: "narrator" });
    typeBrief();
    fireEvent.keyDown(brief(), { key: "Enter" });
    expect(document.activeElement?.id).toBe("fl-voice-stop");
    expect(document.activeElement?.textContent).toBe(fmt(f.voiceStops, { name: "George" }));
    expect(screen.queryByRole("button", { name: t.create.confirm })).toBeNull();
  });
});

describe("the channel's own saved voice on the Create page", () => {
  const narratorOnly = { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: "narrator" };

  it("before the date, a Default narrator is named with the date and a link to change it; Make still works", () => {
    show("2026-11-22T10:00:00Z", narratorOnly);
    expect(screen.getByText(fmt(t.voice.retireLeaving, { slot: t.voice.pickNarrator, name: "George" }))).toBeTruthy();
    expect(screen.getByRole("link", { name: f.voiceChange }).getAttribute("href")).toBe("/chronos/agents");
    typeBrief();
    expect(make().disabled).toBe(false);
  });

  it("after the date, a retired narrator blocks Make until a voice is picked for this video, and says so", () => {
    show("2027-01-02T00:00:00Z", narratorOnly);
    expect(screen.getByText(`${fmt(t.voice.retireGone, { slot: t.voice.pickNarrator, name: "George" })} ${f.voicePickForVideo}`)).toBeTruthy();
    typeBrief();
    expect(make().disabled).toBe(true);
    fireEvent.click(within(openVoices()).getByRole("radio", { name: /Adam/ }));
    expect(make().disabled).toBe(false);
    expect(document.getElementById("fl-voice-stop")).toBeNull();
  });

  it("after the date, a retired quote voice blocks Make whatever narrator is picked, and sends the person to Agents", () => {
    show("2027-01-02T00:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: ADAM, elevenlabs_secondary_voice_id: GEORGE });
    typeBrief();
    fireEvent.click(within(openVoices()).getByRole("radio", { name: /Adam/ }));
    expect(make().disabled).toBe(true);
    expect(document.getElementById("fl-voice-stop")?.textContent).toBe(fmt(f.voiceStopsQuote, { name: "George" }));
    // Picking a narrator does not fix a quote voice, so the narrator hint is not offered for it.
    expect(screen.queryByText(new RegExp(f.voicePickForVideo))).toBeNull();
  });

  it("the same Default voice as narrator and quote voice is one notice, not two", () => {
    show("2026-11-22T10:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: GEORGE });
    expect(screen.getAllByText(/is an ElevenLabs Default voice/)).toHaveLength(1);
    expect(screen.getByText(fmt(t.voice.retireLeaving, { slot: t.voice.pickBoth, name: "George" }))).toBeTruthy();
  });

  it("an Edge channel gets no notice", () => {
    show("2027-01-02T00:00:00Z", { tts_provider: "edge", elevenlabs_voice_id: GEORGE });
    expect(screen.queryByText(/ElevenLabs Default voice/)).toBeNull();
  });
});
