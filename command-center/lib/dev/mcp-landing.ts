/**
 * The structure of the long /mcp page below the connect card (the words are per
 * language in lib/i18n/site/dev-*.ts, `mcp.land`, keyed by these ids).
 *
 * Honesty rules the page keeps, and the tests pin:
 *  - every picture is drawn here (CSS and inline SVG) and labelled as an
 *    illustration; no generated media, nothing that looks like a real result;
 *  - no model, provider or price is named: the copy says what Nightshift does,
 *    never whose model does it, and every claim is one docs/MCP.md makes;
 *  - the capability rows show only things the server's tools really do.
 */

/** The picture drawn beside each capability row, and which tool names it is about. */
export const CAPABILITY_ROWS = [
  { id: "video", frame: "video", tools: ["create_video", "get_job_status"], thumbs: 0 },
  { id: "channels", frame: "channels", tools: ["list_channels"], thumbs: 0 },
  { id: "language", frame: "voice", tools: ["create_video"], thumbs: 0 },
  { id: "approval", frame: "approve", tools: ["get_video", "publish_video"], thumbs: 0 },
  { id: "credits", frame: "credits", tools: ["get_balance"], thumbs: 0 },
  { id: "batch", frame: "batch", tools: ["create_video", "get_job_status", "get_balance"], thumbs: 3 },
] as const;

export type FrameKind = (typeof CAPABILITY_ROWS)[number]["frame"];

/** The drawn scene behind each example card in the carousel. */
export const EXAMPLE_SCENES = ["hills", "waves", "city", "stars", "rings", "dunes"] as const;
export type SceneKind = (typeof EXAMPLE_SCENES)[number];

/** How many ready-to-ask sentences the "Ask it like this" grid has. */
export const ASK_IDS = ["video", "follow", "check", "publish", "language", "balance"] as const;

/** The "Works with" marquee: the first six clients of the connect card, the rest, and where videos can be published. */
export const PUBLISH_TARGETS = ["YouTube", "Instagram", "TikTok"] as const;
