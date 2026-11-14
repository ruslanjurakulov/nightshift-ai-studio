// @vitest-environment jsdom
/**
 * The Create page's voice-model picker never offers an Uzbek video a model that does not speak
 * Uzbek, and never drops a choice without saying so. The run would refuse such a model at
 * preflight (modules/tts_languages.py); the picker saves the person the wait and names the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { dictionaries, type Locale } from "@/lib/i18n";
import { fmt } from "@/lib/i18n/core";
import { CreateStudio } from "@/components/create/CreateStudio";

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).startsWith("/api/credits/estimate")) return json({ supported: false });
      if (String(url).startsWith("/api/agent/events")) return json({ events: [], jobs: null });
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (language: string, locale: Locale = "en") =>
  render(
    <I18nProvider locale={locale}>
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun operator dna={{ language, voice: "", duration: "", href: "/x" }} />
    </I18nProvider>,
  );

function voiceModelSelect(locale: Locale = "en"): HTMLSelectElement {
  const label = screen.getByText(dictionaries[locale].create.voiceModel).closest("label");
  if (!label) throw new Error("voice model picker not rendered");
  return label.querySelector("select") as HTMLSelectElement;
}
const option = (select: HTMLSelectElement, value: string) => Array.from(select.options).find((o) => o.value === value)!;

describe("the voice-model picker and the video's language", () => {
  it("switches off every model that does not speak Uzbek, with the reason, and keeps Eleven v3", () => {
    show("Uzbek");
    const select = voiceModelSelect();
    for (const m of ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"]) {
      expect(option(select, m).disabled, m).toBe(true);
      expect(option(select, m).textContent).toContain(fmt(dictionaries.en.create.voiceModelNoLanguage, { language: "Oʻzbek" }));
    }
    expect(option(select, "eleven_v3").disabled).toBe(false);
  });

  it("warns that the repo default may not speak Uzbek, since this page cannot see what it is", () => {
    show("Uzbek");
    expect(option(voiceModelSelect(), "").textContent).toContain(fmt(dictionaries.en.create.voiceModelDefaultMayNot, { language: "Oʻzbek" }));
  });

  it("says nothing extra for an English video, and disables nothing it can run", () => {
    show("English");
    const select = voiceModelSelect();
    expect(option(select, "").textContent).toBe(dictionaries.en.create.optDefault);
    for (const m of ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"]) expect(option(select, m).disabled, m).toBe(false);
  });

  it("names a choice the language rules out instead of dropping it silently", () => {
    show("English");
    const select = voiceModelSelect();
    fireEvent.change(select, { target: { value: "eleven_multilingual_v2" } });
    const languageSelect = screen.getByText(dictionaries.en.agents.runLangLabel).closest("label")!.querySelector("select")!;
    fireEvent.change(languageSelect, { target: { value: "Uzbek" } });
    expect(select.value).toBe("");
    expect(document.body.textContent).toContain(fmt(dictionaries.en.create.voiceModelDropped, { model: "Multilingual v2", language: "Oʻzbek" }));
  });

  it("speaks Uzbek and Russian too", () => {
    for (const locale of ["uz", "ru"] as const) {
      show("Uzbek", locale);
      expect(option(voiceModelSelect(locale), "").textContent).toContain(fmt(dictionaries[locale].create.voiceModelDefaultMayNot, { language: "Oʻzbek" }));
      cleanup();
    }
  });
});
