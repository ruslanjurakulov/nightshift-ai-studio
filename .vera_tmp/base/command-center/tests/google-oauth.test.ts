import { describe, expect, it, vi, beforeAll } from "vitest";

// server-only guard is meaningless in the test runner.
vi.mock("server-only", () => ({}));

// The module reads these at import time.
process.env.GOOGLE_OAUTH_CLIENT_ID = "cid.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";

let mod: typeof import("../lib/server/google-oauth");
beforeAll(async () => {
  mod = await import("../lib/server/google-oauth");
});

describe("state encode/decode", () => {
  it("round-trips ref + nonce", () => {
    const s = mod.encodeState({ ref: "finance", nonce: "abc-123" });
    expect(mod.decodeState(s)).toEqual({ ref: "finance", nonce: "abc-123" });
  });
  it("rejects garbage", () => {
    expect(mod.decodeState("not-base64-json!!")).toBeNull();
    expect(mod.decodeState(Buffer.from('{"ref":1}').toString("base64url"))).toBeNull();
  });
});

describe("tokenSecretName", () => {
  it("maps the default channel to the legacy secret", () => {
    for (const r of ["", "default", "all", "  DEFAULT "]) {
      expect(mod.tokenSecretName(r)).toBe("YOUTUBE_TOKEN_JSON");
    }
  });
  it("maps a named channel to CHRONOS_YT_TOKEN_<REF>", () => {
    expect(mod.tokenSecretName("finance")).toBe("CHRONOS_YT_TOKEN_FINANCE");
    expect(mod.tokenSecretName("extinct-world")).toBe("CHRONOS_YT_TOKEN_EXTINCT_WORLD");
  });
});

describe("buildAuthUrl", () => {
  it("requests offline access, forces consent, and carries the state + scopes", () => {
    const url = new URL(mod.buildAuthUrl({ origin: "https://app.example", state: "STATE" }));
    const p = url.searchParams;
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("state")).toBe("STATE");
    expect(p.get("redirect_uri")).toBe("https://app.example/api/oauth/youtube/callback");
    expect(p.get("scope")).toContain("youtube.upload");
  });
});

describe("buildTokenJson", () => {
  it("produces the authorized-user shape the bot loads", () => {
    const json = JSON.parse(
      mod.buildTokenJson({ access_token: "at", refresh_token: "rt", scope: "a b" }),
    );
    expect(json).toMatchObject({
      token: "at",
      refresh_token: "rt",
      token_uri: "https://oauth2.googleapis.com/token",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "csecret",
      scopes: ["a", "b"],
    });
  });
});
