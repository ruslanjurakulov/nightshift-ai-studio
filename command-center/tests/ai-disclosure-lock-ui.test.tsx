// @vitest-environment jsdom
/**
 * Migration 0114: `ai_disclosure = never` and `ai_disclosure_voice = own_clone` lower what is declared to the platforms, so
 * only a platform administrator may set them (the database refuses everyone else, an organization's admin included). This
 * is the Command Center half: the two settings on the channel card offer those two words only to a platform administrator,
 * show them locked (with the reason) to everyone else, never send one from a person who may not, word the database's refusal
 * in the person's language, and read a stored value the way the pipeline does.
 *
 * What would break without these: a customer offered an option that always fails; a refusal shown as the database's English
 * text; a locked option still sent by a stale page; a stored " Never" read as "auto" (so the page says the label is on while
 * the pipeline sends none); the stripping rule drifting from the SQL's or Python's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/chronos/channels" }));

type Reply = { error: { message: string; code?: string; hint?: string } | null };
const db: { stored: Record<string, unknown>; updates: Array<Record<string, unknown>>; reply: Reply } = {
  stored: {},
  updates: [],
  reply: { error: null },
};
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { agent_config: db.stored }, error: null }) }) }),
      update: (payload: Record<string, unknown>) => ({
        eq: () => {
          db.updates.push(payload);
          return Promise.resolve(db.reply);
        },
      }),
    }),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { AiDisclosureSettings } from "@/components/channels/AiDisclosureSettings";
import {
  AI_LOWERING,
  AI_MODES,
  AI_STRIP_CLASS,
  AI_VOICES,
  aiChoices,
  isAiLockRefusal,
  normalizeAiMode,
  normalizeAiVoice,
} from "@/lib/aiDisclosure";

const ROOT = join(__dirname, "..");
const LOCALES: Locale[] = ["en", "ru", "uz"];
const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;

function settings(over: Partial<React.ComponentProps<typeof AiDisclosureSettings>> = {}, locale: Locale = "en") {
  return render(
    withI18n(<AiDisclosureSettings channelId="chronos" agent={{}} canEdit canLower={false} {...over} />, locale),
  );
}
const modeSelect = (locale: Locale = "en") => screen.getByLabelText(dictionaries[locale].aiLabel.modeLabel) as HTMLSelectElement;
const voiceSelect = (locale: Locale = "en") => screen.getByLabelText(dictionaries[locale].aiLabel.voiceLabel) as HTMLSelectElement;
const options = (el: HTMLSelectElement) => [...el.options].map((o) => ({ value: o.value, disabled: o.disabled, text: o.text }));

beforeEach(() => {
  db.stored = {};
  db.updates = [];
  db.reply = { error: null };
  refresh.mockClear();
});
afterEach(cleanup);

describe("what is offered", () => {
  it("a person who is not a platform administrator sees never and own_clone locked, and every other word open", () => {
    expect(aiChoices("ai_disclosure", false)).toEqual([
      { value: "auto", locked: false },
      { value: "always", locked: false },
      { value: "never", locked: true },
    ]);
    expect(aiChoices("ai_disclosure_voice", false)).toEqual([
      { value: "generic", locked: false },
      { value: "own_clone", locked: true },
      { value: "real_person", locked: false },
    ]);
  });

  it("a platform administrator sees all three words of each, none locked", () => {
    expect(aiChoices("ai_disclosure", true).map((c) => [c.value, c.locked])).toEqual([["auto", false], ["always", false], ["never", false]]);
    expect(aiChoices("ai_disclosure_voice", true).map((c) => [c.value, c.locked])).toEqual([["generic", false], ["own_clone", false], ["real_person", false]]);
  });

  it("the lowering words are exactly the two the pipeline treats as lowering (modules/ai_disclosure.py)", () => {
    expect(AI_LOWERING).toEqual({ ai_disclosure: "never", ai_disclosure_voice: "own_clone" });
    expect(AI_MODES).toEqual(["auto", "always", "never"]);
    expect(AI_VOICES).toEqual(["generic", "own_clone", "real_person"]);
  });

  it("the card renders the options disabled with the reason, for someone who may edit but not lower", () => {
    settings();
    const mode = options(modeSelect());
    expect(mode.map((o) => [o.value, o.disabled])).toEqual([["auto", false], ["always", false], ["never", true]]);
    expect(mode[2].text).toContain(dictionaries.en.aiLabel.locked);
    const voice = options(voiceSelect());
    expect(voice.map((o) => [o.value, o.disabled])).toEqual([["generic", false], ["own_clone", true], ["real_person", false]]);
    expect(screen.getByText(dictionaries.en.aiLabel.lockedNote)).toBeTruthy();
  });

  it("the card renders every option of both enabled for a platform administrator, and no locked note", () => {
    settings({ canLower: true });
    expect(options(modeSelect()).map((o) => [o.value, o.disabled])).toEqual([["auto", false], ["always", false], ["never", false]]);
    expect(options(voiceSelect()).map((o) => [o.value, o.disabled])).toEqual([["generic", false], ["own_clone", false], ["real_person", false]]);
    expect(screen.queryByText(dictionaries.en.aiLabel.lockedNote)).toBeNull();
  });

  it("a viewer of the channel can change nothing", () => {
    settings({ canEdit: false, canLower: false });
    expect(modeSelect().disabled).toBe(true);
    expect(voiceSelect().disabled).toBe(true);
  });
});

describe("what is sent", () => {
  it("an editor raising the label writes the word merged into the live config, leaving every other key as it is", async () => {
    db.stored = { language: "Russian", ai_disclosure_voice: " Own_Clone", storyboard_review: true };
    settings({ agent: db.stored });
    fireEvent.change(modeSelect(), { target: { value: "always" } });
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0].agent_config).toEqual({ language: "Russian", ai_disclosure_voice: " Own_Clone", storyboard_review: true, ai_disclosure: "always" });
    await waitFor(() => expect(screen.getByText(dictionaries.en.aiLabel.saved)).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
  });

  it("a locked word is never sent by a person who may not set it, even if the page is made to ask", async () => {
    settings();
    fireEvent.change(modeSelect(), { target: { value: "never" } });
    fireEvent.change(voiceSelect(), { target: { value: "own_clone" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(db.updates).toEqual([]);
  });

  it("a platform administrator can send both", async () => {
    settings({ canLower: true });
    fireEvent.change(modeSelect(), { target: { value: "never" } });
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect((db.updates[0].agent_config as Record<string, unknown>).ai_disclosure).toBe("never");
    await waitFor(() => expect(modeSelect().disabled).toBe(false));
    fireEvent.change(voiceSelect(), { target: { value: "own_clone" } });
    await waitFor(() => expect(db.updates).toHaveLength(2));
    expect(db.updates[1].agent_config).toMatchObject({ ai_disclosure_voice: "own_clone" });
  });
});

describe("when the database refuses", () => {
  const refusal = { message: "ai_disclosure_lock: only a platform administrator may set: ai_disclosure", code: "42501", hint: "ai_disclosure_lock" };

  it.each(LOCALES)("says so in %s, without the database's own text, and puts the select back", async (locale) => {
    db.reply = { error: refusal };
    // A stale page: the person was a platform administrator when it loaded.
    settings({ canLower: true }, locale);
    fireEvent.change(modeSelect(locale), { target: { value: "never" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(dictionaries[locale].aiLabel.lockRefused);
    expect(alert.textContent).not.toContain("ai_disclosure_lock");
    expect(alert.textContent).not.toContain("platform administrator");
    expect(modeSelect(locale).value).toBe("auto");
  });

  it("another failure is not worded as a lock", async () => {
    db.reply = { error: { message: "network down", code: "08006" } };
    settings({ canLower: true });
    fireEvent.change(modeSelect(), { target: { value: "always" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(dictionaries.en.aiLabel.saveFailed);
    expect(alert.textContent).toContain("network down");
    expect(alert.textContent).not.toContain(dictionaries.en.aiLabel.lockRefused);
  });

  it("recognises the lock by its hint or by the message prefix, and nothing else", () => {
    expect(isAiLockRefusal(refusal)).toBe(true);
    expect(isAiLockRefusal({ message: "ai_disclosure_lock: only a platform administrator may set: ai_disclosure_voice" })).toBe(true);
    expect(isAiLockRefusal({ hint: "ai_disclosure_lock", message: "" })).toBe(true);
    expect(isAiLockRefusal({ code: "42501", message: "only an administrator of this organization may change: auto_publish" })).toBe(false);
    expect(isAiLockRefusal(null)).toBe(false);
    expect(isAiLockRefusal(undefined)).toBe(false);
  });
});

describe("a channel that already carries a locked word", () => {
  it("shows what the pipeline will do (a stored ' Never' reads as never), says it is locked, and can be moved off it", async () => {
    db.stored = { ai_disclosure: " Never", ai_disclosure_voice: "OWN_CLONE" };
    settings({ agent: db.stored });
    expect(modeSelect().value).toBe("never");
    expect(voiceSelect().value).toBe("own_clone");
    expect(screen.getByText(dictionaries.en.aiLabel.currentLocked)).toBeTruthy();
    fireEvent.change(modeSelect(), { target: { value: "auto" } });
    await waitFor(() => expect(db.updates).toHaveLength(1));
    // The voice keeps exactly the text it had: an unrelated save does not rewrite it.
    expect(db.updates[0].agent_config).toEqual({ ai_disclosure: "auto", ai_disclosure_voice: "OWN_CLONE" });
  });
});

describe("reading a stored value the way the pipeline does (modules/ai_disclosure.py)", () => {
  it("mode: exactly one of the three words, case and surrounding space ignored, else auto", () => {
    for (const v of ["never", "Never", "NEVER", " never ", "\tnever\n", " never　", "\u001fnever", "\u0085never"]) expect(normalizeAiMode(v), JSON.stringify(v)).toBe("never");
    for (const v of ["always", " ALWAYS"]) expect(normalizeAiMode(v)).toBe("always");
    // JavaScript's trim() would read these as never; Python's strip() does not, so neither do we.
    for (const v of ["﻿never", "never​", "nevermind", "ne ver", "", null, undefined, 5, true, ["never"], {}]) expect(normalizeAiMode(v), JSON.stringify(v)).toBe("auto");
  });

  it("voice: absent or blank is generic, an unknown word is real_person", () => {
    for (const v of [undefined, null, "", "  ", "　"]) expect(normalizeAiVoice(v), JSON.stringify(v)).toBe("generic");
    for (const v of ["own_clone", "Own_Clone", " OWN_CLONE\n"]) expect(normalizeAiVoice(v)).toBe("own_clone");
    for (const v of ["own clone", "clone", 5, true, ["own_clone"], "﻿own_clone"]) expect(normalizeAiVoice(v), JSON.stringify(v)).toBe("real_person");
    expect(normalizeAiVoice("generic")).toBe("generic");
    expect(normalizeAiVoice("real_person")).toBe("real_person");
  });

  it("the stripped characters are exactly the ones Python's str.strip() removes", () => {
    // Python 3: [c for c in map(chr, range(1, 0x110000)) if c.strip() == ""]
    const python = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
    for (let c = 0x2000; c <= 0x200a; c++) python.add(c);
    const re = new RegExp(`^${AI_STRIP_CLASS}$`);
    const ours = new Set<number>();
    for (let c = 1; c < 0x10000; c++) if (re.test(String.fromCharCode(c))) ours.add(c);
    expect([...ours].filter((c) => !python.has(c)).map((c) => c.toString(16))).toEqual([]);
    expect([...python].filter((c) => !ours.has(c)).map((c) => c.toString(16))).toEqual([]);
  });

  it("is the same character class as migration 0114's ai_disclosure_norm", () => {
    const sql = readFileSync(join(ROOT, "..", "supabase", "migrations", "0114_ai_disclosure_admin_lock.sql"), "utf8");
    const m = sql.match(/'\^(\[[^']*\])\+\|(\[[^']*\])\+\$'/);
    expect(m).toBeTruthy();
    const toChars = (cls: string) => cls.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    expect(toChars(m![1])).toBe(AI_STRIP_CLASS);
    expect(toChars(m![2])).toBe(AI_STRIP_CLASS);
  });
});

describe("copy", () => {
  const flat = (node: unknown, path = ""): [string, string][] =>
    typeof node === "string" ? [[path, node]] : node && typeof node === "object" ? Object.entries(node).flatMap(([k, v]) => flat(v, path ? `${path}.${k}` : k)) : [];
  const source = flat(dictionaries.en.aiLabel);
  const BANNED = /openai|google|runway|kling|veo|sora|elevenlabs|replicate|fal\.ai|minimax|gemini|anthropic|claude|\b(owner|editor|viewer|admin|administrator)\b|владел|редактор\b|наблюдател|администратор|egasi|muharrir|kuzatuvchi/i;

  it.each(["ru", "uz"] as const)("%s carries exactly the keys of en, none empty, and does not answer in English", (loc) => {
    const got = new Map(flat(dictionaries[loc].aiLabel));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      if (text.length > 12) expect(got.get(key), `${loc}.${key}`).not.toBe(text);
    }
  });

  it.each(LOCALES)("%s names no provider and uses no role words", (loc) => {
    for (const [key, text] of flat(dictionaries[loc].aiLabel)) expect(text, `${loc}.${key}`).not.toMatch(BANNED);
  });

  it.each(LOCALES)("%s has a word for every option of both settings", (loc) => {
    const a = dictionaries[loc].aiLabel;
    for (const m of AI_MODES) expect(a.modeOptions[m], `${loc}.modeOptions.${m}`).toBeTruthy();
    for (const v of AI_VOICES) expect(a.voiceOptions[v], `${loc}.voiceOptions.${v}`).toBeTruthy();
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("the Channels page asks the database who is a platform administrator and passes it down; the card passes it on", () => {
    const page = read("app/(app)/[channel]/channels/page.tsx");
    expect(page).toContain("const canLowerAiLabel = await isPlatformAdmin();");
    expect(page).toContain("canLowerAiLabel={canLowerAiLabel}");
    expect(page).toContain("canEdit={canEditDna}");
    const card = read("components/channels/ChannelCard.tsx");
    expect(card).toContain("canLower={canLowerAiLabel}");
    expect(card).toContain("canEdit={canEdit}");
    // fail closed: nobody is a platform administrator until the page says so
    expect(card).toContain("canLowerAiLabel = false");
  });

  it("the settings never decide the lock from an organization role (an organization admin is refused too)", () => {
    const src = read("components/channels/AiDisclosureSettings.tsx");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/atLeast\(|orgRole|isOperator|\badmin\b/);
    expect(src).toContain("const lockedChoice = !canLower && value === AI_LOWERING[key];");
  });
});
