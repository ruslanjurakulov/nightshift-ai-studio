// @vitest-environment jsdom
/**
 * The channel card's spend limit, question-comment and watch-next editors (components/channels/ChannelRiskSettings.tsx).
 *
 * What would break without these: a limit typed as 0 or "1e5" written anyway (the worker reads it as no limit at all); a
 * write that replaces the whole config, or that reads it first and writes it back (two writers lose each other's keys: the page
 * sends ONE key to patch_channel_agent_config and never reads); the database's refusal of a raise (migration 0119, hint
 * spend_ceiling_lock) shown as a raw error or not at all; a viewer able to save; a stored value the worker ignores shown as an
 * active limit; the three languages drifting; a provider or model name in the copy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/chronos/channels" }));

type Err = { message: string; code?: string; hint?: string } | null;
const db: {
  /** Every patch_channel_agent_config call the page made. */
  calls: Array<{ fn: string; args: { p_channel_id: string; p_patch: Record<string, unknown> } }>;
  /** What the database answers: an error, or the stored config after the merge. */
  error: Err;
  data: unknown;
  /** Anything the page tries to read or write through the table API. */
  tableTouched: string[];
} = { calls: [], error: null, data: undefined, tableTouched: [] };
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: (fn: string, args: { p_channel_id: string; p_patch: Record<string, unknown> }) => {
      db.calls.push({ fn, args });
      return Promise.resolve({ data: db.error ? null : (db.data ?? { ok: true, agent_config: args.p_patch }), error: db.error });
    },
    from: (table: string) => {
      db.tableTouched.push(table);
      throw new Error("the page must not read or write the table: it patches through the function");
    },
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ChannelRiskSettings } from "@/components/channels/ChannelRiskSettings";
import { isSpendCeilingLockRefusal } from "@/lib/channelRisk";
import { channelRiskEn } from "@/lib/i18n/channel-risk/en";

const ROOT = join(__dirname, "..");
const LOCALES: Locale[] = ["en", "ru", "uz"];
const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;

function card(over: Partial<React.ComponentProps<typeof ChannelRiskSettings>> = {}, locale: Locale = "en") {
  return render(withI18n(<ChannelRiskSettings channelId="chronos" agent={{}} canEdit canRaise {...over} />, locale));
}
const d = (locale: Locale = "en") => dictionaries[locale].channelRisk;
const input = (locale: Locale = "en") => screen.getByLabelText(d(locale).ceilingLabel) as HTMLInputElement;
const save = (locale: Locale = "en") => screen.getByRole("button", { name: d(locale).ceilingSave });
const sw = (label: string) => screen.getByRole("switch", { name: label }) as HTMLButtonElement;
/** The patch of the last call: exactly what the database is asked to merge. */
const lastPatch = () => db.calls[db.calls.length - 1].args.p_patch;

beforeEach(() => {
  db.calls = [];
  db.error = null;
  db.data = undefined;
  db.tableTouched = [];
  refresh.mockClear();
});
afterEach(cleanup);

describe("what is shown", () => {
  it("a channel with nothing set shows no limit and both extras on, as the worker reads it", () => {
    card();
    expect(input().value).toBe("");
    expect(screen.getByText(d().ceilingNone)).toBeTruthy();
    expect(sw(d().pinnedLabel).getAttribute("aria-checked")).toBe("true");
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: d().ceilingRemove })).toBeNull();
  });

  it("a stored limit is shown as the amount, and the extras as off only when they are a real false", () => {
    card({ agent: { spend_ceiling_usd: 25, pinned_comment: false, watch_next: "false" as unknown as boolean } });
    expect(input().value).toBe("25");
    expect(screen.getByText("Current limit: $25.00 a month.")).toBeTruthy();
    expect(sw(d().pinnedLabel).getAttribute("aria-checked")).toBe("false");
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe("true");
  });

  it.each([0, -5, "abc", "NaN", true, []])("a stored %j is no limit to the worker, so the page says no limit", (raw) => {
    card({ agent: { spend_ceiling_usd: raw } });
    expect(input().value).toBe("");
    expect(screen.getByText(d().ceilingNone)).toBeTruthy();
  });

  it("a viewer can change nothing", () => {
    card({ canEdit: false });
    expect(input().disabled).toBe(true);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(sw(d().pinnedLabel).disabled).toBe(true);
    expect(sw(d().watchLabel).disabled).toBe(true);
  });
});

describe("the spend limit", () => {
  it("sends the number as a one-key patch to the function and reads nothing", async () => {
    card({ agent: { language: "Russian", storyboard_review: true } });
    fireEvent.change(input(), { target: { value: "25,5" } });
    fireEvent.click(save());
    await waitFor(() => expect(db.calls).toHaveLength(1));
    expect(db.calls[0]).toEqual({ fn: "patch_channel_agent_config", args: { p_channel_id: "chronos", p_patch: { spend_ceiling_usd: 25.5 } } });
    await waitFor(() => expect(screen.getByText(d().saved)).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("Current limit: $25.50 a month.")).toBeTruthy();
    expect(db.tableTouched).toEqual([]);
  });

  it("an empty field sends a JSON null (the function removes the key), not 0", async () => {
    card({ agent: { language: "Uzbek", spend_ceiling_usd: 40 } });
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(db.calls).toHaveLength(1));
    expect(lastPatch()).toEqual({ spend_ceiling_usd: null });
  });

  it("Remove limit does the same", async () => {
    card({ agent: { spend_ceiling_usd: 40 } });
    fireEvent.click(screen.getByRole("button", { name: d().ceilingRemove }));
    await waitFor(() => expect(db.calls).toHaveLength(1));
    expect(lastPatch()).toEqual({ spend_ceiling_usd: null });
    await waitFor(() => expect(screen.getByText(d().ceilingNone)).toBeTruthy());
  });

  it.each([
    ["0", "ceilingNotPositive"],
    ["0.00", "ceilingNotPositive"],
    ["-5", "ceilingNotPositive"],
    ["abc", "ceilingInvalid"],
    ["1e5", "ceilingInvalid"],
    ["Infinity", "ceilingInvalid"],
    ["25.555", "ceilingInvalid"],
    ["1000000.01", "ceilingTooLarge"],
  ] as const)("refuses '%s' with its own sentence and sends nothing", async (typed, key) => {
    card();
    fireEvent.change(input(), { target: { value: typed } });
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(key === "ceilingTooLarge" ? "$1,000,000.00" : d()[key].slice(0, 20));
    await new Promise((r) => setTimeout(r, 20));
    expect(db.calls).toEqual([]);
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  it("a person who may not edit cannot write even if the form is submitted", async () => {
    card({ canEdit: false });
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.submit(input().closest("form") as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 20));
    expect(db.calls).toEqual([]);
  });

  it("an answer that is not a confirmation says nothing was saved and does not show the new limit", async () => {
    db.data = { ok: false };
    card({ agent: { spend_ceiling_usd: 10 } });
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.click(save());
    await screen.findByText(d().notStored);
    expect(screen.queryByText(d().saved)).toBeNull();
    expect(screen.getByText("Current limit: $10.00 a month.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a channel that is not the caller's (the database's 'not yours', hint channel_not_writable) says nothing was saved", async () => {
    db.error = { message: "channel not found or not yours", code: "42501", hint: "channel_not_writable" };
    card();
    fireEvent.click(sw(d().watchLabel));
    await screen.findByText(d().notStored);
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(d().saved)).toBeNull();
  });

  it("before the migration is applied (the function is unknown) it says so plainly and keeps the old limit", async () => {
    db.error = { message: "Could not find the function public.patch_channel_agent_config(p_channel_id, p_patch) in the schema cache", code: "PGRST202" };
    card({ agent: { spend_ceiling_usd: 10 } });
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.click(save());
    await screen.findByText(d().unavailable);
    expect(screen.getByText("Current limit: $10.00 a month.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("any other refusal shows the database's message, keeps the old limit on the page, and does not refresh", async () => {
    db.error = { message: "invalid_patch: spend_ceiling_usd is a number above 0", code: "22023", hint: "invalid_patch" };
    card({ agent: { spend_ceiling_usd: 10 } });
    fireEvent.change(input(), { target: { value: "99" } });
    fireEvent.click(save());
    await screen.findByText(/invalid_patch/);
    expect(screen.getByText("Current limit: $10.00 a month.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("who may raise or remove a limit that is already set (the database decides, on the row as it is)", () => {
  const send = (typed: string) => {
    fireEvent.change(input(), { target: { value: typed } });
    fireEvent.click(save());
  };
  const lock = { message: "spend_ceiling_lock: only an administrator of this organization may raise or remove a spend limit that is already set", code: "42501", hint: "spend_ceiling_lock" };

  it("an editor's raise is sent, and the database's refusal is worded in the page's language, with the old limit kept", async () => {
    db.error = lock;
    card({ canRaise: false, agent: { spend_ceiling_usd: 40 } });
    send("50");
    await screen.findByText(d().ceilingAdminOnly);
    expect(lastPatch()).toEqual({ spend_ceiling_usd: 50 });
    expect(screen.getByText("Current limit: $40.00 a month.")).toBeTruthy();
    expect(screen.queryByText(/spend_ceiling_lock/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(LOCALES)("the refusal is worded in %s", async (loc) => {
    db.error = lock;
    card({ canRaise: false, agent: { spend_ceiling_usd: 40 } }, loc);
    fireEvent.change(input(loc), { target: { value: "50" } });
    fireEvent.click(save(loc));
    await screen.findByText(d(loc).ceilingAdminOnly);
    if (loc !== "en") expect(d(loc).ceilingAdminOnly).not.toBe(d("en").ceilingAdminOnly);
  });

  it("the refusal is recognised by its hint or by its message prefix, and by nothing else", () => {
    expect(isSpendCeilingLockRefusal({ hint: "spend_ceiling_lock", message: "" })).toBe(true);
    expect(isSpendCeilingLockRefusal({ message: "spend_ceiling_lock: only an administrator" })).toBe(true);
    expect(isSpendCeilingLockRefusal({ code: "42501", message: "only an administrator of this organization may change: auto_publish" })).toBe(false);
    expect(isSpendCeilingLockRefusal({ code: "42501", hint: "ai_disclosure_lock", message: "ai_disclosure_lock: x" })).toBe(false);
    expect(isSpendCeilingLockRefusal(null)).toBe(false);
    expect(isSpendCeilingLockRefusal(undefined)).toBe(false);
  });

  it("the page does not pre-judge from the value it was drawn with: a page drawn with no limit still sends, and one drawn with a limit may set one the database allows", async () => {
    card({ canRaise: false, agent: {} });
    send("50");
    await waitFor(() => expect(db.calls).toHaveLength(1));
    cleanup();
    db.calls = [];
    card({ canRaise: false, agent: { spend_ceiling_usd: 5 } });
    send("50");
    await waitFor(() => expect(db.calls).toHaveLength(1));
    expect(lastPatch()).toEqual({ spend_ceiling_usd: 50 });
  });

  it("an editor is not offered Remove limit; an administrator is", () => {
    card({ canRaise: false, agent: { spend_ceiling_usd: 40 } });
    expect((screen.getByRole("button", { name: d().ceilingRemove }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    card({ canRaise: true, agent: { spend_ceiling_usd: 40 } });
    expect((screen.getByRole("button", { name: d().ceilingRemove }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an administrator's raise and removal are sent as the same patches", async () => {
    card({ canRaise: true, agent: { spend_ceiling_usd: 40 } });
    send("50");
    await waitFor(() => expect(db.calls).toHaveLength(1));
    expect(lastPatch()).toEqual({ spend_ceiling_usd: 50 });
    await waitFor(() => expect(input().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: d().ceilingRemove }));
    await waitFor(() => expect(db.calls).toHaveLength(2));
    expect(lastPatch()).toEqual({ spend_ceiling_usd: null });
  });

  it("the two switches are not held to it: an editor switches either way", async () => {
    card({ canRaise: false });
    fireEvent.click(sw(d().pinnedLabel));
    await waitFor(() => expect(lastPatch()).toEqual({ pinned_comment: false }));
  });
});

describe("the page follows the stored value", () => {
  it("another administrator's change, arriving as new props after a refresh, replaces the limit and the switches shown", () => {
    const view = card({ agent: { spend_ceiling_usd: 10, watch_next: true } });
    expect(input().value).toBe("10");
    view.rerender(
      withI18n(<ChannelRiskSettings channelId="chronos" agent={{ spend_ceiling_usd: 75, watch_next: false }} canEdit canRaise />),
    );
    expect(input().value).toBe("75");
    expect(screen.getByText("Current limit: $75.00 a month.")).toBeTruthy();
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe("false");
  });

  it.each([
    ["only the limit", { spend_ceiling_usd: 10, pinned_comment: true, watch_next: true }, { spend_ceiling_usd: 20, pinned_comment: true, watch_next: true }],
    ["only the question comment", { spend_ceiling_usd: 10, pinned_comment: true }, { spend_ceiling_usd: 10, pinned_comment: false }],
    ["only watch-next", { spend_ceiling_usd: 10, watch_next: true }, { spend_ceiling_usd: 10, watch_next: false }],
  ])("%s changing is enough to redraw", (_n, before, after) => {
    const view = card({ agent: before });
    view.rerender(withI18n(<ChannelRiskSettings channelId="chronos" agent={after} canEdit canRaise />));
    expect(input().value).toBe(String(after.spend_ceiling_usd));
    expect(sw(d().pinnedLabel).getAttribute("aria-checked")).toBe(String((after as { pinned_comment?: boolean }).pinned_comment !== false));
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe(String((after as { watch_next?: boolean }).watch_next !== false));
  });

  it("an unrelated re-render does not wipe what the person is typing", () => {
    const view = card({ agent: { spend_ceiling_usd: 10 } });
    fireEvent.change(input(), { target: { value: "12" } });
    view.rerender(withI18n(<ChannelRiskSettings channelId="chronos" agent={{ spend_ceiling_usd: 10 }} canEdit canRaise />));
    expect(input().value).toBe("12");
  });
});

describe("the two extras", () => {
  it("switching the question comment off sends a real false and only that key", async () => {
    card({ agent: { storyboard_review: true, watch_next: false, language: "Russian" } });
    fireEvent.click(sw(d().pinnedLabel));
    await waitFor(() => expect(db.calls).toHaveLength(1));
    expect(lastPatch()).toEqual({ pinned_comment: false });
    await waitFor(() => expect(sw(d().pinnedLabel).getAttribute("aria-checked")).toBe("false"));
  });

  it("switching watch-next off and on again sends false, then true", async () => {
    card();
    fireEvent.click(sw(d().watchLabel));
    await waitFor(() => expect(lastPatch()).toEqual({ watch_next: false }));
    await waitFor(() => expect(sw(d().watchLabel).disabled).toBe(false));
    fireEvent.click(sw(d().watchLabel));
    await waitFor(() => expect(db.calls).toHaveLength(2));
    expect(lastPatch()).toEqual({ watch_next: true });
  });

  it("a refused write leaves the switch where it was", async () => {
    db.error = { message: "nope" };
    card();
    fireEvent.click(sw(d().watchLabel));
    await screen.findByText(/nope/);
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe("true");
  });
});

describe("the words", () => {
  const keys = Object.keys(channelRiskEn).sort();
  const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const dict = dictionaries[loc].channelRisk as Record<string, string>;
    expect(Object.keys(dict).sort()).toEqual(keys);
    for (const k of keys) {
      const src = (channelRiskEn as Record<string, string>)[k];
      expect(dict[k], `${loc}.${k}`).toBeTruthy();
      expect(fillers(dict[k]), `${loc}.${k}`).toEqual(fillers(src));
    }
  });

  it("names no model or provider in any language", () => {
    const banned = /eleven|openai|gpt|gemini|claude|anthropic|higgsfield|kling|veo|runway|fal\.ai|midjourney|stability|suno/i;
    for (const loc of LOCALES) {
      for (const [k, v] of Object.entries(dictionaries[loc].channelRisk)) expect(v, `${loc}.${k}`).not.toMatch(banned);
    }
  });

  it.each(LOCALES)("renders in %s without a missing key", (loc) => {
    card({}, loc);
    expect(input(loc)).toBeTruthy();
    expect(sw(d(loc).pinnedLabel)).toBeTruthy();
    expect(sw(d(loc).watchLabel)).toBeTruthy();
  });

  it("says the question comment only may be posted, and only after a real publish", () => {
    expect(channelRiskEn.pinnedOnHint).toMatch(/really published.*may post/);
  });

  it("states the limit is monthly, in USD, and that unpriced costs are not counted", () => {
    expect(channelRiskEn.ceilingLabel).toMatch(/Monthly.*USD/);
    expect(channelRiskEn.ceilingHint).toMatch(/without a price are not counted/);
  });
});

describe("where it sits", () => {
  const card_ = readFileSync(join(ROOT, "components/channels/ChannelCard.tsx"), "utf8");

  it("the channel card renders it for anyone who may edit, not only administrators", () => {
    expect(card_).toContain("canEdit={canEdit}");
    expect(card_).toContain("canRaise={canControl}");
  });

  it("it offers no Shorts setting, writes no key but the three, and goes through the function, not the table", () => {
    const src = readFileSync(join(ROOT, "components/channels/ChannelRiskSettings.tsx"), "utf8");
    expect(src).not.toMatch(/shorts/i);
    expect(src).not.toMatch(/storyboard_review|auto_publish|publish_gate|require_two_person/);
    expect(src).toContain('"pinned_comment" | "watch_next"');
    expect(src).toContain("patchChannelAgentConfig(");
    expect(src).not.toMatch(/\.from\(|\.update\(|\.select\(/);
    expect(src).not.toMatch(/advisory/i);
  });

  it("the storyboard switch on the card goes through the function too, and the card no longer calls the limit's check advisory", () => {
    expect(card_).toContain("patchChannelAgentConfig(supabase, channel.channel_id, { storyboard_review: next })");
    expect(card_).not.toMatch(/advisory/i);
    expect(card_).not.toMatch(/\.update\(\{\s*agent_config/);
  });
});
