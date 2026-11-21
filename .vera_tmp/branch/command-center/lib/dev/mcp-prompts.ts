import { OAUTH_TOOL_SCOPES } from "@/lib/api/mcp-oauth";

/**
 * The prompt gallery on /mcp: things to paste into an assistant, each tied to the tools the server really has
 * (lib/api/mcp.ts TOOL_NAMES; tests/mcp-prompts.test.tsx keeps every name in that list). The words are per language in
 * lib/i18n/site/dev-*.ts (`mcp.land.prompts.items`), keyed by these ids.
 *
 * Which connection a prompt works on is DERIVED, never typed: a connected app (a sign-in) is offered exactly the tools
 * in OAUTH_TOOL_SCOPES, so a prompt that needs any other tool (the Studio's four, the paid download) works only with an
 * API key. A card that said "works in your chat app" for list_models would be a promise the server refuses.
 */
export const PROMPT_GALLERY = [
  { id: "balance", tools: ["get_balance"] },
  { id: "channels", tools: ["list_channels"] },
  { id: "plan", tools: ["list_channels", "list_videos"] },
  { id: "make", tools: ["list_channels", "create_video", "get_job_status"] },
  { id: "review", tools: ["list_videos", "get_video"] },
  { id: "models", tools: ["list_models"] },
  { id: "quote", tools: ["list_models", "quote_generation"] },
  { id: "generate", tools: ["create_generation", "get_generation"] },
] as const satisfies readonly { id: string; tools: readonly string[] }[];

export type PromptId = (typeof PROMPT_GALLERY)[number]["id"];

/** "both": a sign-in or an API key; "key": only an API key (with the Studio permissions for the Studio's tools). */
export type PromptDoor = "both" | "key";

export function promptDoor(tools: readonly string[]): PromptDoor {
  return tools.every((t) => Object.hasOwn(OAUTH_TOOL_SCOPES, t)) ? "both" : "key";
}
