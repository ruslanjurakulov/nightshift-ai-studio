import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  OAUTH_PUBLIC_PATHS,
  OAUTH_SCOPES,
  WELL_KNOWN_PATHS,
  authorizationServerMetadata,
  oauthEndpoints,
  protectedResourceMetadata,
} from "@/lib/oauth/config";
import { gateDecision, isOAuthPublicPath, isPublicApiPath } from "@/lib/public-paths";
import { wwwAuthenticate } from "@/lib/api/mcp-http";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null, calls: 0 }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        auth.calls += 1;
        return { data: { user: auth.user } };
      },
    },
  }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
const { middleware, config } = await import("@/middleware");
const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => { regexp: string }[];
};
const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));

beforeEach(() => {
  auth.user = null;
  auth.calls = 0;
});

const O = "https://nightshift-ai.studio";

describe("discovery documents (RFC 9728, RFC 8414, MCP authorization 2026-07-28)", () => {
  const prm = protectedResourceMetadata(O);
  const asm = authorizationServerMetadata(O);

  it("the protected resource names itself, its authorization server and the permissions", () => {
    expect(prm.resource).toBe(O + "/api/mcp");
    expect(prm.authorization_servers).toEqual([O]);
    expect(prm.scopes_supported).toEqual([...OAUTH_SCOPES]);
    expect(prm.bearer_methods_supported).toEqual(["header"]);
  });

  it("the authorization server metadata is internally consistent and offers only what is implemented", () => {
    expect(asm.issuer).toBe(O);
    expect(asm.authorization_endpoint).toBe(O + "/oauth/authorize");
    expect(asm.token_endpoint).toBe(O + "/oauth/token");
    expect(asm.registration_endpoint).toBe(O + "/oauth/register");
    expect(asm.revocation_endpoint).toBe(O + "/oauth/revoke");
    expect(asm.response_types_supported).toEqual(["code"]);
    expect(asm.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(asm.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]); // never "plain"
    expect(asm.authorization_response_iss_parameter_supported).toBe(true);
    // Client ID Metadata Documents need SSRF-safe fetching: not implemented, and it says so.
    expect(asm.client_id_metadata_document_supported).toBe(false);
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"] as const)
      expect(asm[key].startsWith(asm.issuer + "/")).toBe(true);
  });

  it("the 401 challenge points at the path-inserted metadata of the resource and lists the permissions", () => {
    const e = oauthEndpoints(O);
    expect(e.resourceMetadata).toBe(O + "/.well-known/oauth-protected-resource/api/mcp");
    expect(wwwAuthenticate(e.resourceMetadata, OAUTH_SCOPES)).toBe(
      `Bearer resource_metadata="${e.resourceMetadata}", scope="videos:read videos:create videos:publish"`,
    );
    expect(wwwAuthenticate(e.resourceMetadata, ["videos:read"], true)).toMatch(/^Bearer error="invalid_token", error_description="[^"]+", resource_metadata=/);
  });
});

describe("the well-known names, exactly", () => {
  const ROOT = join(__dirname, "..", "app");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

  it("a route file exists for every well-known name and for nothing else under /.well-known", () => {
    const files = walk(join(ROOT, ".well-known")).map((f) => "/" + relative(ROOT, f).split("\\").join("/").replace(/\/route\.ts$/, ""));
    expect(files.sort()).toEqual([...WELL_KNOWN_PATHS].sort());
  });

  it("the public OAuth endpoints are exactly register, token and revoke; the consent page and decision are not public", () => {
    expect([...OAUTH_PUBLIC_PATHS].sort()).toEqual(["/oauth/register", "/oauth/revoke", "/oauth/token"]);
    const routes = walk(join(ROOT, "oauth")).map((f) => "/" + relative(ROOT, f).split("\\").join("/").replace(/\/(route\.ts|page\.tsx)$/, ""));
    expect(routes.sort()).toEqual(["/oauth/authorize", "/oauth/decision", "/oauth/register", "/oauth/revoke", "/oauth/token"]);
    for (const p of ["/oauth/authorize", "/oauth/decision"]) expect(isPublicApiPath(p), p).toBe(false);
  });

  it.each([...WELL_KNOWN_PATHS, ...OAUTH_PUBLIC_PATHS])("%s is served signed out, without a session lookup", async (path) => {
    expect(isOAuthPublicPath(path)).toBe(true);
    expect(gateDecision(path, false)).toBe("pass");
    const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(404);
    expect(auth.calls).toBe(0);
  });

  it.each([
    "/.well-known",
    "/.well-known/",
    "/.well-known/oauth-protected-resource/",
    "/.well-known/oauth-protected-resource/api/mcp/x",
    "/.well-known/oauth-protected-resource/api",
    "/.well-known/oauth-protected-resourcex",
    "/.well-known/OAUTH-PROTECTED-RESOURCE",
    "/.well-known/oauth-authorization-server/x",
    "/.well-known/openid-configuration/other",
    "/.well-known/security.txt",
    "/.well-known/anything",
    "/oauth",
    "/oauth/",
    "/oauth/tokens",
    "/oauth/token/x",
    "/oauth/register/",
    "/oauth/revoke/x",
    "/oauth/Token",
    "/oauth/authorize",
    "/oauth/authorize/x",
    "/oauth/decision",
    "/api/mcp/x",
    "/api/mcp/.well-known/openid-configuration",
    "/api/mcpx",
  ])("%s is NOT public: signed out it is sent to /login or answered with the 404, and the matcher runs", async (path) => {
    expect(isPublicApiPath(path), path).toBe(false);
    expect(matchers.some((r) => r.test(path)), path).toBe(true);
    const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
    if (res.status === 404) return;
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toMatch(/^\/login\/?$/);
  });

  it("sends a signed-out connection request to /login with a return path that comes back to it, and nothing else does", async () => {
    const res = await middleware(new NextRequest("https://nightshift.test/oauth/authorize?client_id=a&state=b%26c"));
    const loc = new URL(res.headers.get("location") ?? "https://x/");
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/oauth/authorize?client_id=a&state=b%26c");
    const other = await middleware(new NextRequest("https://nightshift.test/oauth/decision?x=1"));
    expect(new URL(other.headers.get("location") ?? "https://x/").searchParams.get("next")).toBeNull();
  });

  it("a channel can never be called 'oauth'", async () => {
    const { isValidChannelId } = await import("@/lib/channels");
    expect(isValidChannelId("oauth")).toBe(false);
  });
});

describe("every OAuth route says how it knows who is asking", () => {
  const ROOT = join(__dirname, "..", "app");
  const files = (dir: string) =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map(String)
      .filter((f) => /route\.ts$/.test(f))
      .map((f) => ({ rel: `${dir}/${f}`.split("\\").join("/"), src: readFileSync(join(ROOT, dir, f), "utf8") }));

  it("the session routes ask the session; the public ones are public by design, listed, never cached", () => {
    const decision = files("oauth").find((f) => f.rel === "oauth/decision/route.ts")!;
    expect(decision.src).toContain("getUser(");
    expect(decision.src).toContain('request.headers.get("origin")');
    for (const f of files("oauth").filter((x) => x.rel !== "oauth/decision/route.ts")) {
      expect(f.src, f.rel).toMatch(/Endpoint\(request, oauthDeps\(\)\)/);
      expect(f.src, f.rel).not.toContain("getUser(");
      expect(f.src, f.rel).not.toContain("cookies(");
    }
    for (const f of files(".well-known")) {
      expect(f.src, f.rel).toMatch(/metadataJson\(/);
      expect(f.src, f.rel).not.toMatch(/getUser|cookies|headers\(\)/);
    }
  });

  it("no OAuth route reads a secret from the URL", () => {
    for (const f of [...files("oauth"), ...files(".well-known")]) {
      expect(f.src, f.rel).not.toMatch(/searchParams|nextUrl|new URL\(request\.url\)\.search/);
    }
    const page = readFileSync(join(ROOT, "oauth", "authorize", "page.tsx"), "utf8");
    expect(page).not.toMatch(/console\.(log|info|warn|error)/);
  });

  it("never logs a token, code or verifier", () => {
    for (const rel of ["lib/oauth/endpoints.ts", "app/oauth/decision/route.ts", "lib/server/oauth.ts", "lib/oauth/tokens.ts", "lib/api/mcp-oauth.ts"]) {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(src, rel).not.toMatch(/console\./);
    }
  });
});
