import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { isGithubConfigured, listConfiguredSecretNames } from "@/lib/server/github-secrets";
import { readVariables } from "@/lib/server/github-variables";
import {
  ALERT_SECRET_NAMES,
  deriveAlertConfig,
  formatAlertText,
  sendSlackWebhook,
  type AlertConfig,
} from "@/lib/server/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Alert channel status + a "Send test alert".
 *
 * GET (any signed-in user) reports which channels are configured, by secret /
 * variable NAME presence — the web app can never read a secret VALUE.
 *
 * POST (admin) writes a test row into the durable `alert_events` feed and, IF
 * the Slack webhook happens to be present in this runtime's environment, sends
 * it and marks the row delivered. Otherwise the row stands as queued: the real
 * fan-out runs where the secret env var lives (the Actions pipeline). Nothing
 * sensitive is accepted in the body and no secret value is ever returned.
 */

async function readConfig(): Promise<AlertConfig & { githubConfigured: boolean }> {
  if (!isGithubConfigured) {
    return { slackConfigured: false, emailConfigured: false, githubConfigured: false };
  }
  let secretNames: string[] = [];
  let variables: Record<string, string> = {};
  try {
    secretNames = await listConfiguredSecretNames(ALERT_SECRET_NAMES);
  } catch {
    secretNames = [];
  }
  try {
    variables = await readVariables();
  } catch {
    variables = {};
  }
  return { ...deriveAlertConfig(secretNames, variables), githubConfigured: true };
}

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await readConfig());
}

export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireRole("admin")))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const config = await readConfig();

  // Attempt a real Slack send only if the webhook is present in THIS runtime.
  // The web app cannot read a GitHub secret value, so most deploys will not
  // have it here — the row is then queued for the pipeline to deliver.
  const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
  const text = formatAlertText({
    kind: "alert.test",
    severity: "info",
    title: "Test alert from the Command Center",
    body: "If you can read this, the alert feed is wired. Delivery to Slack/email runs where the channel secret is present.",
  });

  let delivered = false;
  if (webhook) {
    try {
      delivered = await sendSlackWebhook(webhook, text);
    } catch {
      delivered = false;
    }
  }

  const supabase = await createClient();
  let recorded = false;
  if (supabase) {
    const { error } = await supabase.from("alert_events").insert({
      kind: "alert.test",
      severity: "info",
      title: "Test alert from the Command Center",
      body: "Manual test triggered from the Alerts page.",
      delivered,
    });
    recorded = !error;
  }

  return NextResponse.json({
    ok: true,
    slackConfigured: config.slackConfigured,
    emailConfigured: config.emailConfigured,
    githubConfigured: config.githubConfigured,
    recorded,
    delivered,
    // queued = row stands in the feed for the pipeline to deliver later.
    queued: recorded && !delivered,
  });
}
