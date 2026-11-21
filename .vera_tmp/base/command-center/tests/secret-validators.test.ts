import { describe, expect, it } from "vitest";
import { validateSecretValue, validateVariableValue } from "../lib/server/secret-validators";

/**
 * Per-name checks for the GitHub secret and variable routes (BR-S-020). What would break without them: an alert
 * address or Slack URL swapped for an attacker's, a Google token JSON that sends the refresh token to another host,
 * and a value with `$` or a line break that makes deploy_web.yml refuse every deploy.
 */

// Assembled from parts so a push scanner does not mistake the fixture for a live webhook.
const SLACK_PATH = ["services", "T01ABCDEF", "B01ABCDEF", "abcdefghijklmnopqrstuvwx"].join("/");
const SLACK = `https://hooks.slack.com/${SLACK_PATH}`;
const GOOGLE_TOKEN = JSON.stringify({
  token: "ya29.x",
  refresh_token: "1//0abc",
  token_uri: "https://oauth2.googleapis.com/token",
  client_id: "id.apps.googleusercontent.com",
  client_secret: "s",
});
const CLIENT_FILE = JSON.stringify({
  installed: { client_id: "id", client_secret: "s", token_uri: "https://oauth2.googleapis.com/token", auth_uri: "https://accounts.google.com/o/oauth2/auth" },
});

const reason = (r: ReturnType<typeof validateSecretValue>) => (r.ok ? "ok" : r.reason);

describe("secrets: SLACK_WEBHOOK_URL", () => {
  it("accepts a real-looking incoming webhook, trimmed", () => {
    expect(validateSecretValue("SLACK_WEBHOOK_URL", `  ${SLACK}\n`)).toEqual({ ok: true, value: SLACK });
  });
  it.each([
    ["http scheme", SLACK.replace("https", "http"), "bad_url"],
    ["another host", `https://evil.example/${SLACK_PATH}`, "bad_host"],
    ["look-alike host", `https://hooks.slack.com.evil.example/${SLACK_PATH}`, "bad_host"],
    ["userinfo trick", `https://hooks.slack.com@evil.example/${SLACK_PATH}`, "bad_url"],
    ["a query", `${SLACK}?x=1`, "bad_url"],
    ["a port", SLACK.replace(".com", ".com:8443"), "bad_url"],
    ["wrong path", "https://hooks.slack.com/other/path", "bad_shape"],
    ["a dollar", `${SLACK}$x`, "forbidden_chars"],
    ["an inner newline", `${SLACK}\nSLACK=1`, "control_chars"],
    ["not a URL", "hello", "bad_url"],
  ])("refuses %s", (_label, value, why) => {
    expect(reason(validateSecretValue("SLACK_WEBHOOK_URL", value))).toBe(why);
  });
});

describe("secrets: keys and ids", () => {
  it("Resend keys start with re_", () => {
    expect(validateSecretValue("RESEND_API_KEY", "re_AbCdEf123456_xyz").ok).toBe(true);
    expect(reason(validateSecretValue("RESEND_API_KEY", "sk_live_abcdefgh"))).toBe("bad_shape");
  });
  it("a YouTube channel id is UC + 22 characters", () => {
    expect(validateSecretValue("YOUTUBE_CHANNEL_ID", "UCabcdefghijklmnopqrstuv").ok).toBe(true);
    expect(reason(validateSecretValue("YOUTUBE_CHANNEL_ID", "@somehandle"))).toBe("bad_shape");
  });
  it.each(["GEMINI_API_KEY", "ELEVENLABS_API_KEY", "YOUTUBE_DATA_API_KEY", "OPENAI_API_KEY", "FAL_KEY", "VIDIQ_ACCESS_TOKEN"])(
    "%s: a plain token passes; whitespace, a newline, `$`, a quote, a backtick or an overlong value do not",
    (name) => {
      expect(validateSecretValue(name, "AIzaSyD-abc_123456789").ok).toBe(true);
      expect(validateSecretValue(name, " key:secret.part-1 ").ok).toBe(true);
      expect(reason(validateSecretValue(name, "abc def ghi jkl"))).toBe("bad_shape");
      expect(reason(validateSecretValue(name, "abcdefgh\nijklmnop"))).toBe("control_chars");
      expect(reason(validateSecretValue(name, "abcdefgh$ijklmnop"))).toBe("forbidden_chars");
      expect(reason(validateSecretValue(name, "abcdefgh`id`"))).toBe("forbidden_chars");
      expect(reason(validateSecretValue(name, `"abcdefghijkl"`))).toBe("forbidden_chars");
      expect(reason(validateSecretValue(name, "a".repeat(4097)))).toBe("too_long");
      expect(reason(validateSecretValue(name, "short"))).toBe("bad_shape");
      expect(validateSecretValue(name, "a".repeat(4096)).ok).toBe(true);
    },
  );
  it("non-strings and blanks never pass", () => {
    expect(reason(validateSecretValue("GEMINI_API_KEY", 12345678))).toBe("bad_shape");
    expect(reason(validateSecretValue("GEMINI_API_KEY", "   "))).toBe("empty");
  });
});

describe("secrets: Google OAuth JSON", () => {
  it("an authorized-user token and a client file pass", () => {
    expect(validateSecretValue("YOUTUBE_TOKEN_JSON", GOOGLE_TOKEN).ok).toBe(true);
    expect(validateSecretValue("CHRONOS_YT_TOKEN_MYCHANNEL", GOOGLE_TOKEN).ok).toBe(true);
    expect(validateSecretValue("YOUTUBE_CLIENT_SECRET_JSON", CLIENT_FILE).ok).toBe(true);
    // a pasted pretty-printed document is accepted but WRITTEN compact, on one line: a line break in it would make the
    // worker env file builder (deploy/build-service-env.py) refuse every deploy
    const pretty = JSON.stringify(JSON.parse(GOOGLE_TOKEN), null, 2);
    expect(pretty).toContain("\n");
    for (const name of ["YOUTUBE_TOKEN_JSON", "CHRONOS_YT_TOKEN_MYCHANNEL"]) {
      const r = validateSecretValue(name, `\n${pretty}\n`);
      expect(r).toEqual({ ok: true, value: GOOGLE_TOKEN });
      expect((r as { value: string }).value).not.toMatch(/[\r\n]/);
    }
    const prettyClient = JSON.stringify(JSON.parse(CLIENT_FILE), null, 4);
    expect(validateSecretValue("YOUTUBE_CLIENT_SECRET_JSON", prettyClient)).toEqual({ ok: true, value: CLIENT_FILE });
  });
  it("a token_uri on another host is refused (the refresh token would be posted there)", () => {
    const evil = JSON.stringify({ ...JSON.parse(GOOGLE_TOKEN), token_uri: "https://evil.example/token" });
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", evil))).toBe("bad_host");
    expect(reason(validateSecretValue("CHRONOS_YT_TOKEN_X", evil))).toBe("bad_host");
    const evilClient = JSON.stringify({ web: { client_id: "i", client_secret: "s", token_uri: "http://oauth2.googleapis.com/token" } });
    expect(reason(validateSecretValue("YOUTUBE_CLIENT_SECRET_JSON", evilClient))).toBe("bad_host");
  });
  it("a document that would still break the env file once compact is refused: `$` or ' #' inside a string", () => {
    const withDollar = JSON.stringify({ ...JSON.parse(GOOGLE_TOKEN), note: "a$b" });
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", withDollar))).toBe("forbidden_chars");
    const escaped = '{"refresh_token":"1//0abc","note":"a\\u0024b"}';
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", escaped))).toBe("forbidden_chars");
    const withHash = JSON.stringify({ ...JSON.parse(GOOGLE_TOKEN), note: "x #y" });
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", withHash))).toBe("forbidden_chars");
    // a '#' with no space before it is fine
    expect(validateSecretValue("YOUTUBE_TOKEN_JSON", JSON.stringify({ ...JSON.parse(GOOGLE_TOKEN), note: "x#y" })).ok).toBe(true);
  });
  it("wrong shapes are refused", () => {
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", "not json"))).toBe("bad_json");
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", "[1,2]"))).toBe("bad_json");
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", JSON.stringify({ token: "x" })))).toBe("bad_shape");
    expect(reason(validateSecretValue("YOUTUBE_CLIENT_SECRET_JSON", JSON.stringify({ token: "x" })))).toBe("bad_shape");
    expect(reason(validateSecretValue("YOUTUBE_TOKEN_JSON", " ".repeat(10) + "x".repeat(20_000)))).toBe("too_long");
  });
});

describe("variables", () => {
  it("ALERT_EMAIL_TO is exactly one valid address", () => {
    expect(validateVariableValue("ALERT_EMAIL_TO", " owner@example.com ")).toEqual({ ok: true, value: "owner@example.com" });
    for (const bad of ["a@b.co, c@d.co", "a@b.co;c@d.co", "Owner <a@b.co>", "a@b", "a@@b.co", "a b@c.co", "a@b..co", "@b.co", "a@-b.co", "a@b.c", "a@b.co\nbcc:x@y.co"]) {
      expect(validateVariableValue("ALERT_EMAIL_TO", bad).ok, bad).toBe(false);
    }
    expect(reason(validateVariableValue("ALERT_EMAIL_TO", "a@b.co$") as never)).not.toBe("ok");
  });
  it("ALERT_EMAIL_FROM is an address or `Name <address>`", () => {
    expect(validateVariableValue("ALERT_EMAIL_FROM", "alerts@nightshift-ai.studio").ok).toBe(true);
    expect(validateVariableValue("ALERT_EMAIL_FROM", "Nightshift Alerts <alerts@nightshift-ai.studio>").ok).toBe(true);
    for (const bad of ["Nightshift <a@b.co>, x@y.co", "<a@b.co>", "Name <not-an-address>", "a@b.co <a@b.co>", 'N"x <a@b.co>']) {
      expect(validateVariableValue("ALERT_EMAIL_FROM", bad).ok, bad).toBe(false);
    }
  });
  it("provider ids come from the closed lists, case-folded", () => {
    expect(validateVariableValue("CHRONOS_VIDEO_PROVIDER", " Higgsfield ")).toEqual({ ok: true, value: "higgsfield" });
    expect(validateVariableValue("CHRONOS_IMAGE_PROVIDER", "nano-banana").ok).toBe(true);
    expect(reason(validateVariableValue("CHRONOS_VIDEO_PROVIDER", "evil"))).toBe("bad_choice");
    expect(reason(validateVariableValue("CHRONOS_IMAGE_PROVIDER", "higgsfield"))).toBe("bad_choice");
  });
  it("switches are 0/1/true/false/yes/no/on/off", () => {
    for (const name of ["CHRONOS_ENABLE_VIDEO_GEN", "CHRONOS_ENABLE_MINIMAX_BROLL", "CHRONOS_ENABLE_IMAGE_GEN", "CHRONOS_AGENT_AUTOPILOT"]) {
      expect(validateVariableValue(name, "1").ok).toBe(true);
      expect(validateVariableValue(name, "TRUE")).toEqual({ ok: true, value: "true" });
      expect(reason(validateVariableValue(name, "2"))).toBe("bad_choice");
    }
  });
  it("`$`, backticks, quotes and control characters are refused for every name; empty clears; non-strings never pass", () => {
    for (const name of ["ALERT_EMAIL_TO", "CHRONOS_VIDEO_PROVIDER", "CHRONOS_AGENT_AUTOPILOT"]) {
      expect(validateVariableValue(name, "$HOME").ok).toBe(false);
      expect(validateVariableValue(name, "`id`").ok).toBe(false);
      expect(validateVariableValue(name, "1\n2").ok).toBe(false);
      expect(validateVariableValue(name, "").ok).toBe(true);
      expect(validateVariableValue(name, 1).ok).toBe(false);
    }
  });
});
