/**
 * Breach probes on the Owner Console facts pages (branch claude/sprint-owner-brain-console). Synthetic data only.
 *
 * What would break:
 * - the health page's credential-status lookup uses `in`, which is true for Object.prototype keys: a status string such as
 *   "__proto__" or "constructor" (the column has no CHECK constraint, 0001) makes the page hand React an object or a function
 *   instead of words — the owner's health page dies on one odd row, or draws an empty flag where "unknown" belongs (rule 5);
 * - the real loader (app/owner/_facts.ts, not a mock) must stop the page on OwnerOnlyError (rethrow or 404), never log a
 *   figure, and hand back only a kind on a second-factor refusal;
 * - a customer-typed workspace name carrying a bidi override must not reorder the workspace id drawn beside it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OwnerFacts } from "../lib/owner-console/facts-types";

vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({ load: null as unknown }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, redirect: () => { throw new Error("NEXT_REDIRECT"); } }));
vi.mock("@/lib/server/owner-console", () => ({ requireOwnerConsole: async () => {} }));
vi.mock("@/app/owner/_facts", () => ({ loadOwnerFacts: async () => s.load }));

const AS_OF = "2026-11-21T07:00:00.000Z";
const withStatus = (status: string): OwnerFacts => ({
  version: 1,
  as_of: AS_OF,
  people: { state: "unknown", why: "read failed" },
  revenue: { state: "unknown", why: "read failed" },
  providers: { state: "unknown", why: "read failed" },
  health: {
    state: "measured", as_of: AS_OF,
    value: { channels: [{ channel_id: "ch-z", name: "Zeta", youtube: { token_stored: true, credential_status: status } }], queues: {}, workers: [], doctor: {}, alerts_24h: {} },
  },
});

beforeEach(() => {
  s.load = null;
});

describe("health page: a credential status that names an Object.prototype key", () => {
  for (const status of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    it(`draws "${status}" as unknown, never crashes or draws an empty flag`, async () => {
      s.load = { ok: true, facts: withStatus(status) };
      const mod = await import("../app/owner/health/page");
      const html = renderToStaticMarkup((await mod.default()) as ReactElement);
      // The cell for ch-z must carry the "unknown" tag, exactly as for any other status the dictionary does not know.
      const row = html.slice(html.indexOf("ch-z"));
      const cells = row.slice(0, row.indexOf("</tr>")).split("<td>");
      const youtube = cells[cells.length - 1];
      expect(youtube).toMatch(/oc-tag-unknown/);
    });
  }
});

describe("the real facts loader", () => {
  it("rethrows OwnerOnlyError, maps the second factor to a kind, and logs no figure", async () => {
    vi.resetModules();
    vi.doUnmock("@/app/owner/_facts");
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
    class OwnerOnlyError extends Error {}
    class SecondFactorRequiredError extends Error {}
    let mode = "owner-only";
    vi.doMock("@/lib/server/owner-brain-facts", () => ({
      OwnerOnlyError,
      SecondFactorRequiredError,
      buildOwnerFacts: async () => {
        if (mode === "owner-only") throw new OwnerOnlyError("x");
        if (mode === "2fa") throw new SecondFactorRequiredError("x");
        throw new Error("net_before_fees_30d=480.5 secret-figure");
      },
    }));
    const { loadOwnerFacts } = await import("../app/owner/_facts");
    // Rethrown or turned into the 404: either way the page stops; it must never resolve into something drawn.
    const denied = await loadOwnerFacts().then(
      (v) => ({ resolved: v }),
      (e: unknown) => ({ rejected: e }),
    );
    expect("rejected" in denied).toBe(true);
    const err = (denied as { rejected: unknown }).rejected;
    expect(err instanceof OwnerOnlyError || (err instanceof Error && err.message === "NEXT_NOT_FOUND")).toBe(true);
    mode = "2fa";
    expect(await loadOwnerFacts()).toEqual({ ok: false, kind: "second_factor" });
    mode = "boom";
    expect(await loadOwnerFacts()).toEqual({ ok: false, kind: "failed" });
    expect(JSON.stringify(errors)).not.toMatch(/480|secret-figure/);
    spy.mockRestore();
  });
});

// A workspace name is customer-typed and may carry a right-to-left override (U+202E). Drawn inline beside the workspace id in
// one cell without isolation, the override runs on past the name and the owner reads the id (and anything after it) reversed:
// "#abcd1234" shows as "4321dcba#". The name must be bidi-isolated (<bdi>, or dir="auto" on its own element). Fixed: <bdi>.
describe("users page: a customer-typed workspace name cannot reorder the text around it", () => {
  it("isolates the name from the workspace id beside it", async () => {
    s.load = {
      ok: true,
      facts: {
        version: 1, as_of: AS_OF,
        revenue: { state: "unknown", why: "read failed" }, providers: { state: "unknown", why: "read failed" }, health: { state: "unknown", why: "read failed" },
        people: { state: "measured", as_of: AS_OF, value: { recent_plan_changes: [{ workspace: "‮evil co", workspace_id: "abcd1234", plan: "creator", status: "active", at: AS_OF }] } },
      } satisfies OwnerFacts,
    };
    // An earlier test in this file swaps in the real loader; this one needs the stub back.
    vi.resetModules();
    vi.doMock("@/app/owner/_facts", () => ({ loadOwnerFacts: async () => s.load }));
    const mod = await import("../app/owner/users/page");
    const html = renderToStaticMarkup((await mod.default()) as ReactElement);
    expect(html).toMatch(/<bdi[^>]*>‮evil co<\/bdi>|dir="auto"[^>]*>‮evil co</);
  });
});
