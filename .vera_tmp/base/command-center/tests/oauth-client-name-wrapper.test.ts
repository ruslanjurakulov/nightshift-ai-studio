import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { registerEndpoint, type OauthDeps } from "@/lib/oauth/endpoints";
import { RESERVED_NAME, checkClientName, foldClientName, registrationName } from "@/lib/oauth/redirect";
import { MCP_SERVER_NAME } from "@/lib/dev/mcp-clients";
import { FakeOauthDb } from "./helpers/oauth-fake-db";

/**
 * Claude Code registers as "Claude Code (<server name>)", and /mcp tells people
 * to name the server `nightshift`. The anti-impersonation rule refused that name,
 * so the most common real client could not sign in at all. The fix drops one
 * trailing "(nightshift)" and registers what is left; these tests pin both
 * halves: the real client gets through, and nothing that reads as Nightshift
 * ever reaches the consent screen.
 */

const ORIGIN = "https://nightshift-ai.studio";
const REDIRECT = "http://localhost:53682/callback";
const LAB = readFileSync(join(__dirname, "..", "..", "tests", "security", "test_sec_mcp_oauth.py"), "utf8");
const NAME_BAD = (/NAME_BAD = \[\n([\s\S]*?)\n\]/.exec(LAB)?.[1] ?? "")
  .split("\n")
  .map((l) => /^\s+("(?:[^"\\]|\\.)*"),?(?:\s*#.*)?$/.exec(l)?.[1])
  .filter((x): x is string => !!x)
  .map((lit) => JSON.parse(lit) as string);

let db: FakeOauthDb;
let deps: OauthDeps;
beforeEach(() => {
  db = new FakeOauthDb();
  deps = { rpc: db.rpc, origin: ORIGIN, resource: ORIGIN + "/api/mcp" };
});
const register = (client_name: unknown) =>
  registerEndpoint(
    new Request(ORIGIN + "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    }),
    deps,
  );

describe("registrationName", () => {
  it("accepts the name Claude Code sends for the server our snippets add, and keeps only the app's own name", () => {
    expect(MCP_SERVER_NAME).toBe("nightshift");
    expect(registrationName(`Claude Code (${MCP_SERVER_NAME})`)).toEqual({ ok: true, name: "Claude Code" });
    // The person may have typed the server name differently; it is still their label for our server.
    for (const n of ["Claude Code (Nightshift)", "Claude Code (night-shift)", "Claude Code(nightshift)", "Claude Code  ( nightshift )", "Gemini CLI (NIGHTSHIFT)"])
      expect(registrationName(n), n).toEqual({ ok: true, name: n.replace(/\s*\(.*$/, "").trim() });
  });

  it("refuses every name that would still read as Nightshift once the wrapper is gone", () => {
    for (const n of [
      "Nightshift",
      "Nightshift Official",
      "Nightshift (nightshift)",
      "N1ghtsh1ft (nightshift)",
      "(nightshift)",
      " (nightshift)",
      "Claude (Nightshift Official)",
      "Claude (nightshift) helper",
      "Nightshift (Claude Code)",
      "Claude Code (nightshift) (nightshift)",
      "Claude Code (nightshift prod)",
      "Ｎｉｇｈｔｓｈｉｆｔ (nightshift)",
      "Night​shift (nightshift)",
    ])
      expect(registrationName(n).ok, n).toBe(false);
  });

  it("is checkClientName for every name without the wrapper", () => {
    for (const n of ["Claude", "Claude Code (my-laptop)", "Cursor", undefined, null, 42, "", "x".repeat(81), "Visual Studio Code"])
      expect(registrationName(n), String(n)).toEqual(checkClientName(n));
  });

  it("whatever it accepts from the lab's impersonation list, the stored name passes the database's rule on its own", () => {
    expect(NAME_BAD.length).toBeGreaterThan(50);
    for (const n of NAME_BAD) {
      const r = registrationName(n);
      if (!r.ok) continue;
      expect(r.name, JSON.stringify(n)).toBeTruthy();
      expect(foldClientName(r.name!), JSON.stringify(n)).not.toContain(RESERVED_NAME);
      expect(checkClientName(r.name), JSON.stringify(n)).toEqual({ ok: true, name: r.name });
    }
  });
});

describe("POST /oauth/register with a wrapped name", () => {
  it("registers Claude Code as \"Claude Code\" and says so in its answer (RFC 7591 3.2.1)", async () => {
    const res = await register("Claude Code (nightshift)");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_name).toBe("Claude Code");
    expect([...db.clients.values()].map((c) => c.name)).toEqual(["Claude Code"]);
  });

  it("still refuses an impersonation, before the database is asked", async () => {
    for (const n of ["Nightshift", "Nightshift (nightshift)", "(nightshift)", "Nightshift Official", "Claude (Nightshift Official)"]) {
      const res = await register(n);
      expect(res.status, n).toBe(400);
      expect((await res.json()).error, n).toBe("invalid_client_metadata");
    }
    expect(db.clients.size).toBe(0);
  });
});
