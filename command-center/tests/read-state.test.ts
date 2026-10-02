import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commandCenterChip, knownCount, readFailed } from "../lib/readState";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import type { Dictionary } from "../lib/i18n";

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({ t: null as unknown }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: ctx.t, locale: "en" }) }));
// Shared components on the public pages read the public slice the same way.
vi.mock("@/lib/i18n/public-context", () => ({ usePublicI18n: () => ({ t: ctx.t, locale: "en" }) }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { ErrorState } from "../components/ReadError";
import { readCreditAccount, readCreditPrices } from "../lib/server/credits";
import { EMPTY, FAILED, NO_ROW, esc, supabaseStub } from "./helpers/supabaseStub";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("readFailed / knownCount", () => {
  it("is true only when a read carries an error", () => {
    expect(readFailed({ error: null }, { error: undefined })).toBe(false);
    expect(readFailed({ error: { message: "x" } })).toBe(true);
    expect(readFailed({ error: null }, { error: { message: "x" } })).toBe(true);
    expect(readFailed(null, undefined)).toBe(false);
  });

  it("a count is unknown (null), never 0, when its read failed", () => {
    expect(knownCount(0, false)).toBeNull();
    expect(knownCount(0, true)).toBe(0);
    expect(knownCount(7, true)).toBe(7);
  });
});

describe("commandCenterChip", () => {
  it("never says healthy when the backend is unreadable", () => {
    expect(commandCenterChip({ readable: false, errors24h: null, events: 0 })).toBe("unreadable");
    expect(commandCenterChip({ readable: false, errors24h: 0, events: 50 })).toBe("unreadable");
  });
  it("never says healthy with no events at all", () => {
    expect(commandCenterChip({ readable: true, errors24h: 0, events: 0 })).toBe("noActivity");
  });
  it("attention on recent failures, healthy only with evidence", () => {
    expect(commandCenterChip({ readable: true, errors24h: 2, events: 9 })).toBe("attention");
    expect(commandCenterChip({ readable: true, errors24h: 0, events: 9 })).toBe("healthy");
  });
});

describe("ErrorState", () => {
  for (const [name, t] of [["en", en], ["ru", ru], ["uz", uz]] as [string, Dictionary][]) {
    it(`renders a translated message and Retry (${name})`, () => {
      ctx.t = t;
      const html = renderToStaticMarkup(createElement(ErrorState));
      expect(html).toContain('role="alert"');
      expect(html).toContain(esc(t.common.readFailedTitle));
      expect(html).toContain(esc(t.common.readFailedBody));
      expect(html).toContain(`>${esc(t.common.retry)}<`);
    });
  }

  it("shows a specific message when given one", () => {
    ctx.t = en;
    expect(renderToStaticMarkup(createElement(ErrorState, { message: "Specific." }))).toContain("Specific.");
  });

  it("the new strings exist and differ per language", () => {
    for (const k of ["unknown", "couldNotRead", "readFailedTitle", "readFailedBody", "retry", "retrying"] as const) {
      expect(en.common[k]).toBeTruthy();
      expect(ru.common[k]).toBeTruthy();
      expect(uz.common[k]).toBeTruthy();
      expect(ru.common[k]).not.toBe(en.common[k]);
      expect(uz.common[k]).not.toBe(en.common[k]);
    }
  });
});

describe("readCreditAccount keeps 'read failed' apart from 'no account row'", () => {
  const asClient = (s: unknown) => s as unknown as SupabaseClient;

  it("a failed read is failed, with NO account (never zeros)", async () => {
    const r = await readCreditAccount(asClient(supabaseStub(() => FAILED)), "org");
    expect(r).toMatchObject({ supported: true, failed: true, hasRow: false, account: null });
  });

  it("a missing table is 'not supported', not failed", async () => {
    const r = await readCreditAccount(
      asClient(supabaseStub(() => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }))),
      "org",
    );
    expect(r).toMatchObject({ supported: false, failed: false, account: null });
  });

  it("no row is a real, empty account: zero balance, hasRow false, not failed", async () => {
    const r = await readCreditAccount(asClient(supabaseStub(() => NO_ROW)), "org");
    expect(r).toMatchObject({ supported: true, failed: false, hasRow: false });
    expect(r.account).toEqual({ balance: 0, reserved: 0, available: 0 });
  });

  it("a row is read as is", async () => {
    const r = await readCreditAccount(asClient(supabaseStub(() => ({ data: { balance: 120, reserved: 20 }, error: null }))), "org");
    expect(r).toMatchObject({ failed: false, hasRow: true });
    expect(r.account).toEqual({ balance: 120, reserved: 20, available: 100 });
  });

  it("a failed price read is failed, not an empty price list", async () => {
    expect(await readCreditPrices(asClient(supabaseStub(() => FAILED)))).toMatchObject({ supported: true, failed: true, prices: {} });
    expect(await readCreditPrices(asClient(supabaseStub(() => EMPTY)))).toMatchObject({ supported: true, failed: false, prices: {} });
  });
});
