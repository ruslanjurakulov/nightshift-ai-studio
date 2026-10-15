import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
let client: unknown = { rpc };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client }));

import * as route from "@/app/api/email/unsubscribe/route";
import { gateDecision, isAlwaysPublicPath, RESERVED_ROOT_SEGMENTS, UNSUBSCRIBE_API_PATH, UNSUBSCRIBE_PATH } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";

const TOKEN = "ab".repeat(32);
const ORIGIN = "https://app.example.test";
const post = (query: string, body = "") =>
  route.POST(new Request(`${ORIGIN}/api/email/unsubscribe?${query}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }));

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: "ok", error: null });
  client = { rpc };
});

describe("POST /api/email/unsubscribe", () => {
  it("is POST only: a mail scanner opening the link changes nothing", () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it("a mail program's one-click POST turns the mail off and gets a bare 200", async () => {
    const res = await post(`t=${TOKEN}&s=ready`, "List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("email_unsubscribe", { p_token: TOKEN, p_scope: "ready" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the page's button redirects back with done, and the token is not in the redirect", async () => {
    const res = await post(`t=${TOKEN}&s=weekly&l=ru`);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(`${ORIGIN}/unsubscribe`);
    expect(to.searchParams.get("d")).toBe("1");
    expect(to.searchParams.get("s")).toBe("weekly");
    expect(to.searchParams.get("l")).toBe("ru");
    expect(res.headers.get("location")).not.toContain(TOKEN);
  });

  it("an unknown token reads the same as a malformed one, and the database is not asked for a malformed one", async () => {
    rpc.mockResolvedValue({ data: "invalid", error: null });
    const unknown = await post(`t=${TOKEN}&s=ready`, "List-Unsubscribe=One-Click");
    expect(unknown.status).toBe(400);
    rpc.mockClear();
    for (const q of ["", `t=${TOKEN}`, "t=short&s=ready", `t=${TOKEN.toUpperCase()}&s=ready`, `t=${TOKEN}&s=everything`]) {
      const res = await post(q, "List-Unsubscribe=One-Click");
      expect(res.status, q).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
    const form = await post("t=short&s=ready");
    expect(new URL(form.headers.get("location")!).searchParams.get("d")).toBe("0");
  });

  it("a database error or no database is a refusal, never a success", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect((await post(`t=${TOKEN}&s=ready`, "List-Unsubscribe=One-Click")).status).toBe(400);
    client = null;
    expect((await post(`t=${TOKEN}&s=ready`, "List-Unsubscribe=One-Click")).status).toBe(400);
  });

  it("reads only a small body: an oversized one is never taken for a one-click post", async () => {
    const big = "x".repeat(5000) + "List-Unsubscribe=One-Click";
    const res = await post(`t=${TOKEN}&s=ready`, big);
    expect(res.status).toBe(303);
    // The mail was still switched off: the query carries the authority, the body only picks the reply.
    expect(rpc).toHaveBeenCalledWith("email_unsubscribe", { p_token: TOKEN, p_scope: "ready" });
  });

  it("passes back a registered language and drops every other well-formed code (the page then uses the visitor's)", async () => {
    for (const l of ["en", "ru", "uz"]) {
      expect(new URL((await post(`t=${TOKEN}&s=ready&l=${l}`)).headers.get("location")!).searchParams.get("l")).toBe(l);
    }
    for (const l of ["de", "RU", "ru-RU", "rus", "r", "..%2Fru", "ru%0d%0aSet-Cookie:x"]) {
      expect(new URL((await post(`t=${TOKEN}&s=ready&l=${l}`)).headers.get("location")!).searchParams.has("l"), l).toBe(false);
    }
  });

  it("ignores a language that is not a code", async () => {
    const res = await post(`t=${TOKEN}&s=ready&l=%3Cscript%3E`);
    expect(new URL(res.headers.get("location")!).searchParams.has("l")).toBe(false);
  });
});

describe("the public surface for the unsubscribe link", () => {
  it("the page and the route work signed out, exactly", () => {
    expect(gateDecision(UNSUBSCRIBE_PATH, false)).toBe("pass");
    expect(gateDecision(UNSUBSCRIBE_API_PATH, false)).toBe("pass");
    expect(isAlwaysPublicPath(UNSUBSCRIBE_PATH)).toBe(true);
    // A neighbour is not opened by it.
    expect(gateDecision(`${UNSUBSCRIBE_API_PATH}/x`, false)).toBe("to-login");
    expect(gateDecision("/api/email", false)).toBe("to-login");
    expect(gateDecision("/api/email/unsubscribe2", false)).toBe("to-login");
    expect(gateDecision("/unsubscribe/x", false)).toBe("to-login");
  });

  it("no channel can take the word", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("unsubscribe");
    expect(isValidChannelId("unsubscribe")).toBe(false);
  });
});
