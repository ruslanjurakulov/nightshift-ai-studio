import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanClientName, describeRedirect, normalizeResource, validateRedirectUri } from "@/lib/oauth/redirect";
import { authorizeReturnPath, parseAuthorizeParams, redirectWith } from "@/lib/oauth/authorize";
import { safeLoginReturn } from "@/lib/safe-redirect";

/**
 * Redirect URIs are where an authorization code is sent: the open-redirect and
 * redirect_uri-confusion surface of an OAuth server. The TypeScript validator
 * (lib/oauth/redirect.ts) and the database's (oauth_redirect_uri_ok, 0093) are
 * twins; the lab tests the SQL with the lists below, and this file reads those
 * same lists out of the Python test and runs them through the TypeScript one,
 * so the two cannot drift apart unseen.
 */

const LAB = readFileSync(join(__dirname, "..", "..", "tests", "security", "test_sec_mcp_oauth.py"), "utf8");

function pyList(name: string): string[] {
  const block = new RegExp(`${name} = \\[\\n([\\s\\S]*?)\\n\\]`).exec(LAB)?.[1] ?? "";
  return block
    .split("\n")
    .map((l) => /^\s+("(?:[^"\\]|\\.)*"),?(?:\s*#.*)?$/.exec(l)?.[1])
    .filter((x): x is string => !!x)
    .map((lit) => JSON.parse(lit) as string);
}

const BAD = pyList("BAD_URIS");
const GOOD = pyList("GOOD_URIS");

describe("redirect URI validation (twin of oauth_redirect_uri_ok)", () => {
  it("reads the lab's lists (the parity check is not vacuous)", () => {
    expect(BAD.length).toBeGreaterThan(20);
    expect(GOOD.length).toBeGreaterThanOrEqual(8);
    expect(BAD).toContain("https://evil.com@good.com/cb");
    expect(BAD).toContain("http://localhost.evil.com/cb");
  });

  it.each(BAD)("refuses %j", (uri) => {
    expect(validateRedirectUri(uri).ok).toBe(false);
  });

  it.each(GOOD)("accepts %j", (uri) => {
    expect(validateRedirectUri(uri)).toEqual({ ok: true });
  });

  it("refuses non-strings, an oversize URI and a port above 65535", () => {
    for (const v of [null, undefined, 5, {}, ["https://a.example.com/cb"]]) expect(validateRedirectUri(v).ok).toBe(false);
    expect(validateRedirectUri("https://a.example.com:99999/cb")).toEqual({ ok: false, reason: "bad_port" });
    expect(validateRedirectUri("http://127.0.0.1:70000/cb")).toEqual({ ok: false, reason: "bad_port" });
    expect(validateRedirectUri("https://a.example.com/" + "x".repeat(300)).ok).toBe(false);
  });

  it("shows the person where they will be sent, loopback marked as their own computer", () => {
    expect(describeRedirect("https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", local: false });
    expect(describeRedirect("http://127.0.0.1:33418/callback")).toEqual({ host: "127.0.0.1:33418", local: true });
    expect(describeRedirect("http://[::1]:9000/cb").local).toBe(true);
    expect(describeRedirect("cursor://anysphere.cursor-retrieval/oauth/x/callback")).toEqual({ host: "cursor://anysphere.cursor-retrieval", local: true });
  });
});

describe("resource indicators (RFC 8707)", () => {
  const R = "https://nightshift-ai.studio/api/mcp";
  it("accepts the MCP server's own URL, with scheme/host in any case and one trailing slash", () => {
    for (const ok of [R, R + "/", "HTTPS://Nightshift-AI.Studio/api/mcp", "https://nightshift-ai.studio:443/api/mcp"])
      expect(normalizeResource(ok, R), ok).toBe(R);
  });
  it("treats an absent resource as the MCP server (there is no other)", () => {
    expect(normalizeResource(undefined, R)).toBe(R);
    expect(normalizeResource("", R)).toBe(R);
  });
  it.each([
    "https://evil.example/api/mcp",
    "https://nightshift-ai.studio/api/v1",
    "https://nightshift-ai.studio/api/mcp/x",
    "https://nightshift-ai.studio",
    "https://nightshift-ai.studio/api/mcp?x=1",
    "https://nightshift-ai.studio/api/mcp#f",
    "https://user@nightshift-ai.studio/api/mcp",
    "http://nightshift-ai.studio/api/mcp",
    "https://nightshift-ai.studio.evil.com/api/mcp",
    "nightshift-ai.studio/api/mcp",
    "https://nightshift-ai.studio/api/mcp\n",
  ])("refuses %j", (raw) => {
    expect(normalizeResource(raw, R)).toBeNull();
  });
});

describe("what a person sees of an app's name", () => {
  it("strips controls and direction overrides, collapses space, bounds the length, falls back to the host", () => {
    expect(cleanClientName("  Claude‮ gnp.exe \n\t Desktop\u0000 ", "h")).toBe("Claude gnp.exe Desktop");
    expect(cleanClientName("x".repeat(200), "h")).toHaveLength(80);
    expect(cleanClientName("", "claude.ai")).toBe("claude.ai");
    expect(cleanClientName(42, "claude.ai")).toBe("claude.ai");
    expect(cleanClientName("​‮", "host.example")).toBe("host.example");
  });
});

describe("the authorization request", () => {
  const id = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
  it("parses the parameters and refuses a repeated one", () => {
    const ok = parseAuthorizeParams({ client_id: id, redirect_uri: "https://a.example.com/cb", response_type: "code", state: "s", code_challenge: "c", code_challenge_method: "S256" });
    expect(ok).toMatchObject({ ok: true, params: { clientId: id, state: "s", scope: null, resource: null } });
    expect(parseAuthorizeParams({ client_id: id, redirect_uri: ["a", "b"] })).toEqual({ ok: false, reason: "bad_request" });
    expect(parseAuthorizeParams({ client_id: id, redirect_uri: "https://a.example.com/cb", state: ["1", "2"] })).toEqual({ ok: false, reason: "bad_request" });
    expect(parseAuthorizeParams({ client_id: "not-a-uuid", redirect_uri: "x" })).toEqual({ ok: false, reason: "unknown_client" });
    expect(parseAuthorizeParams({ client_id: id })).toEqual({ ok: false, reason: "bad_request" });
  });

  it("adds the answer and the issuer to the registered address, keeping an existing query", () => {
    expect(redirectWith("https://a.example.com/cb", { code: "c", state: "s" }, "https://as.example")).toBe(
      "https://a.example.com/cb?code=c&state=s&iss=https%3A%2F%2Fas.example",
    );
    expect(redirectWith("https://a.example.com/cb?x=1", { error: "access_denied", state: null }, "https://as.example")).toBe(
      "https://a.example.com/cb?x=1&error=access_denied&iss=https%3A%2F%2Fas.example",
    );
    expect(redirectWith("cursor://anysphere.cursor-retrieval/oauth/u/callback", { code: "c" }, "https://as.example")).toMatch(/^cursor:\/\/.*\?code=c&iss=/);
  });

  it("returns a signed-out person to this page with the same query", () => {
    expect(authorizeReturnPath("?client_id=1&state=a%26b")).toBe("/oauth/authorize?client_id=1&state=a%26b");
    expect(authorizeReturnPath("")).toBe("/oauth/authorize");
  });
});

describe("the sign-in return path honours the connection page and nothing else", () => {
  const long = "/oauth/authorize?" + "a=".padEnd(900, "b");
  it("accepts /oauth/authorize with a long query", () => {
    expect(safeLoginReturn(long, "/command-center")).toBe(long);
    expect(safeLoginReturn("/oauth/authorize", "/x")).toBe("/oauth/authorize");
  });
  it.each([
    "https://evil.example/oauth/authorize",
    "//evil.example/oauth/authorize?x=1",
    "/\\evil.example",
    "javascript:alert(1)",
    "/other?x=" + "a".repeat(2000),
    "",
    null,
  ])("sends %j to the default", (raw) => {
    expect(safeLoginReturn(raw as string, "/command-center")).toBe("/command-center");
  });
  it("a lookalike path gets only the ordinary rule: same origin, ordinary length", () => {
    expect(safeLoginReturn("/oauth/authorizex?a=1", "/d")).toBe("/oauth/authorizex?a=1");
    expect(safeLoginReturn("/oauth/authorizex?" + "a".repeat(900), "/d")).toBe("/d");
    expect(safeLoginReturn("/oauth/authorize/../../login", "/d")).toBe("/login"); // resolved by the URL parser, still this origin
  });
  it("never returns a protocol-relative path (dot segments resolve into //host)", () => {
    for (const raw of ["/oauth/authorize/../..//evil.example", "/a/..//evil.example/oauth/authorize"])
      expect(safeLoginReturn(raw, "/command-center")).toBe("/command-center");
  });
  it("keeps the ordinary rule for ordinary paths, with the ordinary length bound", () => {
    expect(safeLoginReturn("/welcome", "/command-center")).toBe("/welcome");
    expect(safeLoginReturn("/welcome?" + "a".repeat(600), "/command-center")).toBe("/command-center");
  });
});
