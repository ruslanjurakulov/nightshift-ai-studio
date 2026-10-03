// @vitest-environment jsdom
/**
 * Channel DNA in the UI (migration 0056): the card on the channels page that
 * shows and edits it, and the two forms that start from it — the Studio panel
 * and the Run now form — each saying "Using channel DNA · Change".
 *
 * What would break without these: a pre-filled value that reads as one the
 * person chose (no hint), a save that sends something other than what the
 * card shows, an Edit button for someone the database would refuse, and a
 * workspace without 0056 shown an empty card as if the channel had no DNA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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
import { ChannelDnaSection } from "@/components/channels/ChannelDnaSection";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { CreateStudio } from "@/components/create/CreateStudio";
import { EMPTY_DNA, dnaFromChannel, type ChannelDna } from "@/lib/channel-dna";
import type { StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
import { VOICES } from "@/lib/ttsModels";
const ORG = "11111111-1111-4111-8111-111111111111";
const KIT = "55555555-5555-4555-8555-555555555555";
const KIT2 = "66666666-6666-4666-8666-666666666666";
const HERO = "77777777-7777-4777-8777-777777777777";
const SIDE = "88888888-8888-4888-8888-888888888888";
const ADAM = "pNInz6obpgDQGcFmaJgB";
const BRIAN = "nPczCjzI2devNBz1zQrb";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const DNA: ChannelDna = dnaFromChannel(
  {
    agent_config: { language: "Uzbek", elevenlabs_voice_id: ADAM },
    default_style_kit_id: KIT,
    dna_format: "shorts",
    dna_aspect: null,
    dna_tone: "calm, curious",
  },
  [HERO],
);
const KITS = [
  { id: KIT, name: "Warm film" },
  { id: KIT2, name: "Neon night" },
];
const CHARS = [
  { id: HERO, name: "hero" },
  { id: SIDE, name: "sidekick" },
];

let posts: Array<{ url: string; body: Record<string, unknown> }>;
let dnaAnswer: () => Promise<Response>;
beforeEach(() => {
  posts = [];
  refresh.mockReset();
  dnaAnswer = () => json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/channels/dna") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return dnaAnswer();
      }
      if (url.startsWith("/api/style-kits")) return json({ org: ORG, kits: [] });
      if (url === "/api/creative/quote") return json({ quote: { credits: 4 } });
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const section = (over: Partial<Parameters<typeof ChannelDnaSection>[0]> = {}) =>
  render(
    withI18n(
      <ChannelDnaSection
        channelId="chan-a"
        dna={DNA}
        kits={KITS}
        characters={CHARS}
        styleState="ready"
        available
        canEdit
        standardVoice={false}
        studioHref="/chronos/studio"
        {...over}
      />,
    ),
  );

describe("the channel's DNA card", () => {
  it("shows every part of the DNA by name, never an id", () => {
    section();
    const card = screen.getByRole("region", { name: t.dna.title });
    expect(card.id).toBe("dna-chan-a");
    for (const text of ["Warm film", "@hero", "Adam", "O'zbek", t.dna.formats.shorts, "9:16", "calm, curious"]) {
      expect(within(card).getByText(text)).toBeTruthy();
    }
    expect(card.textContent).not.toContain(KIT);
    expect(card.textContent).not.toContain(ADAM);
  });

  it("saves exactly what was picked, then refreshes the page", async () => {
    section();
    fireEvent.click(screen.getByRole("button", { name: t.dna.edit }));
    fireEvent.click(screen.getByRole("button", { name: "Neon night" }));
    fireEvent.click(screen.getByRole("button", { name: "@sidekick" }));
    fireEvent.change(screen.getByLabelText(t.dna.voice), { target: { value: BRIAN } });
    fireEvent.click(screen.getByRole("button", { name: "Русский" }));
    fireEvent.click(screen.getByRole("button", { name: t.dna.formats.long }));
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    fireEvent.change(screen.getByLabelText(t.dna.tone), { target: { value: "dry wit" } });
    fireEvent.click(screen.getByRole("button", { name: t.dna.save }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({
      channel_id: "chan-a",
      style_kit_id: KIT2,
      character_ids: [HERO, SIDE],
      voice_id: BRIAN,
      language: "ru",
      format: "long",
      aspect: "1:1",
      tone: "dry wit",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText(t.dna.saved)).toBeTruthy();
  });

  it("a voice the list cannot show is kept, not cleared", async () => {
    section({ dna: { ...DNA, voiceId: "ZzZzZzZzZzZzZzZzZzZz" } });
    expect(screen.getByText(t.dna.customVoice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.dna.edit }));
    expect((screen.getByLabelText(t.dna.voice) as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: t.dna.save }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.voice_id).toBeNull();
  });

  it("a refusal reads as a sentence and the form stays open", async () => {
    dnaAnswer = () => json({ error: "invalid_character" }, 400);
    section();
    fireEvent.click(screen.getByRole("button", { name: t.dna.edit }));
    fireEvent.click(screen.getByRole("button", { name: t.dna.save }));
    expect(await screen.findByText(t.dna.errors.invalid_character)).toBeTruthy();
    expect(screen.getByRole("button", { name: t.dna.save })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("caps characters at eight", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `9999999${i}-9999-4999-8999-999999999999`, name: `c${i}` }));
    section({ dna: { ...DNA, characterIds: [] }, characters: many });
    fireEvent.click(screen.getByRole("button", { name: t.dna.edit }));
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("button", { name: `@c${i}` }));
    expect((screen.getByRole("button", { name: "@c8" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("someone who may not edit sees it, without an Edit button or role words", () => {
    section({ canEdit: false });
    expect(screen.queryByRole("button", { name: t.dna.edit })).toBeNull();
    const text = screen.getByText(t.dna.readOnly).textContent ?? "";
    expect(text).not.toMatch(/owner|editor|viewer|admin/i);
  });

  it("without 0056 it says so instead of showing empty DNA", () => {
    section({ available: false, dna: EMPTY_DNA });
    expect(screen.getByText(t.dna.notEnabled)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.dna.edit })).toBeNull();
  });

  it("a failed read of its characters is not shown as none, and cannot be saved over", () => {
    section({ failed: true });
    expect(screen.getByText(t.dna.readFailed)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.dna.edit })).toBeNull();
  });
});

const MODELS: StudioModel[] = [
  { id: "pics", displayName: "Pictures", capabilities: ["t2i"], beta: false },
  { id: "voice", displayName: "Voice", capabilities: ["tts"], beta: false },
];

describe("the Studio panel starts from the channel's DNA", () => {
  it("starts in the channel's aspect, says so, and links to the card", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} dna={{ aspect: "9:16", voiceId: ADAM, href: "/chronos/channels#dna-chan-a" }} />));
    const aspect = screen.getByRole("group", { name: t.gen.aspectLabel });
    expect(within(aspect).getByRole("button", { name: "9:16" }).getAttribute("aria-pressed")).toBe("true");
    const hint = screen.getByTestId("dna-hint");
    expect(hint.textContent).toContain(t.dna.using);
    expect(within(hint).getByRole("link").getAttribute("href")).toBe("/chronos/channels#dna-chan-a");
    // The person can still change it for this job.
    fireEvent.click(within(aspect).getByRole("button", { name: "16:9" }));
    expect(within(aspect).getByRole("button", { name: "16:9" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("speech starts in the channel's narrator voice", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} dna={{ aspect: null, voiceId: ADAM, href: "/x" }} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.tts }));
    expect((screen.getByRole("combobox", { name: t.gen.ttsVoiceLabel }) as HTMLSelectElement).value).toBe(ADAM);
  });

  it("a retried job's own settings win, and no hint is shown without DNA", () => {
    render(
      withI18n(
        <GeneratePanel
          orgId={ORG}
          models={MODELS}
          initial={{ capability: "t2i", model: "pics", prompt: "a cliff", aspect: "1:1", duration: 5 }}
          dna={{ aspect: "9:16", voiceId: null, href: "/x" }}
        />,
      ),
    );
    const aspect = screen.getByRole("group", { name: t.gen.aspectLabel });
    expect(within(aspect).getByRole("button", { name: "1:1" }).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    expect(screen.queryByTestId("dna-hint")).toBeNull();
  });
});

describe("Run now starts from the channel's DNA", () => {
  const run = (over: Partial<Parameters<typeof CreateStudio>[0]> = {}) =>
    render(
      withI18n(
        <CreateStudio
          channelId="chan-a"
          githubConfigured
          agentConfig={{ language: "Uzbek", elevenlabs_voice_id: ADAM }}
          dna={{ language: "Uzbek", voice: ADAM, duration: "60", href: "/chronos/channels#dna-chan-a" }}
          {...over}
        />,
      ),
    );

  it("fills language, voice and length, and says where they came from", () => {
    run();
    // Language is a select under "More options"; length and voice are the choice cards' one-line values.
    const values = (screen.getAllByRole("combobox") as HTMLSelectElement[]).map((s) => s.value);
    expect(values).toContain("Uzbek");
    const shown = Array.from(document.querySelectorAll(".fl-choice-value")).map((n) => n.textContent);
    expect(shown).toContain(t.agents.runDur1m);
    expect(shown).toContain(VOICES.find((v) => v.id === ADAM)?.name);
    expect(screen.getByTestId("dna-hint")).toBeTruthy();
  });

  it("Home's own choices win over the channel's", () => {
    run({ initial: { brief: "Silk Road", duration: "600", language: "English" } });
    const values = (screen.getAllByRole("combobox") as HTMLSelectElement[]).map((s) => s.value);
    expect(values).toContain("English");
    expect(values).not.toContain("Uzbek");
    const shown = Array.from(document.querySelectorAll(".fl-choice-value")).map((n) => n.textContent);
    expect(shown).toContain(t.agents.runDur10m);
    expect(shown).not.toContain(t.agents.runDur1m);
  });

  it("nothing is sent before Create is confirmed", () => {
    run();
    expect(posts).toHaveLength(0);
  });
});
