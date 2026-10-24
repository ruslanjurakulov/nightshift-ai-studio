// @vitest-environment jsdom
/**
 * The channel card's spend limit, question-comment and watch-next editors (components/channels/ChannelRiskSettings.tsx).
 *
 * What would break without these: a limit typed as 0 or "1e5" written anyway (the worker reads it as no limit at all); a
 * write that replaces the whole config with just the one key (wiping the storyboard review, the publish gate, the voice); a
 * write after an unreadable read; a viewer able to save; a stored value the worker ignores shown as an active limit; the
 * three languages drifting; a provider or model name in the copy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/chronos/channels" }));

type Err = { message: string } | null;
const db: {
  stored: Record<string, unknown> | null;
  updates: Array<Record<string, unknown>>;
  readErr: Err;
  writeErr: Err;
  /** RLS filtering an UPDATE to no rows: no error, nothing written. */
  zeroRows: boolean;
} = {
  stored: {},
  updates: [],
  readErr: null,
  writeErr: null,
  zeroRows: false,
};
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () =>
            Promise.resolve({ data: db.readErr || db.stored === null ? null : { agent_config: db.stored }, error: db.readErr }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: () => ({
          select: () => {
            db.updates.push(payload);
            return Promise.resolve({
              data: db.writeErr ? null : db.zeroRows ? [] : [{ agent_config: payload.agent_config }],
              error: db.writeErr,
            });
          },
        }),
      }),
    }),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ChannelRiskSettings } from "@/components/channels/ChannelRiskSettings";
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
const lastConfig = () => db.updates[db.updates.length - 1].agent_config as Record<string, unknown>;

beforeEach(() => {
  db.stored = {};
  db.updates = [];
  db.readErr = null;
  db.writeErr = null;
  db.zeroRows = false;
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
  it("saves the number merged into the live config, leaving every other key and the controls as they are", async () => {
    db.stored = { language: "Russian", storyboard_review: true, publish_gate: { fact_check: true }, auto_publish: false };
    card();
    fireEvent.change(input(), { target: { value: "25,5" } });
    fireEvent.click(save());
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ ...db.stored, spend_ceiling_usd: 25.5 });
    await waitFor(() => expect(screen.getByText(d().saved)).toBeTruthy());
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("Current limit: $25.50 a month.")).toBeTruthy();
  });

  it("an empty field removes the key (no limit), it does not store 0 or null", async () => {
    db.stored = { language: "Uzbek", spend_ceiling_usd: 40 };
    card({ agent: db.stored });
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ language: "Uzbek" });
    expect("spend_ceiling_usd" in lastConfig()).toBe(false);
  });

  it("Remove limit does the same", async () => {
    db.stored = { spend_ceiling_usd: 40 };
    card({ agent: db.stored });
    fireEvent.click(screen.getByRole("button", { name: d().ceilingRemove }));
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({});
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
  ] as const)("refuses '%s' with its own sentence and writes nothing", async (typed, key) => {
    card();
    fireEvent.change(input(), { target: { value: typed } });
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(key === "ceilingTooLarge" ? "$1,000,000.00" : d()[key].slice(0, 20));
    await new Promise((r) => setTimeout(r, 20));
    expect(db.updates).toEqual([]);
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  it("a person who may not edit cannot write even if the form is submitted", async () => {
    card({ canEdit: false });
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.submit(input().closest("form") as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 20));
    expect(db.updates).toEqual([]);
  });

  it("a read that returns nothing, with no error, is not written to either", async () => {
    db.stored = null;
    card();
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.click(save());
    await screen.findByText(d().notStored);
    expect(db.updates).toEqual([]);
    expect(screen.getByText(d().ceilingNone)).toBeTruthy();
  });

  it("an update that matched no row (RLS filtered it, no error) says nothing was saved and does not show the new limit", async () => {
    db.zeroRows = true;
    card({ agent: { spend_ceiling_usd: 10 } });
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.click(save());
    await screen.findByText(d().notStored);
    expect(screen.queryByText(d().saved)).toBeNull();
    expect(screen.getByText("Current limit: $10.00 a month.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a switch whose update matched no row stays where it was", async () => {
    db.zeroRows = true;
    card();
    fireEvent.click(sw(d().watchLabel));
    await screen.findByText(d().notStored);
    expect(sw(d().watchLabel).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(d().saved)).toBeNull();
  });

  it("an unreadable config is not written to", async () => {
    db.readErr = { message: "permission denied" };
    card();
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.click(save());
    await screen.findByText(/permission denied/);
    expect(db.updates).toEqual([]);
    expect(screen.getByText(d().ceilingNone)).toBeTruthy();
  });

  it("a refused write says so, keeps the old limit on the page, and does not refresh", async () => {
    db.writeErr = { message: "row-level security" };
    card({ agent: { spend_ceiling_usd: 10 } });
    fireEvent.change(input(), { target: { value: "99" } });
    fireEvent.click(save());
    await screen.findByText(/row-level security/);
    expect(screen.getByText("Current limit: $10.00 a month.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("who may raise or remove a limit that is already set (advisory, decided on the live value)", () => {
  const lowerThan = (typed: string) => {
    fireEvent.change(input(), { target: { value: typed } });
    fireEvent.click(save());
  };

  it("an editor may set a first limit", async () => {
    db.stored = { language: "Russian" };
    card({ canRaise: false });
    lowerThan("30");
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ language: "Russian", spend_ceiling_usd: 30 });
  });

  it("an editor may lower one, equal included", async () => {
    db.stored = { spend_ceiling_usd: 40 };
    card({ canRaise: false, agent: db.stored });
    lowerThan("10");
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ spend_ceiling_usd: 10 });
  });

  it("an editor cannot raise one: nothing is written and the sentence says why", async () => {
    db.stored = { spend_ceiling_usd: 40 };
    card({ canRaise: false, agent: db.stored });
    lowerThan("50");
    await screen.findByText(d().ceilingAdminOnly);
    await new Promise((r) => setTimeout(r, 20));
    expect(db.updates).toEqual([]);
    expect(screen.getByText("Current limit: $40.00 a month.")).toBeTruthy();
  });

  it("the live value decides, not what the page was drawn with: a page drawn with no limit cannot raise one set meanwhile", async () => {
    db.stored = { spend_ceiling_usd: 40 };
    card({ canRaise: false, agent: {} });
    lowerThan("50");
    await screen.findByText(d().ceilingAdminOnly);
    expect(db.updates).toEqual([]);
  });

  it("and the other way: a page drawn with a limit may set one where the live config has none", async () => {
    db.stored = {};
    card({ canRaise: false, agent: { spend_ceiling_usd: 5 } });
    lowerThan("50");
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ spend_ceiling_usd: 50 });
  });

  it("an editor cannot remove one: the button is disabled and an empty field is refused", async () => {
    db.stored = { spend_ceiling_usd: 40 };
    card({ canRaise: false, agent: db.stored });
    expect((screen.getByRole("button", { name: d().ceilingRemove }) as HTMLButtonElement).disabled).toBe(true);
    lowerThan("");
    await screen.findByText(d().ceilingAdminOnly);
    expect(db.updates).toEqual([]);
  });

  it("an administrator may raise and remove", async () => {
    db.stored = { spend_ceiling_usd: 40 };
    card({ canRaise: true, agent: db.stored });
    lowerThan("50");
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ spend_ceiling_usd: 50 });
    await waitFor(() => expect(screen.getByRole("button", { name: d().ceilingRemove })).toBeTruthy());
    await waitFor(() => expect(input().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: d().ceilingRemove }));
    await waitFor(() => expect(db.updates).toHaveLength(2));
    expect(lastConfig()).toEqual({});
  });

  it("the two switches are not held to it: an editor can switch either way", async () => {
    card({ canRaise: false });
    fireEvent.click(sw(d().pinnedLabel));
    await waitFor(() => expect(lastConfig()).toEqual({ pinned_comment: false }));
  });

  it.each(LOCALES)("the sentence exists in %s", (loc) => {
    expect(d(loc).ceilingAdminOnly.length).toBeGreaterThan(10);
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
  it("switching the question comment off writes a real false and keeps the rest of the config", async () => {
    db.stored = { storyboard_review: true, watch_next: false, language: "Russian" };
    card({ agent: db.stored });
    fireEvent.click(sw(d().pinnedLabel));
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(lastConfig()).toEqual({ storyboard_review: true, watch_next: false, language: "Russian", pinned_comment: false });
    await waitFor(() => expect(sw(d().pinnedLabel).getAttribute("aria-checked")).toBe("false"));
  });

  it("switching watch-next off and on again writes false, then true", async () => {
    card();
    fireEvent.click(sw(d().watchLabel));
    await waitFor(() => expect(lastConfig()).toEqual({ watch_next: false }));
    await waitFor(() => expect(sw(d().watchLabel).disabled).toBe(false));
    fireEvent.click(sw(d().watchLabel));
    await waitFor(() => expect(db.updates).toHaveLength(2));
    expect(lastConfig()).toEqual({ watch_next: true });
  });

  it("a refused write leaves the switch where it was", async () => {
    db.writeErr = { message: "nope" };
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

  it("it offers no Shorts setting and writes no key but the three", () => {
    const src = readFileSync(join(ROOT, "components/channels/ChannelRiskSettings.tsx"), "utf8");
    expect(src).not.toMatch(/shorts/i);
    expect(src).not.toMatch(/storyboard_review|auto_publish|publish_gate|require_two_person/);
    expect(src).toContain('"pinned_comment" | "watch_next"');
  });
});
