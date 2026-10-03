/**
 * The AI assistants /mcp tells people how to connect, and the exact snippet for
 * each. A client is listed ONLY if its own documentation, fetched for this
 * change, shows a remote (Streamable HTTP) server with a static header: the
 * server uses API keys, not OAuth, so a client that cannot send a header cannot
 * connect (docs/MCP.md). The URL above each entry is the page that was read;
 * it stays here, in code, and is not printed on the page.
 *
 * Left out because their documentation shows no way to send a header to a
 * remote server: Continue (docs.continue.dev/customize/deep-dives/mcp lists
 * only `url`), Goose (block.github.io / goose-docs.ai extensions page: OAuth
 * only for remote servers), JetBrains AI Assistant
 * (jetbrains.com/help/ai-assistant/mcp.html: `url` only). Add one back the day
 * its page shows a header.
 *
 * Added for the sign-in (OAuth) flow, each verified the same way:
 *  - Claude: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
 *    (Customize > Connectors > + Add > Add custom connector) and
 *    https://claude.com/docs/connectors/building/directory-vs-custom (the
 *    `claude.ai/customize/connectors?modal=add-custom-connector&connectorName=&connectorUrl=` prefill link).
 *  - ChatGPT: https://developers.openai.com/api/docs/guides/developer-mode (Settings > Security and login >
 *    Developer mode; Plugins > plus > developer-mode app; OAuth supported). No directory-listing link or prompt
 *    prefill is used: no official page documents them.
 *  - OpenClaw: https://docs.openclaw.ai/cli/mcp/registry and /transports (`transport: "streamable-http"` — omitted means
 *    sse; `auth: "oauth"` then `openclaw mcp login <name>`; static `headers`).
 *  - Hermes: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp (~/.hermes/config.yaml `mcp_servers`,
 *    `auth: oauth` is required for OAuth, `headers`, `/reload-mcp`, `hermes mcp login <name>`).
 * Left unsaid because no official page confirms it: Cursor's "Open MCP settings" command name and a "Connect" button,
 * Codex's own steps beyond the config file, any ChatGPT directory link.
 *
 * The words around a snippet (where it goes, what to know) are per language in
 * lib/i18n/site/dev-*.ts, keyed by `id`; the brand names here are not translated.
 */

/** What the person replaces with their own key. Printed as is, never a real key. */
export const KEY_PLACEHOLDER = "<your API key>";

export type McpClient = {
  id: string;
  /** The product's own name; not translated. */
  label: string;
  /** The six the owner named are primary, in this order; the rest sit behind "More clients". */
  group: "primary" | "more";
  /** Connector-only: the client takes a server URL and a sign-in, never a header, so it has no API-key snippet. */
  oauthOnly?: boolean;
  /** How the snippet is highlighted/labelled: a shell line, JSON or TOML. */
  lang: "bash" | "json" | "toml" | "text";
  /** The API-key variant (a header with `<your API key>`). Connector-only clients return "". */
  snippet: (mcpUrl: string) => string;
  /** The sign-in variant (no key), shown when MCP_OAUTH_LIVE is on, for clients that can run one from a file or command. */
  oauthSnippet?: (mcpUrl: string) => string;
};

/**
 * Pretty JSON, except that a small object nested below the second level stays on
 * one line. The connect card gives every tab the height of its tallest panel, so
 * a snippet that wastes lines makes every other tab's card taller than it needs.
 */
function json(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => `${pad}  ${json(v, depth + 1)}`).join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const flat = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${json(v, depth + 1)}`).join(", ")} }`;
    if (depth >= 2 && !flat.includes("\n") && flat.length <= 64) return flat;
    return `{\n${entries.map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${json(v, depth + 1)}`).join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}
const bearer = `Bearer ${KEY_PLACEHOLDER}`;

export const MCP_CLIENTS: readonly McpClient[] = [
  {
    // Connector: https://support.claude.com/en/articles/11175166 — a server URL and a sign-in; no header can be typed there.
    id: "claude",
    label: "Claude",
    group: "primary",
    oauthOnly: true,
    lang: "text",
    snippet: () => "",
  },
  {
    // Developer-mode app: https://developers.openai.com/api/docs/guides/developer-mode — URL and OAuth; no static header.
    id: "chatgpt",
    label: "ChatGPT",
    group: "primary",
    oauthOnly: true,
    lang: "text",
    snippet: () => "",
  },
  {
    // https://code.claude.com/docs/en/mcp — `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`
    id: "claude-code",
    group: "primary",
    label: "Claude Code",
    lang: "bash",
    snippet: (url) => `claude mcp add --transport http nightshift ${url} \\\n  --header "Authorization: ${bearer}"`,
    oauthSnippet: (url) => `claude mcp add --transport http nightshift ${url}`,
  },
  {
    // https://docs.openclaw.ai/cli/mcp/registry — `openclaw mcp set <name> '<json>'`; `transport: "streamable-http"` is required
    // (omitted means sse); static `headers`, or `auth: "oauth"` followed by `openclaw mcp login <name>`.
    id: "openclaw",
    label: "OpenClaw",
    group: "primary",
    lang: "bash",
    snippet: (url) =>
      `openclaw mcp set nightshift '${json({ url, transport: "streamable-http", headers: { Authorization: bearer } })}'`,
    oauthSnippet: (url) =>
      `openclaw mcp set nightshift '${json({ url, transport: "streamable-http", auth: "oauth" })}'`,
  },
  {
    // https://cursor.com/docs/context/mcp — mcp.json, remote server: url + headers (~/.cursor/mcp.json or .cursor/mcp.json)
    id: "cursor",
    group: "primary",
    label: "Cursor",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { url, headers: { Authorization: bearer } } } }),
    oauthSnippet: (url) => json({ mcpServers: { nightshift: { url } } }),
  },
  {
    // https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp — ~/.hermes/config.yaml `mcp_servers`; `headers`, or
    // `auth: oauth` (required for OAuth) then `hermes mcp login <name>`; `/reload-mcp` picks up the change.
    id: "hermes",
    label: "Hermes",
    group: "primary",
    lang: "text",
    snippet: (url) => `mcp_servers:\n  nightshift:\n    url: "${url}"\n    headers:\n      Authorization: "${bearer}"`,
    oauthSnippet: (url) => `mcp_servers:\n  nightshift:\n    url: "${url}"\n    auth: oauth`,
  },
  {
    // https://code.visualstudio.com/docs/copilot/reference/mcp-configuration — type "http", url, headers; inputs with
    // promptString + password so the key is asked for, not written into a file that may be committed.
    id: "vscode",
    group: "more",
    label: "VS Code",
    lang: "json",
    snippet: (url) =>
      json({
        inputs: [{ type: "promptString", id: "nightshift-key", description: "Nightshift API key", password: true }],
        servers: { nightshift: { type: "http", url, headers: { Authorization: "Bearer ${input:nightshift-key}" } } },
      }),
  },
  {
    // https://docs.windsurf.com/windsurf/cascade/mcp — "Remote HTTP MCPs": serverUrl + headers in mcp_config.json,
    // opened from the Cascade panel's Actions menu (the file's path moved in that page's latest revision, so none is printed).
    id: "windsurf",
    group: "more",
    label: "Windsurf",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { serverUrl: url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://docs.cline.bot/mcp/configuring-mcp-servers — "Remote server (Streamable HTTP)": type streamableHttp, url, headers.
    id: "cline",
    group: "more",
    label: "Cline",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { type: "streamableHttp", url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://zed.dev/docs/ai/mcp — "As Custom Servers": context_servers entry with url + headers in settings.json.
    id: "zed",
    group: "more",
    label: "Zed",
    lang: "json",
    snippet: (url) => json({ context_servers: { nightshift: { url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md — `gemini mcp add --transport http --header …`.
    // `--scope user` on purpose: the default scope is "project", which writes the header into .gemini/settings.json in the repository.
    id: "gemini-cli",
    group: "more",
    label: "Gemini CLI",
    lang: "bash",
    snippet: (url) => `gemini mcp add --scope user --transport http \\\n  --header "Authorization: ${bearer}" \\\n  nightshift ${url}`,
  },
  {
    // https://developers.openai.com/codex/mcp — config.toml, Streamable HTTP: url + bearer_token_env_var (sent in Authorization).
    id: "codex",
    group: "more",
    label: "Codex",
    lang: "toml",
    snippet: (url) =>
      `# In your shell profile\nexport NIGHTSHIFT_API_KEY="${KEY_PLACEHOLDER}"\n\n# ~/.codex/config.toml\n[mcp_servers.nightshift]\nurl = "${url}"\nbearer_token_env_var = "NIGHTSHIFT_API_KEY"`,
  },
  {
    // https://docs.roocode.com/features/mcp/using-mcp-in-roo — "Streamable HTTP configuration": type "streamable-http", url, headers.
    id: "roo-code",
    group: "more",
    label: "Roo Code",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { type: "streamable-http", url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://docs.warp.dev/knowledge-and-collaboration/mcp — Settings > Agents > MCP servers > + Add: a JSON snippet with url + headers.
    id: "warp",
    group: "more",
    label: "Warp",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { url, headers: { Authorization: bearer } } } }),
  },
  {
    // Claude Desktop's own connector screen signs in with OAuth and cannot send a header (docs/MCP.md), so it goes through
    // the mcp-remote bridge. https://modelcontextprotocol.io/docs/develop/connect-local-servers — Settings > Developer > Edit Config
    // (claude_desktop_config.json); https://github.com/geelen/mcp-remote — `--header "Name:${VAR}"` with the value in `env`
    // (no space after the colon, so a space-bearing value stays out of the argument list).
    id: "claude-desktop",
    group: "more",
    label: "Claude Desktop",
    lang: "json",
    snippet: (url) =>
      json({
        mcpServers: {
          nightshift: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", "Authorization:${NIGHTSHIFT_AUTH}"],
            env: { NIGHTSHIFT_AUTH: bearer },
          },
        },
      }),
  },
  {
    // The protocol's own shape: any client that speaks Streamable HTTP and can send a header.
    id: "other",
    group: "more",
    label: "Other",
    lang: "text",
    snippet: (url) => `URL        ${url}\nTransport  Streamable HTTP\nHeader     Authorization: ${bearer}`,
  },
] as const;

export const MCP_CLIENT_IDS = MCP_CLIENTS.map((c) => c.id);
/** The clients that take an API key (a header): every tab but the two connector-only ones. */
export const KEY_CLIENT_IDS = MCP_CLIENTS.filter((c) => !c.oauthOnly).map((c) => c.id);
/** The clients with a sign-in variant written out step by step: the six the owner named. */
export const OAUTH_CLIENT_IDS = MCP_CLIENTS.filter((c) => c.group === "primary").map((c) => c.id);

/** Claude's documented install link: it opens the add-connector dialog with name and URL filled in. */
export function claudeConnectorLink(mcpUrl: string): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Nightshift&connectorUrl=${encodeURIComponent(mcpUrl)}`;
}
export const CHATGPT_DEVMODE_GUIDE = "https://developers.openai.com/api/docs/guides/developer-mode";

/** The ten tools, in the order the server lists them (lib/api/mcp.ts TOOL_NAMES;
 *  tests/dev-pages-copy.test.ts keeps the two lists equal). */
export const MCP_TOOL_IDS = [
  "list_channels",
  "create_video",
  "get_job_status",
  "list_videos",
  "get_video",
  "list_connected_accounts",
  "publish_video",
  "request_download",
  "get_download",
  "get_balance",
] as const;
