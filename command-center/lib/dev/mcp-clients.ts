/**
 * The AI assistants /mcp tells people how to connect, and the exact snippet for
 * each. The site's owner decided on 2026-11-13 that the page and the Developers
 * console name exactly six, in this order: ChatGPT, Claude, Gemini, Grok, Cursor
 * and VS Code (GitHub Copilot). Other clients that speak the MCP authorization flow can still
 * connect on their own (the server is standard; Claude Code's registration name
 * is accepted, lib/oauth/redirect.ts registrationName), but the page shows no
 * tab, button or logo for them. Two would not work anyway: LM Studio documents
 * no OAuth for its `lmstudio://add_mcp` link, and Raycast's sign-in calls back
 * to `raycast://`, which the redirect rule (lib/oauth/redirect.ts: https,
 * loopback or Cursor's own scheme) refuses on purpose.
 *
 * Each format was read in the vendor's official docs on 2026-11-13 (the page is
 * named where it was recorded). None has been tested end to end with the product
 * itself, which is why every one-click button sits beside the steps by hand, and
 * why Cursor's `cursor:` link only works where Cursor is installed:
 *  - ChatGPT: https://developers.openai.com/api/docs/guides/custom-mcp-server (chatgpt.com/plugins > + > Add custom
 *    MCP server > name, description, URL with its path > OAuth > "I understand and want to continue" > Create as a
 *    plugin > install; web only). The older developer-mode guide is gone (404). No deep link is documented, so
 *    ChatGPT gets the steps by hand only. No static header: sign-in only.
 *  - Claude: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
 *    (Customize > Connectors > + Add > Add custom connector; a Free plan has one custom connector; on Team and
 *    Enterprise only Owners, or an Enterprise custom role, add one) and
 *    https://claude.com/docs/connectors/building/directory-vs-custom (the
 *    `claude.ai/customize/connectors?modal=add-custom-connector&connectorName=&connectorUrl=` prefill link, and the
 *    same parameters on `claude.ai/admin-settings/connectors` for an organization). The dialog only prefills; the
 *    person confirms, and a signed-out person signs in first. Its "OAuth client" choice must stay "Register
 *    automatically": this server registers clients dynamically and does not read Client ID Metadata Documents, so
 *    "Use Claude's published identity" cannot work. Claude's "Request headers" field is a beta some organizations
 *    have, so a key cannot be promised to everyone: sign-in only.
 *  - Gemini: https://support.google.com/gemini/answer/17209137 (on a computer, gemini.google.com > Settings >
 *    Connected Apps, or Personal Intelligence > Connected Apps > Custom apps > Add a custom app > the URL > Next >
 *    sign in; then @ in a prompt). A personal Google Account only (not work or school), 18 and over, currently the
 *    US and English only, Keep Activity on; connected on the web, it then works on mobile too. No header field:
 *    sign-in only. No deep link is documented. Its callbacks, https://oauth-redirect.googleusercontent.com/r/… and
 *    /a/…, already pass the redirect rule.
 *  - Grok: https://docs.x.ai/grok/connectors (grok.com/connectors > New Connector > Custom > the URL > sign in) and
 *    https://docs.x.ai/grok/connector-management (Business and Enterprise: a team admin first adds it in the xAI
 *    console, Add Connector > Other > URL; members then connect at grok.com/connectors). Its OAuth form may show a
 *    Client ID field: people are told to leave Client ID and Secret empty so it registers itself. That Grok really
 *    uses dynamic client registration is UNVERIFIED: if it insists on a Client ID it cannot connect, and the page
 *    says so. No deep link is documented. Its web callback, https://grok.com/connectors-oauth-exchange-code/, already
 *    passes the redirect rule.
 *  - Cursor: its MCP docs under https://cursor.com/docs/context/mcp — mcp.json with `url` (+ `headers` for a key);
 *    install links `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=` with the base64 of the server
 *    object itself, not of `mcpServers`; Cursor asks before it installs, then registers as a public client.
 *  - VS Code (GitHub Copilot): https://code.visualstudio.com/docs/copilot/reference/mcp-configuration — `servers`,
 *    type "http", url (+ headers with a password `promptString` input for a key); install links in its MCP docs:
 *    `vscode:mcp/install?` + the URL-encoded server JSON with its name, `vscode-insiders:` for Insiders, wrapped in
 *    `https://vscode.dev/redirect?url=` for a web page; VS Code opens a review editor before it installs.
 *
 * The words around a snippet (where it goes, what to know) are per language in
 * lib/i18n/site/dev-*.ts, keyed by `id`; the brand names here are not translated.
 */

/** What the person replaces with their own key. Printed as is, never a real key. */
export const KEY_PLACEHOLDER = "<your API key>";

export type McpClient = {
  id: string;
  /** The product's own name as the tab shows it; not translated. */
  label: string;
  /** The name inside "Add to …" where the tab's label is longer than the product's own name. */
  shortLabel?: string;
  /** Connector-only: the client takes a server URL and a sign-in, never a header, so it has no API-key snippet. */
  oauthOnly?: boolean;
  /** How the snippet is highlighted/labelled: a shell line, JSON or TOML. */
  lang: "bash" | "json" | "toml" | "text";
  /** The API-key variant (a header with `<your API key>`). Connector-only clients return "". */
  snippet: (mcpUrl: string) => string;
  /** The sign-in variant (no key), shown when MCP_OAUTH_LIVE is on, for clients that can run one from a file. */
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

/** The six, in the order the owner set: ChatGPT, Claude, Gemini, Grok, Cursor, VS Code. */
export const MCP_CLIENTS: readonly McpClient[] = [
  { id: "chatgpt", label: "ChatGPT", oauthOnly: true, lang: "text", snippet: () => "" },
  { id: "claude", label: "Claude", oauthOnly: true, lang: "text", snippet: () => "" },
  { id: "gemini", label: "Gemini", oauthOnly: true, lang: "text", snippet: () => "" },
  { id: "grok", label: "Grok", oauthOnly: true, lang: "text", snippet: () => "" },
  {
    id: "cursor",
    label: "Cursor",
    lang: "json",
    snippet: (url) => json({ mcpServers: { nightshift: { url, headers: { Authorization: bearer } } } }),
    oauthSnippet: (url) => json({ mcpServers: { nightshift: { url } } }),
  },
  {
    // The key variant asks for the key through a password input, so it is never written into a file that may be committed.
    id: "vscode",
    label: "VS Code (GitHub Copilot)",
    shortLabel: "VS Code",
    lang: "json",
    snippet: (url) =>
      json({
        inputs: [{ type: "promptString", id: "nightshift-key", description: "Nightshift API key", password: true }],
        servers: { nightshift: { type: "http", url, headers: { Authorization: "Bearer ${input:nightshift-key}" } } },
      }),
    oauthSnippet: (url) => json({ servers: { nightshift: { type: "http", url } } }),
  },
] as const;

export const MCP_CLIENT_IDS = MCP_CLIENTS.map((c) => c.id);
/** The clients that take an API key (a header): every tab but the connector-only ones. */
export const KEY_CLIENT_IDS = MCP_CLIENTS.filter((c) => !c.oauthOnly).map((c) => c.id);
/** The clients whose sign-in is written out step by step (dev.mcp.oauth): the connector-only ones and every client with a sign-in snippet. */
export const OAUTH_CLIENT_IDS = MCP_CLIENTS.filter((c) => c.oauthOnly || c.oauthSnippet).map((c) => c.id);

/**
 * The name every snippet and install link gives the server. A client that names itself after the server it was
 * given (Claude Code: "Claude Code (nightshift)") is registered under its own name (lib/oauth/redirect.ts).
 */
export const MCP_SERVER_NAME = "nightshift";

/**
 * Claude's documented install link: it opens the add-connector dialog with name and URL filled in, and the person
 * still confirms. "organization" is the same dialog in the admin settings, for an Owner adding it for everyone.
 */
export function claudeConnectorLink(mcpUrl: string, scope: "personal" | "organization" = "personal"): string {
  const page = scope === "organization" ? "admin-settings/connectors" : "customize/connectors";
  return `https://claude.ai/${page}?modal=add-custom-connector&connectorName=Nightshift&connectorUrl=${encodeURIComponent(mcpUrl)}`;
}

/**
 * Cursor's install link. `config` is the base64 of the server object itself ({"url": …}), not of an `mcpServers` map,
 * and is not percent-encoded: that is the documented shape. Base64 of our own URL has only letters, digits and "="
 * (tests pin it), so no "+" can be read back as a space.
 */
export function cursorInstallLink(mcpUrl: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${btoa(JSON.stringify({ url: mcpUrl }))}`;
}

/** VS Code's own install link (opens a review editor before anything is installed). */
export function vscodeInstallLink(mcpUrl: string, edition: "stable" | "insiders" = "stable"): string {
  const scheme = edition === "insiders" ? "vscode-insiders" : "vscode";
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_SERVER_NAME, type: "http", url: mcpUrl }))}`;
}

/**
 * The same link as a web address: vscode.dev/redirect is VS Code's documented way to start a `vscode:` link from a
 * web page, so the button is an ordinary https link that any browser opens and hands to the app.
 */
export function vscodeWebInstallLink(mcpUrl: string, edition: "stable" | "insiders" = "stable"): string {
  return `https://vscode.dev/redirect?url=${encodeURIComponent(vscodeInstallLink(mcpUrl, edition))}`;
}

export type InstallLink = {
  href: string;
  /**
   * "web": an https page, opened in a new tab. "app": a custom scheme, followed in the SAME tab — a new tab for a
   * scheme the browser hands to an app is left blank, and when the app is not installed nothing happens at all,
   * which is why the steps by hand sit beside every button.
   */
  opens: "web" | "app";
};

/** The one-click button for a client, or null when it has no documented install link. */
export function installLink(id: string, mcpUrl: string): InstallLink | null {
  switch (id) {
    case "claude":
      return { href: claudeConnectorLink(mcpUrl), opens: "web" };
    case "cursor":
      return { href: cursorInstallLink(mcpUrl), opens: "app" };
    case "vscode":
      return { href: vscodeWebInstallLink(mcpUrl), opens: "web" };
    default:
      // ChatGPT, Gemini and Grok document no install link: their tabs and console rows are the steps by hand only.
      return null;
  }
}

/** The clients with a one-click button. ChatGPT, Gemini and Grok are not (no documented install link). */
export const INSTALL_CLIENT_IDS = ["claude", "cursor", "vscode"] as const;

/** OpenAI's current guide for adding a custom MCP server to ChatGPT (the developer-mode guide it replaced is a 404). */
export const CHATGPT_MCP_GUIDE = "https://developers.openai.com/api/docs/guides/custom-mcp-server";
/** Google's help page for custom apps in Gemini. */
export const GEMINI_MCP_GUIDE = "https://support.google.com/gemini/answer/17209137";
/** xAI's page for custom connectors in Grok. */
export const GROK_MCP_GUIDE = "https://docs.x.ai/grok/connectors";

/** The vendor's own guide each steps-only tab links to: the assistants with no documented install link. */
export const MCP_GUIDES: Record<string, string> = { chatgpt: CHATGPT_MCP_GUIDE, gemini: GEMINI_MCP_GUIDE, grok: GROK_MCP_GUIDE };

/** The tools, in the order the server lists them (lib/api/mcp.ts TOOL_NAMES;
 *  tests/dev-pages-copy.test.ts keeps the two lists equal). The last four (the Studio's generations) are API-key only. */
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
  "list_models",
  "quote_generation",
  "create_generation",
  "get_generation",
] as const;
