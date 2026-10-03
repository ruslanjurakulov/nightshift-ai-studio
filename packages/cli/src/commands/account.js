import { deleteCredentials, credentialsPath, writeCredentials } from "../config.js";
import { Client, DEFAULT_BASE_URL } from "../client.js";
import { CliError, EXIT } from "../errors.js";
import { readAllStdin, readHidden } from "../secret.js";
import { rows, show, usd } from "../format.js";
import { checkKey, getClient, resolveBaseUrl } from "./shared.js";

export const accountCommands = [
  {
    path: "login",
    summary: "Save an API key (checked with GET /v1/me first).",
    usage: "nightshift login [--key KEY] [--base-url URL]",
    options: {
      key: { type: "string", arg: "KEY", help: "The key. Prefer the hidden prompt, NIGHTSHIFT_API_KEY, or stdin: a flag stays in shell history and the process list." },
    },
    positionals: { names: [], min: 0, max: 0 },
    examples: [
      "nightshift login                        # hidden prompt",
      "echo \"$NIGHTSHIFT_API_KEY\" | nightshift login   # key on stdin",
      "NIGHTSHIFT_API_KEY=... nightshift login",
    ],
    notes: [
      "The key is stored in your user config directory with file mode 0600 and is never printed.",
      "Create keys in Developers > API keys; revoke them there too (logout only deletes the local file).",
    ],
    async run(ctx) {
      const { io, values } = ctx;
      let key = values.key ?? io.env.NIGHTSHIFT_API_KEY;
      if (values.key != null)
        ctx.warn("Passing a key with --key leaves it in your shell history and process list. Prefer the prompt, stdin or NIGHTSHIFT_API_KEY.");
      if (!key) key = io.stdin.isTTY ? await readHidden(io, "Paste your API key (input is hidden): ") : (await readAllStdin(io.stdin)).trim();
      if (!key) throw new CliError("usage", "No key given.", { exit: EXIT.USAGE });
      ctx.addSecret(key);
      checkKey(key);
      const explicitBase = values["base-url"] || io.env.NIGHTSHIFT_BASE_URL;
      const baseUrl = resolveBaseUrl(ctx);
      const client = new Client({ baseUrl, key, io, debug: !!values.debug, log: (s) => io.stderr.write(ctx.clean(s)) });
      const { body } = await client.request("GET", "/me");
      const path = await writeCredentials(io, {
        api_key: key,
        base_url: explicitBase && baseUrl !== DEFAULT_BASE_URL ? baseUrl : undefined,
      });
      const org = body?.organization?.name ?? null;
      ctx.result({ ok: true, organization: body?.organization ?? null, tier: body?.tier ?? null, credentials_file: path }, () =>
        `Logged in${org ? ` to ${org}` : ""} (tier ${show(body?.tier)}). Key saved to ${path} (mode 0600).\n`,
      );
    },
  },
  {
    path: "logout",
    summary: "Delete the saved key from this computer.",
    usage: "nightshift logout",
    options: {},
    positionals: { names: [], min: 0, max: 0 },
    examples: ["nightshift logout"],
    notes: ["This does not revoke the key. To revoke it, use Developers > API keys."],
    async run(ctx) {
      const removed = await deleteCredentials(ctx.io);
      const envSet = !!ctx.io.env.NIGHTSHIFT_API_KEY;
      ctx.result({ ok: true, removed, env_key_still_set: envSet }, () =>
        (removed ? `Removed ${credentialsPath(ctx.io)}.\n` : "No saved key.\n") +
        "The key itself still works until you revoke it in Developers > API keys.\n" +
        (envSet ? "NIGHTSHIFT_API_KEY is still set in this environment.\n" : ""),
      );
    },
  },
  {
    path: "whoami",
    summary: "Show the organization, tier and limits this key belongs to.",
    usage: "nightshift whoami [--json]",
    options: {},
    positionals: { names: [], min: 0, max: 0 },
    examples: ["nightshift whoami", "nightshift whoami --json"],
    async run(ctx) {
      const client = await getClient(ctx);
      const { body } = await client.request("GET", "/me");
      const l = body?.limits ?? {};
      ctx.result(body, () =>
        rows([
          ["Organization", `${show(body?.organization?.name)} (${show(body?.organization?.id)})`],
          ["Key", `${show(body?.key?.id)} from ${ctx.keySource}`],
          ["Tier", show(body?.tier)],
          ["Requests/minute", show(l.requests_per_minute)],
          ["Videos at once", show(l.concurrent_videos)],
          ["Monthly limit", l.monthly_limit_cents == null ? "none reported" : usd(l.monthly_limit_cents)],
          ["Key monthly limit", l.key_monthly_limit_cents == null ? "none set" : usd(l.key_monthly_limit_cents)],
          ["Server", client.baseUrl],
        ]),
      );
    },
  },
  {
    path: "balance",
    summary: "Show the prepaid API balance (US cents), holds and this month's spend.",
    usage: "nightshift balance [--json]",
    options: {},
    positionals: { names: [], min: 0, max: 0 },
    examples: ["nightshift balance", "nightshift balance --json"],
    notes: [
      "This is the USD API balance that videos and downloads are paid from.",
      "Generations (`nightshift generate`) are paid in the organization's credits, which the API does not report; see the web app.",
    ],
    async run(ctx) {
      const client = await getClient(ctx);
      const { body: b } = await client.request("GET", "/balance");
      ctx.result(b, () =>
        rows([
          ["Available", usd(b?.available_cents)],
          ["Balance", usd(b?.balance_cents)],
          ["On hold", usd(b?.reserved_cents)],
          ["Spent this month", usd(b?.month_spend_cents)],
          ["Monthly limit", b?.monthly_limit_cents == null ? "none reported" : usd(b.monthly_limit_cents)],
          ["Tier", show(b?.tier)],
          ...(b?.exempt ? [["Note", "this organization is exempt from API charges"]] : []),
        ]),
      );
    },
  },
  {
    path: "channels",
    summary: "List the organization's channels (ids for `create`).",
    usage: "nightshift channels [--json]",
    options: {},
    positionals: { names: [], min: 0, max: 0 },
    examples: ["nightshift channels"],
    async run(ctx) {
      const client = await getClient(ctx);
      const { body } = await client.request("GET", "/channels");
      const list = Array.isArray(body?.channels) ? body.channels : [];
      ctx.result(body, () =>
        list.length === 0
          ? "No channels.\n"
          : list
              .map(
                (c) =>
                  `${c.id}  ${show(c.name, "")}  ${c.active ? "active" : "NOT active (cannot make videos)"}  youtube:${c.youtube_connected ? "connected" : "not connected"}  target length: ${
                    c.target_duration_seconds == null ? "not set" : c.target_duration_seconds + "s"
                  }`,
              )
              .join("\n") + "\n",
      );
    },
  },
  {
    path: "accounts",
    summary: "List publish targets (YouTube channels, Instagram and TikTok accounts).",
    usage: "nightshift accounts [--json]",
    options: {},
    positionals: { names: [], min: 0, max: 0 },
    examples: ["nightshift accounts"],
    async run(ctx) {
      const client = await getClient(ctx);
      const { body } = await client.request("GET", "/accounts");
      const list = Array.isArray(body?.accounts) ? body.accounts : [];
      ctx.result(body, () =>
        list.length === 0
          ? "No publish targets.\n"
          : list
              .map((a) => `${a.platform}  ${a.platform === "youtube" ? "--youtube " + a.channel_id : "--account " + a.account_id}  ${show(a.name, "")}  ${a.connected ? "connected" : "not connected"}`)
              .join("\n") + "\n",
      );
    },
  },
];
