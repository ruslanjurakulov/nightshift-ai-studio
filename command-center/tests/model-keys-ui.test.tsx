// @vitest-environment jsdom
/**
 * The owner's "Model API keys" board: VERIFY AND FORGET.
 *
 * What would break without these: a key left in the page after it was sent, a key in a URL or in what the page shows, "API verified" for a
 * key the vendor refused, a verdict that does not say the key was not saved, a "Format only" vendor presented as verifiable, a link that opens
 * without rel=noopener, a link nobody verified shown as if it were, a Remove or masked tail that implies something is stored, anything written
 * to browser storage, and a card that hides which variable to set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { jsonRes } from "./helpers/response";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { buildCards } from "../lib/model-keys";

const h = vi.hoisted(() => ({ fetch: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => { throw new Error("nothing to refresh: nothing is stored"); } }) }));

import { ModelKeysBoard } from "../components/model-keys/ModelKeysBoard";

const m = en.modelKeys;
const KEY = "sk-test-AbCdEf0123456789-wxyz";
const AT = "2026-10-25T09:30:12.000Z";

const show = (configured: string[] | null = []) => render(<ModelKeysBoard cards={buildCards(configured)} />);
const card = (id: string) => document.querySelector(`[data-provider="${id}"]`) as HTMLElement;
const submit = async (c: HTMLElement) => {
  await act(async () => {
    fireEvent.submit(c.querySelector("form") as HTMLFormElement);
  });
};
const type = (c: HTMLElement, value: string) => fireEvent.change(c.querySelector('input[type="password"]') as HTMLInputElement, { target: { value } });
const bodyOf = (n = 0) => JSON.parse((h.fetch.mock.calls[n][1] as RequestInit).body as string);
const verdict = (state: string, extra: Record<string, unknown> = {}) => jsonRes({ ok: true, state, at: AT, ...extra });

let storageWrites: string[] = [];
beforeEach(() => {
  h.locale = "en";
  h.fetch.mockReset().mockResolvedValue(verdict("verified"));
  vi.stubGlobal("fetch", h.fetch);
  storageWrites = [];
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((k: string) => {
    storageWrites.push(k);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every vendor has a card", () => {
  it("with its name, a 'Not checked' chip, a password field and a Verify button, and nothing that implies a stored key", () => {
    show();
    expect(document.querySelectorAll("[data-provider]")).toHaveLength(14);
    const c = card("openai");
    expect(within(c).getByText(m.status.not_checked)).toBeTruthy();
    expect(c.querySelector('input[type="password"]')).toBeTruthy();
    expect(within(c).getByRole("button", { name: m.card.verify })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: /remove|delete|save/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/••|Vault|Stored key/i);
    expect(screen.getByText(m.nothingStored)).toBeTruthy();
  });

  it("says on every card the exact variable to set and that nothing is stored", () => {
    show();
    expect(card("openai").querySelector("[data-use-it]")?.textContent).toBe(
      "Nothing is stored. To use a verified key, add it to GitHub Actions secrets and the worker environment as OPENAI_API_KEY.",
    );
    expect(card("kling").querySelector("[data-use-it]")?.textContent).toContain("KLING_API_KEY or KLING_ACCESS_KEY + KLING_SECRET_KEY");
    expect(card("google").querySelector("[data-use-it]")?.textContent).toContain("GEMINI_API_KEY or VEO_API_KEY");
    expect(card("runway").querySelector("[data-use-it]")?.textContent).toContain("RUNWAYML_API_SECRET");
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
    expect(m.card.howFormat).toMatch(/sent to our server for a shape check only.*never sent to the vendor and never stored/);
    expect(k.textContent).toContain(m.card.formatOnlyNote);
    expect(card("openai").textContent).not.toContain(m.card.formatOnlyNote);
    expect(k.textContent).toContain(m.card.pairedHint);
  });
});

describe("the key field", () => {
  it("is a password field with no name (so it can never be part of a native form submission or a URL), autocomplete off, and a label", () => {
    show();
    const input = card("openai").querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.getAttribute("name")).toBeNull();
    // Chrome and Firefox ignore autocomplete=off on a password field; new-password keeps them from offering to save the vendor key.
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(screen.getAllByLabelText(m.card.keyLabel).length).toBe(14);
    expect((input.closest("form") as HTMLFormElement).getAttribute("method")?.toLowerCase()).toBe("post");
  });

  it("is emptied the moment the key is sent, and the key is in the request body only", async () => {
    let release!: () => void;
    h.fetch.mockImplementation(() => new Promise((ok) => (release = () => ok(verdict("verified")))));
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
    expect(bodyOf()).toEqual({ action: "verify", provider: "openai", key: KEY });
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(within(c).getByText(m.status.checking)).toBeTruthy();
    await act(async () => release());
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(document.body.innerHTML).not.toContain("sk-test");
  });

  it("does nothing for an empty field and sends one request for a double submit", async () => {
    let release!: () => void;
    h.fetch.mockImplementation(() => new Promise((ok) => (release = () => ok(verdict("rejected")))));
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

  it("a vendor with no free check needs no tick: nothing is saved, so there is nothing to confirm", async () => {
    h.fetch.mockResolvedValue(verdict("format_only"));
    show();
    const c = card("bytedance");
    expect(within(c).queryByRole("checkbox")).toBeNull();
    type(c, "ark-0123456789abcdef-ghijkl");
    await submit(c);
    expect(bodyOf()).toEqual({ action: "verify", provider: "bytedance", key: "ark-0123456789abcdef-ghijkl" });
  });
});

describe("the verdict, for this visit only", () => {
  const attempt = async (id: string, res: Response, key = KEY) => {
    h.fetch.mockResolvedValue(res);
    show();
    const c = card(id);
    type(c, key);
    await submit(c);
    return c;
  };

  it("verified: 'API verified at 09:30 UTC. The key was not saved.'", async () => {
    const c = await attempt("openai", verdict("verified"));
    expect(within(c).getByText(m.status.verified)).toBeTruthy();
    expect(c.querySelector("[data-attempt=verified]")?.textContent).toBe("API verified at 09:30 UTC. The key was not saved.");
  });

  it("format only: said as the weaker claim, with the time, and 'not saved'", async () => {
    const c = await attempt("kling", verdict("format_only"));
    expect(within(c).getByText(m.status.format_only)).toBeTruthy();
    expect(c.querySelector("[data-attempt=format_only]")?.textContent).toBe("Format only, at 09:30 UTC. The vendor did not check this key, and it was not saved.");
  });

  it("rejected: the chip says so, the key is not saved, and a limited-scope vendor adds its caveat", async () => {
    const c = await attempt("openai", verdict("rejected"));
    expect(within(c).getByText(m.status.rejected)).toBeTruthy();
    const t = c.querySelector("[data-attempt=rejected]")?.textContent ?? "";
    expect(t).toContain("The key was not saved.");
    expect(t).toContain(m.verdict.rejectedScoped);
  });

  it("rejected for the region-bound vendor says which region the check uses", async () => {
    const c = await attempt("alibaba", verdict("rejected"));
    expect(c.querySelector("[data-attempt=rejected]")?.textContent).toContain(m.verdict.rejectedRegion);
  });

  it("could not reach: 'Could not reach vendor — retry' with the reason, and the card can be used again", async () => {
    const c = await attempt("openai", verdict("could_not_reach", { reason: "timeout" }));
    expect(within(c).getByText(m.status.could_not_reach)).toBeTruthy();
    const t = c.querySelector("[data-attempt=could_not_reach]")?.textContent ?? "";
    expect(t).toContain("The key was not saved.");
    expect(t).toContain(m.reason.timeout);
    type(c, KEY);
    expect((within(c).getByRole("button", { name: m.card.verify }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    [{ status: 403, body: { error: "forbidden" } }, m.err.forbidden],
    [{ status: 401, body: { error: "mfa_required" } }, m.err.mfa_required],
    [{ status: 401, body: { error: "mfa_recent_required" } }, m.err.mfa_recent_required],
    [{ status: 429, body: { error: "rate_limited" } }, m.err.rate_limited],
    [{ status: 404, body: { error: "not_found" } }, m.err.not_found],
    [{ status: 502, body: { ok: false, error: "verify_failed" } }, m.err.verify_failed],
    [{ status: 400, body: { ok: false, error: "bad_key", reason: "too_short" } }, m.keyReason.too_short],
    [{ status: 500, body: "boom" }, m.err.server],
    [{ status: 200, body: { ok: true, state: "stored", at: AT } }, m.err.server],
    [{ status: 200, body: { ok: true, state: "verified" } }, m.err.server],
  ])("a refusal or an odd answer %j is worded, never a bare 'failed'", async ({ status, body }, text) => {
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

  it("a verdict is not remembered: a fresh render shows 'Not checked' and nothing was written to browser storage or sent again", async () => {
    await attempt("openai", verdict("verified"));
    expect(storageWrites).toEqual([]);
    cleanup();
    show();
    expect(card("openai").getAttribute("data-state")).toBe("not_checked");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(document.cookie).toBe("");
  });
});

describe("which key a run uses", () => {
  it("env: names the GitHub secret and says runs use it", () => {
    show(["OPENAI_API_KEY"]);
    expect(card("openai").querySelector("[data-source]")?.getAttribute("data-source")).toBe("env");
    expect(card("openai").textContent).toContain("The GitHub secret OPENAI_API_KEY is set. Runs use that key.");
  });

  it("none, and unknown when the names could not be read (never 'none' for that)", () => {
    show([]);
    expect(card("bfl").textContent).toContain("The GitHub secret BFL_API_KEY is not set.");
    cleanup();
    show(null);
    expect(card("bfl").textContent).toContain(m.source.unknown);
    expect(card("bfl").textContent).not.toContain("is not set");
  });
});

describe("the three languages", () => {
  it.each([["ru", ru.modelKeys], ["uz", uz.modelKeys]] as const)("%s has every string, keeps the placeholders and shows the variable name", (locale, d) => {
    h.locale = locale;
    show(["OPENAI_API_KEY"]);
    const c = card("openai");
    expect(c.textContent).toContain("OPENAI_API_KEY");
    expect(c.textContent).not.toMatch(/\{\w+\}/);
    expect(within(c).getByRole("button", { name: d.card.verify })).toBeTruthy();
    const shape = (o: unknown, p = ""): string[] =>
      typeof o === "string" ? [p] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${p}.${k}`));
    expect(shape(d)).toEqual(shape(m));
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    for (const [a, b] of [
      [d.card.howHttp, m.card.howHttp],
      [d.card.useIt, m.card.useIt],
      [d.source.env, m.source.env],
      [d.source.none, m.source.none],
      [d.verdict.verified, m.verdict.verified],
      [d.verdict.format_only, m.verdict.format_only],
      [d.verdict.rejected, m.verdict.rejected],
      [d.verdict.couldNotReach, m.verdict.couldNotReach],
    ]) {
      expect(holes(a)).toEqual(holes(b));
    }
  });
});
