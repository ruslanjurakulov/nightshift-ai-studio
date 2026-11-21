/**
 * /owner/ai and the owner AI panel. What would break: the page drawn for someone who is not the owner; the panel shipped with a
 * figure in it (the facts are built per question, server side); a failure shown as a raw code or without its remedy; a refusal
 * for the second factor without the way to verify. Strings only, no figures.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { failureText } from "../components/owner-console/OwnerAssistant";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({ owner: true }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/server/owner-console", () => ({
  requireOwnerConsole: async () => {
    if (!s.owner) throw new Error("NEXT_NOT_FOUND");
  },
}));
const u = vi.hoisted(() => ({ meta: { full_name: "Aziz Karimov" } as Record<string, unknown> | null }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => (u.meta === null ? null : { id: "u1", user_metadata: u.meta }) }));
const a = en.ownerConsole.assistant;

describe("/owner/ai", () => {
  it("is the 404 for anyone but the owner", async () => {
    s.owner = false;
    const { default: Page } = await import("../app/owner/ai/page");
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    s.owner = true;
  });

  it("draws only the chat: no live cards, no figure, and one line saying it cannot act", async () => {
    const { default: Page } = await import("../app/owner/ai/page");
    const html = renderToStaticMarkup((await Page()) as ReactElement).replace(/&#x27;/g, "'");
    expect(html).toContain(a.noActions);
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain(`<h1 class="chat-title">${a.ai}</h1>`);
    // The cards moved to the Overview (owner decision 2026-11-21): nothing of them may come back to the chat.
    expect(html).not.toContain("ai-kpi");
    expect(html).not.toContain(a.kpi.title);
    expect(html).not.toMatch(/\$\d/);
  });

  it("greets the owner by first name, and with a plain hello when there is no name (never by an address)", async () => {
    const { default: Page } = await import("../app/owner/ai/page");
    const html = renderToStaticMarkup((await Page()) as ReactElement);
    expect(html).toContain(">Hello, Aziz<");
    u.meta = { full_name: "owner@example.com" };
    const plain = renderToStaticMarkup((await Page()) as ReactElement);
    expect(plain).toContain(`>${a.greetingNoName}<`);
    expect(plain).not.toContain("example.com");
    u.meta = { full_name: "Aziz Karimov" };
  });
});

describe("the second-factor refusal in plain words", () => {
  // What would break: the owner reading "second factor ... verify it" and not knowing a 6-digit code is wanted.
  it.each([
    ["en", en, "enter the 6-digit code from your authenticator app again", "Enter code"],
    ["ru", ru, "6-значный код", "Ввести код"],
    ["uz", uz, "6 xonali kodni qayta kiriting", "Kodni kiritish"],
  ] as const)("%s: names the 6-digit code, and the button says to enter it", (_loc, dict, words, button) => {
    const da = dict.ownerConsole.assistant;
    expect(da.errors.second_factor).toContain(words);
    expect(da.errors.second_factor).not.toMatch(/second factor|вторым фактором|ikkinchi omil/i);
    expect(da.verify).toBe(button);
    expect(failureText(da, 401, { error: "second_factor" })).toEqual({ message: da.errors.second_factor, verify: true });
  });
});

describe("the panel's failures", () => {
  it("says the remedy for each refusal the route gives", () => {
    expect(failureText(a, 409, { error: "model_unavailable", reason: "not_configured" }).message).toBe(a.errors.model_unavailable.not_configured);
    expect(failureText(a, 502, { error: "model_failed", reason: "vendor_quota" }).message).toBe(a.errors.model_failed.vendor_quota);
    expect(failureText(a, 502, { error: "model_failed", reason: "output_too_long" }).message).toBe(a.errors.model_failed.output_too_long);
    expect(failureText(a, 429, { error: "daily_cap", limit: 200 }).message).toContain("200");
    expect(failureText(a, 503, { error: "not_enabled", needs: "0203" }).message).toContain("0203");
    expect(failureText(a, 401, { error: "second_factor" })).toEqual({ message: a.errors.second_factor, verify: true });
    expect(failureText(a, 404, { error: "not_found" })).toEqual({ message: a.errors.session, signIn: true });
    // Asking again only where it can help: a daily cap or a missing key refuses again.
    expect(failureText(a, 429, { error: "daily_cap", limit: 200 }).retry).toBeFalsy();
    expect(failureText(a, 502, { error: "model_failed", reason: "vendor_auth" }).retry).toBe(false);
    expect(failureText(a, 502, { error: "model_failed", reason: "timeout" }).retry).toBe(true);
    expect(failureText(a, 503, { error: "unavailable" }).retry).toBe(true);
    // A conversation too long to send says how to get out of it, not "ask again".
    expect(failureText(a, 413, { error: "payload_too_large" })).toEqual({ message: a.errors.tooMuchHistory, clear: true });
  });

  it("never shows a raw code, even one it does not know", () => {
    for (const body of [{ error: "model_failed", reason: "__proto__" }, { error: "model_unavailable", reason: "constructor" }, { error: "weird" }, null]) {
      const m = failureText(a, 500, body as Record<string, unknown> | null).message;
      expect(typeof m).toBe("string");
      expect(m).not.toMatch(/__proto__|constructor|weird/);
    }
  });

  it("has every string in ru and uz, and Uzbek uses the modifier letters", () => {
    const walk = (o: unknown, pre = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => walk(v, `${pre}${k}.`)) : [pre];
    expect(walk(ru.ownerConsole.assistant).sort()).toEqual(walk(a).sort());
    expect(walk(uz.ownerConsole.assistant).sort()).toEqual(walk(a).sort());
    const strings = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(strings) : []);
    for (const t of strings(uz.ownerConsole.assistant)) expect(t, t).not.toMatch(/['‘’]/);
  });
});
