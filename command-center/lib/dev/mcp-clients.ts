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
 * The words around a snippet (where it goes, what to know) are per language in
 * lib/i18n/site/dev-*.ts, keyed by `id`; the brand names here are not translated.
 */

/** What the person replaces with their own key. Printed as is, never a real key. */
export const KEY_PLACEHOLDER = "<your API key>";

export type McpClient = {
  id: string;
  /** The product's own name; not translated. */
  label: string;
  /** How the snippet is highlighted/labelled: a shell line, JSON or TOML. */
  lang: "bash" | "json" | "toml" | "text";
  snippet: (mcpUrl: string) => string;
};

const json = (value: unknown) => JSON.stringify(value, null, 2);
const bearer = `Bearer ${KEY_PLACEHOLDER}`;

export const MCP_CLIENTS: readonly McpClient[] = [
  {
    // https://code.claude.com/docs/en/mcp — `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`
    id: "claude-code",
    label: "Claude Code",
    lang: "bash",
    snippet: (url) => `claude mcp add --transport http nightshift ${url} \\\n  --header "Authorization: ${bearer}"`,
  },
  {
    // https://cursor.com/docs/context/mcp — mcp.json, remote server: url + headers (~/.cursor/mcp.json or .cursor/mcp.json)
    id: "cursor",
    label: "Cursor",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://code.visualstudio.com/docs/copilot/reference/mcp-configuration — type "http", url, headers; inputs with
    // promptString + password so the key is asked for, not written into a file that may be committed.
    id: "vscode",
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
    label: "Windsurf",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { serverUrl: url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://docs.cline.bot/mcp/configuring-mcp-servers — "Remote server (Streamable HTTP)": type streamableHttp, url, headers.
    id: "cline",
    label: "Cline",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { type: "streamableHttp", url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://zed.dev/docs/ai/mcp — "As Custom Servers": context_servers entry with url + headers in settings.json.
    id: "zed",
    label: "Zed",
    lang: "json",
    snippet: (url) => json({ context_servers: { nightshift: { url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md — `gemini mcp add --transport http --header …`.
    // `--scope user` on purpose: the default scope is "project", which writes the header into .gemini/settings.json in the repository.
    id: "gemini-cli",
    label: "Gemini CLI",
    lang: "bash",
    snippet: (url) => `gemini mcp add --scope user --transport http \\\n  --header "Authorization: ${bearer}" \\\n  nightshift ${url}`,
  },
  {
    // https://developers.openai.com/codex/mcp — config.toml, Streamable HTTP: url + bearer_token_env_var (sent in Authorization).
    id: "codex",
    label: "Codex",
    lang: "toml",
    snippet: (url) =>
      `# In your shell profile\nexport NIGHTSHIFT_API_KEY="${KEY_PLACEHOLDER}"\n\n# ~/.codex/config.toml\n[mcp_servers.nightshift]\nurl = "${url}"\nbearer_token_env_var = "NIGHTSHIFT_API_KEY"`,
  },
  {
    // https://docs.roocode.com/features/mcp/using-mcp-in-roo — "Streamable HTTP configuration": type "streamable-http", url, headers.
    id: "roo-code",
    label: "Roo Code",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { type: "streamable-http", url, headers: { Authorization: bearer } } } }),
  },
  {
    // https://docs.warp.dev/knowledge-and-collaboration/mcp — Settings > Agents > MCP servers > + Add: a JSON snippet with url + headers.
    id: "warp",
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
    label: "Other",
    lang: "text",
    snippet: (url) => `URL        ${url}\nTransport  Streamable HTTP\nHeader     Authorization: ${bearer}`,
  },
] as const;

export const MCP_CLIENT_IDS = MCP_CLIENTS.map((c) => c.id);

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
