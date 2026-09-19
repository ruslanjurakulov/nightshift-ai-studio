import { describe, expect, it, vi } from "vitest";

// alerts / github-secrets / github-variables are `server-only`; neutralize the
// guard so they can be imported in the node test runner.
vi.mock("server-only", () => ({}));

const {
  ALERT_SECRET_NAMES,
  ALERT_VARIABLE_NAMES,
  deriveAlertConfig,
  formatAlertText,
  formatAlertHtml,
  severityTag,
} = await import("../lib/server/alerts");
const { isWritableSecretName } = await import("../lib/server/github-secrets");
const { isWritableVariable } = await import("../lib/server/github-variables");

describe("deriveAlertConfig", () => {
  it("marks Slack configured only when its webhook secret is present", () => {
    expect(deriveAlertConfig([], {}).slackConfigured).toBe(false);
    expect(deriveAlertConfig(["SLACK_WEBHOOK_URL"], {}).slackConfigured).toBe(true);
    // A Set is accepted too.
    expect(deriveAlertConfig(new Set(["SLACK_WEBHOOK_URL"]), {}).slackConfigured).toBe(true);
  });

  it("requires the Resend key AND both addresses for email", () => {
    // Key alone is not enough — there is nowhere to send.
    expect(deriveAlertConfig(["RESEND_API_KEY"], {}).emailConfigured).toBe(false);
    // Addresses without a key cannot send either.
    expect(
      deriveAlertConfig([], {
        ALERT_EMAIL_TO: "ops@example.com",
        ALERT_EMAIL_FROM: "bot@example.com",
      }).emailConfigured,
    ).toBe(false);
    // All three present → configured.
    expect(
      deriveAlertConfig(["RESEND_API_KEY"], {
        ALERT_EMAIL_TO: "ops@example.com",
        ALERT_EMAIL_FROM: "bot@example.com",
      }).emailConfigured,
    ).toBe(true);
  });

  it("treats blank/whitespace address variables as unset", () => {
    expect(
      deriveAlertConfig(["RESEND_API_KEY"], {
        ALERT_EMAIL_TO: "   ",
        ALERT_EMAIL_FROM: "bot@example.com",
      }).emailConfigured,
    ).toBe(false);
  });

  it("keeps the two channels independent", () => {
    const cfg = deriveAlertConfig(["SLACK_WEBHOOK_URL"], {});
    expect(cfg.slackConfigured).toBe(true);
    expect(cfg.emailConfigured).toBe(false);
  });
});

describe("severityTag", () => {
  it("maps each severity to its tag", () => {
    expect(severityTag("info")).toBe("INFO");
    expect(severityTag("warn")).toBe("WARN");
    expect(severityTag("critical")).toBe("CRITICAL");
  });
});

describe("formatAlertText", () => {
  it("leads with the severity tag and title, then kind and body", () => {
    const text = formatAlertText({
      kind: "run.failed",
      severity: "critical",
      title: "Daily video failed",
      body: "Timeout at render step.",
    });
    expect(text).toContain("[Nightshift · CRITICAL] Daily video failed");
    expect(text).toContain("kind: run.failed");
    expect(text).toContain("Timeout at render step.");
  });

  it("omits the body line when there is no body", () => {
    const text = formatAlertText({ kind: "alert.test", severity: "info", title: "Ping" });
    expect(text).toContain("[Nightshift · INFO] Ping");
    expect(text.trimEnd().endsWith("kind: alert.test")).toBe(true);
  });
});

describe("formatAlertHtml", () => {
  it("escapes HTML in the title and body", () => {
    const html = formatAlertHtml({
      kind: "gate.block",
      severity: "warn",
      title: "<script>bad</script>",
      body: "a & b < c",
    });
    expect(html).not.toContain("<script>bad");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b &lt; c");
  });
});

describe("alert credential allowlists", () => {
  it("every alert secret name is writable through the secrets allowlist", () => {
    for (const name of ALERT_SECRET_NAMES) {
      expect(isWritableSecretName(name), name).toBe(true);
    }
  });

  it("every alert variable name is writable through the variables allowlist", () => {
    for (const name of ALERT_VARIABLE_NAMES) {
      expect(isWritableVariable(name), name).toBe(true);
    }
  });
});
