// @vitest-environment jsdom
/**
 * The owner's "Model API keys" board: what a tap does and what it never does.
 *
 * What would break without these: a key left in the page after it was sent, a key in a URL or in what the page shows, "API verified" shown
 * for a key the vendor refused, a "Format only" vendor presented as verifiable, a link that opens without rel=noopener, a link nobody verified
 * shown as if it were, a stored key described as if runs used it, and a card with no way to remove or retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { jsonRes } from "./helpers/response";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { buildCards, type StoredKey } from "../lib/model-keys";

const h = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/context", async () => {
  const dicts = { en: (await import("../lib/i18n/en")).en, ru: (await import("../lib/i18n/ru")).ru, uz: (await import("../lib/i18n/uz")).uz };
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: dicts[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));

import { ModelKeysBoard } from "../components/model-keys/ModelKeysBoard";

const m = en.modelKeys;
const KEY = "sk-test-AbCdEf0123456789-wxyz";

const STORED: StoredKey[] = [
  { provider: "openai", status: "verified", last4: "wxyz", verifiedAt: "2026-10-25T09:30:00.000Z", checkedByEmail: "o@a.uz" },
  { provider: "kling", status: "format_only", last4: "bbbb", verifiedAt: "2026-10-24T09:30:00.000Z", checkedByEmail: "o@a.uz" },
];
const show = (stored: StoredKey[] = [], configured: string[] | null = []) => render(<ModelKeysBoard cards={buildCards(stored, configured)} />);
const card = (id: string) => document.querySelector(`[data-provider="${id}"]`) as HTMLElement;
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const submit = async (c: HTMLElement) => {
  await act(async () => {
    fireEvent.submit(c.querySelector("form") as HTMLFormElement);
  });
};
const type = (c: HTMLElement, value: string) => fireEvent.change(c.querySelector('input[type="password"]') as HTMLInputElement, { target: { value } });
const bodyOf = (n = 0) => JSON.parse((h.fetch.mock.calls[n][1] as RequestInit).body as string);

beforeEach(() => {
  h.locale = "en";
  h.fetch.mockReset().mockResolvedValue(jsonRes({ ok: true, state: "verified", stored: true }));
  h.refresh.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("every vendor has a card", () => {
  it("with its name, a status chip that says Not set, a password field, 'Verify and save', and no Remove while nothing is stored", () => {
    show();
    const cards = [...document.querySelectorAll("[data-provider]")];
    expect(cards).toHaveLength(13);
    const c = card("openai");
    expect(within(c).getByText(m.status.not_set)).toBeTruthy();
    expect(c.querySelector('input[type="password"]')).toBeTruthy();
    expect(within(c).getByRole("button", { name: m.card.verifyAndSave })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: m.card.remove })).toBeNull();
    expect(c.textContent).not.toContain(m.card.storedKey);
  });

  it("shows the masked last four and the date for a stored key, and Remove", () => {
    show(STORED);
    const c = card("openai");
    expect(within(c).getByText(m.status.verified)).toBeTruthy();
    expect(c.querySelector("[data-stored]")?.textContent).toContain("•••• wxyz");
    expect(c.querySelector("[data-stored]")?.textContent).toContain("2026-10-25");
    expect(within(c).getByRole("button", { name: m.card.remove })).toBeTruthy();
    expect(card("kling").textContent).toContain(m.status.format_only);
  });
});

describe("the key page link", () => {
  it("opens in a new tab with rel=noopener noreferrer, and is the vendor's own page", () => {
    show();
    const link = within(card("openai")).getByRole("link", { name: m.card.getKey }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    for (const a of document.querySelectorAll('a[target="_blank"]')) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("is not invented for a vendor whose page nobody verified: the card says 'link unverified'", () => {
    show();
    const c = card("kling");
    expect(within(c).queryByRole("link", { name: m.card.getKey })).toBeNull();
    expect(c.querySelector("[data-link-unverified]")?.textContent).toBe(m.card.linkUnverified);
  });
});

describe("how the key is checked is said, per vendor", () => {
  it("a vendor with a free check names the request; one without says its key is never sent", () => {
    show();
    expect(card("openai").textContent).toContain("GET /v1/models on api.openai.com");
    expect(card("bfl").textContent).toContain("GET /v1/credits on api.bfl.ai");
    const k = card("kling");
    expect(k.textContent).toContain(m.card.howFormat);
    expect(k.textContent).toContain(m.card.formatOnlyNote);
    expect(card("openai").textContent).not.toContain(m.card.formatOnlyNote);
  });

  it("a vendor with no free check needs a tick first, and its button does not say 'verify'", async () => {
    show();
    const c = card("bytedance");
    const button = within(c).getByRole("button", { name: m.card.saveUnverified }) as HTMLButtonElement;
    type(c, KEY);
    expect(button.disabled).toBe(true);
    await tap(within(c).getByRole("checkbox"));
    expect(button.disabled).toBe(false);
    await submit(c);
    expect(bodyOf()).toEqual({ action: "save", provider: "bytedance", key: KEY, confirm_format_only: true });
  });

  it("says where Kling's two parts go", () => {
    show();
    expect(card("kling").textContent).toContain(m.card.pairedHint);
  });
});

describe("the key field", () => {
  it("is a password field with no name (so it can never be part of a native form submission or a URL), autocomplete off, and a label", () => {
    show();
    const input = card("openai").querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.getAttribute("name")).toBeNull();
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(screen.getAllByLabelText(m.card.keyLabel).length).toBe(13);
    const form = input.closest("form") as HTMLFormElement;
    expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
  });

  it("is emptied the moment the key is sent, and the key is in the request body only", async () => {
    let release!: () => void;
    h.fetch.mockImplementation(() => new Promise((ok) => (release = () => ok(jsonRes({ ok: true, state: "verified", stored: true })))));
    show();
    const c = card("openai");
    type(c, KEY);
    await submit(c);
    expect((c.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/owner/model-keys");
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("POST");
    expect(bodyOf()).toEqual({ action: "save", provider: "openai", key: KEY });
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(within(c).getByText(m.status.checking)).toBeTruthy();
    await act(async () => release());
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain("sk-test");
  });

  it("does nothing for an empty field and sends one request for a double submit", async () => {
    let release!: () => void;
    h.fetch.mockImplementation(() => new Promise((ok) => (release = () => ok(jsonRes({ ok: true, state: "rejected", stored: false })))));
    show();
    const c = card("openai");
    await submit(c);
    expect(h.fetch).not.toHaveBeenCalled();
    type(c, KEY);
    await submit(c);
    type(c, KEY);
    await submit(c);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });
});

describe("what a card says after an attempt", () => {
  const attempt = async (id: string, res: Response, key = KEY) => {
    h.fetch.mockResolvedValue(res);
    show();
    const c = card(id);
    type(c, key);
    await submit(c);
    return c;
  };

  it("verified: 'API verified and saved', and the page is refreshed so the stored state is read back", async () => {
    const c = await attempt("openai", jsonRes({ ok: true, state: "verified", stored: true }));
    expect(c.querySelector("[data-attempt=saved]")?.textContent).toBe(m.result.verified);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("rejected: the chip says so, nothing is claimed saved, and a limited-scope vendor adds its caveat", async () => {
    const c = await attempt("openai", jsonRes({ ok: true, state: "rejected", stored: false }));
    expect(within(c).getByText(m.status.rejected)).toBeTruthy();
    expect(c.querySelector("[data-attempt=rejected]")?.textContent).toContain(m.result.rejected);
    expect(c.querySelector("[data-attempt=rejected]")?.textContent).toContain(m.result.rejectedScoped);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("rejected for the region-bound vendor says which region the check uses", async () => {
    const c = await attempt("alibaba", jsonRes({ ok: true, state: "rejected", stored: false }));
    expect(c.querySelector("[data-attempt=rejected]")?.textContent).toContain(m.result.rejectedRegion);
  });

  it("unreachable: 'Could not reach vendor — retry' with the reason, and the key can be tried again", async () => {
    const c = await attempt("openai", jsonRes({ ok: true, state: "unreachable", reason: "timeout", stored: false }));
    expect(within(c).getByText(m.status.unreachable)).toBeTruthy();
    expect(c.querySelector("[data-attempt=unreachable]")?.textContent).toContain(m.unreachableReason.timeout);
    type(c, KEY);
    expect((within(c).getByRole("button", { name: m.card.verifyAndSave }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a new attempt the vendor refuses is shown as the attempt, and the stored key is said to be unchanged", async () => {
    h.fetch.mockResolvedValue(jsonRes({ ok: true, state: "rejected", stored: false }));
    show(STORED);
    const c = card("openai");
    type(c, KEY);
    await submit(c);
    expect(within(c).getByText(m.status.rejected)).toBeTruthy();
    expect(c.querySelector("[data-stored]")?.textContent).toContain("wxyz");
    expect(c.querySelector("[data-attempt=rejected]")?.textContent).toContain("unchanged");
  });

  it.each([
    [{ status: 403, body: { error: "forbidden" } }, m.err.forbidden],
    [{ status: 401, body: { error: "mfa_required" } }, m.err.mfa_required],
    [{ status: 401, body: { error: "mfa_recent_required" } }, m.err.mfa_recent_required],
    [{ status: 429, body: { error: "rate_limited" } }, m.err.rate_limited],
    [{ status: 404, body: { error: "not_found" } }, m.err.not_found],
    [{ status: 502, body: { ok: false, error: "store_failed" } }, m.err.store_failed],
    [{ status: 400, body: { ok: false, error: "bad_key", reason: "too_short" } }, m.keyReason.too_short],
    [{ status: 500, body: "boom" }, m.err.server],
  ])("a refusal %j is worded, never a bare 'failed'", async ({ status, body }, text) => {
    const c = await attempt("openai", jsonRes(body, status));
    expect(c.querySelector("[data-attempt=error]")?.textContent).toBe(text);
  });

  it("no answer at all is 'no answer from the server'", async () => {
    h.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    show();
    const c = card("openai");
    type(c, KEY);
    await submit(c);
    expect(c.querySelector("[data-attempt=error]")?.textContent).toBe(m.err.network);
  });

  it("never shows the key, whatever came back", async () => {
    const c = await attempt("openai", jsonRes({ ok: false, error: "weird", message: KEY }, 500));
    expect(c.textContent).not.toContain(KEY);
  });
});

describe("remove", () => {
  it("asks first, then sends only the vendor, then refreshes", async () => {
    h.fetch.mockResolvedValue(jsonRes({ ok: true, state: "not_set" }));
    show(STORED);
    const c = card("openai");
    await tap(within(c).getByRole("button", { name: m.card.remove }));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(c.textContent).toContain(m.card.removeAsk);
    await tap(within(c).getByRole("button", { name: m.card.cancel }));
    expect(h.fetch).not.toHaveBeenCalled();
    await tap(within(c).getByRole("button", { name: m.card.remove }));
    await tap(within(c).getByRole("button", { name: m.card.removeYes }));
    expect(bodyOf()).toEqual({ action: "remove", provider: "openai" });
    expect(c.querySelector("[data-attempt=removed]")?.textContent).toBe(m.result.removed);
    expect(h.refresh).toHaveBeenCalled();
  });
});

describe("which key a run uses (the active source)", () => {
  it("env: names the GitHub secret and says the stored key is not the one used", () => {
    show([STORED[0]], ["OPENAI_API_KEY"]);
    const t = card("openai").textContent ?? "";
    expect(t).toContain("OPENAI_API_KEY");
    expect(t).toContain(m.source.envAlsoVault);
  });

  it("vault only: stored, and honestly NOT used by any run yet", () => {
    show([STORED[0]], []);
    expect(card("openai").textContent).toContain(m.source.vault);
  });

  it("none, and unknown when the environment could not be read (never 'none' for that)", () => {
    show([], []);
    expect(card("bfl").textContent).toContain(m.source.none);
    cleanup();
    show([], null);
    expect(card("bfl").textContent).toContain(m.source.unknown);
    expect(card("bfl").textContent).not.toContain(m.source.none);
  });
});

describe("the page note and the three languages", () => {
  it("says that runs still read the environment", () => {
    show();
    expect(screen.getByText(m.vaultNote)).toBeTruthy();
  });

  it.each([["ru", ru.modelKeys], ["uz", uz.modelKeys]] as const)("%s has every string and keeps the placeholders", (locale, d) => {
    h.locale = locale;
    show(STORED, ["OPENAI_API_KEY"]);
    const c = card("openai");
    expect(within(c).getByRole("button", { name: d.card.remove })).toBeTruthy();
    expect(c.textContent).toContain("OPENAI_API_KEY");
    expect(c.textContent).not.toMatch(/\{\w+\}/);
    const shape = (o: unknown, p = ""): string[] =>
      typeof o === "string" ? [p] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${p}.${k}`));
    expect(shape(d)).toEqual(shape(m));
    for (const key of ["howHttp", "verifiedOn", "formatOnlyOn"] as const) {
      expect([...d.card[key].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort()).toEqual([...m.card[key].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort());
    }
    expect([...d.source.env.matchAll(/\{(\w+)\}/g)].map((x) => x[1])).toEqual(["names"]);
  });
});
