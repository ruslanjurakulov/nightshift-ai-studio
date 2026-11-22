// @vitest-environment jsdom
/**
 * The Create page and ElevenLabs' retired Default voices (lib/voiceRetirement.ts). Before 31 Dec 2026 a Default voice
 * is offered with a note that it is leaving; from 1 Jan 2027 it is not offered, and a retired id typed in by hand
 * blocks Make with the reason. Nothing is ever picked in its place.
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

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

function show(at: string) {
  // Only Date is faked: the component's promises and timers run as usual.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  render(
    <I18nProvider locale="en">
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: new RegExp(f.voiceLabel) }));
  return screen.getByRole("radiogroup", { name: t.create.voicePick });
}

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
  it("before the date, a Default voice is still offered and says it is leaving", () => {
    const group = show("2026-12-30T12:00:00Z");
    const george = within(group).getByRole("radio", { name: /George/ });
    expect(george.textContent).toContain(f.voiceLeaves);
    // A voice that is not retiring carries no note.
    expect(within(group).getByRole("radio", { name: /Adam/ }).textContent).not.toContain(f.voiceLeaves);
  });

  it("from 1 Jan 2027 it is not offered at all", () => {
    const group = show("2027-01-01T00:00:00Z");
    expect(within(group).queryByRole("radio", { name: /George/ })).toBeNull();
    expect(within(group).getByRole("radio", { name: /Adam/ })).toBeTruthy();
  });

  it("a retired id typed by hand is named, and Make stays off rather than running in another voice", () => {
    const group = show("2027-01-02T00:00:00Z");
    fireEvent.change(screen.getByRole("textbox", { name: f.topicTitle }), { target: { value: "Ancient Khiva" } });
    fireEvent.click(within(group).getByRole("radio", { name: f.voiceOwn }));
    fireEvent.change(screen.getByRole("textbox", { name: t.create.voiceCustomId }), { target: { value: GEORGE } });
    expect(screen.getByRole("alert").textContent).toBe(fmt(f.voiceRetired, { name: "George" }));
    expect((screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the channel's own saved voice on the Create page", () => {
  function showFor(at: string, agentConfig: Record<string, string>) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    render(
      <I18nProvider locale="en">
        <CreateStudio channelId="chan-a" githubConfigured agentConfig={agentConfig} canRun />
      </I18nProvider>,
    );
  }

  it("before the date, a Default narrator is named with the date and a link to change it; Make still works", () => {
    showFor("2026-11-22T10:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: "narrator" });
    expect(screen.getByRole("status").textContent).toContain(fmt(t.voice.retireLeaving, { slot: t.voice.pickNarrator, name: "George" }));
    expect(screen.getByRole("link", { name: f.voiceChange }).getAttribute("href")).toBe("/chronos/agents");
    fireEvent.change(screen.getByRole("textbox", { name: f.topicTitle }), { target: { value: "Ancient Khiva" } });
    expect((screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("after the date, a retired narrator blocks Make until another voice is picked for this video", () => {
    showFor("2027-01-02T00:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: "narrator" });
    fireEvent.change(screen.getByRole("textbox", { name: f.topicTitle }), { target: { value: "Ancient Khiva" } });
    expect((screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.voiceLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: /Adam/ }));
    expect((screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("after the date, a retired quote voice blocks Make whatever narrator is picked", () => {
    showFor("2027-01-02T00:00:00Z", { tts_provider: "elevenlabs", elevenlabs_voice_id: "pNInz6obpgDQGcFmaJgB", elevenlabs_secondary_voice_id: GEORGE });
    fireEvent.change(screen.getByRole("textbox", { name: f.topicTitle }), { target: { value: "Ancient Khiva" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(f.voiceLabel) }));
    fireEvent.click(screen.getByRole("radio", { name: /Adam/ }));
    expect((screen.getByRole("button", { name: t.create.create }) as HTMLButtonElement).disabled).toBe(true);
  });
});
