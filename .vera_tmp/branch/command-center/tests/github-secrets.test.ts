import { describe, expect, it, vi } from "vitest";

// The module is `server-only`; in a test runner that guard has no meaning, so
// it is stubbed out rather than shipped around.
vi.mock("server-only", () => ({}));

const { isWritableSecretName, channelTokenSecret } = await import(
  "../lib/server/github-secrets"
);

/**
 * The allowlist is the whole security boundary of the secrets endpoint: an
 * authenticated operator can write a key, and must not be able to aim the same
 * endpoint at a secret the workflow trusts for something else.
 */
describe("isWritableSecretName", () => {
  it("accepts the pipeline's own API keys", () => {
    for (const name of [
      "GEMINI_API_KEY",
      "PEXELS_API_KEY",
      "ELEVENLABS_API_KEY",
      "YOUTUBE_DATA_API_KEY",
      "YOUTUBE_CLIENT_SECRET_JSON",
      "YOUTUBE_TOKEN_JSON",
      "YOUTUBE_CHANNEL_ID",
    ]) {
      expect(isWritableSecretName(name), name).toBe(true);
    }
  });

  it("accepts a per-channel publishing token", () => {
    expect(isWritableSecretName("CHRONOS_YT_TOKEN_EXTINCT_WORLD")).toBe(true);
    expect(isWritableSecretName("CHRONOS_YT_TOKEN_FINANCE")).toBe(true);
  });

  it("refuses the Supabase service key and anything else infrastructural", () => {
    for (const name of [
      "SUPABASE_SERVICE_KEY",
      "SUPABASE_URL",
      "GITHUB_TOKEN",
      "GITHUB_SECRETS_TOKEN",
      "NPM_TOKEN",
    ]) {
      expect(isWritableSecretName(name), name).toBe(false);
    }
  });

  it("refuses names that only look like a channel token", () => {
    expect(isWritableSecretName("CHRONOS_YT_TOKEN_")).toBe(false);
    expect(isWritableSecretName("chronos_yt_token_a")).toBe(false);
    expect(isWritableSecretName("XCHRONOS_YT_TOKEN_A")).toBe(false);
    expect(isWritableSecretName("CHRONOS_YT_TOKEN_A/../B")).toBe(false);
    expect(isWritableSecretName("CHRONOS_YT_TOKEN_A B")).toBe(false);
    expect(isWritableSecretName("CHRONOS_YT_TOKEN_" + "A".repeat(65))).toBe(false);
  });
});

/** Must match modules/channel_credentials.env_var_name exactly, or the bot
 *  looks for a secret the dashboard never wrote. */
describe("channelTokenSecret", () => {
  it("upper-cases and collapses separators the way the bot does", () => {
    expect(channelTokenSecret("extinct-world")).toBe("CHRONOS_YT_TOKEN_EXTINCT_WORLD");
    expect(channelTokenSecret("finance")).toBe("CHRONOS_YT_TOKEN_FINANCE");
    expect(channelTokenSecret("-a--b-")).toBe("CHRONOS_YT_TOKEN_A_B");
  });
});
